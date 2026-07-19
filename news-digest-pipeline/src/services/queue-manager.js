import { getArticleCount, getNewArticles } from '../db/index.js';
import { generateDigest } from './digest-generator.js';
import { notifyDigestReady } from './notifier.js';
import { getDb } from '../db/index.js';

let running = false;

async function processQueue(config) {
  if (running) {
    return;
  }

  running = true;

  try {
    const newCount = getArticleCount('new');

    if (newCount < config.articleThreshold) {
      return;
    }

    const limit = Math.min(newCount, config.maxArticlesPerDigest);
    const articles = getNewArticles(limit);

    console.log(`[queue-manager] Processing ${articles.length} articles into digest`);

    const db = getDb();
    const digestId = await generateDigest(db, articles, config);

    console.log(`[queue-manager] Digest generated: ${digestId}`);

    if (config.ntfyTopic) {
      const { getDigest } = await import('../db/index.js');
      const digest = getDigest(digestId);
      await notifyDigestReady(config.ntfyTopic, digest);
    }
  } catch (err) {
    console.error('[queue-manager] Error processing queue:', err.message);
  } finally {
    running = false;
  }
}

export function startQueueManager(config) {
  if (!config.autoQueueEnabled) {
    console.log('[queue-manager] Disabled; n8n owns daily collection and generation');
    return null;
  }

  console.log(`[queue-manager] Started (interval: ${config.checkIntervalMs}ms, threshold: ${config.articleThreshold})`);

  const intervalId = setInterval(() => processQueue(config), config.checkIntervalMs);

  // Run once immediately
  processQueue(config);

  return intervalId;
}
