import { beforeEach, describe, expect, it } from 'vitest';
import {
  claimAutomationRun,
  getDb,
  getAutomationRun,
  getAutomationRunByKey,
  getLatestAutomationRun,
  getLatestDailyAutomationRun,
  initDb,
  recordDuplicateArticle,
  updateAutomationRun,
} from './index.js';

let nativeDatabaseReady = true;
try {
  initDb(':memory:');
} catch {
  // The host runs Node 24 while this repository's production image is Node 20.
  // Keep the integration coverage enabled automatically wherever the native
  // better-sqlite3 binding is available.
  nativeDatabaseReady = false;
}

const describeWithNativeDatabase = nativeDatabaseReady ? describe : describe.skip;

describeWithNativeDatabase('automation run lock', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  it('claims a daily key only once while it is active or published', () => {
    const first = claimAutomationRun('daily-rss:2026-07-15');
    const duplicate = claimAutomationRun('daily-rss:2026-07-15');

    expect(first.claimed).toBe(true);
    expect(duplicate).toMatchObject({ claimed: false, reason: 'running' });

    updateAutomationRun(first.run.id, {
      status: 'published',
      stage: 'confirmed',
      degraded: 1,
      metrics_json: JSON.stringify({ selected: 13 }),
      completed_at: new Date().toISOString(),
    });
    const publishedDuplicate = claimAutomationRun('daily-rss:2026-07-15');
    expect(publishedDuplicate).toMatchObject({ claimed: false, reason: 'published' });
    expect(getAutomationRunByKey('daily-rss:2026-07-15')).toMatchObject({
      id: first.run.id,
      status: 'published',
      stage: 'confirmed',
      degraded: 1,
      metrics_json: JSON.stringify({ selected: 13 }),
    });
  });

  it('only reclaims a failed run and preserves its digest id for a safe publish retry', () => {
    const first = claimAutomationRun('daily-rss:2026-07-16');
    updateAutomationRun(first.run.id, {
      status: 'failed',
      digest_id: 'digest-safe-to-retry',
      error: 'Telegram rejected request before delivery',
    });

    const retry = claimAutomationRun('daily-rss:2026-07-16');
    const stored = getAutomationRun(first.run.id);

    expect(retry).toMatchObject({ claimed: true, reason: 'retry' });
    expect(stored).toMatchObject({
      status: 'running',
      digest_id: 'digest-safe-to-retry',
      attempts: 2,
      error: null,
    });
  });
});

describeWithNativeDatabase('article duplicate audit fields', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  it('records a rejected event without returning it to the new article queue', () => {
    const result = recordDuplicateArticle({
      url: 'https://example.com/repackaged-story',
      title: 'Repackaged story',
      content: 'The same event from another source.',
      eventFingerprint: 'event-123',
      duplicateOf: 'https://example.com/original-story',
      duplicateReason: 'recent-event',
    });
    const stored = getDb().prepare('SELECT * FROM articles WHERE id = ?').get(result.id);

    expect(result.recorded).toBe(true);
    expect(stored).toMatchObject({
      status: 'duplicate',
      event_fingerprint: 'event-123',
      duplicate_of: 'https://example.com/original-story',
      duplicate_reason: 'recent-event',
    });
  });

  it('keeps a failed manual run separate from daily production health', () => {
    const daily = claimAutomationRun('daily-rss:2026-08-09', 'schedule');
    updateAutomationRun(daily.run.id, { status: 'published', stage: 'confirmed' });
    const manual = claimAutomationRun('manual-rss:2026-08-09:test', 'manual');
    updateAutomationRun(manual.run.id, { status: 'failed', stage: 'failed', error: 'test failure' });

    expect(getLatestAutomationRun()).toMatchObject({ id: manual.run.id, trigger: 'manual' });
    expect(getLatestDailyAutomationRun()).toMatchObject({
      id: daily.run.id,
      trigger: 'schedule',
      status: 'published',
    });
  });
});
