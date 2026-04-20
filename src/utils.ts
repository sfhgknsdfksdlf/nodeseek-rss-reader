import { CATEGORY_LABELS } from './constants';
import type { HighlightGroup, PaginationModel } from './types';

export function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function parseInteger(value: string | undefined | null, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function slugToCategoryLabel(slug: string): string {
  return CATEGORY_LABELS[slug] ?? slug;
}

export function safeRegex(pattern: string): RegExp {
  const trimmed = pattern.trim();
  if (!trimmed) return /$a/;
  const sliced = trimmed.slice(0, 256);
  try {
    return new RegExp(sliced, 'i');
  } catch {
    const escaped = sliced.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped, 'i');
  }
}

export function formatBjTime(dateStr: string, nowMs = Date.now()): string {
  const date = new Date(dateStr);
  const now = new Date(nowMs);
  const zone = 'Asia/Shanghai';
  const dayFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const timeFmt = new Intl.DateTimeFormat('zh-CN', { timeZone: zone, hour: 'numeric', minute: '2-digit', hour12: false });
  const d1 = dayFmt.format(date);
  const d2 = dayFmt.format(now);
  const time = timeFmt.format(date);
  if (d1 === d2) return `今天 ${time}`;
  const [y, m, d] = d1.split('/');
  return `${y}-${m}-${d} ${time}`;
}

export function buildPagination(page: number, totalPages: number): PaginationModel {
  const p = Math.max(1, Math.min(page, Math.max(1, totalPages)));
  const pages: number[] = [p];
  for (let i = 1; i <= 3; i += 1) {
    if (p + i <= totalPages) pages.push(p + i);
  }
  return {
    page: p,
    totalPages: Math.max(1, totalPages),
    pages,
    hasPrev: p > 1,
    hasNext: p < totalPages,
    prevPage: Math.max(1, p - 1),
    nextPage: Math.min(totalPages, p + 1)
  };
}

export function withQuery(path: string, values: Record<string, string | number | undefined | null>): string {
  const url = new URL(path, 'https://example.com');
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

function applyHighlightedText(text: string, highlightGroups: HighlightGroup[]): string {
  let escaped = escapeHtml(text);
  for (const group of highlightGroups) {
    for (const rule of group.rules) {
      const regex = safeRegex(rule.pattern);
      escaped = escaped.replace(regex, (match) => `<span class="hl" style="background:${escapeHtml(group.color)}">${match}</span>`);
    }
  }
  return escaped;
}

function isImageUrl(url: string): boolean {
  return /\.(png|jpe?g|gif|webp)(\?.*)?$/i.test(url);
}

export function renderPostContentHtml(content: string, highlightGroups: HighlightGroup[]): string {
  const tokenRegex = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s]+\.(?:png|jpe?g|gif|webp)(?:\?[^\s]*)?)/gi;
  let html = '';
  let lastIndex = 0;
  for (const match of content.matchAll(tokenRegex)) {
    const index = match.index ?? 0;
    const plain = content.slice(lastIndex, index);
    if (plain) {
      html += `<div class="post-text">${applyHighlightedText(plain, highlightGroups).replace(/\n+/g, '<br>')}</div>`;
    }
    const alt = match[1] ?? 'image';
    const url = match[2] ?? match[3];
    if (url && isImageUrl(url)) {
      html += `<figure class="post-image"><img loading="lazy" src="${escapeHtml(url)}" alt="${escapeHtml(alt)}"></figure>`;
    }
    lastIndex = index + match[0].length;
  }
  const rest = content.slice(lastIndex);
  if (rest) {
    html += `<div class="post-text">${applyHighlightedText(rest, highlightGroups).replace(/\n+/g, '<br>')}</div>`;
  }
  return html || '<div class="post-text"></div>';
}

export function renderTitleHtml(title: string, highlightGroups: HighlightGroup[]): string {
  return applyHighlightedText(title, highlightGroups);
}

export function postMatchesSearch(search: string, text: string): boolean {
  if (!search.trim()) return true;
  return safeRegex(search).test(text);
}

export function postMatchesMute(patterns: string[], text: string): boolean {
  return patterns.some((pattern) => safeRegex(pattern).test(text));
}

export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function flattenHighlightPatterns(groups: HighlightGroup[]): string[] {
  return groups.flatMap((group) => group.rules.map((rule) => `${group.name}: ${rule.pattern}`));
}
