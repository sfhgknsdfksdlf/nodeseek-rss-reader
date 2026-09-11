-- Bounded, resumable search-index schema for literal keyword search.
-- Both FTS5 tables are contentless: they store only the inverted index, and
-- rows are written/deleted at runtime under rowid = posts.id by the explicit
-- indexer and backfill. No backfill happens here on purpose.
CREATE VIRTUAL TABLE IF NOT EXISTS posts_search_trigram USING fts5(
  body,
  tokenize='trigram',
  content='',
  contentless_delete=1
);

-- tok holds a space-separated string of fixed-width hex bigram tokens
-- (deterministic adjacent-codepoint encoding) built by src/search.ts.
CREATE VIRTUAL TABLE IF NOT EXISTS posts_search_bigrams USING fts5(
  tok,
  content='',
  contentless_delete=1
);

-- Singleton cursor for the incremental indexer/backfill:
-- last_post_id = highest posts.id indexed so far; complete = 1 only after a
-- backfill pass finds no more unindexed rows.
CREATE TABLE IF NOT EXISTS search_index_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_post_id INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO search_index_state (id, last_post_id, complete, updated_at)
VALUES (1, 0, 0, '2026-09-10T00:00:00.000Z');
