import { clearSessionCookie, getCookie, json, nowIso, one, setSessionCookie } from "./db";
import type { Env } from "./types";

const adminSessionDays = 7;
const encryptedKeys = new Set(["brevo_api_key", "telegram_bot_token"]);

export interface RuntimeSettings {
  brevoApiKey: string;
  telegramBotToken: string;
  mailFrom: string;
  mailFromName: string;
  readStateRetentionDays: number;
  postRetentionDays: number;
  pushLogRetentionDays: number;
}

function randomToken(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function cryptoKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encrypt(secret: string, value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cryptoKey(secret), new TextEncoder().encode(value)));
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv);
  combined.set(ciphertext, iv.length);
  return toBase64(combined);
}

async function decrypt(secret: string, value: string): Promise<string> {
  const combined = fromBase64(value);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await cryptoKey(secret), ciphertext);
  return new TextDecoder().decode(plain);
}

function clampDays(value: unknown, fallback: number): number {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(3650, Math.max(1, number));
}

async function getRawSetting(env: Env, key: string): Promise<{ value: string; encrypted: number } | null> {
  return one<{ value: string; encrypted: number }>(env.DB.prepare("SELECT value, encrypted FROM app_settings WHERE key = ?").bind(key));
}

export async function getSetting(env: Env, key: string): Promise<string> {
  const row = await getRawSetting(env, key);
  if (!row) return "";
  if (!row.encrypted) return row.value;
  if (!env.ADMIN_SECRET) return "";
  try {
    return await decrypt(env.ADMIN_SECRET, row.value);
  } catch {
    return "";
  }
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  const encrypted = encryptedKeys.has(key) ? 1 : 0;
  const stored = encrypted && env.ADMIN_SECRET ? await encrypt(env.ADMIN_SECRET, value) : value;
  await env.DB.prepare("INSERT OR REPLACE INTO app_settings (key, value, encrypted, updated_at) VALUES (?, ?, ?, ?)").bind(key, stored, encrypted, nowIso()).run();
}

export async function runtimeSettings(env: Env): Promise<RuntimeSettings> {
  const [brevoApiKey, telegramBotToken, mailFrom, mailFromName, readDays, postDays, pushDays] = await Promise.all([
    getSetting(env, "brevo_api_key"),
    getSetting(env, "telegram_bot_token"),
    getSetting(env, "mail_from"),
    getSetting(env, "mail_from_name"),
    getSetting(env, "read_state_retention_days"),
    getSetting(env, "post_retention_days"),
    getSetting(env, "push_log_retention_days")
  ]);
  return {
    brevoApiKey: brevoApiKey || env.BREVO_API_KEY || "",
    telegramBotToken: telegramBotToken || env.TELEGRAM_BOT_TOKEN || "",
    mailFrom: mailFrom || env.MAIL_FROM || "",
    mailFromName: mailFromName || env.MAIL_FROM_NAME || "NodeSeek RSS Reader",
    readStateRetentionDays: clampDays(readDays || env.READ_STATE_RETENTION_DAYS, 30),
    postRetentionDays: clampDays(postDays || env.POST_RETENTION_DAYS, 365),
    pushLogRetentionDays: clampDays(pushDays || env.PUSH_LOG_RETENTION_DAYS, 30)
  };
}

export async function isAdmin(request: Request, env: Env): Promise<boolean> {
  const sessionId = getCookie(request, "admin_session");
  if (!sessionId) return false;
  const row = await one<{ id: string }>(env.DB.prepare("SELECT id FROM admin_sessions WHERE id = ? AND expires_at > ?").bind(sessionId, nowIso()));
  return !!row;
}

export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!env.ADMIN_SECRET) {
    return new Response(`<!doctype html><meta charset="utf-8"><title>管理员配置</title><body style="font-family:system-ui;margin:2rem;line-height:1.7"><h1>管理员功能未启用</h1><p>请在 Cloudflare Worker Secrets 中添加 <code>ADMIN_SECRET</code>，建议使用 32 字符以上随机字符串，然后重新部署。</p><p>部署后访问 <code>/admin?token=你的ADMIN_SECRET</code>，并保存该管理入口为书签。</p></body>`, { status: 503, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (url.searchParams.get("token") !== env.ADMIN_SECRET) return new Response("Forbidden", { status: 403 });
  const id = randomToken();
  const expires = new Date(Date.now() + adminSessionDays * 86400 * 1000);
  await env.DB.prepare("INSERT INTO admin_sessions (id, expires_at, created_at) VALUES (?, ?, ?)").bind(id, expires.toISOString(), nowIso()).run();
  return new Response("", { status: 302, headers: { location: "/", "set-cookie": setSessionCookie(id, expires).replace("session=", "admin_session=") } });
}

export async function adminSettingsResponse(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ admin: false, adminSecretConfigured: !!env.ADMIN_SECRET }, 401);
  const settings = await runtimeSettings(env);
  return json({
    admin: true,
    adminSecretConfigured: !!env.ADMIN_SECRET,
    brevoApiKeyConfigured: !!settings.brevoApiKey,
    telegramBotTokenConfigured: !!settings.telegramBotToken,
    mailFrom: settings.mailFrom,
    mailFromName: settings.mailFromName,
    readStateRetentionDays: settings.readStateRetentionDays,
    postRetentionDays: settings.postRetentionDays,
    pushLogRetentionDays: settings.pushLogRetentionDays
  });
}

export async function updateAdminSettings(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "管理员认证已过期，请重新打开管理书签" }, 401);
  const body = (await request.json().catch(() => ({}))) as {
    mailFrom?: unknown;
    mailFromName?: unknown;
    brevoApiKey?: unknown;
    telegramBotToken?: unknown;
    readStateRetentionDays?: unknown;
    postRetentionDays?: unknown;
    pushLogRetentionDays?: unknown;
  };
  const updates: Array<[string, string]> = [];
  if (typeof body.mailFrom === "string") updates.push(["mail_from", body.mailFrom.trim()]);
  if (typeof body.mailFromName === "string") updates.push(["mail_from_name", body.mailFromName.trim() || "NodeSeek RSS Reader"]);
  if (typeof body.brevoApiKey === "string" && body.brevoApiKey.trim()) updates.push(["brevo_api_key", body.brevoApiKey.trim()]);
  if (typeof body.telegramBotToken === "string" && body.telegramBotToken.trim()) updates.push(["telegram_bot_token", body.telegramBotToken.trim()]);
  updates.push(["read_state_retention_days", String(clampDays(body.readStateRetentionDays, 30))]);
  updates.push(["post_retention_days", String(clampDays(body.postRetentionDays, 365))]);
  updates.push(["push_log_retention_days", String(clampDays(body.pushLogRetentionDays, 30))]);
  for (const [key, value] of updates) await setSetting(env, key, value);
  return json({ ok: true });
}

export async function logoutAdmin(request: Request, env: Env): Promise<Response> {
  const sessionId = getCookie(request, "admin_session");
  if (sessionId) await env.DB.prepare("DELETE FROM admin_sessions WHERE id = ?").bind(sessionId).run();
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookie().replace("session=", "admin_session=") });
}
