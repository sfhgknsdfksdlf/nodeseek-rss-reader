import type { Env, FeedState, HighlightGroup, HighlightRule, MuteRule, PostRecord, SubscriptionRule, SubscriptionRuleWithUser, User } from './types';

export async function getFeedState(env: Env): Promise<FeedState> {
  const row = await env.DB.prepare('SELECT * FROM feed_state WHERE id = 1').first<FeedState>();
  if (!row) throw new Error('feed_state missing');
  return row;
}

export async function acquireIngestLock(env: Env, ttlSeconds = 45): Promise<boolean> {
  const until = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const result = await env.DB.prepare(`
    UPDATE feed_state
    SET ingest_lock_until = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = 1 AND (ingest_lock_until IS NULL OR ingest_lock_until < CURRENT_TIMESTAMP)
  `).bind(until).run();
  return Boolean(result.meta.changes);
}

export async function releaseIngestLock(env: Env, buildDate: string | null, touched = true): Promise<void> {
  await env.DB.prepare(`
    UPDATE feed_state
    SET ingest_lock_until = NULL,
        last_ingest_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE last_ingest_at END,
        last_success_build_date = COALESCE(?, last_success_build_date),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `).bind(touched ? 1 : 0, buildDate).run();
}

export async function insertPost(env: Env, post: Omit<PostRecord, 'id' | 'fetched_at_utc' | 'created_at'>): Promise<number | null> {
  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO posts (
      external_id, source_url, title, content_html, content_text, author_name, category_slug, published_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    post.external_id,
    post.source_url,
    post.title,
    post.content_html,
    post.content_text,
    post.author_name,
    post.category_slug,
    post.published_at_utc
  ).run();
  if (!result.meta.changes) return null;
  const created = await env.DB.prepare('SELECT id FROM posts WHERE external_id = ?').bind(post.external_id).first<{ id: number }>();
  return created?.id ?? null;
}

export async function countPosts(env: Env, category?: string): Promise<number> {
  const sql = category && category !== 'all'
    ? 'SELECT COUNT(*) as total FROM posts WHERE category_slug = ?'
    : 'SELECT COUNT(*) as total FROM posts';
  const stmt = env.DB.prepare(sql);
  const row = category && category !== 'all'
    ? await stmt.bind(category).first<{ total: number }>()
    : await stmt.first<{ total: number }>();
  return Number(row?.total ?? 0);
}

export async function listPosts(env: Env, page: number, pageSize: number, category?: string): Promise<PostRecord[]> {
  const offset = (page - 1) * pageSize;
  const sql = category && category !== 'all'
    ? `SELECT * FROM posts WHERE category_slug = ? ORDER BY published_at_utc DESC, id DESC LIMIT ? OFFSET ?`
    : `SELECT * FROM posts ORDER BY published_at_utc DESC, id DESC LIMIT ? OFFSET ?`;
  const stmt = env.DB.prepare(sql);
  const res = category && category !== 'all'
    ? await stmt.bind(category, pageSize, offset).all<PostRecord>()
    : await stmt.bind(pageSize, offset).all<PostRecord>();
  return res.results ?? [];
}

export async function listRecentPosts(env: Env, limit: number, category?: string): Promise<PostRecord[]> {
  const sql = category && category !== 'all'
    ? `SELECT * FROM posts WHERE category_slug = ? ORDER BY published_at_utc DESC, id DESC LIMIT ?`
    : `SELECT * FROM posts ORDER BY published_at_utc DESC, id DESC LIMIT ?`;
  const stmt = env.DB.prepare(sql);
  const res = category && category !== 'all'
    ? await stmt.bind(category, limit).all<PostRecord>()
    : await stmt.bind(limit).all<PostRecord>();
  return res.results ?? [];
}

export async function getPostById(env: Env, id: number): Promise<PostRecord | null> {
  return (await env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first<PostRecord>()) ?? null;
}

export async function createUser(env: Env, username: string, passwordHash: string): Promise<void> {
  await env.DB.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').bind(username, passwordHash).run();
}

export async function getUserByUsername(env: Env, username: string): Promise<User | null> {
  return (await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first<User>()) ?? null;
}

export async function markPostRead(env: Env, userId: number, postId: number): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO user_reads (user_id, post_id, read_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, post_id) DO UPDATE SET read_at = CURRENT_TIMESTAMP
  `).bind(userId, postId).run();
}

export async function getReadPostIds(env: Env, userId: number, postIds: number[]): Promise<Set<number>> {
  if (!postIds.length) return new Set();
  const placeholders = postIds.map(() => '?').join(',');
  const res = await env.DB.prepare(`SELECT post_id FROM user_reads WHERE user_id = ? AND post_id IN (${placeholders})`)
    .bind(userId, ...postIds)
    .all<{ post_id: number }>();
  return new Set((res.results ?? []).map((r) => r.post_id));
}

export async function listHighlightGroups(env: Env, userId: number): Promise<HighlightGroup[]> {
  const groups = (await env.DB.prepare('SELECT * FROM highlight_groups WHERE user_id = ? ORDER BY sort_order ASC, id ASC').bind(userId).all<any>()).results ?? [];
  const rules = (await env.DB.prepare('SELECT * FROM highlight_rules WHERE user_id = ? ORDER BY id DESC').bind(userId).all<HighlightRule>()).results ?? [];
  return groups.map((group: any) => ({ ...group, rules: rules.filter((rule) => rule.group_id === group.id) }));
}

export async function addHighlightGroup(env: Env, userId: number, name: string, color: string): Promise<void> {
  await env.DB.prepare('INSERT INTO highlight_groups (user_id, name, color, sort_order) VALUES (?, ?, ?, ?)')
    .bind(userId, name, color, Date.now())
    .run();
}

export async function addHighlightRule(env: Env, userId: number, groupId: number, pattern: string): Promise<void> {
  await env.DB.prepare('INSERT INTO highlight_rules (user_id, group_id, pattern) VALUES (?, ?, ?)').bind(userId, groupId, pattern).run();
}

export async function clearHighlightRules(env: Env, userId: number, groupId: number): Promise<void> {
  await env.DB.prepare('DELETE FROM highlight_rules WHERE user_id = ? AND group_id = ?').bind(userId, groupId).run();
}

export async function deleteHighlightGroup(env: Env, userId: number, groupId: number): Promise<void> {
  await env.DB.prepare('DELETE FROM highlight_groups WHERE user_id = ? AND id = ?').bind(userId, groupId).run();
}

export async function deleteHighlightRule(env: Env, userId: number, ruleId: number): Promise<void> {
  await env.DB.prepare('DELETE FROM highlight_rules WHERE user_id = ? AND id = ?').bind(userId, ruleId).run();
}

export async function listMuteRules(env: Env, userId: number): Promise<MuteRule[]> {
  const rows = await env.DB.prepare('SELECT * FROM mute_rules WHERE user_id = ? ORDER BY id DESC').bind(userId).all<MuteRule>();
  return rows.results ?? [];
}

export async function addMuteRule(env: Env, userId: number, pattern: string): Promise<void> {
  await env.DB.prepare('INSERT INTO mute_rules (user_id, pattern) VALUES (?, ?)').bind(userId, pattern).run();
}

export async function clearMuteRules(env: Env, userId: number): Promise<void> {
  await env.DB.prepare('DELETE FROM mute_rules WHERE user_id = ?').bind(userId).run();
}

export async function deleteMuteRule(env: Env, userId: number, ruleId: number): Promise<void> {
  await env.DB.prepare('DELETE FROM mute_rules WHERE user_id = ? AND id = ?').bind(userId, ruleId).run();
}

export async function listSubscriptionRules(env: Env, userId: number): Promise<SubscriptionRule[]> {
  const rows = await env.DB.prepare('SELECT * FROM subscription_rules WHERE user_id = ? ORDER BY id DESC').bind(userId).all<SubscriptionRule>();
  return rows.results ?? [];
}

export async function addSubscriptionRule(env: Env, userId: number, pattern: string, notifyEmail: boolean, notifyTelegram: boolean): Promise<void> {
  await env.DB.prepare(`INSERT INTO subscription_rules (user_id, pattern, notify_email, notify_telegram) VALUES (?, ?, ?, ?)`)
    .bind(userId, pattern, notifyEmail ? 1 : 0, notifyTelegram ? 1 : 0)
    .run();
}

export async function clearSubscriptionRules(env: Env, userId: number): Promise<void> {
  await env.DB.prepare('DELETE FROM subscription_rules WHERE user_id = ?').bind(userId).run();
}

export async function deleteSubscriptionRule(env: Env, userId: number, ruleId: number): Promise<void> {
  await env.DB.prepare('DELETE FROM subscription_rules WHERE user_id = ? AND id = ?').bind(userId, ruleId).run();
}

export async function listSubscriptionRulesWithUsers(env: Env): Promise<SubscriptionRuleWithUser[]> {
  const rows = await env.DB.prepare(`
    SELECT sr.*, u.email, u.email_verified, u.telegram_chat_id, u.telegram_username, u.username
    FROM subscription_rules sr
    JOIN users u ON u.id = sr.user_id
  `).all<SubscriptionRuleWithUser>();
  return rows.results ?? [];
}

export async function deliveryExists(env: Env, userId: number, subscriptionRuleId: number, postId: number, channel: string): Promise<boolean> {
  const row = await env.DB.prepare(`
    SELECT id FROM notification_deliveries WHERE user_id = ? AND subscription_rule_id = ? AND post_id = ? AND channel = ?
  `).bind(userId, subscriptionRuleId, postId, channel).first<{ id: number }>();
  return Boolean(row?.id);
}

export async function recordDelivery(env: Env, userId: number, subscriptionRuleId: number, postId: number, channel: string, status: string, responseExcerpt: string): Promise<void> {
  await env.DB.prepare(`
    INSERT OR IGNORE INTO notification_deliveries (user_id, subscription_rule_id, post_id, channel, status, response_excerpt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(userId, subscriptionRuleId, postId, channel, status, responseExcerpt.slice(0, 500)).run();
}

export async function setUserEmail(env: Env, userId: number, email: string): Promise<void> {
  await env.DB.prepare('UPDATE users SET email = ?, email_verified = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(email, userId).run();
}

export async function setTelegramNonce(env: Env, userId: number, nonce: string, expiresAt: string): Promise<void> {
  await env.DB.prepare('INSERT OR REPLACE INTO telegram_bindings (nonce, user_id, expires_at) VALUES (?, ?, ?)').bind(nonce, userId, expiresAt).run();
}

export async function getTelegramBindingByNonce(env: Env, nonce: string): Promise<{ user_id: number; expires_at: string } | null> {
  return (await env.DB.prepare('SELECT user_id, expires_at FROM telegram_bindings WHERE nonce = ?').bind(nonce).first<{ user_id: number; expires_at: string }>()) ?? null;
}

export async function bindTelegramForUser(env: Env, userId: number, chatId: string, username: string | null, nonce: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET telegram_chat_id = ?, telegram_username = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(chatId, username, userId),
    env.DB.prepare('DELETE FROM telegram_bindings WHERE nonce = ?').bind(nonce)
  ]);
}
