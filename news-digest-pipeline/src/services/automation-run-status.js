export const MAX_AUTOMATION_RUN_MS = 30 * 60 * 1000;

export function automationRunStatus(run, { now = Date.now(), validPublished = true } = {}) {
  if (!run) return { ok: false, state: 'missing', pending: false, terminal: true };
  const started = String(run.started_at || '').replace(' ', 'T');
  const startedAt = Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(started) ? started : `${started}Z`);
  const active = ['running', 'publishing'].includes(run.status);
  const overdue = active && (!Number.isFinite(startedAt) || now - startedAt >= MAX_AUTOMATION_RUN_MS);
  const published = run.status === 'published' && validPublished;
  const pending = active && !overdue;
  let messageIds = [];
  try {
    const parsed = JSON.parse(run.telegram_message_ids || '[]');
    if (Array.isArray(parsed)) messageIds = parsed;
  } catch { /* A malformed delivery record must never permit a resend. */ }
  return {
    ok: published || pending,
    runId: run.id,
    runKey: run.run_key,
    state: overdue ? 'overdue' : run.status === 'published' && !validPublished ? 'published_before_schedule' : run.status,
    pending,
    terminal: !pending,
    stage: run.stage || null,
    digestId: run.digest_id || null,
    telegramMessageIds: messageIds,
    hasError: Boolean(run.error),
    statusUrl: `/api/automation/runs/${encodeURIComponent(run.id)}`,
    pollAfterSeconds: pending ? 30 : null,
  };
}
