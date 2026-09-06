# PROJECT KNOWLEDGE BASE

**Generated:** 2026-09-06
**Commit:** 41e76f8
**Branch:** factory

## OVERVIEW

Cloudflare Workers + D1 application serving only `https://rss.nodeseek.com/` as an RSS reader. The Worker owns SSR pages, API routing, cron RSS synchronization, authentication, per-user rules, subscriptions, notifications, and diagnostics.

## STRUCTURE

```text
./
├── src/                    # Worker routes and application modules
├── migrations/             # Sequential D1 schema migrations
├── scripts/                # Cloudflare build/deploy config generation
├── public/                 # PWA icon.svg + manifest.webmanifest (only static assets; app renders via Worker)
├── README.md               # Deployment and administrator setup
├── AGENTS.md               # Knowledge base + merged approved design (this file)
├── package.json            # Scripts (dev/migrate/deploy/typecheck); no test or lint scripts
├── tsconfig.json           # strict/no-emit TypeScript config
├── wrangler.jsonc          # Source Worker/D1/cron configuration (no committed DB binding)
└── wrangler.local-qa.jsonc # Committed local-dev/QA config with placeholder D1 binding (`npm run dev` and `db:migrate:local` use it)
```

This is one package, not a monorepo. `migrations/` and `scripts/` are independent operational domains, but their current size does not warrant child `AGENTS.md` files.

## CODE MAP

| Symbol/module | Location | Role |
|---|---|---|
| Worker `fetch`/`scheduled` | `src/index.ts` | Request routing, cron orchestration, debug status |
| RSS sync/parser | `src/rss.ts` | Fetch strategies, parse, D1 insert, diagnostics |
| Home query | `src/posts.ts` | Page/board query, title/body search, pagination, read state |
| SSR shell/client script | `src/render.ts` | HTML rendering and browser interactions |
| Runtime settings | `src/settings.ts` | D1-backed settings and admin configuration |
| Auth/session | `src/auth.ts` | Registration, login, cookies, Telegram binding |
| Rules | `src/rules.ts` | User-isolated rule loading, `cacheHit` negotiation; `rulesVersion` digests the full canonical payload |
| Import validation | `src/rule-import.ts` | Shared limits, strict body parsing, structured errors for `/api/import/*`, shared `validatePatternInput` gate for all rule writes |
| Subscriptions | `src/subscriptions.ts` | Regex matching and notification dispatch |
| Notification senders | `src/notifications.ts` | Brevo/Telegram requests and GUID push logs |
| D1 cleanup | `src/cleanup.ts` | Retention for posts, reads, logs, user+admin sessions |
| Shared helpers | `src/db.ts` | D1 `one`/`all` helpers, JSON responses, body parsing, cookie/session-cookie builders |
| HTML/regex safety | `src/filters.ts` | Escaping, `safeHttpUrl`, `safeRegex` + ReDoS-hazard guard, `sanitizePostHtml` whitelist sanitizer, post text builders |
| Board helpers | `src/board.ts` | Board name normalization and option lists for render |
| Homepage CSS | `src/styles.ts` | Responsive black/white/OLED stylesheet consumed by `src/render.ts` |
| Time display | `src/time.ts` | `formatBeijingTime` (UTC+8, same-day `今天 HH:MM`) |
| Shared types | `src/types.ts` | `Env`, model, page, and timing contracts |

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| RSS/cron latency | `src/rss.ts`, `src/subscriptions.ts`, `src/cleanup.ts` | Inspect `/api/debug/status`; preserve structured timings |
| Homepage latency | `src/posts.ts`, `src/render.ts` | Preserve page size and scan behavior |
| Notification dedupe | `src/notifications.ts`, `src/subscriptions.ts`, `migrations/0009*.sql`, `migrations/0010*.sql` | Use `post_guid`, never `post_id` |
| Admin/debug routes | `src/index.ts`, `src/settings.ts` | Admin auth is the URL-query token model (`/admin?token=ADMIN_SECRET`, owner-approved); comparison must stay constant-time (`secretTokensEqual`) |
| User rule handoff | `src/rules.ts`, `src/render.ts` | Payload/version/cache keys stay user-scoped |
| Rule list ordering | `src/rules.ts`, `src/index.ts`, `src/render.ts` (`keywordRows`) | Canonical order is `id ASC` for user-facing rule lists; see CONVENTIONS |
| Rule import changes | `src/rule-import.ts`, `src/index.ts` | Inclusive limits: 1 MiB body, 20 groups, 5000 rules, 200-char regex; reject before any D1 call |
| Schema changes | `migrations/` | Add a numbered migration; never rewrite deployed migrations |
| Deploy config | `scripts/cloudflare-build.mjs`, `wrangler.jsonc` | Never hand-edit generated `wrangler.generated.jsonc` |

## STRICT SDD

- Design first: every requested feature requires an approved design section (the APPROVED DESIGN section in this file) before implementation.
- The design documents modules, APIs, data models, and original requirement points.
- Implement the approved design literally. Do not invent business logic, routes, storage, dependencies, or UI features.
- If requirements are ambiguous, present 2–3 interpretations and ask before implementing.
- `/spec` updates design only; `/build` or explicit approval starts implementation.

## CONVENTIONS

- TypeScript is strict/no-emit; target Workers and Web APIs, not Node-only APIs.
- D1 owns all persistent state. Do not add KV, Durable Objects, R2, or another store without an explicit request.
- RSS scope is fixed to `https://rss.nodeseek.com/`; `posts.guid` is the stable RSS identity.
- Normal post cards must link to the source URL with a real external `<a target="_blank">`; read receipts go through `POST /api/read-state`. There is no redirect/open route.
- Logged-in read state is D1-backed; anonymous read state is localStorage-backed.
- Rule imports are all-or-nothing: fully validate first, then replace with exactly one `env.DB.batch()` per handler; never delete before validation succeeds. A missing top-level collection key (`groups`/`patterns`/`rules`) is a client bug and is rejected, not treated as an empty import; an explicit empty array means "replace with empty". Per-group `patterns` inside a highlight import stays optional and defaults to `[]` (normalize-and-default semantics for display-only fields).
- All rule-writing endpoints (imports, highlight PUT, block POST, subscription POST) share the same `validatePatternInput` gate: non-empty, ≤200 chars, `safeRegex` (ReDoS-hazard guarded). Reject invalid regex at write time; never persist patterns the cron matcher would silently drop.
- `rulesVersion` is a SHA-256 digest of the complete canonical rule payload (block rules + highlight groups with patterns, including row ids): any persisted change to any rule field changes it; failed writes never do. Cache-hit home payloads (`cacheHit: true`) omit rule arrays; clients reuse localStorage only on exact userId + version match.
- Rule ordering is canonical D1 insertion order (`id ASC`) for every user-facing rule list: SQL reads, API payloads, export, import, and PUT bodies. The settings page PUTs pattern arrays back verbatim on every add/delete/color edit, so any other sort permutes saved rules. Exception: the cron-only subscription loader (`src/subscriptions.ts`) stays `ORDER BY s.id DESC` — matching is order-insensitive and it never round-trips through the settings page.
- Settings chip display is intentionally reversed at the rendering layer: `keywordRows` renders the payload in reverse DOM order because the `.keywords` CSS (`row-reverse` + `wrap-reverse`, group left-aligned) mirrors it into the owner-approved layout — tail (newest) chip at bottom-right, rows reading left→right, full rows wrapping upward, upper rows left-aligned. PUT bodies always come from the in-memory payload arrays, never from DOM order.
- Keep homepage card CSS in `src/styles.ts`; preserve the rounded black/white UI and OLED pure-black dark mode.
- Listings use runtime `page_size` (default 99, saved range 10..500), `page=N` URLs, and no exact total-page calculation.

## ANTI-PATTERNS (THIS PROJECT)

- Do not skip design approval or change scope beyond it.
- Do not use `as any`, `@ts-ignore`, `@ts-expect-error`, or empty catch blocks. The empty `catch {}` blocks inside the embedded browser script in `src/render.ts` are a pre-existing guarded-localStorage convention; the prohibition applies to new server-side TS.
- Do not silently skip, truncate, or partially apply imported rules; reject the whole request with field/index error details.
- Never trust client `rulesVersion` as authoritative; the server always computes the current digest.
- Do not read user-facing rule lists with `ORDER BY id DESC` or re-sort/reverse the payload in the data layer; the settings page round-trips arrays verbatim, so any re-ordering permutes saved rules. (`keywordRows`' display-side reversal is the single sanctioned exception — DOM order must never leak into PUT bodies.)
- Do not rewrite deployed migrations. Add sequential files instead.
- Do not use `push_logs.post_id`; the final schema and dedupe paths use `push_logs.post_guid` exclusively.
- Do not confuse `read_states.post_id` with notification-log identity.
- Do not commit local artifacts: agent states (`.sisyphus/`, `.omo/`, `session-ses_*.md`), logs, or reference dumps. Gitignore covers them; never `git add -f` them.

## DATA AND MIGRATIONS

- Current chain is `0001_initial` through `0011_sessions_expiry_index`.
- `0009` moved push idempotency to `post_guid`; `0010` removed legacy `push_logs.post_id`, its FK, unique constraint, and index.
- `0011_sessions_expiry_index` adds `sessions(expires_at)` for the daily expired-session purge in `cleanupOldData`.
- `0010` caveat (documented, do not edit the migration): a legacy `push_logs` row whose `post_guid` is blank AND whose `post_id` no longer resolves to a `posts.guid` would insert NULL into the `NOT NULL` replacement column, aborting the migration atomically. `0010` is already on `main` (deployed branch) and must not be rewritten; if a database hits this, fix the orphan rows manually, then re-apply.
- `0008_posts_keyset_indexes` supports `(published_at DESC, id DESC)` and `(board_key, published_at DESC, id DESC)` scans.
- Push logs retain GUIDs independently of post retention; do not add an FK from `post_guid` to `posts.guid`.
- `cleanupOldData` purges expired `admin_sessions` and user `sessions` daily (gated by `sync_state.last_cleanup_at`).
- `ADMIN_SECRET` secures admin settings and encrypted Brevo/Telegram values. PBKDF2 iterations must remain `<= 100000`.

## RUNTIME AND HOTSPOTS

- Scheduled sync waits 21..24s before RSS and before browser fallback after failure. `/api/rss-test` is the no-sleep diagnostic path.
- `src/rss.ts` uses `cf.cacheTtl = 60`; preserve attempt diagnostics because upstream often returns 503.
- `/api/debug/status?token=ADMIN_SECRET` is non-live unless `live=1`; `safeSyncRss()` records cron failure in `sync_state.last_sync_error`.
- Worker search matches only `title` and `content_text`; browser rules use the synced payload. Ordinary listings apply block rules in the browser, search results skip block rules, and highlights render in the browser. In `src/posts.ts`, scan only until the requested page fills; defer `content_html` until final IDs are known.
- Slow scan chunk size is intentionally 1000. Diagnose with `home.timings.queryPosts` before changing it.
- Subscription work scales users × subscriptions × posts: batch reads/log checks, cache runtime settings, and precompile regexes.
- Rule payloads must be scoped to the logged-in user; browser processing blocks before highlighting.
- Highlight imports preallocate positive group ids (`Date.now()*1000 + crypto random + index`) so one batch can bind child rows; any batch failure rolls back atomically and returns 500.

## UI AND ADMIN

- Header brand links to `/`; do not add a second homepage button.
- Keep post cards to title, body, username, board, and time; username click only copies and shows a one-line toast.
- Settings tabs stay one row; destructive operations require confirmation.
- Admin is standalone `/admin?token=ADMIN_SECRET`, not a settings tab.
- Floating top/bottom controls use `nd-jump-group`/`nd-jump-item` near `bottom: 200px`.

## COMMANDS

```bash
npm run typecheck             # tsc --noEmit; requires installed dependencies
npm run dev                   # wrangler dev
npm run db:migrate:local      # apply local D1 migrations
npm run db:migrate            # apply remote D1 migrations
npm run deploy                # generate config, migrate, dry-run, deploy
node --check scripts/cloudflare-build.mjs
git diff --check
```

No test or lint scripts are defined. If TypeScript/Wrangler dependencies or the TS language server are absent, report that limitation instead of installing dependencies or inventing tests.

De-facto QA method: run `wrangler dev`, then exercise routes with `curl.exe` using a manual `Cookie: session=...` header (the Secure session cookie is not replayed by PS `Invoke-WebRequest -WebSession`) and byte-exact bodies via `--data-binary '@file'`. Prove rejected requests wrote nothing with SHA-256 export fingerprints taken before/after; test client-side logic by executing the exact served script in Node with localStorage/location/DOM stubs.

## DEPLOY AND CONFIG

- `npm run deploy` runs the generator, applies remote migrations, verifies D1, dry-runs deployment, then deploys with `wrangler.generated.jsonc`.
- All deployments use Worker/D1 `nodeseek-rss-reader`; per-branch environment isolation comes from separate Cloudflare accounts, not branch logic. `WORKER_NAME` / `D1_DATABASE_NAME` env vars override these names.
- Cloudflare Workers Builds injects only `WORKERS_CI_BRANCH` (never `CF_PAGES_BRANCH`/`CF_BRANCH`/`GITHUB_REF_NAME`/`BRANCH`); the old env-var chain therefore never fired in CF builds — root cause of the factory incidents. The script is intentionally branch-agnostic; do not reintroduce branch detection.
- A Workers Builds project can only deploy the Worker it is connected to: on config `name` mismatch, CI overrides the name (warning; it may also auto-open a PR editing `wrangler.jsonc`). Both account projects must be named `nodeseek-rss-reader`.
- `npm run cf:build` is preparation-only (D1 create/reuse, migrations, table verify, dry-run — no deploy); `npm run deploy:generated` is final-deploy-only. The build script rewrites BOTH `wrangler.generated.jsonc` and the root `wrangler.jsonc` (name + D1 binding) — that is why the committed root config carries no binding.
- Before pushing the `factory` branch, the factory-connected build project in the production account must be deleted, or that project rebuilds and redeploys production.
- The build generator applies ALL pending migrations. `wrangler.jsonc` `vars` intentionally contains only `RSS_URL`; `SESSION_SECRET`, `ADMIN_USERNAME`, and `MAIL_PROVIDER` were removed — code never reads them.
- `wrangler.local-qa.jsonc` is committed (placeholder `database_id: local-qa-only`): `npm run dev` and `npm run db:migrate:local` point at it so local development has the `DB` binding; remote deploy always uses the build-generated config.
- Generated config stays at repository root; moving it under `.wrangler/` previously broke migrations.
- Missing `DB` produces `Cannot read properties of undefined (reading 'prepare')`; `/health` is the quickest binding/table check.

## GIT

- Remote: `https://github.com/sfhgknsdfksdlf/nodeseek-rss-reader.git`; do not force-push `main`.
- When committing as the owner, use one-off `git -c user.name=... -c user.email=... commit` flags rather than persistent Git configuration.
- `.sisyphus/` agent artifacts were committed at `a2576f2` and untracked on 2026-09-06 via `git rm -r --cached .sisyphus`. The directory remains gitignored; never re-add agent artifacts (`.sisyphus/`, `.omo/`, `session-ses_*.md`) to git.

## APPROVED DESIGN

本节合并自原 `DESIGN_SPEC.md` 与 `DESIGN_D1_PAGINATION.md`（2026-09-06 复核并入；已剔除与本项目无关的内容，并修正与当前实现不符的过期描述）。STRICT SDD 所指的“已批准设计”即本节。

### 原始需求

- 全新架构实现，仅支持 `https://rss.nodeseek.com/`。
- Cloudflare Workers + 仅免费额度依赖；每分钟抓取 RSS，首跑导入当前 RSS 全部帖子。
- 浏览器刷新即可看到最新帖子；无独立首页按钮，点击品牌 `NodeSeek RSS Reader` 回首页。
- D1 存储用户、阅读进度、高亮/屏蔽/订阅规则、推送日志；开放注册的用户名密码登录。
- 邮件通知使用管理员配置的 Brevo HTTPS API；Telegram 通知使用管理员 Bot Token，用户自行绑定 chat。
- 首次同步只入库，不推送历史帖子。
- 黑白圆润响应式 UI（手机/平板/PC/Mac）；OLED 纯黑暗色模式；支持 Chrome/Firefox/Safari 内核。
- 提供网站图标与 README（GitHub → Cloudflare 部署步骤）。
- 搜索、板块筛选、分页、快速跳页、快速回顶/回底按钮。
- 每用户独立正则高亮分组、屏蔽规则、订阅规则，云端同步 + 格式化导出。
- 卡片只含标题、正文、用户名/板块/时间行；每页数量运行时可配（默认 99，管理员可配 10..500；不显示精确总页数）。

### 架构

单 Worker（TypeScript）承载 HTML、API、静态 icon/manifest、RSS cron 同步、认证、过滤、通知；Cloudflare D1 存全部持久状态；Cron Triggers 每分钟。右下角快捷按钮为固定的圆润上下箭头悬浮按钮。

### 数据模型

- `users(id, username, password_hash, password_salt, email, telegram_chat_id, telegram_bind_code, telegram_bind_code_expires_at, created_at, updated_at)`
- `sessions(id, user_id, expires_at, created_at)`（`0011` 起 `expires_at` 有索引，供每日过期清理）
- `admin_sessions(id, expires_at, created_at)`
- `app_settings(key, value, encrypted, updated_at)`
- `posts(id, guid, title, link, content_html, content_text, author, board_key, published_at, fetched_at)`
- `read_states(user_id, post_id, opened_at)`
- `highlight_groups(id, user_id, name, color, created_at, updated_at)`
- `highlight_rules(id, group_id, pattern, created_at)`
- `block_rules(id, user_id, pattern, created_at)`
- `subscriptions(id, user_id, pattern, send_email, send_telegram, created_at, updated_at)`
- `push_logs(id, user_id, subscription_id, post_guid, channel, status, error, created_at)`
- `sync_state(key, value, updated_at)`
- `rss_fetch_failures(...)`：遗留表，诊断不再读取。
- `rss_fetch_attempts(id, source, method, outcome, status, status_text, error, preview, created_at)`
- `sync_state.last_home_timing` 存最近一次首页服务端计时快照，供 `/api/debug/status`。
- RSS 同步先将当前 feed 的 `guid` 集合与 `posts.guid` 比对，只插入真正新条目。
- 订阅匹配消费内存中的新帖列表，不回读 D1 已插入行。
- 推送幂等基于 `push_logs.post_guid`，不使用数字 `post_id`。

### Push Log `post_id` 淘汰（已批准设计记录）

**需求**：彻底淘汰 `push_logs.post_id`，清理历史 schema 包袱。

**范围**：以 `migrations/0010_rebuild_push_logs_without_post_id.sql` 重建 `push_logs`；不改写已部署迁移 `0001`–`0009`；保留既有行与主键；运行时幂等/查询/清理只用 `post_guid`；不引入 D1 之外的存储。

**最终 schema**：`push_logs(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, subscription_id INTEGER NOT NULL, post_guid TEXT NOT NULL, channel TEXT NOT NULL, status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, UNIQUE (user_id, subscription_id, post_guid, channel), FOREIGN KEY (user_id) REFERENCES users(id), FOREIGN KEY (subscription_id) REFERENCES subscriptions(id))`；保留 `idx_push_logs_created_at`；**故意不**建 `post_guid → posts.guid` 外键（推送日志有独立保留期，帖子删除后仍需有效）。

**迁移过程**：原子上——校验每行可获得非空 GUID（`post_guid` 或按遗留 `post_id` 联 `posts.guid` 回溯），不可回溯则中止且不得静默丢行；建临时表→按 `id` 复制→删旧表→改名→重建索引。

**运行时契约**：`notifications.ts` 只写 `post_guid`；`subscriptions.ts` 幂等键 `(user_id, subscription_id, post_guid, channel)`；`cleanup.ts` 以 `post_guid` 清理；`read_states.post_id` 与推送日志身份无关；任何兼容层不得重新引入 `post_id`。HTTP 契约不变。

### API（当前完整清单）

- `GET /`、`GET /page/:page`：SSR 帖子列表；`GET /health`；`GET /icon.svg`；`GET /manifest.webmanifest`。
- `GET /admin?token=ADMIN_SECRET`：独立管理员页；`POST /telegram/webhook`。
- `GET /api/posts`：JSON 帖子列表。
- `POST /api/auth/register|login|logout`；`GET /api/me`；`PUT /api/me/email`；`PUT /api/me/telegram`；`GET /api/account`；`GET /api/notification-settings`；`POST /api/read-state`。
- 高亮：`GET|POST /api/highlight-groups`、`PUT|DELETE /api/highlight-groups/:id`、`POST /api/highlight-groups/:id/clear`。
- 屏蔽：`GET|POST /api/block-rules`、`POST /api/block-rules/clear`、`DELETE /api/block-rules/:id`。
- 订阅：`GET|POST /api/subscriptions`、`POST /api/subscriptions/clear`、`DELETE /api/subscriptions/:id`。
- 导出：`GET /api/export/highlights|blocks|subscriptions`。
- 导入：`POST /api/import/highlights|blocks|subscriptions`。
- 诊断：`GET /api/rss-test`、`GET /api/debug/status?token=ADMIN_SECRET`（非 `live=1` 不做实抓）。
- 管理：`GET|PUT /api/admin/settings`、`GET /api/admin/users`、`DELETE /api/admin/users/:id`。
- 普通卡片直接外链 `<a target="_blank">` 打开原帖，已读回执走 `POST /api/read-state`；不存在中转打开路由。

### RSS 抓取与失败诊断

- 生产同步：随机 `A ∈ [21,24]` 秒等待 → 抓 `rss` 策略；失败再随机 `B ∈ [21,24]` 秒等待 → 抓 `browser` 策略。
- `/api/rss-test` 同序（`rss` → `browser`）但不等待，便于手动诊断。
- 抓取尝试（成功与失败）结构化写入 `rss_fetch_attempts`，保留 24 小时；遗留 `rss_fetch_failures` 不再读取。
- `GET /api/debug/status?token=ADMIN_SECRET` 含后端计时与 `rss.attemptStats`（`cron.success/failure`、`rssTest.success/failure`），保留原始 `rss.results` 与 `rss.failureSummary`。
- `/api/debug/status` 另含结构化 `cronTiming`：最新一次 cron 的 `timings.rssSync`、`timings.processSubscriptionsMs`、`timings.cleanupOldDataMs`、`timings.totalMs` 分解。
- cron 计时快照自 scheduled 路径异步捕获，不阻塞正常 cron；debug 载荷不改动既有 RSS 诊断字段。

### 首页计时与扫描（当前行为）

- 普通 `/`、`/page/:page` 请求记录 auth、post query、admin status、render 服务端计时；cron 记录 rssSync、订阅、清理分解计时。block/highlight 规则完全在浏览器执行，服务端不再记录 block/highlight 计时字段。
- 计时快照经 `ctx.waitUntil()` 异步写入 `sync_state.last_home_timing`，不延迟页面响应。
- `page=N` URL 与 pager UI 不变。
- 搜索扫描填满当前请求页后即停止，不扫全表。
- Worker 端扫描内部使用 `published_at DESC, id DESC` keyset 游标；SQL 快路径同序稳定分页。
- `migrations/0008_posts_keyset_indexes.sql` 提供 `(published_at DESC, id DESC)` 与 `(board_key, published_at DESC, id DESC)` 索引。

### UI 规则

- 黑白视觉语言，圆润控件与卡片。
- 蓝色用于主操作/当前页；红色用于删除/已读帖子。
- `prefers-color-scheme: dark` 使用 OLED `#000`（页面、卡片、对话框、控件）。
- 搜索与分页在小屏保持一行。
- 卡片只显示标题、正文、三列用户名/板块/时间行。
- 点击用户名复制到剪贴板，不打开帖子。
- 点击卡片在新标签打开原帖并标记已读；已读帖渲染红色。
- 正文图片 markdown 与 image 标签渲染为响应式图片。

### 部署

README 记录 Cloudflare Workers GitHub 集成流程：主路径无需手动建 D1、改 `database_id`、贴 SQL。用户 fork 仓库、在 Cloudflare 连接仓库、构建命令填 `npm run deploy`。

构建命令运行 `scripts/cloudflare-build.mjs`：用 Wrangler 查找名为 `nodeseek-rss-reader` 的 D1（不存在则创建）→ 生成 `wrangler.generated.jsonc`（含 `database_id`）→ 对远端库应用 D1 迁移 → 用生成配置跑 deploy dry-run 校验 → 部署。

`wrangler.jsonc` 是本地开发模板，不含手工 `database_id` 占位。若 GitHub 构建环境无足够 Wrangler 权限，README 提供备用 CLI 段（`npm run cf:build` + `npm run deploy:generated`），但主路径仍是单一构建命令。

### 管理设置

管理员用单一 Secret `ADMIN_SECRET` 认证：访问 `/admin?token=ADMIN_SECRET` 建立 7 天 HttpOnly 管理会话；UI 须提示收藏该 URL（会话 7 天过期）。

`ADMIN_SECRET` 同时派生 AES-GCM 密钥用于加密 D1 设置。Brevo API Key 与 Telegram Bot Token 加密存于 `app_settings`；发件邮箱、发件人名、保留天数明文存储。运行时通知代码先读 D1 设置，再回退环境变量。

默认保留：已读状态 7 天；RSS 帖子 365 天；推送日志 30 天。计划任务经 `sync_state.last_cleanup_at` 闸门每天至多执行一次清理。

### D1 分页与浏览器端规则优化设计（原 DESIGN_D1_PAGINATION.md 全文并入）

**1. 设计范围**：约束分页、规则缓存、API、配置和安全行为；只描述已确认需求及最小实现决策。

**2. 用户已确认的原始需求**（实现不得改写语义）：
1. 不显示精确总页数。
2. 页码窗口保持现有行为，显示当前页至当前页加 3。
3. 页码按钮是占位链接，不预查目标页，点击后才请求 `page=N`。
4. 默认每页 99 条，管理员可配置每页数量。
5. 超出范围的页允许返回空页。
6. 搜索分页暂缓，保留现有服务端搜索语义；屏蔽和高亮不参与云端匹配或分页。
7. 屏蔽和高亮完全在浏览器端执行；普通列表应用同步的 block 规则，搜索结果不应用 block 规则；浏览器再应用高亮规则。

**3. 明确排除项**：不引入新前端框架；不引入 KV/DO/R2（状态用 D1 + 匿名用户 `localStorage`）；不新增搜索分页实现；不为精确总页数保留无条件 `COUNT(*)`；不新增 Keyset 分页实现（保留 `page=N` 与 `OFFSET` 快路径；Worker 端搜索扫描内部的 keyset 游标属既有实现，不在排除范围内）。

**4. 现状约束与核心决策**：
- 4.1 D1 查询：普通列表删除分页用无条件 `COUNT(*)`，按 `page=N` 计算 `OFFSET` 只读所需页；block 规则不参与云端分页；越界页返回空 `posts` 数组。索引改善排序/过滤/分页读取，但不消除 `COUNT(*)` 成本；成本优化来自移除计数查询。
- 4.2 页码窗口：`[currentPage, currentPage+1, currentPage+2, currentPage+3]`，不用 `totalPages` 截断；上一页在第一页指向第一页，下一页指向当前页+1；最后一页无需在当前响应中识别。
- 4.3 搜索：`q` 服务端只匹配 `title` + `content_text`；作者与板块名不参与匹配，板块下拉是独立结构化筛选；搜索分页迁移暂缓；搜索结果页不应用 block 规则，普通列表页应用同一份同步 block 规则。

**5. 数据流**：
- 5.1 SSR 首页：解析用户/`page`/`board`/`q` + 运行时 `page_size` → 按发布时间稳定排序读当前页（无云端规则匹配、无分页 `COUNT(*)`）→ 仅按标题正文服务端搜索，返回规则载荷 → 无帖子仍返回正常页面 → SSR 输出内容、当前至+3 占位页码、同页规则缓存载荷或版本信息 → 浏览器先屏蔽再高亮。
- 5.2 点击页码：客户端只请求对应 `page=N`，保留 `board`、`q` 与用户上下文；响应携带目标页数据与分页状态，不依赖精确总页数；窗口继续当前页至+3。
- 5.3 规则载荷：block/highlight 属用户隔离数据；响应带版本标识，规则变化时带完整载荷；客户端确认持有相同版本时不重复发送完整规则；版本变化时先替换内存状态、先屏蔽后高亮。

**6. 页面数据与 API 契约**：
- 6.1 页面数据语义至少含 `posts`（可为空）、`page`（规范化 ≥1）、`pageSize`、`board`、`query`、规则版本与按需载荷字段；`totalPages` 非必需，不得作为渲染/翻页前置条件。
- 6.2 请求参数：`page=N`、`board=...`、`q=...`；`page` 无效规范化为 ≥1 整数；另设 `MAX_PAGE_OFFSET` 安全上限（`src/posts.ts`），把页码钳制在 OFFSET 整数安全范围内；越界有效页码返回空页不报错；分页响应须能表达当前页数据/页码/`pageSize`/规则版本与是否随响应发送，不得要求先调总数接口。

**7. 每页数量配置**：
- 7.1 `page_size` 用现有 `app_settings` D1 runtime settings 保存；未配置/不可解析回退默认 `99`，越界整数钳制到 10..500 边界（读、写路径同用 `clampPageSize`）；不新增存储类型。
- 7.2 Admin 设置页可配 `page_size`，允许 10..500 含边界；服务端必须重新解析校验，不能只依赖浏览器控件。实际实现为**钳制**：越界整数提交值收紧到 10..500 边界（非拒绝），缺失/非整数等非法值回退默认 99——两条路径均以 `clampPageSize` 为准；这是长期行为，修改前先与 owner 确认。保存后对新请求生效，当前请求用本次开始时读取的单一配置值。

**8. 规则版本、缓存与用户隔离**：缓存键必须含用户身份范围；匿名与不同登录用户不共享规则缓存；匿名继续用 localStorage 约定；登录用户状态不得被遗留的另一用户缓存采用。客户端至少维护用户范围、版本、载荷三者对应：匿名用固定匿名范围标识，登出/切换身份时清理；登录用户用稳定用户标识，不以用户名显示文本作凭据；登录/登出/版本变化时旧版本不得继续参与处理；规则更新先替换内存再处理新内容。版本检查只用于载荷收发判断，不用于授权；服务端以当前会话用户读取规则，不接受客户端提交的规则为可信来源。

**9. 浏览器处理与防闪现**：顺序固定：先 block（移除/隐藏匹配项），再对仍可见内容 highlight。首屏不能长时间以未处理状态显示；在现有 SSR/client 结构中设最小预处理状态，规则准备与 block 先完成再进入高亮。正则必须继续通过现有安全检查与编译路径；不得使用未校验动态正则，不得因客户端缓存跳过服务端安全约束。

**10. XSS 与安全约束**：帖子标题/正文/用户名/板块/链接与规则相关文本继续走现有 HTML 转义或安全 HTML 路径；`href`、`data-*` 属性值必须属性转义，外部帖子链接继续真实 `<a target="_blank">`，不得改成新的中转路由；规则文本不是 HTML，不得直接拼接进标记，嵌入的规则载荷必须安全结构化编码传输、客户端解析后作数据使用；服务端会话与用户身份决定可读规则范围，localStorage 只能作为对应用户范围的缓存，不能成为跨用户授权机制；page size、page number 等查询参数必须服务端校验。

**11. 回滚设计**：实现保持可逆——分页查询、页面数据、SSR pager、客户端分页请求、规则载荷处理、page size 读取保持模块边界清晰；无总数分页出问题可临时恢复旧分页渲染与计数逻辑（不得描述为目标设计）；规则版本或防闪现出问题优先关闭客户端增量规则缓存路径，回退同页发送完整规则并保持“先屏蔽、后高亮”；Admin page_size 异常回退安全默认 99；回滚不得引入 KV 或其他存储，也不得改写已部署历史迁移。

**12. 实现验收边界**：普通首页、匿名用户、登录用户、board 筛选、有效与越界 `page=N`、read state、Admin 10..500 page size 校验、无精确总页数查询、页码点击后才请求、当前至+3 窗口、规则版本变化、用户隔离、登出清理、“先屏蔽、后高亮”顺序。
