import { currentUser, login, logout, register, updateEmail, updateTelegram } from "./auth";
import { all, json, readJson } from "./db";
import { safeRegex } from "./filters";
import { markReadAndGetLink, queryPosts } from "./posts";
import { renderHome } from "./render";
import { latestUnpushedPosts, syncRss } from "./rss";
import { createSubscription, processSubscriptions } from "./subscriptions";
import type { Env, User } from "./types";

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
  if (path === "/api/auth/register" && request.method === "POST") return register(request, env);
  if (path === "/api/auth/login" && request.method === "POST") return login(request, env);
  if (path === "/api/auth/logout" && request.method === "POST") return logout(request, env);
  if (path === "/api/me") return json(user);
  const notAuthed = requireUser(user);
  if (notAuthed) return notAuthed;
  const me = user!;

  if (path === "/api/posts") return json(await queryPosts(env, me, url));
  if (path === "/api/me/email" && request.method === "PUT") return updateEmail(request, env, me);
  if (path === "/api/me/telegram" && request.method === "PUT") return updateTelegram(request, env, me);
  if (path === "/api/highlight-groups" && request.method === "GET") return listHighlights(env, me);
  if (path === "/api/highlight-groups" && request.method === "POST") {
    const body = await readJson<{ name?: string; color?: string }>(request);
    const name = (body.name || "").trim();
    const color = /^#[0-9a-f]{6}$/i.test(body.color || "") ? body.color! : "#ffe066";
    if (!name) return json({ error: "分组名不能为空" }, 400);
    await env.DB.prepare("INSERT INTO highlight_groups (user_id, name, color, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))").bind(me.id, name, color).run();
    return json({ ok: true });
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
    await env.DB.prepare("INSERT INTO block_rules (user_id, pattern, created_at) VALUES (?, ?, datetime('now'))").bind(me.id, pattern).run();
    return json({ ok: true });
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
  return json({ error: "Not found" }, 404);
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

async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/icon.svg") return fetch(new URL("../public/icon.svg", import.meta.url));
  if (url.pathname === "/manifest.webmanifest") return fetch(new URL("../public/manifest.webmanifest", import.meta.url));
  const user = await currentUser(request, env);
  if (url.pathname.startsWith("/api/")) return handleApi(request, env, user, url);
  if (url.pathname === "/telegram/webhook" && request.method === "POST") return handleTelegram(request, env);
  const openMatch = /^\/post\/(\d+)\/open$/.exec(url.pathname);
  if (openMatch) {
    const link = await markReadAndGetLink(env, user, Number(openMatch[1]));
    return link ? Response.redirect(link, 302) : new Response("Not found", { status: 404 });
  }
  if (url.pathname === "/" || /^\/page\/\d+$/.test(url.pathname)) return renderHome(env, user, await queryPosts(env, user, url));
  return new Response("Not found", { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleFetch(request, env);
  },
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const result = await syncRss(env);
    if (!result.firstSync) await processSubscriptions(env, await latestUnpushedPosts(env));
  }
};
