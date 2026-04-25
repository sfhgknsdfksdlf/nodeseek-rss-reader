import { all, readJson } from "./db";
import { safeRegex } from "./filters";
import { sendBrevo, sendTelegram } from "./notifications";
import { runtimeSettings } from "./settings";
import type { Env, Post, Subscription, User } from "./types";

interface SubscriptionWithUser extends Subscription {
  username: string;
  email: string | null;
  telegram_chat_id: string | null;
  telegram_bind_code: string | null;
  telegram_bind_code_expires_at: string | null;
}

function pushKey(userId: number, subscriptionId: number, postId: number, channel: string): string {
  return `${userId}:${subscriptionId}:${postId}:${channel}`;
}

export async function processSubscriptions(env: Env, posts: Post[]): Promise<void> {
  if (!posts.length) return;
  const subs = await all<SubscriptionWithUser>(env.DB.prepare(`
    SELECT s.*, u.username, u.email, u.telegram_chat_id, u.telegram_bind_code, u.telegram_bind_code_expires_at
    FROM subscriptions s
    JOIN users u ON u.id = s.user_id
    ORDER BY s.id DESC
  `));
  if (!subs.length) return;
  const postIds = posts.map((post) => post.id);
  const placeholders = postIds.map(() => "?").join(",");
  const logRows = await all<{ user_id: number; subscription_id: number; post_id: number; channel: string }>(
    env.DB.prepare(`SELECT user_id, subscription_id, post_id, channel FROM push_logs WHERE post_id IN (${placeholders})`).bind(...postIds)
  );
  const sent = new Set(logRows.map((row) => pushKey(row.user_id, row.subscription_id, row.post_id, row.channel)));
  const compiledSubs = subs.map((sub) => ({ sub, regex: safeRegex(sub.pattern) })).filter((item): item is { sub: SubscriptionWithUser; regex: RegExp } => !!item.regex);
  if (!compiledSubs.length) return;
  const settings = await runtimeSettings(env);
  const postTexts = new Map(posts.map((post) => [post.id, `${post.title}\n${post.content_text}\n${post.author || ""}\n${post.board_key || ""}`]));
  for (const { sub, regex } of compiledSubs) {
    const user: User = { id: sub.user_id, username: sub.username, email: sub.email, telegram_chat_id: sub.telegram_chat_id, telegram_bind_code: sub.telegram_bind_code, telegram_bind_code_expires_at: sub.telegram_bind_code_expires_at };
    for (const post of posts) {
      if (!regex.test(postTexts.get(post.id) || "")) continue;
      if (sub.send_email && !sent.has(pushKey(user.id, sub.id, post.id, "email"))) {
        await sendBrevo(env, user, sub, post, settings);
        sent.add(pushKey(user.id, sub.id, post.id, "email"));
      }
      if (sub.send_telegram && !sent.has(pushKey(user.id, sub.id, post.id, "telegram"))) {
        await sendTelegram(env, user, sub, post, settings);
        sent.add(pushKey(user.id, sub.id, post.id, "telegram"));
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
