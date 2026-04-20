# NodeSeek RSS Architect



> Tiny README touch to trigger a fresh Cloudflare build.

A Cloudflare Workers + D1 reading site built from scratch for the single RSS source `https://rss.nodeseek.com/`.

## Goals

- Single-source NodeSeek RSS reader, no legacy project reuse.
- Fully responsive for phone / tablet / desktop / macOS browsers.
- Black / white rounded visual style with automatic light / dark theme.
- OLED pure black in dark mode.
- Per-user login, read progress sync, highlight rules, mute rules, regex search, keyword subscriptions.
- Email + Telegram notifications.
- Cloudflare Workers + D1 only on the Cloudflare side, deployable from GitHub.

## Stack

- Cloudflare Workers
- Hono
- D1
- fast-xml-parser
- Plain SSR HTML + small client-side enhancement script

## Free-tier Cloudflare footprint

- Workers: free tier supported
- D1: free tier supported
- Cron Triggers: free tier supported for 1-minute polling
- No paid Cloudflare products are required by this project

> Note: Telegram notification itself is free. Email delivery requires an outbound provider API key; the implementation ships with Resend API support because it has a free tier and simple HTTP API. If you do not configure it, email verification and email notifications remain disabled while the rest of the site still works.

---

## 1. Fork to your GitHub account

1. Create a new GitHub repository, or fork/copy this project into your own account.
2. Push all files from this directory into that repository.
3. Keep the default branch as `main`.

---

## 2. Create the Cloudflare D1 database

Open a terminal locally and run:

```bash
npm install
npx wrangler login
npx wrangler d1 create nodeseek_rss_architect
```

Cloudflare will return a `database_id`.

Open `wrangler.jsonc` and replace:

```json
"database_id": "REPLACE_WITH_YOUR_D1_DATABASE_ID"
```

with the real D1 database id.

Then apply migrations:

```bash
npm run db:migrate:remote
```

---

## 3. Deploy from GitHub in Cloudflare

This flow intentionally mirrors the convenient GitHub-connected deployment style:

1. Open Cloudflare dashboard → Workers & Pages → Create.
2. Choose **Import a repository / Continue with GitHub**.
3. Authorize GitHub if Cloudflare asks.
4. Select your repository.
5. Keep the default build settings, then deploy.
6. After the first deployment, open the Worker settings and configure the bindings and secrets below.

---

## 4. Required secrets and variables

### Required secret

```bash
npx wrangler secret put APP_SESSION_SECRET
```

Use a long random string, at least 32 characters.

### Optional Telegram secrets

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

Optional plain variable in `wrangler.jsonc`:

```json
"TELEGRAM_BOT_USERNAME": "your_bot_username"
```

### Optional email secrets

```bash
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put RESEND_FROM_EMAIL
```

Example sender:

```text
NodeSeek RSS <noreply@example.com>
```

### Optional manual ingest secret

```bash
npx wrangler secret put MANUAL_INGEST_TOKEN
```

---

## 5. Telegram bot webhook setup

After deployment, set your Telegram webhook manually:

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<your-worker-domain>/tg/webhook/<YOUR_WEBHOOK_SECRET>"}'
```

Users can then bind the bot from the website settings page.

---

## 6. Local development

```bash
npm install
npm run db:migrate:local
npm run dev
```

Then open the local Wrangler URL.

---

## 7. What the project does

- Polls `https://rss.nodeseek.com/` every minute using a cron trigger.
- On first ingest, stores every item currently exposed by the RSS feed.
- On page refresh, if the cached feed is stale, the Worker refreshes before rendering, so the browser refresh button shows the latest posts instead of requiring a homepage jump.
- Stores posts in D1.
- Supports user registration and password login.
- Supports per-user:
  - read progress
  - highlight groups with colors and regex rules
  - mute regex rules
  - subscription regex rules
  - email binding and Telegram binding
- Sends notifications for newly matched posts only.

---

## 8. Project structure

```text
nodeseek-rss-architect/
├── assets/
│   └── icon.svg
├── migrations/
│   └── 0001_initial.sql
├── src/
│   ├── auth.ts
│   ├── constants.ts
│   ├── db.ts
│   ├── index.ts
│   ├── ingest.ts
│   ├── notifications.ts
│   ├── render.ts
│   ├── rss.ts
│   ├── telegram.ts
│   ├── types.ts
│   └── utils.ts
├── package.json
├── tsconfig.json
└── wrangler.jsonc
```

---

## 9. Browser support targets

- Chrome / Chromium
- Firefox
- Safari
- macOS browsers based on the above engines
- Responsive widths for mobile, tablet, laptop, desktop

The layout uses fluid responsive CSS with constrained controls instead of device-specific fixed scaling, which is more robust than designing only for a 1080p phone baseline.
