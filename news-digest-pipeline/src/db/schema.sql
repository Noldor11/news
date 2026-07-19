CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  url TEXT UNIQUE NOT NULL,
  title TEXT,
  content TEXT,
  source TEXT DEFAULT 'extension',
  status TEXT DEFAULT 'new',
  commentary TEXT,
  digest_id TEXT,
  fetch_error TEXT,
  source_chat_id TEXT,
  source_message_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (digest_id) REFERENCES digests(id)
);

CREATE TABLE IF NOT EXISTS digests (
  id TEXT PRIMARY KEY,
  date TEXT,
  part INTEGER DEFAULT 1,
  seq_number INTEGER,
  articles_count INTEGER DEFAULT 0,
  content TEXT,
  status TEXT DEFAULT 'draft',
  generation_log TEXT,
  model TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_usd REAL,
  published_at TEXT,
  facebook_post_id TEXT,
  telegram_message_id TEXT,
  telegram_message_ids TEXT,
  publication_error TEXT,
  youtube_post_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  run_key TEXT UNIQUE NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'n8n',
  status TEXT NOT NULL DEFAULT 'running',
  stage TEXT NOT NULL DEFAULT 'started',
  attempts INTEGER NOT NULL DEFAULT 1,
  degraded INTEGER NOT NULL DEFAULT 0,
  metrics_json TEXT,
  digest_id TEXT,
  telegram_message_ids TEXT,
  error TEXT,
  started_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (digest_id) REFERENCES digests(id)
);
CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status);
CREATE INDEX IF NOT EXISTS idx_articles_url ON articles(url);
CREATE INDEX IF NOT EXISTS idx_articles_digest_id ON articles(digest_id);
CREATE INDEX IF NOT EXISTS idx_digests_date ON digests(date);
CREATE INDEX IF NOT EXISTS idx_digests_status ON digests(status);
CREATE INDEX IF NOT EXISTS idx_automation_runs_status ON automation_runs(status);
