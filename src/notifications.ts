import { nowIso } from "./db";
import type { Env, Post, Subscription, User } from "./types";

async function logPush(env: Env, userId: number, subscriptionId: number, postId: number, channel: string, status: string, error = ""): Promise<void> {
  await env.DB.prepare("INSERT OR IGNORE INTO push_logs (user_id, subscription_id, post_id, channel, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(userId, subscriptionId, postId, channel, status, error || null, nowIso())
    .run();
}

export async function sendBrevo(env: Env, user: User, sub: Subscription, post: Post): Promise<void> {
  if (!env.BREVO_API_KEY || !env.MAIL_FROM || !user.email) return;
  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        sender: { email: env.MAIL_FROM, name: env.MAIL_FROM_NAME || "NodeSeek RSS Reader" },
        to: [{ email: user.email, name: user.username }],
        subject: `NodeSeek 订阅命中：${post.title}`,
        htmlContent: `<p>${post.title}</p><p>${post.content_text.slice(0, 300)}</p><p><a href="${post.link}">打开原帖</a></p>`
      })
    });
    await logPush(env, user.id, sub.id, post.id, "email", res.ok ? "sent" : "failed", res.ok ? "" : await res.text());
  } catch (err) {
    await logPush(env, user.id, sub.id, post.id, "email", "failed", err instanceof Error ? err.message : String(err));
  }
}

export async function sendTelegram(env: Env, user: User, sub: Subscription, post: Post): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !user.telegram_chat_id) return;
  try {
    const text = `NodeSeek 订阅命中\n${post.title}\n${post.link}`;
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: user.telegram_chat_id, text, disable_web_page_preview: false })
    });
    await logPush(env, user.id, sub.id, post.id, "telegram", res.ok ? "sent" : "failed", res.ok ? "" : await res.text());
  } catch (err) {
    await logPush(env, user.id, sub.id, post.id, "telegram", "failed", err instanceof Error ? err.message : String(err));
  }
}
