import { createHash, timingSafeEqual } from 'crypto';
import { Router } from 'express';
import { handleTelegramUpdate } from '../services/telegram-bot.js';
import config from '../config.js';

const router = Router();

function secretMatches(provided, expected) {
  if (!provided || !expected) return false;
  const providedHash = createHash('sha256').update(String(provided)).digest();
  const expectedHash = createHash('sha256').update(String(expected)).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

router.post('/webhook', (req, res) => {
  const secretToken = req.headers['x-telegram-bot-api-secret-token'];
  if (!config.telegramWebhookSecret) {
    console.error('[telegram] Webhook secret is not configured');
    return res.sendStatus(503);
  }
  if (!secretMatches(secretToken, config.telegramWebhookSecret)) {
    console.warn('[telegram] Invalid secret token in webhook request');
    return res.sendStatus(403);
  }

  res.sendStatus(200);

  handleTelegramUpdate(req.body, config).catch(() => {
    console.error('[telegram] Error handling update');
  });
});

export default router;