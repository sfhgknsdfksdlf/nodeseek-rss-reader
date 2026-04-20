import { XMLParser } from 'fast-xml-parser';
import type { RssPostInput } from './types';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  cdataPropName: '__cdata'
});

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && '__cdata' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>).__cdata ?? '');
  }
  return '';
}

function toIsoDate(pubDate: string): string {
  const date = new Date(pubDate);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

export async function fetchRssFeed(rssUrl: string): Promise<{ buildDate: string | null; items: RssPostInput[] }> {
  const res = await fetch(rssUrl, {
    headers: {
      'user-agent': 'NodeSeek RSS Reader Worker/0.1'
    }
  });
  if (!res.ok) {
    throw new Error(`RSS fetch failed: ${res.status}`);
  }
  const xml = await res.text();
  const parsed = parser.parse(xml) as any;
  const channel = parsed?.rss?.channel;
  const rawItems = Array.isArray(channel?.item) ? channel.item : channel?.item ? [channel.item] : [];
  const items: RssPostInput[] = rawItems.map((item: any) => ({
    external_id: String(item.guid?.['#text'] ?? item.guid ?? item.link ?? crypto.randomUUID()),
    source_url: textOf(item.link),
    title: textOf(item.title),
    content_html: textOf(item.description),
    content_text: textOf(item.description),
    author_name: textOf(item['dc:creator']) || 'Unknown',
    category_slug: textOf(item.category) || 'daily',
    published_at_utc: toIsoDate(textOf(item.pubDate))
  }));
  return {
    buildDate: textOf(channel?.lastBuildDate) || textOf(channel?.pubDate) || null,
    items
  };
}
