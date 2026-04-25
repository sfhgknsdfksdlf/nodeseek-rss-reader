import { json, nowIso, one } from "./db";
import type { Env } from "./types";

const encryptedKeys = new Set(["brevo_api_key", "telegram_bot_token"]);

export interface RuntimeSettings {
  brevoApiKey: string;
  telegramBotToken: string;
  telegramBotUsername: string;
  mailFrom: string;
  mailFromName: string;
  readStateRetentionDays: number;
  postRetentionDays: number;
  pushLogRetentionDays: number;
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
  const [brevoApiKey, telegramBotToken, telegramBotUsername, mailFrom, mailFromName, readDays, postDays, pushDays] = await Promise.all([
    getSetting(env, "brevo_api_key"),
    getSetting(env, "telegram_bot_token"),
    getSetting(env, "telegram_bot_username"),
    getSetting(env, "mail_from"),
    getSetting(env, "mail_from_name"),
    getSetting(env, "read_state_retention_days"),
    getSetting(env, "post_retention_days"),
    getSetting(env, "push_log_retention_days")
  ]);
  return {
    brevoApiKey: brevoApiKey || env.BREVO_API_KEY || "",
    telegramBotToken: telegramBotToken || env.TELEGRAM_BOT_TOKEN || "",
    telegramBotUsername: telegramBotUsername || "",
    mailFrom: mailFrom || env.MAIL_FROM || "",
    mailFromName: mailFromName || env.MAIL_FROM_NAME || "NodeSeek RSS Reader",
    readStateRetentionDays: clampDays(readDays || env.READ_STATE_RETENTION_DAYS, 7),
    postRetentionDays: clampDays(postDays || env.POST_RETENTION_DAYS, 365),
    pushLogRetentionDays: clampDays(pushDays || env.PUSH_LOG_RETENTION_DAYS, 30)
  };
}

function tokenFromRequest(request: Request): string {
  return new URL(request.url).searchParams.get("token") || request.headers.get("x-admin-token") || "";
}

export function isAdmin(request: Request, env: Env): boolean {
  return !!env.ADMIN_SECRET && tokenFromRequest(request) === env.ADMIN_SECRET;
}

export function adminStatus(request: Request, env: Env): { adminSecretConfigured: boolean; adminAuthenticated: boolean } {
  return { adminSecretConfigured: !!env.ADMIN_SECRET, adminAuthenticated: isAdmin(request, env) };
}

export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!env.ADMIN_SECRET) {
    return new Response(adminSetupHtml(), { status: 503, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (url.searchParams.get("token") !== env.ADMIN_SECRET) return new Response(adminSetupHtml("管理链接中的 token 不正确。"), { status: 403, headers: { "content-type": "text/html; charset=utf-8" } });
  return new Response(adminPageHtml(url.searchParams.get("token") || ""), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export async function adminSettingsResponse(request: Request, env: Env): Promise<Response> {
  if (!isAdmin(request, env)) return json({ admin: false, adminSecretConfigured: !!env.ADMIN_SECRET }, 401);
  const settings = await runtimeSettings(env);
  return json({
    admin: true,
    adminSecretConfigured: !!env.ADMIN_SECRET,
    brevoApiKeyConfigured: !!settings.brevoApiKey,
    telegramBotTokenConfigured: !!settings.telegramBotToken,
    telegramBotUsername: settings.telegramBotUsername,
    mailFrom: settings.mailFrom,
    mailFromName: settings.mailFromName,
    readStateRetentionDays: settings.readStateRetentionDays,
    postRetentionDays: settings.postRetentionDays,
    pushLogRetentionDays: settings.pushLogRetentionDays
  });
}

export async function updateAdminSettings(request: Request, env: Env): Promise<Response> {
  if (!isAdmin(request, env)) return json({ error: "管理员 token 不正确，请打开 /admin?token=你的ADMIN_SECRET" }, 401);
  const body = (await request.json().catch(() => ({}))) as {
    mailFrom?: unknown;
    mailFromName?: unknown;
    brevoApiKey?: unknown;
    telegramBotToken?: unknown;
    telegramBotUsername?: unknown;
    readStateRetentionDays?: unknown;
    postRetentionDays?: unknown;
    pushLogRetentionDays?: unknown;
  };
  const updates: Array<[string, string]> = [];
  if (typeof body.mailFrom === "string") updates.push(["mail_from", body.mailFrom.trim()]);
  if (typeof body.mailFromName === "string") updates.push(["mail_from_name", body.mailFromName.trim() || "NodeSeek RSS Reader"]);
  if (typeof body.brevoApiKey === "string" && body.brevoApiKey.trim()) updates.push(["brevo_api_key", body.brevoApiKey.trim()]);
  if (typeof body.telegramBotToken === "string" && body.telegramBotToken.trim()) updates.push(["telegram_bot_token", body.telegramBotToken.trim()]);
  if (typeof body.telegramBotUsername === "string") updates.push(["telegram_bot_username", body.telegramBotUsername.trim()]);
  updates.push(["read_state_retention_days", String(clampDays(body.readStateRetentionDays, 7))]);
  updates.push(["post_retention_days", String(clampDays(body.postRetentionDays, 365))]);
  updates.push(["push_log_retention_days", String(clampDays(body.pushLogRetentionDays, 30))]);
  for (const [key, value] of updates) await setSetting(env, key, value);
  return json({ ok: true });
}

export async function adminUsersResponse(request: Request, env: Env): Promise<Response> {
  if (!isAdmin(request, env)) return json({ error: "管理员 token 不正确" }, 401);
  const result = await env.DB.prepare(`
    SELECT
      u.id,
      u.username,
      u.email,
      u.telegram_chat_id,
      u.created_at,
      (SELECT COUNT(*) FROM highlight_groups hg WHERE hg.user_id = u.id) AS highlight_group_count,
      (SELECT COUNT(*) FROM block_rules br WHERE br.user_id = u.id) AS block_rule_count,
      (SELECT COUNT(*) FROM subscriptions s WHERE s.user_id = u.id) AS subscription_count,
      (SELECT COUNT(*) FROM read_states rs WHERE rs.user_id = u.id) AS read_count
    FROM users u
    ORDER BY u.created_at DESC
  `).all();
  return json({ users: result.results || [] });
}

export async function deleteAdminUser(request: Request, env: Env, userId: number): Promise<Response> {
  if (!isAdmin(request, env)) return json({ error: "管理员 token 不正确" }, 401);
  const user = await one<{ id: number; username: string }>(env.DB.prepare("SELECT id, username FROM users WHERE id = ?").bind(userId));
  if (!user) return json({ error: "用户不存在" }, 404);
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
  await env.DB.prepare("DELETE FROM read_states WHERE user_id = ?").bind(userId).run();
  await env.DB.prepare("DELETE FROM highlight_rules WHERE group_id IN (SELECT id FROM highlight_groups WHERE user_id = ?)").bind(userId).run();
  await env.DB.prepare("DELETE FROM highlight_groups WHERE user_id = ?").bind(userId).run();
  await env.DB.prepare("DELETE FROM block_rules WHERE user_id = ?").bind(userId).run();
  await env.DB.prepare("DELETE FROM push_logs WHERE user_id = ?").bind(userId).run();
  await env.DB.prepare("DELETE FROM subscriptions WHERE user_id = ?").bind(userId).run();
  await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
  return json({ ok: true, deleted: user.username });
}

function adminSetupHtml(error = ""): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NodeSeek RSS Reader 管理员设置</title><style>body{font-family:system-ui;margin:0;background:#f8f8f8;color:#111}.wrap{max-width:760px;margin:0 auto;padding:18px}.card{background:#fff;border:1px solid #ddd;border-radius:18px;padding:14px}.code{font-weight:700;background:#eee;border-radius:8px;padding:.1rem .35rem;cursor:pointer}button{border:1px solid #ddd;border-radius:12px;background:#fff;padding:.35rem .55rem}li{margin:.35rem 0}.err{color:#d71920}@media(prefers-color-scheme:dark){body{background:#000;color:#f5f5f5}.card{background:#000;border-color:#2a2a2a}.code{background:#222}}</style><body><main class="wrap"><h1>管理员设置</h1>${error ? `<p class="err">${error}</p>` : ""}<section class="card"><p>请在 Cloudflare Worker 中添加一个 Secret。</p><ol><li>打开 Cloudflare 控制台。</li><li>进入「Workers 和 Pages / Workers & Pages」。</li><li>点击当前 Worker：<span class="code">nodeseek-rss-reader</span>。</li><li>打开「设置 / Settings」。</li><li>打开「变量和机密 / Variables and Secrets」。</li><li>点击「添加 / Add」。</li><li>类型选择「机密 / Secret」。</li><li>「变量名称 / Variable name」填 <span class="code" data-copy="ADMIN_SECRET">ADMIN_SECRET</span> <button data-copy="ADMIN_SECRET">复制</button>。</li><li>「值 / Value」填 32-64 位小写字母数字，例如 <span class="code" data-copy="r7m4qp9vz2kx8nw6ta3yh5bc1ls0defg">r7m4qp9vz2kx8nw6ta3yh5bc1ls0defg</span> <button data-copy="r7m4qp9vz2kx8nw6ta3yh5bc1ls0defg">复制</button>。</li><li>保存前复制并安全保存这个值；Cloudflare 保存后不会再显示明文。</li><li>点击输入框下方的空白处，让「保存 / Save」按钮变亮。</li><li>点击「保存 / Save」；如果弹出部署选择，点击「不部署 / Do not deploy」即可生效。</li><li>打开 <span class="code">/admin?token=你的ADMIN_SECRET</span>，并保存完整链接为书签。</li></ol><p>推荐只用小写字母和数字。URL 的域名不区分大小写，但 <code>token</code> 参数值区分大小写；不推荐特殊字符。</p></section></main><script>document.querySelectorAll('[data-copy]').forEach(el=>el.onclick=async()=>{await navigator.clipboard.writeText(el.dataset.copy);el.textContent='已复制'})</script></body></html>`;
}

function adminPageHtml(token: string): string {
  const safeToken = token.replace(/[&<>'"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[ch] || ch));
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NodeSeek RSS Reader 管理员</title><style>:root{color-scheme:light dark}body{font-family:system-ui;margin:0;background:#f8f8f8;color:#111}.wrap{max-width:860px;margin:0 auto;padding:14px}.card{display:grid;gap:10px;background:#fff;border:1px solid #ddd;border-radius:18px;padding:14px;margin-bottom:14px}input,button{font:inherit;border:1px solid #ddd;border-radius:12px;padding:.5rem}.primary{background:#1663ff;border-color:#1663ff;color:#fff}.danger{background:#d71920;border-color:#d71920;color:#fff}label{display:grid;gap:4px}.muted{color:#666}.user{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;border:1px solid #ddd;border-radius:14px;padding:10px}.user b{overflow:hidden;text-overflow:ellipsis}.stats{font-size:12px;color:#666}details{border:1px solid #ddd;border-radius:14px;padding:10px}summary{cursor:pointer;font-weight:700}li{margin:.25rem 0}@media(prefers-color-scheme:dark){body{background:#000;color:#f5f5f5}.card,input,button,.user,details{background:#000;color:#f5f5f5;border-color:#2a2a2a}.muted,.stats{color:#aaa}}</style><body><main class="wrap"><h1>管理员配置</h1><form class="card" id="adminForm"><label>Brevo API Key<input name="brevoApiKey" id="brevoApiKey"></label><details><summary>查看 Brevo API Key 获取教程</summary><ol><li>打开 <a href="https://www.brevo.com/" target="_blank" rel="noreferrer">Brevo 官网</a> 并注册或登录账号。</li><li>进入 Brevo 控制台后，打开右上角账号菜单。</li><li>进入「SMTP & API」。</li><li>切换到「API Keys」。也可以直接尝试打开 <a href="https://app.brevo.com/settings/keys/api" target="_blank" rel="noreferrer">Brevo API Keys 页面</a>。</li><li>点击「Generate a new API key」。</li><li>名称可填写 <b>NodeSeek RSS Reader</b>。</li><li>复制生成的 API Key，粘贴到本页的「Brevo API Key」。</li><li>继续填写「发件邮箱」和「发件人名称」，然后点击保存。</li></ol><p class="muted">注意：发件邮箱必须是 Brevo 允许发送的邮箱或已验证域名下的邮箱；如果邮件发不出去，请先在 Brevo 检查 Sender / Domain 是否已验证。API Key 保存后不会明文显示，留空保存不会覆盖旧 Key。</p></details><label>发件邮箱<input name="mailFrom" id="mailFrom"></label><label>发件人名称<input name="mailFromName" id="mailFromName"></label><label>Telegram Bot Token<input name="telegramBotToken" id="telegramBotToken"></label><label>Telegram Bot 用户名<input name="telegramBotUsername" id="telegramBotUsername" placeholder="@your_bot_name"></label><label>已读保留天数<input name="readStateRetentionDays" id="readStateRetentionDays" type="number" min="1" max="3650"></label><label>RSS帖子保留天数<input name="postRetentionDays" id="postRetentionDays" type="number" min="1" max="3650"></label><label>推送日志保留天数<input name="pushLogRetentionDays" id="pushLogRetentionDays" type="number" min="1" max="3650"></label><button class="primary">保存</button><a href="/">返回阅读器</a><p class="muted">管理链接包含 SECRET，请不要分享。请保存当前完整链接为书签。</p></form><section class="card"><h2>用户管理</h2><button type="button" id="refreshUsers">刷新用户列表</button><div id="users" class="muted">加载中</div></section></main><script>const token='${safeToken}';const $=s=>document.querySelector(s);function toast(m){alert(m)}async function load(){const r=await fetch('/api/admin/settings?token='+encodeURIComponent(token));if(!r.ok){toast('管理员 token 不正确');return}const s=await r.json();$('#brevoApiKey').placeholder=s.brevoApiKeyConfigured?'已配置，留空不修改':'未配置';$('#telegramBotToken').placeholder=s.telegramBotTokenConfigured?'已配置，留空不修改':'未配置';$('#telegramBotUsername').value=s.telegramBotUsername||'';$('#mailFrom').value=s.mailFrom||'';$('#mailFromName').value=s.mailFromName||'';$('#readStateRetentionDays').value=s.readStateRetentionDays;$('#postRetentionDays').value=s.postRetentionDays;$('#pushLogRetentionDays').value=s.pushLogRetentionDays;loadUsers()}async function loadUsers(){const r=await fetch('/api/admin/users?token='+encodeURIComponent(token));if(!r.ok){$('#users').textContent='用户列表加载失败';return}const data=await r.json();$('#users').innerHTML=data.users.length?data.users.map(u=>'<div class="user"><div><b>'+u.username+'</b><div class="stats">邮箱 '+(u.email?'已绑定':'未绑定')+' · TG '+(u.telegram_chat_id?'已绑定':'未绑定')+' · 高亮 '+u.highlight_group_count+' · 屏蔽 '+u.block_rule_count+' · 订阅 '+u.subscription_count+' · 已读 '+u.read_count+'</div></div><button class="danger" data-del="'+u.id+'" data-name="'+u.username+'">删除</button></div>').join(''):'暂无用户'}$('#refreshUsers').onclick=loadUsers;document.addEventListener('click',async e=>{const b=e.target;if(!b.dataset.del)return;if(!confirm('确认删除用户 '+b.dataset.name+'？该用户的阅读状态、高亮、屏蔽、订阅和推送日志都会被删除。'))return;const r=await fetch('/api/admin/users/'+b.dataset.del+'?token='+encodeURIComponent(token),{method:'DELETE'});toast(r.ok?'已删除':'删除失败');loadUsers()});$('#adminForm').onsubmit=async e=>{e.preventDefault();const body=Object.fromEntries(new FormData(e.target));body.readStateRetentionDays=Number(body.readStateRetentionDays);body.postRetentionDays=Number(body.postRetentionDays);body.pushLogRetentionDays=Number(body.pushLogRetentionDays);const r=await fetch('/api/admin/settings?token='+encodeURIComponent(token),{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)});toast(r.ok?'已保存':'保存失败')};load()</script></body></html>`;
}
