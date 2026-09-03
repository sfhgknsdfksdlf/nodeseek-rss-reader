import { all } from "./db";
import type { BlockRule, Env, HighlightGroup, User } from "./types";

interface BlockRuleVersionRow {
  id: number;
  pattern: string;
  created_at: string;
}

interface HighlightGroupVersionRow {
  id: number;
  name: string;
  color: string;
  created_at: string;
  updated_at: string;
}

interface HighlightRuleVersionRow {
  id: number;
  group_id: number;
  pattern: string;
  created_at: string;
}

export interface RulePayload {
  userId: number | null;
  rulesVersion: string;
  blockRules?: BlockRule[];
  highlightGroups?: HighlightGroup[];
}

export async function getBlockRules(env: Env, user: User | null): Promise<BlockRule[]> {
  if (!user) return [];
  return all<BlockRule>(env.DB.prepare("SELECT * FROM block_rules WHERE user_id = ? ORDER BY id DESC").bind(user.id));
}

export async function getHighlightGroups(env: Env, user: User | null): Promise<HighlightGroup[]> {
  if (!user) return [];
  const rows = await all<{ id: number; user_id: number; name: string; color: string; pattern: string | null }>(env.DB.prepare(`
    SELECT hg.id, hg.user_id, hg.name, hg.color, hr.pattern
    FROM highlight_groups hg
    LEFT JOIN highlight_rules hr ON hr.group_id = hg.id
    WHERE hg.user_id = ?
    ORDER BY hg.id DESC, hr.id DESC
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

export async function getRulesVersion(env: Env, user: User | null): Promise<string> {
  if (!user) return "anonymous";
  const [blocks, groups, highlightRules] = await Promise.all([
    all<BlockRuleVersionRow>(env.DB.prepare("SELECT id, pattern, created_at FROM block_rules WHERE user_id = ? ORDER BY id").bind(user.id)),
    all<HighlightGroupVersionRow>(env.DB.prepare("SELECT id, name, color, created_at, updated_at FROM highlight_groups WHERE user_id = ? ORDER BY id").bind(user.id)),
    all<HighlightRuleVersionRow>(env.DB.prepare("SELECT hr.id, hr.group_id, hr.pattern, hr.created_at FROM highlight_rules hr JOIN highlight_groups hg ON hg.id = hr.group_id WHERE hg.user_id = ? ORDER BY hr.id").bind(user.id)),
  ]);
  return digestVersion(JSON.stringify({ userId: user.id, blocks, groups, highlightRules }));
}

export async function getInitialRulePayload(env: Env, user: User | null, clientVersion: string | null, clientCacheCapable = false): Promise<RulePayload> {
  const rulesVersion = await getRulesVersion(env, user);
  const payload: RulePayload = { userId: user?.id || null, rulesVersion };
  if (user) {
    const [blockRules, highlightGroups] = await Promise.all([getBlockRules(env, user), getHighlightGroups(env, user)]);
    payload.blockRules = blockRules;
    payload.highlightGroups = highlightGroups;
  }
  return payload;
}
