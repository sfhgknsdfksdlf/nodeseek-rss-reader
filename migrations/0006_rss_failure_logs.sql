CREATE TABLE IF NOT EXISTS rss_fetch_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  method TEXT NOT NULL,
  status INTEGER,
  status_text TEXT,
  error TEXT,
  preview TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rss_fetch_failures_created_at ON rss_fetch_failures(created_at);
CREATE INDEX IF NOT EXISTS idx_rss_fetch_failures_source_created_at ON rss_fetch_failures(source, created_at);
