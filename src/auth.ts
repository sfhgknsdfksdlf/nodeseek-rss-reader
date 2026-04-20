import { SESSION_COOKIE_NAME, SESSION_TTL_DAYS } from './constants';
import type { Env, User } from './types';

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashPassword(password: string, secret: string): Promise<string> {
  return sha256(`${secret}::${password}`);
}

export async function verifyPassword(password: string, hashed: string, secret: string): Promise<boolean> {
  return (await hashPassword(password, secret)) === hashed;
}

function cookieValue(headers: Headers, key: string): string | null {
  const cookie = headers.get('cookie') || '';
  const parts = cookie.split(/;\s*/g);
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx);
    const v = part.slice(idx + 1);
    if (k === key) return decodeURIComponent(v);
  }
  return null;
}

export function readSessionId(request: Request): string | null {
  return cookieValue(request.headers, SESSION_COOKIE_NAME);
}

export function makeCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}; Secure`;
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`;
}

export async function createSession(env: Env, userId: number): Promise<{ sessionId: string; cookie: string }> {
  const sessionId = crypto.randomUUID();
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 3600 * 1000).toISOString();
  await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').bind(sessionId, userId, expires).run();
  return {
    sessionId,
    cookie: makeCookie(SESSION_COOKIE_NAME, sessionId, SESSION_TTL_DAYS * 24 * 3600)
  };
}

export async function destroySession(env: Env, request: Request): Promise<string> {
  const sid = readSessionId(request);
  if (sid) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run();
  }
  return clearCookie(SESSION_COOKIE_NAME);
}

export async function getCurrentUser(env: Env, request: Request): Promise<User | null> {
  const sid = readSessionId(request);
  if (!sid) return null;
  const row = await env.DB.prepare(`
    SELECT u.*
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > datetime('now')
  `).bind(sid).first<User>();
  return row ?? null;
}
