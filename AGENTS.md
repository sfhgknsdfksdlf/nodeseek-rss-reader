# PROJECT KNOWLEDGE BASE

**Generated:** 2026-09-12
**Commit:** da86244
**Branch:** factory

## OVERVIEW

Cloudflare Workers + D1 application serving only `https://rss.nodeseek.com/` as an RSS reader. The Worker owns SSR pages, API routing, cron RSS synchronization, FTS5 keyword search, authentication, per-user rules, subscriptions, notifications, and diagnostics.

## STRUCTURE

```text
./
├── src/                    # Worker routes and application modules
├── migrations/             # Sequential D1 schema migrations
├── scripts/                # Cloudflare build/deploy config generation
├── public/                 # PWA icon.svg + manifest.webmanifest — repo assets only; the Worker serves embedded copies from src/index.ts, never these files
├── README.md               # Deployment and administrator setup
├── AGENTS.md               # Knowledge base + merged approved design (this file)
├── package.json            # Scripts (dev/migrate/deploy/typecheck); no test or lint scripts
├── tsconfig.json           # strict/no-emit TypeScript config
├── wrangler.jsonc            # Source Worker/D1/cron configuration (no committed DB binding)
├── wrangler.local-qa.jsonc # Committed local-dev/QA config with placeholder D1 binding (`npm run dev` and `db:migrate:local` use it); intentionally no cron/observability blocks
├── package-lock.json       # npm lockfile; all deps are devDependencies (@cloudflare/workers-types, typescript, wrangler)
└── .gitignore              # ignores .wrangler/, transient wrangler.generated.jsonc, .dev.vars, logs, QA captures, agent state; the `.codegraph/` index is excluded only via local `.git/info/exclude`, never `git add` it
```

This is one package, not a monorepo. `migrations/` and `scripts/` are independent operational domains, but their current size does not warrant child `AGENTS.md` files.

## CODE MAP

| Symbol/module | Location | Role |
|---|---|---|
| Worker `fetch`/`scheduled` | `src/index.ts` | Request routing, state-machine cron orchestration (state 0 sync→claim/build; state 1 verify/recover only; state 2 sync→subscriptions→cleanup→prune), debug status, static `/go` interstitial shell |
| RSS sync/parser | `src/rss.ts` | Fetch strategies, parse, D1 insert, diagnostics |
| Home query | `src/posts.ts` | Page/board query, literal-keyword FTS5 search (title+body), pagination, read state |
| SSR shell/client script | `src/render.ts` | HTML rendering, search-term marking + local search pager, browser interactions |
| FTS5 search index/query | `src/search.ts` | Query parsing (literal terms, trigram/bigram anchor), per-post index writes, resumable backfill, index error/retry state |
| Runtime settings | `src/settings.ts` | D1-backed settings and admin configuration (`page_size`, `search_result_limit`, retention, notification keys) |
| Auth/session | `src/auth.ts` | Registration, login, cookies, Telegram binding |
| Rules | `src/rules.ts` | User-isolated rule loading, `cacheHit` negotiation; `rulesVersion` digests the full canonical payload |
| Import validation | `src/rule-import.ts` | Shared limits, strict body parsing, structured errors for `/api/import/*`, shared chained-aware `validatePatternInput` gate for all rule writes |
| Subscriptions | `src/subscriptions.ts` | Chained AND matching and notification dispatch |
| Notification senders | `src/notifications.ts` | Brevo/Telegram requests and GUID push logs |
| D1 cleanup | `src/cleanup.ts` | Retention for read states, push logs, RSS attempts, user+admin sessions; never deletes posts |
| D1 capacity prune + 0014 state machine | `src/prune.ts` | `db_prune_index_state` (`0`/`1`/`2`) claim/recover/build/verify, size probe (`SELECT 1` + `meta.size_after`), 10,000 posts/UTC-day cap for every day, normal FTS batch, full-DB posts-first fallback, FTS orphan cursors, never throws |
| Shared helpers | `src/db.ts` | D1 `one`/`all` helpers, JSON responses, body parsing, cookie/session-cookie builders |
| HTML/regex + chained-rule core | `src/filters.ts` | Escaping, `safeHttpUrl`, `safeRegex` + ReDoS-hazard guard, chained-rule core (`parseChainedRule`/`compileChainedRule`/`matchChainedRule`/`extractChainedRuleMatches`), `sanitizePostHtml` whitelist sanitizer, post text builders |
| Board helpers | `src/board.ts` | Board name normalization and option lists for render |
| Homepage CSS | `src/styles.ts` | Responsive black/white/OLED stylesheet consumed by `src/render.ts` |
| Time display | `src/time.ts` | `formatBeijingTime` (UTC+8, same-day `今天 HH:MM`) |
| Shared types | `src/types.ts` | `Env`, model, page, and timing contracts |

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| RSS/cron latency | `src/rss.ts`, `src/subscriptions.ts`, `src/cleanup.ts` | Inspect `/api/debug/status`; preserve structured timings |
| D1 容量/满库 | `src/prune.ts`, `src/index.ts`, `src/settings.ts` | Cron prunes after sync only in state `"2"`; check `storage` and `sync_state.db_prune_*`; state machine, normal batch, wall posts-first fallback, FTS orphan cursors; no `PRAGMA page_count`/`dbstat`/REST |
| Homepage latency | `src/posts.ts`, `src/render.ts` | Preserve page size and scan behavior |
| Search latency/index gaps | `src/search.ts`, `src/posts.ts` | Check `search_index_state.complete` and `sync_state.last_search_index_error`; cron backfill ≤25 posts/min, resumable |
| Notification dedupe | `src/notifications.ts`, `src/subscriptions.ts`, `migrations/0009*.sql`, `migrations/0010*.sql` | Use `post_guid`, never `post_id` |
| Admin/debug routes | `src/index.ts`, `src/settings.ts` | Admin auth is the URL-query token model (`/admin?token=ADMIN_SECRET`, owner-approved); comparison must stay constant-time (`secretTokensEqual`) |
| User rule handoff | `src/rules.ts`, `src/render.ts` | Payload/version/cache keys stay user-scoped |
| Rule list ordering | `src/rules.ts`, `src/index.ts`, `src/render.ts` (`keywordRows`) | Canonical order is `id ASC` for user-facing rule lists; see CONVENTIONS |
| Rule import changes | `src/rule-import.ts`, `src/index.ts` | Inclusive limits: 1 MiB body, 20 groups, 5000 rules, 200-char whole rule (chained-aware gate); reject before any D1 call |
| Rule matching semantics | `src/filters.ts`, `src/subscriptions.ts`, `src/render.ts` | Chained `####` AND core (server + browser mirror); search `q` is literal keyword FTS5 search, not regex; see APPROVED DESIGN |
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
- **CPU hard limit (MUST):** Workers Free allows **10 ms CPU per HTTP request and 10 ms CPU per Cron Trigger**; network waits (RSS 21–24 s sleeps, `fetch`, D1 queries) do not count toward CPU, but Cron wall-clock is capped at 15 min. Every change MUST consider CPU usage: no unbounded loops or full-table scans, no full FTS rebuilds, keep regex/JSON/HTML and per-post work bounded, and check `home.timings`, `sync_state.last_cron_timing`, or Workers Logs before merging. Exceeding CPU terminates the invocation (Error 1102) and can break cron recovery. Source: https://developers.cloudflare.com/workers/platform/limits/
- **D1 free-tier read/write quotas (MUST):** D1 Free allows **5,000,000 rows read/day and 100,000 rows written/day per account** (resets 00:00 UTC), **50 queries per Worker invocation**, **500 MB per database / 5 GB per account**, and **10 databases**. Rows read counts every row **scanned**, not just returned (`SELECT COUNT(*)` over 340k posts = 340k rows; 34 debug calls = 11.59M rows and exhausted the daily quota). Rows written counts every `INSERT`/`UPDATE`/`DELETE` row; indexes add writes. Every change MUST consider D1 read/write usage: no new full-table scans/counts on hot paths or monitoring endpoints, no full reindex/import loops, batch and paginate writes, keep diagnostics bounded, and check D1 Row Metrics or `meta.rows_read`/`rows_written` before merging. Exceeding the daily quota makes all queries fail until 00:00 UTC. Source: https://developers.cloudflare.com/d1/platform/limits/ · https://developers.cloudflare.com/d1/platform/pricing/
- Package is ESM (`"type": "module"`); tsconfig `include` is `src/**/*.ts` only. `wrangler.local-qa.jsonc` intentionally omits the production cron trigger and observability blocks (local QA only).
- D1 owns all persistent state. Do not add KV, Durable Objects, R2, or another store without an explicit request.
- D1 capacity pruning (see APPROVED DESIGN「D1 容量自动裁剪」) is gated by the `sync_state.db_prune_index_state` machine (`"0"` unverified → `"1"` building/recovering → `"2"` verified). State `"0"` runs normal RSS and never prunes; state `"1"` pauses every scheduled task except state I/O, the idempotent 0014 DDL, independent verification, and error logging; state `"2"` never re-runs 0014 and prunes only inside UTC 23:30–00:00 with a valid `read_states(post_id)` index. Only posts whose `published_at` AND `fetched_at` are both older than 24h are eligible, deleted oldest-first (`published_at ASC, id ASC`); the normal path deletes `read_states`, both FTS tables, and `posts` in one `env.DB.batch()`, while the full-DB fallback deletes single-statement `read_states` then `posts` and leaves FTS orphans for the cursor cleanup. Every UTC day caps pruning at 10,000 posts; every batch is an atomic conditional reservation before each 100-post batch, every delete entry (including initialization and fallback) passes the same window/index/daily-cap gate, and 00:00Z starts no new batch. There is no application-level total write cap: when D1 rejects a write because the platform daily quota is exhausted, the round logs to Workers Logs and stops without looping or degrading, and pruning resumes only after the next 00:00 UTC reset and the following 23:30–00:00 window. Defaults are free 480 MB trigger / 450 MB target, paid 9850 MB trigger / 9000 MB target (paid target 9000 only when the trigger is above 9000; otherwise trigger-30 MB); new posts are capped at 5 only above plan max capacity - 2 MB. Size comes only from `SELECT 1` + `meta.size_after`: never `PRAGMA page_count`/`dbstat`, the Cloudflare REST API/token, or `VACUUM`. Every admin setting is preserve-on-omit: a PUT only writes the fields it provides, so an omitted field keeps its stored value.
- RSS scope is fixed to `https://rss.nodeseek.com/`; `posts.guid` is the stable RSS identity.
- Post cards open the source URL through the root-relative `/go?v=2#p=<post id>&u=<encodeURIComponent(source URL)>` interstitial (owner-approved 2026-09-06, see APPROVED DESIGN「后台打开标红 /go 中转」); root-relative links resolve against the current domain, so multiple custom domains need no detection logic. Read receipts still go through `POST /api/read-state`. The interstitial is a static client-side shell served at `GET /go`; the server never redirects.
- Logged-in read state is D1-backed; anonymous read state is localStorage-backed.
- Rule imports are all-or-nothing: fully validate first, then replace with exactly one `env.DB.batch()` per handler; never delete before validation succeeds. A missing top-level collection key (`groups`/`patterns`/`rules`) is a client bug and is rejected, not treated as an empty import; an explicit empty array means "replace with empty". Per-group `patterns` inside a highlight import stays optional and defaults to `[]` (normalize-and-default semantics for display-only fields).
- All rule-writing endpoints (imports, highlight PUT, block POST, subscription POST) share the same chained-aware `validatePatternInput` gate: whole-trim ≤200 chars (separators and internal spaces count) → `parseChainedRule` (literal `####` split, 1..4 segments, empty/whitespace-only segments rejected) → per-segment `safeRegex` compile. Reject before any D1 call; never persist patterns the matcher would silently drop; store the whole trimmed original string — parsing happens again at match time.
- Rule matching is unified chained AND (see APPROVED DESIGN「规则 #### 链式分段 AND 匹配」): block/highlight/subscription all consume the chained core from `src/filters.ts`, and the embedded browser script mirrors it. Search `q` is literal keyword FTS5 search (see APPROVED DESIGN「索引关键词搜索」) — never regex, and chained parsing does not apply to it either; do not re-introduce whole-string regex compilation for the three rule types.
- `rulesVersion` is a SHA-256 digest of the complete canonical rule payload (block rules + highlight groups with patterns, including row ids): any persisted change to any rule field changes it; failed writes never do. Cache-hit home payloads (`cacheHit: true`) omit rule arrays; clients reuse localStorage only on exact userId + version match.
- Rule ordering is canonical D1 insertion order (`id ASC`) for every user-facing rule list: SQL reads, API payloads, export, import, and PUT bodies. The settings page PUTs pattern arrays back verbatim on every add/delete/color edit, so any other sort permutes saved rules. Exception: the cron-only subscription loader (`src/subscriptions.ts`) stays `ORDER BY s.id DESC` — matching is order-insensitive and it never round-trips through the settings page.
- Settings chip display is intentionally reversed at the rendering layer: `keywordRows` renders the payload in reverse DOM order because the `.keywords` CSS (`row-reverse` + `wrap-reverse`, group left-aligned) mirrors it into the owner-approved layout — tail (newest) chip at bottom-right, rows reading left→right, full rows wrapping upward, upper rows left-aligned. PUT bodies always come from the in-memory payload arrays, never from DOM order.
- Keep homepage card CSS in `src/styles.ts`; preserve the rounded black/white UI and OLED pure-black dark mode.
- Listings use runtime `page_size` (default 80, saved range 10..500), `page=N` URLs, and no exact total-page calculation.
- Search results use runtime `search_result_limit` (default 200, integer clamped to 50..500; missing/non-integer falls back to 200) as a hard cap; the capped set renders once and pages locally in the browser with `page_size` — no server-side search paging, no per-page network requests.

## ANTI-PATTERNS (THIS PROJECT)

- Do not skip design approval or change scope beyond it.
- Do not use `as any`, `@ts-ignore`, `@ts-expect-error`, or empty catch blocks. The empty `catch {}` blocks inside the embedded browser script in `src/render.ts` are a pre-existing guarded-localStorage convention; the prohibition applies to new server-side TS.
- Do not compile stored block/highlight/subscription patterns as a single whole-string regex; use the chained core (parse + per-segment compile). Historical rows containing literal `####` are interpreted under chained semantics at match time (owner-approved). Search `q` is the opposite: literal keyword FTS5 search — do not re-introduce regex (or chained) semantics for it.
- Do not silently skip, truncate, or partially apply imported rules; reject the whole request with field/index error details.
- Never trust client `rulesVersion` as authoritative; the server always computes the current digest.
- Do not read user-facing rule lists with `ORDER BY id DESC` or re-sort/reverse the payload in the data layer; the settings page round-trips arrays verbatim, so any re-ordering permutes saved rules. (`keywordRows`' display-side reversal is the single sanctioned exception — DOM order must never leak into PUT bodies.)
- Do not rewrite deployed migrations. Add sequential files instead.
- Do not use `push_logs.post_id`; the final schema and dedupe paths use `push_logs.post_guid` exclusively.
- Do not confuse `read_states.post_id` with notification-log identity.
- Registration error mapping (`src/auth.ts`): only a real username uniqueness collision returns "用户名已存在"/409 — other DB failures must surface as their own error, never as a false taken-username report.
- Do not commit local artifacts: agent states (`.sisyphus/`, `.omo/`, `session-ses_*.md`), logs, or reference dumps. Gitignore covers them; never `git add -f` them.

## DATA AND MIGRATIONS

- Current chain is `0001_initial` through `0014_read_states_post_id_index`.
- `0009` moved push idempotency to `post_guid`; `0010` removed legacy `push_logs.post_id`, its FK, unique constraint, and index.
- `0011_sessions_expiry_index` adds `sessions(expires_at)` for the daily expired-session purge in `cleanupOldData`.
- `0012_search_indexes` adds the FTS5 search index: contentless `posts_search_trigram` (`tokenize='trigram'`) and `posts_search_bigrams` (hex-codepoint bigram tokens), both keyed by `rowid = posts.id`, plus singleton `search_index_state(id=1, last_post_id, complete, updated_at)` for the resumable cron backfill.
- `0014_read_states_post_id_index` is ledger-only/no-op; it deliberately does NOT create the index on the build path. The cron state machine creates `read_states(post_id)` (idempotent `CREATE INDEX IF NOT EXISTS`) and independently verifies `sqlite_schema` + `PRAGMA index_info` before writing state `"2"`. Without the index the `posts` delete FK check scans the child table (~34.7k rows per 100-post batch), so pruning stays disabled until verification.
- `0010` caveat (documented, do not edit the migration): a legacy `push_logs` row whose `post_guid` is blank AND whose `post_id` no longer resolves to a `posts.guid` would insert NULL into the `NOT NULL` replacement column, aborting the migration atomically. `0010` is already on `main` (deployed branch) and must not be rewritten; if a database hits this, fix the orphan rows manually, then re-apply.
- `0008_posts_keyset_indexes` supports `(published_at DESC, id DESC)` and `(board_key, published_at DESC, id DESC)` scans.
- Push logs retain GUIDs independently of post deletion by capacity pruning; do not add an FK from `post_guid` to `posts.guid`.
- `cleanupOldData` purges expired `read_states`, `push_logs`, `admin_sessions`, user `sessions`, and 24h-expired `rss_fetch_attempts` daily (gated by `sync_state.last_cleanup_at`); posts are never deleted by age.
- D1 capacity pruning reuses `app_settings`/`sync_state`. Settings: `db_prune_limit_mb` (free default 480 / paid 9850, clamp 100..9850), `d1_paid_enabled` (default false). State: `db_prune_index_state` (`"0"`/`"1"`/`"2"`, missing = `"0"`, invalid kept as-is with a config error), `db_prune_active`, `db_prune_day`, `db_prune_deleted_today`, `db_prune_last_at`, `db_prune_last_error`, `db_prune_blocked_full`, `db_prune_fts_trigram_cursor`, `db_prune_fts_bigram_cursor`, `db_prune_lease` (holder token, 16-min max age = 15-min cron wall clock + margin; acquired before RSS/subscriptions and released only after `waitUntil` background work settles; a non-empty lease with an unparseable timestamp is treated as live, never expired). Legacy `db_prune_limit_mb` value `"450"` is decoded as 480 at read time (no migration); an admin explicitly saving 450 stores `"450.0"` and stays 450. A ledger-only migration still needs a ledger write, so it cannot unblock a full database; 0014 is applied by the build as a no-op and the index is built/verified by the first 23:30Z state-machine window before pruning is enabled.
- `ADMIN_SECRET` secures admin settings and encrypted Brevo/Telegram values. PBKDF2 iterations must remain `<= 100000`.

## RUNTIME AND HOTSPOTS

- Scheduled sync waits 21..24s before RSS and before browser fallback after failure. `/api/rss-test` is the no-sleep diagnostic path.
- Cron order depends on `db_prune_index_state`: `"0"` → RSS sync → subscriptions → (window only) atomic `0`→`1` claim → idempotent 0014 DDL → independent `sqlite_schema` + `PRAGMA index_info` verification → `2`; `"1"` → verify/recover only (no RSS, prune, subscriptions, retention cleanup, FTS orphan maintenance, search backfill, or non-essential timing writes); `"2"` → RSS sync → subscriptions → cleanup → prune (window + valid index + cap only) → FTS orphan maintenance → search-index backfill. A verification failure returns to `"0"` without a same-window retry; a crash after writing `"1"` is recovered by verifying first (never re-running the DDL). Prune trigger defaults free 480 MB / paid 9850 MB; targets are free 450 MB / paid 9000 MB; normal delete window is UTC 23:30–00:00; every UTC day caps pruning at 10,000 posts; normal path is the 4-statement batch, full-DB path is single-statement `read_states` then `posts` with FTS rows left as orphans. FTS orphan cursors process ≤25 rows per table per invocation only below the trigger and when not blocked. `SEARCH_BACKFILL_BATCH=25`; sync caps new posts at 5 only when size > plan max capacity - 2 MB, never 0. Free plan hard limits are 10 ms CPU per HTTP request and per Cron Trigger, 50 D1 queries and 50 subrequests per invocation, 100,000 requests/day, and D1's 5,000,000 rows read/day plus 100,000 rows written/day (00:00 UTC reset), 500 MB per database / 5 GB per account; keep prune, cleanup, sync, and diagnostics within that budget, and remember wall-clock waits (21–24 s sleeps, fetch/D1) do not count as CPU. Rows read counts scanned rows, so no full-table COUNT in hot paths or monitors. Failures land in `sync_state.db_prune_last_error`/`db_prune_blocked_full` and never block sync.
- `src/rss.ts` uses `cf.cacheTtl = 60`; preserve attempt diagnostics because upstream often returns 503.
- `/api/debug/status?token=ADMIN_SECRET` is non-live unless `live=1`; `safeSyncRss()` records cron failure in `sync_state.last_sync_error`.
- `sync_state` fixed-key write contract (`first_sync_done`, `last_sync_at`, `last_sync_error`, `last_sync_strategy`, `last_cron_timing`, `last_cleanup_at`): missing keys are initialized with guarded `INSERT ... SELECT ... WHERE NOT EXISTS ... ON CONFLICT(key) DO NOTHING`, then updated with conditional `UPDATE ... WHERE value IS NOT ?`; each success path and each failure path runs as one D1 batch. Strategy/error updates fire only on value change, so a stable cron no longer rewrites state every minute. Conditions are evaluated in-DB: with overlapping syncs the later-committing batch wins (success clears the current error, failure keeps it), and there are deliberately no locks or versioning. `last_home_timing` and all search-state writes are outside this contract and unchanged.
- Worker search matches only `title` and `content_text` via the FTS5 index (see APPROVED DESIGN「索引关键词搜索」); browser rules use the synced payload. Ordinary listings apply block rules in the browser, search results skip block rules, and highlights + literal search-term marking render in the browser. In `src/posts.ts`, ordinary listings scan only until the requested page fills; defer `content_html` until final IDs are known.
- Search index lifecycle: new posts index on insert (failure records `last_search_index_error` and flags retry), cron backfills ≤25 posts/min until `search_index_state.complete = 1`; capacity pruning deletes both FTS rows in the same post batch, and the full-DB fallback leaves FTS orphans for the cursor cleanup. Search timings live in `home.timings.queryPosts` (`searchParseMs`/`searchQueryMs`).
- Slow scan chunk size is intentionally 1000. Diagnose with `home.timings.queryPosts` before changing it.
- Subscription work scales users × subscriptions × posts: batch reads/log checks, cache runtime settings, and precompile regexes.
- Subscriptions match ONLY the posts actually inserted by this sync (`insertedPosts` = the `INSERT OR IGNORE` results with truthy `meta.changes`): feed-internal GUID dedupe keeps the first occurrence per GUID, already-present GUIDs and `changes=0` conflicts never match, and the scheduler gate stays `result.ok && !result.firstSync` — the first success (including first-fail-then-success) only imports, never notifies. Matching consumes the in-memory `insertedPosts` array; it never re-queries D1 for "new" posts. `INSERT OR IGNORE` + the `posts.guid` unique constraint remain the final defense against duplicates.
- Rule payloads must be scoped to the logged-in user; browser processing blocks before highlighting.
- Highlight imports preallocate positive group ids (`Date.now()*1000 + crypto random + index`) so one batch can bind child rows; any batch failure rolls back atomically and returns 500.

## UI AND ADMIN

- Header brand links to `/`; do not add a second homepage button.
- Keep post cards to title, body, username, board, and time; username and time clicks each copy and show a one-line toast (time button keeps `<time datetime="ISO8601">` inside for machine-readable semantics).
- Settings tabs stay one row; destructive operations require confirmation.
- Admin is standalone `/admin?token=ADMIN_SECRET`, not a settings tab. The admin settings form exposes 「数据库自动清理触发阈值（MB）」(`dbPruneLimitMb`, free default 480 / paid 9850, input range 100..9850, server-clamped) and a 「付费版 D1」 toggle (`d1PaidEnabled`, default off, max 500 MB vs 10 GB). All admin settings are preserve-on-omit: a PUT only writes the fields it provides, so an omitted field keeps its stored value.
- Floating jump control is a single directional button `#ndJumpBtn` inside `nd-jump-group`/`nd-jump-item` (owner-approved 2026-09-09): style/size identical to the old top/bottom pair; last scroll movement decides the target — scrolling down shows 到底部, scrolling up shows 到顶部 (passive listener, 4px jitter gate); within 100px of the top it locks to 到底部 and within 100px of the bottom to 到顶部 (`ndNear=100`, owner refinement 2026-09-09 — the lock triggers near, not exactly at, the extremes; the middle region keeps direction-following); position is the old 置顶 spot (`bottom:254px` desktop, `bottom:250px` ≤520px).
- Desktop jump-button alignment: `right:max(20px,calc(50% - 530px))` keeps the button 8px off the card column's right edge on wide viewports (fixed-element percentages resolve scrollbar-free, same frame as `.wrap` centering; `522` was the original flush-touch formula, an 8px gap was added the same day); the 20px/12px floors auto-fall back to window-edge margins when the outside margin cannot fit the button. Mobile keeps `right:max(12px,calc(50% - 522px))` (effectively 12px).
- Mobile ≤520px header auth buttons are slightly smaller: `.auth button{padding:.34rem .5rem;font-size:14px}` (设置/退出, and consistently 登录/注册; owner-approved 2026-09-09).
- Read marking colors only the card title: `.card.read .title{color:#ac0079}` (owner-approved 2026-09-09; card body/meta keep normal colors — the original whole-card inheritance was unintended — `--red` stays delete-only).
- Settings chained-rule hint is the example form `规则:A|B####C.*D####E,对应匹配规则为同时包含"A|B"、"C.*D"、"E"三组关键字，三组关键字不区分先后位置` rendered as `.rule-hint`; mobile ≤520px shows one 12px line clamped with tap-to-expand (`nd-hint-open`, one delegated toggle on `#settingsBody`); the chain limits (≤200 chars, ≤4 segments, empty-segment rejection, `#{4}` escape) stay server-enforced and are documented only in README (owner-approved 2026-09-09).
- Mobile ≤520px settings controls reduced (owner-approved 2026-09-09): panel-head ~29px (close button 28px), group-title ~30px, chips 12px font, color-input 30px, add/clear/delete/add-group buttons 26-27px.
- Search results pager keeps the listing pager's look (owner 2026-09-11): `上一页` + numbered window `[current..current+3]` clamped to the known local page count + `下一页`, rendered as the same `<a class="page">` links as the listing pager — never disabled (`上一页` on page 1 points to page 1, `下一页` points to page+1) — plus the jump form. All controls page locally without network requests (capped rendered results; hrefs are the no-JS fallback, preventDefaulted by the delegated handler); clicking regenerates the navs via `innerHTML`, so the delegated click handler re-focuses the corresponding control (prev/next/current page link) to preserve keyboard page-walking. The former `N / M` indicator span is gone by design.

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

本地 QA 铁律（owner 2026-09-06，必须遵守，违者整轮验证会被用户感知为"卡死"）：

- **禁止在 shell 工具里以任何分离式方式自行拉起 `wrangler dev`**（典型违规写法：`Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm run dev" -WindowStyle Hidden -PassThru -RedirectStandardOutput/-RedirectStandardError`，即后台隐藏窗口 + 重定向输出那套）：该模式会让工具会话假死，每次都要 owner 手动 abort（owner 2026-09-12 明令禁止再犯）。正确做法：先 `netstat -ano | findstr :8787` 探端口、`curl.exe --max-time 5 http://127.0.0.1:8787/health` 探活；已有存活 server 直接复用，没有则请 owner 在自己的终端手动启动 `npm run dev`，agent 只轮询 `/health` 等就绪。
- `wrangler dev` 冷启动**禁止固定 sleep 盲等**（曾固定等 12s，连续多轮被投诉卡住）：启动后轮询 `/health` 直到 HTTP 200 再发后续请求。
- server 就绪后**跨验证轮次复用**，禁止每轮验证杀掉重启。
- 仅验证 CSS/标记增量时，**优先对已抓取页面做字符串补丁后 file:// 测量**，完全不碰 server；仅当 CSS 规则本身变化且无法安全补丁时才重启。
- 浏览器级调试必须使用 Playwright 无头浏览器（已安装：Chromium 优先，Firefox 备用）；调试手机相关问题时视口固定 `412×915`（owner 2026-09-09）。Playwright MCP 的 chrome 渠道缺 `chrome.exe` 不可用时的退路：node 直跑 npx 缓存里的 `playwright-core`，`chromium.launch({ executablePath: '%LOCALAPPDATA%\ms-playwright\chromium-1243\chrome-win64\chrome.exe' })`——headless-shell 变体未安装，必须显式指定全量 chromium 的 executablePath。

## DEPLOY AND CONFIG

- `npm run deploy` runs the generator, applies remote migrations, verifies D1 (five tables: `posts`, `users`, `sync_state`, `app_settings`, `admin_sessions`), dry-runs deployment, then deploys with `wrangler.generated.jsonc`.
- All deployments use Worker/D1 `nodeseek-rss-reader`; per-branch environment isolation comes from separate Cloudflare accounts, not branch logic. `WORKER_NAME` / `D1_DATABASE_NAME` env vars override these names.
- Cloudflare Workers Builds injects only `WORKERS_CI_BRANCH` (never `CF_PAGES_BRANCH`/`CF_BRANCH`/`GITHUB_REF_NAME`/`BRANCH`); the old env-var chain therefore never fired in CF builds — root cause of the factory incidents. The script is intentionally branch-agnostic; do not reintroduce branch detection.
- A Workers Builds project can only deploy the Worker it is connected to: on config `name` mismatch, CI overrides the name (warning; it may also auto-open a PR editing `wrangler.jsonc`). Both account projects must be named `nodeseek-rss-reader`.
- `npm run cf:build` is preparation-only (D1 create/reuse, migrations, table verify, dry-run — no deploy); `npm run deploy:generated` is final-deploy-only. The build script rewrites BOTH `wrangler.generated.jsonc` and the root `wrangler.jsonc` (name + D1 binding) — that is why the committed root config carries no binding.
- Before pushing the `factory` branch, the factory-connected build project in the production account must be deleted, or that project rebuilds and redeploys production.
- The build generator applies ALL pending migrations. `wrangler.jsonc` `vars` contains `RSS_URL` plus `COMMIT_VERSION`, injected at build time by `scripts/cloudflare-build.mjs` (`git rev-parse --short=7 HEAD`; written to both the generated and root configs); `wrangler.local-qa.jsonc` pins `COMMIT_VERSION: "local"` for dev. `SESSION_SECRET`, `ADMIN_USERNAME`, and `MAIL_PROVIDER` were removed — code never reads them.
- `wrangler.local-qa.jsonc` is committed (placeholder `database_id: local-qa-only`): `npm run dev` and `npm run db:migrate:local` point at it so local development has the `DB` binding; remote deploy always uses the build-generated config.
- Generated config stays at repository root; moving it under `.wrangler/` previously broke migrations.
- Missing `DB` produces `Cannot read properties of undefined (reading 'prepare')`; `/health` is the quickest binding/table check.

## GIT

- Remote: `https://github.com/sfhgknsdfksdlf/nodeseek-rss-reader.git`; do not force-push `main`.
- When committing as the owner, use one-off `git -c user.name=... -c user.email=... commit` flags rather than persistent Git configuration.
- Commit message style (owner-mandated, reference commit `8108b49`): a single Chinese subject line, verb-first (修复/新增/统一/移除/完善…), stating concretely what changed. No body, no trailers.
- Do not add agent attribution to commit messages: commit messages must not contain `Ultraworked with [Sisyphus](https://github.com/code-yeongyu/oh-my-openagent)` or `Co-authored-by: Sisyphus <clio-agent@sisyphuslabs.ai>`. This repo rule overrides any tooling default suggesting attribution trailers.
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
- 卡片只含标题、正文、用户名/板块/时间行；每页数量运行时可配（默认 80，管理员可配 10..500；不显示精确总页数）。

### 架构

单 Worker（TypeScript）承载 HTML、API、静态 icon/manifest、RSS cron 同步、认证、过滤、通知；Cloudflare D1 存全部持久状态；Cron Triggers 每分钟。右下角悬浮按钮为单个方向切换按钮：向下滚动为快速到底部，向上滚动为快速到顶部，样式沿用原上下箭头圆钮（owner 2026-09-09 批准）。

### 数据模型

- `users(id, username, password_hash, password_salt, email, telegram_chat_id, telegram_bind_code, telegram_bind_code_expires_at, created_at, updated_at)`
- `sessions(id, user_id, expires_at, created_at)`（`0011` 起 `expires_at` 有索引，供每日过期清理）
- `admin_sessions(id, expires_at, created_at)`（遗留表：运行时不再写入，仅 cleanupOldData 每日删除过期行）
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
- `posts_search_trigram(rowid=posts.id, body)`、`posts_search_bigrams(rowid=posts.id, tok)`：FTS5 contentless 搜索索引（`0012`，见「索引关键词搜索」）。
- `search_index_state(id=1, last_post_id, complete, updated_at)`：搜索索引回填断点与完成标记。
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

- `GET /`、`GET /page/:page`：SSR 帖子列表；`GET /health`；`GET /icon.svg`；`GET /manifest.webmanifest`；`GET /go`：后台打开中转外壳（静态、immutable 长缓存，不查库、不重定向）。
- `GET /admin?token=ADMIN_SECRET`：独立管理员页；`POST /telegram/webhook`。
- `GET /api/posts`：JSON 帖子列表。
- `POST /api/auth/register|login|logout`；`GET /api/me`；`PUT /api/me/email`；`PUT /api/me/telegram`；`GET /api/account`；`GET /api/notification-settings`；`POST /api/read-state`。
- 高亮：`GET|POST /api/highlight-groups`、`PUT|DELETE /api/highlight-groups/:id`、`POST /api/highlight-groups/:id/clear`。
- 屏蔽：`GET|POST /api/block-rules`、`POST /api/block-rules/clear`、`DELETE /api/block-rules/:id`。
- 订阅：`GET|POST /api/subscriptions`、`POST /api/subscriptions/clear`、`DELETE /api/subscriptions/:id`。
- 导出：`GET /api/export/highlights|blocks|subscriptions`。
- 导入：`POST /api/import/highlights|blocks|subscriptions`。
- 诊断：`GET /api/rss-test`、`GET /api/debug/status?token=ADMIN_SECRET`（非 `live=1` 不做实抓）；debug 另含 `searchIndex.building`/`searchIndex.lastError`（索引构建状态与最近错误）、`storage`（`sizeBytes`/`limitBytes`/`targetBytes`/`active`/`deletedToday`/`lastPruneAt`/`lastPruneError`）与 `timings.storageMs`。
- 管理：`GET|PUT /api/admin/settings`、`GET /api/admin/users`、`DELETE /api/admin/users/:id`。
- 卡片经根相对 `/go?v=2#p=<id>&u=<原帖链接>` 中转外壳在新标签打开原帖，已读回执走 `POST /api/read-state`（2026-09-06 owner 批准；外壳纯客户端，服务端不做重定向，见「后台打开标红 /go 中转」）。

### RSS 抓取与失败诊断

- 生产同步：随机 `A ∈ [21,24]` 秒等待 → 抓 `rss` 策略；失败再随机 `B ∈ [21,24]` 秒等待 → 抓 `browser` 策略。
- `/api/rss-test` 同序（`rss` → `browser`）但不等待，便于手动诊断。
- 抓取尝试只记录失败：`rss_fetch_attempts` 仅在尝试失败时结构化写入（`rss`/`browser` 两种策略、cron 与 rss-test 两个来源、HTTP 失败与异常均覆盖，字段语义不变）；成功尝试（cron 与 rss-test，含 RSS 失败后 browser 重试成功）一律不写库。过期记录由每日 `cleanupOldData` 按滚动 24 小时 cutoff 清理；清理使用 `last_cleanup_at` 做尽力而为的每日节流（无锁重叠可能重复清理，物理记录最长可能保留约 48 小时），attempt/debug 路径只读；`live=1` 诊断失败写入仍是唯一诊断写操作；遗留 `rss_fetch_failures` 不再读取。
- 诊断口径为 failures-only：`getRssAttemptDiagnostics` 载荷顶层带 `collectionMode: "failures-only"`、`statsScope: "latest-200-failures-within-24h"`、`sampleLimit: 200` 元数据（`/api/debug/status` 的 `rss` 对象同步透出）；`totalAttempts`、`bySource`、`byResult`、`byStatus`、`attemptStats` 等既有数字字段只统计返回的失败样本，不得删除任何既有数字字段名；`attemptStats` 中 `success: 0` 表示「当前失败样本中没有成功行」，不代表实际成功为零；`recentSamples` 为最近 20 条失败。
- `GET /api/debug/status?token=ADMIN_SECRET` 含后端计时与 `rss.attemptStats`（`cron.success/failure`、`rssTest.success/failure`），保留原始 `rss.results` 与 `rss.failureSummary`。
- `/api/debug/status` 另含结构化 `cronTiming`：最新一次 cron 的 `timings.rssSync`、`timings.processSubscriptionsMs`、`timings.cleanupOldDataMs`、`timings.totalMs` 分解。
- cron 计时快照自 scheduled 路径异步捕获，不阻塞正常 cron；debug 载荷不改动既有 RSS 诊断字段。

### 首页计时与扫描（当前行为）

- 普通 `/`、`/page/:page` 请求记录 auth、post query、admin status、render 服务端计时；cron 记录 rssSync、订阅、清理分解计时。block/highlight 规则完全在浏览器执行，服务端不再记录 block/highlight 计时字段。
- 计时快照经 `ctx.waitUntil()` 异步写入 `sync_state.last_home_timing`，不延迟页面响应。
- `page=N` URL 与 pager UI 不变。
- 搜索已改为索引关键词匹配：结果按 `search_result_limit` 封顶一次性返回，浏览器按 `page_size` 本地翻页（2026-09-10，见「索引关键词搜索」）。
- Worker 端扫描内部使用 `published_at DESC, id DESC` keyset 游标；SQL 快路径同序稳定分页。
- `migrations/0008_posts_keyset_indexes.sql` 提供 `(published_at DESC, id DESC)` 与 `(board_key, published_at DESC, id DESC)` 索引。

### UI 规则

- 黑白视觉语言，圆润控件与卡片。
- 蓝色用于主操作/当前页；红色用于删除按钮；已读标记为仅标题紫红 `#ac0079`（2026-09-09 修订，见下）。
- `prefers-color-scheme: dark` 使用 OLED `#000`（页面、卡片、对话框、控件）。
- 搜索与分页在小屏保持一行。
- 卡片只显示标题、正文、三列用户名/板块/时间行。
- 点击用户名/时间均复制到剪贴板并弹一行 toast，不打开帖子；时间按钮内保留 `<time datetime>`（ISO 8601）机器可读语义（owner 2026-09-06）。
- 用户名/时间芯片增高采用「垂直 padding 增量 + 等量负上下 margin」补偿，保持按钮中心到卡片边框距离不变（owner 2026-09-06）；调整 padding 必须同步负 margin（基础档 `padding:.35rem .28rem;margin:-.25rem 0`，移动端 `padding:.3rem .22rem;margin:-.24rem 0`）。
- 移动端（≤520px）品牌字号压缩为 `clamp(15px,4.2vw,18px)` 且 `white-space:nowrap` 永不折行；登录态用户名 span 手机端可见（`hide-sm` 已移除），`.auth` 与 `.auth>span` 的 `min-width:0` 构成收缩链——头部挤压全部由 span 吸收、自动省略号，全局上限 200px，按钮 `min-width:auto` 永不被压碎（owner 2026-09-06）。
- 首页品牌后显示构建 commit 短版本号：生产构建由 `scripts/cloudflare-build.mjs` 通过 `git rev-parse --short=7 HEAD` 注入 `COMMIT_VERSION`，缺失时显示 `local`；桌面端与品牌同行，≤520px 手机端换到品牌下方，不新增路由、存储或依赖。
- 点击卡片在新标签打开原帖并标记已读；已读标记为仅标题紫红 `#ac0079`，正文与灰色行保持原色（2026-09-09 修订；此前整卡继承红色，owner 确认仅标题变色）。中键/长按“后台打开”经 `/go` 中转外壳同样标记已读（见「后台打开标红 /go 中转」）。
- 正文图片 markdown 与 image 标签渲染为响应式图片。
- 帖子卡片标题与正文 `word-break:break-all`：填满行内容宽度再换行（owner 2026-09-06 批准；避免示例中 `aaaaaaaaaa-` 未满行即提前换行，接受英文行尾按字符断词，中文逐字换行不受影响）。

### 后台打开标红 /go 中转（2026-09-06 owner 批准）

**需求**：中键点击、手机长按菜单“后台打开”帖子时，列表页也要标红。此前只有左键 `click` 触发回执：中键触发 `auxclick`、上下文菜单路径不产生任何页面事件，均无法标记；浏览器对“上下文菜单选了后台打开”没有任何可用信号，精确覆盖只能让打开动作本身经过本站。

**设计**：
- 卡片 `.card-overlay` 与 `.title-link` 的 href 改为根相对 `/go?v=1#p=<post id>&u=<encodeURIComponent(safeHttpUrl(post.link))>`，保留 `target="_blank" rel="noreferrer"`。`?v=` 是外壳缓存版本号（查询串参与 HTTP 缓存键，运行时不读），改外壳逻辑时递增以整体失效旧缓存；帖子参数放 fragment——fragment 不发给服务器、不参与缓存键，所以所有帖子共用同一份外壳缓存条目，每帖打开不再各存一份、也不多打 Worker 请求。
- 多域名：根相对链接由浏览器解析到当前域名（A/B/C/D/E…各自生成各自的 `/go` 链接），无需任何检测逻辑；会话 Cookie 按域名隔离，回执跟随当前域名登录态（匿名仍 localStorage）。
- `GET /go` 返回静态外壳 HTML（约 1KB，`Cache-Control: public, max-age=31536000, immutable`），对所有帖子/域名同一份内容；浏览器 HTTP 缓存每域名每版本只存一份（~1KB），每个版本只发生一次外壳 Worker 请求。服务端不查库、不做重定向；路由放在 DB 缺失检查之前，无 DB 也可用。
- 外壳脚本（纯客户端，顺序固定）：1) `new URL(u).hostname` 必须匹配 `nodeseek.com` 及其子域（防开放重定向/钓鱼，失败显示“链接无效”并不跳转）；2) `BroadcastChannel('nd-read').postMessage({postId})` 通知同源已打开的列表页，列表页监听后本地标红并按自身作用域写 localStorage（外壳不知道登录态，不写作用域键）；3) `keepalive fetch POST /api/read-state {postId}` 发已读回执（登录入库，匿名 401 静默）；4) `location.replace(u)` 跳原帖（`replace` 让外壳不留在该标签的历史记录里，后退行为与原直链一致），外壳带 `<meta name="referrer" content="no-referrer">` 保持原 noreferrer 隐私行为。
- 左键 `click` 的既有 `markRead`（即时标红 + localStorage + POST 回执）保留；与外壳回执幂等（`INSERT OR REPLACE`），双路径重复上报无害。
- 取舍：打开帖子多一跳（首次约几十 ms，之后外壳走磁盘缓存近零）；复制的链接是 `/go` 形态（仍正常跳转）；不支持 BroadcastChannel 的老浏览器退化为“下次加载时按 localStorage/服务端状态标红”。
- 不新增 API、不改 schema、不引入新存储。
- 2026-09-09 修订（owner）：外壳完全静默——删除 `<title>` 与「正在打开原帖…」可见文本，成功路径 `body` 仅含脚本、无任何可见内容；新增 `<meta name="color-scheme" content="light dark">` 让空白过渡跟随系统主题（暗色不再白闪）；`<meta name="referrer" content="no-referrer">` 与脚本顺序不变；「链接无效或已过期」失败提示保留（唯一会出现可见内容的场景）；外壳缓存版本递增 `/go?v=1` → `/go?v=2`（卡片链接同步，旧版本缓存整体失效）。

### 部署

README 记录 Cloudflare Workers GitHub 集成流程：主路径无需手动建 D1、改 `database_id`、贴 SQL。用户 fork 仓库、在 Cloudflare 连接仓库、构建命令填 `npm run deploy`。

构建命令运行 `scripts/cloudflare-build.mjs`：用 Wrangler 查找名为 `nodeseek-rss-reader` 的 D1（不存在则创建）→ 生成 `wrangler.generated.jsonc`（含 `database_id`）→ 对远端库应用 D1 迁移 → 用生成配置跑 deploy dry-run 校验 → 部署。

`wrangler.jsonc` 是本地开发模板，不含手工 `database_id` 占位。若 GitHub 构建环境无足够 Wrangler 权限，README 提供备用 CLI 段（`npm run cf:build` + `npm run deploy:generated`），但主路径仍是单一构建命令。

### 管理设置

管理员用单一 Secret `ADMIN_SECRET` 认证（2026-09-06 修订：无服务端管理会话）：`/admin` 页面与每个 `/api/admin/*` 请求都直接校验 token（URL `?token=` 或 `x-admin-token` 头），`secretTokensEqual` 常量时间比较；管理页 JS 内嵌 token 调 API，UI 须提示收藏完整管理 URL。`admin_sessions` 表为遗留，运行时不再写入，仅每日清理过期行。

`ADMIN_SECRET` 同时派生 AES-GCM 密钥用于加密 D1 设置。Brevo API Key 与 Telegram Bot Token 加密存于 `app_settings`；发件邮箱、发件人名、保留天数、`db_prune_limit_mb`、`page_size`、`search_result_limit` 明文存储。运行时通知代码先读 D1 设置，再回退环境变量。

默认保留：已读状态 7 天；推送日志 30 天；帖子只由容量裁剪删除。管理员页可配的是「数据库自动清理触发阈值（MB）」（`db_prune_limit_mb`），免费默认 480、付费默认 9850（9.85G），钳制 100..9850；清理目标免费版 450MB、付费版默认 9GB（付费触发阈值≤9000MB 时按阈值-30MB）；正常删除窗口 UTC 23:30–00:00；索引未验证（状态 0）不删帖，每个 UTC 日最多 10,000 条。管理员页另有「付费版 D1」开关（默认关闭）：免费最大容量 500MB，付费 10GB；超过套餐最大容量减 2MB 时新帖每轮最多写入 5 条。每页数量默认 80（钳制 10..500）；搜索结果上限默认 200（钳制 50..500）。计划任务经 `sync_state.last_cleanup_at` 闸门每天至多执行一次清理。

### D1 分页与浏览器端规则优化设计（原 DESIGN_D1_PAGINATION.md 全文并入）

**1. 设计范围**：约束分页、规则缓存、API、配置和安全行为；只描述已确认需求及最小实现决策。

**2. 用户已确认的原始需求**（实现不得改写语义）：
1. 不显示精确总页数。
2. 页码窗口保持现有行为，显示当前页至当前页加 3。
3. 页码按钮是占位链接，不预查目标页，点击后才请求 `page=N`。
4. 默认每页 80 条，管理员可配置每页数量。
5. 超出范围的页允许返回空页。
6. 搜索分页暂缓，保留现有服务端搜索语义；屏蔽和高亮不参与云端匹配或分页。（2026-09-10 修订：已被「索引关键词搜索」取代——搜索为字面关键词匹配，结果封顶后浏览器本地翻页；屏蔽不参与搜索、高亮仍在浏览器执行的语义未变。）
7. 屏蔽和高亮完全在浏览器端执行；普通列表应用同步的 block 规则，搜索结果不应用 block 规则；浏览器再应用高亮规则。

**3. 明确排除项**：不引入新前端框架；不引入 KV/DO/R2（状态用 D1 + 匿名用户 `localStorage`）；不新增搜索分页实现（2026-09-10 修订：搜索改走「索引关键词搜索」的封顶 + 浏览器本地翻页路径）；不为精确总页数保留无条件 `COUNT(*)`；不新增 Keyset 分页实现（保留 `page=N` 与 `OFFSET` 快路径；Worker 端搜索扫描内部的 keyset 游标属既有实现，不在排除范围内）。

**4. 现状约束与核心决策**：
- 4.1 D1 查询：普通列表删除分页用无条件 `COUNT(*)`，按 `page=N` 计算 `OFFSET` 只读所需页；block 规则不参与云端分页；越界页返回空 `posts` 数组。索引改善排序/过滤/分页读取，但不消除 `COUNT(*)` 成本；成本优化来自移除计数查询。
- 4.2 页码窗口：`[currentPage, currentPage+1, currentPage+2, currentPage+3]`，不用 `totalPages` 截断；上一页在第一页指向第一页，下一页指向当前页+1；最后一页无需在当前响应中识别。
- 4.3 搜索：`q` 服务端只匹配 `title` + `content_text`；作者与板块名不参与匹配，板块下拉是独立结构化筛选；搜索分页迁移暂缓；搜索结果页不应用 block 规则，普通列表页应用同一份同步 block 规则。（2026-09-10 修订：`q` 改为字面关键词 FTS5 匹配，新增结果封顶与浏览器本地翻页，见「索引关键词搜索」；匹配范围 title+正文、作者/板块不参与、搜索页不应用 block 规则的语义未变。）

**5. 数据流**：
- 5.1 SSR 首页：解析用户/`page`/`board`/`q` + 运行时 `page_size` → 按发布时间稳定排序读当前页（无云端规则匹配、无分页 `COUNT(*)`）→ 仅按标题正文服务端搜索，返回规则载荷 → 无帖子仍返回正常页面 → SSR 输出内容、当前至+3 占位页码、同页规则缓存载荷或版本信息 → 浏览器先屏蔽再高亮。
- 5.2 点击页码：客户端只请求对应 `page=N`，保留 `board`、`q` 与用户上下文；响应携带目标页数据与分页状态，不依赖精确总页数；窗口继续当前页至+3。
- 5.3 规则载荷：block/highlight 属用户隔离数据；响应带版本标识，规则变化时带完整载荷；客户端确认持有相同版本时不重复发送完整规则；版本变化时先替换内存状态、先屏蔽后高亮。

**6. 页面数据与 API 契约**：
- 6.1 页面数据语义至少含 `posts`（可为空）、`page`（规范化 ≥1）、`pageSize`、`board`、`query`、规则版本与按需载荷字段；`totalPages` 非必需，不得作为渲染/翻页前置条件。
- 6.2 请求参数：`page=N`、`board=...`、`q=...`；`page` 无效规范化为 ≥1 整数；另设 `MAX_PAGE_OFFSET` 安全上限（`src/posts.ts`），把页码钳制在 OFFSET 整数安全范围内；越界有效页码返回空页不报错；分页响应须能表达当前页数据/页码/`pageSize`/规则版本与是否随响应发送，不得要求先调总数接口。

**7. 每页数量配置**：
- 7.1 `page_size` 用现有 `app_settings` D1 runtime settings 保存；未配置/不可解析回退默认 `80`，越界整数钳制到 10..500 边界（读、写路径同用 `clampPageSize`）；不新增存储类型。
- 7.2 Admin 设置页可配 `page_size`，允许 10..500 含边界；服务端必须重新解析校验，不能只依赖浏览器控件。实际实现为**钳制**：越界整数提交值收紧到 10..500 边界（非拒绝），缺失/非整数等非法值回退默认 80——两条路径均以 `clampPageSize` 为准；这是长期行为，修改前先与 owner 确认。保存后对新请求生效，当前请求用本次开始时读取的单一配置值。

**8. 规则版本、缓存与用户隔离**：缓存键必须含用户身份范围；匿名与不同登录用户不共享规则缓存；匿名继续用 localStorage 约定；登录用户状态不得被遗留的另一用户缓存采用。客户端至少维护用户范围、版本、载荷三者对应：匿名用固定匿名范围标识，登出/切换身份时清理；登录用户用稳定用户标识，不以用户名显示文本作凭据；登录/登出/版本变化时旧版本不得继续参与处理；规则更新先替换内存再处理新内容。版本检查只用于载荷收发判断，不用于授权；服务端以当前会话用户读取规则，不接受客户端提交的规则为可信来源。

**9. 浏览器处理与防闪现**：顺序固定：先 block（移除/隐藏匹配项），再对仍可见内容 highlight。首屏不能长时间以未处理状态显示；在现有 SSR/client 结构中设最小预处理状态，规则准备与 block 先完成再进入高亮。正则必须继续通过现有安全检查与编译路径；不得使用未校验动态正则，不得因客户端缓存跳过服务端安全约束。

**10. XSS 与安全约束**：帖子标题/正文/用户名/板块/链接与规则相关文本继续走现有 HTML 转义或安全 HTML 路径；`href`、`data-*` 属性值必须属性转义，外部帖子链接保持 `<a target="_blank">` 新标签打开行为（2026-09-06 owner 批准改为经根相对 `/go` 中转外壳，见「后台打开标红 /go 中转」；中转仅承载跳转与已读回执，不承载授权，服务端不做重定向）；规则文本不是 HTML，不得直接拼接进标记，嵌入的规则载荷必须安全结构化编码传输、客户端解析后作数据使用；服务端会话与用户身份决定可读规则范围，localStorage 只能作为对应用户范围的缓存，不能成为跨用户授权机制；page size、page number 等查询参数必须服务端校验。

**11. 回滚设计**：实现保持可逆——分页查询、页面数据、SSR pager、客户端分页请求、规则载荷处理、page size 读取保持模块边界清晰；无总数分页出问题可临时恢复旧分页渲染与计数逻辑（不得描述为目标设计）；规则版本或防闪现出问题优先关闭客户端增量规则缓存路径，回退同页发送完整规则并保持“先屏蔽、后高亮”；Admin page_size 异常回退安全默认 80；回滚不得引入 KV 或其他存储，也不得改写已部署历史迁移。

**12. 实现验收边界**：普通首页、匿名用户、登录用户、board 筛选、有效与越界 `page=N`、read state、Admin 10..500 page size 校验、无精确总页数查询、页码点击后才请求、当前至+3 窗口、规则版本变化、用户隔离、登出清理、“先屏蔽、后高亮”顺序。

### 规则 #### 链式分段 AND 匹配（2026-09-07 owner 批准）

**需求**：高亮、屏蔽、订阅三类规则统一支持把一条规则按字面 `####` 分隔为最多 4 段正则；各段在同一段文本（haystack）上全部命中才生效；链式高亮命中后标记所有命中分段。旧单段规则完全兼容；搜索 `q` 当时保持单段正则不受影响（2026-09-10 修订：已改为字面关键词搜索，见「索引关键词搜索」）。

**语义**：
- 解析：整条规则先去首尾空白，再按字面 4 连井号 `####` 切分；额外井号留在相邻段（`a#####b` → 段 `a` + `#b`；`a######b` → `a` + `##b`）；不含 `####` 即单段。
- 限制：整条 trim 后长度 ≤200（含分隔符与段内空格）；空段/全空白段拒绝；超过 4 段拒绝。
- 空格：分隔符两侧空格保留在相邻段内容内并参与匹配（`Alpha #### Beta` 的两段是 `Alpha ` 与 ` Beta`）。
- 存储：存整体 trim 后的原始字符串（含 `####` 与段内空格），不存分段；解析仅发生在校验与匹配时，无 schema 变更。
- 匹配：每段经 `safeRegex`（flag "i"、每段 ≤200、ReDoS-hazard 防护）编译后，对同一完整 haystack 做 AND（`every` 失败短路、不要求位置顺序）。haystack 维持各自现状：屏蔽 = 标题+正文+作者（`postTextForBlock`），高亮 = 标题+正文，订阅 = 标题+正文+作者+板块。
- 高亮：规则命中后按逐段匹配信息把每个命中分段都标记出来（零宽匹配该段不产生标记但不影响命中判定）。
- 字面井号：要匹配连续井号本身用 `#{4}`（量词写法，字符串内无 4 连井号，不触发切分）。

**核心与镜像**：核心导出于 `src/filters.ts`（`parseChainedRule`/`compileChainedRule`/`matchChainedRule`/`extractChainedRuleMatches`），纯函数、零依赖（仅 String/RegExp/Array 原语），保证服务端与浏览器副本可镜像且行为一致。服务端订阅匹配（`src/subscriptions.ts`）每 cron 每订阅预编译一次（不逐帖编译），编译失败的存量 pattern 静默跳过、不中断 cron（与旧 `safeRegex` 过滤语义一致）；浏览器嵌入脚本（`src/render.ts`）镜像同一语义（`clientRegex` 保留同样的 200/防护/try-catch 语义）。

**校验**：三类导入（`/api/import/highlights|blocks|subscriptions`）与三个单项写入端点（highlight PUT、block POST、subscription POST）共用链式感知的 `validatePatternInput` 门，任何错误在 D1 调用之前返回；导入错误保留 field/index 结构化细节；导入保持 all-or-nothing。

**兼容与例外**：不含 `####` 的规则行为与旧版完全一致（单段）；历史存量含 `####` 的规则在匹配时按新语义解释（owner 认可的语义变更，含行为改变的可能：如字符类切分后编译失败则规则惰性）；搜索 `q`（`src/posts.ts`）始终不做链式解析（2026-09-10 修订：已由单段正则改为字面关键词搜索，见「索引关键词搜索」）。

**排除项**：不改 schema/迁移；不改 API 路径与响应形状；不新增依赖或存储；不改规则顺序匹配语义（订阅加载器仍 `ORDER BY s.id DESC`）；不改 rulesVersion 摘要契约（pattern 仍为整串存储，载荷形状不变）。

### 索引关键词搜索（2026-09-10 实现并入，commit da86244；结果翻页 UI 2026-09-11 owner 修订见 UI AND ADMIN）

**需求**：搜索从服务端正则扫描升级为字面关键词匹配：D1 FTS5 索引（标题+正文）支撑，历史帖子索引由 cron 渐进回填、无需手动 SQL；结果封顶，浏览器本地翻页。

**语义**：
- `q` 是字面关键词，不是正则：trim → 按空白拆分最多 10 个词（去重，ASCII A-Z 折叠小写，其余字符精确匹配）；整条 ≤200 字符；至少一个 ≥2 字符（codepoint）的词，否则作为 `PageData.searchError` 返回提示（SSR 渲染 `role="alert"` 的 `.search-status`）。
- 锚定词：优先最长 ≥3 字符词（同长取输入靠前），无则取第一个 2 字符词；trigram 表用词原文 FTS 短语，bigram 表用该词首 bigram token；每条结果必含锚定词；1 字符词不参与锚定、只能参与命中计数（`instr(lower(...))` 路径）。
- 排序：命中词数降序 → `published_at DESC` → `id DESC`；板块筛选仍是结构化 `board_key` 谓词。
- 结果上限：运行时 `search_result_limit`（默认 200，钳制 50..500，缺失/非整数回退 200）；封顶结果一次性渲染，浏览器按 `page_size` 本地翻页，翻页零网络请求；搜索结果不应用 block 规则，高亮规则与搜索词字面 mark 标记仍生效。

**存储与运行时**：
- `0012` 三对象：`posts_search_trigram`（`tokenize='trigram'`、`content=''`、`contentless_delete=1`、rowid=posts.id）、`posts_search_bigrams`（同 contentless，`tok` 为定长十六进制相邻码点 bigram 空格串）、`search_index_state`（id=1 单行：last_post_id/complete/updated_at）。
- 核心在 `src/search.ts`（`parseSearchQuery`/`ftsPhrase`/`indexPostForSearch`/`backfillSearchIndexes`）；FTS 短语一律绑定参数，绝不拼接 SQL（`ftsPhrase` 负责双引号转义）。
- 新帖：`syncRss` 插入成功后立即索引（四语句批：删旧两行 + 插新两行）；失败非致命——记 `sync_state.last_search_index_error`（≤500 字符）并置 `complete=0` 等待重试。
- 回填：cron 经 `ctx.waitUntil(backfillSearchIndexes)`，每分钟 ≤25 帖（`SEARCH_BACKFILL_BATCH=25`），按 id 断点续跑，断点状态与索引语句同一 D1 batch 原子更新；无剩余时置 `complete=1`。构建未完成时搜索仅覆盖已索引帖子，页面显示「历史搜索索引仍在构建中」。
- 清理：`cleanup.ts` 删过期帖前按 100 id 一批先删两 FTS 表对应行，再删 posts。
- 诊断：`/api/debug/status` 增加 `searchIndex.building`（`complete!==1` 即 true）与 `searchIndex.lastError`；搜索计时 `searchParseMs`/`searchQueryMs` 记入 `home.timings.queryPosts`（原 `searchRegexCompileMs`/`searchMatchMs`/`scanMs` 等字段已移除）。

**排除项**：不新增路由/依赖/存储；普通列表 pager（`page=N` 链接）不变；已读、`/go` 中转、规则契约不变。

### D1 容量自动裁剪（2026-11-20 owner 批准；2026-11-21 修订）

**需求**：免费版 D1 单库上限 500MB。管理员可设置「付费版 D1」开关（默认关闭）；免费最大容量 500MB，付费 10GB。数据库达到「数据库自动清理触发阈值」后自动删除最旧帖子，免费版清理到 450MB、付费版清理到 9GB；正常删除窗口 UTC 23:30–00:00；索引验证前不删帖，每个 UTC 日最多 10,000 条；免费默认触发 480MB，付费默认 9850MB（9.85G）。

- 触发阈值可在管理员页调整，clamp 100..9850；未显式保存时按当前套餐默认（免费 480 / 付费 9850）；目标免费 450MB / 付费 9000MB（付费触发阈值≤9000MB 时按阈值-30MB）；正常删除窗口 UTC 23:30–00:00。
- 历史显式 `"450"` 在读取时按 480 生效（无需迁移）；管理员重新保存 450 会写入 `"450.0"`，仍按 450 生效；缺省 key 直接使用套餐默认。0014 是 ledger-only/no-op 迁移：部署不会在已有生产库上预建索引；cron 状态机在首个 UTC 23:30–00:00 窗口执行幂等 DDL 并用 `sqlite_schema` + `PRAGMA index_info` 独立验证后才进入状态 `"2"`。
- 5 帖限流：`size > 套餐最大容量 - 2MB`（免费 498MB，付费 9998MB）时，每次同步最多写入 5 条新帖；否则按原 feed 窗口（当前 20 条）。绝不设 0，也不设 420-450 档。

**0014 索引状态机（0/1/2）**：`sync_state.db_prune_index_state` 只存精确文本 `"0"`/`"1"`/`"2"`；缺行按 `"0"`，非法值原样保留并记录配置错误（正常 RSS、禁止 DDL 与裁剪）。
- `"0"` 未验证：先正常 RSS；窗口内、当前同步及对应订阅完成后，用 `key + value="0" + 观测到的 updated_at` 条件更新（或缺失行插入）原子领取 `"1"`，只有一个调用成功；过期读者不能覆盖更新的失败标记。领取后再次确认仍在窗口才执行幂等 `CREATE INDEX IF NOT EXISTS idx_read_states_post_id ON read_states(post_id)`。
- `"1"` 建索引/恢复：只允许状态读写、0014、独立验证和必要错误日志；跳过 RSS/订阅/裁剪/保留清理/FTS 孤儿/搜索回填/非必要诊断写入，HTTP 不关闭。DDL 后从主库验证 `sqlite_schema`（恰好一条 `type='index'`、`tbl_name='read_states'`、普通非唯一非部分定义）和 `PRAGMA index_info`（恰好 `seqno=0`/`name='post_id'`）；通过且条件写 `"2"` 成功才放行裁剪。
- `"2"` 终态：绝不再次触发 0014；只有窗口、索引有效、容量和日额度都满足时才裁剪；索引丢失/变形时记录异常并停止裁剪，不自动重建。
- 失败/超时/验证失败：条件写回 `"0"`（用该行 `updated_at` 标记失败窗口，本窗口后续分钟只同步不重试），恢复 RSS，零裁剪。崩溃在写 `"1"` 后：下一调用先验证，不执行 DDL；有效则条件写 `"2"`，无效且已过平台最长存活期则写回 `"0"`。00:00Z 后不发新裁剪批次；23:59 启动的索引可在 00:00 后验证。

**大小探测**：cron 每次执行 `SELECT 1` 并读取 `D1Result.meta.size_after`（字节）；不使用 `PRAGMA page_count`/`dbstat`（D1 白名单外），也不调用 Cloudflare REST API/Token；缺失或非有限数时跳过本轮。

**正常路径**：四语句 `env.DB.batch()`（`read_states` → `posts_search_trigram` → `posts_search_bigrams` → `posts`），按 `published_at ASC, id ASC`，24h 双护栏，每轮最多 5 批/500 帖；每个 UTC 日最多 10,000 帖；计数只按 `posts` 的实际数字 `meta.changes` 结算；`changes` 缺失或非数字视为未知并保留配额预留。状态键初始化失败时本轮零删除；满库回退与 1 行降级都必须先过同一道窗口/索引/日额度门槛。

**满库路径**：batch 因 `Exceeded maximum DB size` 回滚时，不再重跑含 FTS 的 batch；对同一批 ID 用单语句先 `read_states`、再 `posts` 释放正文空间，FTS 行暂留孤儿。`read_states` 删除失败只记录错误、不阻止后续 `posts` 删除。只有 `Exceeded maximum DB size` 的 100 行单语句 `posts` 删除失败才进入 1 行降级；非容量错误视为未知并保留配额预留、结束本轮（不降级）。wall 路径在 `read_states` 与 `posts` 两次独立删除前分别复查窗口；窗口关闭时 posts 未提交的配额可退，已提交的写入保留。降级时对同批前 10 个 ID 逐条重试（每个 ID 最多 `read_states` + `posts` 两条语句，共 ≤20 条删除），`changes === 1` 计入确认删除、`changes === 0` 计入可退款，缺失或非数字 `changes` 视为未确认并停止后续尝试，`posts` 抛错即记录首个错误并停止，确认未删（`changes===0`）与因窗口/查询关闭或 10-ID 降级上限而未尝试的 ID 退还 post 配额，只有已提交但结果未知的 ID 保持预留，退款失败只记日志且不覆盖原始满库错误；无论成功几条都设置 `db_prune_blocked_full=1` 并立即结束本轮。100 行删除返回数字（含 37/100 或 0 的部分删除）时不降级，按已知数量退款。无法确认的删除保留保守计数并设置 `db_prune_blocked_full=1`。下一 UTC 日重置；状态键初始化失败时本轮零删除。`blocked_full=1` 不再暂停容量裁剪：`size >= 触发阈值` 时窗口内下一分钟照常重试初始化、候选查询与删除（保留原 `last_error` 作为基础诊断），该标记只作为诊断与 FTS 孤儿清理的闸门；仅当 `size < 触发阈值` 时清除。

**FTS 孤儿清理**：不 DROP 表、不建 JSON 队列。游标键 `db_prune_fts_trigram_cursor`、`db_prune_fts_bigram_cursor`；每张表每轮 `rowid > cursor LIMIT 25`，只删除 `rowid NOT IN (SELECT id FROM posts WHERE id IN (...))` 的行；游标到末尾归零。仅当 `sizeBytes < 触发阈值` 且未 `blocked_full` 时运行，放在 cron `waitUntil`，在同步/清理之后、搜索回填之前；搜索内连接 `posts`，孤儿不显示。

**计数**：`db_prune_deleted_today` 只按实际 `posts` changes 结算；`"1100.0"` 规范为 `"1100"` 并视为已用；不按 postCount 差值退款；正常失败不扣费，只有独立预留允许保守多记。

**回填**：`SEARCH_BACKFILL_BATCH=25`，只用于历史回填（读 posts → 生成索引 → 写回 FTS + `search_index_state`），不接 `syncRss` 新帖。

**执行顺序**：`scheduled` 先读状态。`"0"` 先正常 RSS 与订阅，窗口内且无失败标记时原子领取 `"1"` 后建索引/验证；`"1"` 只验证/恢复，跳过普通任务；`"2"` 先 RSS/订阅/清理，再在窗口、索引、容量、日额度满足时裁剪。同步前用 `SELECT 1` 探测大小，`size > 套餐最大容量 - 2MB` 时 `maxNewPosts=5` 传给 `safeSyncRss`。裁剪后只有在 `!active` 或 `deletedThisRun=0` 时清理 FTS 孤儿，`!active` 时回填；首页 timing 写入有独立 catch。进入 `"1"` 前必须完成本轮新帖的订阅处理。

**预算**：免费 50 queries/invocation；每个阶段都预留查询头寸（claim 16、裁剪入口 12、每批 12、降级 24、后台 14）并硬保留最终状态写+lease 释放的 4 条；头寸不足时跳过该阶段，绝不让最终 lease 释放越过 50。写入不设应用级总上限：D1 平台日写额度耗尽时只记录 Workers Logs、结束本轮、不循环/重试/休眠，等待 00:00 UTC 重置，之后仍需等到下一个 23:30–00:00 窗口才继续裁剪；日配额错误不进入满库降级路径。帖子配额只在数字 `changes` 或已知回滚时退还，`changes` 缺失/非数字或结果未知时保留预留并结束本轮。

**状态键**：`db_prune_index_state`、`db_prune_active`、`db_prune_day`、`db_prune_deleted_today`、`db_prune_last_at`、`db_prune_last_error`、`db_prune_blocked_full`、`db_prune_fts_trigram_cursor`、`db_prune_fts_bigram_cursor`、`db_prune_lease`；设置键 `db_prune_limit_mb`、`d1_paid_enabled`。

**诊断**：`/api/debug/status` 的 `storage` 增加/保留 `indexState`、`indexStateRaw`、`indexStateInvalid`、`indexDay`、`dailyCap`、`paidPlan`、`maxCapacityBytes`、`fivePostThresholdBytes`、`blockedFull`、`sizeBytes`、`limitBytes`、`targetBytes`、`active`、`deletedToday`、`lastPruneAt`、`lastPruneError`。

**配置/迁移**：`app_settings.db_prune_limit_mb`（free 默认 480 / paid 默认 9850，clamp 100..9850）、`app_settings.d1_paid_enabled`（默认 false）；目标免费 450MB / 付费 9000MB（付费触发阈值≤9000MB 时按阈值-30MB）；正常删除窗口 UTC 23:30–00:00；历史显式 `"450"` 读取时按 480 生效，管理员显式保存 450 存为 `"450.0"` 并保持 450；`0014_read_states_post_id_index` 是 ledger-only/no-op，不提供索引；索引由 `db_prune_index_state` 状态机创建并验证，不改其他 schema。

**排除项**：不 DROP/重建 FTS、不新增 JSON 孤儿队列/存储/依赖/路由、不使用 `PRAGMA page_count`/`dbstat`/REST/VACUUM（索引验证只允许 `PRAGMA index_info`/`sqlite_schema`）、不做年龄清理；帖子删除只由容量裁剪执行，与已读/推送保留互不替代。

**参考实现**：
- `cloudflare_temp_email`：`SELECT 1` 读 `meta.size_after` 与按时间/批量清理：https://github.com/dreamhunter2333/cloudflare_temp_email/blob/main/worker/src/admin_api/db_api.ts#L270-L276
- `codegraph` telemetry-worker：按保留期有界批量清理，README 记录满库后删除/读取仍可用：https://github.com/colbymchenry/codegraph/blob/main/telemetry-worker/src/rollup.ts#L390-L404
- Cloudflare D1 limits/batch/return metadata 与 SQLite FTS5 `contentless_delete` 文档（见上文实现说明）。
