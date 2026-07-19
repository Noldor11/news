import { describe, expect, it } from 'vitest';
import {
  isKyivDailyWindow,
  isKyivRecoveryWindow,
  isKyivWatchdogWindow,
  kyivDateKey,
  parseSqliteUtc,
  runStartedInDailyWindow,
  runStartedInRecoveryWindow,
} from './automation-schedule.js';

describe('automation schedule guards', () => {
  it('uses the Europe/Kyiv calendar date', () => {
    expect(kyivDateKey(new Date('2026-07-17T21:30:00Z'))).toBe('2026-07-18');
  });

  it('allows the daily endpoint only around the 18:00 Kyiv schedule', () => {
    expect(isKyivDailyWindow(new Date('2026-07-17T14:50:00Z'))).toBe(true);
    expect(isKyivDailyWindow(new Date('2026-07-17T15:30:00Z'))).toBe(true);
    expect(isKyivDailyWindow(new Date('2026-07-17T09:50:00Z'))).toBe(false);
    expect(isKyivDailyWindow(new Date('2026-07-17T15:31:00Z'))).toBe(false);
  });

  it('handles the winter Kyiv offset without hardcoding UTC hours', () => {
    expect(isKyivDailyWindow(new Date('2026-01-17T16:00:00Z'))).toBe(true);
  });

  it('recognizes separate recovery and watchdog windows', () => {
    expect(isKyivRecoveryWindow(new Date('2026-07-17T15:35:00Z'))).toBe(true);
    expect(isKyivWatchdogWindow(new Date('2026-07-17T15:55:00Z'))).toBe(true);
    expect(isKyivWatchdogWindow(new Date('2026-07-17T15:20:00Z'))).toBe(false);
    expect(isKyivWatchdogWindow(new Date('2026-07-17T16:31:00Z'))).toBe(false);
  });

  it('treats SQLite timestamps as UTC and recognizes scheduled recovery runs', () => {
    expect(parseSqliteUtc('2026-07-17 15:00:01')?.toISOString()).toBe('2026-07-17T15:00:01.000Z');
    expect(runStartedInDailyWindow({ started_at: '2026-07-17 15:00:01' })).toBe(true);
    expect(runStartedInRecoveryWindow({ started_at: '2026-07-17 15:35:01' })).toBe(true);
    expect(runStartedInDailyWindow({ started_at: '2026-07-17 09:50:01' })).toBe(false);
  });
});
