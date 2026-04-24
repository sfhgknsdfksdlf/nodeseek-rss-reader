import { all, one, readJson } from "./db";
import { regexMatches } from "./filters";
import { sendBrevo, sendTelegram } from "./notifications";
import type { Env, Post, Subscription, User } from "./types";

export async function processSubscriptions(env: Env, posts: Post[]): Promise<void> {
  if (!posts.length) return;
  const users = await all<User>(env.DB.prepare("SELECT id, username, email, telegram_chat_id, telegram_bind_code FROM users"));
  for (const user of users) {
    const subs = await all<Subscription>(env.DB.prepare("SELECT * FROM subscriptions WHERE user_id = ?").bind(user.id));
    for (const sub of subs) {
      for (const post of posts) {
        const matched = regexMatches(sub.pattern, `${post.title}\n${post.content_text}\n${post.author || ""}\n${post.board_key || ""}`);
        if (!matched) continue;
        const existing = await one<{ id: number }>(env.DB.prepare("SELECT id FROM push_logs WHERE user_id = ? AND subscription_id = ? AND post_id = ? LIMIT 1").bind(user.id, sub.id, post.id));
        if (existing) continue;
        if (sub.send_email) await sendBrevo(env, user, sub, post);
        if (sub.send_telegram) await sendTelegram(env, user, sub, post);
      }
    }
  }
}

export async function createSubscription(request: Request, env: Env, user: User): Promise<Response> {
  const body = await readJson<{ pattern?: string; sendEmail?: boolean; sendTelegram?: boolean }>(request);
  const pattern = (body.pattern || "").trim();
  if (!pattern || pattern.length > 200) return Response.json({ error: "订阅正则不能为空且不能超过 200 字符" }, { status: 400 });
  await env.DB.prepare("INSERT INTO subscriptions (user_id, pattern, send_email, send_telegram, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))")
    .bind(user.id, pattern, body.sendEmail === false ? 0 : 1, body.sendTelegram === false ? 0 : 1)
    .run();
  return Response.json({ ok: true });
}
