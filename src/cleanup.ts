import { nowIso, one } from "./db";
import { runtimeSettings } from "./settings";
import type { Env } from "./types";

function cutoff(days: number): string {
  return new Date(Date.now() - days * 86400 * 1000).toISOString();
}

export async function cleanupOldData(env: Env): Promise<void> {
  const last = await one<{ value: string }>(env.DB.prepare("SELECT value FROM sync_state WHERE key = 'last_cleanup_at'"));
  if (last?.value && Date.now() - new Date(last.value).getTime() < 86400 * 1000) return;
  const settings = await runtimeSettings(env);
  const readCutoff = cutoff(settings.readStateRetentionDays);
  const pushCutoff = cutoff(settings.pushLogRetentionDays);
  await env.DB.prepare("DELETE FROM rss_fetch_attempts WHERE created_at < ?").bind(cutoff(1)).run();
  await env.DB.prepare("DELETE FROM read_states WHERE opened_at < ?").bind(readCutoff).run();
  await env.DB.prepare("DELETE FROM push_logs WHERE created_at < ?").bind(pushCutoff).run();
  await env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at < ?").bind(nowIso()).run();
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(nowIso()).run();
  const updatedAt = nowIso();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sync_state (key, value, updated_at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM sync_state WHERE key = ?) ON CONFLICT(key) DO NOTHING").bind("last_cleanup_at", updatedAt, updatedAt, "last_cleanup_at"),
    env.DB.prepare("UPDATE sync_state SET value = ?, updated_at = ? WHERE key = 'last_cleanup_at'").bind(updatedAt, updatedAt)
  ]);
}
