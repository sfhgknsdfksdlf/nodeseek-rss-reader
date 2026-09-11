import { all, nowIso, one } from "./db";
import type { Env, Post } from "./types";

export const SEARCH_QUERY_MAX_UNITS = 200;
export const SEARCH_MAX_TERMS = 10;
export const SEARCH_BACKFILL_BATCH = 30;
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
  const codepoints = Array.from(text);
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index + 1 < codepoints.length; index += 1) {
    const first = codepoints[index];
    const second = codepoints[index + 1];
    if (first === undefined || second === undefined) continue;
    const token = encodeCodepoint(first) + encodeCodepoint(second);
    if (!seen.has(token)) {
      seen.add(token);
      tokens.push(token);
    }
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

export async function recordSearchIndexError(env: Env, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const timestamp = nowIso();
  try {
    await env.DB.prepare("INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES ('last_search_index_error', ?, ?)")
      .bind(`${timestamp} ${message}`.slice(0, 500), timestamp)
      .run();
  } catch (diagnosticError) {
    const diagnosticMessage = diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError);
    console.error("Search index diagnostic failed", diagnosticMessage);
  }
}

export async function markSearchIndexRetryPending(env: Env): Promise<void> {
  try {
    await env.DB.prepare("UPDATE search_index_state SET complete = 0, updated_at = ? WHERE id = 1").bind(nowIso()).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Search index retry-flag update failed", message);
  }
}

export async function backfillSearchIndexes(env: Env): Promise<void> {
  const state = await one<{ last_post_id: number; complete: number }>(env.DB.prepare("SELECT last_post_id, complete FROM search_index_state WHERE id = 1"));
  if (state?.complete === 1) return;
  const lastPostId = state?.last_post_id ?? 0;
  const posts = await all<Pick<Post, "id" | "title" | "content_text">>(
    env.DB.prepare("SELECT id, title, content_text FROM posts WHERE id > ? ORDER BY id ASC LIMIT ?").bind(lastPostId, SEARCH_BACKFILL_BATCH)
  );
  if (!posts.length) {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO search_index_state (id, last_post_id, complete, updated_at) VALUES (1, ?, 1, ?) ON CONFLICT(id) DO UPDATE SET complete = 1, updated_at = excluded.updated_at").bind(lastPostId, nowIso())
    ]);
    return;
  }
  const maxId = posts[posts.length - 1]?.id ?? lastPostId;
  const statements = posts.flatMap((post) => indexStatements(env, post));
  statements.push(
    env.DB.prepare("INSERT INTO search_index_state (id, last_post_id, complete, updated_at) VALUES (1, ?, 0, ?) ON CONFLICT(id) DO UPDATE SET last_post_id = excluded.last_post_id, complete = 0, updated_at = excluded.updated_at").bind(maxId, nowIso())
  );
  await env.DB.batch(statements);
}
