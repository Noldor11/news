import { createHash } from 'crypto';
import config from '../config.js';
import {
  deleteArticle,
  deleteDigestAndReleaseArticles,
  getDb,
  getDigest,
  insertArticle,
  recordDuplicateArticle,
  resetArticlesForRetry,
} from '../db/index.js';
import { generateDigest } from './digest-generator.js';
import { publishDigest } from './publishers/index.js';

const DEFAULT_MIN_ARTICLES = 23;
const DEFAULT_HARD_MIN_ARTICLES = 8;
const DEFAULT_MAX_ARTICLES = 25;
const DEFAULT_GADGET_ARTICLES = 5;
const DEFAULT_MARKETPLACE_ARTICLES = 1;
const DEFAULT_MAX_AGE_HOURS = 36;
const DEFAULT_FALLBACK_MAX_AGE_HOURS = 72;
const DEFAULT_MAX_PER_SOURCE = 3;
const DEFAULT_FETCH_RETRIES = 2;
const FETCH_CANDIDATES = 80;
const FEED_TIMEOUT_MS = 15000;
const EVENT_HISTORY_DAYS = 10;

const sources = [
  { name: 'TechCrunch AI', url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
  { name: 'VentureBeat AI', url: 'https://venturebeat.com/category/ai/feed/' },
  { name: 'The Verge AI', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
  { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/technology-lab' },
  { name: 'MIT News AI', url: 'https://news.mit.edu/topic/mitartificial-intelligence2-rss.xml' },
  { name: 'OpenAI News', url: 'https://openai.com/news/rss.xml' },
  { name: 'Google AI Blog', url: 'https://blog.google/technology/ai/rss/' },
  { name: 'NVIDIA Blog', url: 'https://blogs.nvidia.com/feed/' },
  { name: 'Hugging Face', url: 'https://huggingface.co/blog/feed.xml' },
  { name: 'Wired AI', url: 'https://www.wired.com/feed/tag/ai/latest/rss' },
  { name: 'AWS Machine Learning', url: 'https://aws.amazon.com/blogs/machine-learning/feed/' },
  { name: 'ZDNet AI', url: 'https://www.zdnet.com/topic/artificial-intelligence/rss.xml' },
  { name: 'IEEE Spectrum AI', url: 'https://spectrum.ieee.org/feeds/topic/artificial-intelligence.rss' },
  { name: 'TechCrunch Gadgets', category: 'gadgets', url: 'https://techcrunch.com/category/gadgets/feed/' },
  { name: 'Ars Technica Gear & Gadgets', category: 'gadgets', url: 'https://feeds.arstechnica.com/arstechnica/gadgets' },
  { name: 'The Verge Gadgets', category: 'gadgets', url: 'https://www.theverge.com/rss/gadgets/index.xml' },
  { name: 'Upwork News', category: 'upwork', url: 'https://investors.upwork.com/rss/news-releases.xml' },
  { name: 'Fiverr News', category: 'fiverr', url: 'https://investors.fiverr.com/rss/news-releases.xml' },
  { name: 'LinkedIn Pressroom', category: 'linkedin', format: 'linkedin-pressroom', url: 'https://news.linkedin.com/' },
];

const techTerms = [
  'ai', 'artificial intelligence', 'openai', 'anthropic', 'claude', 'gpt', 'gemini', 'deepmind', 'llm',
  'agent', 'model', 'robot', 'robotics', 'automation', 'software', 'coding', 'cybersecurity', 'security',
  'chip', 'semiconductor', 'nvidia', 'gpu', 'cloud', 'startup', 'data center', 'machine learning', 'neural',
  'copilot', 'cursor', 'perplexity', 'quantum', 'privacy', 'data', 'platform', 'developer', 'api',
];

const gadgetTerms = [
  'gadget', 'device', 'hardware', 'smartphone', 'phone', 'laptop', 'tablet', 'wearable', 'smartwatch',
  'earbuds', 'headphones', 'camera', 'drone', 'smart home', 'robot vacuum', 'foldable', 'vr', 'ar',
  'consumer electronics',
];

const marketplaceTerms = [
  'upwork', 'fiverr', 'linkedin', 'freelance', 'freelancer', 'freelancing', 'talent marketplace',
  'talent', 'client', 'contractor', 'gig', 'gigs', 'hiring', 'job search', 'professional network',
  'professional', 'workforce', 'creator economy', 'proposal', 'connects',
];

const nonTechTerms = [
  'election', 'president', 'prime minister', 'parliament', 'congress', 'government', 'politics', 'political',
  'war', 'battlefield', 'military', 'missile', 'ceasefire', 'sanction', 'invasion', 'protest', 'diplomacy',
  'ukraine', 'russia', 'gaza', 'israel', 'iran', 'china tariffs', 'celebrity', 'football', 'basketball',
  'movie review', 'royal family', 'crime', 'murder',
];

const titleStopWords = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'is', 'it', 'of', 'on', 'or',
  'the', 'to', 'with', 'your', 'new', 'this', 'that', 'how', 'why', 'what', 'will', 'its', 'after', 'about',
  'available', 'both', 'capable', 'compare', 'compared', 'first', 'here', 'made', 'make', 'makes',
  'model', 'more', 'most', 'one',
  'как', 'что', 'это', 'для', 'или', 'при', 'про', 'без', 'под', 'над', 'уже', 'еще', 'ещё', 'его', 'ее',
  'её', 'они', 'она', 'оно', 'этот', 'эта', 'эти', 'который', 'которая', 'которые', 'после', 'перед',
]);

const tokenAliases = new Map([
  ['hacked', 'hack'],
  ['hacking', 'hack'],
  ['hacks', 'hack'],
  ['breached', 'breach'],
  ['breaches', 'breach'],
  ['models', 'model'],
  ['agents', 'agent'],
  ['systems', 'system'],
  ['updates', 'update'],
  ['updated', 'update'],
  ['launches', 'launch'],
  ['launched', 'launch'],
  ['deepfakes', 'deepfake-abuse'],
  ['deepfake', 'deepfake-abuse'],
  ['nonconsensual', 'deepfake-abuse'],
  ['nudes', 'deepfake-abuse'],
  ['nude', 'deepfake-abuse'],
  ['undress', 'deepfake-abuse'],
]);

const eventActionTokens = new Set([
  'acquisition', 'ban', 'breach', 'deepfake-abuse', 'exploit', 'funding', 'hack', 'incident',
  'launch', 'lawsuit', 'mode', 'release', 'security', 'update', 'vulnerability', 'voice',
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function resolveRssSettings(appConfig = config) {
  const maxArticles = clampInteger(appConfig.maxArticlesPerDigest, DEFAULT_MAX_ARTICLES, 1, 30);
  const minArticles = Math.min(
    maxArticles,
    clampInteger(appConfig.minArticlesPerDigest, DEFAULT_MIN_ARTICLES, 1, maxArticles),
  );
  const hardMinArticles = Math.min(
    minArticles,
    clampInteger(appConfig.hardMinArticlesPerDigest, DEFAULT_HARD_MIN_ARTICLES, 1, minArticles),
  );

  const maxAgeHours = clampInteger(
    appConfig.rssMaxArticleAgeHours,
    DEFAULT_MAX_AGE_HOURS,
    1,
    168,
  );
  const fallbackMaxAgeHours = Math.max(
    maxAgeHours,
    clampInteger(
      appConfig.rssFallbackMaxArticleAgeHours,
      DEFAULT_FALLBACK_MAX_AGE_HOURS,
      maxAgeHours,
      168,
    ),
  );

  return {
    minArticles,
    hardMinArticles,
    maxArticles,
    maxAgeHours,
    fallbackMaxAgeHours,
    maxPerSource: clampInteger(appConfig.rssMaxArticlesPerSource, DEFAULT_MAX_PER_SOURCE, 1, maxArticles),
    gadgetArticlesPerDigest: clampInteger(
      appConfig.gadgetArticlesPerDigest,
      DEFAULT_GADGET_ARTICLES,
      0,
      maxArticles,
    ),
    marketplaceArticlesPerDigest: clampInteger(
      appConfig.marketplaceArticlesPerDigest,
      DEFAULT_MARKETPLACE_ARTICLES,
      0,
      maxArticles,
    ),
    fetchRetries: clampInteger(appConfig.rssFetchRetries, DEFAULT_FETCH_RETRIES, 0, 5),
  };
}

export function selectCandidatesWithFallback(
  items,
  settings,
  excludedUrls = new Set(),
  priorArticles = [],
) {
  const select = (maxAgeHours) => selectDigestCandidatesDetailed(items, {
    maxAgeHours,
    maxPerSource: settings.maxPerSource,
    limit: FETCH_CANDIDATES,
    gadgetArticlesPerDigest: settings.gadgetArticlesPerDigest,
    marketplaceArticlesPerDigest: settings.marketplaceArticlesPerDigest,
    excludedUrls,
    priorArticles,
  });

  const primary = select(settings.maxAgeHours);
  if (primary.selected.length >= settings.hardMinArticles
      || settings.fallbackMaxAgeHours <= settings.maxAgeHours) {
    return {
      candidates: primary.selected,
      rejectedDuplicates: primary.rejectedDuplicates,
      fallbackUsed: false,
      effectiveMaxAgeHours: settings.maxAgeHours,
    };
  }

  const fallback = select(settings.fallbackMaxAgeHours);
  return {
    candidates: fallback.selected,
    rejectedDuplicates: fallback.rejectedDuplicates,
    fallbackUsed: true,
    effectiveMaxAgeHours: settings.fallbackMaxAgeHours,
  };
}

export function classifyArticleCount(count, settings) {
  if (count < settings.hardMinArticles) return 'insufficient';
  if (count < settings.minArticles) return 'degraded';
  return 'full';
}

export class InsufficientArticlesError extends Error {
  constructor(message, metrics = {}) {
    super(message);
    this.name = 'InsufficientArticlesError';
    this.retryable = false;
    this.metrics = metrics;
  }
}

function decodeXml(value = '') {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripHtml(value = '') {
  return decodeXml(value)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function readTag(block, name) {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return match ? decodeXml(match[1]).trim() : '';
}

function readAttr(block, tagName, attrName) {
  const match = block.match(new RegExp(`<${tagName}\\b[^>]*\\b${attrName}=["']([^"']+)["'][^>]*>`, 'i'));
  return match ? decodeXml(match[1]).trim() : '';
}

function readUrl(block) {
  const alternate = block.match(/<link\b[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["'][^>]*>/i)
    || block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']alternate["'][^>]*>/i);
  if (alternate) return decodeXml(alternate[1]).trim();
  return readAttr(block, 'link', 'href') || readTag(block, 'link') || readTag(block, 'guid');
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function parseFeed(xml, source) {
  const sourceName = typeof source === 'string' ? source : source.name;
  const category = typeof source === 'string' ? 'ai-tech' : (source.category || 'ai-tech');
  const blocks = [
    ...(xml.match(/<item\b[\s\S]*?<\/item>/gi) || []),
    ...(xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || []),
  ];

  return blocks.map((block) => {
    const title = stripHtml(readTag(block, 'title'));
    const url = normalizeUrl(readUrl(block));
    const summary = stripHtml(
      readTag(block, 'description')
      || readTag(block, 'summary')
      || readTag(block, 'content:encoded')
      || readTag(block, 'content')
    );
    const publishedAt = readTag(block, 'pubDate') || readTag(block, 'updated') || readTag(block, 'published') || '';
    return { title, url, summary, publishedAt, source: sourceName, category };
  }).filter((item) => item.title && item.url && item.summary.length >= 80);
}

function readClassTag(block, tagName, className) {
  const match = block.match(new RegExp(
    `<${tagName}\\b[^>]*\\bclass=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/${tagName}>`,
    'i',
  ));
  return match ? decodeXml(match[1]).trim() : '';
}

export function parseLinkedInPressroom(html, source = { name: 'LinkedIn Pressroom', category: 'linkedin', url: 'https://news.linkedin.com/' }) {
  const sourceName = typeof source === 'string' ? source : source.name;
  const category = typeof source === 'string' ? 'linkedin' : (source.category || 'linkedin');
  const baseUrl = typeof source === 'string' ? 'https://news.linkedin.com/' : source.url;
  const blocks = [
    ...(html.match(/<article\b[\s\S]*?<\/article>/gi) || []),
    ...(html.match(/<li\b[^>]*\bcmp-post-list__item\b[\s\S]*?<\/li>/gi) || []),
  ];

  return blocks.map((block) => {
    const headline = block.match(
      /<a\b(?=[^>]*\b(?:post-headline|cmp-post-card__title-link)\b)(?=[^>]*\bhref=["']([^"']+)["'])[^>]*>([\s\S]*?)<\/a>/i,
    );
    if (!headline) return null;
    const rawUrl = headline[1];
    const url = normalizeUrl(new URL(rawUrl, baseUrl).toString());
    const title = stripHtml(headline[2]);
    const summary = stripHtml(
      readClassTag(block, 'p', 'post-summary')
      || readClassTag(block, 'p', 'cmp-post-card__description'),
    );
    const publishedAt = readAttr(block, 'time', 'datetime')
      || stripHtml(readClassTag(block, 'time', 'date'))
      || stripHtml(readClassTag(block, 'time', 'cmp-post-card__date'));
    return { title, url, summary, publishedAt, source: sourceName, category };
  }).filter((item) => item && item.title && item.url && item.summary.length >= 80);
}

export function scoreItem(item, maxAgeHours = DEFAULT_MAX_AGE_HOURS) {
  const text = [item.title, item.summary, item.source].join(' ').toLowerCase();
  const category = item.category || item.feedCategory || 'ai-tech';
  const baseTechScore = techTerms.reduce((sum, term) => sum + (text.includes(term) ? 3 : 0), 0);
  const gadgetScore = category === 'gadgets'
    ? gadgetTerms.reduce((sum, term) => sum + (text.includes(term) ? 3 : 0), 0)
    : 0;
  const marketplaceScore = ['upwork', 'fiverr', 'linkedin'].includes(category)
    ? marketplaceTerms.reduce((sum, term) => sum + (text.includes(term) ? 3 : 0), 0)
    : 0;
  const techScore = baseTechScore + gadgetScore + marketplaceScore;
  const nonTechScore = nonTechTerms.reduce((sum, term) => sum + (text.includes(term) ? 4 : 0), 0);
  const timestamp = Date.parse(item.publishedAt);
  const ageHours = Number.isNaN(timestamp) ? maxAgeHours + 1 : Math.max(0, (Date.now() - timestamp) / 3600000);
  const recencyScore = Math.max(0, maxAgeHours - ageHours) / 6;
  return {
    score: techScore + recencyScore - nonTechScore,
    ageHours,
    techScore,
    gadgetScore,
    marketplaceScore,
    nonTechScore,
    category,
  };
}

export function isFreshTechItem(meta, maxAgeHours = DEFAULT_MAX_AGE_HOURS) {
  if (meta.ageHours > maxAgeHours || meta.techScore < 3) return false;
  // A primarily political/news item is rejected even when it mentions AI once.
  return !(meta.nonTechScore >= 4 && meta.techScore < 9);
}

function titleTokens(title) {
  return new Set(
    String(title || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(/\s+/)
      .map((word) => tokenAliases.get(word) || word)
      .filter((word) => word.length > 2 && !titleStopWords.has(word))
  );
}

function tokenSimilarity(a, b) {
  if (a.size === 0 || b.size === 0) return { score: 0, shared: 0, sharedTokens: [] };
  let intersection = 0;
  const sharedTokens = [];
  for (const word of a) {
    if (!b.has(word)) continue;
    intersection += 1;
    sharedTokens.push(word);
  }
  return {
    score: intersection / (a.size + b.size - intersection),
    shared: intersection,
    sharedTokens,
  };
}

export function titleSimilarity(left, right) {
  return tokenSimilarity(titleTokens(left), titleTokens(right)).score;
}

function eventTokens(item) {
  return titleTokens([item.title, item.summary || item.content].filter(Boolean).join(' '));
}

export function eventSimilarity(left, right) {
  const title = tokenSimilarity(titleTokens(left.title), titleTokens(right.title));
  const combined = tokenSimilarity(eventTokens(left), eventTokens(right));
  const sharesEventAction = title.sharedTokens.some((token) => eventActionTokens.has(token))
    || combined.sharedTokens.some((token) => eventActionTokens.has(token));
  const duplicate = title.score >= 0.42
    || (sharesEventAction && title.shared >= 4 && title.score >= 0.33)
    || (sharesEventAction && title.shared >= 3 && title.score >= 0.3)
    || (sharesEventAction && title.shared >= 3 && combined.score >= 0.28)
    || (sharesEventAction && title.shared >= 2 && combined.score >= 0.4);
  return {
    duplicate,
    score: Math.max(title.score, combined.score),
    titleScore: title.score,
    combinedScore: combined.score,
    sharedTitleTokens: title.shared,
    sharesEventAction,
  };
}

export function buildEventFingerprint(item) {
  const normalized = [...eventTokens(item)].sort().slice(0, 16).join('|');
  return createHash('sha256').update(normalized || String(item.url || '')).digest('hex').slice(0, 24);
}

function findEventDuplicate(item, references) {
  let best = null;
  for (const reference of references) {
    const similarity = eventSimilarity(item, reference);
    if (!similarity.duplicate || (best && best.similarity.score >= similarity.score)) continue;
    best = { reference, similarity };
  }
  return best;
}

export function selectDiverseCandidatesDetailed(items, settings = {}) {
  const maxAgeHours = settings.maxAgeHours || DEFAULT_MAX_AGE_HOURS;
  const maxPerSource = settings.maxPerSource || DEFAULT_MAX_PER_SOURCE;
  const limit = settings.limit || FETCH_CANDIDATES;
  const excludedUrls = settings.excludedUrls instanceof Set
    ? settings.excludedUrls
    : new Set(settings.excludedUrls || []);
  const seenUrls = new Set();
  const selected = [];
  const rejectedDuplicates = [];
  const priorArticles = Array.isArray(settings.priorArticles) ? settings.priorArticles : [];
  const sourceCounts = new Map();

  const ranked = items
    .map((item) => ({ ...item, meta: item.meta || scoreItem(item, maxAgeHours) }))
    .filter((item) => isFreshTechItem(item.meta, maxAgeHours))
    .sort((a, b) => b.meta.score - a.meta.score || a.meta.ageHours - b.meta.ageHours);

  for (const item of ranked) {
    if (selected.length >= limit || seenUrls.has(item.url) || excludedUrls.has(item.url)) continue;
    if ((sourceCounts.get(item.source) || 0) >= maxPerSource) continue;
    const match = findEventDuplicate(item, [...priorArticles, ...selected]);
    if (match) {
      rejectedDuplicates.push({
        ...item,
        duplicateOf: match.reference.url,
        duplicateReason: priorArticles.includes(match.reference)
          ? 'recent-event'
          : 'same-batch-event',
        eventFingerprint: match.reference.eventFingerprint
          || match.reference.event_fingerprint
          || buildEventFingerprint(match.reference),
        similarity: match.similarity,
      });
      continue;
    }

    seenUrls.add(item.url);
    sourceCounts.set(item.source, (sourceCounts.get(item.source) || 0) + 1);
    selected.push({ ...item, eventFingerprint: buildEventFingerprint(item) });
  }

  return { selected, rejectedDuplicates };
}

export function selectDiverseCandidates(items, settings = {}) {
  return selectDiverseCandidatesDetailed(items, settings).selected;
}

export function isGadgetItem(item) {
  return item?.category === 'gadgets' || item?.feedCategory === 'gadgets';
}

/**
 * Reserve the requested candidates for each configured lane before filling
 * the remaining slots from the general AI/tech pool.
 */
export function selectDigestCandidatesDetailed(items, settings = {}) {
  const limit = settings.limit || FETCH_CANDIDATES;
  const laneTargets = [
    {
      category: 'gadgets',
      target: clampInteger(settings.gadgetArticlesPerDigest, DEFAULT_GADGET_ARTICLES, 0, limit),
    },
    ...['upwork', 'fiverr', 'linkedin'].map((category) => ({
      category,
      target: clampInteger(
        settings.marketplaceArticlesPerDigest,
        DEFAULT_MARKETPLACE_ARTICLES,
        0,
        limit,
      ),
    })),
  ].filter((lane) => lane.target > 0);

  if (laneTargets.length === 0) return selectDiverseCandidatesDetailed(items, settings);

  const selected = [];
  const rejectedDuplicates = [];
  const activeLaneCategories = new Set(laneTargets.map((lane) => lane.category));
  let remaining = limit;
  let priorArticles = [...(settings.priorArticles || [])];

  for (const lane of laneTargets) {
    if (remaining <= 0) break;
    const laneItems = items.filter((item) => (item.category || item.feedCategory || 'ai-tech') === lane.category);
    const laneResult = selectDiverseCandidatesDetailed(laneItems, {
      ...settings,
      limit: Math.min(lane.target, remaining),
      priorArticles,
    });
    selected.push(...laneResult.selected);
    rejectedDuplicates.push(...laneResult.rejectedDuplicates);
    remaining -= laneResult.selected.length;
    priorArticles = [...priorArticles, ...laneResult.selected];
  }

  const coreItems = items.filter((item) => !activeLaneCategories.has(item.category || item.feedCategory || 'ai-tech'));
  const coreResult = remaining > 0
    ? selectDiverseCandidatesDetailed(coreItems, {
      ...settings,
      limit: remaining,
      priorArticles,
    })
    : { selected: [], rejectedDuplicates: [] };

  return {
    selected: [...selected, ...coreResult.selected],
    rejectedDuplicates: [...rejectedDuplicates, ...coreResult.rejectedDuplicates],
  };
}

async function fetchFeedOnce(source) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const response = await fetch(source.url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GDN/1.0)',
        Accept: 'application/rss+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.text();
    return source.format === 'linkedin-pressroom'
      ? parseLinkedInPressroom(body, source)
      : parseFeed(body, source);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFeed(source, retries) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchFeedOnce(source);
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(Math.min(1000 * (2 ** attempt), 5000));
    }
  }
  throw lastError;
}

async function collectCandidates(settings, excludedUrls = new Set(), priorArticles = []) {
  const sourceErrors = [];
  const feedResults = await Promise.all(sources.map(async (source) => {
    try {
      return await fetchFeed(source, settings.fetchRetries);
    } catch (error) {
      sourceErrors.push(`${source.name}: ${error.message}`);
      return [];
    }
  }));

  const { candidates, rejectedDuplicates, fallbackUsed, effectiveMaxAgeHours } = selectCandidatesWithFallback(
    feedResults.flat(),
    settings,
    excludedUrls,
    priorArticles,
  );

  const publicationMode = classifyArticleCount(candidates.length, settings);
  if (publicationMode === 'insufficient') {
    throw new InsufficientArticlesError(
      'Only ' + candidates.length + ' fresh, diverse AI/tech, gadget, and platform candidates were collected; '
      + 'hard floor is ' + settings.hardMinArticles + '. Source errors: '
      + (sourceErrors.join('; ') || 'none'),
      { candidateCount: candidates.length, sourceErrors, publicationMode, fallbackUsed, effectiveMaxAgeHours },
    );
  }

  return {
    candidates,
    rejectedDuplicates,
    sourceErrors,
    publicationMode,
    fallbackUsed,
    effectiveMaxAgeHours,
  };
}

function getArticlesByIds(db, ids) {
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM articles WHERE id IN (${placeholders})`).all(...ids);
  const byId = new Map(rows.map((article) => [article.id, article]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

function canReuseArticle(article) {
  return article.source === 'railway-rss'
    && !article.digest_id
    && ['new', 'error'].includes(article.status);
}

function getDedupHistory(db) {
  const existing = db.prepare(
    `SELECT id, url, title, content, source, status, digest_id,
            event_fingerprint, created_at
     FROM articles
     WHERE url IS NOT NULL`,
  ).all();

  // Failed, unattached RSS entries remain retryable. All other URLs are
  // excluded before diversity caps, so former top stories cannot crowd out
  // newer candidates from the same source.
  const excludedUrls = new Set(existing
    .filter((article) => !canReuseArticle(article))
    .map((article) => article.url));

  const priorArticles = existing
    .filter((article) => article.source === 'railway-rss'
      && article.digest_id
      && article.status === 'used'
      && Date.parse(`${article.created_at}Z`) >= Date.now() - EVENT_HISTORY_DAYS * 86400000)
    .map((article) => ({
      ...article,
      summary: article.content || '',
      eventFingerprint: article.event_fingerprint,
    }));

  return { excludedUrls, priorArticles };
}

/**
 * Collect, generate, and publish one daily RSS digest. The automation route
 * owns the run lock; this function remains usable for a controlled manual job.
 */
export async function runDailyRssDigest({ onDigestReady, onProgress } = {}) {
  const settings = resolveRssSettings();
  const db = getDb();
  const { excludedUrls, priorArticles } = getDedupHistory(db);
  const {
    candidates,
    rejectedDuplicates,
    sourceErrors,
    publicationMode: collectedMode,
    fallbackUsed,
    effectiveMaxAgeHours,
  } = await collectCandidates(settings, excludedUrls, priorArticles);
  const duplicateReasons = rejectedDuplicates.reduce((counts, item) => {
    counts[item.duplicateReason] = (counts[item.duplicateReason] || 0) + 1;
    return counts;
  }, {});
  if (onProgress) {
    await onProgress('collected', {
      candidateCount: candidates.length,
      semanticDuplicateCount: rejectedDuplicates.length,
      duplicateReasons,
      sourceErrorCount: sourceErrors.length,
      publicationMode: collectedMode,
      fallbackUsed,
      effectiveMaxAgeHours,
    });
  }
  const selectedArticleIds = [];
  const insertedArticleIds = [];
  let exactDuplicates = 0;
  let reused = 0;

  for (const item of candidates) {
    if (selectedArticleIds.length >= settings.maxArticles) break;

    const content = [
      `Заголовок: ${item.title}`,
      `Источник: ${item.source}`,
      `Краткое описание: ${item.summary}`,
    ].join('\n\n').slice(0, 6000);

    const result = insertArticle({
      url: item.url,
      title: item.title,
      content,
      source: 'railway-rss',
      eventFingerprint: item.eventFingerprint,
    });

    if (result.duplicate) {
      exactDuplicates += 1;
      if (canReuseArticle(result) && !selectedArticleIds.includes(result.id)) {
        if (result.status === 'error') resetArticlesForRetry([result.id]);
        selectedArticleIds.push(result.id);
        reused += 1;
      }
      continue;
    }

    insertedArticleIds.push(result.id);
    selectedArticleIds.push(result.id);
  }

  const selectedMode = classifyArticleCount(selectedArticleIds.length, settings);
  const duplicates = exactDuplicates + rejectedDuplicates.length;
  if (selectedMode === 'insufficient') {
    for (const articleId of insertedArticleIds) deleteArticle(articleId);
    throw new InsufficientArticlesError(
      'Only ' + selectedArticleIds.length + ' new or safely retryable articles were available; '
      + 'hard floor is ' + settings.hardMinArticles + '. Duplicates: ' + duplicates + '.',
      {
        selectedCount: selectedArticleIds.length,
        duplicates,
        semanticDuplicates: rejectedDuplicates.length,
        duplicateReasons,
        publicationMode: selectedMode,
      },
    );
  }

  const articles = getArticlesByIds(db, selectedArticleIds);
  const articleMode = classifyArticleCount(articles.length, settings);
  if (articleMode === 'insufficient') {
    for (const articleId of insertedArticleIds) deleteArticle(articleId);
    throw new InsufficientArticlesError(
      'Article lookup returned ' + articles.length + '; hard floor is ' + settings.hardMinArticles + '.',
      { selectedCount: articles.length, publicationMode: articleMode },
    );
  }
  if (onProgress) {
    await onProgress('selected', {
      candidateCount: candidates.length,
      selectedCount: articles.length,
      duplicates,
      semanticDuplicates: rejectedDuplicates.length,
      duplicateReasons,
      reused,
      publicationMode: articleMode,
    });
  }

  let digestId;
  try {
    digestId = await generateDigest(db, articles, config);
  } catch (error) {
    resetArticlesForRetry(selectedArticleIds);
    throw error;
  }

  const digest = getDigest(digestId);
  const digestMode = classifyArticleCount(digest?.articles_count || 0, settings);
  if (!digest || digestMode === 'insufficient') {
    if (digestId) deleteDigestAndReleaseArticles(digestId);
    resetArticlesForRetry(selectedArticleIds);
    throw new InsufficientArticlesError(
      'Digest generated only ' + (digest?.articles_count || 0) + ' publishable articles; '
      + 'hard floor is ' + settings.hardMinArticles + '. Articles were returned to the queue.',
      { generatedCount: digest?.articles_count || 0, publicationMode: digestMode },
    );
  }

  let recordedDuplicates = 0;
  for (const item of rejectedDuplicates) {
    const content = [
      `Заголовок: ${item.title}`,
      `Источник: ${item.source}`,
      `Краткое описание: ${item.summary}`,
    ].join('\n\n').slice(0, 6000);
    const recorded = recordDuplicateArticle({
      url: item.url,
      title: item.title,
      content,
      source: 'railway-rss',
      eventFingerprint: item.eventFingerprint,
      duplicateOf: item.duplicateOf,
      duplicateReason: item.duplicateReason,
    });
    if (recorded.recorded) recordedDuplicates += 1;
  }

  // Keep successful digest articles attached, but retry only the model failures
  // on a later run instead of leaving them permanently in the error state.
  const failedArticleIds = getArticlesByIds(db, selectedArticleIds)
    .filter((article) => article.status === 'error')
    .map((article) => article.id);
  resetArticlesForRetry(failedArticleIds);

  if (onDigestReady) await onDigestReady(digestId);
  const published = await publishDigest(digest, config, ['telegram']);

  return {
    ok: Boolean(published.telegram?.ok),
    collected: candidates.length,
    selected: articles.length,
    duplicates,
    exactDuplicates,
    semanticDuplicates: rejectedDuplicates.length,
    duplicateReasons,
    recordedDuplicates,
    reused,
    modelRetriesQueued: failedArticleIds.length,
    publicationMode: digestMode,
    degraded: digestMode === 'degraded',
    preferredMinimum: settings.minArticles,
    fallbackUsed,
    effectiveMaxAgeHours,
    hardMinimum: settings.hardMinArticles,
    digestId,
    published: { telegram: published.telegram || null },
    sourceErrors,
  };
}
