import { bindTelegramForUser, getTelegramBindingByNonce } from './db';
import type { Env } from './types';

export async function sendTelegramText(env: Env, chatId: string, text: string): Promise<{ ok: boolean; detail: string }> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    return { ok: false, detail: 'telegram-not-configured' };
  }
  const res = await fetch(`${env.TELEGRAM_API_BASE}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true
    })
  });
  const body = await res.text();
  return { ok: res.ok, detail: body.slice(0, 500) };
}

export async function handleTelegramWebhook(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const secret = url.pathname.split('/').pop();
  if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response('forbidden', { status: 403 });
  }
  const update = await request.json<any>();
  const message = update?.message;
  const text = String(message?.text ?? '');
  const chatId = String(message?.chat?.id ?? '');
  const username = message?.from?.username ? String(message.from.username) : null;
  const startMatch = text.match(/^\/start\s+([a-zA-Z0-9\-]+)$/);
  if (startMatch && chatId) {
    const nonce = startMatch[1];
    const binding = await getTelegramBindingByNonce(env, nonce);
    if (binding && new Date(binding.expires_at).getTime() > Date.now()) {
      await bindTelegramForUser(env, binding.user_id, chatId, username, nonce);
      await sendTelegramText(env, chatId, '绑定成功，现在你会收到订阅推送。');
    } else {
      await sendTelegramText(env, chatId, '绑定码无效或已过期，请回到网站重新生成。');
    }
  }
  return new Response('ok');
}
