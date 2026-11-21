import { nowIso } from "./db";
import { escapeAttr, escapeHtml, safeHttpUrl } from "./filters";
import { runtimeSettings } from "./settings";
import type { RuntimeSettings } from "./settings";
import type { Env, RssNewPost, Subscription, User } from "./types";

export type PushStatus = "sent" | "failed" | "skipped";

export interface SendResult {
  status: PushStatus;
  error: string;
}

export async function recordPushLog(
  env: Env,
  userId: number,
  subscriptionId: number,
  postGuid: string,
  channel: string,
  status: PushStatus,
  error: string
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO push_logs (user_id, subscription_id, post_guid, channel, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, subscription_id, post_guid, channel) DO UPDATE SET status = excluded.status, error = excluded.error, created_at = excluded.created_at"
  )
    .bind(userId, subscriptionId, postGuid, channel, status, error || null, nowIso())
    .run();
}

export async function sendBrevo(env: Env, user: User, sub: Subscription, post: RssNewPost, cachedSettings?: RuntimeSettings): Promise<SendResult> {
  const settings = cachedSettings || await runtimeSettings(env);
  if (!settings.brevoApiKey || !settings.mailFrom || !user.email) return { status: "skipped", error: "" };
  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": settings.brevoApiKey, "content-type": "application/json" },
      body: JSON.stringify({
        sender: { email: settings.mailFrom, name: settings.mailFromName },
        to: [{ email: user.email, name: user.username }],
        subject: `NodeSeek 订阅命中：${post.title}`,
        // RSS content is third-party input: escape text nodes, validate the
        // URL scheme, and attribute-escape the href before interpolation.
        htmlContent: `<p>${escapeHtml(post.title)}</p><p>${escapeHtml(post.content_text.slice(0, 300))}</p><p><a href="${escapeAttr(safeHttpUrl(post.link))}">打开原帖</a></p>`
      })
    });
    if (!res.ok) return { status: "failed", error: await res.text() };
    return { status: "sent", error: "" };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendTelegram(env: Env, user: User, sub: Subscription, post: RssNewPost, cachedSettings?: RuntimeSettings): Promise<SendResult> {
  const settings = cachedSettings || await runtimeSettings(env);
  if (!settings.telegramBotToken || !user.telegram_chat_id) return { status: "skipped", error: "" };
  try {
    const text = `NodeSeek 订阅命中\n${post.title}\n${post.link}`;
    const res = await fetch(`https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: user.telegram_chat_id, text, disable_web_page_preview: false })
    });
    if (!res.ok) return { status: "failed", error: await res.text() };
    return { status: "sent", error: "" };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}
