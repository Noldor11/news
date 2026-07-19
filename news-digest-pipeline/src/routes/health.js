import { Router } from 'express';
import {
  getArticleCount,
  getDb,
  getLatestAutomationRun,
  getLatestPublishedDigest,
} from '../db/index.js';

const router = Router();

router.get('/', (req, res) => {
  try {
    const articles = {
      new: getArticleCount('new'),
      processing: getArticleCount('processing'),
      used: getArticleCount('used'),
      error: getArticleCount('error'),
    };
    const latestPublished = getLatestPublishedDigest();
    const latestRun = getLatestAutomationRun();
    const runIsDegraded = ['failed', 'partial'].includes(latestRun?.status);

    res.json({
      // Keep HTTP 200 for Railway liveness while exposing an actionable state
      // to the dashboard/monitoring layer.
      status: runIsDegraded ? 'degraded' : 'ok',
      articles,
      latestPublished: latestPublished ? {
        id: latestPublished.id,
        status: latestPublished.status,
        articles: latestPublished.articles_count,
        publishedAt: latestPublished.published_at,
      } : null,
      latestRun: latestRun ? {
        runKey: latestRun.run_key,
        status: latestRun.status,
        stage: latestRun.stage || null,
        degraded: Boolean(latestRun.degraded),
        attempts: latestRun.attempts,
        digestId: latestRun.digest_id,
        updatedAt: latestRun.updated_at,
        hasError: Boolean(latestRun.error),
      } : null,
      uptime: process.uptime(),
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/ready', (req, res) => {
  try {
    getDb().prepare('SELECT 1 AS ok').get();
    res.json({ status: 'ready' });
  } catch (error) {
    res.status(503).json({ status: 'not_ready', message: error.message });
  }
});

export default router;
