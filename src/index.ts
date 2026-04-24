import { currentUser, login, logout, register, updateEmail, updateTelegram } from "./auth";
import { cleanupOldData } from "./cleanup";
import { all, json, readJson } from "./db";
import { safeRegex } from "./filters";
import { markReadAndGetLink, queryPosts } from "./posts";
import { renderHome } from "./render";
import { latestUnpushedPosts, safeSyncRss, testRssFetch } from "./rss";
import { adminSettingsResponse, adminStatus, handleAdmin, logoutAdmin, updateAdminSettings } from "./settings";
import { createSubscription, processSubscriptions } from "./subscriptions";
import type { Env, User } from "./types";

const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="NodeSeek RSS Reader"><rect width="128" height="128" rx="30" fill="#fff"/><rect x="8" y="8" width="112" height="112" rx="24" fill="none" stroke="#111" stroke-width="8"/><path d="M34 35h16l31 43V35h15v58H80L49 50v43H34z" fill="#111"/><circle cx="38" cy="91" r="8" fill="#111"/><path d="M34 67c15 0 27 12 27 27" fill="none" stroke="#111" stroke-width="8" stroke-linecap="round"/><path d="M34 49c25 0 45 20 45 45" fill="none" stroke="#111" stroke-width="8" stroke-linecap="round"/></svg>`;
const manifest = { name: "NodeSeek RSS Reader", short_name: "NodeSeek RSS", start_url: "/", display: "standalone", background_color: "#000000", theme_color: "#000000", icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }] };

function requireUser(user: User | null): Response | null {
  return user ? null : json({ error: "需要登录" }, 401);
}

async function listHighlights(env: Env, user: User): Promise<Response> {
  const groups = await all<{ id: number; user_id: number; name: string; color: string }>(env.DB.prepare("SELECT id, user_id, name, color FROM highlight_groups WHERE user_id = ? ORDER BY id DESC").bind(user.id));
  const out = [];
  for (const group of groups) {
    const rules = await all<{ pattern: string }>(env.DB.prepare("SELECT pattern FROM highlight_rules WHERE group_id = ? ORDER BY id DESC").bind(group.id));
    out.push({ ...group, patterns: rules.map((r) => r.pattern) });
  }
  return json(out);
}

async function handleApi(request: Request, env: Env, user: User | null, url: URL): Promise<Response> {
  const path = url.pathname;
  if (path === "/api/admin/settings" && request.method === "GET") return adminSettingsResponse(request, env);
  if (path === "/api/admin/settings" && request.method === "PUT") return updateAdminSettings(request, env);
  if (path === "/api/admin/logout" && request.method === "POST") return logoutAdmin(request, env);
  if (path === "/api/auth/register" && request.method === "POST") return register(request, env);
  if (path === "/api/auth/login" && request.method === "POST") return login(request, env);
  if (path === "/api/auth/logout" && request.method === "POST") return logout(request, env);
  if (path === "/api/me") return json(user);
  const notAuthed = requireUser(user);
  if (notAuthed) return notAuthed;
  const me = user!;

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
      await env.DB.prepare("UPDATE highlight_groups SET name = ?, color = ?, updated_at = datetime('now') WHERE id = ?").bind((body.name || "").trim() || "未命名", body.color || "#ffe066", groupId).run();
      await env.DB.prepare("DELETE FROM highlight_rules WHERE group_id = ?").bind(groupId).run();
      for (const pattern of body.patterns || []) {
        const p = String(pattern).trim();
        if (p && p.length <= 200 && safeRegex(p)) await env.DB.prepare("INSERT INTO highlight_rules (group_id, pattern, created_at) VALUES (?, ?, datetime('now'))").bind(groupId, p).run();
      }
      return json({ ok: true });
    }
  }
  if (path === "/api/block-rules" && request.method === "GET") return json(await all(env.DB.prepare("SELECT id, pattern FROM block_rules WHERE user_id = ? ORDER BY id DESC").bind(me.id)));
  if (path === "/api/block-rules" && request.method === "POST") {
    const body = await readJson<{ pattern?: string }>(request);
    const pattern = (body.pattern || "").trim();
    if (!safeRegex(pattern)) return json({ error: "正则无效" }, 400);
    const result = await env.DB.prepare("INSERT INTO block_rules (user_id, pattern, created_at) VALUES (?, ?, datetime('now'))").bind(me.id, pattern).run();
    return json({ ok: true, id: Number(result.meta.last_row_id), pattern });
  }
  const blockMatch = /^\/api\/block-rules\/(\d+)$/.exec(path);
  if (blockMatch && request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM block_rules WHERE id = ? AND user_id = ?").bind(Number(blockMatch[1]), me.id).run();
    return json({ ok: true });
  }
  if (path === "/api/subscriptions" && request.method === "GET") return json(await all(env.DB.prepare("SELECT id, pattern, send_email, send_telegram FROM subscriptions WHERE user_id = ? ORDER BY id DESC").bind(me.id)));
  if (path === "/api/subscriptions" && request.method === "POST") return createSubscription(request, env, me);
  const subMatch = /^\/api\/subscriptions\/(\d+)$/.exec(path);
  if (subMatch && request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM subscriptions WHERE id = ? AND user_id = ?").bind(Number(subMatch[1]), me.id).run();
    return json({ ok: true });
  }
  if (path === "/api/export/highlights") return listHighlights(env, me);
  if (path === "/api/export/blocks") return json(await all(env.DB.prepare("SELECT pattern FROM block_rules WHERE user_id = ? ORDER BY id DESC").bind(me.id)));
  if (path === "/api/export/subscriptions") return json(await all(env.DB.prepare("SELECT pattern, send_email, send_telegram FROM subscriptions WHERE user_id = ? ORDER BY id DESC").bind(me.id)));
  if (path === "/api/import/highlights" && request.method === "POST") return importHighlights(request, env, me);
  if (path === "/api/import/blocks" && request.method === "POST") return importBlocks(request, env, me);
  if (path === "/api/import/subscriptions" && request.method === "POST") return importSubscriptions(request, env, me);
  return json({ error: "Not found" }, 404);
}

async function importHighlights(request: Request, env: Env, user: User): Promise<Response> {
  const body = await readJson<{ groups?: Array<{ name?: string; color?: string; patterns?: string[] }> }>(request);
  await env.DB.prepare("DELETE FROM highlight_rules WHERE group_id IN (SELECT id FROM highlight_groups WHERE user_id = ?)").bind(user.id).run();
  await env.DB.prepare("DELETE FROM highlight_groups WHERE user_id = ?").bind(user.id).run();
  for (const group of body.groups || []) {
    const name = String(group.name || "未命名").trim() || "未命名";
    const color = /^#[0-9a-f]{6}$/i.test(String(group.color || "")) ? String(group.color) : "#ffe066";
    const result = await env.DB.prepare("INSERT INTO highlight_groups (user_id, name, color, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))").bind(user.id, name, color).run();
    const groupId = Number(result.meta.last_row_id);
    for (const pattern of group.patterns || []) {
      const p = String(pattern).trim();
      if (p && p.length <= 200 && safeRegex(p)) await env.DB.prepare("INSERT INTO highlight_rules (group_id, pattern, created_at) VALUES (?, ?, datetime('now'))").bind(groupId, p).run();
    }
  }
  return json({ ok: true });
}

async function importBlocks(request: Request, env: Env, user: User): Promise<Response> {
  const body = await readJson<{ patterns?: string[] }>(request);
  await env.DB.prepare("DELETE FROM block_rules WHERE user_id = ?").bind(user.id).run();
  for (const pattern of body.patterns || []) {
    const p = String(pattern).trim();
    if (p && p.length <= 200 && safeRegex(p)) await env.DB.prepare("INSERT INTO block_rules (user_id, pattern, created_at) VALUES (?, ?, datetime('now'))").bind(user.id, p).run();
  }
  return json({ ok: true });
}

async function importSubscriptions(request: Request, env: Env, user: User): Promise<Response> {
  const body = await readJson<{ rules?: Array<{ pattern?: string; sendEmail?: boolean; sendTelegram?: boolean }> }>(request);
  await env.DB.prepare("DELETE FROM subscriptions WHERE user_id = ?").bind(user.id).run();
  for (const rule of body.rules || []) {
    const pattern = String(rule.pattern || "").trim();
    if (pattern && pattern.length <= 200 && safeRegex(pattern)) await env.DB.prepare("INSERT INTO subscriptions (user_id, pattern, send_email, send_telegram, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))").bind(user.id, pattern, rule.sendEmail === false ? 0 : 1, rule.sendTelegram === false ? 0 : 1).run();
  }
  return json({ ok: true });
}

async function handleTelegram(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ message?: { text?: string; chat?: { id?: number } } }>(request);
  const text = body.message?.text?.trim() || "";
  const chatId = body.message?.chat?.id;
  if (!chatId || !text) return json({ ok: true });
  const code = text.replace(/^\/start\s*/, "").trim();
  if (code) await env.DB.prepare("UPDATE users SET telegram_chat_id = ?, updated_at = datetime('now') WHERE telegram_bind_code = ?").bind(String(chatId), code).run();
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

async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/icon.svg") return new Response(iconSvg, { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=86400" } });
  if (url.pathname === "/manifest.webmanifest") return json(manifest, 200, { "cache-control": "public, max-age=86400" });
  if (url.pathname === "/health") return health(env);
  if (!env.DB) return missingDbResponse(request);
  if (url.pathname === "/admin") return handleAdmin(request, env);
  const user = await currentUser(request, env);
  if (url.pathname.startsWith("/api/")) return handleApi(request, env, user, url);
  if (url.pathname === "/telegram/webhook" && request.method === "POST") return handleTelegram(request, env);
  const openMatch = /^\/post\/(\d+)\/open$/.exec(url.pathname);
  if (openMatch) {
    const link = await markReadAndGetLink(env, user, Number(openMatch[1]));
    return link ? Response.redirect(link, 302) : new Response("Not found", { status: 404 });
  }
  if (url.pathname === "/" || /^\/page\/\d+$/.test(url.pathname)) return renderHome(env, user, await queryPosts(env, user, url), await adminStatus(request, env));
  return new Response("Not found", { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleFetch(request, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (new URL(request.url).pathname.startsWith("/api/")) return json({ ok: false, error: message }, 500);
      return new Response(`<!doctype html><meta charset="utf-8"><title>NodeSeek RSS Reader Error</title><body style="font-family:system-ui;margin:2rem;line-height:1.6"><h1>NodeSeek RSS Reader Error</h1><pre style="white-space:pre-wrap">${message.replace(/[&<>'"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[ch] || ch))}</pre><p>Check <code>/health</code> and Cloudflare Worker bindings.</p></body>`, { status: 500, headers: { "content-type": "text/html; charset=utf-8" } });
    }
  },
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    if (!env.DB) throw new Error("Cloudflare D1 binding DB is missing");
    const result = await safeSyncRss(env);
    if (result.ok && !result.firstSync) await processSubscriptions(env, await latestUnpushedPosts(env));
    await cleanupOldData(env);
  }
};
