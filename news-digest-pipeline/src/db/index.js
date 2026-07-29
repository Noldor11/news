import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db;

export function initDb(dbPath) {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);

  // Idempotent migrations for existing DBs
  const articleCols = new Set(db.prepare('PRAGMA table_info(articles)').all().map((c) => c.name));
  if (!articleCols.has('source_chat_id')) {
    db.exec('ALTER TABLE articles ADD COLUMN source_chat_id TEXT');
  }
  if (!articleCols.has('source_message_id')) {
    db.exec('ALTER TABLE articles ADD COLUMN source_message_id TEXT');
  }
  if (!articleCols.has('event_fingerprint')) {
    db.exec('ALTER TABLE articles ADD COLUMN event_fingerprint TEXT');
  }
  if (!articleCols.has('duplicate_of')) {
    db.exec('ALTER TABLE articles ADD COLUMN duplicate_of TEXT');
  }
  if (!articleCols.has('duplicate_reason')) {
    db.exec('ALTER TABLE articles ADD COLUMN duplicate_reason TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_articles_event_fingerprint ON articles(event_fingerprint)');

  // Token accounting + cost columns on digests (idempotent)
  const digestCols = new Set(db.prepare('PRAGMA table_info(digests)').all().map((c) => c.name));
  if (!digestCols.has('seq_number')) {
    // createDigest writes seq_number, so older DBs missing this column break
    // digest creation entirely. Add it and backfill existing rows in order.
    db.exec('ALTER TABLE digests ADD COLUMN seq_number INTEGER');
    const rows = db.prepare('SELECT id FROM digests ORDER BY created_at ASC, rowid ASC').all();
    const setSeq = db.prepare('UPDATE digests SET seq_number = ? WHERE id = ?');
    rows.forEach((r, i) => setSeq.run(i + 1, r.id));
  }
  if (!digestCols.has('model')) {
    db.exec('ALTER TABLE digests ADD COLUMN model TEXT');
  }
  if (!digestCols.has('input_tokens')) {
    db.exec('ALTER TABLE digests ADD COLUMN input_tokens INTEGER DEFAULT 0');
  }
  if (!digestCols.has('output_tokens')) {
    db.exec('ALTER TABLE digests ADD COLUMN output_tokens INTEGER DEFAULT 0');
  }
  if (!digestCols.has('cost_usd')) {
    db.exec('ALTER TABLE digests ADD COLUMN cost_usd REAL');
  }
  if (!digestCols.has('telegram_message_ids')) {
    db.exec('ALTER TABLE digests ADD COLUMN telegram_message_ids TEXT');
  }
  if (!digestCols.has('publication_error')) {
    db.exec('ALTER TABLE digests ADD COLUMN publication_error TEXT');
  }

  const automationCols = new Set(db.prepare('PRAGMA table_info(automation_runs)').all().map((c) => c.name));
  if (!automationCols.has('stage')) {
    db.exec("ALTER TABLE automation_runs ADD COLUMN stage TEXT NOT NULL DEFAULT 'started'");
  }
  if (!automationCols.has('degraded')) {
    db.exec('ALTER TABLE automation_runs ADD COLUMN degraded INTEGER NOT NULL DEFAULT 0');
  }
  if (!automationCols.has('metrics_json')) {
    db.exec('ALTER TABLE automation_runs ADD COLUMN metrics_json TEXT');
  }

  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export function insertArticle({
  url,
  title,
  content,
  source = 'extension',
  sourceChatId = null,
  sourceMessageId = null,
  eventFingerprint = null,
}) {
  const existing = db.prepare('SELECT id, url, title, source, status, digest_id FROM articles WHERE url = ?').get(url);
  if (existing) {
    return { ...existing, duplicate: true };
  }

  const id = uuidv4();
  db.prepare(
    `INSERT INTO articles (
       id, url, title, content, source, source_chat_id, source_message_id, event_fingerprint
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    url,
    title || null,
    content || null,
    source,
    sourceChatId,
    sourceMessageId,
    eventFingerprint,
  );

  return { id, url, title, status: 'new', duplicate: false };
}

export function recordDuplicateArticle({
  url,
  title,
  content,
  source = 'railway-rss',
  eventFingerprint = null,
  duplicateOf,
  duplicateReason,
}) {
  const existing = db.prepare('SELECT id FROM articles WHERE url = ?').get(url);
  if (existing) return { id: existing.id, recorded: false };

  const id = uuidv4();
  db.prepare(
    `INSERT INTO articles (
       id, url, title, content, source, status, event_fingerprint, duplicate_of, duplicate_reason
     ) VALUES (?, ?, ?, ?, ?, 'duplicate', ?, ?, ?)`
  ).run(
    id,
    url,
    title || null,
    content || null,
    source,
    eventFingerprint,
    duplicateOf || null,
    duplicateReason || null,
  );
  return { id, recorded: true };
}

export function getNewArticles(limit = 50) {
  return db.prepare(
    'SELECT * FROM articles WHERE status = ? AND digest_id IS NULL ORDER BY created_at ASC LIMIT ?'
  ).all('new', limit);
}

export function getArticleCount(status) {
  if (status) {
    return db.prepare('SELECT COUNT(*) as count FROM articles WHERE status = ?').get(status).count;
  }
  return db.prepare('SELECT COUNT(*) as count FROM articles').get().count;
}

export function updateArticleStatus(id, status) {
  db.prepare(
    `UPDATE articles SET status = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(status, id);
}

export function updateArticleCommentary(id, commentary) {
  db.prepare(
    `UPDATE articles SET commentary = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(commentary, id);
}

export function assignArticlesToDigest(articleIds, digestId) {
  const stmt = db.prepare(
    `UPDATE articles SET digest_id = ?, status = 'used', updated_at = datetime('now') WHERE id = ?`
  );
  const transaction = db.transaction((ids) => {
    for (const id of ids) {
      stmt.run(digestId, id);
    }
  });
  transaction(articleIds);
}

export function createDigest({ date, part = 1, articlesCount = 0 }) {
  const id = uuidv4();
  // Auto-increment seq_number
  const maxSeq = db.prepare('SELECT COALESCE(MAX(seq_number), 0) as max FROM digests').get().max;
  db.prepare(
    `INSERT INTO digests (id, date, part, articles_count, seq_number) VALUES (?, ?, ?, ?, ?)`
  ).run(id, date, part, articlesCount, maxSeq + 1);
  return id;
}

export function updateDigest(id, fields) {
  const allowed = ['content', 'status', 'generation_log', 'published_at',
    'facebook_post_id', 'telegram_message_id', 'telegram_message_ids', 'publication_error',
    'youtube_post_id', 'articles_count', 'model', 'input_tokens', 'output_tokens', 'cost_usd'];
  const updates = [];
  const values = [];

  for (const [key, value] of Object.entries(fields)) {
    if (allowed.includes(key)) {
      updates.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (updates.length === 0) return;

  updates.push(`updated_at = datetime('now')`);
  values.push(id);

  db.prepare(`UPDATE digests SET ${updates.join(', ')} WHERE id = ?`).run(...values);
}

export function getDigest(id) {
  return db.prepare('SELECT * FROM digests WHERE id = ?').get(id);
}

export function getDigests(filters = {}) {
  let query = 'SELECT * FROM digests';
  const params = [];

  if (filters.status) {
    query += ' WHERE status = ?';
    params.push(filters.status);
  }

  query += ' ORDER BY created_at DESC';

  if (filters.limit) {
    query += ' LIMIT ?';
    params.push(filters.limit);
  }

  return db.prepare(query).all(...params);
}

export function getArticlesByDigestId(digestId) {
  return db.prepare(
    'SELECT * FROM articles WHERE digest_id = ? ORDER BY created_at ASC'
  ).all(digestId);
}

export function deleteArticle(id) {
  return db.prepare('DELETE FROM articles WHERE id = ?').run(id);
}
export function claimAutomationRun(runKey, trigger = 'n8n') {
  const existing = db.prepare('SELECT * FROM automation_runs WHERE run_key = ?').get(runKey);

  if (!existing) {
    const id = uuidv4();
    try {
      db.prepare(
        `INSERT INTO automation_runs (id, run_key, trigger, status) VALUES (?, ?, ?, 'running')`
      ).run(id, runKey, trigger);
      return { claimed: true, reason: 'started', run: getAutomationRun(id) };
    } catch (error) {
      // Two requests can race between SELECT and INSERT. The unique run_key is
      // the final arbiter, so return the winner instead of publishing twice.
      if (!/UNIQUE constraint failed: automation_runs\.run_key/.test(error.message)) throw error;
      const concurrent = db.prepare('SELECT * FROM automation_runs WHERE run_key = ?').get(runKey);
      return { claimed: false, reason: concurrent?.status || 'running', run: concurrent };
    }
  }

  if (existing.status === 'failed') {
    db.prepare(
      `UPDATE automation_runs
       SET status = 'running', attempts = attempts + 1, error = NULL,
           stage = 'started', degraded = 0, metrics_json = NULL,
           started_at = datetime('now'),
           completed_at = NULL, updated_at = datetime('now')
       WHERE id = ?`
    ).run(existing.id);
    return { claimed: true, reason: 'retry', run: getAutomationRun(existing.id) };
  }

  return { claimed: false, reason: existing.status, run: existing };
}

export function getAutomationRun(id) {
  return db.prepare('SELECT * FROM automation_runs WHERE id = ?').get(id);
}

export function getAutomationRunByKey(runKey) {
  return db.prepare('SELECT * FROM automation_runs WHERE run_key = ?').get(runKey);
}

export function getLatestAutomationRun() {
  return db.prepare('SELECT * FROM automation_runs ORDER BY updated_at DESC, rowid DESC LIMIT 1').get();
}

export function updateAutomationRun(id, fields) {
  const allowed = [
    'status', 'stage', 'degraded', 'metrics_json', 'digest_id',
    'telegram_message_ids', 'error', 'completed_at',
  ];
  const updates = [];
  const values = [];

  for (const [key, value] of Object.entries(fields)) {
    if (allowed.includes(key)) {
      updates.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (updates.length === 0) return;

  updates.push(`updated_at = datetime('now')`);
  values.push(id);
  db.prepare(`UPDATE automation_runs SET ${updates.join(', ')} WHERE id = ?`).run(...values);
}

export function getLatestPublishedDigest() {
  return db.prepare(
    `SELECT * FROM digests WHERE status = 'published' ORDER BY published_at DESC, created_at DESC LIMIT 1`
  ).get();
}

export function resetArticlesForRetry(articleIds) {
  if (!Array.isArray(articleIds) || articleIds.length === 0) return;

  const stmt = db.prepare(
    `UPDATE articles
     SET status = 'new', commentary = NULL, digest_id = NULL, updated_at = datetime('now')
     WHERE id = ?`
  );
  const transaction = db.transaction((ids) => ids.forEach((id) => stmt.run(id)));
  transaction(articleIds);
}

export function deleteDigestAndReleaseArticles(digestId) {
  const transaction = db.transaction((id) => {
    db.prepare(
      `UPDATE articles
       SET status = 'new', commentary = NULL, digest_id = NULL, updated_at = datetime('now')
       WHERE digest_id = ?`
    ).run(id);
    db.prepare('DELETE FROM digests WHERE id = ?').run(id);
  });
  transaction(digestId);
}
