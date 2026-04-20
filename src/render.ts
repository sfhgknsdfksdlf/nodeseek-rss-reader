import { CATEGORY_ORDER } from './constants';
import type { HighlightGroup, MuteRule, PaginationModel, PostRecord, SubscriptionRule, User, ViewPost } from './types';
import { escapeHtml, flattenHighlightPatterns, formatBjTime, prettyJson, renderPostContentHtml, renderTitleHtml, slugToCategoryLabel, withQuery } from './utils';

function navTabs(currentCategory: string, search: string): string {
  return `
    <nav class="tabs">${CATEGORY_ORDER.map((slug) => {
      const label = slug === 'all' ? '全部' : slugToCategoryLabel(slug);
      const href = slug === 'all' ? withQuery('/', search ? { q: search } : {}) : withQuery(`/c/${slug}`, search ? { q: search } : {});
      return `<a class="tab ${currentCategory === slug ? 'active' : ''}" href="${href}">${escapeHtml(label)}</a>`;
    }).join('')}</nav>
  `;
}

function paginationBar(model: PaginationModel, basePath: string, search: string, bottom = false): string {
  const pageHref = (page: number) => withQuery(basePath, { page, q: search || undefined });
  return `
    <div class="pager-wrap ${bottom ? 'bottom' : 'top'}">
      <div class="pager">
        <a class="page-btn ${model.hasPrev ? '' : 'disabled'}" href="${pageHref(model.prevPage)}">上一页</a>
        ${model.pages.map((page, idx) => `<a class="page-btn ${idx === 0 ? 'current' : ''}" href="${pageHref(page)}">${page}</a>`).join('')}
        <a class="page-btn ${model.hasNext ? '' : 'disabled'}" href="${pageHref(model.nextPage)}">下一页</a>
      </div>
      ${bottom ? `<form class="jump-form" method="get" action="${basePath}"><input type="hidden" name="q" value="${escapeHtml(search)}"><input class="jump-input" type="number" min="1" name="page" placeholder="页码"><button class="jump-btn" type="submit">跳转</button></form>` : ''}
    </div>
  `;
}

function topSearch(basePath: string, search: string): string {
  return `
    <form class="search-bar" method="get" action="${basePath}">
      <input class="search-input" type="text" name="q" value="${escapeHtml(search)}" placeholder="搜索帖子（直接支持正则）">
      <button class="search-btn" type="submit">搜索</button>
    </form>
  `;
}

function viewPosts(posts: PostRecord[], readSet: Set<number>, highlightGroups: HighlightGroup[]): ViewPost[] {
  return posts.map((post) => ({
    ...post,
    read: readSet.has(post.id),
    titleHtml: renderTitleHtml(post.title, highlightGroups),
    bodyHtml: renderPostContentHtml(post.content_text || post.content_html, highlightGroups),
    categoryLabel: slugToCategoryLabel(post.category_slug),
    bjTimeLabel: formatBjTime(post.published_at_utc)
  }));
}

function postCards(posts: ViewPost[]): string {
  if (!posts.length) {
    return `<div class="empty-card">暂无帖子</div>`;
  }
  return posts.map((post) => `
    <article class="post-card ${post.read ? 'read' : ''}" data-post-id="${post.id}" data-post-url="${escapeHtml(post.source_url)}">
      <h2 class="post-title">${post.titleHtml}</h2>
      <div class="post-body">${post.bodyHtml}</div>
      <div class="post-meta">
        <button class="meta-author" type="button" data-copy-author="${escapeHtml(post.author_name)}">${escapeHtml(post.author_name)}</button>
        <div class="meta-category">${escapeHtml(post.categoryLabel)}</div>
        <time class="meta-time">${escapeHtml(post.bjTimeLabel)}</time>
      </div>
    </article>
  `).join('');
}

function settingsTabs(current: string): string {
  const tabs = [
    ['highlights', '高亮'],
    ['mutes', '屏蔽'],
    ['subscriptions', '订阅'],
    ['account', '账户'],
    ['export', '导出']
  ];
  return `<div class="settings-tabs">${tabs.map(([key, label]) => `<a class="tab ${current === key ? 'active' : ''}" href="/settings/${key}">${label}</a>`).join('')}</div>`;
}

function pageShell(title: string, body: string, user: User | null, extraHead = ''): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${escapeHtml(title)}</title>
  <meta name="color-scheme" content="light dark">
  <style>
    :root {
      --bg: #f5f5f5;
      --card: #ffffff;
      --text: #111111;
      --muted: #666666;
      --line: rgba(0,0,0,0.12);
      --blue: #2670ff;
      --red: #d62020;
      --green: #1b8c42;
      --chip: #ececec;
      --shadow: 0 10px 30px rgba(0,0,0,0.06);
      --radius: 18px;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #000000;
        --card: #000000;
        --text: #f5f5f5;
        --muted: #aaaaaa;
        --line: rgba(255,255,255,0.12);
        --blue: #3f82ff;
        --red: #ff4d4f;
        --green: #35b25d;
        --chip: #101010;
        --shadow: none;
      }
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, 'PingFang SC', 'Microsoft YaHei', sans-serif; }
    a { color: inherit; text-decoration: none; }
    button, input, select { font: inherit; }
    .page { max-width: 980px; margin: 0 auto; padding: 16px 14px 96px; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
    .brand { font-size: clamp(22px, 3.5vw, 34px); font-weight: 800; letter-spacing: -0.02em; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .toplinks { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    .mini-link { padding: 10px 14px; border: 1px solid var(--line); border-radius: 999px; background: var(--card); white-space: nowrap; }
    .tabs { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; margin-bottom: 12px; scrollbar-width: none; }
    .tabs::-webkit-scrollbar { display: none; }
    .tab { flex: 0 0 auto; padding: 9px 14px; border-radius: 999px; border: 1px solid var(--line); background: var(--card); color: var(--muted); white-space: nowrap; }
    .tab.active { background: var(--blue); color: #fff; border-color: transparent; }
    .search-bar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
    .search-input { min-width: 0; flex: 1 1 auto; padding: 12px 14px; border-radius: 14px; border: 1px solid var(--line); background: var(--card); color: var(--text); }
    .search-btn, .btn, .danger-btn, .neutral-btn, .blue-btn { flex: 0 0 auto; border: none; padding: 12px 14px; border-radius: 14px; color: #fff; cursor: pointer; white-space: nowrap; }
    .search-btn, .blue-btn, .btn { background: var(--blue); }
    .danger-btn { background: var(--red); }
    .neutral-btn { background: #7a7a7a; }
    .pager-wrap { display: flex; flex-direction: column; align-items: center; gap: 10px; margin: 10px 0 14px; }
    .pager { display: inline-flex; gap: 6px; flex-wrap: nowrap; max-width: 100%; overflow-x: auto; padding-bottom: 2px; }
    .page-btn { min-width: 44px; text-align: center; padding: 10px 12px; border-radius: 14px; border: 1px solid var(--line); background: var(--card); white-space: nowrap; }
    .page-btn.current { background: var(--blue); color: #fff; border-color: transparent; }
    .page-btn.disabled { opacity: .45; pointer-events: none; }
    .jump-form { display: inline-flex; align-items: center; gap: 8px; justify-content: center; }
    .jump-input { width: 84px; padding: 10px 12px; border-radius: 14px; border: 1px solid var(--line); background: var(--card); color: var(--text); text-align: center; }
    .jump-btn { border: none; padding: 10px 14px; border-radius: 14px; background: var(--blue); color: #fff; }
    .post-card, .empty-card, .panel, .auth-card { background: var(--card); border: 1px solid var(--line); border-radius: 22px; padding: 16px; box-shadow: var(--shadow); }
    .post-card { margin-bottom: 12px; cursor: pointer; }
    .post-title { margin: 0 0 12px; font-size: clamp(18px, 2.5vw, 23px); line-height: 1.3; word-break: break-word; }
    .post-card.read .post-title { color: var(--red); }
    .post-body { color: var(--text); line-height: 1.6; word-break: break-word; }
    .post-text { margin-bottom: 10px; }
    .post-image { margin: 10px 0; }
    .post-image img { display: block; width: 100%; max-width: 100%; height: auto; border-radius: 16px; border: 1px solid var(--line); }
    .post-meta { margin-top: 12px; display: grid; grid-template-columns: minmax(0,1fr) auto minmax(0,1fr); align-items: center; gap: 8px; }
    .meta-author, .meta-category, .meta-time { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .meta-author { text-align: left; border: none; padding: 0; background: transparent; color: var(--text); cursor: pointer; }
    .meta-category { text-align: center; color: var(--muted); }
    .meta-time { text-align: right; color: var(--muted); }
    .hl { color: #000; border-radius: 6px; padding: 0 4px; font-weight: 700; }
    .settings-wrap { display: grid; gap: 12px; }
    .settings-tabs { display: flex; gap: 8px; overflow-x: auto; }
    .group-card { padding: 14px; border: 1px solid var(--line); border-radius: 18px; margin-bottom: 10px; background: var(--card); }
    .group-head { display: grid; grid-template-columns: minmax(0,1fr) auto auto; gap: 8px; align-items: center; margin-bottom: 10px; }
    .group-label { display: inline-flex; align-items: center; gap: 10px; min-width: 0; }
    .color-dot { width: 18px; height: 18px; border-radius: 999px; border: 1px solid var(--line); }
    .kw-cloud { min-height: 56px; display: flex; flex-wrap: wrap-reverse; flex-direction: row-reverse; justify-content: flex-end; align-content: flex-end; gap: 8px; margin-bottom: 12px; }
    .kw-item { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 999px; background: var(--chip); max-width: 100%; }
    .kw-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mini-x { border: none; background: transparent; color: inherit; cursor: pointer; padding: 0; }
    .inline-form { display: flex; gap: 8px; align-items: center; }
    .inline-form input[type='text'], .inline-form input[type='password'], .inline-form input[type='email'], .stack-form input[type='text'], .stack-form input[type='password'], .stack-form input[type='email'] { min-width: 0; flex: 1 1 auto; padding: 12px 14px; border-radius: 14px; border: 1px solid var(--line); background: var(--card); color: var(--text); }
    .stack-form { display: grid; gap: 10px; }
    .helper { color: var(--muted); font-size: 14px; }
    .section-title { margin: 0 0 10px; font-size: 20px; }
    .settings-grid { display: grid; gap: 12px; }
    .mono-box { white-space: pre-wrap; word-break: break-word; background: var(--chip); border-radius: 18px; padding: 14px; border: 1px solid var(--line); }
    .float-jump { position: fixed; right: 18px; bottom: 20px; display: flex; flex-direction: column; gap: 10px; z-index: 30; }
    .jump-fab { width: 46px; height: 46px; border-radius: 999px; border: 1px solid var(--line); background: var(--card); color: var(--text); display: grid; place-items: center; box-shadow: var(--shadow); cursor: pointer; }
    .auth-shell { max-width: 480px; margin: 36px auto 0; }
    .auth-card h1 { margin-top: 0; }
    .toast { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); background: var(--text); color: var(--bg); padding: 10px 14px; border-radius: 999px; opacity: 0; pointer-events: none; transition: opacity .2s; }
    .toast.show { opacity: 1; }
    @media (max-width: 640px) {
      .page { padding-left: 10px; padding-right: 10px; }
      .topbar { align-items: flex-start; flex-direction: column; }
      .toplinks { width: 100%; justify-content: flex-start; }
      .search-btn, .btn, .danger-btn, .neutral-btn, .blue-btn { padding-left: 12px; padding-right: 12px; }
      .post-card, .empty-card, .panel, .auth-card { border-radius: 18px; padding: 14px; }
      .group-head { grid-template-columns: minmax(0,1fr) auto auto; }
    }
  </style>
  ${extraHead}
</head>
<body>
  <div class="page">
    <header class="topbar">
      <a class="brand" href="/">NodeSeek RSS Reader</a>
      <div class="toplinks">
        ${user ? `<a class="mini-link" href="/settings/highlights">设置</a><a class="mini-link" href="/logout">退出（${escapeHtml(user.username)}）</a>` : `<a class="mini-link" href="/login">登录</a><a class="mini-link" href="/register">注册</a>`}
      </div>
    </header>
    ${body}
  </div>
  <div class="float-jump">
    <button class="jump-fab" type="button" id="go-top" aria-label="回到顶部"><svg viewBox="0 0 24 24" width="24"><path fill="currentColor" d="M7.41,15.41L12,10.83L16.59,15.41L18,14L12,8L6,14L7.41,15.41Z"/></svg></button>
    <button class="jump-fab" type="button" id="go-bottom" aria-label="到底部"><svg viewBox="0 0 24 24" width="24"><path fill="currentColor" d="M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z"/></svg></button>
  </div>
  <div class="toast" id="toast"></div>
  <script>
    const toast = document.getElementById('toast');
    const showToast = (text) => { toast.textContent = text; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 1400); };
    document.getElementById('go-top')?.addEventListener('click', () => window.scrollTo({top: 0, behavior: 'smooth'}));
    document.getElementById('go-bottom')?.addEventListener('click', () => window.scrollTo({top: document.body.scrollHeight, behavior: 'smooth'}));
    document.querySelectorAll('[data-copy-author]').forEach((el) => {
      el.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        const value = el.getAttribute('data-copy-author') || '';
        try { await navigator.clipboard.writeText(value); showToast('用户名已复制'); } catch { showToast('复制失败'); }
      });
    });
    const markRead = (id) => {
      const url = '/api/read/' + id;
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([], {type: 'text/plain'}));
      } else {
        fetch(url, { method: 'POST', keepalive: true });
      }
    };
    document.querySelectorAll('.post-card').forEach((card) => {
      card.addEventListener('click', () => {
        const id = card.getAttribute('data-post-id');
        const url = card.getAttribute('data-post-url');
        if (id) markRead(id);
        card.classList.add('read');
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
      });
    });
  </script>
</body>
</html>`;
}

export function renderHomePage(args: {
  posts: PostRecord[];
  readSet: Set<number>;
  highlightGroups: HighlightGroup[];
  user: User | null;
  pagination: PaginationModel;
  currentCategory: string;
  search: string;
}): string {
  const basePath = args.currentCategory === 'all' ? '/' : `/c/${args.currentCategory}`;
  const body = `
    ${navTabs(args.currentCategory, args.search)}
    ${topSearch(basePath, args.search)}
    ${paginationBar(args.pagination, basePath, args.search, false)}
    <section>${postCards(viewPosts(args.posts, args.readSet, args.highlightGroups))}</section>
    ${paginationBar(args.pagination, basePath, args.search, true)}
  `;
  return pageShell('NodeSeek RSS Reader', body, args.user);
}

export function renderPostPage(post: PostRecord, user: User | null, readSet: Set<number>, highlightGroups: HighlightGroup[]): string {
  const body = `
    <div class="panel">
      ${postCards(viewPosts([post], readSet, highlightGroups))}
      <div class="helper">点击卡片会新窗口打开原帖。</div>
    </div>
  `;
  return pageShell(post.title, body, user);
}

export function renderAuthPage(kind: 'login' | 'register', error = ''): string {
  const title = kind === 'login' ? '登录' : '注册';
  const action = kind === 'login' ? '/login' : '/register';
  const altHref = kind === 'login' ? '/register' : '/login';
  const altText = kind === 'login' ? '没有账号？去注册' : '已有账号？去登录';
  const body = `
    <div class="auth-shell">
      <div class="auth-card">
        <h1>${title}</h1>
        ${error ? `<div class="helper" style="color:var(--red);margin-bottom:10px;">${escapeHtml(error)}</div>` : ''}
        <form class="stack-form" method="post" action="${action}">
          <input name="username" type="text" placeholder="用户名" required>
          <input name="password" type="password" placeholder="密码" required>
          <button class="btn" type="submit">${title}</button>
        </form>
        <div class="helper" style="margin-top:12px;"><a href="${altHref}">${altText}</a></div>
      </div>
    </div>
  `;
  return pageShell(title, body, null);
}

export function renderHighlightsPage(user: User, groups: HighlightGroup[]): string {
  const body = `
    <div class="settings-wrap">
      ${settingsTabs('highlights')}
      <section class="panel settings-grid">
        <h2 class="section-title">高亮分组</h2>
        ${groups.map((group) => `
          <div class="group-card">
            <div class="group-head">
              <div class="group-label"><span class="color-dot" style="background:${escapeHtml(group.color)}"></span><strong>${escapeHtml(group.name)}</strong></div>
              <form method="post" action="/settings/highlights/clear"><input type="hidden" name="groupId" value="${group.id}"><button class="neutral-btn" type="submit">清空</button></form>
              <form method="post" action="/settings/highlights/delete-group"><input type="hidden" name="groupId" value="${group.id}"><button class="danger-btn" type="submit">删除</button></form>
            </div>
            <div class="kw-cloud">
              ${group.rules.map((rule) => `<span class="kw-item"><span class="kw-text">${escapeHtml(rule.pattern)}</span><form method="post" action="/settings/highlights/delete-rule"><input type="hidden" name="ruleId" value="${rule.id}"><button class="mini-x" type="submit">×</button></form></span>`).join('')}
            </div>
            <form class="inline-form" method="post" action="/settings/highlights/add-rule">
              <input type="hidden" name="groupId" value="${group.id}">
              <input type="text" name="pattern" placeholder="输入正则关键字" required>
              <button class="blue-btn" type="submit">添加</button>
            </form>
          </div>
        `).join('')}
        <form class="stack-form" method="post" action="/settings/highlights/add-group">
          <input type="text" name="name" placeholder="新分组名" required>
          <input type="text" name="color" placeholder="#ffd54f" value="#ffd54f" required>
          <button class="btn" type="submit">新增高亮分组</button>
        </form>
      </section>
    </div>
  `;
  return pageShell('高亮设置', body, user);
}

export function renderMutesPage(user: User, rules: MuteRule[]): string {
  const body = `
    <div class="settings-wrap">
      ${settingsTabs('mutes')}
      <section class="panel settings-grid">
        <h2 class="section-title">屏蔽规则</h2>
        <div class="helper">服务端根据你的规则过滤标题、正文、用户名，命中的卡片不会返回给你。</div>
        <div class="kw-cloud">${rules.map((rule) => `<span class="kw-item"><span class="kw-text">${escapeHtml(rule.pattern)}</span><form method="post" action="/settings/mutes/delete"><input type="hidden" name="ruleId" value="${rule.id}"><button class="mini-x" type="submit">×</button></form></span>`).join('')}</div>
        <form class="inline-form" method="post" action="/settings/mutes/add">
          <input type="text" name="pattern" placeholder="输入正则关键字" required>
          <button class="blue-btn" type="submit">添加</button>
        </form>
        <form method="post" action="/settings/mutes/clear"><button class="danger-btn" type="submit">清空全部屏蔽</button></form>
      </section>
    </div>
  `;
  return pageShell('屏蔽设置', body, user);
}

export function renderSubscriptionsPage(user: User, rules: SubscriptionRule[]): string {
  const body = `
    <div class="settings-wrap">
      ${settingsTabs('subscriptions')}
      <section class="panel settings-grid">
        <h2 class="section-title">订阅规则</h2>
        <div class="helper">对新增帖子按正则匹配，命中后推送到你绑定的邮箱和 Telegram。</div>
        <div class="settings-grid">
          ${rules.map((rule) => `<div class="group-card"><div><strong>${escapeHtml(rule.pattern)}</strong></div><div class="helper">Email: ${rule.notify_email ? '开' : '关'} · Telegram: ${rule.notify_telegram ? '开' : '关'}</div><form style="margin-top:10px;" method="post" action="/settings/subscriptions/delete"><input type="hidden" name="ruleId" value="${rule.id}"><button class="danger-btn" type="submit">删除</button></form></div>`).join('')}
        </div>
        <form class="stack-form" method="post" action="/settings/subscriptions/add">
          <input type="text" name="pattern" placeholder="输入订阅正则关键字" required>
          <label><input type="checkbox" name="notifyEmail" checked> 邮箱推送</label>
          <label><input type="checkbox" name="notifyTelegram" checked> Telegram 推送</label>
          <button class="btn" type="submit">添加订阅</button>
        </form>
        <form method="post" action="/settings/subscriptions/clear"><button class="danger-btn" type="submit">清空全部订阅</button></form>
      </section>
    </div>
  `;
  return pageShell('订阅设置', body, user);
}

export function renderAccountPage(user: User, tgNonce: string | null, tgBindUrl: string | null): string {
  const body = `
    <div class="settings-wrap">
      ${settingsTabs('account')}
      <section class="panel settings-grid">
        <h2 class="section-title">账户</h2>
        <div><strong>用户名：</strong>${escapeHtml(user.username)}</div>
        <form class="stack-form" method="post" action="/settings/account/email">
          <input type="email" name="email" value="${escapeHtml(user.email ?? '')}" placeholder="绑定邮箱">
          <button class="btn" type="submit">保存邮箱</button>
        </form>
        <div class="helper">当前邮箱：${escapeHtml(user.email ?? '未绑定')} · 状态：${user.email_verified ? '已验证' : '未验证'}</div>
        <div class="group-card">
          <div><strong>Telegram 绑定</strong></div>
          <div class="helper" style="margin-top:8px;">当前：${escapeHtml(user.telegram_username ? '@' + user.telegram_username : user.telegram_chat_id ?? '未绑定')}</div>
          ${tgNonce ? `<div class="mono-box" style="margin-top:10px;">绑定码：${escapeHtml(tgNonce)}</div>` : ''}
          ${tgBindUrl ? `<div style="margin-top:10px;"><a class="mini-link" href="${tgBindUrl}" target="_blank" rel="noopener noreferrer">打开 Bot 绑定</a></div>` : '<div class="helper" style="margin-top:10px;">尚未配置 Telegram Bot 用户名，无法生成一键绑定链接。</div>'}
        </div>
      </section>
    </div>
  `;
  return pageShell('账户设置', body, user);
}

export function renderExportPage(user: User, groups: HighlightGroup[], mutes: MuteRule[], subscriptions: SubscriptionRule[]): string {
  const payload = {
    highlightGroups: groups.map((group) => ({ name: group.name, color: group.color, patterns: group.rules.map((rule) => rule.pattern) })),
    highlightsFlat: flattenHighlightPatterns(groups),
    mutes: mutes.map((rule) => rule.pattern),
    subscriptions: subscriptions.map((rule) => ({ pattern: rule.pattern, notifyEmail: !!rule.notify_email, notifyTelegram: !!rule.notify_telegram }))
  };
  const body = `
    <div class="settings-wrap">
      ${settingsTabs('export')}
      <section class="panel settings-grid">
        <h2 class="section-title">导出配置</h2>
        <div class="helper">这是美化后的云端配置导出。</div>
        <div class="mono-box">${escapeHtml(prettyJson(payload))}</div>
        <a class="mini-link" href="/api/export/config.json">下载 JSON</a>
      </section>
    </div>
  `;
  return pageShell('导出配置', body, user);
}
