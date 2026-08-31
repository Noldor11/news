import { Router } from 'express';
import {
  getArticleCount,
  getDb,
  getLatestDailyAutomationRun,
  getLatestAutomationRun,
  getLatestPublishedDigest,
} from '../db/index.js';

const router = Router();
export const healthDetailsRouter = Router();

router.get('/', (req, res) => {
  res.json({ status: 'ok' });
});

router.get('/ready', (req, res) => {
  try {
    getDb().prepare('SELECT 1 AS ok').get();
    res.json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'not_ready' });
  }
});

healthDetailsRouter.get('/', (req, res) => {
  try {
    const articles = {
      new: getArticleCount('new'),
      processing: getArticleCount('processing'),
      used: getArticleCount('used'),
      error: getArticleCount('error'),
    };
    const latestPublished = getLatestPublishedDigest();
    const latestRun = getLatestDailyAutomationRun();
    const latestActivity = getLatestAutomationRun();
    const runIsDegraded = ['failed', 'partial'].includes(latestRun?.status);

    res.json({
      status: runIsDegraded ? 'degraded' : 'ok',
      articles,
      latestPublished: latestPublished ? {
        id: latestPublished.id,
        status: latestPublished.status,
        articles: latestPublished.articles_count,
        publishedAt: latestPublished.published_at,
      } : null,
      latestRun: latestRun ? {
        runId: latestRun.id,
        runKey: latestRun.run_key,
        status: latestRun.status,
        stage: latestRun.stage || null,
        degraded: Boolean(latestRun.degraded),
        attempts: latestRun.attempts,
        digestId: latestRun.digest_id,
        updatedAt: latestRun.updated_at,
        hasError: Boolean(latestRun.error),
      } : null,
      latestActivity: latestActivity ? {
        runKey: latestActivity.run_key,
        trigger: latestActivity.trigger,
        status: latestActivity.status,
        stage: latestActivity.stage || null,
        updatedAt: latestActivity.updated_at,
        hasError: Boolean(latestActivity.error),
      } : null,
      uptime: process.uptime(),
    });
  } catch {
    res.status(500).json({ status: 'error' });
  }
});

export default router;
