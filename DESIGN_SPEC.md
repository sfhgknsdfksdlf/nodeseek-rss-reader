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

- `src/index.ts`: Worker entry, routing, cron handler.
- `src/types.ts`: shared environment and model types.
- `src/db.ts`: D1 helpers and SQL utilities.
- `src/auth.ts`: registration, login, logout, sessions, PBKDF2 password hashing.
- `src/rss.ts`: fetch and parse NodeSeek RSS, record structured RSS failure logs.
- `src/posts.ts`: post list query, pagination, search, block filtering, read state.
- `src/filters.ts`: regex validation, matching, highlight rendering.
- `src/subscriptions.ts`: subscription matching and deduplicated push dispatch.
- `src/notifications.ts`: Brevo and Telegram notification sending.
- `src/render.ts`: server-rendered HTML and client interaction script.
- `src/styles.ts`: responsive black/white/OLED CSS.
- `src/time.ts`: Beijing time formatting.
- `src/board.ts`: board key to Chinese display mapping.

## Data Model

- `users(id, username, password_hash, password_salt, email, telegram_chat_id, telegram_bind_code, created_at, updated_at)`
- `sessions(id, user_id, expires_at, created_at)`
- `admin_sessions(id, expires_at, created_at)`
- `app_settings(key, value, encrypted, updated_at)`
- `posts(id, guid, title, link, content_html, content_text, author, board_key, published_at, fetched_at)`
- `read_states(user_id, post_id, opened_at)`
- `highlight_groups(id, user_id, name, color, created_at, updated_at)`
- `highlight_rules(id, group_id, pattern, created_at)`
- `block_rules(id, user_id, pattern, created_at)`
- `subscriptions(id, user_id, pattern, send_email, send_telegram, created_at, updated_at)`
- `push_logs(id, user_id, subscription_id, post_id, channel, status, error, created_at)`
- `sync_state(key, value, updated_at)`
- `rss_fetch_failures(id, source, method, status, status_text, error, preview, created_at)`

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

- Production RSS sync keeps only two fetch header strategies and runs them as `rss`, then `browser` after a 7-second delay if the RSS-style request fails.
- `/api/rss-test` uses the same strategy order `rss` then `browser`, but it does not wait 7 seconds between attempts so manual diagnostics stay fast.
- RSS fetch failures are written to D1 as structured records instead of relying only on concatenated text logs.
- Failure records are retained for 24 hours and exposed in admin diagnostics.
- `GET /api/debug/status?token=ADMIN_SECRET` adds `rss.failureSummary`, which summarizes the last 24 hours of `/api/rss-test` and scheduled sync fetch failures while preserving raw `rss.results` output.

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
