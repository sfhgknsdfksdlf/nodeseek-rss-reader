CREATE TABLE IF NOT EXISTS rss_fetch_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  method TEXT NOT NULL,
  outcome TEXT NOT NULL,
  status INTEGER,
  status_text TEXT,
  error TEXT,
  preview TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rss_fetch_attempts_created_at ON rss_fetch_attempts(created_at);
CREATE INDEX IF NOT EXISTS idx_rss_fetch_attempts_source_created_at ON rss_fetch_attempts(source, created_at);
CREATE INDEX IF NOT EXISTS idx_rss_fetch_attempts_method_outcome_created_at ON rss_fetch_attempts(method, outcome, created_at);
