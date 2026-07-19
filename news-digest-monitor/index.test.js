import test from 'node:test';
import assert from 'node:assert/strict';
import { currentAction } from './index.js';

test('chooses Kyiv recovery and verification windows in summer', () => {
  assert.equal(currentAction(new Date('2026-07-19T15:35:00Z')), 'recover');
  assert.equal(currentAction(new Date('2026-07-19T15:55:00Z')), 'verify');
  assert.equal(currentAction(new Date('2026-07-19T14:00:00Z')), 'skip');
});

test('handles Kyiv winter offset without changing the UTC cron', () => {
  assert.equal(currentAction(new Date('2026-01-19T16:35:00Z')), 'recover');
  assert.equal(currentAction(new Date('2026-01-19T16:55:00Z')), 'verify');
});
