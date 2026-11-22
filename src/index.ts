import { accountInfo, currentUser, login, logout, newTelegramBindCode, register, updateEmail, updateTelegram } from "./auth";
import { cleanupOldData } from "./cleanup";
import { runMaintenanceCron } from "./cron-maintenance";
import { runNotificationCron } from "./cron-notify";
import { resolveCronRole } from "./cron-role";
import { all, json, readJson } from "./db";
import { DailyWriteQuotaExhaustedError, DB_PRUNE_BACKGROUND_QUERY_RESERVE, DB_PRUNE_CLAIM_QUERY_RESERVE, DB_PRUNE_DAILY_CAP, DB_PRUNE_PRUNE_QUERY_RESERVE, D1_FIVE_POST_MARGIN_MB, D1_FREE_MAX_CAPACITY_MB, D1_PAID_MAX_CAPACITY_MB, acquirePruneLease, buildAndVerifyReadStatesIndex, canClaimIndexBuild, claimIndexBuild, cleanupFtsOrphans, decodeIndexSnapshot, decideMaxNewPosts, isDailyWriteQuotaError, isPruneWindow, pruneOldPostsBySize, pruneThresholds, readCronState, readDatabaseSizeBytes, readIndexState, readIndexStateAfterLease, readPruneSettings, recoverIndexState, refreshPruneLease, releasePruneLease, runIsolated, isIndexDay, planBackgroundTasks, claimAbortsNormalWork, indexStateChanged } from "./prune";
import { D1_QUERY_LIMIT, DB_PRUNE_FINAL_QUERY_RESERVE, budgetRemaining, consumeQuery, createQueryBudget, markDailyWriteQuotaExhausted } from "./query-budget";
import type { CronStateSnapshot, IndexStateSnapshot, PruneRunResult } from "./prune";
import { queryPosts } from "./posts";
import { renderHome } from "./render";
import { createRunContext, emitRunLog, emitRunMeasureLog, noteFirstInIsolate, shouldRecordCronTiming } from "./observability";
import type { RunFieldValue } from "./observability";
import { createD1Metrics, createMeasuredDb, snapshotD1Metrics, withPhase } from "./d1-metrics";
import type { D1Metrics } from "./d1-metrics";
import { backfillSearchIndexes, recordSearchIndexError } from "./search";
import { getHighlightGroups, getInitialRulePayload } from "./rules";
import { readValidatedBlockImport, readValidatedHighlightImport, readValidatedSubscriptionImport, validatePatternInput } from "./rule-import";
import { getRssAttemptDiagnostics, recordCronTiming, safeSyncRss, testRssFetch } from "./rss";
import { enqueueRss } from "./ingest-producer";
import { processIngestMessage } from "./ingest-consumer";
import { claimInlineSyncMinute } from "./inline-gate";
import type { IngestMessageV1 } from "./ingest-message";
import { adminSettingsResponse, adminStatus, adminUsersResponse, deleteAdminUser, handleAdmin, isAdmin, runtimeSettings, updateAdminSettings } from "./settings";
import { createSubscription, initializeNotificationCursor, processNotifications } from "./subscriptions";
import type { CronTimingSnapshot, Env, HomeTimingSnapshot, HomeTimings, User } from "./types";

const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="NodeSeek RSS Reader"><rect width="128" height="128" rx="30" fill="#fff"/><rect x="8" y="8" width="112" height="112" rx="24" fill="none" stroke="#111" stroke-width="8"/><path d="M34 35h16l31 43V35h15v58H80L49 50v43H34z" fill="#111"/><circle cx="38" cy="91" r="8" fill="#111"/><path d="M34 67c15 0 27 12 27 27" fill="none" stroke="#111" stroke-width="8" stroke-linecap="round"/><path d="M34 49c25 0 45 20 45 45" fill="none" stroke="#111" stroke-width="8" stroke-linecap="round"/></svg>`;
const manifest = { name: "NodeSeek RSS Reader", short_name: "NodeSeek RSS", start_url: "/", display: "standalone", background_color: "#000000", theme_color: "#000000", icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }] };
// Static interstitial shell for post links (/go?v=2#p=<post id>&u=<encoded source URL>).
// Card hrefs are root-relative, so every custom domain resolves to its own /go. Post
// params travel in the URL FRAGMENT on purpose: fragments never reach the server and do
// not participate in the HTTP cache key, so every post shares the single /go?v=2 cache
// entry (about 1KB per domain, one Worker request per domain per shell version). The
// ?v= query stays in the cache key as the version lever: bump it to invalidate every
// cached shell at once. The shell is fully silent (owner request: 纯静默跳转): no title,
// no visible success text — the browser's theme-colored blank page is all the user sees.
// The shell runs client-side only: validate u against nodeseek.com
// hosts (anti open-redirect), broadcast the post id so already-open list tabs turn red,
// send the read receipt via keepalive fetch (server-side INSERT OR REPLACE is idempotent),
// then location.replace(u) so the back button returns to the list. The server never redirects.
const goInterstitialHtml = String.raw`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer"></head><body><script>(function(){var q=new URLSearchParams(location.hash.slice(1));var target=q.get('u')||'';var ok=false;try{ok=/^(?:[a-z0-9-]+\.)*nodeseek\.com$/i.test(new URL(target).hostname)}catch(e){}if(!ok){document.body.innerHTML='<p style="font-family:system-ui;padding:2rem;line-height:1.6">链接无效或已过期，<a href="/">返回首页</a>。</p>';return}var id=Number(q.get('p')||0);if(Number.isInteger(id)&&id>0){try{var ch=new BroadcastChannel('nd-read');ch.postMessage({postId:id});ch.close()}catch(e){}fetch('/api/read-state',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({postId:id}),keepalive:true}).catch(function(){})}location.replace(target)})();</script></body></html>`;

function goInterstitial(): Response {
  return new Response(goInterstitialHtml, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" } });
}

function requireUser(user: User | null): Response | null {
  return user ? null : json({ error: "需要登录" }, 401);
}

function isQuotaStop(error: unknown): boolean {
  return error instanceof DailyWriteQuotaExhaustedError || isDailyWriteQuotaError(error);
}

// Prefix accounting for the one explicit QueryBudget. The fixed six are the
// index-state/lease reads, the merged prune settings read, and the pre-sync
// size probe; inline mode adds the one per-minute sync claim, and sync adds the
// first_sync_done read + sync_state write batch, one GUID chunk per 100 feed
// GUIDs, the insert batch, one merged inline FTS index batch, and an
// index-failure diagnostic pair. Notification dispatch consumes
// this same budget itself, so only the first-sync cursor bootstrap (max(id) +
// one cursor upsert batch) is charged here as a fixed ceiling. Cleanup (8) and
// recordCronTiming (1) run after creation but before the first gate; the lease
// can be refreshed twice outside the budget (before claim, then before prune).
// Numbers are ceilings: overestimating only makes a phase wait one more minute.
const PRE_BUDGET_QUERY_CEILING = 6;
const SYNC_STATE_QUERY_CEILING = 2;
// syncRss stops attempting inline indexing after the first failure and emits
// exactly one record+retry-pending diagnostic pair, so this is a true bound.
const SEARCH_INDEX_FAILURE_QUERY_CEILING = 2;
const FIRST_SYNC_CURSOR_QUERY_CEILING = 2;
// 1 last_cleanup_at read + 1 batched settings read + 5 retention deletes +
// 1 final sync_state batch.
const CLEANUP_QUERY_CEILING = 8;
const LEASE_REFRESH_QUERY_CEILING = 2;
const CRON_TIMING_QUERY_CEILING = 1;

// A failed sync may have completed most insert/index work before throwing, and
// its result carries zeroed timings, so charge the full one-window ceiling:
// 1 first_sync read + ≤1 GUID dedupe + 1 insert batch + 1 merged inline FTS
// batch + ≤2 index-failure diagnostics + 1 sync_state success batch +
// 1 RSS failure attempt log + 1 failure state batch ≈ 10. 30 keeps margin.
const SYNC_FAILURE_QUERY_CEILING = 30;

// Queue mode keeps all insert/index work out of this invocation: 1 first-sync
// read (done + snapshot + window start), ≤1 feed GUID existence query, ≤1
// snapshot/window-start batch or ≤1 window-start repair, ≤1 first-sync
// completion batch, ≤1 first-sync incomplete diagnostic, 1 success state batch,
// and one attempt log per failed fetch strategy → ≈9. 10 keeps margin.
const QUEUE_SYNC_QUERY_CEILING = 10;

interface CronMeasureInput {
  cron: string;
  cronRole: string;
  mode: string;
  scriptVersion: string;
  inlineClaim: string;
  inserted: number;
  indexFailureCount: number;
  notificationAttempts: number;
  cleanupRan: boolean;
  indexState: string;
  pruneCalled: boolean;
  backfillCalled: boolean;
}

function cronMeasureFields(metrics: D1Metrics, input: CronMeasureInput): Record<string, RunFieldValue> {
  const snapshot = snapshotD1Metrics(metrics);
  return {
    cron: input.cron,
    role: input.cronRole,
    mode: input.mode,
    scriptVersion: input.scriptVersion,
    inlineClaim: input.inlineClaim,
    d1Calls: snapshot.calls,
    d1BatchCalls: snapshot.batchCalls,
    d1DurationMs: Math.round(snapshot.durationMs),
    d1RowsRead: snapshot.rowsRead,
    d1RowsWritten: snapshot.rowsWritten,
    d1SizeAfter: snapshot.sizeAfter,
    d1PhaseCounts: JSON.stringify(snapshot.phaseCounts),
    inserted: input.inserted,
    indexFailureCount: input.indexFailureCount,
    notificationAttempts: input.notificationAttempts,
    cleanupDue: input.cleanupRan,
    indexState: input.indexState,
    pruneCalled: input.pruneCalled,
    backfillCalled: input.backfillCalled
  };
}

function estimatePrefixQueries(result: Awaited<ReturnType<typeof safeSyncRss>>, ingestMode: "inline" | "queue"): number {
  if (ingestMode === "queue") {
    return PRE_BUDGET_QUERY_CEILING + QUEUE_SYNC_QUERY_CEILING + (result.ok ? 0 : 2) + CLEANUP_QUERY_CEILING + LEASE_REFRESH_QUERY_CEILING + CRON_TIMING_QUERY_CEILING;
  }
  // The inline per-minute sync claim runs before the sync body and is one D1 call.
  const preBudget = PRE_BUDGET_QUERY_CEILING + 1;
  if (!result.ok) return preBudget + SYNC_FAILURE_QUERY_CEILING;
  const feedCount = result.timings?.parseItemCount ?? 0;
  const newCount = result.timings?.insertNewCount ?? result.inserted;
  const indexFailures = result.timings?.indexFailureCount ?? 0;
  return preBudget
    + SYNC_STATE_QUERY_CEILING
    + Math.ceil(feedCount / 100)
    + 1
    + (newCount > 0 ? 1 : 0)
    + (indexFailures > 0 ? SEARCH_INDEX_FAILURE_QUERY_CEILING : 0)
    + (result.firstSync ? FIRST_SYNC_CURSOR_QUERY_CEILING : 0)
    + CLEANUP_QUERY_CEILING
    + LEASE_REFRESH_QUERY_CEILING
    + CRON_TIMING_QUERY_CEILING;
}

async function listHighlights(env: Env, user: User): Promise<Response> {
  return json(await getHighlightGroups(env, user));
}

async function handleApi(request: Request, env: Env, user: User | null, url: URL): Promise<Response> {
  const path = url.pathname;
  if (path === "/api/debug/status" && request.method === "GET") return debugStatus(request, env);
  if (path === "/api/admin/settings" && request.method === "GET") return adminSettingsResponse(request, env);
  if (path === "/api/admin/settings" && request.method === "PUT") return updateAdminSettings(request, env);
  if (path === "/api/admin/users" && request.method === "GET") return adminUsersResponse(request, env);
  const adminUserMatch = /^\/api\/admin\/users\/(\d+)$/.exec(path);
  if (adminUserMatch && request.method === "DELETE") return deleteAdminUser(request, env, Number(adminUserMatch[1]));
  if (path === "/api/auth/register" && request.method === "POST") return register(request, env);
  if (path === "/api/auth/login" && request.method === "POST") return login(request, env);
  if (path === "/api/auth/logout" && request.method === "POST") return logout(request, env);
  if (path === "/api/me") return json(user);
  const notAuthed = requireUser(user);
  if (notAuthed) return notAuthed;
  const me = user!;

  if (path === "/api/notification-settings") {
    const settings = await runtimeSettings(env);
    return json({ telegramBotUsername: settings.telegramBotUsername, telegramBotConfigured: !!settings.telegramBotToken, mailConfigured: !!settings.mailFrom });
  }
  if (path === "/api/account") return json(await accountInfo(env, me));
  if (path === "/api/posts") return json(await queryPosts(env, me, url));
  if (path === "/api/rss-test") return json({ results: await testRssFetch(env), timestamp: new Date().toISOString() });
  if (path === "/api/read-state" && request.method === "POST") {
    const body = await readJson<{ postId?: number }>(request);
    const postId = Number(body.postId || 0);
    if (!postId) return json({ error: "postId required" }, 400);
    await env.DB.prepare("INSERT OR REPLACE INTO read_states (user_id, post_id, opened_at) VALUES (?, ?, datetime('now'))").bind(me.id, postId).run();
    return json({ ok: true });
  }
  if (path === "/api/me/email" && request.method === "PUT") return updateEmail(request, env, me);
  if (path === "/api/me/telegram" && request.method === "PUT") return updateTelegram(request, env, me);
  if (path === "/api/highlight-groups" && request.method === "GET") return listHighlights(env, me);
  if (path === "/api/highlight-groups" && request.method === "POST") {
    const body = await readJson<{ name?: string; color?: string }>(request);
    const name = (body.name || "").trim();
    const color = /^#[0-9a-f]{6}$/i.test(body.color || "") ? body.color! : "#ffe066";
    if (!name) return json({ error: "分组名不能为空" }, 400);
    const result = await env.DB.prepare("INSERT INTO highlight_groups (user_id, name, color, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))").bind(me.id, name, color).run();
    return json({ ok: true, id: Number(result.meta.last_row_id), name, color, patterns: [] });
  }
  const groupMatch = /^\/api\/highlight-groups\/(\d+)(\/clear)?$/.exec(path);
  if (groupMatch) {
    const groupId = Number(groupMatch[1]);
    const owned = await env.DB.prepare("SELECT id FROM highlight_groups WHERE id = ? AND user_id = ?").bind(groupId, me.id).first();
    if (!owned) return json({ error: "不存在" }, 404);
    if (request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM highlight_rules WHERE group_id = ?").bind(groupId).run();
      await env.DB.prepare("DELETE FROM highlight_groups WHERE id = ?").bind(groupId).run();
      return json({ ok: true });
    }
    if (request.method === "POST" && groupMatch[2]) {
      await env.DB.prepare("DELETE FROM highlight_rules WHERE group_id = ?").bind(groupId).run();
      return json({ ok: true });
    }
    if (request.method === "PUT") {
      const body = await readJson<{ name?: string; color?: string; patterns?: string[] }>(request);
      const rawPatterns = Array.isArray(body.patterns) ? body.patterns : [];
      const details: { field: string; index: number; reason: string }[] = [];
      const patterns: string[] = [];
      for (const [patternIndex, rawPattern] of rawPatterns.entries()) {
        const result = validatePatternInput(rawPattern);
        if (result.ok) patterns.push(result.pattern);
        else details.push({ field: `patterns[${patternIndex}]`, index: patternIndex, reason: result.reason });
      }
      const name = (body.name || "").trim() || "未命名";
      const color = /^#[0-9a-f]{6}$/i.test(body.color || "") ? body.color! : "#ffe066";
      // Validate the whole replacement payload before any mutation: a PUT with
      // one invalid pattern must not delete the group's existing rules.
      if (details.length > 0) return json({ error: "规则数据无效", details }, 400);
      await env.DB.prepare("UPDATE highlight_groups SET name = ?, color = ?, updated_at = datetime('now') WHERE id = ?").bind(name, color, groupId).run();
      await env.DB.prepare("DELETE FROM highlight_rules WHERE group_id = ?").bind(groupId).run();
      for (const pattern of patterns) {
        await env.DB.prepare("INSERT INTO highlight_rules (group_id, pattern, created_at) VALUES (?, ?, datetime('now'))").bind(groupId, pattern).run();
      }
      return json({ ok: true });
    }
  }
  if (path === "/api/block-rules" && request.method === "GET") return json(await all(env.DB.prepare("SELECT id, pattern FROM block_rules WHERE user_id = ? ORDER BY id ASC").bind(me.id)));
  if (path === "/api/block-rules" && request.method === "POST") {
    const body = await readJson<{ pattern?: string }>(request);
    const result = validatePatternInput(body.pattern ?? "");
    if (!result.ok) return json({ error: result.reason }, 400);
    const insert = await env.DB.prepare("INSERT INTO block_rules (user_id, pattern, created_at) VALUES (?, ?, datetime('now'))").bind(me.id, result.pattern).run();
    return json({ ok: true, id: Number(insert.meta.last_row_id), pattern: result.pattern });
  }
  if (path === "/api/block-rules/clear" && request.method === "POST") {
    await env.DB.prepare("DELETE FROM block_rules WHERE user_id = ?").bind(me.id).run();
    return json({ ok: true });
  }
  const blockMatch = /^\/api\/block-rules\/(\d+)$/.exec(path);
  if (blockMatch && request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM block_rules WHERE id = ? AND user_id = ?").bind(Number(blockMatch[1]), me.id).run();
    return json({ ok: true });
  }
  if (path === "/api/subscriptions" && request.method === "GET") return json(await all(env.DB.prepare("SELECT id, pattern, send_email, send_telegram FROM subscriptions WHERE user_id = ? ORDER BY id ASC").bind(me.id)));
  if (path === "/api/subscriptions" && request.method === "POST") return createSubscription(request, env, me);
  if (path === "/api/subscriptions/clear" && request.method === "POST") {
    await env.DB.prepare("DELETE FROM subscriptions WHERE user_id = ?").bind(me.id).run();
    return json({ ok: true });
  }
  const subMatch = /^\/api\/subscriptions\/(\d+)$/.exec(path);
  if (subMatch && request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM subscriptions WHERE id = ? AND user_id = ?").bind(Number(subMatch[1]), me.id).run();
    return json({ ok: true });
  }
  if (path === "/api/export/highlights") return listHighlights(env, me);
  if (path === "/api/export/blocks") return json(await all(env.DB.prepare("SELECT pattern FROM block_rules WHERE user_id = ? ORDER BY id ASC").bind(me.id)));
  if (path === "/api/export/subscriptions") return json(await all(env.DB.prepare("SELECT pattern, send_email, send_telegram FROM subscriptions WHERE user_id = ? ORDER BY id ASC").bind(me.id)));
  if (path === "/api/import/highlights" && request.method === "POST") return importHighlights(request, env, me);
  if (path === "/api/import/blocks" && request.method === "POST") return importBlocks(request, env, me);
  if (path === "/api/import/subscriptions" && request.method === "POST") return importSubscriptions(request, env, me);
  return json({ error: "Not found" }, 404);
}

function parseSyncCursorId(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function debugStatus(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "管理员 token 不正确" }, 401);
  const url = new URL(request.url);
  const live = url.searchParams.get("live") === "1";
  const startedAt = Date.now();
  const timings: Record<string, number> = {};
  const measure = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    const value = await fn();
    timings[key] = Date.now() - t0;
    return value;
  };
  const tableRows = await measure("tablesMs", async () => all<{ name: string }>(env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('posts', 'users', 'sync_state', 'app_settings')")));
  const tableNames = new Set(tableRows.map((row) => row.name));
  const syncRows = await measure("syncStateMs", async () => all<{ key: string; value: string; updated_at: string }>(env.DB.prepare("SELECT key, value, updated_at FROM sync_state ORDER BY updated_at DESC")));
  const sync = Object.fromEntries(syncRows.map((row) => [row.key, { value: row.value, updatedAt: row.updated_at }]));
  const latestPost = await measure("latestPostMs", async () => env.DB.prepare("SELECT guid, title, link, published_at, fetched_at FROM posts ORDER BY published_at DESC LIMIT 1").first<{ guid: string; title: string; link: string; published_at: string; fetched_at: string }>());
  const rssResults = live ? await measure("rssTestMs", async () => testRssFetch(env)) : [];
  const rssDiagnostics = await measure("rssDiagnosticsMs", async () => getRssAttemptDiagnostics(env));
  const lastHomeTiming = await measure("homeTimingMs", async () => getLastHomeTiming(env));
  const lastCronTiming = await measure("cronTimingMs", async () => getLastCronTiming(env));
  // Cheap point-read only: building/lastError summary, never counts or cursors.
  const searchIndexState = await measure("searchIndexMs", async () => env.DB.prepare("SELECT complete FROM search_index_state WHERE id = 1").first<{ complete: number }>());
  const storage = await measure("storageMs", async () => {
    const sizeBytes = await readDatabaseSizeBytes(env).catch((error: unknown) => {
      console.error("readDatabaseSizeBytes failed", error instanceof Error ? error.message : String(error));
      return null;
    });
    // Derived from the sync_state map already fetched above; no extra query.
    const indexEntry = sync["db_prune_index_state"];
    const indexState = decodeIndexSnapshot(indexEntry?.value ?? null, indexEntry?.updatedAt ?? null, indexEntry !== undefined);
    const indexDay = indexState.value === "2" ? isIndexDay(indexState) : false;
    const deletedRaw = sync["db_prune_deleted_today"]?.value ?? "";
    const deleted = Number(deletedRaw);
    const base = {
      sizeBytes,
      active: sync["db_prune_active"]?.value === "1",
      deletedToday: Number.isFinite(deleted) && deleted > 0 ? Math.floor(deleted) : 0,
      lastPruneAt: sync["db_prune_last_at"]?.value || null,
      lastPruneError: sync["db_prune_last_error"]?.value || null,
      blockedFull: sync["db_prune_blocked_full"]?.value === "1",
      indexState: indexState.value,
      indexStateRaw: indexState.raw,
      indexStateInvalid: indexState.invalid,
      indexDay,
      dailyCap: DB_PRUNE_DAILY_CAP
    };
    let paidPlan: boolean;
    let limitMb: number;
    try {
      const pruneSettings = await readPruneSettings(env);
      paidPlan = pruneSettings.paidPlan;
      limitMb = pruneSettings.limitMb;
    } catch (error) {
      return { ...base, paidPlan: null, limitBytes: null, targetBytes: null, maxCapacityBytes: null, fivePostThresholdBytes: null, error: error instanceof Error ? error.message : String(error) };
    }
    const { limitBytes, targetBytes } = pruneThresholds(limitMb, paidPlan);
    const maxCapacityBytes = (paidPlan ? D1_PAID_MAX_CAPACITY_MB : D1_FREE_MAX_CAPACITY_MB) * 1_000_000;
    const fivePostThresholdBytes = Math.max(0, maxCapacityBytes - D1_FIVE_POST_MARGIN_MB * 1_000_000);
    return { ...base, paidPlan, limitBytes, targetBytes, maxCapacityBytes, fivePostThresholdBytes };
  });
  const latestRss = rssResults.find((result) => result.success && result.latestGuid);
  let missingFromDb: string[] = [];
  if (latestRss?.latestGuid && latestPost?.guid) {
    const latestRssId = Number(latestRss.latestGuid);
    const latestDbId = Number(latestPost.guid);
    if (Number.isFinite(latestRssId) && Number.isFinite(latestDbId) && latestRssId > latestDbId) {
      missingFromDb = Array.from({ length: latestRssId - latestDbId }, (_value, index) => String(latestDbId + index + 1));
    }
  }
  return json({
    ok: true,
    timestamp: new Date().toISOString(),
    timings: { ...timings, totalMs: Date.now() - startedAt },
    worker: { dbBinding: !!env.DB, rssUrl: env.RSS_URL || "https://rss.nodeseek.com/", adminSecretConfigured: !!env.ADMIN_SECRET },
    database: {
      tables: { posts: tableNames.has("posts"), users: tableNames.has("users"), sync_state: tableNames.has("sync_state"), app_settings: tableNames.has("app_settings") },
      latestPost
    },
    sync: {
      lastSyncAt: sync.last_sync_at?.value || "",
      lastSyncError: sync.last_sync_error?.value || "",
      lastSyncStrategy: sync.last_sync_strategy?.value || "",
      firstSyncDone: sync.first_sync_done?.value === "1",
      lastCleanupAt: sync.last_cleanup_at?.value || "",
      rows: syncRows
    },
    notifications: {
      cursorPostId: parseSyncCursorId(sync["notification_cursor_post_id"]?.value),
      cursorSubscriptionId: parseSyncCursorId(sync["notification_cursor_subscription_id"]?.value),
      cursorChannel: sync["notification_cursor_channel"]?.value ?? ""
    },
    home: lastHomeTiming,
    cronTiming: lastCronTiming,
    searchIndex: { building: searchIndexState?.complete !== 1, lastError: sync.last_search_index_error?.value || "" },
    storage,
    rss: { live, ok: live ? !!latestRss : null, latestItem: latestRss ? { guid: latestRss.latestGuid, title: latestRss.latestTitle, link: latestRss.latestLink, publishedAt: latestRss.latestPublishedAt } : null, itemCount: latestRss?.itemCount || 0, missingFromDb, results: rssResults, collectionMode: rssDiagnostics.collectionMode, statsScope: rssDiagnostics.statsScope, sampleLimit: rssDiagnostics.sampleLimit, attemptStats: rssDiagnostics.attemptStats, failureSummary: rssDiagnostics.failureSummary }
  });
}

async function getLastCronTiming(env: Env): Promise<CronTimingSnapshot | null> {
  const row = await env.DB.prepare("SELECT value, updated_at FROM sync_state WHERE key = 'last_cron_timing' LIMIT 1").first<{ value: string; updated_at: string }>();
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value) as CronTimingSnapshot;
    return { ...parsed, recordedAt: row.updated_at || parsed.recordedAt };
  } catch {
    return null;
  }
}

async function getLastHomeTiming(env: Env): Promise<HomeTimingSnapshot | null> {
  const row = await env.DB.prepare("SELECT value, updated_at FROM sync_state WHERE key = 'last_home_timing' LIMIT 1").first<{ value: string; updated_at: string }>();
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value) as HomeTimingSnapshot;
    return { ...parsed, recordedAt: row.updated_at || parsed.recordedAt };
  } catch {
    return null;
  }
}

async function storeLastHomeTiming(env: Env, snapshot: HomeTimingSnapshot): Promise<void> {
  await env.DB.prepare("INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES ('last_home_timing', ?, ?)").bind(JSON.stringify(snapshot), snapshot.recordedAt).run();
}

async function importHighlights(request: Request, env: Env, user: User): Promise<Response> {
  const outcome = await readValidatedHighlightImport(request);
  if (!outcome.ok) return outcome.response;
  const groupIdSeed = Date.now() * 1000 + crypto.getRandomValues(new Uint32Array(1))[0];
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM highlight_rules WHERE group_id IN (SELECT id FROM highlight_groups WHERE user_id = ?)").bind(user.id),
    env.DB.prepare("DELETE FROM highlight_groups WHERE user_id = ?").bind(user.id)
  ];
  for (const [groupIndex, group] of outcome.value.entries()) {
    const groupId = groupIdSeed + groupIndex;
    statements.push(env.DB.prepare("INSERT INTO highlight_groups (id, user_id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))").bind(groupId, user.id, group.name, group.color));
    // Insert patterns in input order so import/export and the settings page preserve sequence.
    for (const pattern of group.patterns) {
      statements.push(env.DB.prepare("INSERT INTO highlight_rules (group_id, pattern, created_at) VALUES ((SELECT id FROM highlight_groups WHERE id = ? AND user_id = ?), ?, datetime('now'))").bind(groupId, user.id, pattern));
    }
  }
  try {
    await env.DB.batch(statements);
  } catch (error) {
    console.error("Highlight import batch failed", error);
    return json({ error: "高亮规则导入失败" }, 500);
  }
  return json({ ok: true });
}

async function importBlocks(request: Request, env: Env, user: User): Promise<Response> {
  const outcome = await readValidatedBlockImport(request);
  if (!outcome.ok) return outcome.response;
  const statements: D1PreparedStatement[] = [env.DB.prepare("DELETE FROM block_rules WHERE user_id = ?").bind(user.id)];
  for (const pattern of outcome.value) {
    statements.push(env.DB.prepare("INSERT INTO block_rules (user_id, pattern, created_at) VALUES (?, ?, datetime('now'))").bind(user.id, pattern));
  }
  try {
    await env.DB.batch(statements);
  } catch (error) {
    console.error("Block import batch failed", error);
    return json({ error: "屏蔽规则导入失败" }, 500);
  }
  return json({ ok: true });
}

async function importSubscriptions(request: Request, env: Env, user: User): Promise<Response> {
  const outcome = await readValidatedSubscriptionImport(request);
  if (!outcome.ok) return outcome.response;
  const statements: D1PreparedStatement[] = [env.DB.prepare("DELETE FROM subscriptions WHERE user_id = ?").bind(user.id)];
  for (const rule of outcome.value) {
    statements.push(env.DB.prepare("INSERT INTO subscriptions (user_id, pattern, send_email, send_telegram, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))").bind(user.id, rule.pattern, rule.sendEmail ? 1 : 0, rule.sendTelegram ? 1 : 0));
  }
  try {
    await env.DB.batch(statements);
  } catch (error) {
    console.error("Subscription import batch failed", error);
    return json({ error: "订阅导入失败" }, 500);
  }
  return json({ ok: true });
}

async function handleTelegram(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ message?: { text?: string; chat?: { id?: number } } }>(request);
  const text = body.message?.text?.trim() || "";
  const chatId = body.message?.chat?.id;
  if (!chatId || !text) return json({ ok: true });
  const code = text.replace(/^\/start\s*/, "").trim();
  if (code) {
    const user = await env.DB.prepare("SELECT id, telegram_bind_code_expires_at FROM users WHERE telegram_bind_code = ? LIMIT 1").bind(code).first<{ id: number; telegram_bind_code_expires_at: string | null }>();
    if (user?.telegram_bind_code_expires_at && new Date(user.telegram_bind_code_expires_at).getTime() > Date.now()) {
      const next = newTelegramBindCode();
      await env.DB.prepare("UPDATE users SET telegram_chat_id = ?, telegram_bind_code = ?, telegram_bind_code_expires_at = ?, updated_at = datetime('now') WHERE id = ?").bind(String(chatId), next.code, next.expiresAt, user.id).run();
    }
  }
  return json({ ok: true });
}

function missingDbResponse(request: Request): Response {
  const message = "Cloudflare D1 binding DB is missing. Redeploy with build command `npm run deploy`, or add a D1 binding named DB to this Worker.";
  if (new URL(request.url).pathname.startsWith("/api/") || new URL(request.url).pathname === "/health") return json({ ok: false, error: message, dbBinding: false }, 500);
  return new Response(`<!doctype html><meta charset="utf-8"><title>NodeSeek RSS Reader Setup Error</title><body style="font-family:system-ui;margin:2rem;line-height:1.6"><h1>NodeSeek RSS Reader</h1><p>${message}</p><p>Open <code>/health</code> after fixing the binding.</p></body>`, { status: 500, headers: { "content-type": "text/html; charset=utf-8" } });
}

async function health(env: Env): Promise<Response> {
  if (!env.DB) return json({ ok: false, dbBinding: false, tables: {} }, 500);
  try {
    const rows = await all<{ name: string }>(env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('posts', 'users', 'sync_state')"));
    const names = new Set(rows.map((row) => row.name));
    const tables = { posts: names.has("posts"), users: names.has("users"), sync_state: names.has("sync_state") };
    return json({ ok: Object.values(tables).every(Boolean), dbBinding: true, tables }, Object.values(tables).every(Boolean) ? 200 : 500);
  } catch (error) {
    return json({ ok: false, dbBinding: true, error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const isHomeRoute = url.pathname === "/" || /^\/page\/\d+$/.test(url.pathname);
  const homeTimings: HomeTimings | undefined = isHomeRoute ? { queryPosts: {}, render: {} } : undefined;
  const homeStart = isHomeRoute ? Date.now() : 0;
  if (url.pathname === "/icon.svg") return new Response(iconSvg, { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=86400" } });
  if (url.pathname === "/manifest.webmanifest") return json(manifest, 200, { "cache-control": "public, max-age=86400" });
  if (url.pathname === "/go") return goInterstitial();
  if (url.pathname === "/health") return health(env);
  if (!env.DB) return missingDbResponse(request);
  if (url.pathname === "/admin") return handleAdmin(request, env);
  const authStart = isHomeRoute ? Date.now() : 0;
  const user = await currentUser(request, env);
  if (homeTimings) homeTimings.authMs = Date.now() - authStart;
  if (url.pathname.startsWith("/api/")) return handleApi(request, env, user, url);
  if (url.pathname === "/telegram/webhook" && request.method === "POST") return handleTelegram(request, env);
  if (isHomeRoute && homeTimings) {
    const pageData = await queryPosts(env, user, url, homeTimings.queryPosts);
    const initialRules = await getInitialRulePayload(env, user, url.searchParams.get("rulesVersion"), url.searchParams.get("rulesCache") === "1");
    const adminStatusStart = Date.now();
    const admin = await adminStatus(request, env);
    homeTimings.adminStatusMs = Date.now() - adminStatusStart;
    const response = await renderHome(env, user, pageData, admin, homeTimings, initialRules);
    homeTimings.totalMs = Date.now() - homeStart;
    ctx.waitUntil(storeLastHomeTiming(env, { path: url.pathname, query: url.searchParams.get("q") || "", board: url.searchParams.get("board") || "", page: pageData.page, user: !!user, postCount: pageData.posts.length, recordedAt: new Date().toISOString(), timings: homeTimings }).catch((error: unknown) => console.error("storeLastHomeTiming failed", error instanceof Error ? error.message : String(error))));
    return response;
  }
  return new Response("Not found", { status: 404 });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    noteFirstInIsolate();
    try {
      return await handleFetch(request, env, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (new URL(request.url).pathname.startsWith("/api/")) return json({ ok: false, error: message }, 500);
      return new Response(`<!doctype html><meta charset="utf-8"><title>NodeSeek RSS Reader Error</title><body style="font-family:system-ui;margin:2rem;line-height:1.6"><h1>NodeSeek RSS Reader Error</h1><pre style="white-space:pre-wrap">${message.replace(/[&<>'"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[ch] || ch))}</pre><p>Check <code>/health</code> and Cloudflare Worker bindings.</p></body>`, { status: 500, headers: { "content-type": "text/html; charset=utf-8" } });
    }
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const role = resolveCronRole(event.cron);
    const ingestMode = env.INGEST_MODE === "queue" ? "queue" : "inline";
    // MEASURE_CRON is a temporary inline-only switch. Flag off keeps the real
    // binding untouched; the swap below happens before the inline gate so the
    // gate claim itself is counted.
    const measure = ingestMode === "inline" && env.MEASURE_CRON === "1" && !!env.DB;
    const run = createRunContext("cron", noteFirstInIsolate(), measure);
    const metrics = measure ? createD1Metrics() : null;
    if (metrics) env = { ...env, DB: createMeasuredDb(env.DB, metrics) };
    let inlineClaim = "not_attempted";
    let cleanupRan = false;
    let pruneCalled = false;
    let backfillCalled = false;
    const measureSummary = { inserted: 0, indexFailureCount: 0, notificationAttempts: 0 };
    console.log(JSON.stringify({ event: "cron_route", cron: event.cron, role, mode: ingestMode }));
    if (ingestMode === "inline") {
      // Inline mode has no queue to absorb work, so every recognized trigger
      // competes for the single per-UTC-minute sync claim. If the platform
      // merges the three every-minute expressions (or fires one twice), the
      // winner runs the sync body no matter which role it reports; the rest
      // skip. Unknown expressions still do nothing.
      if (role === "unknown") {
        emitRunLog(run, "skipped", "role_unknown");
        return;
      }
      if (!env.DB) {
        emitRunLog(run, "failed", "missing_db");
        throw new Error("Cloudflare D1 binding DB is missing");
      }
      const claimed = await withPhase(metrics, "gate", () => claimInlineSyncMinute(env));
      inlineClaim = claimed ? "won" : "duplicate";
      if (measure) run.fields.inlineClaim = inlineClaim;
      if (!claimed) {
        emitRunLog(run, "skipped", "inline_tick_duplicate");
        return;
      }
    } else {
      if (role === "notify") {
        if (!env.DB) {
          emitRunLog(run, "failed", "missing_db");
          return;
        }
        await runNotificationCron(env, ctx, run);
        return;
      }
      if (role === "maintenance") {
        if (!env.DB) {
          emitRunLog(run, "failed", "missing_db");
          return;
        }
        await runMaintenanceCron(env, ctx, run);
        return;
      }
      if (role !== "sync") {
        emitRunLog(run, "skipped", `role_${role}`);
        return;
      }
      if (!env.DB) {
        emitRunLog(run, "failed", "missing_db");
        throw new Error("Cloudflare D1 binding DB is missing");
      }
    }

    let context: CronStateSnapshot;
    try {
      context = await withPhase(metrics, "state", () => readCronState(env));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isQuotaStop(error)) {
        console.error("d1_daily_write_quota_exhausted", "initial_state", message);
      } else {
        console.error("readCronState failed; skipping scheduled work", message);
      }
      emitRunLog(run, "failed", "read_cron_state");
      return;
    }
    let indexState = context.indexState;
    let searchComplete = context.searchComplete;
    if (indexState.invalid) {
      console.error("Invalid db_prune_index_state value; keeping it and disabling index/prune", indexState.raw);
    }
    // State-1 recovery may run in an overlapping invocation, but only the
    // observed updated_at can prove the holder is gone. Recovery itself never
    // starts normal work: this invocation ends unconditionally after one
    // recovery attempt, whatever state (or error) it produces.
    if (!indexState.invalid && indexState.value === "1") {
      try {
        await withPhase(metrics, "state", () => recoverIndexState(env, indexState));
      } catch (error) {
        console.error("recoverIndexState failed; ending invocation", error instanceof Error ? error.message : String(error));
      }
      emitRunLog(run, "maintenance", "index_state_1");
      return;
    }

    // The merged prune-settings read, size probe, and readCronState are the
    // complete pre-lease prefix; they run exactly once per invocation.
    const startedAt = Date.now();
    let settingsOk = true;
    let paidKnown = false;
    let paidPlan = false;
    let limitMb = 0;
    try {
      const pruneSettings = await withPhase(metrics, "settings", () => readPruneSettings(env));
      paidPlan = pruneSettings.paidPlan;
      limitMb = pruneSettings.limitMb;
      paidKnown = true;
    } catch (error) {
      if (isQuotaStop(error)) {
        console.error("prune settings read hit D1 daily write quota; ending invocation", error instanceof Error ? error.message : String(error));
        emitRunLog(run, "failed", "settings_quota");
        return;
      }
      settingsOk = false;
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 200);
      console.error("prune_settings_read_failed", JSON.stringify({ key: "prune_settings", message }));
    }

    let sizeProbe: number | null = null;
    try {
      sizeProbe = await withPhase(metrics, "size", () => readDatabaseSizeBytes(env));
    } catch (error) {
      if (isQuotaStop(error)) {
        console.error("readDatabaseSizeBytes hit D1 daily write quota; ending invocation", error instanceof Error ? error.message : String(error));
        emitRunLog(run, "failed", "size_probe_quota");
        return;
      }
      console.error("readDatabaseSizeBytes before sync failed", error instanceof Error ? error.message : String(error));
    }
    const maxNewPosts = decideMaxNewPosts({ sizeBytes: sizeProbe, paid: paidKnown ? paidPlan : null });

    let leaseToken: string | null = null;
    try {
      leaseToken = await withPhase(metrics, "lease", () => acquirePruneLease(env));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isQuotaStop(error)) {
        console.error("d1_daily_write_quota_exhausted", "acquire_lease", message);
      } else {
        console.error("acquirePruneLease failed; skipping normal cron work", message);
      }
      emitRunLog(run, "failed", "acquire_lease");
      return;
    }
    if (!leaseToken) {
      console.warn("prune lease is held by another invocation; skipping RSS, claim, and prune");
      emitRunLog(run, "skipped", "lease_held");
      return;
    }
    const token = leaseToken;
    // Lease release stays the last plain call and never consumes the budget.
    const releaseLease = async (): Promise<void> => {
      await withPhase(metrics, "lease", () => releasePruneLease(env, token));
    };
    const measureInput = (): CronMeasureInput => ({
      cron: event.cron,
      cronRole: role,
      mode: ingestMode,
      scriptVersion: env.COMMIT_VERSION || "local",
      inlineClaim,
      inserted: measureSummary.inserted,
      indexFailureCount: measureSummary.indexFailureCount,
      notificationAttempts: measureSummary.notificationAttempts,
      cleanupRan,
      indexState: indexState.value,
      pruneCalled,
      backfillCalled
    });
    // Deliberately emitted only after the background waitUntil chain and the
    // lease release settle, so d1Calls/d1PhaseCounts include background work.
    const emitMeasure = (): void => {
      if (!measure || !metrics) return;
      emitRunMeasureLog(run, cronMeasureFields(metrics, measureInput()));
    };
    let backgroundChain: Promise<void> | null = null;

    try {
      let stateAfterLease: { indexState: IndexStateSnapshot; searchComplete: number };
      try {
        stateAfterLease = await withPhase(metrics, "state", () => readIndexStateAfterLease(env));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isQuotaStop(error)) {
          console.error("d1_daily_write_quota_exhausted", "state_after_lease", message);
        } else {
          console.error("readIndexStateAfterLease after lease failed; aborting", message);
        }
        emitRunLog(run, "failed", "read_index_state");
        return;
      }
      if (indexStateChanged(stateAfterLease.indexState, indexState)) {
        console.warn("db_prune_index_state changed after lease acquisition; aborting normal work");
        emitRunLog(run, "skipped", "index_state_changed");
        return;
      }
      indexState = stateAfterLease.indexState;
      searchComplete = stateAfterLease.searchComplete;

      const result = ingestMode === "queue"
        ? await enqueueRss(env, maxNewPosts === undefined ? undefined : { maxNewPosts })
        : await withPhase(metrics, "sync", () => safeSyncRss(env, { maxNewPosts, searchComplete }));
      if (!result.ok && isQuotaStop(result.error)) {
        console.error("RSS sync hit D1 daily write quota; ending invocation", String(result.error ?? ""));
        emitRunLog(run, "failed", "rss_quota");
        return;
      }
      if (ingestMode === "queue") {
        run.fields.ingestMode = ingestMode;
        run.fields.enqueuedItems = result.timings?.enqueuedItems ?? 0;
        run.fields.enqueuedMessages = result.timings?.enqueuedMessages ?? 0;
      }
      if (ingestMode === "inline" && result.firstSync) {
        try {
          await withPhase(metrics, "notifications", () => initializeNotificationCursor(env));
        } catch (error) {
          if (isQuotaStop(error)) {
            console.error("initializeNotificationCursor hit D1 daily write quota; ending invocation", error instanceof Error ? error.message : String(error));
            emitRunLog(run, "failed", "notification_cursor_quota");
            return;
          }
          console.error("initializeNotificationCursor failed; continuing", error instanceof Error ? error.message : String(error));
        }
      }

      const estimatedPrefix = estimatePrefixQueries(result, ingestMode);
      // An over-cap prefix must never be followed by a post-budget phase: the
      // remaining work (cleanup/timing/release) is already inside the prefix.
      const prefixOverCap = estimatedPrefix > D1_QUERY_LIMIT - DB_PRUNE_FINAL_QUERY_RESERVE;
      if (prefixOverCap) {
        console.error("prefix_over_platform_cap", JSON.stringify({ prefix: estimatedPrefix, cap: D1_QUERY_LIMIT - DB_PRUNE_FINAL_QUERY_RESERVE }));
      }
      const budget = createQueryBudget(D1_QUERY_LIMIT, DB_PRUNE_FINAL_QUERY_RESERVE, estimatedPrefix);

      let notificationTimings = { totalMs: 0, compileMs: 0, matchMs: 0, attempts: 0, matches: 0, skipped: 0, cursorPostId: 0, cursorSubscriptionId: 0, cursorChannel: "" };
      let notificationsOk = true;
      if (!prefixOverCap && ingestMode === "inline" && result.ok && !result.firstSync) {
        const notificationsStartedAt = Date.now();
        try {
          const notifications = await withPhase(metrics, "notifications", () => processNotifications(env, budget));
          notificationTimings = {
            totalMs: Date.now() - notificationsStartedAt,
            compileMs: notifications.compileMs,
            matchMs: notifications.matchMs,
            attempts: notifications.attempts,
            matches: notifications.matches,
            skipped: notifications.skipped,
            cursorPostId: notifications.cursor.postId,
            cursorSubscriptionId: notifications.cursor.subscriptionId,
            cursorChannel: notifications.cursor.channel
          };
        } catch (error) {
          if (isQuotaStop(error)) {
            console.error("processNotifications hit D1 daily write quota; ending invocation", error instanceof Error ? error.message : String(error));
            emitRunLog(run, "failed", "notifications_quota");
            return;
          }
          notificationsOk = false;
          console.error("processNotifications failed; skipping index claim", error instanceof Error ? error.message : String(error));
        }
      }

      let leaseHeld = false;
      if (!prefixOverCap) {
        try {
          leaseHeld = await withPhase(metrics, "lease", () => refreshPruneLease(env, token));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (isQuotaStop(error)) {
            console.error("d1_daily_write_quota_exhausted", "refresh_lease", message);
          } else {
            console.error("refreshPruneLease failed; skipping maintenance", message);
          }
          emitRunLog(run, "failed", "refresh_lease");
          return;
        }
        if (!leaseHeld) {
          console.warn("prune lease lost before maintenance; skipping claim and prune");
          emitRunLog(run, "skipped", "lease_lost");
          return;
        }
      }

      let maintenanceInvocation = false;
      if (!prefixOverCap && settingsOk && !indexState.invalid && indexState.value === "0" && canClaimIndexBuild(indexState)) {
        if (!result.ok || !notificationsOk) {
          console.warn("sync or notifications did not complete; staying in db_prune_index_state 0");
        } else if (budgetRemaining(budget) < DB_PRUNE_CLAIM_QUERY_RESERVE) {
          console.warn("query headroom insufficient for claim+DDL+verify+failure cleanup; staying 0", JSON.stringify({ remaining: budgetRemaining(budget) }));
        } else {
          try {
            const fresh = await withPhase(metrics, "state", () => readIndexState(env, budget));
            if (!fresh.invalid && fresh.value === "0" && canClaimIndexBuild(fresh)) {
              const claim = await withPhase(metrics, "state", () => claimIndexBuild(env, fresh.updatedAt, budget));
              if (claimAbortsNormalWork(claim.status) || (claim.status === "claimed" && !claim.token)) {
                // The claim may have committed 0 -> 1 but the response was
                // lost; let the next invocation recover from the main database.
                console.warn("index claim outcome is unknown; ending normal scheduling for main-DB recovery");
                emitRunLog(run, "skipped", "index_claim_unknown");
                return;
              }
              if (claim.status === "claimed" && claim.token) {
                maintenanceInvocation = true;
                const claimToken = claim.token;
                await withPhase(metrics, "state", () => buildAndVerifyReadStatesIndex(env, claimToken, budget));
              }
            }
          } catch (error) {
            if (isQuotaStop(error)) {
              console.error("index build admission hit D1 daily write quota; ending invocation", error instanceof Error ? error.message : String(error));
              emitRunLog(run, "failed", "index_build_quota");
              return;
            }
            console.error("index build admission failed; staying 0", error instanceof Error ? error.message : String(error));
          }
        }
      }
      if (maintenanceInvocation) {
        emitRunLog(run, "maintenance", "index_build");
        return;
      }

      const cleanupStartedAt = Date.now();
      cleanupRan = true;
      let cleanupOldDataMs = 0;
      try {
        await withPhase(metrics, "cleanup", () => runIsolated("cleanupOldData", async () => {
          await cleanupOldData(env);
        }));
      } catch (error) {
        if (isQuotaStop(error)) {
          console.error("cleanupOldData hit D1 daily write quota; ending invocation", error instanceof Error ? error.message : String(error));
          emitRunLog(run, "failed", "cleanup_quota");
          return;
        }
        console.error("cleanupOldData failed unexpectedly; continuing", error instanceof Error ? error.message : String(error));
      }
      cleanupOldDataMs = Date.now() - cleanupStartedAt;

      const forceTiming = !result.ok || !notificationsOk;
      if (shouldRecordCronTiming(forceTiming, Math.random())) {
        try {
          await withPhase(metrics, "timing", () => runIsolated("recordCronTiming", async () => {
            await recordCronTiming(env, {
              recordedAt: new Date().toISOString(),
              ok: result.ok,
              firstSync: result.firstSync,
              inserted: result.inserted,
              ranProcessSubscriptions: ingestMode === "inline" && result.ok && !result.firstSync,
              timings: {
                rssSync: result.timings || { fetchRssMs: 0, fetchFirstStrategyMs: 0, fetchRetryStrategyMs: 0, parseItemsMs: 0, parseItemCount: 0, prepareInsertMs: 0, insertBindRunMs: 0, insertNewCount: 0, insertExistingCount: 0, insertLoopMs: 0, insertPostsMs: 0, writeSyncStateMs: 0, totalMs: 0 },
                processSubscriptionsMs: notificationTimings.totalMs,
                cleanupOldDataMs,
                totalMs: Date.now() - startedAt,
                notifications: {
                  attempts: notificationTimings.attempts,
                  matches: notificationTimings.matches,
                  skipped: notificationTimings.skipped,
                  cursorPostId: notificationTimings.cursorPostId
                }
              },
              cpu: {
                rssParseItemsMs: result.cpu?.parseItemsMs || 0,
                processSubscriptionsCompileMs: notificationTimings.compileMs,
                processSubscriptionsMatchMs: notificationTimings.matchMs,
                cleanupPrepMs: 0,
                totalMs: (result.cpu?.parseItemsMs || 0) + notificationTimings.compileMs + notificationTimings.matchMs
              },
              notificationCursor: {
                postId: notificationTimings.cursorPostId,
                subscriptionId: notificationTimings.cursorSubscriptionId,
                channel: notificationTimings.cursorChannel
              },
              ...(result.error ? { error: result.error } : {}),
              sampled: !forceTiming,
              forced: forceTiming,
              sampleRate: 10
            });
          }));
        } catch (error) {
          if (isQuotaStop(error)) {
            console.error("recordCronTiming hit D1 daily write quota; ending invocation", error instanceof Error ? error.message : String(error));
            emitRunLog(run, "failed", "record_timing_quota");
            return;
          }
          console.error("recordCronTiming failed unexpectedly; continuing", error instanceof Error ? error.message : String(error));
        }
      }

      const pruneWindowOpen = !prefixOverCap && settingsOk && !indexState.invalid && indexState.value === "2" && isPruneWindow();
      let prune: PruneRunResult | null = null;
      if (pruneWindowOpen) {
        let stillHeld = false;
        try {
          stillHeld = await withPhase(metrics, "lease", () => refreshPruneLease(env, token));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (isQuotaStop(error)) {
            console.error("d1_daily_write_quota_exhausted", "refresh_lease_before_prune", message);
          } else {
            console.error("refreshPruneLease before prune failed; skipping prune and background maintenance", message);
          }
          emitRunLog(run, "failed", "refresh_lease_before_prune");
          return;
        }
        if (!stillHeld) {
          console.warn("prune lease lost before prune; skipping prune and background maintenance");
          emitRunLog(run, "skipped", "lease_lost_before_prune");
          return;
        }
        if (budgetRemaining(budget) < DB_PRUNE_PRUNE_QUERY_RESERVE) {
          console.warn("query headroom insufficient for prune; skipping this run", JSON.stringify({ remaining: budgetRemaining(budget) }));
        } else {
          try {
            pruneCalled = true;
            prune = await withPhase(metrics, "prune", () => pruneOldPostsBySize(env, { indexState, paidPlan, limitMb, budget }));
          } catch (error) {
            if (isQuotaStop(error)) {
              console.error("pruneOldPostsBySize hit D1 daily write quota; ending invocation", error instanceof Error ? error.message : String(error));
              emitRunLog(run, "failed", "prune_quota");
              return;
            }
            console.error("pruneOldPostsBySize failed; continuing", error instanceof Error ? error.message : String(error));
          }
        }
      }

      if (prune?.dailyWriteQuotaExhausted) {
        emitRunLog(run, "failed", "prune_daily_write_quota");
        return;
      }

      // A prune result already carries this run's activation; otherwise the
      // merged entry snapshot is reused. No extra sync_state read here.
      const pruneActive = prune
        ? prune.active
        : !indexState.invalid && indexState.value === "2"
          ? context.pruneActive
          : false;

      const backgroundPlan = planBackgroundTasks({
        pruneCalled: pruneWindowOpen,
        pruneActive,
        pruneDeletedThisRun: prune?.deletedThisRun ?? 0
      });
      const wantOrphans = settingsOk && context.ftsOrphansPending && backgroundPlan.runFtsOrphans;
      const wantBackfill = ingestMode === "inline" && backgroundPlan.runSearchBackfill && searchComplete !== 1;
      if (!prefixOverCap && (wantOrphans || wantBackfill)) {
        if (budgetRemaining(budget) < DB_PRUNE_BACKGROUND_QUERY_RESERVE) {
          console.warn("query headroom insufficient for background maintenance; skipping", JSON.stringify({ remaining: budgetRemaining(budget) }));
        } else {
          backgroundChain = (async () => {
            let canBackfill = true;
            if (wantOrphans) {
              try {
                await withPhase(metrics, "background", () => cleanupFtsOrphans(env, { paidPlan, limitMb, blockedFull: context.blockedFull, orphansPending: context.ftsOrphansPending, budget }));
              } catch (error) {
                if (isQuotaStop(error)) {
                  markDailyWriteQuotaExhausted(budget);
                  console.error("cleanupFtsOrphans hit D1 daily write quota; stopping background chain", error instanceof Error ? error.message : String(error));
                  canBackfill = false;
                } else {
                  console.error("cleanupFtsOrphans failed", error instanceof Error ? error.message : String(error));
                }
              }
            }
            if (canBackfill && wantBackfill && budgetRemaining(budget) >= 4) {
              try {
                // search.ts has no budget parameter yet: pre-charge its ceiling
                // (state read + post page read + index batch) so the invocation
                // still cannot cross the platform query limit.
                consumeQuery(budget);
                consumeQuery(budget);
                consumeQuery(budget);
                backfillCalled = true;
                await withPhase(metrics, "background", () => backfillSearchIndexes(env));
              } catch (error) {
                if (isQuotaStop(error)) {
                  markDailyWriteQuotaExhausted(budget);
                  console.error("backfillSearchIndexes hit D1 daily write quota; stopping background chain", error instanceof Error ? error.message : String(error));
                } else {
                  try {
                    await withPhase(metrics, "background", () => recordSearchIndexError(env, error, budget));
                  } catch (recordError) {
                    if (isQuotaStop(recordError)) {
                      markDailyWriteQuotaExhausted(budget);
                      console.error("recordSearchIndexError hit D1 daily write quota; stopping background chain", recordError instanceof Error ? recordError.message : String(recordError));
                    } else {
                      console.error("recordSearchIndexError failed", recordError instanceof Error ? recordError.message : String(recordError));
                    }
                  }
                }
              }
            }
          })();
        }
      }
      measureSummary.inserted = result.inserted;
      measureSummary.indexFailureCount = result.timings?.indexFailureCount ?? 0;
      measureSummary.notificationAttempts = notificationTimings.attempts;
      if (measure && metrics) Object.assign(run.fields, cronMeasureFields(metrics, measureInput()));
      emitRunLog(run, result.ok && notificationsOk ? "ok" : "failed", result.ok ? (notificationsOk ? null : "notifications") : "rss_sync");
    } catch (error) {
      emitRunLog(run, "failed", "unhandled");
      throw error;
    } finally {
      if (backgroundChain) {
        if (measure) {
          const settled = backgroundChain.then(releaseLease, releaseLease);
          ctx.waitUntil(settled.then(emitMeasure, (error: unknown) => {
            emitMeasure();
            throw error;
          }));
        } else {
          ctx.waitUntil(backgroundChain.then(releaseLease, releaseLease));
        }
      } else if (measure) {
        try {
          await releaseLease();
        } finally {
          emitMeasure();
        }
      } else {
        await releaseLease();
      }
    }
  },
  async queue(batch: MessageBatch<IngestMessageV1>, env: Env): Promise<void> {
    const run = createRunContext("consumer", noteFirstInIsolate());
    let ackCount = 0;
    let retryCount = 0;
    let inserted = 0;
    let indexed = 0;
    let skipped = 0;
    let itemCount = 0;
    for (const message of batch.messages) {
      itemCount += Array.isArray(message.body?.items) ? message.body.items.length : 0;
      try {
        const result = await processIngestMessage(env, message.body);
        if (!result.ok) {
          message.retry();
          retryCount += 1;
          continue;
        }
        message.ack();
        ackCount += 1;
        inserted += result.inserted;
        indexed += result.indexed;
        skipped += result.skipped;
      } catch (error) {
        console.error("ingest consumer failed", error instanceof Error ? error.message : String(error));
        message.retry();
        retryCount += 1;
      }
    }
    run.fields.itemCount = itemCount;
    run.fields.insertedCount = inserted;
    run.fields.indexedCount = indexed;
    run.fields.skippedCount = skipped;
    run.fields.ackCount = ackCount;
    run.fields.retryCount = retryCount;
    emitRunLog(run, retryCount === 0 ? "ok" : "failed", retryCount === 0 ? null : "ingest_retry");
  }

};
