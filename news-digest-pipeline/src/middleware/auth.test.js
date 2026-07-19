import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiAuth } from './auth.js';

const previous = {};

beforeEach(() => {
  for (const key of ['NODE_ENV', 'API_SECRET_KEY', 'MONITOR_API_KEY']) previous[key] = process.env[key];
  process.env.NODE_ENV = 'production';
  process.env.API_SECRET_KEY = 'primary-api-key-123456';
  process.env.MONITOR_API_KEY = 'monitor-api-key-123456';
});

afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function invoke(path, token) {
  let statusCode = 200;
  let body;
  let nextCalled = false;
  const req = { path, headers: { authorization: `Bearer ${token}` } };
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { body = value; return this; },
  };
  apiAuth(req, res, () => { nextCalled = true; });
  return { statusCode, body, nextCalled };
}

describe('scoped API authentication', () => {
  it('allows the monitor key only for health and recovery', () => {
    expect(invoke('/health', process.env.MONITOR_API_KEY).nextCalled).toBe(true);
    expect(invoke('/automation/daily-recovery', process.env.MONITOR_API_KEY).nextCalled).toBe(true);
    expect(invoke('/digests', process.env.MONITOR_API_KEY)).toMatchObject({ statusCode: 401, nextCalled: false });
  });

  it('allows the primary API key on all API routes', () => {
    expect(invoke('/digests', process.env.API_SECRET_KEY).nextCalled).toBe(true);
  });
});