import express from 'express';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import config from './config.js';
import { initDb } from './db/index.js';
import { apiAuth, clearDashboardSession, createDashboardSession, dashboardAuth, validateDashboardCredentials } from './middleware/auth.js';
import healthRouter from './routes/health.js';
import articlesRouter from './routes/articles.js';
import digestsRouter from './routes/digests.js';
import telegramRouter from './routes/telegram.js';
import settingsRouter from './routes/settings.js';
import automationRouter from './routes/automation.js';
import { startQueueManager } from './services/queue-manager.js';
import { setupTelegramBot } from './services/telegram-bot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.set('trust proxy', 1);

// Middleware
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: false }));
morgan.token('safe-url', (req) => req.path);
app.use(morgan(':method :safe-url :status :res[content-length] - :response-time ms'));

// Debug logging — only in development
if (process.env.NODE_ENV !== 'production') {
  app.use((req, res, next) => {
    if (req.path !== '/health') {
      console.log(`[debug] ${req.method} ${req.path} Content-Type: ${req.headers['content-type']}`);
    }
    next();
  });
}

// Rate limiters
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests' },
});

const publishLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many publish requests' },
});

const generateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  message: { error: 'Too many generation requests' },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many login attempts, try again later',
  skipSuccessfulRequests: true,
});
// Health endpoint — public, no auth
app.use('/health', healthRouter);

function renderLoginPage(error = '') {
  const errorHtml = error ? `<p class="error">${error}</p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>News Digest Login</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #f6f7f9; color: #171717; }
    main { width: min(380px, calc(100vw - 32px)); }
    h1 { margin: 0 0 18px; font-size: 24px; font-weight: 650; }
    form { display: grid; gap: 12px; padding: 24px; border: 1px solid #d8dde5; border-radius: 8px; background: #fff; box-shadow: 0 8px 30px rgba(17,24,39,.08); }
    label { display: grid; gap: 6px; font-size: 13px; font-weight: 600; }
    input { box-sizing: border-box; width: 100%; padding: 10px 12px; border: 1px solid #b9c0cc; border-radius: 6px; font: inherit; }
    button { margin-top: 6px; padding: 10px 12px; border: 0; border-radius: 6px; background: #111827; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
    .error { margin: 0 0 12px; color: #b42318; font-size: 14px; }
    @media (prefers-color-scheme: dark) {
      body { background: #111315; color: #f7f7f7; }
      form { background: #181b20; border-color: #343a44; box-shadow: none; }
      input { background: #101214; color: #fff; border-color: #4b5563; }
      button { background: #f7f7f7; color: #111315; }
    }
  </style>
</head>
<body>
  <main>
    <h1>News Digest</h1>
    <form method="post" action="/login">
      ${errorHtml}
      <label>Username<input name="username" autocomplete="username" autofocus required /></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required /></label>
      <button type="submit">Sign in</button>
    </form>
  </main>
</body>
</html>`;
}

app.get('/login', (req, res) => {
  res.type('html').send(renderLoginPage());
});

app.post('/login', loginLimiter, (req, res) => {
  const username = String(req.body.username || '');
  const password = String(req.body.password || '');
  if (!validateDashboardCredentials(username, password)) {
    return res.status(401).type('html').send(renderLoginPage('Invalid username or password'));
  }
  createDashboardSession(res, username);
  return res.redirect('/');
});

app.post('/logout', (req, res) => {
  clearDashboardSession(res);
  return res.redirect('/login');
});

// Dashboard: a signed login session protects all static UI routes. Login
// throttling is attached directly to POST /login above.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path === '/health' || req.path === '/login') return next();
  dashboardAuth(req, res, () => {
    express.static(join(__dirname, 'public'))(req, res, next);
  });
});
// Telegram webhook — mounted before general API auth (has its own secret-token check)
app.use('/api/telegram', telegramRouter);

// API auth + rate limiting for all other /api/* routes
app.use('/api', apiAuth, apiLimiter);

// API routes with specific rate limits
app.use('/api/settings', settingsRouter);
app.use('/api/automation', automationRouter);
app.use('/api/articles', articlesRouter);
app.use('/api/digests/generate', generateLimiter);
app.use('/api/digests/:id/publish', publishLimiter);
app.use('/api/digests', digestsRouter);

// Initialize
try {
  initDb(config.dbPath);
  console.log(`[init] Database initialized at ${config.dbPath}`);
} catch (err) {
  console.error('[init] Failed to initialize database:', err);
  process.exit(1);
}

// Start queue manager
const queueInterval = startQueueManager(config);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[shutdown] Stopping...');
  clearInterval(queueInterval);
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[shutdown] Stopping...');
  clearInterval(queueInterval);
  process.exit(0);
});

// Start server
app.listen(config.port, () => {
  console.log(`[server] News Digest Pipeline running on port ${config.port}`);
  console.log(`[server] Environment: ${config.nodeEnv}`);

  // Register Telegram webhook after server is listening
  setupTelegramBot(config).catch((err) => {
    console.error('[init] Failed to setup Telegram bot:', err.message);
  });
});
