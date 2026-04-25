import { all, one } from "./db";
import { normalizeBoard } from "./board";
import { postTextForBlock, safeRegex } from "./filters";
import type { BlockRule, Env, HighlightGroup, PageData, Post, User } from "./types";

export const pageSize = 50;

export async function getBlockRules(env: Env, user: User | null): Promise<BlockRule[]> {
  if (!user) return [];
  return all<BlockRule>(env.DB.prepare("SELECT * FROM block_rules WHERE user_id = ? ORDER BY id DESC").bind(user.id));
}

export async function getHighlightGroups(env: Env, user: User | null): Promise<HighlightGroup[]> {
  if (!user) return [];
  const rows = await all<{ id: number; user_id: number; name: string; color: string; pattern: string | null }>(env.DB.prepare(`
    SELECT hg.id, hg.user_id, hg.name, hg.color, hr.pattern
    FROM highlight_groups hg
    LEFT JOIN highlight_rules hr ON hr.group_id = hg.id
    WHERE hg.user_id = ?
    ORDER BY hg.id DESC, hr.id DESC
  `).bind(user.id));
  const byId = new Map<number, HighlightGroup>();
  for (const row of rows) {
    let group = byId.get(row.id);
    if (!group) {
      group = { id: row.id, user_id: row.user_id, name: row.name, color: row.color, patterns: [] };
      byId.set(row.id, group);
    }
    if (row.pattern) group.patterns.push(row.pattern);
  }
  return [...byId.values()];
}

function allowedByBlocks(post: Post, blocks: RegExp[]): boolean {
  const text = postTextForBlock(post);
  return !blocks.some((rule) => rule.test(text));
}

function postTextForSearch(post: Post): string {
  return `${post.title}\n${post.content_text}\n${post.author || ""}\n${post.board_key || ""}`;
}

function allowedBySearch(post: Post, queryRegex: RegExp | null): boolean {
  if (!queryRegex) return true;
  return queryRegex.test(postTextForSearch(post));
}

export async function queryPosts(env: Env, user: User | null, url: URL): Promise<PageData> {
  const board = normalizeBoard(url.searchParams.get("board"));
  const query = (url.searchParams.get("q") || "").trim();
  const urlPage = /\/page\/(\d+)/.exec(url.pathname)?.[1];
  const requestedPage = Math.max(1, Number(url.searchParams.get("page") || urlPage || "1") || 1);
  const blocks = await getBlockRules(env, user);
  const blockRegexes = blocks.map((rule) => safeRegex(rule.pattern)).filter((rule): rule is RegExp => !!rule);
  const queryRegex = query ? safeRegex(query) : null;
  if (!query && blocks.length === 0) {
    const where = board ? "WHERE board_key = ?" : "";
    const countArgs = board ? [board] : [];
    const total = (await one<{ count: number }>(env.DB.prepare(`SELECT COUNT(*) AS count FROM posts ${where}`).bind(...countArgs)))?.count || 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
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
    sql += "ORDER BY p.published_at DESC LIMIT ? OFFSET ?";
    args.push(pageSize, offset);
    const posts = await all<Post>(env.DB.prepare(sql).bind(...args));
    const syncError = total === 0 ? (await one<{ value: string }>(env.DB.prepare("SELECT value FROM sync_state WHERE key = 'last_sync_error'")))?.value || "" : "";
    return { posts, page, pageSize, totalPages, board, query, syncError };
  }

  const args: unknown[] = [];
  let sql = "SELECT p.*, " + (user ? "CASE WHEN r.post_id IS NULL THEN 0 ELSE 1 END" : "0") + " AS is_read FROM posts p ";
  if (user) sql += "LEFT JOIN read_states r ON r.post_id = p.id AND r.user_id = ? ";
  if (user) args.push(user.id);
  if (board) {
    sql += "WHERE p.board_key = ? ";
    args.push(board);
  }
  sql += "ORDER BY p.published_at DESC LIMIT ? OFFSET ?";
  const chunkSize = 500;
  let matched = 0;
  const pagePosts: Post[] = [];
  const lastPagePosts: Post[] = [];
  const start = (requestedPage - 1) * pageSize;
  const end = start + pageSize;
  for (let offset = 0; ; offset += chunkSize) {
    const chunk = await all<Post>(env.DB.prepare(sql).bind(...args, chunkSize, offset));
    if (!chunk.length) break;
    for (const post of chunk) {
      if (!allowedByBlocks(post, blockRegexes) || !allowedBySearch(post, queryRegex)) continue;
      if (matched >= start && matched < end) pagePosts.push(post);
      lastPagePosts.push(post);
      if (lastPagePosts.length > pageSize) lastPagePosts.shift();
      matched++;
    }
    if (chunk.length < chunkSize) break;
  }
  const totalPages = Math.max(1, Math.ceil(matched / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const syncError = matched === 0 ? (await one<{ value: string }>(env.DB.prepare("SELECT value FROM sync_state WHERE key = 'last_sync_error'")))?.value || "" : "";
  return { posts: page === requestedPage ? pagePosts : lastPagePosts, page, pageSize, totalPages, board, query, syncError };
}

export async function markReadAndGetLink(env: Env, user: User | null, postId: number): Promise<string | null> {
  const post = await one<Post>(env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(postId));
  if (!post) return null;
  if (user) await env.DB.prepare("INSERT OR REPLACE INTO read_states (user_id, post_id, opened_at) VALUES (?, ?, datetime('now'))").bind(user.id, postId).run();
  return post.link;
}
