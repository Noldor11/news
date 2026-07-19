import { pathToFileURL } from 'node:url';
const BASE_URL = String(process.env.BASE_URL || '').replace(new RegExp('/+$'), '');
const DAILY_SECRET = process.env.N8N_DAILY_TRIGGER_SECRET || '';
const API_KEY = process.env.API_SECRET_KEY || '';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ALERT_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID || '';
const REQUEST_TIMEOUT_MS = 180000;

function kyivParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function currentAction(date = new Date()) {
  const parts = kyivParts(date);
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  if (minutes >= 18 * 60 + 30 && minutes <= 18 * 60 + 45) return 'recover';
  if (minutes >= 18 * 60 + 50 && minutes <= 19 * 60 + 10) return 'verify';
  return 'skip';
}

function dateKey(date = new Date()) {
  const parts = kyivParts(date);
  return parts.year + '-' + parts.month + '-' + parts.day;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

async function sendAlert(message) {
  if (!BOT_TOKEN || !ALERT_CHAT_ID) throw new Error('Telegram alert configuration is missing');
  const response = await fetchWithTimeout('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: ALERT_CHAT_ID,
      text: message,
      disable_web_page_preview: true,
    }),
  });
  const data = await readJson(response);
  if (!response.ok || !data?.ok) {
    throw new Error(data?.description || 'Telegram HTTP ' + response.status);
  }
  return String(data.result.message_id);
}

async function recover() {
  const response = await fetchWithTimeout(BASE_URL + '/api/automation/daily-recovery', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + API_KEY,
      'X-N8N-Daily-Secret': DAILY_SECRET,
    },
  });
  const data = await readJson(response);
  if (!response.ok) {
    const detail = String(data?.error || data?.reason || 'HTTP ' + response.status).replace(/[<>]/g, '');
    await sendAlert('GDN external recovery failed for ' + dateKey() + '. ' + detail);
    throw new Error(detail);
  }
  console.log(JSON.stringify({
    action: 'recover',
    ok: true,
    skipped: Boolean(data?.skipped),
    digestId: data?.digestId || null,
    degraded: Boolean(data?.degraded),
  }));
}

async function verify() {
  let response;
  let health;
  try {
    response = await fetchWithTimeout(BASE_URL + '/health');
    health = await readJson(response);
    if (!response.ok) throw new Error('Health HTTP ' + response.status);
  } catch (error) {
    await sendAlert('GDN external monitor: application unavailable. ' + String(error.message).replace(/[<>]/g, ''));
    throw error;
  }

  const expected = process.env.MONITOR_EXPECT_RUN_KEY || 'daily-rss:' + dateKey();
  const confirmed = health?.latestRun?.runKey === expected
    && health?.latestRun?.status === 'published';

  if (!confirmed) {
    const actual = health?.latestRun
      ? health.latestRun.runKey + ' / ' + health.latestRun.status
      : 'missing';
    await sendAlert('GDN external monitor: no confirmed digest for ' + dateKey() + '. State: ' + actual);
    throw new Error('Digest is not confirmed: ' + actual);
  }

  console.log(JSON.stringify({
    action: 'verify',
    ok: true,
    runKey: health.latestRun.runKey,
    degraded: Boolean(health.latestRun.degraded),
  }));
}

async function main() {
  if (!BASE_URL || !DAILY_SECRET || !API_KEY) throw new Error('BASE_URL or N8N_DAILY_TRIGGER_SECRET is missing');
  const forcedAction = process.env.MONITOR_FORCE_ACTION;
  const action = ['recover', 'verify'].includes(forcedAction) ? forcedAction : currentAction();
  if (action === 'recover') return recover();
  if (action === 'verify') return verify();
  console.log(JSON.stringify({ action: 'skip', reason: 'outside Europe/Kyiv windows' }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
