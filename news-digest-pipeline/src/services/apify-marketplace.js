import {
  getMarketplaceSnapshot,
  saveMarketplaceSnapshot,
} from '../db/index.js';

const APIFY_API_BASE = 'https://api.apify.com/v2';
const UPWORK_ACTOR = 'valig~upwork-jobs-scraper';
const FIVERR_ACTOR = 'memo23~fiverr-scraper';
const KYIV_TIME_ZONE = 'Europe/Kiev';
const ACTOR_TIMEOUT_SECONDS = 120;
const REQUEST_TIMEOUT_MS = 135000;
const MAX_CHARGE_USD = 0.05;
const AUTOMATION_TERMS = [
  'n8n', 'make.com', 'zapier', 'automation', 'workflow', 'ai agent',
  'openai', 'api integration', 'chatbot', 'crm automation',
];

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function kyivDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: KYIV_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  return Object.fromEntries(parts
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
}

export function kyivDateKey(date = new Date()) {
  const { year, month, day } = kyivDateParts(date);
  return `${year}-${month}-${day}`;
}

export function kyivWeekday(date = new Date()) {
  const label = new Intl.DateTimeFormat('en-US', {
    timeZone: KYIV_TIME_ZONE,
    weekday: 'short',
  }).format(date);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(label);
}

export function kyivWeekKey(date = new Date()) {
  const { year, month, day } = kyivDateParts(date);
  const local = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const daysSinceMonday = (local.getUTCDay() + 6) % 7;
  local.setUTCDate(local.getUTCDate() - daysSinceMonday);
  return local.toISOString().slice(0, 10);
}

function humanKyivDate(date = new Date()) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: KYIV_TIME_ZONE,
    day: 'numeric',
    month: 'long',
  }).format(date);
}

function median(values) {
  const sorted = values
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function money(value) {
  if (!Number.isFinite(value)) return null;
  return `$${Math.round(value * 100) / 100}`;
}

function topCounts(values, limit = 6) {
  const counts = new Map();
  const display = new Map();
  for (const raw of values) {
    const value = String(raw || '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
    if (!display.has(key)) display.set(key, value);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([key, count]) => `${display.get(key)} (${count})`);
}

function compactTitles(rows, limit = 3) {
  return rows
    .map((row) => String(row.title || '').trim())
    .filter(Boolean)
    .slice(0, limit)
    .map((title) => `«${title.slice(0, 120)}»`)
    .join('; ');
}

function dedupeRows(rows, keys) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = keys.map((name) => row?.[name]).find(Boolean);
    if (!key || seen.has(String(key))) return false;
    seen.add(String(key));
    return true;
  });
}

function isAutomationRow(row) {
  const text = [
    row?.title,
    row?.description,
    ...(row?.skills || []).map((skill) => skill?.prefLabel),
  ].join(' ').toLowerCase();
  return AUTOMATION_TERMS.some((term) => text.includes(term));
}

function titleUrlOverlap(row) {
  try {
    const titleTokens = new Set(String(row.title || '').toLowerCase().match(/[a-z0-9]+/g) || []);
    const urlTokens = new Set(new URL(row.gigUrl).pathname.toLowerCase().match(/[a-z0-9]+/g) || []);
    let shared = 0;
    for (const token of titleTokens) {
      if (token.length > 2 && urlTokens.has(token)) shared += 1;
    }
    return shared;
  } catch {
    return 0;
  }
}

export function buildUpworkSnapshot(rawRows, now = new Date()) {
  const cutoff = now.getTime() - 7 * 86400000;
  const rows = dedupeRows(rawRows || [], ['id', 'url'])
    .filter((row) => row?.title && row?.url)
    .filter(isAutomationRow)
    .filter((row) => {
      const timestamp = Date.parse(row.publishTime || row.createTime || '');
      return Number.isNaN(timestamp) || timestamp >= cutoff;
    })
    .sort((left, right) => Date.parse(right.publishTime || 0) - Date.parse(left.publishTime || 0));
  if (!rows.length) return null;

  const skillCounts = topCounts(rows.flatMap((row) => (row.skills || []).map((skill) => skill.prefLabel)));
  const fixedBudgets = rows
    .map((row) => Number(row.fixedPriceAmount?.amount))
    .filter((value) => Number.isFinite(value) && value > 0);
  const hourlyMins = rows.map((row) => Number(row.hourlyBudgetMin)).filter((value) => value > 0);
  const hourlyMaxes = rows.map((row) => Number(row.hourlyBudgetMax)).filter((value) => value > 0);
  const applicants = rows.map((row) => Number(row.totalApplicants)).filter(Number.isFinite);
  const budgetParts = [];
  if (fixedBudgets.length) budgetParts.push(`медианный fixed budget ${money(median(fixedBudgets))}`);
  if (hourlyMins.length || hourlyMaxes.length) {
    const low = money(median(hourlyMins));
    const high = money(median(hourlyMaxes));
    budgetParts.push(`типичный hourly диапазон ${low || '?'}-${high || '?'}`);
  }

  const summary = [
    `Публичный ежедневный срез ${rows.length} свежих вакансий Upwork по n8n, Make, Zapier, AI-автоматизации и AI-агентам.`,
    skillCounts.length ? `Чаще всего нужны навыки: ${skillCounts.join(', ')}.` : '',
    budgetParts.length ? `По вакансиям с указанной оплатой: ${budgetParts.join('; ')}.` : '',
    applicants.length ? `Медиана уже поданных заявок: ${Math.round(median(applicants))}.` : '',
    `Примеры свежих запросов: ${compactTitles(rows)}.`,
  ].filter(Boolean).join(' ');

  return {
    item: {
      title: `Upwork market pulse за ${humanKyivDate(now)}: ${rows.length} свежих вакансий по AI-автоматизации`,
      url: rows[0].url,
      summary,
      publishedAt: now.toISOString(),
      source: 'Apify Upwork Public Jobs',
      category: 'upwork',
    },
    itemCount: rows.length,
  };
}

export function buildFiverrSnapshot(rawRows, now = new Date()) {
  const rows = dedupeRows(rawRows || [], ['gigId', 'gigUrl'])
    .filter((row) => row?.rowType === 'gig' && row?.title && row?.gigUrl)
    .filter(isAutomationRow);
  if (!rows.length) return null;

  const prices = rows.map((row) => Number(row.priceFrom)).filter((value) => value > 0);
  const sellerLevels = topCounts(rows.map((row) => row.sellerLevel), 4);
  const reviewed = rows.filter((row) => Number(row.reviewsCount) > 0);
  const proofRow = [...rows].sort((left, right) => titleUrlOverlap(right) - titleUrlOverlap(left))[0];
  const summary = [
    `Еженедельный публичный срез предложения на Fiverr: ${rows.length} гигов по n8n, Make и AI-автоматизации.`,
    prices.length ? `Медианная стартовая цена ${money(median(prices))}.` : '',
    sellerLevels.length ? `Уровни продавцов в выдаче: ${sellerLevels.join(', ')}.` : '',
    reviewed.length ? `${reviewed.length} из ${rows.length} гигов уже имеют отзывы.` : '',
    `Это срез конкуренции и упаковки услуг, а не прямое измерение клиентского спроса. Примеры: ${compactTitles(rows)}.`,
  ].filter(Boolean).join(' ');

  return {
    item: {
      title: `Fiverr weekly supply snapshot за неделю ${kyivWeekKey(now)}: AI-автоматизация и n8n`,
      url: proofRow.gigUrl,
      summary,
      publishedAt: now.toISOString(),
      source: 'Apify Fiverr Public Gigs',
      category: 'fiverr',
    },
    itemCount: rows.length,
  };
}

export async function runApifyActor({
  actorId,
  input,
  token,
  memory,
  fetchImpl = fetch,
}) {
  const query = new URLSearchParams({
    timeout: String(ACTOR_TIMEOUT_SECONDS),
    memory: String(memory),
    maxTotalChargeUsd: String(MAX_CHARGE_USD),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(
      `${APIFY_API_BASE}/acts/${actorId}/run-sync-get-dataset-items?${query}`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      },
    );
    if (!response.ok) {
      const detail = (await response.text()).replace(/apify_api_[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 300);
      throw new Error(`Apify Actor HTTP ${response.status}: ${detail || 'no response body'}`);
    }
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('Apify Actor returned a non-array dataset');
    return rows;
  } finally {
    clearTimeout(timer);
  }
}

async function cachedActorSnapshot({
  snapshotKey,
  source,
  actorId,
  input,
  token,
  memory,
  buildSnapshot,
  now,
  fetchImpl,
}) {
  const cached = getMarketplaceSnapshot(snapshotKey);
  if (cached?.payload?.item) {
    return {
      item: cached.payload.item,
      itemCount: cached.item_count,
      cached: true,
    };
  }

  const rows = await runApifyActor({ actorId, input, token, memory, fetchImpl });
  const snapshot = buildSnapshot(rows, now);
  if (!snapshot?.item) throw new Error(`${source} returned no usable public rows`);
  saveMarketplaceSnapshot({
    snapshotKey,
    source,
    payload: snapshot,
    itemCount: snapshot.itemCount,
  });
  return { ...snapshot, cached: false };
}

function diagnostic(name, category, result = {}, error = null, skipped = null) {
  return {
    name,
    category,
    fetched: result.itemCount || 0,
    fresh: result.item ? 1 : 0,
    freshAtFallback: result.item ? 1 : 0,
    latestPublishedAt: result.item?.publishedAt || null,
    cached: Boolean(result.cached),
    skipped,
    error,
  };
}

export async function collectApifyMarketplace(appConfig, {
  now = new Date(),
  fetchImpl = fetch,
} = {}) {
  const items = [];
  const diagnostics = [];
  const errors = [];
  const token = appConfig.apifyApiToken;

  const jobs = [];
  if (appConfig.apifyUpworkEnabled) {
    if (!token) {
      const error = 'APIFY_API_TOKEN is not configured';
      errors.push(`Apify Upwork Public Jobs: ${error}`);
      diagnostics.push(diagnostic('Apify Upwork Public Jobs', 'upwork', {}, error));
    } else {
      const limit = clampInteger(appConfig.apifyUpworkMaxItems, 30, 1, 30);
      jobs.push((async () => {
        try {
          const result = await cachedActorSnapshot({
            snapshotKey: `upwork:${kyivDateKey(now)}`,
            source: 'upwork',
            actorId: UPWORK_ACTOR,
            input: {
              keywords: appConfig.apifyUpworkKeywords,
              sort: 'recency',
              limit,
            },
            token,
            memory: 128,
            buildSnapshot: buildUpworkSnapshot,
            now,
            fetchImpl,
          });
          items.push(result.item);
          diagnostics.push(diagnostic('Apify Upwork Public Jobs', 'upwork', result));
        } catch (cause) {
          const error = cause?.name === 'AbortError' ? 'request timed out' : cause.message;
          errors.push(`Apify Upwork Public Jobs: ${error}`);
          diagnostics.push(diagnostic('Apify Upwork Public Jobs', 'upwork', {}, error));
        }
      })());
    }
  }

  if (appConfig.apifyFiverrEnabled) {
    const configuredDay = clampInteger(appConfig.apifyFiverrWeekday, 1, 0, 6);
    if (kyivWeekday(now) !== configuredDay) {
      diagnostics.push(diagnostic(
        'Apify Fiverr Public Gigs',
        'fiverr',
        {},
        null,
        `weekly schedule: weekday ${configuredDay}`,
      ));
    } else if (!token) {
      const error = 'APIFY_API_TOKEN is not configured';
      errors.push(`Apify Fiverr Public Gigs: ${error}`);
      diagnostics.push(diagnostic('Apify Fiverr Public Gigs', 'fiverr', {}, error));
    } else {
      const limit = clampInteger(appConfig.apifyFiverrMaxItems, 30, 1, 30);
      const queries = (appConfig.apifyFiverrQueries || []).slice(0, 3);
      jobs.push((async () => {
        try {
          const result = await cachedActorSnapshot({
            snapshotKey: `fiverr:${kyivWeekKey(now)}`,
            source: 'fiverr',
            actorId: FIVERR_ACTOR,
            input: {
              searchQueries: queries,
              scrapeDetails: false,
              maxItems: limit,
              maxItemsPerSearch: Math.max(1, Math.ceil(limit / Math.max(1, queries.length))),
              maxConcurrency: 4,
              maxRequestRetries: 5,
            },
            token,
            memory: 512,
            buildSnapshot: buildFiverrSnapshot,
            now,
            fetchImpl,
          });
          items.push(result.item);
          diagnostics.push(diagnostic('Apify Fiverr Public Gigs', 'fiverr', result));
        } catch (cause) {
          const error = cause?.name === 'AbortError' ? 'request timed out' : cause.message;
          errors.push(`Apify Fiverr Public Gigs: ${error}`);
          diagnostics.push(diagnostic('Apify Fiverr Public Gigs', 'fiverr', {}, error));
        }
      })());
    }
  }

  await Promise.all(jobs);
  return { items, diagnostics, errors };
}
