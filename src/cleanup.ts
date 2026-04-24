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
  const postCutoff = cutoff(settings.postRetentionDays);
  const pushCutoff = cutoff(settings.pushLogRetentionDays);
  await env.DB.prepare("DELETE FROM read_states WHERE opened_at < ?").bind(readCutoff).run();
  await env.DB.prepare("DELETE FROM push_logs WHERE created_at < ?").bind(pushCutoff).run();
  await env.DB.prepare("DELETE FROM read_states WHERE post_id IN (SELECT id FROM posts WHERE published_at < ?)").bind(postCutoff).run();
  await env.DB.prepare("DELETE FROM push_logs WHERE post_id IN (SELECT id FROM posts WHERE published_at < ?)").bind(postCutoff).run();
  await env.DB.prepare("DELETE FROM posts WHERE published_at < ?").bind(postCutoff).run();
  await env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at < ?").bind(nowIso()).run();
  await env.DB.prepare("INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES ('last_cleanup_at', ?, ?)").bind(nowIso(), nowIso()).run();
}
