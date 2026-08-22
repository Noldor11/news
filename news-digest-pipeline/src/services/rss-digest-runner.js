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
import { resolveHistoricalDuplicates } from './semantic-dedup.js';

const DEFAULT_MIN_ARTICLES = 23;
const DEFAULT_HARD_MIN_ARTICLES = 15;
const DEFAULT_MAX_ARTICLES = 25;
const DEFAULT_GADGET_ARTICLES = 5;
const DEFAULT_MARKETPLACE_ARTICLES = 1;
const DEFAULT_WORK_MARKET_ARTICLES = 7;
const DEFAULT_WORK_MARKET_MAX_AGE_HOURS = 36;
const DEFAULT_MAX_AGE_HOURS = 36;
const DEFAULT_FALLBACK_MAX_AGE_HOURS = 72;
const DEFAULT_MAX_PER_SOURCE = 3;
const DEFAULT_RECOVERY_MAX_AGE_HOURS = 120;
const DEFAULT_RECOVERY_MAX_PER_SOURCE = 4;
const DEFAULT_FETCH_RETRIES = 2;
const FETCH_CANDIDATES = 80;
const FEED_TIMEOUT_MS = 15000;
const DEFAULT_EVENT_HISTORY_DAYS = 30;

const WORK_MARKET_CATEGORIES = new Set(['upwork', 'fiverr', 'linkedin', 'freelance-market']);
const workMarketFeedTerms = [
  'ai', 'automation', 'freelance', 'freelancer', 'gig economy', 'independent work', 'contractor',
  'contingent workforce', 'future of work', 'remote work', 'hiring', 'jobs', 'job market', 'labor market',
  'talent marketplace', 'skills demand', 'upwork', 'fiverr', 'linkedin', 'n8n', 'zapier', 'make.com',
];
const strictFreelanceFeedTerms = [
  'freelance', 'freelancer', 'gig economy', 'independent work', 'contractor', 'contingent workforce',
  'talent marketplace', 'creator economy', 'upwork', 'fiverr',
];

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
  { name: 'MIT Technology Review AI', url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed/' },
  { name: '404 Media', url: 'https://www.404media.co/rss/' },
  { name: 'Google Research', url: 'https://research.google/blog/rss/' },
  { name: 'Microsoft Research', url: 'https://www.microsoft.com/en-us/research/feed/' },
  { name: 'Simon Willison', url: 'https://simonwillison.net/atom/everything/' },
  // Official engineering/research feeds widen the pool without introducing a
  // generic news search that could pull politics or low-quality reposts.
  { name: 'GitHub Blog', url: 'https://github.blog/feed/' },
  { name: 'GitHub Changelog', url: 'https://github.blog/changelog/feed/' },
  { name: 'Mozilla Hacks', url: 'https://hacks.mozilla.org/feed/' },
  { name: 'Meta Engineering', url: 'https://engineering.fb.com/feed/' },
  { name: 'Google Developers Blog', url: 'https://developers.googleblog.com/feeds/posts/default?alt=rss' },
  { name: 'Cloudflare Blog', url: 'https://blog.cloudflare.com/rss/' },
  { name: 'TechCrunch Security', url: 'https://techcrunch.com/category/security/feed/' },
  { name: 'Hackaday', category: 'gadgets', url: 'https://hackaday.com/blog/feed/' },
  { name: 'TechCrunch Gadgets', category: 'gadgets', url: 'https://techcrunch.com/category/gadgets/feed/' },
  { name: 'Ars Technica Gear & Gadgets', category: 'gadgets', url: 'https://feeds.arstechnica.com/arstechnica/gadgets' },
  { name: 'The Verge Gadgets', category: 'gadgets', url: 'https://www.theverge.com/rss/gadgets/index.xml' },
  { name: 'Engadget', category: 'gadgets', url: 'https://www.engadget.com/rss.xml' },
  { name: 'Apple Newsroom', category: 'gadgets', url: 'https://www.apple.com/newsroom/rss-feed.rss' },
  {
    name: 'Google News Upwork Market',
    category: 'upwork',
    url: 'https://news.google.com/rss/search?q=%22Upwork%22%20(freelance%20OR%20freelancer%20OR%20hiring%20OR%20jobs%20OR%20demand%20OR%20fees%20OR%20policy)%20-site%3Aupwork.com%20-site%3Ainvestors.upwork.com%20when%3A3d&hl=en-US&gl=US&ceid=US%3Aen',
    blockedPublisherDomains: ['upwork.com'],
  },
  {
    name: 'Google News Fiverr Market',
    category: 'fiverr',
    url: 'https://news.google.com/rss/search?q=%22Fiverr%22%20(freelance%20OR%20freelancer%20OR%20hiring%20OR%20jobs%20OR%20demand%20OR%20fees%20OR%20policy)%20-site%3Afiverr.com%20-site%3Ainvestors.fiverr.com%20when%3A3d&hl=en-US&gl=US&ceid=US%3Aen',
    blockedPublisherDomains: ['fiverr.com'],
  },
  {
    name: 'Google News LinkedIn Work Market',
    category: 'linkedin',
    url: 'https://news.google.com/rss/search?q=%22LinkedIn%22%20(hiring%20OR%20jobs%20OR%20freelance%20OR%20workforce%20OR%20AI%20OR%20automation)%20-site%3Alinkedin.com%20-site%3Anews.linkedin.com%20when%3A3d&hl=en-US&gl=US&ceid=US%3Aen',
    blockedPublisherDomains: ['linkedin.com'],
  },
  { name: 'LinkedIn Pressroom', category: 'linkedin', format: 'linkedin-pressroom', url: 'https://news.linkedin.com/' },
  {
    name: 'Google News Freelance Market',
    category: 'freelance-market',
    url: 'https://news.google.com/rss/search?q=(%22freelance%20market%22%20OR%20%22gig%20economy%22%20OR%20%22independent%20work%22%20OR%20%22contingent%20workforce%22)%20(AI%20OR%20automation%20OR%20hiring%20OR%20demand%20OR%20rates%20OR%20jobs)%20when%3A2d&hl=en-US&gl=US&ceid=US%3Aen',
    requiredAnyTerms: workMarketFeedTerms,
  },
  {
    name: 'Google News AI Automation Work',
    category: 'freelance-market',
    url: 'https://news.google.com/rss/search?q=(%22AI%20automation%22%20OR%20%22AI%20agents%22%20OR%20n8n%20OR%20Zapier%20OR%20%22Make.com%22)%20(freelance%20OR%20jobs%20OR%20hiring%20OR%20demand%20OR%20skills)%20when%3A2d&hl=en-US&gl=US&ceid=US%3Aen',
    requiredAnyTerms: workMarketFeedTerms,
  },
  {
    name: 'Indeed Hiring Lab',
    category: 'freelance-market',
    url: 'https://www.hiringlab.org/feed/',
    requiredAnyTerms: workMarketFeedTerms,
  },
  {
    name: 'Allwork Space Workforce',
    category: 'freelance-market',
    url: 'https://allwork.space/category/workforce/feed/',
    requiredAnyTerms: workMarketFeedTerms,
  },
  {
    name: 'Allwork Space Tech',
    category: 'freelance-market',
    url: 'https://allwork.space/category/tech/feed/',
    requiredAnyTerms: workMarketFeedTerms,
  },
  { name: 'Freelancers Union', category: 'freelance-market', url: 'https://blog.freelancersunion.org/rss/' },
  { name: 'Freelance Informer AI', category: 'freelance-market', url: 'https://www.freelanceinformer.com/category/artificial-intelligence/feed/' },
  {
    name: 'PYMNTS Freelance Market',
    category: 'freelance-market',
    url: 'https://www.pymnts.com/feed/',
    requiredAnyTerms: strictFreelanceFeedTerms,
  },
  { name: 'Freelancing.eu', category: 'freelance-market', url: 'https://freelancingeu.substack.com/feed' },
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function resolveRssSettings(appConfig = config, { recoveryMode = false } = {}) {
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
  const regularFallbackMaxAgeHours = Math.max(
    maxAgeHours,
    clampInteger(
      appConfig.rssFallbackMaxArticleAgeHours,
      DEFAULT_FALLBACK_MAX_AGE_HOURS,
      maxAgeHours,
      168,
    ),
  );
  const regularMaxPerSource = clampInteger(
    appConfig.rssMaxArticlesPerSource,
    DEFAULT_MAX_PER_SOURCE,
    1,
    maxArticles,
  );
  const fallbackMaxAgeHours = recoveryMode
    ? Math.max(
      regularFallbackMaxAgeHours,
      clampInteger(
        appConfig.rssRecoveryMaxArticleAgeHours,
        DEFAULT_RECOVERY_MAX_AGE_HOURS,
        regularFallbackMaxAgeHours,
        168,
      ),
    )
    : regularFallbackMaxAgeHours;
  const maxPerSource = recoveryMode
    ? Math.max(
      regularMaxPerSource,
      clampInteger(
        appConfig.rssRecoveryMaxArticlesPerSource,
        DEFAULT_RECOVERY_MAX_PER_SOURCE,
        regularMaxPerSource,
        maxArticles,
      ),
    )
    : regularMaxPerSource;

  return {
    minArticles,
    hardMinArticles,
    maxArticles,
    maxAgeHours,
    fallbackMaxAgeHours,
    maxPerSource,
    recoveryMode,
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
    workMarketArticlesPerDigest: clampInteger(
      appConfig.workMarketArticlesPerDigest,
      DEFAULT_WORK_MARKET_ARTICLES,
      0,
      maxArticles,
    ),
    workMarketMaxAgeHours: clampInteger(
      appConfig.workMarketMaxArticleAgeHours,
      DEFAULT_WORK_MARKET_MAX_AGE_HOURS,
      1,
      maxAgeHours,
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
    workMarketArticlesPerDigest: settings.workMarketArticlesPerDigest,
    workMarketMaxAgeHours: settings.workMarketMaxAgeHours,
    excludedUrls,
    priorArticles,
  });

  const primary = select(settings.maxAgeHours);
  if (primary.selected.length >= settings.hardMinArticles
      || settings.fallbackMaxAgeHours <= settings.maxAgeHours) {
    return {
      candidates: primary.selected,
      rejectedDuplicates: primary.rejectedDuplicates,
      laneStats: primary.laneStats,
      fallbackUsed: false,
      effectiveMaxAgeHours: settings.maxAgeHours,
    };
  }

  const fallback = select(settings.fallbackMaxAgeHours);
  return {
    candidates: fallback.selected,
    rejectedDuplicates: fallback.rejectedDuplicates,
    laneStats: fallback.laneStats,
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

export function isBlockedPublisher(source, publisherUrl) {
  const blockedDomains = Array.isArray(source?.blockedPublisherDomains)
    ? source.blockedPublisherDomains
    : [];
  if (!blockedDomains.length || !publisherUrl) return false;
  try {
    const hostname = new URL(publisherUrl).hostname.toLowerCase().replace(/^www\./, '');
    return blockedDomains.some((domain) => {
      const normalized = String(domain || '').toLowerCase().replace(/^www\./, '');
      return hostname === normalized || hostname.endsWith(`.${normalized}`);
    });
  } catch {
    return false;
  }
}

function containsTerm(text, term) {
  const normalizedTerm = String(term || '').trim().toLowerCase();
  if (!normalizedTerm) return false;
  if (normalizedTerm.length > 3) return text.includes(normalizedTerm);

  const escaped = normalizedTerm
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(text);
}

function matchesRequiredSourceTerms(item, source) {
  const requiredTerms = Array.isArray(source?.requiredAnyTerms) ? source.requiredAnyTerms : [];
  if (requiredTerms.length === 0) return true;
  const text = `${item.title || ''} ${item.summary || ''}`.toLowerCase();
  return requiredTerms.some((term) => containsTerm(text, term));
}

export function parseFeed(xml, source) {
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
    const publisher = stripHtml(readTag(block, 'source'));
    const publisherUrl = normalizeUrl(readAttr(block, 'source', 'url'));
    return { title, url, summary, publishedAt, source: sourceName, category, publisher, publisherUrl };
  }).filter((item) => item.title
    && item.url
    && item.summary.length >= 80
    && !isBlockedPublisher(source, item.publisherUrl)
    && matchesRequiredSourceTerms(item, source));
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
  const baseTechScore = techTerms.reduce((sum, term) => sum + (containsTerm(text, term) ? 3 : 0), 0);
  const gadgetScore = category === 'gadgets'
    ? gadgetTerms.reduce((sum, term) => sum + (containsTerm(text, term) ? 3 : 0), 0)
    : 0;
  const marketplaceScore = WORK_MARKET_CATEGORIES.has(category)
    ? marketplaceTerms.reduce((sum, term) => sum + (containsTerm(text, term) ? 3 : 0), 0)
    : 0;
  const techScore = baseTechScore + gadgetScore + marketplaceScore;
  const nonTechScore = nonTechTerms.reduce((sum, term) => sum + (containsTerm(text, term) ? 4 : 0), 0);
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
  if (WORK_MARKET_CATEGORIES.has(meta.category) && meta.marketplaceScore < 3) return false;
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
  const duplicate = title.score >= 0.58
    || (title.shared >= 4 && title.score >= 0.34)
    || (title.shared >= 3 && combined.score >= 0.32)
    || (title.shared >= 2 && title.score >= 0.4 && combined.score >= 0.38);
  return {
    duplicate,
    score: Math.max(title.score, combined.score),
    titleScore: title.score,
    combinedScore: combined.score,
    sharedTitleTokens: title.shared,
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
  const sourceCounts = settings.initialSourceCounts instanceof Map
    ? new Map(settings.initialSourceCounts)
    : new Map(Object.entries(settings.initialSourceCounts || {}));

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
  const maxAgeHours = settings.maxAgeHours || DEFAULT_MAX_AGE_HOURS;
  const gadgetTarget = clampInteger(
    settings.gadgetArticlesPerDigest,
    DEFAULT_GADGET_ARTICLES,
    0,
    limit,
  );
  const workMarketTarget = clampInteger(
    settings.workMarketArticlesPerDigest,
    DEFAULT_WORK_MARKET_ARTICLES,
    0,
    limit,
  );
  const workMarketMaxAgeHours = Math.min(
    maxAgeHours,
    clampInteger(
      settings.workMarketMaxAgeHours,
      DEFAULT_WORK_MARKET_MAX_AGE_HOURS,
      1,
      maxAgeHours,
    ),
  );
  const platformMinimumTarget = clampInteger(
    settings.marketplaceArticlesPerDigest,
    DEFAULT_MARKETPLACE_ARTICLES,
    0,
    workMarketTarget || limit,
  );
  const laneTargets = [
    {
      category: 'gadgets',
      target: gadgetTarget,
      maxAgeHours,
    },
    ...(workMarketTarget > 0 ? ['upwork', 'fiverr', 'linkedin'].map((category) => ({
      category,
      target: platformMinimumTarget,
      maxAgeHours: workMarketMaxAgeHours,
    })) : []),
  ].filter((lane) => lane.target > 0);

  if (laneTargets.length === 0 && workMarketTarget === 0) {
    return { ...selectDiverseCandidatesDetailed(items, settings), laneStats: [] };
  }

  const selected = [];
  const rejectedDuplicates = [];
  const activeLaneCategories = new Set(laneTargets.map((lane) => lane.category));
  if (workMarketTarget > 0) {
    for (const category of WORK_MARKET_CATEGORIES) activeLaneCategories.add(category);
  }
  const laneStats = [];
  let remaining = limit;
  let priorArticles = [...(settings.priorArticles || [])];
  const sourceCounts = new Map();
  const baseExcludedUrls = settings.excludedUrls instanceof Set
    ? settings.excludedUrls
    : new Set(settings.excludedUrls || []);

  const selectLane = (laneItems, target, laneMaxAgeHours) => {
    const laneLimit = Math.min(target, remaining);
    const freshCount = laneItems
      .map((item) => ({ ...item, meta: item.meta || scoreItem(item, laneMaxAgeHours) }))
      .filter((item) => isFreshTechItem(item.meta, laneMaxAgeHours))
      .length;
    if (laneLimit <= 0) return { selected: [], rejectedDuplicates: [], freshCount };

    const laneResult = selectDiverseCandidatesDetailed(laneItems, {
      ...settings,
      maxAgeHours: laneMaxAgeHours,
      limit: laneLimit,
      priorArticles,
      initialSourceCounts: sourceCounts,
      excludedUrls: new Set([
        ...baseExcludedUrls,
        ...selected.map((item) => item.url),
      ]),
    });
    selected.push(...laneResult.selected);
    rejectedDuplicates.push(...laneResult.rejectedDuplicates);
    for (const item of laneResult.selected) {
      sourceCounts.set(item.source, (sourceCounts.get(item.source) || 0) + 1);
    }
    remaining -= laneResult.selected.length;
    priorArticles = [...priorArticles, ...laneResult.selected];
    return { ...laneResult, freshCount };
  };

  for (const lane of laneTargets) {
    if (remaining <= 0) break;
    const alreadySelectedForMarket = selected.filter((item) => WORK_MARKET_CATEGORIES.has(
      item.category || item.feedCategory || 'ai-tech',
    )).length;
    const target = WORK_MARKET_CATEGORIES.has(lane.category)
      ? Math.min(lane.target, Math.max(0, workMarketTarget - alreadySelectedForMarket))
      : lane.target;
    const laneItems = items.filter((item) => (item.category || item.feedCategory || 'ai-tech') === lane.category);
    const laneResult = selectLane(laneItems, target, lane.maxAgeHours);
    laneStats.push({
      category: lane.category,
      target: lane.target,
      fetched: laneItems.length,
      fresh: laneResult.freshCount,
      selected: laneResult.selected.length,
      duplicates: laneResult.rejectedDuplicates.length,
    });
  }

  if (workMarketTarget > 0) {
    const workMarketItems = items.filter((item) => WORK_MARKET_CATEGORIES.has(
      item.category || item.feedCategory || 'ai-tech',
    ));
    const selectedBeforeFill = selected.filter((item) => WORK_MARKET_CATEGORIES.has(
      item.category || item.feedCategory || 'ai-tech',
    )).length;
    const fillResult = selectLane(
      workMarketItems,
      Math.max(0, workMarketTarget - selectedBeforeFill),
      workMarketMaxAgeHours,
    );
    laneStats.push({
      category: 'work-market',
      categories: [...WORK_MARKET_CATEGORIES],
      target: workMarketTarget,
      fetched: workMarketItems.length,
      fresh: fillResult.freshCount,
      selected: selectedBeforeFill + fillResult.selected.length,
      duplicates: fillResult.rejectedDuplicates.length,
    });
  }

  const coreItems = items.filter((item) => !activeLaneCategories.has(item.category || item.feedCategory || 'ai-tech'));
  const coreResult = remaining > 0
    ? selectDiverseCandidatesDetailed(coreItems, {
      ...settings,
      limit: remaining,
      priorArticles,
      initialSourceCounts: sourceCounts,
      excludedUrls: new Set([
        ...baseExcludedUrls,
        ...selected.map((item) => item.url),
      ]),
    })
    : { selected: [], rejectedDuplicates: [] };

  return {
    selected: [...selected, ...coreResult.selected],
    rejectedDuplicates: [...rejectedDuplicates, ...coreResult.rejectedDuplicates],
    laneStats,
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
    if (source.format === 'linkedin-pressroom') return parseLinkedInPressroom(body, source);
    return parseFeed(body, source);
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

function semanticLaneStats(laneStats, selected, rejected) {
  return laneStats.map((lane) => {
    const categories = Array.isArray(lane.categories) ? lane.categories : [lane.category];
    const belongsToLane = (item) => categories.includes(item.category || item.feedCategory);
    return {
      ...lane,
      selected: selected.filter(belongsToLane).length,
      duplicates: (lane.duplicates || 0) + rejected.filter(belongsToLane).length,
    };
  });
}

function addUsage(left = {}, right = {}) {
  return {
    inputTokens: (left.inputTokens || 0) + (right.inputTokens || 0),
    outputTokens: (left.outputTokens || 0) + (right.outputTokens || 0),
  };
}

async function selectCandidatesWithSemanticFallback(
  items,
  settings,
  excludedUrls,
  priorArticles,
) {
  const selectAtAge = async (maxAgeHours) => {
    const batch = selectDigestCandidatesDetailed(items, {
      maxAgeHours,
      maxPerSource: settings.maxPerSource,
      limit: FETCH_CANDIDATES,
      gadgetArticlesPerDigest: settings.gadgetArticlesPerDigest,
      marketplaceArticlesPerDigest: settings.marketplaceArticlesPerDigest,
      workMarketArticlesPerDigest: settings.workMarketArticlesPerDigest,
      workMarketMaxAgeHours: settings.workMarketMaxAgeHours,
      excludedUrls,
      // Cross-day history needs an update-aware verdict. Obvious same-batch
      // duplicates are removed here; ambiguous pairs receive the same semantic
      // verdict in the next step.
      priorArticles: [],
    });
    const semantic = await resolveHistoricalDuplicates({
      candidates: batch.selected,
      priorArticles,
      similarityFn: eventSimilarity,
      appConfig: config,
      maxPairs: clampInteger(config.semanticDedupMaxPairs, 40, 0, 100),
    });
    return {
      selected: semantic.selected,
      rejectedDuplicates: [...batch.rejectedDuplicates, ...semantic.rejected],
      laneStats: semanticLaneStats(batch.laneStats, semantic.selected, semantic.rejected),
      semanticDecisionStats: semantic.stats,
      semanticUsage: semantic.usage,
    };
  };

  const primary = await selectAtAge(settings.maxAgeHours);
  if (primary.selected.length >= settings.hardMinArticles
      || settings.fallbackMaxAgeHours <= settings.maxAgeHours) {
    return {
      candidates: primary.selected,
      rejectedDuplicates: primary.rejectedDuplicates,
      laneStats: primary.laneStats,
      semanticDecisionStats: primary.semanticDecisionStats,
      semanticUsage: primary.semanticUsage,
      fallbackUsed: false,
      effectiveMaxAgeHours: settings.maxAgeHours,
    };
  }

  const fallback = await selectAtAge(settings.fallbackMaxAgeHours);
  return {
    candidates: fallback.selected,
    rejectedDuplicates: fallback.rejectedDuplicates,
    laneStats: fallback.laneStats,
    semanticDecisionStats: fallback.semanticDecisionStats,
    semanticUsage: addUsage(primary.semanticUsage, fallback.semanticUsage),
    fallbackUsed: true,
    effectiveMaxAgeHours: settings.fallbackMaxAgeHours,
  };
}

async function collectCandidates(settings, excludedUrls = new Set(), priorArticles = []) {
  const feedResults = await Promise.all(sources.map(async (source) => {
    try {
      return { source, items: await fetchFeed(source, settings.fetchRetries), error: null };
    } catch (error) {
      return { source, items: [], error: error.message };
    }
  }));

  const sourceErrors = feedResults
    .filter((result) => result.error)
    .map((result) => `${result.source.name}: ${result.error}`);
  const sourceDiagnostics = feedResults.map(({ source, items, error }) => {
    const scoredItems = items.map((item) => ({ ...item, meta: scoreItem(item, settings.maxAgeHours) }));
    const fallbackScoredItems = items.map((item) => ({ ...item, meta: scoreItem(item, settings.fallbackMaxAgeHours) }));
    const datedItems = items
      .filter((item) => !Number.isNaN(Date.parse(item.publishedAt)))
      .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt));
    return {
      name: source.name,
      category: source.category || 'ai-tech',
      fetched: items.length,
      fresh: scoredItems.filter((item) => isFreshTechItem(item.meta, settings.maxAgeHours)).length,
      freshAtFallback: fallbackScoredItems.filter((item) => isFreshTechItem(item.meta, settings.fallbackMaxAgeHours)).length,
      latestPublishedAt: datedItems[0]?.publishedAt || null,
      error,
    };
  });

  const {
    candidates,
    rejectedDuplicates,
    laneStats,
    semanticDecisionStats,
    semanticUsage,
    fallbackUsed,
    effectiveMaxAgeHours,
  } = await selectCandidatesWithSemanticFallback(
    feedResults.flatMap((result) => result.items),
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
      {
        candidateCount: candidates.length,
        sourceErrors,
        sourceDiagnostics,
        laneStats,
        semanticDecisionStats,
        publicationMode,
        fallbackUsed,
        effectiveMaxAgeHours,
        recoveryMode: settings.recoveryMode,
      },
    );
  }

  return {
    candidates,
    rejectedDuplicates,
    sourceErrors,
    sourceDiagnostics,
    laneStats,
    semanticDecisionStats,
    semanticUsage,
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
  const historyDays = clampInteger(
    config.semanticDedupHistoryDays,
    DEFAULT_EVENT_HISTORY_DAYS,
    1,
    90,
  );
  const cutoff = Date.now() - historyDays * 86400000;
  const isRecentUsedRss = (article) => article.source === 'railway-rss'
    && article.digest_id
    && article.status === 'used'
    && Date.parse(`${article.created_at}Z`) >= cutoff;

  // Failed, unattached RSS entries remain retryable. All other URLs are
  // excluded before diversity caps. Recent published URLs instead go through
  // the update-aware semantic verdict, so a materially updated source page is
  // not blocked merely because its canonical URL stayed the same.
  const excludedUrls = new Set(existing
    .filter((article) => !canReuseArticle(article) && !isRecentUsedRss(article))
    .map((article) => article.url));

  const priorArticles = existing
    .filter(isRecentUsedRss)
    .map((article) => ({
      ...article,
      summary: article.content || '',
      eventFingerprint: article.event_fingerprint,
    }));

  return { excludedUrls, priorArticles };
}

function storageUrlForCandidate(db, item) {
  const existing = db.prepare('SELECT id FROM articles WHERE url = ?').get(item.url);
  if (!existing || item.semanticVerdict !== 'update') return item.url;
  try {
    const url = new URL(item.url);
    const fingerprint = item.eventFingerprint || buildEventFingerprint(item);
    url.hash = `gdn-update-${new Date().toISOString().slice(0, 10)}-${fingerprint.slice(0, 8)}`;
    return url.toString();
  } catch {
    return item.url;
  }
}

/**
 * Collect, generate, and publish one daily RSS digest. The automation route
 * owns the run lock; this function remains usable for a controlled manual job.
 */
export async function runDailyRssDigest({ onDigestReady, onProgress, recoveryMode = false } = {}) {
  const settings = resolveRssSettings(config, { recoveryMode });
  const db = getDb();
  const { excludedUrls, priorArticles } = getDedupHistory(db);
  const {
    candidates,
    rejectedDuplicates,
    sourceErrors,
    sourceDiagnostics,
    laneStats,
    semanticDecisionStats,
    semanticUsage,
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
      sourceDiagnostics,
      laneStats,
      semanticDecisionStats,
      publicationMode: collectedMode,
      fallbackUsed,
      effectiveMaxAgeHours,
      recoveryMode: settings.recoveryMode,
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
      url: storageUrlForCandidate(db, item),
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
        sourceDiagnostics,
        laneStats,
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
      sourceDiagnostics,
      laneStats,
      semanticDecisionStats,
      publicationMode: articleMode,
    });
  }

  let digestId;
  try {
    digestId = await generateDigest(db, articles, config, semanticUsage);
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
    semanticDecisionStats,
    duplicateReasons,
    recordedDuplicates,
    reused,
    modelRetriesQueued: failedArticleIds.length,
    publicationMode: digestMode,
    degraded: digestMode === 'degraded',
    preferredMinimum: settings.minArticles,
    fallbackUsed,
    effectiveMaxAgeHours,
    recoveryMode: settings.recoveryMode,
    hardMinimum: settings.hardMinArticles,
    sourceDiagnostics,
    laneStats,
    digestId,
    published: { telegram: published.telegram || null },
    sourceErrors,
  };
}
