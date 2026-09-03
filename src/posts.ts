import { all, one } from "./db";
import { normalizeBoard } from "./board";
import { postTextForBlock, safeRegex } from "./filters";
import { getBlockRules, getHighlightGroups } from "./rules";
import { runtimeSettings } from "./settings";
import type { Env, HomeTimings, PageData, Post, User } from "./types";

type PostScanRow = Pick<Post, "id" | "title" | "content_text" | "author" | "board_key" | "published_at">;

// Keep bound offsets well below SQLite/D1 integer limits while allowing ordinary page numbers.
const MAX_PAGE_OFFSET = 2_000_000_000;

function allowedByBlocks(post: Pick<Post, "title" | "content_text" | "author">, blocks: RegExp[]): boolean {
  const text = postTextForBlock(post);
  return !blocks.some((rule) => rule.test(text));
}

function postTextForSearch(post: Pick<Post, "title" | "content_text" | "author" | "board_key">): string {
  return `${post.title}\n${post.content_text}\n${post.author || ""}\n${post.board_key || ""}`;
}

function allowedBySearch(post: Pick<Post, "title" | "content_text" | "author" | "board_key">, queryRegex: RegExp | null): boolean {
  if (!queryRegex) return true;
  return queryRegex.test(postTextForSearch(post));
}

async function postsByIds(env: Env, user: User | null, ids: number[]): Promise<Post[]> {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const order = new Map(ids.map((id, index) => [id, index]));
  const args: unknown[] = [];
  let sql = "SELECT p.*, " + (user ? "CASE WHEN r.post_id IS NULL THEN 0 ELSE 1 END" : "0") + ` AS is_read FROM posts p `;
  if (user) {
    sql += "LEFT JOIN read_states r ON r.post_id = p.id AND r.user_id = ? ";
    args.push(user.id);
  }
  sql += `WHERE p.id IN (${placeholders})`;
  args.push(...ids);
  const posts = await all<Post>(env.DB.prepare(sql).bind(...args));
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
  const blocksStart = Date.now();
  const blocks = await getBlockRules(env, user);
  setTiming("blockRulesLoadMs", Date.now() - blocksStart);
  const blockRegexStart = Date.now();
  const blockRegexes = blocks.map((rule) => safeRegex(rule.pattern)).filter((rule): rule is RegExp => !!rule);
  setTiming("blockRegexCompileMs", Date.now() - blockRegexStart);
  const searchRegexStart = Date.now();
  const queryRegex = query ? safeRegex(query) : null;
  setTiming("searchRegexCompileMs", Date.now() - searchRegexStart);
  if (!query && blocks.length === 0) {
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
  const lastPagePostIds: number[] = [];
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
    const blockStart = Date.now();
    const blockAllowed = blockRegexes.length ? chunk.filter((post) => allowedByBlocks(post, blockRegexes)) : chunk;
    if (timings) timings.blockMatchMs = (timings.blockMatchMs || 0) + (Date.now() - blockStart);
    const searchStart = Date.now();
    const searchAllowed = queryRegex ? blockAllowed.filter((post) => allowedBySearch(post, queryRegex)) : blockAllowed;
    if (timings) timings.searchMatchMs = (timings.searchMatchMs || 0) + (Date.now() - searchStart);
    for (const post of searchAllowed) {
      if (matched >= start && matched < end) pagePostIds.push(post.id);
      lastPagePostIds.push(post.id);
      if (lastPagePostIds.length > pageSize) lastPagePostIds.shift();
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
  setTiming("limitedScan", 1);
  setTiming("hasNextPage", stoppedAtPageLimit ? 1 : 0);
  const dbPageStart = Date.now();
  const posts = await postsByIds(env, user, pagePostIds);
  setTiming("dbPageMs", Date.now() - dbPageStart);
  setTiming("totalMs", Date.now() - totalStart);
  return { posts, page, pageSize, board, query, syncError };
}

export async function markReadAndGetLink(env: Env, user: User | null, postId: number): Promise<string | null> {
  const post = await one<Post>(env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(postId));
  if (!post) return null;
  if (user) await env.DB.prepare("INSERT OR REPLACE INTO read_states (user_id, post_id, opened_at) VALUES (?, ?, datetime('now'))").bind(user.id, postId).run();
  return post.link;
}
