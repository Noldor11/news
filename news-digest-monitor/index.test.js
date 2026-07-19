import test from 'node:test';
import assert from 'node:assert/strict';
import { currentAction, diagnosticCode, sanitizeDiagnostic } from './index.js';

test('chooses Kyiv recovery and verification windows in summer', () => {
  assert.equal(currentAction(new Date('2026-07-19T15:35:00Z')), 'recover');
  assert.equal(currentAction(new Date('2026-07-19T15:55:00Z')), 'verify');
  assert.equal(currentAction(new Date('2026-07-19T14:00:00Z')), 'skip');
});

test('handles Kyiv winter offset without changing the UTC cron', () => {
  assert.equal(currentAction(new Date('2026-01-19T16:35:00Z')), 'recover');
  assert.equal(currentAction(new Date('2026-01-19T16:55:00Z')), 'verify');
});
test('redacts secrets from diagnostics', () => {
  const output = sanitizeDiagnostic(
    'Failed URL API_SECRET_KEY=secret-value-123456 TELEGRAM_BOT_TOKEN=1234567890:abcdefghijklmnopqrstuvwxyzABCDE',
  );
  assert.equal(output.includes('secret-value-123456'), false);
  assert.equal(output.includes('abcdefghijklmnopqrstuvwxyzABCDE'), false);
});

test('maps URL failures to a stable code without returning the URL', () => {
  assert.equal(diagnosticCode(new Error('Failed to parse URL from https://example.test API_SECRET_KEY=secret')), 'invalid_application_url');
});
