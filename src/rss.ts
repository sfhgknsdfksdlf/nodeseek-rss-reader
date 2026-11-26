import { all, nowIso, one } from "./db";
import { normalizeBoard } from "./board";
import { sanitizePostHtml, stripHtml } from "./filters";
import { sanitizeAndExtract } from "./html";
import { indexPostsForSearch, markSearchIndexRetryPending, recordSearchIndexError } from "./search";
import type { CronTimingSnapshot, Env, Post, RssNewPost } from "./types";

export interface RssItem {
  guid: string;
  title: string;
  link: string;
  contentHtml: string;
  contentText: string;
  author: string;
  board: string;
  publishedAt: string;
}

interface RssInsertCandidate {
  guid: string;
  item?: RssItem;
  chunk?: string;
}

interface FetchStrategy {
  name: string;
  headers: HeadersInit;
}

interface RssFetchTestResult {
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

interface RssFailureSummary {
  // Counts below cover only the returned failure sample (capped by RssAttemptDiagnostics.sampleLimit), not every attempt in the window.
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

interface RssAttemptStats {
  // success is always 0 under failures-only collection; kept for payload-shape compatibility.
  cron: { success: number; failure: number };
  rssTest: { success: number; failure: number };
}

interface RssAttemptDiagnostics {
  collectionMode: "failures-only";
  statsScope: "latest-200-failures-within-24h";
  sampleLimit: number;
  attemptStats: RssAttemptStats;
  failureSummary: RssFailureSummary;
}

function tagPattern(tag: string): RegExp {
  return new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
}

// Compiled once per isolate; the previous parser rebuilt 7-9 RegExp objects per item.
const guidTagPatterns = [tagPattern("guid"), tagPattern("id")];
const titleTagPatterns = [tagPattern("title")];
const contentTagPatterns = [tagPattern("content:encoded"), tagPattern("content"), tagPattern("description"), tagPattern("summary")];
const authorTagPatterns = [tagPattern("dc:creator"), tagPattern("author"), tagPattern("name")];
const categoryTagPatterns = [tagPattern("category")];
const dateTagPatterns = [tagPattern("pubDate"), tagPattern("published"), tagPattern("updated")];
const linkHrefPattern = /<link\b[^>]*href=["']([^"']+)["'][^>]*>/i;
const linkTextTagPatterns = [tagPattern("link")];
const cdataWrapperPattern = /^<!\[CDATA\[|\]\]>$/g;
const itemChunkPattern = /<item[\s\S]*?<\/item>|<entry[\s\S]*?<\/entry>/gi;

function textBetweenPatterns(xml: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = pattern.exec(xml);
    if (match) return decodeXml(match[1].replace(cdataWrapperPattern, "").trim());
  }
  return "";
}

function attrLink(xml: string): string {
  const href = linkHrefPattern.exec(xml)?.[1];
  if (href) return decodeXml(href);
  return textBetweenPatterns(xml, linkTextTagPatterns);
}

export function decodeXml(value: string): string {
  // Fast path: most text has no entity at all; the replace chain would return it unchanged.
  if (!value.includes("&")) return value;
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

export function splitItemChunks(xml: string): string[] {
  return [...xml.matchAll(itemChunkPattern)].map((match) => match[0]);
}

// Mirrors the legacy parser's GUID precedence: guid/id text, then link, then title.
export function cheapGuid(chunk: string): string {
  return textBetweenPatterns(chunk, guidTagPatterns) || attrLink(chunk) || textBetweenPatterns(chunk, titleTagPatterns);
}

interface ParsedChunkResult {
  item: RssItem;
  guidMismatch: boolean;
}

// Field extraction without HTML sanitization, shared by the inline (regex) and
// Queue (HTMLRewriter) paths so the RSS/XML parsing logic cannot drift. The
// optional guidHint also yields the same mismatch flag for both paths.
export interface ParsedChunkFields {
  guid: string;
  title: string;
  link: string;
  contentRaw: string;
  author: string;
  board: string;
  publishedAt: string;
  guidMismatch: boolean;
}

export function parseChunkFields(chunk: string, guidHint?: string): ParsedChunkFields {
  const title = textBetweenPatterns(chunk, titleTagPatterns);
  const link = attrLink(chunk);
  const guid = textBetweenPatterns(chunk, guidTagPatterns) || link || title;
  const contentRaw = textBetweenPatterns(chunk, contentTagPatterns);
  const author = textBetweenPatterns(chunk, authorTagPatterns);
  const board = normalizeBoard(textBetweenPatterns(chunk, categoryTagPatterns));
  const dateRaw = textBetweenPatterns(chunk, dateTagPatterns);
  const date = new Date(dateRaw);
  return {
    guid,
    title,
    link,
    contentRaw,
    author,
    board,
    publishedAt: Number.isNaN(date.getTime()) ? nowIso() : date.toISOString(),
    guidMismatch: typeof guidHint === "string" && guidHint !== guid
  };
}

// `guidHint` is the cheap prefilter GUID. A divergence is reported to the caller
// instead of silently replacing the identity used for dedupe/existence checks.
export function parseChunkFull(chunk: string, guidHint?: string): ParsedChunkResult {
  const fields = parseChunkFields(chunk, guidHint);
  const contentHtml = sanitizePostHtml(fields.contentRaw);
  return {
    item: {
      guid: fields.guid,
      title: fields.title,
      link: fields.link,
      contentHtml,
      contentText: stripHtml(contentHtml || fields.contentRaw),
      author: fields.author,
      board: fields.board,
      publishedAt: fields.publishedAt
    },
    guidMismatch: fields.guidMismatch
  };
}

// HTMLRewriter variant used by the Queue consumer when HTML_MODE=rewriter.
// Same fields and same guidMismatch semantics; only the body pipeline differs.
export async function parseChunkFullHtml(chunk: string, guidHint?: string): Promise<{ item: RssItem; guidMismatch: boolean; htmlMode: "rewriter" }> {
  const fields = parseChunkFields(chunk, guidHint);
  const sanitized = await sanitizeAndExtract(fields.contentRaw);
  return {
    item: {
      guid: fields.guid,
      title: fields.title,
      link: fields.link,
      contentHtml: sanitized.html,
      contentText: sanitized.html ? sanitized.text : stripHtml(fields.contentRaw),
      author: fields.author,
      board: fields.board,
      publishedAt: fields.publishedAt
    },
    guidMismatch: fields.guidMismatch,
    htmlMode: "rewriter"
  };
}

function parseChunksFull(chunks: string[]): RssItem[] {
  return chunks.map((chunk) => parseChunkFull(chunk).item).filter((item) => item.guid && item.title && item.link);
}

export function parseItemsFull(xml: string): RssItem[] {
  return parseChunksFull(splitItemChunks(xml));
}

const parseItems = parseItemsFull;

async function fetchWithStrategy(rssUrl: string, strategy: FetchStrategy): Promise<Response> {
  return fetch(rssUrl, { headers: strategy.headers, cf: { cacheTtl: 60 } });
}

// Only failure attempts are persisted; success writes nothing (diagnostics query is failures-only).
async function recordRssAttempt(env: Env, source: string, strategy: string, outcome: "success" | "failure", status?: number, statusText?: string, error?: string, preview?: string): Promise<void> {
  if (outcome === "success") return;
  await env.DB.prepare("INSERT INTO rss_fetch_attempts (source, method, outcome, status, status_text, error, preview, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(source, strategy, outcome, status ?? null, statusText ?? null, error ?? null, preview ?? null, nowIso())
    .run();
}

async function tryStrategy(env: Env, source: string, logMethod: string, rssUrl: string, strategy: FetchStrategy, persistFailure = true): Promise<{ ok: true; xml: string; strategy: string; fetchMs: number } | { ok: false; message: string; fetchMs: number }> {
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
    if (persistFailure) await recordRssAttempt(env, source, strategy.name, "failure", res.status, res.statusText, undefined, preview);
    return { ok: false, message, fetchMs: Date.now() - startedAt };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    if (persistFailure) await recordRssAttempt(env, source, strategy.name, "failure", undefined, undefined, messageText);
    return { ok: false, message: `${logMethod}: ${messageText}`, fetchMs: Date.now() - startedAt };
  }
}

export async function fetchRssXml(env: Env, rssUrl: string, options?: { persistFailure?: boolean }): Promise<{ xml: string; strategy: string; timings: { fetchRssMs: number; fetchFirstStrategyMs: number; fetchRetryStrategyMs: number } }> {
  const rssStrategy = rssFetchStrategies[0];
  const browserStrategy = rssFetchStrategies[1];
  const persistFailure = options?.persistFailure !== false;
  const firstDelaySeconds = randomIntInclusive(21, 24);
  const retryDelaySeconds = randomIntInclusive(21, 24);
  await sleep(firstDelaySeconds * 1000);
  const rssResult = await tryStrategy(env, "sync", "rss", rssUrl, rssStrategy, persistFailure);
  if (rssResult.ok) return { xml: rssResult.xml, strategy: rssResult.strategy, timings: { fetchRssMs: rssResult.fetchMs, fetchFirstStrategyMs: rssResult.fetchMs, fetchRetryStrategyMs: 0 } };
  await sleep(retryDelaySeconds * 1000);
  const browserResult = await tryStrategy(env, "sync", "browser", rssUrl, browserStrategy, persistFailure);
  if (browserResult.ok) return { xml: browserResult.xml, strategy: browserResult.strategy, timings: { fetchRssMs: rssResult.fetchMs + browserResult.fetchMs, fetchFirstStrategyMs: rssResult.fetchMs, fetchRetryStrategyMs: browserResult.fetchMs } };
  const errors = [rssResult.message, browserResult.message];
  throw new Error(`RSS fetch failed. ${errors.join(" | ")}`);
}

function initSyncState(env: Env, key: string, value: string, updatedAt: string): D1PreparedStatement {
  return env.DB.prepare("INSERT INTO sync_state (key, value, updated_at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM sync_state WHERE key = ?) ON CONFLICT(key) DO NOTHING").bind(key, value, updatedAt, key);
}

// Feed GUIDs are compared in bounded IN() chunks so a large feed never turns
// into one oversized statement. Both syncRss and the Queue producer share this.
export async function queryExistingGuids(env: Env, guids: string[]): Promise<Set<string>> {
  const existing = new Set<string>();
  for (let offset = 0; offset < guids.length; offset += 100) {
    const chunk = guids.slice(offset, offset + 100);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await all<{ guid: string }>(env.DB.prepare(`SELECT guid FROM posts WHERE guid IN (${placeholders})`).bind(...chunk));
    for (const row of rows) existing.add(row.guid);
  }
  return existing;
}

// Success state stays the single fixed-key contract: guarded inserts first,
// then conditional updates so a stable cron does not rewrite unchanged values.
// Queue mode passes markFirstSyncDone=false: first_sync_done may only flip once
// the consumer has actually persisted every bootstrap GUID.
export async function persistSyncSuccess(env: Env, strategy: string, options?: { markFirstSyncDone?: boolean; restoreSearchComplete?: boolean }): Promise<void> {
  const updatedAt = nowIso();
  const statements: D1PreparedStatement[] = [];
  if (options?.markFirstSyncDone !== false) statements.push(initSyncState(env, "first_sync_done", "1", updatedAt));
  statements.push(
    initSyncState(env, "last_sync_at", updatedAt, updatedAt),
    initSyncState(env, "last_sync_error", "", updatedAt),
    initSyncState(env, "last_sync_strategy", strategy, updatedAt),
    env.DB.prepare("UPDATE sync_state SET value = ?, updated_at = ? WHERE key = 'last_sync_at'").bind(updatedAt, updatedAt),
    env.DB.prepare("UPDATE sync_state SET value = '', updated_at = ? WHERE key = 'last_sync_error' AND value IS NOT ''").bind(updatedAt),
    env.DB.prepare("UPDATE sync_state SET value = ?, updated_at = ? WHERE key = 'last_sync_strategy' AND value IS NOT ?").bind(strategy, updatedAt, strategy)
  );
  // Same batch, no extra D1 call: if this restore fails, complete stays 0 and
  // the resumable backfill repairs the posts.
  if (options?.restoreSearchComplete) {
    statements.push(env.DB.prepare("UPDATE search_index_state SET complete = 1, updated_at = ? WHERE id = 1").bind(updatedAt));
  }
  await env.DB.batch(statements);
}

export async function persistSyncFailure(env: Env, message: string): Promise<void> {
  const updatedAt = nowIso();
  await env.DB.batch([
    initSyncState(env, "last_sync_error", message, updatedAt),
    initSyncState(env, "last_sync_at", updatedAt, updatedAt),
    env.DB.prepare("UPDATE sync_state SET value = ?, updated_at = ? WHERE key = 'last_sync_error' AND value IS NOT ?").bind(message, updatedAt, message),
    env.DB.prepare("UPDATE sync_state SET value = ?, updated_at = ? WHERE key = 'last_sync_at'").bind(updatedAt, updatedAt)
  ]);
}

async function setCronTimingSnapshot(env: Env, snapshot: CronTimingSnapshot): Promise<void> {
  const updatedAt = nowIso();
  const value = JSON.stringify(snapshot);
  await env.DB.batch([
    initSyncState(env, "last_cron_timing", value, updatedAt),
    env.DB.prepare("UPDATE sync_state SET value = ?, updated_at = ? WHERE key = 'last_cron_timing'").bind(value, updatedAt)
  ]);
}

export interface RssSyncTiming {
  fetchRssMs: number;
  fetchFirstStrategyMs: number;
  fetchRetryStrategyMs: number;
  parseItemsMs: number;
  parseItemCount: number;
  prepareInsertMs: number;
  insertBindRunMs: number;
  insertNewCount: number;
  insertExistingCount: number;
  insertLoopMs: number;
  insertPostsMs: number;
  writeSyncStateMs: number;
  totalMs: number;
  guidExtractMs?: number;
  guidExtractCount?: number;
  fullParseMs?: number;
  fullParseCount?: number;
  guidMismatchCount?: number;
  indexFailureCount?: number;
  enqueuedItems?: number;
  enqueuedMessages?: number;
}

export interface RssSyncOptions {
  maxNewPosts?: number;
  // Observed `search_index_state.complete` from the invocation's single read;
  // only a currently-complete index needs the durable pre-mark/restore pair.
  searchComplete?: number;
  // `first_sync_done` row presence, preloaded by the inline caller's post-lease
  // snapshot so `syncRss` does not need a separate point read. Callers that omit
  // it (queue mode) keep the standalone query.
  firstSyncDone?: boolean;
  // Cut C of the factory A/B/C/D experiment: fetch and parse the real prefix,
  // then return before any business write or failure diagnostic.
  abcdCut?: "C";
}

interface RssSyncResult {
  inserted: number;
  firstSync: boolean;
  insertedPosts: RssNewPost[];
  strategy: string;
  indexFailureCount: number;
  abcdCut?: "C";
  timings: RssSyncTiming;
  cpu: {
    parseItemsMs: number;
    parseItemCount: number;
  };
}

export interface SafeRssSyncResult {
  inserted: number;
  firstSync: boolean;
  insertedPosts: RssNewPost[];
  ok: boolean;
  strategy?: string;
  abcdCut?: "C";
  timings?: RssSyncTiming;
  cpu?: {
    parseItemsMs: number;
    parseItemCount: number;
  };
  error?: string;
}

// A pre-mark is only useful (and only safe to restore) when this sync actually
// inserts rows into an index that was complete before the sync started.
export function shouldPreMarkSearchIncomplete(insertRowCount: number, initialSearchComplete: number | undefined): boolean {
  return insertRowCount > 0 && initialSearchComplete === 1;
}

export async function syncRss(env: Env, options?: RssSyncOptions): Promise<RssSyncResult> {
  const rssUrl = env.RSS_URL || "https://rss.nodeseek.com/";
  const initialSearchComplete = options?.searchComplete;
  const fetchStartedAt = Date.now();
  const { xml, strategy, timings: fetchTimings } = await fetchRssXml(env, rssUrl, { persistFailure: options?.abcdCut !== "C" });
  const fetchRssMs = Date.now() - fetchStartedAt;
  const chunks = splitItemChunks(xml);
  const guidExtractStartedAt = Date.now();
  const chunkGuids = chunks.map((chunk) => cheapGuid(chunk));
  const guidExtractMs = Date.now() - guidExtractStartedAt;
  const useFallback = chunkGuids.some((guid) => !guid.trim());
  let fullParseMs = 0;
  let fullParseCount = 0;
  let guidMismatchCount = 0;
  const seenGuids = new Set<string>();
  let candidates: RssInsertCandidate[] = [];
  if (useFallback) {
    const fullParseStartedAt = Date.now();
    const items = parseChunksFull(chunks);
    fullParseMs += Date.now() - fullParseStartedAt;
    fullParseCount += items.length;
    candidates = items.filter((item) => {
      if (seenGuids.has(item.guid)) return false;
      seenGuids.add(item.guid);
      return true;
    }).map((item) => ({ guid: item.guid, item }));
  } else {
    chunks.forEach((chunk, index) => {
      const guid = chunkGuids[index] ?? "";
      if (seenGuids.has(guid)) return;
      seenGuids.add(guid);
      candidates.push({ guid, chunk });
    });
  }
  const guids = candidates.map((candidate) => candidate.guid);
  const existingGuids = await queryExistingGuids(env, guids);
  let targetCandidates = candidates.filter((candidate) => !existingGuids.has(candidate.guid));
  const candidateInsertCount = targetCandidates.length;
  const maxNewPosts = options?.maxNewPosts;
  let capped = false;
  if (typeof maxNewPosts === "number" && Number.isFinite(maxNewPosts) && maxNewPosts >= 0 && targetCandidates.length > maxNewPosts) {
    targetCandidates = targetCandidates.slice(0, Math.floor(maxNewPosts));
    capped = true;
  }
  if (!useFallback) {
    const fullParseStartedAt = Date.now();
    const parsed: RssInsertCandidate[] = [];
    for (const candidate of targetCandidates) {
      const { item, guidMismatch } = parseChunkFull(candidate.chunk ?? "", candidate.guid);
      fullParseCount++;
      if (guidMismatch) guidMismatchCount++;
      if (item.guid && item.title && item.link) parsed.push({ guid: item.guid, item });
    }
    fullParseMs += Date.now() - fullParseStartedAt;
    targetCandidates = parsed;
  }
  if (guidMismatchCount > 0) console.warn("RSS GUID mismatch", JSON.stringify({ count: guidMismatchCount }));
  if (capped) console.warn("RSS insert capped", JSON.stringify({ cap: maxNewPosts, candidates: candidateInsertCount }));
  const parseItemsMs = guidExtractMs + fullParseMs;
  if (options?.abcdCut === "C") {
    // Cut C stops after the real fetch/GUID/parse prefix and before any
    // posts, FTS, sync_state, first_sync, or diagnostic write.
    return {
      inserted: 0,
      firstSync: false,
      insertedPosts: [],
      strategy,
      indexFailureCount: 0,
      abcdCut: "C",
      timings: {
        fetchRssMs: fetchTimings.fetchRssMs,
        fetchFirstStrategyMs: fetchTimings.fetchFirstStrategyMs,
        fetchRetryStrategyMs: fetchTimings.fetchRetryStrategyMs,
        parseItemsMs,
        parseItemCount: chunks.length,
        prepareInsertMs: 0,
        insertBindRunMs: 0,
        insertNewCount: 0,
        insertExistingCount: existingGuids.size,
        insertLoopMs: 0,
        insertPostsMs: 0,
        writeSyncStateMs: 0,
        totalMs: Date.now() - fetchStartedAt,
        guidExtractMs,
        guidExtractCount: chunks.length,
        fullParseMs,
        fullParseCount,
        guidMismatchCount,
        indexFailureCount: 0
      },
      cpu: { parseItemsMs, parseItemCount: chunks.length }
    };
  }
  const first = options?.firstSyncDone === undefined
    ? !(await one<{ value: string }>(env.DB.prepare("SELECT value FROM sync_state WHERE key = 'first_sync_done'")))
    : !options.firstSyncDone;
  let inserted = 0;
  let indexFailureCount = 0;
  let firstIndexFailure: unknown = null;
  const insertedPosts: RssNewPost[] = [];
  const insertedForIndex: Array<Pick<Post, "id" | "title" | "content_text">> = [];
  const insertStartedAt = Date.now();
  const prepareInsertStartedAt = Date.now();
  let insertRows = targetCandidates
    .filter((candidate): candidate is RssInsertCandidate & { item: RssItem } => Boolean(candidate.item))
    .map((candidate) => {
      const { item } = candidate;
      return { item, values: [item.guid, item.title, item.link, item.contentHtml, item.contentText, item.author || null, item.board || null, item.publishedAt, nowIso()] };
    });
  const prepareInsertMs = Date.now() - prepareInsertStartedAt;
  let insertBindRunMs = 0;
  let insertNewCount = 0;
  let insertExistingCount = existingGuids.size;
  const batchStartedAt = Date.now();
  const preMarkSearchIncomplete = shouldPreMarkSearchIncomplete(insertRows.length, initialSearchComplete);
  if (insertRows.length) {
    const sql = "INSERT OR IGNORE INTO posts (guid, title, link, content_html, content_text, author, board_key, published_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
    const statements = insertRows.map((row) => env.DB.prepare(sql).bind(...row.values));
    if (preMarkSearchIncomplete) {
      // Durability: complete=0 commits atomically with the posts themselves, so
      // the retry survives even when the later diagnostic writes fail.
      statements.push(env.DB.prepare("UPDATE search_index_state SET complete = 0, updated_at = ? WHERE id = 1").bind(nowIso()));
    }
    const results = await env.DB.batch(statements);
    for (let index = 0; index < insertRows.length; index++) {
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
        insertedForIndex.push({ id: result.meta.last_row_id, title: item.title, content_text: item.contentText });
      } else {
        insertExistingCount++;
      }
    }
  }
  if (insertedForIndex.length > 0) {
    try {
      await indexPostsForSearch(env, insertedForIndex);
    } catch (error) {
      // One merged FTS batch rolls back only the index writes; the posts above
      // are already committed, and complete=0 lets the cron backfill repair
      // every post left unindexed.
      indexFailureCount = 1;
      firstIndexFailure = error;
    }
  }
  const insertLoopMs = Date.now() - insertStartedAt;
  if (firstIndexFailure !== null) {
    try {
      await recordSearchIndexError(env, firstIndexFailure);
      await markSearchIndexRetryPending(env);
    } catch (error) {
      console.error("search index failure persist failed", error instanceof Error ? error.message : String(error));
    }
  }
  const writeStateStartedAt = Date.now();
  const restoreSearchComplete = preMarkSearchIncomplete && firstIndexFailure === null;
  await persistSyncSuccess(env, strategy, restoreSearchComplete ? { restoreSearchComplete } : undefined);
  const writeSyncStateMs = Date.now() - writeStateStartedAt;
  const insertPostsMs = insertLoopMs;
  insertBindRunMs = Date.now() - batchStartedAt;
  return { inserted, firstSync: first, insertedPosts, strategy, indexFailureCount, timings: { fetchRssMs: fetchTimings.fetchRssMs, fetchFirstStrategyMs: fetchTimings.fetchFirstStrategyMs, fetchRetryStrategyMs: fetchTimings.fetchRetryStrategyMs, parseItemsMs, parseItemCount: chunks.length, prepareInsertMs, insertBindRunMs, insertNewCount, insertExistingCount, insertLoopMs, insertPostsMs, writeSyncStateMs, totalMs: Date.now() - fetchStartedAt, guidExtractMs, guidExtractCount: chunks.length, fullParseMs, fullParseCount, guidMismatchCount, indexFailureCount }, cpu: { parseItemsMs, parseItemCount: chunks.length } };
}

export async function safeSyncRss(env: Env, options?: RssSyncOptions): Promise<SafeRssSyncResult> {
  try {
    const result = await syncRss(env, options);
    return { inserted: result.inserted, firstSync: result.firstSync, insertedPosts: result.insertedPosts, ok: true, strategy: result.strategy, timings: result.timings, cpu: result.cpu, abcdCut: result.abcdCut };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("RSS sync failed", message);
    // Cut C must leave no failure diagnostic behind; only the default path persists it.
    if (options?.abcdCut !== "C") {
      try {
        await persistSyncFailure(env, message);
      } catch (stateError) {
        console.error("RSS sync state persist failed", stateError instanceof Error ? stateError.message : String(stateError));
      }
    }
    return { inserted: 0, firstSync: false, insertedPosts: [], ok: false, error: message, timings: { fetchRssMs: 0, fetchFirstStrategyMs: 0, fetchRetryStrategyMs: 0, parseItemsMs: 0, parseItemCount: 0, prepareInsertMs: 0, insertBindRunMs: 0, insertNewCount: 0, insertExistingCount: 0, insertLoopMs: 0, insertPostsMs: 0, writeSyncStateMs: 0, totalMs: 0 }, cpu: { parseItemsMs: 0, parseItemCount: 0 } };
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

const attemptSampleLimit = 200;

export async function getRssAttemptDiagnostics(env: Env): Promise<RssAttemptDiagnostics> {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const rows = await all<RssAttemptLogRow>(env.DB.prepare(`SELECT created_at, source, method, outcome, status, status_text, error, preview FROM rss_fetch_attempts WHERE created_at >= ? AND outcome = 'failure' ORDER BY created_at DESC LIMIT ${attemptSampleLimit}`).bind(since));
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
    collectionMode: "failures-only",
    statsScope: "latest-200-failures-within-24h",
    sampleLimit: attemptSampleLimit,
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
