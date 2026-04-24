import { all, one } from "./db";
import { normalizeBoard } from "./board";
import { postTextForBlock, regexMatches } from "./filters";
import type { BlockRule, Env, HighlightGroup, PageData, Post, User } from "./types";

export const pageSize = 50;

export async function getBlockRules(env: Env, user: User | null): Promise<BlockRule[]> {
  if (!user) return [];
  return all<BlockRule>(env.DB.prepare("SELECT * FROM block_rules WHERE user_id = ? ORDER BY id DESC").bind(user.id));
}

export async function getHighlightGroups(env: Env, user: User | null): Promise<HighlightGroup[]> {
  if (!user) return [];
  const groups = await all<Omit<HighlightGroup, "patterns">>(env.DB.prepare("SELECT id, user_id, name, color FROM highlight_groups WHERE user_id = ? ORDER BY id DESC").bind(user.id));
  const result: HighlightGroup[] = [];
  for (const group of groups) {
    const rules = await all<{ pattern: string }>(env.DB.prepare("SELECT pattern FROM highlight_rules WHERE group_id = ? ORDER BY id DESC").bind(group.id));
    result.push({ ...group, patterns: rules.map((r) => r.pattern) });
  }
  return result;
}

function allowedByBlocks(post: Post, blocks: BlockRule[]): boolean {
  const text = postTextForBlock(post);
  return !blocks.some((rule) => regexMatches(rule.pattern, text));
}

function allowedBySearch(post: Post, query: string): boolean {
  if (!query) return true;
  return regexMatches(query, `${post.title}\n${post.content_text}\n${post.author || ""}\n${post.board_key || ""}`);
}

export async function queryPosts(env: Env, user: User | null, url: URL): Promise<PageData> {
  const board = normalizeBoard(url.searchParams.get("board"));
  const query = (url.searchParams.get("q") || "").trim();
  const urlPage = /\/page\/(\d+)/.exec(url.pathname)?.[1];
  const requestedPage = Math.max(1, Number(url.searchParams.get("page") || urlPage || "1") || 1);
  const blocks = await getBlockRules(env, user);
  const args: unknown[] = [];
  let sql = "SELECT p.*, " + (user ? "CASE WHEN r.post_id IS NULL THEN 0 ELSE 1 END" : "0") + " AS is_read FROM posts p ";
  if (user) sql += "LEFT JOIN read_states r ON r.post_id = p.id AND r.user_id = ? ";
  if (user) args.push(user.id);
  if (board) {
    sql += "WHERE p.board_key = ? ";
    args.push(board);
  }
  sql += "ORDER BY p.published_at DESC LIMIT 1000";
  const rows = await all<Post>(env.DB.prepare(sql).bind(...args));
  const filtered = rows.filter((post) => allowedByBlocks(post, blocks) && allowedBySearch(post, query));
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const page = Math.min(requestedPage, totalPages);
  return { posts: filtered.slice((page - 1) * pageSize, page * pageSize), page, pageSize, totalPages, board, query };
}

export async function markReadAndGetLink(env: Env, user: User | null, postId: number): Promise<string | null> {
  const post = await one<Post>(env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(postId));
  if (!post) return null;
  if (user) await env.DB.prepare("INSERT OR REPLACE INTO read_states (user_id, post_id, opened_at) VALUES (?, ?, datetime('now'))").bind(user.id, postId).run();
  return post.link;
}
