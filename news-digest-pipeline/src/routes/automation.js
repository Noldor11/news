import { Router } from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import config from '../config.js';
import {
  claimAutomationRun,
  getAutomationRunByKey,
  getDigest,
  updateAutomationRun,
} from '../db/index.js';
import {
  isKyivDailyWindow,
  isKyivRecoveryWindow,
  isKyivWatchdogWindow,
  kyivDateKey,
  runStartedInDailyWindow,
  runStartedInRecoveryWindow,
} from '../services/automation-schedule.js';
import { runDailyRssDigest } from '../services/rss-digest-runner.js';
import { publishDigest } from '../services/publishers/index.js';
import { sendMessage } from '../services/telegram-bot.js';
import { redactSecrets, safeErrorMessage } from '../security/redact.js';

const router = Router();

function finishedAt() {
  return new Date().toISOString();
}

function safeSecretMatch(provided, expected) {
  if (!provided || !expected) return false;
  const providedHash = createHash('sha256').update(String(provided)).digest();
  const expectedHash = createHash('sha256').update(String(expected)).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

function requireDailyTriggerSecret(req, res, next) {
  const expected = config.n8nDailyTriggerSecret;
  if (!expected) {
    return res.status(503).json({ ok: false, error: 'Daily trigger authentication is not configured' });
  }

  if (!safeSecretMatch(req.get('x-n8n-daily-secret'), expected)) {
    return res.status(401).json({ ok: false, error: 'Invalid daily trigger authentication' });
  }

  return next();
}

function getRunKey(trigger) {
  const dateKey = kyivDateKey();
  return trigger === 'manual'
    ? `manual-rss:${dateKey}:${randomUUID()}`
    : `daily-rss:${dateKey}`;
}

function metricsJson(metrics = {}) {
  return JSON.stringify(metrics);
}

function parseMetrics(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

function isValidScheduledRun(run) {
  return runStartedInDailyWindow(run) || runStartedInRecoveryWindow(run);
}

function alertChatId() {
  return config.telegramAlertChatId || config.telegramChatId || config.telegramPublishChatId;
}

function configuredSecrets() {
  return [
    config.apiSecretKey,
    config.n8nDailyTriggerSecret,
    config.telegramBotToken,
    config.telegramWebhookSecret,
    config.anthropicApiKey,
    config.openaiApiKey,
  ].filter(Boolean);
}

async function sendAutomationAlert(message) {
  const chatId = alertChatId();
  if (!config.telegramBotToken || !chatId) {
    return { ok: false, error: 'Telegram alert target is not configured' };
  }
  return sendMessage(config.telegramBotToken, chatId, redactSecrets(message, configuredSecrets()));
}

function hasTelegramDeliveryRecord(digest) {
  if (digest.telegram_message_id) return true;
  try {
    const messageIds = JSON.parse(digest.telegram_message_ids || '[]');
    return Array.isArray(messageIds) && messageIds.length > 0;
  } catch {
    return Boolean(digest.telegram_message_ids);
  }
}

function setTelegramRunResult(runId, digestId, telegram, result = {}) {
  const messageIds = JSON.stringify(telegram?.messageIds || []);
  const metrics = {
    collected: result.collected ?? null,
    selected: result.selected ?? null,
    duplicates: result.duplicates ?? null,
    exactDuplicates: result.exactDuplicates ?? null,
    semanticDuplicates: result.semanticDuplicates ?? null,
    duplicateReasons: result.duplicateReasons || {},
    recordedDuplicates: result.recordedDuplicates ?? null,
    reused: result.reused ?? null,
    sourceErrorCount: result.sourceErrors?.length || 0,
    publicationMode: result.publicationMode || null,
    fallbackUsed: Boolean(result.fallbackUsed),
    effectiveMaxAgeHours: result.effectiveMaxAgeHours ?? null,
    telegramMessageCount: telegram?.messageIds?.length || 0,
  };

  if (telegram?.ok) {
    updateAutomationRun(runId, {
      status: 'published',
      stage: 'confirmed',
      degraded: result.degraded ? 1 : 0,
      metrics_json: metricsJson(metrics),
      digest_id: digestId,
      telegram_message_ids: messageIds,
      error: null,
      completed_at: finishedAt(),
    });
    return { status: 'published', httpStatus: result.degraded ? 200 : 201 };
  }

  const status = telegram?.retrySafe ? 'failed' : 'partial';
  updateAutomationRun(runId, {
    status,
    stage: status === 'partial' ? 'delivery_unknown' : 'send_failed',
    degraded: result.degraded ? 1 : 0,
    metrics_json: metricsJson(metrics),
    digest_id: digestId,
    telegram_message_ids: messageIds,
    error: telegram?.error || 'Telegram did not confirm full delivery',
    completed_at: status === 'partial' ? finishedAt() : null,
  });
  return { status, httpStatus: status === 'failed' ? 502 : 409 };
}

async function resumeSafeTelegramPublish(run) {
  const digest = getDigest(run.digest_id);
  if (!digest?.content) {
    throw new Error('The retry run points to a missing or empty digest. Manual review is required.');
  }

  if (digest.status === 'publish_partial' || hasTelegramDeliveryRecord(digest)) {
    return {
      telegram: {
        ok: false,
        retrySafe: false,
        messageIds: [],
        error: 'Digest already has a Telegram delivery record; refusing to duplicate it.',
      },
    };
  }

  const previousMetrics = parseMetrics(run.metrics_json);
  updateAutomationRun(run.id, { status: 'publishing', stage: 'sending', digest_id: digest.id, error: null });
  return {
    digestId: digest.id,
    published: await publishDigest(digest, config, ['telegram']),
    resumed: true,
  };
}

// Scheduled runs share the day's idempotency key. Manual runs receive a unique
// key, so testing cannot consume the 18:00 publication slot.
async function executeDigest(req, res, trigger) {
  const runKey = getRunKey(trigger);
  const claim = claimAutomationRun(runKey, trigger);

  if (!claim.claimed) {
    const status = claim.run.status;
    const scheduledTrigger = ['schedule', 'recovery'].includes(trigger);
    const validScheduledRetry = !scheduledTrigger || isValidScheduledRun(claim.run);
    const safelyPublished = status === 'published' && validScheduledRetry;
    const reason = status === 'published' && !validScheduledRetry
      ? 'published_before_schedule'
      : status;

    return res.status(safelyPublished ? 200 : 409).json({
      ok: safelyPublished,
      skipped: true,
      reason,
      runKey,
      trigger,
      digestId: claim.run.digest_id || null,
    });
  }

  let phase = 'collecting';
  updateAutomationRun(claim.run.id, { status: 'running', stage: 'collecting' });

  try {
    const result = claim.run.digest_id
      ? await resumeSafeTelegramPublish(claim.run)
      : await runDailyRssDigest({
        onProgress: async (stage, metrics) => {
          updateAutomationRun(claim.run.id, {
            stage,
            degraded: metrics.publicationMode === 'degraded' ? 1 : 0,
            metrics_json: metricsJson(metrics),
          });
        },
        onDigestReady: async (digestId) => {
          phase = 'publishing';
          updateAutomationRun(claim.run.id, {
            status: 'publishing',
            stage: 'sending',
            digest_id: digestId,
            error: null,
          });
        },
      });

    const digestId = result.digestId || claim.run.digest_id;
    const telegram = result.published?.telegram;
    const outcome = setTelegramRunResult(claim.run.id, digestId, telegram, result);

    if (!telegram?.ok) {
      return res.status(outcome.httpStatus).json({
        ok: false,
        runKey,
        trigger,
        digestId,
        state: outcome.status,
        telegram,
        sourceErrors: result.sourceErrors || [],
      });
    }

    if (result.degraded) {
      const notice = 'GDN: опубликован сокращённый дайджест за ' + kyivDateKey()
        + '. Материалов: ' + result.selected + ', обычная цель: ' + result.preferredMinimum + '.';
      const alertResult = await sendAutomationAlert(notice);
      if (!alertResult?.ok) console.error('[automation] degraded digest alert failed:', alertResult?.error);
    }

    return res.status(outcome.httpStatus).json({
      ok: true,
      runKey,
      trigger,
      digestId,
      collected: result.collected,
      selected: result.selected,
      duplicates: result.duplicates,
      degraded: Boolean(result.degraded),
      publicationMode: result.publicationMode || 'full',
      resumed: Boolean(result.resumed),
      telegram,
      sourceErrors: result.sourceErrors || [],
    });
  } catch (error) {
    const status = phase === 'publishing' ? 'partial' : 'failed';
    const retryable = error.retryable !== false;
    const safeError = safeErrorMessage(error, 'Digest automation failed', configuredSecrets());
    updateAutomationRun(claim.run.id, {
      status,
      stage: status === 'partial' ? 'delivery_unknown' : 'failed',
      metrics_json: metricsJson(error.metrics || {}),
      error: safeError,
      completed_at: status === 'partial' ? finishedAt() : null,
    });
    console.error('[automation] digest run error:', safeError);
    return res.status(status === 'partial' ? 409 : retryable ? 500 : 422).json({
      ok: false,
      retryable,
      runKey,
      trigger,
      state: status,
      metrics: error.metrics || {},
      error: safeError,
    });
  }
}

function executeScheduledDigest(req, res) {
  if (!isKyivDailyWindow()) {
    return res.status(409).json({
      ok: false,
      reason: 'outside_schedule_window',
      expected: '17:50-18:30 Europe/Kyiv',
    });
  }

  return executeDigest(req, res, 'schedule');
}

function executeRecoveryDigest(req, res) {
  if (!isKyivRecoveryWindow()) {
    return res.status(409).json({
      ok: false,
      reason: 'outside_recovery_window',
      expected: '18:25-19:15 Europe/Kyiv',
    });
  }

  return executeDigest(req, res, 'recovery');
}

async function executeAutomationAlert(req, res) {
  const event = redactSecrets(String(req.body?.event || 'workflow_error'), configuredSecrets()).slice(0, 120);
  const detail = redactSecrets(String(req.body?.detail || 'No detail provided'), configuredSecrets()).slice(0, 1200);
  const message = ['GDN automation alert', 'Event: ' + event, 'Detail: ' + detail].join('\n');
  const result = await sendAutomationAlert(message);
  return res.status(result?.ok ? 200 : 502).json({
    ok: Boolean(result?.ok),
    messageId: result?.messageId || null,
    error: result?.ok ? null : result?.error || 'Telegram alert failed',
  });
}

async function executeDailyWatchdog(req, res) {
  if (!isKyivWatchdogWindow()) {
    return res.status(409).json({
      ok: false,
      reason: 'outside_watchdog_window',
      expected: '18:45-19:30 Europe/Kyiv',
    });
  }

  const runKey = `daily-rss:${kyivDateKey()}`;
  const run = getAutomationRunByKey(runKey);
  const healthy = run?.status === 'published' && isValidScheduledRun(run);

  if (healthy) {
    return res.json({ ok: true, runKey, status: run.status, digestId: run.digest_id });
  }

  const reason = run?.status === 'published'
    ? 'published_before_schedule'
    : run?.status || 'missing';
  const message = [
    `⚠️ GDN: автодайджест за ${kyivDateKey()} не подтверждён после 18:00.`,
    `Состояние: ${reason}.`,
    'Проверь workflow News Digest Daily Auto в n8n.',
  ].join('\n');

  let alertResult = { ok: false };
  try {
    alertResult = await sendAutomationAlert(message);
  } catch (error) {
    console.error('[automation] watchdog alert failed:', error.message);
  }

  return res.status(alertResult?.ok ? 200 : 503).json({
    ok: false,
    runKey,
    reason,
    alertSent: Boolean(alertResult?.ok),
  });
}

router.post('/daily-digest', requireDailyTriggerSecret, executeScheduledDigest);
router.post('/daily-recovery', requireDailyTriggerSecret, executeRecoveryDigest);
router.post('/daily-watchdog', requireDailyTriggerSecret, executeDailyWatchdog);
router.post('/alert', requireDailyTriggerSecret, executeAutomationAlert);
router.post('/manual-digest', (req, res) => executeDigest(req, res, 'manual'));

export default router;
