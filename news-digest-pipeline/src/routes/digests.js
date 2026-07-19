import { Router } from 'express';
import { safeErrorMessage } from '../security/redact.js';
import {
  getDigest,
  getDigests,
  getNewArticles,
  getArticlesByDigestId,
} from '../db/index.js';
import { generateDigest } from '../services/digest-generator.js';
import { publishDigest } from '../services/publishers/index.js';
import { getDb } from '../db/index.js';
import config from '../config.js';

const router = Router();

function hasTelegramDeliveryRecord(digest) {
  if (digest.telegram_message_id) return true;
  try {
    const messageIds = JSON.parse(digest.telegram_message_ids || '[]');
    return Array.isArray(messageIds) && messageIds.length > 0;
  } catch {
    return Boolean(digest.telegram_message_ids);
  }
}

function includesTelegram(platforms) {
  return !Array.isArray(platforms) || platforms.length === 0 || platforms.includes('telegram');
}

// POST /api/digests/generate — manual trigger
router.post('/generate', async (req, res) => {
  try {
    const { articleIds } = req.body || {};

    let articles;
    if (Array.isArray(articleIds) && articleIds.length > 0) {
      const db = getDb();
      const placeholders = articleIds.map(() => '?').join(',');
      articles = db.prepare(
        `SELECT * FROM articles WHERE id IN (${placeholders})`
      ).all(...articleIds);
    } else {
      articles = getNewArticles(config.maxArticlesPerDigest);
    }

    if (articles.length === 0) {
      return res.status(400).json({ error: 'No articles available for digest generation' });
    }

    const db = getDb();
    const digestId = await generateDigest(db, articles, config);

    res.status(201).json({ digestId });
  } catch (err) {
    console.error('[digests] POST /generate error:', safeErrorMessage(err));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/digests — list digests
router.get('/', (req, res) => {
  try {
    const { status } = req.query;
    const filters = {};
    if (status) filters.status = status;

    const digests = getDigests(filters);
    res.json(digests);
  } catch (err) {
    console.error('[digests] GET / error:', safeErrorMessage(err));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/digests/latest/text — latest digest as plain text
router.get('/latest/text', (req, res) => {
  try {
    const digests = getDigests();
    if (digests.length === 0) {
      return res.status(404).send('No digests yet');
    }
    const latest = digests[0];
    if (!latest.content) {
      return res.status(400).send('Latest digest has no content yet');
    }
    res.type('text/plain; charset=utf-8').send(latest.content);
  } catch (err) {
    console.error('[digests] GET /latest/text error:', safeErrorMessage(err));
    res.status(500).send('Internal server error');
  }
});

// GET /api/digests/:id — single digest with articles
router.get('/:id', (req, res) => {
  try {
    const digest = getDigest(req.params.id);
    if (!digest) {
      return res.status(404).json({ error: 'Digest not found' });
    }

    const articles = getArticlesByDigestId(digest.id);

    res.json({ ...digest, articles });
  } catch (err) {
    console.error('[digests] GET /:id error:', safeErrorMessage(err));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/digests/:id/text — plain text for copy-paste
router.get('/:id/text', (req, res) => {
  try {
    const digest = getDigest(req.params.id);
    if (!digest) {
      return res.status(404).json({ error: 'Digest not found' });
    }
    if (!digest.content) {
      return res.status(400).send('Digest has no content yet');
    }
    res.type('text/plain; charset=utf-8').send(digest.content);
  } catch (err) {
    console.error('[digests] GET /:id/text error:', safeErrorMessage(err));
    res.status(500).send('Internal server error');
  }
});

// POST /api/digests/:id/publish — publish to selected platforms.
// A digest with a Telegram delivery record cannot be sent again from the UI.
router.post('/:id/publish', async (req, res) => {
  try {
    const digest = getDigest(req.params.id);
    if (!digest) return res.status(404).json({ error: 'Digest not found' });
    if (!digest.content) return res.status(400).json({ error: 'Digest has no content to publish' });

    const { platforms } = req.body || {};
    if (includesTelegram(platforms) && (digest.status === 'publish_partial' || hasTelegramDeliveryRecord(digest))) {
      return res.status(409).json({
        error: 'Telegram delivery is already recorded or incomplete. Refusing to risk a duplicate post.',
        digestId: digest.id,
        status: digest.status,
      });
    }

    const results = await publishDigest(digest, config, platforms);
    const telegram = results.telegram;
    if (includesTelegram(platforms) && !telegram?.ok) {
      const code = telegram?.status === 'partial' || telegram?.status === 'blocked' ? 409 : 502;
      return res.status(code).json({ digestId: digest.id, published: results, error: telegram?.error });
    }

    return res.json({ digestId: digest.id, published: results });
  } catch (err) {
    console.error('[digests] POST /:id/publish error:', safeErrorMessage(err));
    return res.status(500).json({ error: 'Internal server error' });
  }
});
// PATCH /api/digests/:id/mark-copied — mark digest as copied
router.patch('/:id/mark-copied', (req, res) => {
  try {
    const digest = getDigest(req.params.id);
    if (!digest) {
      return res.status(404).json({ error: 'Digest not found' });
    }

    const db = getDb();
    db.prepare(
      `UPDATE digests SET status = 'copied', updated_at = datetime('now') WHERE id = ?`
    ).run(req.params.id);

    res.json({ ok: true, id: req.params.id, status: 'copied' });
  } catch (err) {
    console.error('[digests] PATCH /:id/mark-copied error:', safeErrorMessage(err));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/digests/:id — delete a digest
router.delete('/:id', (req, res) => {
  try {
    const digest = getDigest(req.params.id);
    if (!digest) {
      return res.status(404).json({ error: 'Digest not found' });
    }

    if (digest.status === 'publish_partial' || hasTelegramDeliveryRecord(digest)) {
      return res.status(409).json({
        error: 'A digest with a Telegram delivery record cannot be deleted because it could be posted again later.',
      });
    }
    const db = getDb();
    // Unlink articles from this digest (set them back to 'new')
    db.prepare(`UPDATE articles SET digest_id = NULL, status = 'new', commentary = NULL WHERE digest_id = ?`).run(req.params.id);
    // Delete digest
    db.prepare('DELETE FROM digests WHERE id = ?').run(req.params.id);

    res.json({ ok: true, deleted: req.params.id });
  } catch (err) {
    console.error('[digests] DELETE /:id error:', safeErrorMessage(err));
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
