import { all, nowIso, one } from "./db";
import { normalizeBoard } from "./board";
import { sanitizePostHtml, stripHtml } from "./filters";
import type { Env, Post } from "./types";

interface RssItem {
  guid: string;
  title: string;
  link: string;
  contentHtml: string;
  contentText: string;
  author: string;
  board: string;
  publishedAt: string;
}

function textBetween(xml: string, tags: string[]): string {
  for (const tag of tags) {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
    const match = re.exec(xml);
    if (match) return decodeXml(match[1].replace(/^<!\[CDATA\[|\]\]>$/g, "").trim());
  }
  return "";
}

function attrLink(xml: string): string {
  const href = /<link\b[^>]*href=["']([^"']+)["'][^>]*>/i.exec(xml)?.[1];
  if (href) return decodeXml(href);
  return textBetween(xml, ["link"]);
}

function decodeXml(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function parseItems(xml: string): RssItem[] {
  const chunks = [...xml.matchAll(/<item[\s\S]*?<\/item>|<entry[\s\S]*?<\/entry>/gi)].map((m) => m[0]);
  return chunks.map((chunk) => {
    const title = textBetween(chunk, ["title"]);
    const link = attrLink(chunk);
    const guid = textBetween(chunk, ["guid", "id"]) || link || title;
    const contentRaw = textBetween(chunk, ["content:encoded", "content", "description", "summary"]);
    const contentHtml = sanitizePostHtml(contentRaw);
    const author = textBetween(chunk, ["dc:creator", "author", "name"]);
    const board = normalizeBoard(textBetween(chunk, ["category"]));
    const dateRaw = textBetween(chunk, ["pubDate", "published", "updated"]);
    const date = new Date(dateRaw);
    return {
      guid,
      title,
      link,
      contentHtml,
      contentText: stripHtml(contentHtml || contentRaw),
      author,
      board,
      publishedAt: Number.isNaN(date.getTime()) ? nowIso() : date.toISOString()
    };
  }).filter((item) => item.guid && item.title && item.link);
}

export async function syncRss(env: Env): Promise<{ inserted: number; firstSync: boolean }> {
  const rssUrl = env.RSS_URL || "https://rss.nodeseek.com/";
  const res = await fetch(rssUrl, { headers: { "user-agent": "NodeSeek RSS Reader/1.0" } });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
  const xml = await res.text();
  const items = parseItems(xml);
  const first = !(await one<{ value: string }>(env.DB.prepare("SELECT value FROM sync_state WHERE key = 'first_sync_done'")));
  let inserted = 0;
  for (const item of items) {
    const result = await env.DB.prepare("INSERT OR IGNORE INTO posts (guid, title, link, content_html, content_text, author, board_key, published_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(item.guid, item.title, item.link, item.contentHtml, item.contentText, item.author || null, item.board || null, item.publishedAt, nowIso())
      .run();
    if (result.meta.changes) inserted++;
  }
  await env.DB.prepare("INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES ('first_sync_done', '1', ?), ('last_sync_at', ?, ?)").bind(nowIso(), nowIso(), nowIso()).run();
  return { inserted, firstSync: first };
}

export async function latestUnpushedPosts(env: Env): Promise<Post[]> {
  return all<Post>(env.DB.prepare("SELECT * FROM posts WHERE fetched_at >= datetime('now', '-3 minutes') ORDER BY published_at DESC LIMIT 100"));
}
