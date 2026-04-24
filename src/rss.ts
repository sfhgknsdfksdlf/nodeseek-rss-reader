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

interface FetchStrategy {
  name: string;
  headers: HeadersInit;
}

export interface RssFetchTestResult {
  method: string;
  status?: number;
  statusText?: string;
  success: boolean;
  contentType?: string | null;
  preview?: string;
  error?: string;
}

const rssFetchStrategies: FetchStrategy[] = [
  {
    name: "browser",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      "Referer": "https://www.nodeseek.com/",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache"
    }
  },
  {
    name: "rss",
    headers: {
      "User-Agent": "Mozilla/5.0 NodeSeek RSS Reader",
      "Accept": "application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Referer": "https://www.nodeseek.com/"
    }
  },
  {
    name: "curl",
    headers: {
      "User-Agent": "curl/8.0.1",
      "Accept": "*/*"
    }
  }
];

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

async function fetchRssXml(rssUrl: string): Promise<{ xml: string; strategy: string }> {
  const errors: string[] = [];
  for (const strategy of rssFetchStrategies) {
    try {
      const res = await fetch(rssUrl, { headers: strategy.headers, cf: { cacheTtl: 0, cacheEverything: false } });
      const text = await res.text();
      if (res.ok) return { xml: text, strategy: strategy.name };
      errors.push(`${strategy.name}: ${res.status} ${res.statusText} ${text.slice(0, 120)}`.trim());
    } catch (error) {
      errors.push(`${strategy.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`RSS fetch failed. ${errors.join(" | ")}`);
}

async function setSyncState(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare("INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)").bind(key, value, nowIso()).run();
}

export async function syncRss(env: Env): Promise<{ inserted: number; firstSync: boolean }> {
  const rssUrl = env.RSS_URL || "https://rss.nodeseek.com/";
  const { xml, strategy } = await fetchRssXml(rssUrl);
  const items = parseItems(xml);
  const first = !(await one<{ value: string }>(env.DB.prepare("SELECT value FROM sync_state WHERE key = 'first_sync_done'")));
  let inserted = 0;
  for (const item of items) {
    const result = await env.DB.prepare("INSERT OR IGNORE INTO posts (guid, title, link, content_html, content_text, author, board_key, published_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(item.guid, item.title, item.link, item.contentHtml, item.contentText, item.author || null, item.board || null, item.publishedAt, nowIso())
      .run();
    if (result.meta.changes) inserted++;
  }
  await env.DB.prepare("INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES ('first_sync_done', '1', ?), ('last_sync_at', ?, ?), ('last_sync_error', '', ?), ('last_sync_strategy', ?, ?)").bind(nowIso(), nowIso(), nowIso(), nowIso(), strategy, nowIso()).run();
  return { inserted, firstSync: first };
}

export async function safeSyncRss(env: Env): Promise<{ inserted: number; firstSync: boolean; ok: boolean; error?: string }> {
  try {
    return { ...(await syncRss(env)), ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await setSyncState(env, "last_sync_error", message);
    await setSyncState(env, "last_sync_at", nowIso());
    return { inserted: 0, firstSync: false, ok: false, error: message };
  }
}

export async function testRssFetch(env: Env): Promise<RssFetchTestResult[]> {
  const rssUrl = env.RSS_URL || "https://rss.nodeseek.com/";
  const results: RssFetchTestResult[] = [];
  for (const strategy of rssFetchStrategies) {
    try {
      const res = await fetch(rssUrl, { headers: strategy.headers, cf: { cacheTtl: 0, cacheEverything: false } });
      const text = await res.text();
      results.push({ method: strategy.name, status: res.status, statusText: res.statusText, success: res.ok, contentType: res.headers.get("content-type"), preview: text.slice(0, 200) });
      if (res.ok) break;
    } catch (error) {
      results.push({ method: strategy.name, success: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

export async function latestUnpushedPosts(env: Env): Promise<Post[]> {
  return all<Post>(env.DB.prepare("SELECT * FROM posts WHERE fetched_at >= datetime('now', '-3 minutes') ORDER BY published_at DESC LIMIT 100"));
}
