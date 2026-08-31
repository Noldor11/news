import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ runs: new Map(), runner: vi.fn(), alert: vi.fn() }));
vi.mock('../config.js', () => ({ default: {} }));
vi.mock('../db/index.js', () => ({
  claimAutomationRun(key, trigger) {
    const previous = [...mocks.runs.values()].find((run) => run.run_key === key);
    if (previous) return { claimed: false, run: previous };
    const run = { id: `run-${mocks.runs.size}`, run_key: key, trigger, status: 'running', started_at: new Date().toISOString() };
    mocks.runs.set(run.id, run);
    return { claimed: true, run };
  },
  getAutomationRun: (id) => mocks.runs.get(id),
  getAutomationRunByKey: (key) => [...mocks.runs.values()].find((r) => r.run_key === key),
  updateAutomationRun: (id, fields) => Object.assign(mocks.runs.get(id), fields),
  getDigest: vi.fn(),
}));
vi.mock('../services/rss-digest-runner.js', () => ({ runDailyRssDigest: mocks.runner }));
vi.mock('../services/apify-marketplace.js', () => ({ kyivWeekKey: vi.fn() }));
vi.mock('../services/weekly-marketplace-report.js', () => ({ runWeeklyMarketplaceReport: vi.fn() }));
vi.mock('../services/publishers/index.js', () => ({ publishDigest: vi.fn() }));
vi.mock('../services/telegram-bot.js', () => ({ sendMessage: mocks.alert }));

import { executeDigest, getRunStatus } from './automation.js';

function response() {
  return { code: null, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}
const request = { get: () => 'respond-async' };
const result = { digestId: 'digest-1', selected: 23, published: { telegram: { ok: true, messageIds: ['1', '2'] } } };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-31T15:00:00Z'));
  mocks.runs.clear();
  mocks.runner.mockReset();
  mocks.alert.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('async digest request lifecycle', () => {
  it('acknowledges before processing and confirms a six-minute job without a false failure', async () => {
    let finish;
    mocks.runner.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const accepted = response();
    await executeDigest(request, accepted, 'schedule');
    expect(accepted.code).toBe(202);
    expect(accepted.body).toMatchObject({ accepted: true, pending: true, runId: 'run-0' });
    expect(mocks.runner).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6 * 60000);
    const running = response();
    getRunStatus({ params: { id: 'run-0' } }, running);
    expect(running.body.pending).toBe(true);
    const duplicate = response();
    await executeDigest(request, duplicate, 'recovery');
    expect(duplicate.code).toBe(202);
    expect(duplicate.body.skipped).toBe(true);
    expect(mocks.runner).toHaveBeenCalledTimes(1);
    finish(result);
    await vi.advanceTimersByTimeAsync(1);
    const completed = response();
    getRunStatus({ params: { id: 'run-0' } }, completed);
    expect(completed.body).toMatchObject({ state: 'published', pending: false, ok: true, telegramMessageIds: ['1', '2'] });
    expect(mocks.alert).not.toHaveBeenCalled();
    const repeated = response();
    await executeDigest(request, repeated, 'schedule');
    expect(repeated.code).toBe(200);
    expect(mocks.runner).toHaveBeenCalledTimes(1);
  });

  it('persists a real background failure for polling instead of claiming success', async () => {
    mocks.runner.mockRejectedValue(new Error('Test collection failure'));
    const accepted = response();
    await executeDigest(request, accepted, 'schedule');
    await vi.advanceTimersByTimeAsync(1);
    const status = response();
    getRunStatus({ params: { id: accepted.body.runId } }, status);
    expect(status.body).toMatchObject({ ok: false, state: 'failed', terminal: true });
  });

  it('blocks a retry when delivery becomes ambiguous', async () => {
    mocks.runner.mockImplementation(async ({ onDigestReady }) => {
      await onDigestReady('digest-1');
      throw new Error('Test transport failure');
    });
    await executeDigest(request, response(), 'schedule');
    await vi.advanceTimersByTimeAsync(1);
    const retry = response();
    await executeDigest(request, retry, 'recovery');
    expect(retry.code).toBe(409);
    expect(retry.body.state).toBe('partial');
    expect(mocks.runner).toHaveBeenCalledTimes(1);
  });

  it('preserves synchronous manual clients unless they request async', async () => {
    mocks.runner.mockResolvedValue(result);
    const res = response();
    await executeDigest({ get: () => undefined }, res, 'manual');
    expect(res.code).toBe(201);
    expect(res.body.digestId).toBe('digest-1');
  });
});
