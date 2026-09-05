# PROJECT KNOWLEDGE BASE

**Generated:** 2026-09-05
**Commit:** a08c5b7
**Branch:** 0905

## OVERVIEW

Cloudflare Workers + D1 application serving only `https://rss.nodeseek.com/` as an RSS reader. The Worker owns SSR pages, API routing, cron RSS synchronization, authentication, per-user rules, subscriptions, notifications, and diagnostics.

## STRUCTURE

```text
./
├── src/                    # Worker routes and application modules
├── migrations/             # Sequential D1 schema migrations
├── scripts/                # Cloudflare build/deploy config generation
├── public/                 # PWA icon.svg + manifest.webmanifest (only static assets; app renders via Worker)
├── DESIGN_SPEC.md          # SDD requirements and approved designs
├── DESIGN_D1_PAGINATION.md # Pagination/rule-cache design constraints
├── README.md               # Deployment and administrator setup
└── wrangler.jsonc          # Source Worker/D1/cron configuration
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
| Rules | `src/rules.ts` | User-isolated rule loading, SHA-256 version digest, `cacheHit` cache negotiation |
| Import validation | `src/rule-import.ts` | Shared limits, strict body parsing, structured errors for `/api/import/*` |
| Subscriptions | `src/subscriptions.ts` | Regex matching and notification dispatch |
| Notification senders | `src/notifications.ts` | Brevo/Telegram requests and GUID push logs |
| D1 cleanup | `src/cleanup.ts` | Retention for posts, reads, logs, sessions |
| Shared types | `src/types.ts` | `Env`, model, page, and timing contracts |

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| RSS/cron latency | `src/rss.ts`, `src/subscriptions.ts`, `src/cleanup.ts` | Inspect `/api/debug/status`; preserve structured timings |
| Homepage latency | `src/posts.ts`, `src/render.ts` | Preserve page size and scan behavior |
| Notification dedupe | `src/notifications.ts`, `src/subscriptions.ts`, `migrations/0009*.sql`, `migrations/0010*.sql` | Use `post_guid`, never `post_id` |
| Admin/debug routes | `src/index.ts`, `src/settings.ts` | Admin secret/session boundaries are security-sensitive |
| User rule handoff | `src/rules.ts`, `src/render.ts` | Payload/version/cache keys stay user-scoped |
| Rule import changes | `src/rule-import.ts`, `src/index.ts` | Inclusive limits: 1 MiB body, 20 groups, 5000 rules, 200-char regex; reject before any D1 call |
| Schema changes | `migrations/` | Add a numbered migration; never rewrite deployed migrations |
| Deploy config | `scripts/cloudflare-build.mjs`, `wrangler.jsonc` | Never hand-edit generated `wrangler.generated.jsonc` |

## STRICT SDD

- Design first: every requested feature requires an approved `DESIGN_SPEC.md` section before implementation.
- The design documents modules, APIs, data models, and original requirement points.
- Implement the approved design literally. Do not invent business logic, routes, storage, dependencies, or UI features.
- If requirements are ambiguous, present 2–3 interpretations and ask before implementing.
- `/spec` updates design only; `/build` or explicit approval starts implementation.

## CONVENTIONS

- TypeScript is strict/no-emit; target Workers and Web APIs, not Node-only APIs.
- D1 owns all persistent state. Do not add KV, Durable Objects, R2, or another store without an explicit request.
- RSS scope is fixed to `https://rss.nodeseek.com/`; `posts.guid` is the stable RSS identity.
- Normal post cards must link to the source URL with a real external `<a target="_blank">`; `/post/:id/open` is not the normal open path.
- Logged-in read state is D1-backed; anonymous read state is localStorage-backed.
- Rule imports are all-or-nothing: fully validate first, then replace with exactly one `env.DB.batch()` per handler; never delete before validation succeeds.
- `rulesVersion` is a SHA-256 content digest that includes row ids: any successful replacement changes it; failed imports never do. Cache-hit home payloads (`cacheHit: true`) omit rule arrays; clients reuse localStorage only on exact userId + version match.
- Keep homepage card CSS in `src/styles.ts`; preserve the rounded black/white UI and OLED pure-black dark mode.
- Listings use runtime `page_size` (default 99, saved range 10..500), `page=N` URLs, and no exact total-page calculation.

## ANTI-PATTERNS (THIS PROJECT)

- Do not skip design approval or change scope beyond it.
- Do not use `as any`, `@ts-ignore`, `@ts-expect-error`, or empty catch blocks. The empty `catch {}` blocks inside the embedded browser script in `src/render.ts` are a pre-existing guarded-localStorage convention; the prohibition applies to new server-side TS.
- Do not silently skip, truncate, or partially apply imported rules; reject the whole request with field/index error details.
- Never trust client `rulesVersion` as authoritative; the server always computes the current digest.
- Do not rewrite deployed migrations. Add sequential files instead.
- Do not use `push_logs.post_id`; the final schema and dedupe paths use `push_logs.post_guid` exclusively.
- Do not confuse `read_states.post_id` with notification-log identity.
- Do not commit local reference artifacts such as `nodeseek.js` or `rss.nodeseek.com.har` unless requested.

## DATA AND MIGRATIONS

- Current chain is `0001_initial` through `0010_rebuild_push_logs_without_post_id`.
- `0009` moved push idempotency to `post_guid`; `0010` removed legacy `push_logs.post_id`, its FK, unique constraint, and index.
- `0008_posts_keyset_indexes` supports `(published_at DESC, id DESC)` and `(board_key, published_at DESC, id DESC)` scans.
- Push logs retain GUIDs independently of post retention; do not add an FK from `post_guid` to `posts.guid`.
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
- Branch `factory` maps to Worker/D1 `nodeseek-rss-reader-factory`; all other branches use `nodeseek-rss-reader`. `WORKER_NAME` / `D1_DATABASE_NAME` env vars override these names.
- The build generator applies ALL pending migrations (not just `0001` as stale README wording suggests).
- Generated config stays at repository root; moving it under `.wrangler/` previously broke migrations.
- Missing `DB` produces `Cannot read properties of undefined (reading 'prepare')`; `/health` is the quickest binding/table check.

## GIT

- Remote: `https://github.com/sfhgknsdfksdlf/nodeseek-rss-reader.git`; do not force-push `main`.
- When committing as the owner, use one-off `git -c user.name=... -c user.email=... commit` flags rather than persistent Git configuration.
