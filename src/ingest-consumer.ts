// Queue ingest consumer. One message carries pre-filtered RSS chunks; the
// consumer owns the expensive work the sync cron must not do: full parse,
// sanitize, text extraction, INSERT OR IGNORE, FTS indexing.
//
// Idempotency comes from posts.guid UNIQUE plus the delete+insert FTS batch, so
// replaying a message inserts nothing new and leaves the index unchanged. FTS
// repair also survives redelivery: after the INSERT we resolve every item's id
// by GUID and index it even when INSERT OR IGNORE reported changes=0, so a run
// terminated between INSERT and FTS is repaired by the retry. The consumer never
// touches the prune lease or db_prune_index_state.
import { all, nowIso } from "./db";
import { isValidIngestMessage, type IngestMessageV1 } from "./ingest-message";
import { parseChunkFull, parseChunkFullHtml } from "./rss";
import { indexPostForSearch, markSearchIndexRetryPending, recordSearchIndexError } from "./search";
import type { Env } from "./types";

export interface IngestProcessResult {
  ok: boolean;
  inserted: number;
  indexed: number;
  skipped: number;
  error?: string;
}

const INSERT_POST_SQL = "INSERT OR IGNORE INTO posts (guid, title, link, content_html, content_text, author, board_key, published_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";

// FTS failures do not roll back inserted posts and do not trigger a message
// retry; the posts are already committed and complete=0 makes the maintenance
// backfill repair them instead.
export async function processIngestMessage(env: Env, message: IngestMessageV1): Promise<IngestProcessResult> {
  if (!isValidIngestMessage(message)) {
    console.error(JSON.stringify({ event: "ingest_invalid_message" }));
    return { ok: true, inserted: 0, indexed: 0, skipped: 0 };
  }

  const parsedItems = [];
  const useRewriter = env.HTML_MODE === "rewriter";
  let skipped = 0;
  for (const entry of message.items) {
    const parsed = useRewriter ? await parseChunkFullHtml(entry.chunk, entry.guid) : parseChunkFull(entry.chunk, entry.guid);
    const { item } = parsed;
    if (!item.guid || !item.title || !item.link) {
      skipped += 1;
      console.warn(JSON.stringify({ event: "ingest_item_skipped", reason: "missing_guid_title_or_link" }));
      continue;
    }
    parsedItems.push(item);
  }
  if (parsedItems.length === 0) {
    return { ok: true, inserted: 0, indexed: 0, skipped };
  }

  const fetchedAt = nowIso();
  const statements = parsedItems.map((item) =>
    env.DB.prepare(INSERT_POST_SQL).bind(item.guid, item.title, item.link, item.contentHtml, item.contentText, item.author || null, item.board || null, item.publishedAt, fetchedAt)
  );
  const results = await env.DB.batch(statements);

  let inserted = 0;
  for (const result of results) {
    if (result && result.meta.changes) inserted += 1;
  }

  const placeholders = parsedItems.map(() => "?").join(", ");
  const rows = await all<{ id: number; guid: string; title: string; content_text: string }>(
    env.DB.prepare(`SELECT id, guid, title, content_text FROM posts WHERE guid IN (${placeholders})`).bind(...parsedItems.map((item) => item.guid))
  );
  const rowByGuid = new Map<string, { id: number; title: string; content_text: string }>();
  for (const row of rows) {
    if (!rowByGuid.has(row.guid)) rowByGuid.set(row.guid, row);
  }

  let indexed = 0;
  let indexFailures = 0;
  let firstIndexError: unknown = null;
  const indexedIds = new Set<number>();
  for (const item of parsedItems) {
    const row = rowByGuid.get(item.guid);
    if (row === undefined) {
      console.warn("ingest_post_id_missing", JSON.stringify({ guid: item.guid }));
      continue;
    }
    if (indexedIds.has(row.id)) continue;
    try {
      await indexPostForSearch(env, { id: row.id, title: row.title, content_text: row.content_text });
      indexedIds.add(row.id);
      indexed += 1;
    } catch (error) {
      // Stop after the first failure (mirrors the inline sync path): it bounds
      // the diagnostic writes to one pair and complete=0 lets the backfill
      // repair every post left unindexed here.
      indexFailures = 1;
      firstIndexError = error;
      break;
    }
  }
  if (firstIndexError !== null) {
    const errorRecorded = await recordSearchIndexError(env, firstIndexError);
    const retryMarked = await markSearchIndexRetryPending(env);
    if (!errorRecorded || !retryMarked) {
      // Without the complete=0 repair flag the unindexed posts would stay
      // unindexed forever, so the message must be retried instead of ACKed.
      console.error(JSON.stringify({ event: "ingest_index_failure_persist_failed", errorRecorded, retryMarked }));
      return { ok: false, inserted, indexed, skipped, error: "index_failure_persist_failed" };
    }
  }
  return {
    ok: true,
    inserted,
    indexed,
    skipped,
    ...(indexFailures > 0 ? { error: `index_failures:${indexFailures}` } : {})
  };
}
