import type { Post } from "./types";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[ch] || ch));
}

export function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

export function safeHttpUrl(value: string, fallback = "#"): string {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : fallback;
  } catch {
    return fallback;
  }
}

export function safeRegex(pattern: string): RegExp | null {
  if (!pattern || pattern.length > 200 || regexHasBacktrackingHazard(pattern)) return null;
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

export type ChainedRuleParseResult =
  | { readonly ok: true; readonly segments: readonly string[] }
  | { readonly ok: false; readonly reason: string };

export type ChainedRuleCompileResult =
  | { readonly ok: true; readonly segments: readonly RegExp[] }
  | { readonly ok: false; readonly reason: string; readonly segmentIndex?: number };

export interface ChainedRuleMatch {
  readonly index: number;
  readonly length: number;
  readonly text: string;
}

export function parseChainedRule(rule: string): ChainedRuleParseResult {
  const trimmedRule = rule.trim();
  if (!trimmedRule) return { ok: false, reason: "不能为空" };
  const segments = trimmedRule.split("####");
  if (segments.length > 4) return { ok: false, reason: "分段数量超过上限（最多 4 段）" };
  if (segments.some((segment) => !segment.trim())) return { ok: false, reason: "分段不能为空" };
  return { ok: true, segments };
}

export function compileChainedRule(rule: string): ChainedRuleCompileResult {
  const parsed = parseChainedRule(rule);
  if (!parsed.ok) return parsed;
  const compiled: RegExp[] = [];
  for (const [segmentIndex, segment] of parsed.segments.entries()) {
    const regex = safeRegex(segment);
    if (!regex) return { ok: false, reason: "不是有效的正则表达式", segmentIndex };
    compiled.push(regex);
  }
  return { ok: true, segments: compiled };
}

export function matchChainedRule(compiled: readonly RegExp[], haystack: string): boolean {
  return compiled.every((regex) => regex.test(haystack));
}

export function extractChainedRuleMatches(compiled: readonly RegExp[], haystack: string): readonly ChainedRuleMatch[] {
  const matches: ChainedRuleMatch[] = [];
  for (const regex of compiled) {
    const match = regex.exec(haystack);
    if (!match) return [];
    matches.push({ index: match.index, length: match[0].length, text: match[0] });
  }
  return matches;
}

// Reject the common nested-quantifier shape such as (a+)+. This is not a
// general regex timeout; valid simple expressions remain supported.
export function regexHasBacktrackingHazard(pattern: string): boolean {
  return /\((?:[^()\\]|\.)*[+*](?:[^()\\]|\.)*\)(?:[+*]|\{\d+(?:,\d*)?\})/.test(pattern)
    || /(?:^|[^\w\\])(?:[\w\\](?:[+*]|\{\d+(?:,\d*)?\})){2}/.test(pattern)
    || /\((?:[^()\\]|\.)*\|(?:[^()\\]|\.)*\)(?:[+*]|\{\d+(?:,\d*)?\})/.test(pattern);
}

export function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

export function markdownImagesToHtml(value: string): string {
  return value.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (_all, alt: string, src: string) => `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}">`);
}

export function sanitizePostHtml(raw: string): string {
  let html = markdownImagesToHtml(raw);
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  html = html.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  html = html.replace(/javascript:/gi, "");
  html = html.replace(/<(?!\/?(?:p|br|a|img|blockquote|code|pre|strong|em|ul|ol|li)\b)[^>]+>/gi, "");
  html = html.replace(/<a\b([^>]*)>/gi, (_m, attrs: string) => {
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] || "#";
    return `<a href="${escapeAttr(safeHttpUrl(href))}" target="_blank" rel="noreferrer">`;
  });
  html = html.replace(/<img\b([^>]*)>/gi, (_m, attrs: string) => {
    const src = /src\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] || "";
    const alt = /alt\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] || "";
    if (!/^https?:\/\//i.test(src)) return "";
    return `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" loading="lazy">`;
  });
  return html.trim();
}

export function postTextForBlock(post: Pick<Post, "title" | "content_text" | "author">): string {
  return `${post.title}\n${post.content_text}\n${post.author || ""}`;
}

export function postTextForHighlight(post: Post): string {
  return `${post.title}\n${post.content_text}`;
}
