# NodeSeek RSS Reader Design Spec

## Original Requirements

- Build a fresh architecture without referencing any local NodeSeek RSS Reader implementation.
- Only support `https://rss.nodeseek.com/`.
- Run on Cloudflare Workers with only free Cloudflare dependencies.
- Fetch RSS every minute; first run imports all RSS items.
- Browser refresh must show latest posts without clicking a home button.
- Provide database-backed users, reading progress sync, highlights, blocks, subscriptions, email and Telegram binding.
- Use simple username/password login with open registration.
- Email notifications use Brevo HTTPS API configured by the administrator.
- Telegram notifications use an administrator bot token; users bind their own chat.
- First sync imports posts only and does not send historical notifications.
- Responsive black/white rounded UI for phones, tablets, PC, and Mac.
- OLED dark mode using pure black page/card/settings backgrounds.
- Support Chrome, Firefox, Safari and related browser engines.
- Provide a website icon and README with GitHub-to-Cloudflare deployment steps.
- Remove the source metadata line and home button; clicking `NodeSeek RSS Reader` returns home.
- Provide search, board filtering, pagination, quick page jump, quick top/bottom buttons.
- Per-user regex highlight groups, block rules, and subscription rules with cloud sync and formatted export.
- Each page contains 50 post cards; cards contain only title, body, and username/board/time row.

## Architecture

The app is a single Cloudflare Worker written in TypeScript. It serves HTML, API routes, static icon/manifest assets, RSS cron sync, auth, filtering, and notifications. Cloudflare D1 stores all persistent data. Cloudflare Cron Triggers run every minute.

No existing local Reader code is used. The requested `workspace/nodeseek.js` quick-button shape was not present in `/opt/workspace`; the implementation uses fixed rounded top/bottom arrow buttons that can be replaced if that file is provided later.

## Modules

- `src/index.ts`: Worker entry, routing, cron handler, debug status.
- `src/types.ts`: shared environment, model, and timing types.
- `src/db.ts`: D1 helpers and SQL/cookie utilities.
- `src/auth.ts`: registration, login, logout, sessions, PBKDF2 password hashing.
- `src/rss.ts`: fetch, parse, sync, and record structured RSS fetch attempt logs.
- `src/posts.ts`: post list query, pagination, search, block filtering, read state.
- `src/filters.ts`: regex validation, matching, highlight rendering.
- `src/subscriptions.ts`: subscription matching and push dispatch.
- `src/notifications.ts`: Brevo and Telegram senders plus push logging.
- `src/cleanup.ts`: retention cleanup for posts, read states, push logs, sessions.
- `src/settings.ts`: runtime settings load/save and admin configuration.
- `src/render.ts`: server-rendered HTML shell and client interaction script.
- `src/styles.ts`: responsive black/white/OLED CSS.
- `src/time.ts`: Beijing time formatting.
- `src/board.ts`: board key to Chinese display mapping.

## Data Model

- `users(id, username, password_hash, password_salt, email, telegram_chat_id, telegram_bind_code, telegram_bind_code_expires_at, created_at, updated_at)`
- `sessions(id, user_id, expires_at, created_at)`
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
- `rss_fetch_failures(id, source, method, status, status_text, error, preview, created_at)` legacy table no longer read by diagnostics.
- `rss_fetch_attempts(id, source, method, outcome, status, status_text, error, preview, created_at)`
- `sync_state.last_home_timing` stores the latest normal home-page server timing snapshot for `/api/debug/status`.
- RSS sync checks the current feed item `guid` values against `posts.guid` in one D1 query before inserting; only truly new RSS items are inserted.
- Subscription matching consumes the in-memory list of newly discovered RSS items instead of re-reading inserted rows from D1.
- Push notification idempotency uses `push_logs.post_guid` rather than numeric `post_id` so the RSS sync path can avoid re-reading inserted rows from D1.

## API

- `GET /`, `GET /page/:page`: SSR post list.
- `GET /post/:postId/open`: mark read then redirect to source post.
- `GET /api/posts`: JSON post list.
- `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/me`.
- `PUT /api/me/email`, `PUT /api/me/telegram`.
- `GET /api/highlight-groups`, `POST /api/highlight-groups`, `PUT /api/highlight-groups/:id`, `DELETE /api/highlight-groups/:id`, `POST /api/highlight-groups/:id/clear`.
- `GET /api/block-rules`, `POST /api/block-rules`, `DELETE /api/block-rules/:id`.
- `GET /api/subscriptions`, `POST /api/subscriptions`, `DELETE /api/subscriptions/:id`.
- `GET /api/export/highlights`, `GET /api/export/blocks`, `GET /api/export/subscriptions`.
- `POST /telegram/webhook`.

## RSS Failure Diagnostics

- Production RSS sync generates random integer `A` in `[21, 24]`, sleeps `A` seconds, tries `rss`, then if it fails generates random integer `B` in `[21, 24]`, sleeps `B` seconds, and tries `browser`.
- `/api/rss-test` uses the same strategy order `rss` then `browser`, but it does not sleep so manual diagnostics stay fast.
- RSS fetch attempts, both successes and failures, are written to D1 as structured records in `rss_fetch_attempts`.
- Attempt records are retained for 24 hours and exposed in admin diagnostics; old `rss_fetch_failures` rows are ignored by new diagnostics.
- `GET /api/debug/status?token=ADMIN_SECRET` includes backend timing fields plus `rss.attemptStats` for `cron.success`, `cron.failure`, `rssTest.success`, and `rssTest.failure`, while preserving raw `rss.results` output and `rss.failureSummary`.
- `/api/debug/status` also exposes a structured `cronTiming` object that breaks down the latest cron execution into per-step durations, at minimum: `safeSyncRssMs`, `processSubscriptionsMs`, `cleanupOldDataMs`, `totalMs`, and an `updatedAt` timestamp for the snapshot.
- The cron timing snapshot is captured asynchronously from the scheduled path so normal cron execution is not blocked by diagnostics writes.
- The debug payload should keep the current RSS diagnostics unchanged and only add the cron timing breakdown as an additional top-level field.
- `/api/debug/status` does not run live RSS fetch diagnostics by default; append `live=1` to run `/api/rss-test` style fetch checks.

## Home Page Timing And Scanning

- Normal `/` and `/page/:page` requests record server-side timing for auth, post querying, block/search matching, highlight group loading, title/body highlighting, and HTML rendering.
- The latest timing snapshot is written asynchronously with `ctx.waitUntil()` to avoid delaying the page response.
- `page=N` URLs and pager UI remain unchanged.
- When search or block rules require Worker-side filtering, scanning stops after the current page is filled instead of scanning the full post table.
- Worker-side scans use keyset pagination internally with `published_at DESC, id DESC`; SQL fast paths use the same ordering for stable pagination.
- Migration `0008_posts_keyset_indexes.sql` adds `(published_at DESC, id DESC)` and `(board_key, published_at DESC, id DESC)` indexes for keyset and board-filtered scans.

## UI Rules

- Black/white visual language, rounded controls and cards.
- Blue is used for primary actions/current page; red is used for delete/opened posts.
- `prefers-color-scheme: dark` uses OLED `#000` for page, cards, dialogs, and controls.
- Search and pagination remain one line on small screens.
- Cards show title, body, and a three-column username/board/time row only.
- Username click copies to clipboard and does not open the post.
- Card click opens the original post in a new tab and marks it read; opened posts render red.
- Body image markdown and image tags render as responsive images.

## Deployment

README documents a Cloudflare Workers GitHub integration flow modeled after the referenced NodeWarden README. The main path does not require users to manually create D1 databases, edit `database_id`, or paste SQL. Users fork the repository, connect it in Cloudflare, and set the build command to `npm run deploy`.

The build command runs `scripts/cloudflare-build.mjs`, which:

- Uses Wrangler to find a D1 database named `nodeseek-rss-reader`.
- Creates that D1 database automatically if it does not exist.
- Generates `wrangler.generated.jsonc` with the discovered `database_id`.
- Applies D1 migrations to the remote database.
- Runs a Wrangler deploy dry-run against the generated config to validate the Worker bundle.

`wrangler.jsonc` remains a template for local development and does not contain a manual `database_id` placeholder. `npm run deploy` deploys with the generated config after `npm run cf:build` has prepared it. The Cloudflare GitHub UI only needs this single build command.

If Cloudflare's GitHub build environment does not grant enough Wrangler permission to create or migrate D1, README provides a fallback CLI section, but the primary documented deployment path is still the single build command.

## Admin Settings

Admin access uses a single Cloudflare Secret named `ADMIN_SECRET`. The admin enters `/admin?token=ADMIN_SECRET` to create a 7-day HttpOnly admin session. The UI must tell the admin to bookmark this URL because the session expires after 7 days.

`ADMIN_SECRET` is also used to derive an AES-GCM key for encrypted D1 settings. Brevo API Key and Telegram Bot Token are stored encrypted in `app_settings`. Mail sender, sender name, and retention-day settings are stored as normal app settings. Runtime notification code reads D1 settings first and falls back to environment variables.

Default retention settings:

- Read states: 7 days.
- RSS posts: 365 days.
- Push logs: 30 days.

The scheduled task performs cleanup at most once per day using `sync_state.last_cleanup_at`.
