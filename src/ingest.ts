import { acquireIngestLock, getPostById, insertPost, releaseIngestLock } from './db';
import { notifyForNewPosts } from './notifications';
import { fetchRssFeed } from './rss';
import type { Env, PostRecord, RssPostInput } from './types';

async function persistNewPosts(env: Env, items: RssPostInput[]): Promise<PostRecord[]> {
  const created: PostRecord[] = [];
  for (const item of items) {
    const id = await insertPost(env, item as any);
    if (!id) continue;
    const post = await getPostById(env, id);
    if (post) created.push(post);
  }
  return created;
}

export async function runIngest(env: Env): Promise<{ created: number; buildDate: string | null; skipped: boolean }> {
  const locked = await acquireIngestLock(env, 45);
  if (!locked) return { created: 0, buildDate: null, skipped: true };
  try {
    const { buildDate, items } = await fetchRssFeed(env.RSS_URL);
    const createdPosts = await persistNewPosts(env, items);
    await notifyForNewPosts(env, createdPosts);
    await releaseIngestLock(env, buildDate, true);
    return { created: createdPosts.length, buildDate, skipped: false };
  } catch (error) {
    await releaseIngestLock(env, null, false);
    throw error;
  }
}
