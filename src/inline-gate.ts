// Inline-mode sync gate.
//
// Cloudflare may merge the three every-minute cron expressions (sync, notify,
// maintenance) into a single trigger whose `event.cron` text is whichever
// expression the platform picked. Inline mode runs the full RSS sync inside
// that invocation, so the role cannot be the gate; instead every recognized
// trigger competes for one claim per UTC minute. Only the invocation that
// writes the new minute value runs the sync body.
import type { Env } from "./types";

export const INLINE_TICK_KEY = "last_inline_tick_minute";

export function inlineMinuteKey(nowMs: number): string {
  return Math.floor(nowMs / 60000).toString();
}

// Returns true when this invocation owns the current UTC minute. A D1 failure
// fails open (runs the sync) because skipping is the failure mode that causes
// an outage: a rare duplicate sync is harmless, stopped RSS is not.
export async function claimInlineSyncMinute(env: Env, nowMs: number = Date.now()): Promise<boolean> {
  const minute = inlineMinuteKey(nowMs);
  try {
    const result = await env.DB.prepare(
      "INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE sync_state.value <> excluded.value"
    )
      .bind(INLINE_TICK_KEY, minute, new Date(nowMs).toISOString())
      .run();
    return result.meta.changes !== 0;
  } catch (error) {
    console.error("inline tick claim failed", error instanceof Error ? error.message : String(error));
    return true;
  }
}
