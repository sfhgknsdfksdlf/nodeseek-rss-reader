import { all, nowIso, one } from "./db";
import { normalizeBoard } from "./board";
import { sanitizePostHtml, stripHtml } from "./filters";
import type { CronTimingSnapshot, Env, NewPostForSubscription, Post } from "./types";

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

interface RssAttemptLogRow {
  created_at: string;
  source: string;
  method: string;
  outcome: string;
  status: number | null;
  status_text: string | null;
  error: string | null;
  preview: string | null;
}

export interface RssFailureSummary {
  windowHours: number;
  since: string;
  totalAttempts: number;
  bySource: Record<string, number>;
  byResult: Record<string, number>;
  byStatus: Record<string, number>;
  recentSamples: Array<{
    createdAt: string;
    source: string;
    method: string;
    outcome: string;
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

function randomIntInclusive(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export interface RssAttemptStats {
  cron: { success: number; failure: number };
  rssTest: { success: number; failure: number };
}

export interface RssAttemptDiagnostics {
  attemptStats: RssAttemptStats;
  failureSummary: RssFailureSummary;
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

async function cleanupOldRssAttemptLogs(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  await env.DB.prepare("DELETE FROM rss_fetch_attempts WHERE created_at < ?").bind(cutoff).run();
}

async function recordRssAttempt(env: Env, source: string, strategy: string, outcome: "success" | "failure", status?: number, statusText?: string, error?: string, preview?: string): Promise<void> {
  await cleanupOldRssAttemptLogs(env);
  await env.DB.prepare("INSERT INTO rss_fetch_attempts (source, method, outcome, status, status_text, error, preview, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(source, strategy, outcome, status ?? null, statusText ?? null, error ?? null, preview ?? null, nowIso())
    .run();
}

async function tryStrategy(env: Env, source: string, logMethod: string, rssUrl: string, strategy: FetchStrategy): Promise<{ ok: true; xml: string; strategy: string; fetchMs: number } | { ok: false; message: string; fetchMs: number }> {
  const startedAt = Date.now();
  try {
    const res = await fetchWithStrategy(rssUrl, strategy);
    const text = await res.text();
    const preview = text.slice(0, 120);
    if (res.ok) {
      await recordRssAttempt(env, source, strategy.name, "success", res.status, res.statusText, undefined, preview);
      return { ok: true, xml: text, strategy: strategy.name, fetchMs: Date.now() - startedAt };
    }
    const message = `${logMethod}: ${res.status} ${res.statusText} ${preview}`.trim();
    await recordRssAttempt(env, source, strategy.name, "failure", res.status, res.statusText, undefined, preview);
    return { ok: false, message, fetchMs: Date.now() - startedAt };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    await recordRssAttempt(env, source, strategy.name, "failure", undefined, undefined, messageText);
    return { ok: false, message: `${logMethod}: ${messageText}`, fetchMs: Date.now() - startedAt };
  }
}

async function fetchRssXml(env: Env, rssUrl: string): Promise<{ xml: string; strategy: string; timings: { fetchRssMs: number; fetchFirstStrategyMs: number; fetchRetryStrategyMs: number; writeStateMs: number } }> {
  const rssStrategy = rssFetchStrategies[0];
  const browserStrategy = rssFetchStrategies[1];
  const firstDelaySeconds = randomIntInclusive(21, 24);
  const retryDelaySeconds = randomIntInclusive(21, 24);
  await sleep(firstDelaySeconds * 1000);
  const rssResult = await tryStrategy(env, "sync", "rss", rssUrl, rssStrategy);
  if (rssResult.ok) return { xml: rssResult.xml, strategy: rssResult.strategy, timings: { fetchRssMs: rssResult.fetchMs, fetchFirstStrategyMs: rssResult.fetchMs, fetchRetryStrategyMs: 0, writeStateMs: 0 } };
  await sleep(retryDelaySeconds * 1000);
  const browserResult = await tryStrategy(env, "sync", "browser", rssUrl, browserStrategy);
  if (browserResult.ok) return { xml: browserResult.xml, strategy: browserResult.strategy, timings: { fetchRssMs: rssResult.fetchMs + browserResult.fetchMs, fetchFirstStrategyMs: rssResult.fetchMs, fetchRetryStrategyMs: browserResult.fetchMs, writeStateMs: 0 } };
  const errors = [rssResult.message, browserResult.message];
  throw new Error(`RSS fetch failed. ${errors.join(" | ")}`);
}

async function setSyncState(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare("INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)").bind(key, value, nowIso()).run();
}

async function setCronTimingSnapshot(env: Env, snapshot: CronTimingSnapshot): Promise<void> {
  await setSyncState(env, "last_cron_timing", JSON.stringify(snapshot));
}

export interface RssSyncTiming {
  fetchRssMs: number;
  fetchFirstStrategyMs: number;
  fetchRetryStrategyMs: number;
  parseItemsMs: number;
  parseItemCount: number;
  prepareInsertMs: number;
  insertBindRunMs: number;
  insertLookupMs: number;
  insertNewCount: number;
  insertExistingCount: number;
  insertLoopMs: number;
  insertedPostLoadMs: number;
  insertPostsMs: number;
  writeSyncStateMs: number;
  writeStateMs: number;
  totalMs: number;
}

export interface RssSyncResult {
  inserted: number;
  firstSync: boolean;
  insertedPosts: NewPostForSubscription[];
  strategy: string;
  timings: RssSyncTiming;
  cpu: {
    parseItemsMs: number;
    parseItemCount: number;
  };
}

export interface SafeRssSyncResult {
  inserted: number;
  firstSync: boolean;
  insertedPosts: NewPostForSubscription[];
  ok: boolean;
  strategy?: string;
  timings?: RssSyncTiming;
  cpu?: {
    parseItemsMs: number;
    parseItemCount: number;
  };
  error?: string;
}

export async function syncRss(env: Env): Promise<RssSyncResult> {
  const rssUrl = env.RSS_URL || "https://rss.nodeseek.com/";
  const fetchStartedAt = Date.now();
  const { xml, strategy, timings: fetchTimings } = await fetchRssXml(env, rssUrl);
  const fetchRssMs = Date.now() - fetchStartedAt;
  const parseStartedAt = Date.now();
  const items = parseItems(xml);
  const parseItemsMs = Date.now() - parseStartedAt;
  const first = !(await one<{ value: string }>(env.DB.prepare("SELECT value FROM sync_state WHERE key = 'first_sync_done'")));
  let inserted = 0;
  const insertedPosts: NewPostForSubscription[] = [];
  const insertStartedAt = Date.now();
  const prepareInsertStartedAt = Date.now();
  const insertRows = items.filter((item) => !!item.guid).map((item) => ({ item, values: [item.guid, item.title, item.link, item.contentHtml, item.contentText, item.author || null, item.board || null, item.publishedAt, nowIso()] }));
  const prepareInsertMs = Date.now() - prepareInsertStartedAt;
  let insertBindRunMs = 0;
  let insertLookupMs = 0;
  let insertNewCount = 0;
  let insertExistingCount = 0;
  const batchStartedAt = Date.now();
  if (insertRows.length) {
    const sql = "INSERT OR IGNORE INTO posts (guid, title, link, content_html, content_text, author, board_key, published_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
    const statements = insertRows.map((row) => env.DB.prepare(sql).bind(...row.values));
    const results = await env.DB.batch(statements);
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      const { item, values } = insertRows[index];
      if (result.meta.changes) {
        insertNewCount++;
        inserted++;
        insertedPosts.push({
          guid: item.guid,
          title: item.title,
          link: item.link,
          content_html: item.contentHtml,
          content_text: item.contentText,
          author: item.author || null,
          board_key: item.board || null,
          published_at: item.publishedAt,
          fetched_at: values[8] as string
        });
      } else {
        insertExistingCount++;
      }
    }
  }
  const insertLoopMs = Date.now() - insertStartedAt;
  const insertedPostLoadMs = insertLookupMs;
  const writeStateStartedAt = Date.now();
  await env.DB.prepare("INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES ('first_sync_done', '1', ?), ('last_sync_at', ?, ?), ('last_sync_error', '', ?), ('last_sync_strategy', ?, ?)").bind(nowIso(), nowIso(), nowIso(), nowIso(), strategy, nowIso()).run();
  const writeSyncStateMs = Date.now() - writeStateStartedAt;
  const writeStateMs = fetchTimings.writeStateMs + writeSyncStateMs;
  const insertPostsMs = insertLoopMs + insertedPostLoadMs;
  insertBindRunMs = Date.now() - batchStartedAt;
  return { inserted, firstSync: first, insertedPosts, strategy, timings: { fetchRssMs: fetchTimings.fetchRssMs, fetchFirstStrategyMs: fetchTimings.fetchFirstStrategyMs, fetchRetryStrategyMs: fetchTimings.fetchRetryStrategyMs, parseItemsMs, parseItemCount: items.length, prepareInsertMs, insertBindRunMs, insertLookupMs, insertNewCount, insertExistingCount, insertLoopMs, insertedPostLoadMs, insertPostsMs, writeSyncStateMs, writeStateMs, totalMs: Date.now() - fetchStartedAt }, cpu: { parseItemsMs, parseItemCount: items.length } };
}

export async function safeSyncRss(env: Env): Promise<SafeRssSyncResult> {
  try {
    const result = await syncRss(env);
    return { inserted: result.inserted, firstSync: result.firstSync, insertedPosts: result.insertedPosts, ok: true, strategy: result.strategy, timings: result.timings, cpu: result.cpu };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("RSS sync failed", message);
    await setSyncState(env, "last_sync_error", message);
    await setSyncState(env, "last_sync_at", nowIso());
    return { inserted: 0, firstSync: false, insertedPosts: [], ok: false, error: message, timings: { fetchRssMs: 0, fetchFirstStrategyMs: 0, fetchRetryStrategyMs: 0, parseItemsMs: 0, parseItemCount: 0, prepareInsertMs: 0, insertBindRunMs: 0, insertLookupMs: 0, insertNewCount: 0, insertExistingCount: 0, insertLoopMs: 0, insertedPostLoadMs: 0, insertPostsMs: 0, writeSyncStateMs: 0, writeStateMs: 0, totalMs: 0 }, cpu: { parseItemsMs: 0, parseItemCount: 0 } };
  }
}

export async function recordCronTiming(env: Env, snapshot: CronTimingSnapshot): Promise<void> {
  await setCronTimingSnapshot(env, snapshot);
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
      await recordRssAttempt(env, "rss_test", strategy.name, res.ok ? "success" : "failure", res.status, res.statusText, undefined, text.slice(0, 120));
      if (res.ok) break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ method: strategy.name, success: false, error: message });
      await recordRssAttempt(env, "rss_test", strategy.name, "failure", undefined, undefined, message);
    }
  }
  return results;
}

export async function getRssFailureSummary(env: Env): Promise<RssFailureSummary> {
  return (await getRssAttemptDiagnostics(env)).failureSummary;
}

export async function getRssAttemptStats(env: Env): Promise<RssAttemptStats> {
  return (await getRssAttemptDiagnostics(env)).attemptStats;
}

export async function getRssAttemptDiagnostics(env: Env): Promise<RssAttemptDiagnostics> {
  await cleanupOldRssAttemptLogs(env);
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const rows = await all<RssAttemptLogRow>(env.DB.prepare("SELECT created_at, source, method, outcome, status, status_text, error, preview FROM rss_fetch_attempts WHERE created_at >= ? ORDER BY created_at DESC LIMIT 200").bind(since));
  const bySource: Record<string, number> = {};
  const byResult: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const attemptStats: RssAttemptStats = {
    cron: { success: 0, failure: 0 },
    rssTest: { success: 0, failure: 0 }
  };
  for (const row of rows) {
    bySource[row.source] = (bySource[row.source] || 0) + 1;
    const resultKey = `${row.method}_${row.outcome}`;
    byResult[resultKey] = (byResult[resultKey] || 0) + 1;
    const statusKey = row.status == null ? "error" : String(row.status);
    byStatus[statusKey] = (byStatus[statusKey] || 0) + 1;
    const bucket = row.source === "sync" ? attemptStats.cron : row.source === "rss_test" ? attemptStats.rssTest : null;
    if (bucket) {
      if (row.outcome === "success") bucket.success++;
      if (row.outcome === "failure") bucket.failure++;
    }
  }
  return {
    attemptStats,
    failureSummary: {
      windowHours: 24,
      since,
      totalAttempts: rows.length,
      bySource,
      byResult,
      byStatus,
      recentSamples: rows.slice(0, 20).map((row) => ({
        createdAt: row.created_at,
        source: row.source,
        method: row.method,
        outcome: row.outcome,
        status: row.status,
        statusText: row.status_text,
        error: row.error,
        preview: row.preview
      }))
    }
  };
}
