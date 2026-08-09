import { callModel } from './digest-generator.js';

const DEFAULT_MAX_PAIRS = 40;
const MAX_PAIR_TEXT = 520;
const VERDICTS = new Set(['duplicate', 'update', 'new']);

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_PAIR_TEXT);
}

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return String(value || '');
  }
}

function isPotentialMatch(similarity, sameUrl) {
  if (sameUrl || similarity.duplicate) return true;
  const score = Math.max(similarity.titleScore || 0, similarity.combinedScore || 0);
  return (similarity.sharedTitleTokens >= 2 && score >= 0.12)
    || similarity.titleScore >= 0.28
    || similarity.combinedScore >= 0.22;
}

export function buildSemanticPairs(
  candidates,
  priorArticles,
  similarityFn,
  maxPairs = DEFAULT_MAX_PAIRS,
  includeSameBatch = false,
) {
  const boundedMaxPairs = Math.max(0, Math.min(100, Number(maxPairs) || DEFAULT_MAX_PAIRS));
  const perCandidate = candidates.map((candidate, candidateIndex) => {
    const references = [
      ...priorArticles.map((reference, referenceIndex) => ({
        reference,
        referenceIndex,
        referenceKind: 'history',
        referenceCandidateIndex: null,
      })),
      ...(includeSameBatch
        ? candidates.slice(0, candidateIndex).map((reference, referenceCandidateIndex) => ({
          reference,
          referenceIndex: referenceCandidateIndex,
          referenceKind: 'batch',
          referenceCandidateIndex,
        }))
        : []),
    ];
    const matches = references.map((referenceInfo) => {
      const {
        reference,
        referenceIndex,
        referenceKind,
        referenceCandidateIndex,
      } = referenceInfo;
      const similarity = similarityFn(candidate, reference);
      const sameUrl = canonicalUrl(candidate.url) === canonicalUrl(reference.url);
      return {
        id: `c${candidateIndex}-${referenceKind[0]}${referenceIndex}`,
        candidateIndex,
        referenceIndex,
        referenceKind,
        referenceCandidateIndex,
        candidate,
        reference,
        similarity,
        sameUrl,
        rank: (sameUrl ? 2 : 0)
          + Math.max(similarity.titleScore || 0, similarity.combinedScore || 0)
          + Math.min(0.3, (similarity.sharedTitleTokens || 0) * 0.05),
      };
    })
      .filter((pair) => isPotentialMatch(pair.similarity, pair.sameUrl))
      .sort((left, right) => right.rank - left.rank)
      .slice(0, 2);
    return matches;
  });

  const pairs = [];
  for (let rank = 0; rank < 2 && pairs.length < boundedMaxPairs; rank += 1) {
    for (const matches of perCandidate) {
      if (matches[rank]) pairs.push(matches[rank]);
      if (pairs.length >= boundedMaxPairs) break;
    }
  }
  return pairs;
}

function parseDecisionJson(text) {
  const cleaned = String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('semantic dedup returned no JSON array');
  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error('semantic dedup JSON is not an array');
  return parsed;
}

export async function classifySemanticPairs(appConfig, pairs) {
  if (!pairs.length) return { decisions: [], usage: { inputTokens: 0, outputTokens: 0 } };
  const payload = pairs.map((pair) => ({
    id: pair.id,
    candidate: {
      title: compactText(pair.candidate.title),
      facts: compactText(pair.candidate.summary || pair.candidate.content),
      publishedAt: pair.candidate.publishedAt || null,
    },
    previous: {
      title: compactText(pair.reference.title),
      facts: compactText(pair.reference.summary || pair.reference.content),
      publishedAt: pair.reference.created_at || pair.reference.publishedAt || null,
      kind: pair.referenceKind,
    },
  }));

  const system = [
    'Ты проверяешь пары технологических новостей на повтор по смыслу.',
    'Для каждой пары верни ровно один verdict:',
    '- duplicate: это одно и то же реальное событие, а candidate не добавляет существенного нового факта;',
    '- update: это развитие той же истории, но candidate добавляет конкретный новый факт, решение, дату, цифру, результат или новый этап;',
    '- new: это другое событие, даже если компания, продукт или тема совпадают.',
    'Не решай по одному слову вроде lawsuit, release или product. Сравнивай участников, действие, объект и фактический результат.',
    'Ответ только JSON-массивом: [{"id":"...","verdict":"duplicate|update|new","reason":"до 12 слов"}].',
  ].join('\n');

  const response = await callModel(appConfig, {
    system,
    user: JSON.stringify(payload),
    maxTokens: Math.min(4096, 384 + pairs.length * 72),
  });
  const parsed = parseDecisionJson(response.text);
  const decisions = parsed
    .filter((decision) => pairs.some((pair) => pair.id === decision?.id))
    .map((decision) => ({
      id: decision.id,
      verdict: VERDICTS.has(decision.verdict) ? decision.verdict : 'new',
      reason: compactText(decision.reason).slice(0, 160),
    }));
  return {
    decisions,
    usage: {
      inputTokens: response.inputTokens || 0,
      outputTokens: response.outputTokens || 0,
    },
  };
}

function fallbackDecision(pair) {
  const titleScore = pair.similarity.titleScore || 0;
  const combinedScore = pair.similarity.combinedScore || 0;
  const duplicate = (pair.sameUrl && titleScore >= 0.8 && combinedScore >= 0.6)
    || titleScore >= 0.72
    || combinedScore >= 0.8;
  return {
    id: pair.id,
    verdict: duplicate ? 'duplicate' : 'new',
    reason: duplicate ? 'high-confidence lexical fallback' : 'fail-open lexical fallback',
  };
}

function safeError(value) {
  return String(value || 'semantic classifier failed')
    .replace(/(?:sk|apify_api)-[A-Za-z0-9_-]+/g, '[redacted]')
    .slice(0, 240);
}

export async function resolveHistoricalDuplicates({
  candidates,
  priorArticles,
  similarityFn,
  appConfig,
  maxPairs = DEFAULT_MAX_PAIRS,
  classifyPairs = classifySemanticPairs,
}) {
  if (!Array.isArray(candidates) || !candidates.length) {
    return {
      selected: candidates || [],
      rejected: [],
      stats: { comparedPairs: 0, duplicate: 0, update: 0, new: 0, fallback: false },
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  const pairs = buildSemanticPairs(
    candidates,
    Array.isArray(priorArticles) ? priorArticles : [],
    similarityFn,
    maxPairs,
    true,
  );
  if (!pairs.length) {
    return {
      selected: candidates,
      rejected: [],
      stats: { comparedPairs: 0, duplicate: 0, update: 0, new: 0, fallback: false },
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  let result;
  let fallback = appConfig.semanticDedupEnabled === false;
  let classifierError = null;
  if (!fallback) {
    try {
      result = await classifyPairs(appConfig, pairs);
    } catch (error) {
      fallback = true;
      classifierError = safeError(error.message);
    }
  }
  if (fallback) {
    result = {
      decisions: pairs.map(fallbackDecision),
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  const supplied = new Map((result.decisions || []).map((decision) => [decision.id, decision]));
  const decisions = pairs.map((pair) => supplied.get(pair.id) || fallbackDecision(pair));
  const decisionById = new Map(decisions.map((decision) => [decision.id, decision]));

  const selected = [];
  const rejected = [];
  const stats = { comparedPairs: pairs.length, duplicate: 0, update: 0, new: 0, fallback };
  for (const decision of decisions) stats[decision.verdict] += 1;
  if (classifierError) stats.error = classifierError;

  const rejectionByCandidate = new Map();
  const updateByCandidate = new Map();
  for (const pair of pairs) {
    const decision = decisionById.get(pair.id);
    if (decision.verdict === 'duplicate' && !rejectionByCandidate.has(pair.candidateIndex)) {
      rejectionByCandidate.set(pair.candidateIndex, {
        pair,
        decision,
        reason: pair.referenceKind === 'history' ? 'semantic-history' : 'semantic-batch',
      });
    }
  }
  for (const pair of pairs) {
    const decision = decisionById.get(pair.id);
    if (decision.verdict === 'update') {
      // If this candidate is already a duplicate of published history, do not
      // also remove the earlier same-batch version and lose both choices.
      if (rejectionByCandidate.has(pair.candidateIndex)) continue;
      updateByCandidate.set(pair.candidateIndex, pair);
      if (pair.referenceKind === 'batch' && !rejectionByCandidate.has(pair.referenceCandidateIndex)) {
        rejectionByCandidate.set(pair.referenceCandidateIndex, {
          pair: { ...pair, reference: pair.candidate },
          decision,
          reason: 'semantic-batch-superseded',
        });
      }
    }
  }

  candidates.forEach((candidate, candidateIndex) => {
    const rejection = rejectionByCandidate.get(candidateIndex);
    if (rejection) {
      rejected.push({
        ...candidate,
        duplicateOf: rejection.pair.reference.url,
        duplicateReason: rejection.reason,
        duplicateDecisionReason: rejection.decision.reason,
        eventFingerprint: rejection.pair.reference.eventFingerprint
          || rejection.pair.reference.event_fingerprint,
        similarity: rejection.pair.similarity,
      });
      return;
    }

    const update = updateByCandidate.get(candidateIndex);
    selected.push(update ? {
      ...candidate,
      semanticVerdict: 'update',
      semanticReferenceUrl: update.reference.url,
    } : candidate);
  });

  return {
    selected,
    rejected,
    stats,
    usage: result.usage || { inputTokens: 0, outputTokens: 0 },
  };
}
