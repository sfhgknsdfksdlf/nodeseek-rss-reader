import type { HighlightGroup, Post } from "./types";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[ch] || ch));
}

export function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

export function safeRegex(pattern: string): RegExp | null {
  if (!pattern || pattern.length > 200) return null;
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

export function regexMatches(pattern: string, text: string): boolean {
  const re = safeRegex(pattern);
  if (!re) return false;
  return re.test(text);
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
    return `<a href="${escapeAttr(href)}" target="_blank" rel="noreferrer">`;
  });
  html = html.replace(/<img\b([^>]*)>/gi, (_m, attrs: string) => {
    const src = /src\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] || "";
    const alt = /alt\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] || "";
    if (!/^https?:\/\//i.test(src)) return "";
    return `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" loading="lazy">`;
  });
  return html.trim();
}

function escapeTextPreservingEntities(value: string): string {
  return value.replace(/&(?!(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function highlightText(text: string, groups: HighlightGroup[]): string {
  return highlightPlainText(text, groups);
}

function buildHighlightRanges(text: string, groups: HighlightGroup[]): Array<{ start: number; end: number; color: string }> {
  const ranges: Array<{ start: number; end: number; color: string }> = [];
  for (const group of groups) {
    for (const pattern of group.patterns) {
      const re = safeRegex(pattern);
      if (!re) continue;
      const globalRe = new RegExp(re.source, "gi");
      for (const match of text.matchAll(globalRe)) {
        const start = match.index ?? -1;
        const value = match[0] || "";
        if (start < 0 || !value) continue;
        ranges.push({ start, end: start + value.length, color: group.color });
      }
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: typeof ranges = [];
  for (const range of ranges) {
    const prev = merged[merged.length - 1];
    if (!prev || range.start >= prev.end) {
      merged.push(range);
    }
  }
  return merged;
}

function highlightPlainText(text: string, groups: HighlightGroup[]): string {
  if (!text) return "";
  const ranges = buildHighlightRanges(text, groups);
  if (!ranges.length) return escapeTextPreservingEntities(text);
  let output = "";
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) output += escapeTextPreservingEntities(text.slice(cursor, range.start));
    output += `<mark style="background:${escapeAttr(range.color)}">${escapeTextPreservingEntities(text.slice(range.start, range.end))}</mark>`;
    cursor = range.end;
  }
  if (cursor < text.length) output += escapeTextPreservingEntities(text.slice(cursor));
  return output;
}

export function highlightHtml(html: string, groups: HighlightGroup[]): string {
  if (!html) return "";
  const parts = html.split(/(<[^>]+>)/g);
  return parts.map((part) => (part.startsWith("<") && part.endsWith(">") ? part : highlightPlainText(part, groups))).join("");
}

export function postTextForBlock(post: Post): string {
  return `${post.title}\n${post.content_text}\n${post.author || ""}`;
}

export function postTextForHighlight(post: Post): string {
  return `${post.title}\n${post.content_text}`;
}
