# OpenCode 行为规范: 严格规范驱动开发 (Strict SDD)

你现在处于“严格规范驱动”模式。除非用户明确允许，否则禁止跳过设计阶段直接编码，禁止添加任何用户未提及的功能。

## 核心原则
1. **禁止幻觉**: 严禁根据“常识”或“最佳实践”自动补全用户未提及的业务逻辑。
2. **两阶段执行**: 
   - 阶段一：设计 (Design Phase)。必须先输出 `DESIGN_SPEC.md`。
   - 阶段二：实现 (Implementation Phase)。必须在用户确认设计后，严格按设计稿编码。
3. **字面服从**: 严格按照用户输入的文字描述进行解析，宁可提问，不可猜测。

## 阶段工作流

### 1. 设计阶段 (Mandatory)
当用户提交需求时，你必须首先生成或更新项目根目录下的 `DESIGN_SPEC.md`。
- **输出要求**:
  - 模块结构、API 定义、数据模型。
  - 明确标出用户输入的原始需求点。
- **暂停指令**: 完成文档后，必须输出：“设计文档已生成，请检查。确认无误后请输入 /build 或‘开始编码’。”

### 2. 编码阶段 (Post-Approval)
仅在收到确认指令后开始。
- **代码一致性**: 生成的函数名、变量名、文件路径必须与 `DESIGN_SPEC.md` 保持 100% 一致。
- **范围控制**: 仅编写实现设计稿所需的最少代码。严禁引入额外的第三方库（除非用户指定）。

## 交互约束
- **术语映射**: 将用户的描述转成专业术语，与用户沟通时使用“用户的口语描述（专业术语）”的方式。
- **澄清机制**: 如果用户输入含糊不清，必须列出 2-3 个理解选项让用户选择，而不是自动选择其中之一。


## 触发命令
- `/start`: 重置状态，等待接收原始需求以开始设计。
- `/spec`: 仅更新设计文档，不修改代码。

# Repository Instructions

## Shape
- Cloudflare Workers + D1 app for only `https://rss.nodeseek.com/`; do not add KV/other storage unless explicitly requested.
- Main Worker entry: `src/index.ts`; SSR HTML: `src/render.ts`; all CSS: `src/styles.ts`; RSS sync/parser/diagnostics: `src/rss.ts`.
- D1 stores posts, users, sessions, read state, settings, rules, subscriptions, push logs, sync state, and RSS attempt diagnostics.
- Generated deploy config is root `wrangler.generated.jsonc`; edit `wrangler.jsonc` and `scripts/cloudflare-build.mjs`, not generated output.
- `nodeseek.js` and `rss.nodeseek.com.har` are local reference artifacts; do not commit them unless explicitly asked.

## Project Structure
- `src/board.ts`: board key normalization and board-specific helpers.
- `src/db.ts`: thin D1 helpers and JSON/cookie utilities.
- `src/filters.ts`: regex safety, highlighting, HTML helpers.
- `src/time.ts`: time/date helpers.
- `src/types.ts`: shared Env, model, and timing types.
- `src/index.ts`: request routing, scheduled cron entry, `/api/debug/status`.
- `src/rss.ts`: RSS fetch, parse, sync, and RSS attempt diagnostics.
- `src/posts.ts`: homepage / `/api/posts` query, pagination, search, block filtering.
- `src/subscriptions.ts`: subscription regex matching and notification dispatch.
- `src/notifications.ts`: Brevo / Telegram senders and push logging.
- `src/cleanup.ts`: retention cleanup for posts, read states, push logs, sessions.
- `src/settings.ts`: runtime settings load/save and admin configuration.
- `src/auth.ts`: registration, login, sessions, Telegram binding.
- `src/render.ts`: SSR HTML shell and client script.
- `src/styles.ts`: all CSS and responsive layout.
- `migrations/`: numbered D1 schema migrations; never rewrite deployed ones.
- `scripts/cloudflare-build.mjs`: Cloudflare build/deploy config generator; keep generated config at repo root.

## Where to Look
- RSS / cron slowness: `src/rss.ts`, `src/subscriptions.ts`, `src/cleanup.ts`.
- Homepage slowness: `src/posts.ts`, `src/render.ts`.
- Notification dedupe / push logs: `src/notifications.ts`, `src/subscriptions.ts`, `migrations/0001_initial.sql`, `migrations/0009_push_logs_post_guid.sql`.
- Admin / debug status: `src/index.ts`, `src/settings.ts`.

## Current Conventions
- Keep RSS sync limited to `https://rss.nodeseek.com/`.
- Prefer D1-backed state; avoid introducing new storage.
- Keep homepage card layout and CSS centralized in `src/styles.ts`.
- Preserve root `wrangler.generated.jsonc` and root `wrangler.jsonc` generation flow.
- When changing push dedupe, use `push_logs.post_guid`; do not reintroduce `post_id`-based dedupe in new code.

## Gotchas
- `posts.guid` is the stable RSS identity; use it for RSS-side de-duplication.
- `posts.id` still exists for persisted rows and read-state relations, but new RSS notification flow should not depend on re-reading full rows.
- Cron diagnostics in `/api/debug/status` are temporary investigation aids; avoid adding more unless they explain a concrete regression.

## Commands
- Typecheck: `npm run typecheck`.
- Build-script syntax check: `node --check scripts/cloudflare-build.mjs`.
- Local dev: `npm run dev`.
- Local D1 migrations: `npm run db:migrate:local`; remote migrations: `npm run db:migrate`.
- Cloudflare GitHub build/deploy command is exactly `npm run deploy`; deploy from already generated config with `npm run deploy:generated`.
- No test or lint scripts are defined in `package.json`; do not invent them.

## Deploy And Config
- `npm run deploy` runs `scripts/cloudflare-build.mjs`, finds/creates D1, writes both `wrangler.generated.jsonc` and root `wrangler.jsonc` with `DB`, applies migrations, dry-runs deploy, then `wrangler deploy --config wrangler.generated.jsonc`.
- Branch `factory` maps to Worker/D1 `nodeseek-rss-reader-factory`; all other branches default to `nodeseek-rss-reader`.
- Keep generated config at repo root; migrations previously broke when generated config was moved under `.wrangler/`.
- `wrangler d1 create` output is parsed as text because Cloudflare build logs may not support `--json` there.
- Runtime `Cannot read properties of undefined (reading 'prepare')` means missing D1 binding named `DB`; `/health` is the fastest DB/table check.
- `wrangler.jsonc` enables cron `*/1 * * * *` and `observability.enabled`; use Workers Logs for cron/RSS diagnosis.

## Data And Migrations
- Add schema changes as new numbered SQL files; never rewrite deployed migrations.
- Current migration chain: `0001_initial` through `0009_push_logs_post_guid`; `rss_fetch_failures` is legacy, new diagnostics read `rss_fetch_attempts` only.
- `0008_posts_keyset_indexes` supports home-page keyset scans with `(published_at DESC, id DESC)` and `(board_key, published_at DESC, id DESC)`; confirm remote indexes with `wrangler d1 execute ... "SELECT name FROM sqlite_master WHERE type='index' AND name IN (...)"` when diagnosing deep-page slowness.
- `0009_push_logs_post_guid` moves push-log idempotency from `post_id` to `post_guid`; preserve this direction in new dedupe code.
- `ADMIN_SECRET` authenticates `/admin?token=...` and encrypts D1-stored Brevo/Telegram settings; changing it requires re-entering encrypted settings.
- PBKDF2 iterations must stay `<= 100000`; Workers reject higher counts.

## RSS Sync
- Current scheduled sync sleeps random `A=21..24s`, tries `rss`, and on failure sleeps random `B=21..24s` before trying `browser`.
- `/api/rss-test` is fast diagnostics only: same order `rss -> browser`, no sleeps.
- `src/rss.ts` uses `cf.cacheTtl = 60`; NodeSeek RSS often returns nginx `503`, so keep structured diagnostics before changing cron frequency or headers.
- `/api/debug/status?token=ADMIN_SECRET` does not run live RSS fetches by default; append `live=1` to run `/api/rss-test` style diagnostics.
- `rss_fetch_attempts` records both successes and failures with keys like `rss_success`, `rss_failure`, `browser_success`, `browser_failure` in `/api/debug/status?token=ADMIN_SECRET` under `rss.failureSummary`; `rss.attemptStats` also summarizes cron vs rss-test success/failure.
- `safeSyncRss()` catches cron errors and records `sync_state.last_sync_error`; Cloudflare cron logs can show `outcome: ok` even when RSS sync failed.

## Runtime Behavior
- Post cards must open the original RSS `link` with real `<a target="_blank">`; do not route normal opens through `/post/:id/open`.
- Read state is D1-backed for logged-in users and localStorage-backed for anonymous users.
- Each page shows 50 posts; search must cover all RSS posts in D1, not just the latest page/window.
- Telegram bind codes are 24-hour codes from `GET /api/account`; bound users should not see a bind code until they clear Telegram binding.

## Hotspots
- `src/posts.ts`: search/block rules force Worker-side filtering; keep `page=N` URLs/UI, but scan only until the current page is filled, use keyset pagination, and do not load `content_html` until the final 50 post IDs are known.
- Slow-path scan chunk size is intentionally `1000`; check `home.timings.queryPosts.scannedChunks`, `matchedPosts`, and `scanMs` in `/api/debug/status` before changing it.
- `/api/debug/status` shows the latest real home-page timing from `sync_state.last_home_timing`; it is written with `ctx.waitUntil()` so timing writes should not block normal page responses.
- `src/subscriptions.ts`: matching can become users x subscriptions x posts; batch reads/log checks and avoid repeated `runtimeSettings(env)` in notification loops.
- Precompile regexes per request/task; avoid `new RegExp` per post/rule comparison.

## UI And Admin
- Preserve black/white rounded responsive UI with OLED pure black dark mode.
- Header brand `NodeSeek RSS Reader` links to `/`; do not add a separate homepage button.
- Post card fields stay limited to title, body, username / board / time; username click only copies username and shows one-line toast.
- Settings tabs stay one row; highlight/block/subscription keyword areas share chip layout and scroll within capped height; destructive actions require confirmation.
- Floating top/bottom buttons use `nd-jump-group`/`nd-jump-item` styling around `bottom: 200px`; GitHub footer points to `https://github.com/sfhgknsdfksdlf/nodeseek-rss-reader` and shows stars.
- Admin page is standalone `/admin?token=ADMIN_SECRET`, not a settings tab; preserve inline Brevo API-key guidance if touching admin forms.
- Admin setup docs should use bilingual UI labels like `Workers 和 Pages / Workers & Pages` and mention clicking blank space under Secret input to enable Save.
- Import/export is current-tab only; import overwrites the current tab's rules.

## Git
- Remote is `https://github.com/sfhgknsdfksdlf/nodeseek-rss-reader.git`; pushing needs user credentials.
- Do not force push `main`.
- If committing as the repo owner, use one-off author flags rather than persistent git config: `git -c user.name="sfhgknsdfksdlf" -c user.email="113858507+sfhgknsdfksdlf@users.noreply.github.com" commit ...`.
