import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import {
  updateArticleStatus,
  updateArticleCommentary,
  createDigest,
  updateDigest,
  assignArticlesToDigest,
  getDigests,
  getDigest,
} from '../db/index.js';
import { priceFor } from '../data/model-catalog.js';
import { enforceCanonicalDigestLinks } from './digest-links.js';

const MAX_CONTENT_LENGTH = 3000;
const RETRY_ATTEMPTS = 3;
const INTER_CALL_DELAY_MS = 200;

const INVALID_COMMENTARY_PATTERNS = [
  /это\s+не\s+новость/i,
  /это\s+не\s+текст/i,
  /не\s+текст\s+для\s+(?:поста|разбора|обработки)/i,
  /скинь\s+(?:конкретный\s+)?(?:текст|ссылку|новость)/i,
  /кинь\s+(?:конкретный\s+)?(?:текст|ссылку|новость)/i,
  /не\s+из\s+чего\s+писать/i,
  /ноль\s+толку/i,
  /список\s+(?:твоих\s+)?(?:старых\s+)?запросов/i,
  /истори[яю]\s+запросов/i,
  /скриншот/i,
  /браузер/i,
];

function isInvalidCommentary(text) {
  return INVALID_COMMENTARY_PATTERNS.some((pattern) => pattern.test(text || ''));
}

function buildArticleUserMessage(article, contentTruncated, retry = false) {
  const parts = [];
  if (retry) {
    parts.push('ПРЕДЫДУЩИЙ ОТВЕТ БЫЛ БРАКОМ: нельзя жаловаться на источник или писать, что это не новость. Сделай нормальный короткий авторский комментарий по фактам ниже.');
    parts.push('Запрещено: "это не новость", "это не текст", "скинь", "кинь", "список запросов", "история запросов", "скриншот", "браузер".');
  }
  if (article.title) parts.push(`Заголовок: ${article.title}`);
  if (article.url) parts.push(`Ссылка: ${article.url}`);
  parts.push('Ниже карточка новости из проверенного технологического источника. Используй только факты из неё, не обсуждай процесс сбора.');
  parts.push(contentTruncated || article.title || article.url || '');
  return parts.join('\n\n');
}


const FORBIDDEN_PROMO_PATTERNS = [
  /alexeykrol\.com/i,
  /(?:^|\s)#(?:alexkrol|vibecoding)\b/i,
  /(?:алекс|алексей)\s+крол/i,
  /хотите\s+(?:свой|такой же)\s+дайджест/i,
  /пробн(?:ый|ого)\s+период/i,
  /бесплатн(?:ый|ого)\s+(?:мини\s+)?курс/i,
  /создани[ея]\s+ии\s+агентов/i,
];

function removeForbiddenPromoBlocks(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .filter((block) => !FORBIDDEN_PROMO_PATTERNS.some((pattern) => pattern.test(block)))
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function textFromOpenAIResponse(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }

  return (response?.output || [])
    .filter((item) => item?.type === 'message')
    .flatMap((item) => item.content || [])
    .filter((part) => part?.type === 'output_text' && part.text)
    .map((part) => part.text)
    .join('\n\n')
    .trim();
}

function humanizeDigestPunctuation(text) {
  return String(text || '')
    .replace(/[—–]/g, ',')
    .replace(/пи\.\.ец/gi, 'пиздец')
    .replace(/пиз\.\.ец/gi, 'пиздец')
    .replace(/б\*+/gi, 'блядь')
    .replace(/х\*й/gi, 'хуй')
    .replace(/[ \t]+,/g, ',')
    .replace(/,{2,}/g, ',')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/([,.!?;:])([^\s\n])/g, '$1 $2')
    .trim();
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a single model call (already vendor-specific) with exponential-backoff
 * retry on 429. `fn` returns the raw vendor response.
 */
async function withRetry(fn, attempt = 1) {
  try {
    return await fn();
  } catch (err) {
    if (err?.status === 429 && attempt < RETRY_ATTEMPTS) {
      const delay = Math.pow(2, attempt) * 1000;
      console.warn(`[digest-generator] Rate limited, retrying in ${delay}ms (attempt ${attempt}/${RETRY_ATTEMPTS})`);
      await sleep(delay);
      return withRetry(fn, attempt + 1);
    }
    throw err;
  }
}

/**
 * Vendor-agnostic single-shot model call. Routes to Anthropic (default) or
 * OpenAI based on config.llmVendor. Returns text plus token usage.
 *
 * @param {Object} config App config (llmVendor, claudeModel, *BaseUrl, *ApiKey)
 * @param {{system:string, user:string, maxTokens:number}} opts
 * @returns {Promise<{text:string, inputTokens:number, outputTokens:number}>}
 */
async function callModel(config, { system, user, maxTokens }) {
  const vendor = config.llmVendor || 'anthropic';

  if (vendor === 'openai') {
    if (!config.openaiApiKey) {
      throw new Error('OpenAI API key не настроен (.env: OPENAI_API_KEY)');
    }
    // Lazy import so the package is never loaded for the anthropic path and a
    // missing install does not break startup.
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({
      apiKey: config.openaiApiKey,
      baseURL: config.openaiBaseUrl || undefined,
    });
    const supportedEfforts = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
    const effort = supportedEfforts.has(config.openaiReasoningEffort)
      ? config.openaiReasoningEffort
      : 'high';
    const resp = await withRetry(() => client.responses.create({
      model: config.claudeModel,
      instructions: system,
      input: user,
      max_output_tokens: maxTokens,
      reasoning: { effort },
      store: false,
    }));
    const text = textFromOpenAIResponse(resp);
    if (!text) {
      throw new Error('OpenAI returned an empty response');
    }
    return {
      text,
      inputTokens: resp.usage?.input_tokens || 0,
      outputTokens: resp.usage?.output_tokens || 0,
    };
  }

  // Default: Anthropic
  const client = new Anthropic({
    apiKey: config.anthropicApiKey,
    baseURL: config.anthropicBaseUrl || undefined,
  });
  const resp = await withRetry(() => client.messages.create({
    model: config.claudeModel,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  }));
  const textBlocks = Array.isArray(resp.content)
    ? resp.content.filter((block) => block?.type === 'text' && block.text).map((block) => block.text)
    : [];
  return {
    text: textBlocks.join('\n\n'),
    inputTokens: resp.usage?.input_tokens || 0,
    outputTokens: resp.usage?.output_tokens || 0,
  };
}

export async function generateDigest(db, articles, config) {
  const log = [];

  // Token accounting across every successful model call (Phase A + Phase B).
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  log.push(`Starting digest generation for ${articles.length} articles`);

  // Select Phase A system prompt by active scenario. Assembly (Phase B) is
  // scenario-independent and always uses config.assemblyPrompt.
  const scenario = config.activeScenario || 'sarcastic';
  let commentarySystem = scenario === 'architect' ? config.deepPrompt : config.commentaryPrompt;
  if (scenario === 'architect' && (!config.deepPrompt || !config.deepPrompt.trim())) {
    commentarySystem = config.commentaryPrompt;
    log.push('Scenario: architect requested but deepPrompt is empty — falling back to commentaryPrompt');
  } else {
    log.push(`Scenario: ${scenario}`);
  }

  // Phase A: Generate commentary for each article
  for (const article of articles) {
    if (article.commentary) {
      log.push(`Skipping article ${article.id} — commentary already exists`);
      continue;
    }

    try {
      updateArticleStatus(article.id, 'processing');

      const contentTruncated = (article.content || '').slice(0, MAX_CONTENT_LENGTH);

      let commentary = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await callModel(config, {
          system: commentarySystem,
          user: buildArticleUserMessage(article, contentTruncated, attempt > 0),
          maxTokens: 512,
        });
        commentary = humanizeDigestPunctuation(res.text);
        totalInputTokens += res.inputTokens;
        totalOutputTokens += res.outputTokens;

        if (!isInvalidCommentary(commentary)) break;
        log.push('Rejected invalid commentary for article ' + article.id + '; retrying once');
      }

      if (isInvalidCommentary(commentary)) {
        throw new Error('Model returned an invalid meta-commentary after retry');
      }

      updateArticleCommentary(article.id, commentary);
      article.commentary = commentary;

      log.push(`Generated commentary for article ${article.id}: ${commentary.slice(0, 60)}...`);

      await sleep(INTER_CALL_DELAY_MS);
    } catch (err) {
      log.push(`Error generating commentary for article ${article.id}: ${err.message}`);
      updateArticleStatus(article.id, 'error');
      // Continue with other articles
    }
  }

  // Filter articles that have commentary
  const articlesWithCommentary = articles.filter((a) => a.commentary);

  if (articlesWithCommentary.length === 0) {
    throw new Error('No articles with commentary — cannot assemble digest');
  }

  // Phase B: Assembly
  const today = new Date().toISOString().slice(0, 10);

  // Build the user message for assembly
  const commentaryList = articlesWithCommentary
    .map((a, i) => `${i + 1}. ${a.commentary}\n${a.url}`)
    .join('\n\n');

  const optionalAssemblyParts = [];

  if (config.hashtagsSuffix) {
    optionalAssemblyParts.push(`Нейтральные хэштеги в конце: ${config.hashtagsSuffix}`);
  }

  const assemblyUserMessage = [
    `Вот ${articlesWithCommentary.length} обработанных комментариев для сборки в дайджест:`,
    '',
    commentaryList,
    ...(optionalAssemblyParts.length ? ['', '---', ...optionalAssemblyParts] : []),
  ].join('\n');

  log.push('Assembling digest...');

  const assemblyRes = await callModel(config, {
    system: config.assemblyPrompt,
    user: assemblyUserMessage,
    maxTokens: 16384,
  });
  let digestContent = removeForbiddenPromoBlocks(humanizeDigestPunctuation(assemblyRes.text));
  totalInputTokens += assemblyRes.inputTokens;
  totalOutputTokens += assemblyRes.outputTokens;

  // Post-processing: remove any preamble before "#новости"
  // Claude sometimes adds explanatory text before the actual digest
  const digestStart = digestContent.indexOf('#новости');
  if (digestStart > 0) {
    digestContent = digestContent.substring(digestStart);
    log.push(`Removed ${digestStart} chars of preamble before #новости`);
  }

  digestContent = enforceCanonicalDigestLinks(
    digestContent,
    articlesWithCommentary,
    config.hashtagsSuffix
  );

  // Create digest record
  const digestId = createDigest({
    date: today,
    part: 1,
    articlesCount: articlesWithCommentary.length,
  });

  // Compute cost from accumulated token usage and the model's base pricing.
  const p = priceFor(config.claudeModel);
  let costUsd = null;
  if (p) {
    const raw = (totalInputTokens / 1e6) * p.input + (totalOutputTokens / 1e6) * p.output;
    costUsd = Math.round(raw * 1e6) / 1e6;
  }

  const costLabel = costUsd === null ? 'n/a' : `$${costUsd}`;
  log.push(`Tokens: in=${totalInputTokens} out=${totalOutputTokens} | Model: ${config.claudeModel} | Cost: ${costLabel}`);

  updateDigest(digestId, {
    content: digestContent,
    status: 'draft',
    generation_log: log.join('\n'),
    model: config.claudeModel,
    input_tokens: totalInputTokens,
    output_tokens: totalOutputTokens,
    cost_usd: costUsd,
  });

  // Assign articles to digest
  const articleIds = articlesWithCommentary.map((a) => a.id);
  assignArticlesToDigest(articleIds, digestId);

  // Save digest as .txt file
  const filePath = saveDigestToFile(today, digestContent);
  log.push(`Digest saved to file: ${filePath}`);
  log.push(`Digest created: ${digestId}`);

  // Clean up source Telegram messages ONLY after confirming the digest was
  // assembled successfully: digest row exists, content is non-empty, and the
  // `#новости` marker is present. If anything looks off, skip cleanup so the
  // source messages remain available for retry.
  const saved = getDigest(digestId);
  const digestOk = saved && typeof saved.content === 'string'
    && saved.content.length > 100
    && saved.content.includes('#новости');

  if (!digestOk) {
    log.push('Skipping source cleanup: digest not confirmed valid');
  } else if (config.telegramBotToken) {
    const { deleteTelegramMessage } = await import('./telegram-bot.js');
    const seen = new Set();
    let deleted = 0;
    let failed = 0;
    for (const a of articlesWithCommentary) {
      if (!a.source_chat_id || !a.source_message_id) continue;
      const key = `${a.source_chat_id}:${a.source_message_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const ok = await deleteTelegramMessage(config.telegramBotToken, a.source_chat_id, Number(a.source_message_id));
        if (ok) deleted++; else failed++;
      } catch {
        failed++;
      }
    }
    log.push(`Telegram source cleanup: deleted=${deleted}, failed=${failed}`);
  }

  return digestId;
}

function saveDigestToFile(date, content) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outputDir = join(__dirname, '../../output');
  mkdirSync(outputDir, { recursive: true });

  // Determine part number based on existing files for this date
  const existing = getDigests().filter((d) => d.date === date);
  const part = existing.length || 1;

  const filename = `digest_${date}_part${part}.txt`;
  const filePath = join(outputDir, filename);
  writeFileSync(filePath, content, 'utf-8');
  console.log(`[digest-generator] Saved digest to ${filePath}`);
  return filePath;
}
