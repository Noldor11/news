/**
 * Authentication middleware for API and Dashboard.
 *
 * - API routes: Authorization: Bearer token (using API_SECRET_KEY)
 * - Dashboard: HTTP Basic Auth (using DASHBOARD_PASSWORD, separate from API key)
 * - Telegram webhook: exempted (has its own secret-token check)
 *
 * Two separate keys: compromising one doesn't compromise the other.
 */

import { createHash, createHmac, timingSafeEqual } from 'crypto';

const DASHBOARD_COOKIE = 'news_digest_dashboard';
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Hash both to constant length to avoid length-based timing leak
    const hashA = createHash('sha256').update(a).digest();
    const hashB = createHash('sha256').update(b).digest();
    return timingSafeEqual(hashA, hashB);
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Auth is enforced only in production. Locally (NODE_ENV !== 'production')
 * the dashboard and API are open so the login prompt doesn't get in the way.
 * The deployed instance runs with NODE_ENV=production and stays protected.
 */
function authDisabled() {
  return process.env.NODE_ENV !== 'production';
}

function getDashboardSecret() {
  return process.env.DASHBOARD_PASSWORD || '';
}

function signSession(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function parseCookies(header = '') {
  const cookies = {};
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function hasValidDashboardSession(req) {
  const secret = getDashboardSecret();
  if (!secret) return false;

  const token = parseCookies(req.headers.cookie)[DASHBOARD_COOKIE];
  if (!token) return false;

  const [user, issuedAt, signature] = token.split('.');
  if (!user || !issuedAt || !signature) return false;
  if (user !== (process.env.DASHBOARD_USER || 'admin')) return false;

  const issuedMs = Number(issuedAt);
  if (!Number.isFinite(issuedMs) || Date.now() - issuedMs > SESSION_MAX_AGE_MS) return false;

  const payload = `${user}.${issuedAt}`;
  return safeCompare(signature, signSession(payload, secret));
}

export function createDashboardSession(res, user) {
  const secret = getDashboardSecret();
  if (!secret) return false;

  const issuedAt = String(Date.now());
  const payload = `${user}.${issuedAt}`;
  const token = `${payload}.${signSession(payload, secret)}`;
  const maxAge = Math.floor(SESSION_MAX_AGE_MS / 1000);
  res.setHeader(
    'Set-Cookie',
    `${DASHBOARD_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`
  );
  return true;
}

export function clearDashboardSession(res) {
  res.setHeader('Set-Cookie', `${DASHBOARD_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}

export function validateDashboardCredentials(user, pass) {
  const expectedUser = process.env.DASHBOARD_USER || 'admin';
  const expectedPass = getDashboardSecret();
  if (!expectedPass) return authDisabled();
  return safeCompare(user, expectedUser) && safeCompare(pass, expectedPass);
}

export function apiAuth(req, res, next) {
  // Telegram webhook has its own auth via X-Telegram-Bot-Api-Secret-Token
  if (req.path.startsWith('/telegram/') || req.path.startsWith('/api/telegram/')) return next();

  if (authDisabled()) return next();
  if (hasValidDashboardSession(req)) return next();

  const expectedKey = process.env.API_SECRET_KEY;
  if (!expectedKey) {
    return res.status(503).json({ error: 'API authentication is not configured' });
  }

  // Check Bearer token. The monitor key is intentionally scoped to read-only
  // health and the recovery route, which has an additional daily-secret guard.
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    const bearer = authHeader.slice(7);
    if (safeCompare(bearer, expectedKey)) return next();

    const monitorKey = process.env.MONITOR_API_KEY || '';
    const monitorPaths = new Set(['/health', '/automation/daily-recovery']);
    if (monitorKey && monitorPaths.has(req.path) && safeCompare(bearer, monitorKey)) return next();
  }

  // Check Basic Auth (dashboard passes Basic Auth to API on same origin)
  if (authHeader.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(authHeader.split(' ')[1], 'base64').toString();
      const colonIdx = decoded.indexOf(':');
      if (colonIdx !== -1) {
        const pass = decoded.slice(colonIdx + 1);
        // Accept either API key or dashboard password
        const dashPass = process.env.DASHBOARD_PASSWORD || '';
        if (safeCompare(pass, expectedKey) || (dashPass && safeCompare(pass, dashPass))) return next();
      }
    } catch {
      // malformed — fall through
    }
  }

  return res.status(401).json({ error: 'Unauthorized' });
}

export function dashboardAuth(req, res, next) {
  if (authDisabled()) return next();
  if (hasValidDashboardSession(req)) return next();

  const expectedPass = getDashboardSecret();
  if (!expectedPass) {
    return res.status(503).type('html').send('Dashboard authentication is not configured');
  }

  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Basic ')) {
    return res.redirect('/login');
  }

  try {
    const decoded = Buffer.from(authHeader.split(' ')[1], 'base64').toString();
    const colonIdx = decoded.indexOf(':');
    if (colonIdx === -1) {
      return res.redirect('/login');
    }
    const user = decoded.slice(0, colonIdx);
    const pass = decoded.slice(colonIdx + 1);
    const expectedUser = process.env.DASHBOARD_USER || 'admin';

    if (!safeCompare(user, expectedUser) || !safeCompare(pass, expectedPass)) {
      return res.redirect('/login');
    }
  } catch {
    return res.redirect('/login');
  }

  next();
}
