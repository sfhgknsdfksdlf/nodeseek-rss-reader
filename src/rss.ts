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
  itemCount?: number;
  latestGuid?: string;
  latestTitle?: string;
  latestPublishedAt?: string;
  latestLink?: string;
  error?: string;
}

interface RssFailureLogRow {
  created_at: string;
  source: string;
  method: string;
  status: number | null;
  status_text: string | null;
  error: string | null;
  preview: string | null;
}

export interface RssFailureSummary {
  windowHours: number;
  since: string;
  totalFailures: number;
  bySource: Record<string, number>;
  byMethod: Record<string, number>;
  byStatus: Record<string, number>;
  recentSamples: Array<{
    createdAt: string;
    source: string;
    method: string;
    status: number | null;
    statusText: string | null;
    error: string | null;
    preview: string | null;
  }>;
}

const rssFetchStrategies: FetchStrategy[] = [
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
    name: "browser",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      "Referer": "https://www.nodeseek.com/",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
      "sec-fetch-user": "?1",
      "upgrade-insecure-requests": "1"
    }
  }
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function fetchWithStrategy(rssUrl: string, strategy: FetchStrategy): Promise<Response> {
  return fetch(rssUrl, { headers: strategy.headers, cf: { cacheTtl: 60 } });
}

async function cleanupOldRssFailureLogs(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  await env.DB.prepare("DELETE FROM rss_fetch_failures WHERE created_at < ?").bind(cutoff).run();
}

async function recordRssFailure(env: Env, source: string, strategy: string, status?: number, statusText?: string, error?: string, preview?: string): Promise<void> {
  await cleanupOldRssFailureLogs(env);
  await env.DB.prepare("INSERT INTO rss_fetch_failures (source, method, status, status_text, error, preview, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(source, strategy, status ?? null, statusText ?? null, error ?? null, preview ?? null, nowIso())
    .run();
}

async function tryStrategy(env: Env, source: string, logMethod: string, rssUrl: string, strategy: FetchStrategy): Promise<{ ok: true; xml: string; strategy: string } | { ok: false; message: string }> {
  try {
    const res = await fetchWithStrategy(rssUrl, strategy);
    const text = await res.text();
    if (res.ok) return { ok: true, xml: text, strategy: strategy.name };
    const preview = text.slice(0, 120);
    const message = `${logMethod}: ${res.status} ${res.statusText} ${preview}`.trim();
    await recordRssFailure(env, source, logMethod, res.status, res.statusText, undefined, preview);
    return { ok: false, message };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    await recordRssFailure(env, source, logMethod, undefined, undefined, messageText);
    return { ok: false, message: `${logMethod}: ${messageText}` };
  }
}

async function fetchRssXml(env: Env, rssUrl: string): Promise<{ xml: string; strategy: string }> {
  const rssStrategy = rssFetchStrategies[0];
  const browserStrategy = rssFetchStrategies[1];
  const rssResult = await tryStrategy(env, "sync", "rss", rssUrl, rssStrategy);
  if (rssResult.ok) return { xml: rssResult.xml, strategy: rssResult.strategy };
  await sleep(26000);
  const browserResult = await tryStrategy(env, "sync", "browser_retry", rssUrl, browserStrategy);
  if (browserResult.ok) return { xml: browserResult.xml, strategy: browserResult.strategy };
  const errors = [rssResult.message, browserResult.message];
  throw new Error(`RSS fetch failed. ${errors.join(" | ")}`);
}

async function setSyncState(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare("INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)").bind(key, value, nowIso()).run();
}

export async function syncRss(env: Env): Promise<{ inserted: number; firstSync: boolean; insertedPosts: Post[] }> {
  const rssUrl = env.RSS_URL || "https://rss.nodeseek.com/";
  const { xml, strategy } = await fetchRssXml(env, rssUrl);
  const items = parseItems(xml);
  const first = !(await one<{ value: string }>(env.DB.prepare("SELECT value FROM sync_state WHERE key = 'first_sync_done'")));
  let inserted = 0;
  const insertedPosts: Post[] = [];
  for (const item of items) {
    const fetchedAt = nowIso();
    const result = await env.DB.prepare("INSERT OR IGNORE INTO posts (guid, title, link, content_html, content_text, author, board_key, published_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(item.guid, item.title, item.link, item.contentHtml, item.contentText, item.author || null, item.board || null, item.publishedAt, fetchedAt)
      .run();
    if (result.meta.changes) {
      inserted++;
      const post = await one<Post>(env.DB.prepare("SELECT * FROM posts WHERE guid = ?").bind(item.guid));
      if (post) insertedPosts.push(post);
    }
  }
  await env.DB.prepare("INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES ('first_sync_done', '1', ?), ('last_sync_at', ?, ?), ('last_sync_error', '', ?), ('last_sync_strategy', ?, ?)").bind(nowIso(), nowIso(), nowIso(), nowIso(), strategy, nowIso()).run();
  return { inserted, firstSync: first, insertedPosts };
}

export async function safeSyncRss(env: Env): Promise<{ inserted: number; firstSync: boolean; insertedPosts: Post[]; ok: boolean; error?: string }> {
  try {
    return { ...(await syncRss(env)), ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("RSS sync failed", message);
    await setSyncState(env, "last_sync_error", message);
    await setSyncState(env, "last_sync_at", nowIso());
    return { inserted: 0, firstSync: false, insertedPosts: [], ok: false, error: message };
  }
}

export async function testRssFetch(env: Env): Promise<RssFetchTestResult[]> {
  const rssUrl = env.RSS_URL || "https://rss.nodeseek.com/";
  const results: RssFetchTestResult[] = [];
  for (const strategy of rssFetchStrategies) {
    try {
      const res = await fetchWithStrategy(rssUrl, strategy);
      const text = await res.text();
      const items = res.ok ? parseItems(text) : [];
      const latest = items[0];
      results.push({ method: strategy.name, status: res.status, statusText: res.statusText, success: res.ok, contentType: res.headers.get("content-type"), preview: text.slice(0, 200), itemCount: items.length, latestGuid: latest?.guid, latestTitle: latest?.title, latestPublishedAt: latest?.publishedAt, latestLink: latest?.link });
      if (!res.ok) await recordRssFailure(env, "rss_test", strategy.name, res.status, res.statusText, undefined, text.slice(0, 120));
      if (res.ok) break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ method: strategy.name, success: false, error: message });
      await recordRssFailure(env, "rss_test", strategy.name, undefined, undefined, message);
    }
  }
  return results;
}

export async function getRssFailureSummary(env: Env): Promise<RssFailureSummary> {
  await cleanupOldRssFailureLogs(env);
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const rows = await all<RssFailureLogRow>(env.DB.prepare("SELECT created_at, source, method, status, status_text, error, preview FROM rss_fetch_failures WHERE created_at >= ? ORDER BY created_at DESC LIMIT 200").bind(since));
  const bySource: Record<string, number> = {};
  const byMethod: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const row of rows) {
    bySource[row.source] = (bySource[row.source] || 0) + 1;
    byMethod[row.method] = (byMethod[row.method] || 0) + 1;
    const statusKey = row.status == null ? "error" : String(row.status);
    byStatus[statusKey] = (byStatus[statusKey] || 0) + 1;
  }
  return {
    windowHours: 24,
    since,
    totalFailures: rows.length,
    bySource,
    byMethod,
    byStatus,
    recentSamples: rows.slice(0, 20).map((row) => ({
      createdAt: row.created_at,
      source: row.source,
      method: row.method,
      status: row.status,
      statusText: row.status_text,
      error: row.error,
      preview: row.preview
    }))
  };
}
