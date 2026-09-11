import { all, one } from "./db";
import { normalizeBoard } from "./board";
import { bigramTokenForTerm, codepointLength, ftsPhrase, parseSearchQuery } from "./search";
import { runtimeSettings } from "./settings";
import type { Env, HomeTimings, PageData, Post, User } from "./types";

// Keep bound offsets well below SQLite/D1 integer limits while allowing ordinary page numbers.
const MAX_PAGE_OFFSET = 2_000_000_000;

async function postsByIds(env: Env, user: User | null, ids: number[]): Promise<Post[]> {
  if (!ids.length) return [];
  const order = new Map(ids.map((id, index) => [id, index]));
  const chunkSize = user ? 99 : 100;
  const posts: Post[] = [];
  for (let offset = 0; offset < ids.length; offset += chunkSize) {
    const idChunk = ids.slice(offset, offset + chunkSize);
    const placeholders = idChunk.map(() => "?").join(",");
    const args: unknown[] = [];
    let sql = "SELECT p.*, " + (user ? "CASE WHEN r.post_id IS NULL THEN 0 ELSE 1 END" : "0") + ` AS is_read FROM posts p `;
    if (user) {
      sql += "LEFT JOIN read_states r ON r.post_id = p.id AND r.user_id = ? ";
      args.push(user.id);
    }
    sql += `WHERE p.id IN (${placeholders})`;
    args.push(...idChunk);
    posts.push(...await all<Post>(env.DB.prepare(sql).bind(...args)));
  }
  return posts.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

export async function queryPosts(env: Env, user: User | null, url: URL, timings?: HomeTimings["queryPosts"]): Promise<PageData> {
  const totalStart = Date.now();
  const board = normalizeBoard(url.searchParams.get("board"));
  const query = (url.searchParams.get("q") || "").trim();
  const settings = await runtimeSettings(env);
  const pageSize = settings.pageSize;
  const urlPage = /\/page\/(\d+)/.exec(url.pathname)?.[1];
  const rawPage = url.searchParams.get("page") || urlPage || "1";
  const parsedPage = Number(rawPage);
  const maxPage = Math.floor(MAX_PAGE_OFFSET / pageSize) + 1;
  const requestedPage = Number.isSafeInteger(parsedPage) ? Math.min(maxPage, Math.max(1, parsedPage)) : 1;
  const setTiming = (key: keyof NonNullable<HomeTimings["queryPosts"]>, value: number) => {
    if (timings) timings[key] = value;
  };
  if (!query) {
    const page = requestedPage;
    const offset = (page - 1) * pageSize;
    const args: unknown[] = [];
    let sql = "SELECT p.*, " + (user ? "CASE WHEN r.post_id IS NULL THEN 0 ELSE 1 END" : "0") + " AS is_read FROM posts p ";
    if (user) {
      sql += "LEFT JOIN read_states r ON r.post_id = p.id AND r.user_id = ? ";
      args.push(user.id);
    }
    if (board) {
      sql += "WHERE p.board_key = ? ";
      args.push(board);
    }
    sql += "ORDER BY p.published_at DESC, p.id DESC LIMIT ? OFFSET ?";
    args.push(pageSize, offset);
    const dbPageStart = Date.now();
    const posts = await all<Post>(env.DB.prepare(sql).bind(...args));
    setTiming("dbPageMs", Date.now() - dbPageStart);
    const syncError = posts.length === 0 ? (await one<{ value: string }>(env.DB.prepare("SELECT value FROM sync_state WHERE key = 'last_sync_error'")))?.value || "" : "";
    setTiming("totalMs", Date.now() - totalStart);
    return { posts, page, pageSize, board, query, syncError };
  }

  const searchParseStart = Date.now();
  const parsedResult = parseSearchQuery(query);
  setTiming("searchParseMs", Date.now() - searchParseStart);
  if (!parsedResult.ok) {
    setTiming("totalMs", Date.now() - totalStart);
    return { posts: [], page: requestedPage, pageSize, board, query, searchError: parsedResult.message };
  }
  const { terms, anchorIndex, anchorKind } = parsedResult.parsed;
  const anchor = terms[anchorIndex] ?? "";
  const otherTerms = terms.filter((_, index) => index !== anchorIndex);
  const anchorTable = anchorKind === "trigram" ? "posts_search_trigram" : "posts_search_bigrams";
  const anchorValue = anchorKind === "trigram" ? anchor : bigramTokenForTerm(anchor);
  const ctes = [`candidates AS (SELECT p.id, p.title, p.content_text, p.published_at FROM ${anchorTable} INNER JOIN posts p ON p.id = ${anchorTable}.rowid WHERE ${anchorTable} MATCH ?${board ? " AND p.board_key = ?" : ""})`];
  const scoreParts = ["1"];
  const args: unknown[] = [ftsPhrase(anchorValue)];
  if (board) args.push(board);
  for (let index = 0; index < otherTerms.length; index += 1) {
    const term = otherTerms[index];
    if (term === undefined) continue;
    const length = codepointLength(term);
    if (length >= 2) {
      const table = length >= 3 ? "posts_search_trigram" : "posts_search_bigrams";
      const value = length >= 3 ? term : bigramTokenForTerm(term);
      ctes.push(`term_${index} AS (SELECT rowid FROM ${table} WHERE ${table} MATCH ?)`);
      scoreParts.push(`CASE WHEN EXISTS (SELECT 1 FROM term_${index} WHERE term_${index}.rowid = candidates.id) THEN 1 ELSE 0 END`);
      args.push(ftsPhrase(value));
    } else {
      scoreParts.push("CASE WHEN instr(lower(candidates.title), ?) > 0 OR instr(lower(candidates.content_text), ?) > 0 THEN 1 ELSE 0 END");
      args.push(term, term);
    }
  }
  args.push(settings.searchResultLimit);
  const searchQueryStart = Date.now();
  const ranked = await all<{ id: number }>(env.DB.prepare(`WITH ${ctes.join(", ")} SELECT candidates.id, (${scoreParts.join(" + ")}) AS score FROM candidates ORDER BY score DESC, candidates.published_at DESC, candidates.id DESC LIMIT ?`).bind(...args));
  const state = await one<{ complete: number }>(env.DB.prepare("SELECT complete FROM search_index_state WHERE id = 1"));
  setTiming("searchQueryMs", Date.now() - searchQueryStart);
  const dbPageStart = Date.now();
  const posts = await postsByIds(env, user, ranked.map((row) => row.id));
  setTiming("dbPageMs", Date.now() - dbPageStart);
  setTiming("totalMs", Date.now() - totalStart);
  const syncError = posts.length === 0 ? (await one<{ value: string }>(env.DB.prepare("SELECT value FROM sync_state WHERE key = 'last_sync_error'")))?.value || "" : "";
  return { posts, page: requestedPage, pageSize, board, query, search: { terms, anchor, anchorKind, building: state?.complete !== 1 }, syncError };
}
