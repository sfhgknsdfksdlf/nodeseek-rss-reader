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

export function highlightText(text: string, groups: HighlightGroup[]): string {
  let output = escapeHtml(text);
  for (const group of groups) {
    for (const pattern of group.patterns) {
      const re = safeRegex(pattern);
      if (!re) continue;
      output = output.replace(new RegExp(re.source, "gi"), (match) => `<mark style="background:${escapeAttr(group.color)}">${match}</mark>`);
    }
  }
  return output;
}

export function postTextForBlock(post: Post): string {
  return `${post.title}\n${post.content_text}\n${post.author || ""}`;
}

export function postTextForHighlight(post: Post): string {
  return `${post.title}\n${post.content_text}`;
}
