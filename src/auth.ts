import { clearSessionCookie, getCookie, nowIso, one, readJson, setSessionCookie } from "./db";
import type { Env, User } from "./types";

const sessionDays = 30;

function toBase64(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function randomToken(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: 100000, hash: "SHA-256" }, key, 256);
  return toBase64(bits);
}

function userRow(row: User): User {
  return { id: row.id, username: row.username, email: row.email, telegram_chat_id: row.telegram_chat_id, telegram_bind_code: row.telegram_bind_code };
}

export async function currentUser(request: Request, env: Env): Promise<User | null> {
  const sessionId = getCookie(request, "session");
  if (!sessionId) return null;
  const row = await one<User>(env.DB.prepare("SELECT u.id, u.username, u.email, u.telegram_chat_id, u.telegram_bind_code FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?").bind(sessionId, nowIso()));
  return row ? userRow(row) : null;
}

async function createSession(env: Env, userId: number): Promise<{ id: string; expires: Date }> {
  const id = randomToken();
  const expires = new Date(Date.now() + sessionDays * 86400 * 1000);
  await env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").bind(id, userId, expires.toISOString(), nowIso()).run();
  return { id, expires };
}

export async function register(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ username?: string; password?: string }>(request);
  const username = (body.username || "").trim();
  const password = body.password || "";
  if (!/^[A-Za-z0-9_\-]{3,32}$/.test(username) || password.length < 6) return Response.json({ error: "用户名需 3-32 位，密码至少 6 位" }, { status: 400 });
  const salt = randomToken(16);
  const passwordHash = await hashPassword(password, salt);
  const bindCode = randomToken(4);
  try {
    const result = await env.DB.prepare("INSERT INTO users (username, password_hash, password_salt, telegram_bind_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(username, passwordHash, salt, bindCode, nowIso(), nowIso()).run();
    const session = await createSession(env, Number(result.meta.last_row_id));
    return Response.json({ ok: true }, { headers: { "set-cookie": setSessionCookie(session.id, session.expires) } });
  } catch {
    return Response.json({ error: "用户名已存在" }, { status: 409 });
  }
}

export async function login(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ username?: string; password?: string }>(request);
  const row = await one<(User & { password_hash: string; password_salt: string })>(env.DB.prepare("SELECT * FROM users WHERE username = ?").bind((body.username || "").trim()));
  if (!row) return Response.json({ error: "用户名或密码错误" }, { status: 401 });
  const passwordHash = await hashPassword(body.password || "", row.password_salt);
  if (passwordHash !== row.password_hash) return Response.json({ error: "用户名或密码错误" }, { status: 401 });
  const session = await createSession(env, row.id);
  return Response.json({ ok: true }, { headers: { "set-cookie": setSessionCookie(session.id, session.expires) } });
}

export async function logout(request: Request, env: Env): Promise<Response> {
  const sessionId = getCookie(request, "session");
  if (sessionId) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
  return Response.json({ ok: true }, { headers: { "set-cookie": clearSessionCookie() } });
}

export async function updateEmail(request: Request, env: Env, user: User): Promise<Response> {
  const body = await readJson<{ email?: string }>(request);
  const email = (body.email || "").trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return Response.json({ error: "邮箱格式不正确" }, { status: 400 });
  await env.DB.prepare("UPDATE users SET email = ?, updated_at = ? WHERE id = ?").bind(email || null, nowIso(), user.id).run();
  return Response.json({ ok: true });
}

export async function updateTelegram(request: Request, env: Env, user: User): Promise<Response> {
  const body = await readJson<{ telegramChatId?: string }>(request);
  const chatId = (body.telegramChatId || "").trim();
  if (chatId && !/^-?\d{4,32}$/.test(chatId)) return Response.json({ error: "Telegram Chat ID 格式不正确" }, { status: 400 });
  await env.DB.prepare("UPDATE users SET telegram_chat_id = ?, updated_at = ? WHERE id = ?").bind(chatId || null, nowIso(), user.id).run();
  return Response.json({ ok: true });
}
