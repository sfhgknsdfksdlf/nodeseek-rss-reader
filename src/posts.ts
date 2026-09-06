import { all, one } from "./db";
import { normalizeBoard } from "./board";
import { safeRegex } from "./filters";
import { runtimeSettings } from "./settings";
import type { Env, HomeTimings, PageData, Post, User } from "./types";

type PostScanRow = Pick<Post, "id" | "title" | "content_text" | "author" | "board_key" | "published_at">;

// Keep bound offsets well below SQLite/D1 integer limits while allowing ordinary page numbers.
const MAX_PAGE_OFFSET = 2_000_000_000;

function postTextForSearch(post: Pick<Post, "title" | "content_text">): string {
  return `${post.title}\n${post.content_text}`;
}

function allowedBySearch(post: Pick<Post, "title" | "content_text">, queryRegex: RegExp | null): boolean {
  if (!queryRegex) return true;
  return queryRegex.test(postTextForSearch(post));
}

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
  const pageSize = (await runtimeSettings(env)).pageSize;
  const urlPage = /\/page\/(\d+)/.exec(url.pathname)?.[1];
  const rawPage = url.searchParams.get("page") || urlPage || "1";
  const parsedPage = Number(rawPage);
  const maxPage = Math.floor(MAX_PAGE_OFFSET / pageSize) + 1;
  const requestedPage = Number.isSafeInteger(parsedPage) ? Math.min(maxPage, Math.max(1, parsedPage)) : 1;
  const setTiming = (key: keyof NonNullable<HomeTimings["queryPosts"]>, value: number) => {
    if (timings) timings[key] = value;
  };
  const searchRegexStart = Date.now();
  const queryRegex = query ? safeRegex(query) : null;
  setTiming("searchRegexCompileMs", Date.now() - searchRegexStart);
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

  const chunkSize = 1000;
  let matched = 0;
  const pagePostIds: number[] = [];
  const start = (requestedPage - 1) * pageSize;
  const end = start + pageSize;
  let stoppedAtPageLimit = false;
  let scannedChunks = 0;
  const scanStart = Date.now();
  let cursorPublishedAt: string | null = null;
  let cursorId: number | null = null;
  scan: for (;;) {
    scannedChunks++;
    const where: string[] = [];
    const args: unknown[] = [];
    if (board) {
      where.push("board_key = ?");
      args.push(board);
    }
    if (cursorPublishedAt !== null && cursorId !== null) {
      where.push("(published_at < ? OR (published_at = ? AND id < ?))");
      args.push(cursorPublishedAt, cursorPublishedAt, cursorId);
    }
    const sql = `SELECT id, title, content_text, author, board_key, published_at FROM posts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY published_at DESC, id DESC LIMIT ?`;
    const chunk = await all<PostScanRow>(env.DB.prepare(sql).bind(...args, chunkSize));
    if (!chunk.length) break;
    const searchStart = Date.now();
    const searchAllowed = queryRegex ? chunk.filter((post) => allowedBySearch(post, queryRegex)) : chunk;
    if (timings) timings.searchMatchMs = (timings.searchMatchMs || 0) + (Date.now() - searchStart);
    for (const post of searchAllowed) {
      if (matched >= start && matched < end) pagePostIds.push(post.id);
      matched++;
      if (matched >= end) {
        stoppedAtPageLimit = true;
        break scan;
      }
    }
    const last = chunk[chunk.length - 1];
    cursorPublishedAt = last.published_at;
    cursorId = last.id;
    if (chunk.length < chunkSize) break;
  }
  setTiming("scanMs", Date.now() - scanStart);
  const page = requestedPage;
  const syncError = matched === 0 ? (await one<{ value: string }>(env.DB.prepare("SELECT value FROM sync_state WHERE key = 'last_sync_error'")))?.value || "" : "";
  setTiming("scannedChunks", scannedChunks);
  setTiming("matchedPosts", matched);
  setTiming("hasNextPage", stoppedAtPageLimit ? 1 : 0);
  const dbPageStart = Date.now();
  const posts = await postsByIds(env, user, pagePostIds);
  setTiming("dbPageMs", Date.now() - dbPageStart);
  setTiming("totalMs", Date.now() - totalStart);
  return { posts, page, pageSize, board, query, syncError };
}
