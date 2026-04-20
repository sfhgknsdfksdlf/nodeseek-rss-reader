import { deliveryExists, listSubscriptionRulesWithUsers, recordDelivery } from './db';
import { sendTelegramText } from './telegram';
import type { Env, PostRecord } from './types';
import { safeRegex } from './utils';

function composeNotification(post: PostRecord): string {
  return [
    `NodeSeek 命中订阅`,
    `标题：${post.title}`,
    `作者：${post.author_name}`,
    `板块：${post.category_slug}`,
    `时间：${post.published_at_utc}`,
    `链接：${post.source_url}`
  ].join('\n');
}

async function sendEmail(env: Env, to: string, subject: string, text: string): Promise<{ ok: boolean; detail: string }> {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) {
    return { ok: false, detail: 'email-not-configured' };
  }
  const res = await fetch(env.RESEND_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.RESEND_API_KEY}`
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL,
      to: [to],
      subject,
      text
    })
  });
  const body = await res.text();
  return { ok: res.ok, detail: body.slice(0, 500) };
}

export async function notifyForNewPosts(env: Env, posts: PostRecord[]): Promise<void> {
  if (!posts.length) return;
  const rules = await listSubscriptionRulesWithUsers(env);
  for (const post of posts) {
    const haystack = [post.title, post.content_text, post.author_name, post.category_slug].join('\n');
    for (const rule of rules) {
      const matched = safeRegex(rule.pattern).test(haystack);
      if (!matched) continue;
      const message = composeNotification(post);
      if (rule.notify_telegram && rule.telegram_chat_id) {
        const exists = await deliveryExists(env, rule.user_id, rule.id, post.id, 'telegram');
        if (!exists) {
          const sent = await sendTelegramText(env, rule.telegram_chat_id, message);
          await recordDelivery(env, rule.user_id, rule.id, post.id, 'telegram', sent.ok ? 'sent' : 'failed', sent.detail);
        }
      }
      if (rule.notify_email && rule.email && rule.email_verified) {
        const exists = await deliveryExists(env, rule.user_id, rule.id, post.id, 'email');
        if (!exists) {
          const sent = await sendEmail(env, rule.email, `NodeSeek 订阅命中：${post.title}`, message);
          await recordDelivery(env, rule.user_id, rule.id, post.id, 'email', sent.ok ? 'sent' : 'failed', sent.detail);
        }
      }
    }
  }
}
