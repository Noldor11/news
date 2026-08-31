import { describe, expect, it } from 'vitest';
import { automationRunStatus, MAX_AUTOMATION_RUN_MS } from './automation-run-status.js';

const started = Date.parse('2026-08-31T15:00:00Z');
const run = { id: 'run-1', run_key: 'daily-rss:2026-08-31', status: 'running', started_at: '2026-08-31 15:00:00' };

describe('durable automation status', () => {
  it('remains pending beyond the five-minute proxy cutoff', () => {
    expect(automationRunStatus(run, { now: started + 6 * 60000 })).toMatchObject({
      ok: true, state: 'running', pending: true, terminal: false, pollAfterSeconds: 30,
    });
  });
  it('reports overdue without changing the run or making it retryable', () => {
    expect(automationRunStatus(run, { now: started + MAX_AUTOMATION_RUN_MS })).toMatchObject({
      ok: false, state: 'overdue', pending: false, terminal: true,
    });
    expect(run.status).toBe('running');
  });
  it('distinguishes publication, failure and ambiguous delivery', () => {
    for (const state of ['published', 'failed', 'partial']) {
      expect(automationRunStatus({ ...run, status: state, error: 'private diagnostic' })).toMatchObject({
        ok: state === 'published', state, pending: false, terminal: true, hasError: true,
      });
      expect(automationRunStatus({ ...run, status: state, error: 'private diagnostic' })).not.toHaveProperty('error');
    }
  });
  it('does not treat early publication, missing rows or invalid timestamps as success', () => {
    expect(automationRunStatus({ ...run, status: 'published' }, { validPublished: false }).state).toBe('published_before_schedule');
    expect(automationRunStatus(null).ok).toBe(false);
    expect(automationRunStatus({ ...run, started_at: 'invalid' }).state).toBe('overdue');
  });
});
