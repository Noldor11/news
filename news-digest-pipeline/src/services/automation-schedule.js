const KYIV_TIME_ZONE = 'Europe/Kyiv';
const DAILY_WINDOW_START_MINUTES = 17 * 60 + 50;
const DAILY_WINDOW_END_MINUTES = 18 * 60 + 30;
const RECOVERY_WINDOW_START_MINUTES = 18 * 60 + 25;
const RECOVERY_WINDOW_END_MINUTES = 19 * 60 + 15;
const WATCHDOG_WINDOW_START_MINUTES = 18 * 60 + 45;
const WATCHDOG_WINDOW_END_MINUTES = 19 * 60 + 30;

function kyivParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: KYIV_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function inMinuteWindow(date, start, end) {
  const parts = kyivParts(date);
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return minutes >= start && minutes <= end;
}

export function kyivDateKey(date = new Date()) {
  const parts = kyivParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function isKyivDailyWindow(date = new Date()) {
  return inMinuteWindow(date, DAILY_WINDOW_START_MINUTES, DAILY_WINDOW_END_MINUTES);
}

export function isKyivRecoveryWindow(date = new Date()) {
  return inMinuteWindow(date, RECOVERY_WINDOW_START_MINUTES, RECOVERY_WINDOW_END_MINUTES);
}

export function isKyivWatchdogWindow(date = new Date()) {
  return inMinuteWindow(date, WATCHDOG_WINDOW_START_MINUTES, WATCHDOG_WINDOW_END_MINUTES);
}

export function parseSqliteUtc(value) {
  if (!value) return null;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
    ? value
    : `${String(value).replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function runStartedInRecoveryWindow(run) {
  const startedAt = parseSqliteUtc(run?.started_at);
  return startedAt ? isKyivRecoveryWindow(startedAt) : false;
}

export function runStartedInDailyWindow(run) {
  const startedAt = parseSqliteUtc(run?.started_at);
  return startedAt ? isKyivDailyWindow(startedAt) : false;
}
