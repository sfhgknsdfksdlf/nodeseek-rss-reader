import { Hono } from 'hono';
import { createSession, destroySession, getCurrentUser, hashPassword, verifyPassword } from './auth';
import { DEFAULT_PAGE_SIZE, RECENT_POST_SCAN_LIMIT } from './constants';
import {
  addHighlightGroup,
  addHighlightRule,
  addMuteRule,
  addSubscriptionRule,
  clearHighlightRules,
  clearMuteRules,
  clearSubscriptionRules,
  countPosts,
  createUser,
  deleteHighlightGroup,
  deleteHighlightRule,
  deleteMuteRule,
  deleteSubscriptionRule,
  getFeedState,
  getPostById,
  getReadPostIds,
  getUserByUsername,
  listHighlightGroups,
  listMuteRules,
  listPosts,
  listRecentPosts,
  listSubscriptionRules,
  markPostRead,
  setTelegramNonce,
  setUserEmail
} from './db';
import { runIngest } from './ingest';
import {
  renderAccountPage,
  renderAuthPage,
  renderExportPage,
  renderHighlightsPage,
  renderHomePage,
  renderMutesPage,
  renderPostPage,
  renderSubscriptionsPage
} from './render';
import { handleTelegramWebhook } from './telegram';
import type { Env, User } from './types';
import { buildPagination, parseInteger, postMatchesMute, postMatchesSearch, prettyJson } from './utils';

const app = new Hono<{ Bindings: Env; Variables: { user: User | null } }>();

app.use('*', async (c, next) => {
  const user = await getCurrentUser(c.env, c.req.raw);
  c.set('user', user);
  await next();
});

async function maybeRefreshFeed(env: Env): Promise<void> {
  const state = await getFeedState(env);
  const refreshSeconds = parseInteger(env.RSS_REFRESH_SECONDS, 60);
  const last = state.last_ingest_at ? new Date(state.last_ingest_at).getTime() : 0;
  if (!last || Date.now() - last > refreshSeconds * 1000) {
    try {
      await runIngest(env);
    } catch {
      // keep page serving even if refresh failed
    }
  }
}

async function requireUser(c: any): Promise<User> {
  const user = c.get('user') as User | null;
  if (!user) {
    throw new Response(null, { status: 302, headers: { Location: '/login' } });
  }
  return user;
}

async function buildFilteredPosts(env: Env, user: User | null, page: number, pageSize: number, category: string, search: string) {
  const sourcePosts = search.trim()
    ? await listRecentPosts(env, RECENT_POST_SCAN_LIMIT, category)
    : await listPosts(env, page, pageSize, category);
  const muteRules = user ? await listMuteRules(env, user.id) : [];
  const filtered = sourcePosts.filter((post) => {
    const searchText = `${post.title}\n${post.content_text}`;
    const muteText = `${post.title}\n${post.content_text}\n${post.author_name}`;
    return postMatchesSearch(search, searchText) && !postMatchesMute(muteRules.map((r) => r.pattern), muteText);
  });
  const total = search.trim() ? filtered.length : await countPosts(env, category);
  const paged = search.trim() ? filtered.slice((page - 1) * pageSize, page * pageSize) : filtered;
  return { posts: paged, total };
}

app.get('/', async (c) => {
  await maybeRefreshFeed(c.env);
  const user = c.get('user');
  const page = parseInteger(c.req.query('page'), 1);
  const pageSize = parseInteger(c.env.PAGE_SIZE, DEFAULT_PAGE_SIZE);
  const search = c.req.query('q') ?? '';
  const { posts, total } = await buildFilteredPosts(c.env, user, page, pageSize, 'all', search);
  const readSet = user ? await getReadPostIds(c.env, user.id, posts.map((p) => p.id)) : new Set<number>();
  const groups = user ? await listHighlightGroups(c.env, user.id) : [];
  return c.html(renderHomePage({ posts, readSet, highlightGroups: groups, user, pagination: buildPagination(page, Math.max(1, Math.ceil(total / pageSize))), currentCategory: 'all', search }));
});

app.get('/c/:category', async (c) => {
  await maybeRefreshFeed(c.env);
  const user = c.get('user');
  const category = c.req.param('category');
  const page = parseInteger(c.req.query('page'), 1);
  const pageSize = parseInteger(c.env.PAGE_SIZE, DEFAULT_PAGE_SIZE);
  const search = c.req.query('q') ?? '';
  const { posts, total } = await buildFilteredPosts(c.env, user, page, pageSize, category, search);
  const readSet = user ? await getReadPostIds(c.env, user.id, posts.map((p) => p.id)) : new Set<number>();
  const groups = user ? await listHighlightGroups(c.env, user.id) : [];
  return c.html(renderHomePage({ posts, readSet, highlightGroups: groups, user, pagination: buildPagination(page, Math.max(1, Math.ceil(total / pageSize))), currentCategory: category, search }));
});

app.get('/post/:id', async (c) => {
  const user = c.get('user');
  const post = await getPostById(c.env, Number(c.req.param('id')));
  if (!post) return c.text('Not Found', 404);
  const readSet = user ? await getReadPostIds(c.env, user.id, [post.id]) : new Set<number>();
  const groups = user ? await listHighlightGroups(c.env, user.id) : [];
  return c.html(renderPostPage(post, user, readSet, groups));
});

app.get('/login', (c) => c.html(renderAuthPage('login')));
app.get('/register', (c) => c.html(renderAuthPage('register')));

app.post('/login', async (c) => {
  const form = await c.req.formData();
  const username = String(form.get('username') ?? '').trim();
  const password = String(form.get('password') ?? '');
  const user = await getUserByUsername(c.env, username);
  if (!user || !(await verifyPassword(password, user.password_hash, c.env.APP_SESSION_SECRET))) {
    return c.html(renderAuthPage('login', '用户名或密码错误'));
  }
  const session = await createSession(c.env, user.id);
  return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': session.cookie } });
});

app.post('/register', async (c) => {
  const form = await c.req.formData();
  const username = String(form.get('username') ?? '').trim();
  const password = String(form.get('password') ?? '');
  if (!username || !password || username.length > 40) {
    return c.html(renderAuthPage('register', '请输入有效用户名和密码'));
  }
  const exists = await getUserByUsername(c.env, username);
  if (exists) {
    return c.html(renderAuthPage('register', '用户名已存在'));
  }
  await createUser(c.env, username, await hashPassword(password, c.env.APP_SESSION_SECRET));
  const created = await getUserByUsername(c.env, username);
  if (!created) return c.html(renderAuthPage('register', '注册失败'));
  const session = await createSession(c.env, created.id);
  return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': session.cookie } });
});

app.get('/logout', async (c) => {
  const cookie = await destroySession(c.env, c.req.raw);
  return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': cookie } });
});

app.post('/api/read/:id', async (c) => {
  const user = c.get('user');
  if (!user) return c.text('ok');
  await markPostRead(c.env, user.id, Number(c.req.param('id')));
  return c.text('ok');
});

app.get('/settings/highlights', async (c) => {
  const user = await requireUser(c);
  return c.html(renderHighlightsPage(user, await listHighlightGroups(c.env, user.id)));
});
app.post('/settings/highlights/add-group', async (c) => {
  const user = await requireUser(c);
  const form = await c.req.formData();
  await addHighlightGroup(c.env, user.id, String(form.get('name') ?? '').trim(), String(form.get('color') ?? '#ffd54f').trim() || '#ffd54f');
  return c.redirect('/settings/highlights');
});
app.post('/settings/highlights/add-rule', async (c) => {
  const user = await requireUser(c);
  const form = await c.req.formData();
  await addHighlightRule(c.env, user.id, Number(form.get('groupId')), String(form.get('pattern') ?? '').trim());
  return c.redirect('/settings/highlights');
});
app.post('/settings/highlights/clear', async (c) => {
  const user = await requireUser(c);
  const form = await c.req.formData();
  await clearHighlightRules(c.env, user.id, Number(form.get('groupId')));
  return c.redirect('/settings/highlights');
});
app.post('/settings/highlights/delete-group', async (c) => {
  const user = await requireUser(c);
  const form = await c.req.formData();
  await deleteHighlightGroup(c.env, user.id, Number(form.get('groupId')));
  return c.redirect('/settings/highlights');
});
app.post('/settings/highlights/delete-rule', async (c) => {
  const user = await requireUser(c);
  const form = await c.req.formData();
  await deleteHighlightRule(c.env, user.id, Number(form.get('ruleId')));
  return c.redirect('/settings/highlights');
});

app.get('/settings/mutes', async (c) => {
  const user = await requireUser(c);
  return c.html(renderMutesPage(user, await listMuteRules(c.env, user.id)));
});
app.post('/settings/mutes/add', async (c) => {
  const user = await requireUser(c);
  const form = await c.req.formData();
  await addMuteRule(c.env, user.id, String(form.get('pattern') ?? '').trim());
  return c.redirect('/settings/mutes');
});
app.post('/settings/mutes/delete', async (c) => {
  const user = await requireUser(c);
  const form = await c.req.formData();
  await deleteMuteRule(c.env, user.id, Number(form.get('ruleId')));
  return c.redirect('/settings/mutes');
});
app.post('/settings/mutes/clear', async (c) => {
  const user = await requireUser(c);
  await clearMuteRules(c.env, user.id);
  return c.redirect('/settings/mutes');
});

app.get('/settings/subscriptions', async (c) => {
  const user = await requireUser(c);
  return c.html(renderSubscriptionsPage(user, await listSubscriptionRules(c.env, user.id)));
});
app.post('/settings/subscriptions/add', async (c) => {
  const user = await requireUser(c);
  const form = await c.req.formData();
  await addSubscriptionRule(c.env, user.id, String(form.get('pattern') ?? '').trim(), form.get('notifyEmail') !== null, form.get('notifyTelegram') !== null);
  return c.redirect('/settings/subscriptions');
});
app.post('/settings/subscriptions/delete', async (c) => {
  const user = await requireUser(c);
  const form = await c.req.formData();
  await deleteSubscriptionRule(c.env, user.id, Number(form.get('ruleId')));
  return c.redirect('/settings/subscriptions');
});
app.post('/settings/subscriptions/clear', async (c) => {
  const user = await requireUser(c);
  await clearSubscriptionRules(c.env, user.id);
  return c.redirect('/settings/subscriptions');
});

app.get('/settings/account', async (c) => {
  const user = await requireUser(c);
  const nonce = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  await setTelegramNonce(c.env, user.id, nonce, expiresAt);
  const tgBindUrl = c.env.TELEGRAM_BOT_USERNAME ? `https://t.me/${c.env.TELEGRAM_BOT_USERNAME}?start=${nonce}` : null;
  return c.html(renderAccountPage(user, nonce, tgBindUrl));
});
app.post('/settings/account/email', async (c) => {
  const user = await requireUser(c);
  const form = await c.req.formData();
  await setUserEmail(c.env, user.id, String(form.get('email') ?? '').trim());
  return c.redirect('/settings/account');
});

app.get('/settings/export', async (c) => {
  const user = await requireUser(c);
  const [groups, mutes, subscriptions] = await Promise.all([
    listHighlightGroups(c.env, user.id),
    listMuteRules(c.env, user.id),
    listSubscriptionRules(c.env, user.id)
  ]);
  return c.html(renderExportPage(user, groups, mutes, subscriptions));
});

app.get('/api/export/config.json', async (c) => {
  const user = await requireUser(c);
  const [groups, mutes, subscriptions] = await Promise.all([
    listHighlightGroups(c.env, user.id),
    listMuteRules(c.env, user.id),
    listSubscriptionRules(c.env, user.id)
  ]);
  return c.json({
    highlightGroups: groups.map((group) => ({ name: group.name, color: group.color, patterns: group.rules.map((rule) => rule.pattern) })),
    mutes: mutes.map((rule) => rule.pattern),
    subscriptions: subscriptions.map((rule) => ({ pattern: rule.pattern, notifyEmail: !!rule.notify_email, notifyTelegram: !!rule.notify_telegram }))
  });
});

app.post('/tg/webhook/:secret', async (c) => handleTelegramWebhook(c.env, c.req.raw));

app.get('/api/admin/ingest', async (c) => {
  const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? c.req.query('token') ?? '';
  if (c.env.MANUAL_INGEST_TOKEN && token !== c.env.MANUAL_INGEST_TOKEN) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }
  const result = await runIngest(c.env);
  return c.json({ ok: true, ...result });
});

app.onError((err, c) => {
  if (err instanceof Response) return err;
  return c.text(`Internal Error\n${String(err)}`, 500);
});

export default {
  fetch: app.fetch,
  scheduled: async (_controller: ScheduledController, env: Env) => {
    await runIngest(env);
  }
};
