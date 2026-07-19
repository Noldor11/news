import { describe, expect, it } from 'vitest';
import { redactSecrets, safeErrorMessage } from './redact.js';

describe('secret redaction', () => {
  it('removes named assignments, bearer values and Telegram tokens', () => {
    const input = 'Failed URL API_SECRET_KEY=abc123456789 N8N_DAILY_TRIGGER_SECRET=xyz987654321 '
      + 'Authorization: Bearer bearer-token-value-123456 1234567890:abcdefghijklmnopqrstuvwxyzABCDE';
    const output = redactSecrets(input);

    expect(output).not.toContain('abc123456789');
    expect(output).not.toContain('xyz987654321');
    expect(output).not.toContain('bearer-token-value-123456');
    expect(output).not.toContain('abcdefghijklmnopqrstuvwxyzABCDE');
  });

  it('redacts explicit secrets even without a variable name', () => {
    const secret = 'opaque-secret-value-123456789';
    expect(safeErrorMessage(new Error(`request failed for ${secret}`), 'failed', [secret]))
      .toBe('request failed for [REDACTED]');
  });
});