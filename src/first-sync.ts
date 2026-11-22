// First-sync timeout release helpers (pure, shared by the producer, the
// notification cron, and the fixtures).
//
// The bounded first-sync retry window prevents a permanently missing snapshot
// GUID from blocking notifications forever. When the window expires we release
// the first sync atomically and record the still-missing snapshot GUIDs in
// `sync_state.first_sync_incomplete`; the notification cron excludes exactly
// those GUIDs if they are inserted later, so historical posts can still land in
// D1 without ever being pushed as new.
export const FIRST_SYNC_INCOMPLETE_KEY = "first_sync_incomplete";
export const FIRST_SYNC_RELEASE_REASON = "timeout_released";
const MAX_RELEASE_GUIDS = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Only a round-trippable ISO start is accepted. Date.parse also accepts
// rolled-over calendar dates ("2024-02-30") and numeric strings ("0"), which
// the producer never writes and which must not be read as an expired window.
export function parseFirstSyncStartMs(startedAt: string | null): number | null {
  if (typeof startedAt !== "string" || startedAt.length === 0) return null;
  const ms = Date.parse(startedAt);
  if (!Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString() === startedAt ? ms : null;
  } catch {
    return null;
  }
}

// A missing, empty, or unparseable window start is repaired to "now" by the
// producer before expiry is computed: malformed timestamps must not be treated
// as an already-expired window.
export function isValidFirstSyncStart(startedAt: string | null): boolean {
  return parseFirstSyncStartMs(startedAt) !== null;
}

// Accepts only the timeout-release audit shape. Legacy `{missing, requeued, at}`
// rows and any malformed value yield no exclusions; this helper never throws.
export function parseTimeoutReleaseGuids(raw: string | null): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  if (parsed.reason !== FIRST_SYNC_RELEASE_REASON) return [];
  if (!Array.isArray(parsed.missingGuids)) return [];
  const seen = new Set<string>();
  const guids: string[] = [];
  for (const entry of parsed.missingGuids) {
    if (typeof entry !== "string") continue;
    const guid = entry.trim();
    if (!guid || seen.has(guid)) continue;
    seen.add(guid);
    guids.push(guid);
    if (guids.length >= MAX_RELEASE_GUIDS) break;
  }
  return guids;
}

// The audit value is the only record that a GUID must never be notified, so it
// is bounded and deduped exactly like the parser's output.
export function buildTimeoutReleaseDetail(startedAt: string, releasedAt: string, missingGuids: string[]): string {
  const seen = new Set<string>();
  const bounded: string[] = [];
  for (const raw of missingGuids) {
    const guid = raw.trim();
    if (!guid || seen.has(guid)) continue;
    seen.add(guid);
    bounded.push(guid);
    if (bounded.length >= MAX_RELEASE_GUIDS) break;
  }
  return JSON.stringify({ reason: FIRST_SYNC_RELEASE_REASON, startedAt, releasedAt, missingGuids: bounded });
}
