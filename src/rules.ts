import { all } from "./db";
import type { BlockRule, Env, HighlightGroup, User } from "./types";

export interface RulePayload {
  userId: number | null;
  rulesVersion: string;
  cacheHit?: boolean;
  blockRules?: BlockRule[];
  highlightGroups?: HighlightGroup[];
}

export async function getBlockRules(env: Env, user: User | null): Promise<BlockRule[]> {
  if (!user) return [];
  // Insertion order (id ASC) is the canonical rule order everywhere: the settings
  // page PUTs the payload array back on edit, so any other sort permutes saved rules.
  return all<BlockRule>(env.DB.prepare("SELECT * FROM block_rules WHERE user_id = ? ORDER BY id ASC").bind(user.id));
}

export async function getHighlightGroups(env: Env, user: User | null): Promise<HighlightGroup[]> {
  if (!user) return [];
  const rows = await all<{ id: number; user_id: number; name: string; color: string; pattern: string | null }>(env.DB.prepare(`
    SELECT hg.id, hg.user_id, hg.name, hg.color, hr.pattern
    FROM highlight_groups hg
    LEFT JOIN highlight_rules hr ON hr.group_id = hg.id
    WHERE hg.user_id = ?
    ORDER BY hg.id ASC, hr.id ASC
  `).bind(user.id));
  const byId = new Map<number, HighlightGroup>();
  for (const row of rows) {
    let group = byId.get(row.id);
    if (!group) {
      group = { id: row.id, user_id: row.user_id, name: row.name, color: row.color, patterns: [] };
      byId.set(row.id, group);
    }
    if (row.pattern) group.patterns.push(row.pattern);
  }
  return [...byId.values()];
}

async function digestVersion(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The version digest is computed from the complete canonical rule payload
// (block rules and highlight groups including patterns, with row ids), so any
// persisted change to any rule field changes the version. Cache negotiation
// therefore cannot serve stale rules after an in-place update, and the payload
// reads double as the digest input instead of duplicating them.
export async function getInitialRulePayload(env: Env, user: User | null, clientVersion: string | null, clientCacheCapable = false): Promise<RulePayload> {
  if (!user) return { userId: null, rulesVersion: "anonymous" };
  const [blockRules, highlightGroups] = await Promise.all([getBlockRules(env, user), getHighlightGroups(env, user)]);
  const rulesVersion = await digestVersion(JSON.stringify({ userId: user.id, blockRules, highlightGroups }));
  if (clientCacheCapable && clientVersion !== null && clientVersion.trim().length > 0 && clientVersion === rulesVersion) {
    return { userId: user.id, rulesVersion, cacheHit: true };
  }
  return { userId: user.id, rulesVersion, blockRules, highlightGroups };
}
