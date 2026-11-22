import { all, nowIso, one } from "./db";
import { budgetRemaining, consumeQuery } from "./query-budget";
import type { QueryBudget } from "./query-budget";
import type { Env, Post } from "./types";

export const SEARCH_QUERY_MAX_UNITS = 200;
export const SEARCH_MAX_TERMS = 10;
export const SEARCH_BACKFILL_BATCH = 20;
export const SEARCH_SHORT_INPUT_MESSAGE = "请至少输入一个两字及以上的关键词";

export type SearchAnchorKind = "trigram" | "bigram";

export interface ParsedSearchQuery {
  raw: string;
  terms: string[];
  anchorIndex: number;
  anchorKind: SearchAnchorKind;
}

export type SearchParseResult =
  | { ok: true; parsed: ParsedSearchQuery }
  | {
    ok: false;
    reason: "empty" | "too-long" | "too-many-terms" | "no-two-codepoint-term";
    message: string;
  };

export function codepointLength(s: string): number {
  return Array.from(s).length;
}

export function asciiLower(s: string): string {
  let lowered = "";
  for (let index = 0; index < s.length; index += 1) {
    const unit = s.charCodeAt(index);
    lowered += unit >= 0x41 && unit <= 0x5a ? String.fromCharCode(unit + 0x20) : s[index];
  }
  return lowered;
}

export function parseSearchQuery(input: string | null | undefined): SearchParseResult {
  const raw = (input ?? "").trim();
  if (!raw) {
    return { ok: false, reason: "empty", message: SEARCH_SHORT_INPUT_MESSAGE };
  }
  if (raw.length > SEARCH_QUERY_MAX_UNITS) {
    return { ok: false, reason: "too-long", message: "搜索关键词过长（最多 200 字符）" };
  }

  const terms: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/\s+/)) {
    const term = asciiLower(part);
    if (!seen.has(term)) {
      seen.add(term);
      terms.push(term);
    }
  }
  if (terms.length > SEARCH_MAX_TERMS) {
    return { ok: false, reason: "too-many-terms", message: "搜索关键词过多（最多 10 个）" };
  }

  let anchorIndex = -1;
  let anchorLength = 0;
  for (let index = 0; index < terms.length; index += 1) {
    const term = terms[index];
    if (term === undefined) continue;
    const length = codepointLength(term);
    if (length >= 3 && length > anchorLength) {
      anchorIndex = index;
      anchorLength = length;
    }
  }
  if (anchorIndex >= 0) {
    return { ok: true, parsed: { raw, terms, anchorIndex, anchorKind: "trigram" } };
  }

  anchorIndex = terms.findIndex((term) => codepointLength(term) === 2);
  if (anchorIndex < 0) {
    return { ok: false, reason: "no-two-codepoint-term", message: SEARCH_SHORT_INPUT_MESSAGE };
  }
  return { ok: true, parsed: { raw, terms, anchorIndex, anchorKind: "bigram" } };
}

function encodeCodepoint(codepoint: string): string {
  const value = codepoint.codePointAt(0);
  return (value ?? 0).toString(16).padStart(6, "0");
}

export function bigramTokens(text: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  let previousHex: string | null = null;
  for (const codepoint of text) {
    const currentHex = encodeCodepoint(codepoint);
    if (previousHex !== null) {
      const token = previousHex + currentHex;
      if (!seen.has(token)) {
        seen.add(token);
        tokens.push(token);
      }
    }
    previousHex = currentHex;
  }
  return tokens;
}

export function bigramTokenForTerm(term: string): string {
  return bigramTokens(term)[0] ?? "";
}

export function trigramContent(title: string, contentText: string): string {
  return asciiLower(`${title}\n${contentText}`);
}

/** Returns an FTS phrase that callers must pass to D1 as a bound parameter, never concatenate into SQL. */
export function ftsPhrase(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

function indexStatements(env: Env, post: Pick<Post, "id" | "title" | "content_text">): D1PreparedStatement[] {
  const content = trigramContent(post.title, post.content_text);
  return [
    env.DB.prepare("DELETE FROM posts_search_trigram WHERE rowid = ?").bind(post.id),
    env.DB.prepare("DELETE FROM posts_search_bigrams WHERE rowid = ?").bind(post.id),
    env.DB.prepare("INSERT INTO posts_search_trigram(rowid, body) VALUES (?, ?)").bind(post.id, content),
    env.DB.prepare("INSERT INTO posts_search_bigrams(rowid, tok) VALUES (?, ?)").bind(post.id, bigramTokens(content).join(" "))
  ];
}

export async function indexPostForSearch(env: Env, post: Pick<Post, "id" | "title" | "content_text">): Promise<void> {
  await env.DB.batch(indexStatements(env, post));
}

/**
 * Indexes every new post in one D1 batch. The whole FTS write set rolls back
 * together on failure, so callers keep the inserted posts and let `complete=0`
 * drive the resumable backfill instead of indexing per post.
 */
export async function indexPostsForSearch(env: Env, posts: Array<Pick<Post, "id" | "title" | "content_text">>): Promise<void> {
  const statements = posts.flatMap((post) => indexStatements(env, post));
  if (!statements.length) return;
  await env.DB.batch(statements);
}

export async function recordSearchIndexError(env: Env, error: unknown, budget?: QueryBudget): Promise<boolean> {
  if (budget) {
    // The diagnostic is optional telemetry: without headroom, skip the write
    // instead of crossing the platform query limit or double-charging callers
    // that already reserved it in their prefix estimate.
    if (budgetRemaining(budget) < 1) {
      console.error("Search index diagnostic skipped: query budget exhausted");
      return false;
    }
    consumeQuery(budget);
  }
  const message = error instanceof Error ? error.message : String(error);
  const timestamp = nowIso();
  try {
    await env.DB.prepare("INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES ('last_search_index_error', ?, ?)")
      .bind(`${timestamp} ${message}`.slice(0, 500), timestamp)
      .run();
    return true;
  } catch (diagnosticError) {
    const diagnosticMessage = diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError);
    console.error("Search index diagnostic failed", diagnosticMessage);
    return false;
  }
}

export async function markSearchIndexRetryPending(env: Env): Promise<boolean> {
  try {
    await env.DB.prepare("UPDATE search_index_state SET complete = 0, updated_at = ? WHERE id = 1").bind(nowIso()).run();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Search index retry-flag update failed", message);
    return false;
  }
}

export interface SearchBackfillResult {
  indexed: number;
  complete: boolean;
  lastPostId: number;
}

/**
 * Indexes one resumable batch of posts.
 *
 * `batchSize` bounds the SELECT and therefore the cursor advance: the same
 * value drives the post page and the `last_post_id` update, so a caller using
 * a smaller batch (the maintenance cron uses 5) keeps the exact same
 * checkpoint/complete semantics. Callers that omit it keep the 20-post cron
 * backfill used by the inline sync path.
 */
export async function backfillSearchIndexes(env: Env, batchSize: number = SEARCH_BACKFILL_BATCH): Promise<SearchBackfillResult> {
  const state = await one<{ last_post_id: number; complete: number }>(env.DB.prepare("SELECT last_post_id, complete FROM search_index_state WHERE id = 1"));
  if (state?.complete === 1) return { indexed: 0, complete: true, lastPostId: state?.last_post_id ?? 0 };
  const lastPostId = state?.last_post_id ?? 0;
  const posts = await all<Pick<Post, "id" | "title" | "content_text">>(
    env.DB.prepare("SELECT id, title, content_text FROM posts WHERE id > ? ORDER BY id ASC LIMIT ?").bind(lastPostId, batchSize)
  );
  if (!posts.length) {
    // Completion is conditional on the exact checkpoint we read and on no posts
    // existing past it. A concurrent consumer write advances last_post_id or
    // inserts a post, so changes stays 0 and this pass must not clobber the
    // consumer's complete=0 repair flag.
    const completed = await env.DB.prepare(
      "UPDATE search_index_state SET complete = 1, updated_at = ? WHERE id = 1 AND last_post_id = ? AND NOT EXISTS (SELECT 1 FROM posts WHERE id > ?)"
    ).bind(nowIso(), lastPostId, lastPostId).run();
    const isComplete = completed.meta.changes === 1;
    return { indexed: 0, complete: isComplete, lastPostId };
  }
  const maxId = posts[posts.length - 1]?.id ?? lastPostId;
  const statements = posts.flatMap((post) => indexStatements(env, post));
  statements.push(
    env.DB.prepare("INSERT INTO search_index_state (id, last_post_id, complete, updated_at) VALUES (1, ?, 0, ?) ON CONFLICT(id) DO UPDATE SET last_post_id = excluded.last_post_id, complete = 0, updated_at = excluded.updated_at").bind(maxId, nowIso())
  );
  await env.DB.batch(statements);
  return { indexed: posts.length, complete: false, lastPostId: maxId };
}
