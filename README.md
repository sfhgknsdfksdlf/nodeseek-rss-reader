# NodeSeek RSS Reader

运行在 Cloudflare Workers 上的 NodeSeek RSS 阅读与订阅网站，只适配 `https://rss.nodeseek.com/`。

[![Powered by Cloudflare](https://img.shields.io/badge/Powered%20by-Cloudflare-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)

## 功能

- 每分钟抓取一次 NodeSeek RSS。
- 首次运行导入当前 RSS 全部帖子，不推送历史通知。
- 浏览器刷新当前页面即可看到最新帖子。
- D1 数据库存储帖子、用户、阅读进度、规则和推送日志。
- 开放注册，用户名密码登录。
- 每用户独立的高亮、屏蔽、订阅正则。
- 高亮只匹配标题和正文。
- 屏蔽在服务端执行，匹配标题、正文、用户名。
- 订阅通过 Brevo 邮件和 Telegram Bot 推送。
- OLED 纯黑暗色模式，适配手机、平板、PC、Mac。
- 每页 50 贴，支持板块筛选、正则搜索、URL 页码、快速跳页。

## Cloudflare 免费资源

本项目使用：

- Cloudflare Workers 免费额度。
- Cloudflare D1 免费额度。
- Cloudflare Cron Triggers。
- GitHub 免费仓库。

邮件使用 Brevo HTTPS API，需自行确认 Brevo 免费额度和发信域名配置。

## 网页部署

1. Fork 本仓库到自己的 GitHub 账号。
2. 进入 [Cloudflare Workers 创建页面](https://dash.cloudflare.com/?to=/:account/workers-and-pages/create)。
3. 选择 `Continue with GitHub`。
4. 选择你刚刚 Fork 的仓库。
5. 构建命令填写 `npm run deploy`。
6. 其余配置保持默认并开始部署。
7. 构建脚本会自动创建或复用 D1 数据库 `nodeseek-rss-reader`，自动生成 D1 绑定配置，并自动执行数据库迁移。
8. 部署完成后打开 Workers 域名，注册第一个用户。
9. 如需邮件或 Telegram 推送，在 Cloudflare 项目设置中添加对应 Secrets 和变量，然后重新部署。

## 自动构建命令

Cloudflare GitHub 集成里只需要填写这一个构建命令：

```bash
npm run deploy
```

这个命令会执行：

- 查询当前 Cloudflare 账号下是否已有 `nodeseek-rss-reader` D1 数据库。
- 不存在时自动创建该 D1 数据库。
- 生成 `wrangler.generated.jsonc`。
- 同步更新根目录 `wrangler.jsonc`，确保 Cloudflare 最终部署阶段也带有 `DB` 绑定。
- 自动执行 `migrations/0001_initial.sql`。
- 验证 `posts`、`users`、`sync_state` 表已经存在。
- 执行 Worker 打包 dry-run 校验。
- 使用自动生成的配置部署 Worker。

## 环境变量

`wrangler.jsonc` 已内置：

```json
{
  "RSS_URL": "https://rss.nodeseek.com/",
  "ADMIN_USERNAME": "admin",
  "MAIL_PROVIDER": "brevo"
}
```

通知功能可以在网页管理员后台配置。若要启用管理员后台，请在部署后添加一个 Secret：

```bash
npx wrangler secret put ADMIN_SECRET
```

`ADMIN_SECRET` 建议使用 32-64 位小写字母和数字。URL 的域名不区分大小写，但 `token` 参数值区分大小写；为了减少复制和输入错误，推荐只用小写字母和数字。可以包含特殊字符，但不推荐；如果使用特殊字符，放进 `/admin?token=...` 时必须 URL 编码。避免使用空格和这些容易影响 URL/Shell 的字符：`?`、`#`、`&`、`%`、`=`、`+`、`/`、`\`、引号、反引号、`<`、`>`。

推荐示例：

```text
r7m4qp9vz2kx8nw6ta3yh5bc1ls0defg
```

Cloudflare 保存 Secret 后不会再显示明文，保存前请复制到密码管理器或安全位置。添加后点击输入框下方空白处，让「保存 / Save」按钮变亮；点击「保存 / Save」后如弹出部署选择，点击「不部署 / Do not deploy」即可生效。然后访问：

```text
https://你的域名/admin?token=你的ADMIN_SECRET
```

请保存这个管理入口为书签。管理链接包含 Secret，不要分享给其他人。

也可以继续用 Cloudflare 变量作为 fallback：`BREVO_API_KEY`、`TELEGRAM_BOT_TOKEN`、`MAIL_FROM`、`MAIL_FROM_NAME`。

## Brevo 邮件

1. 注册 Brevo。
2. 配置发件邮箱或发信域名。
3. 创建 SMTP/API Key。
4. 访问 `/admin?token=你的ADMIN_SECRET` 进入独立管理员页面。
5. 填写 Brevo API Key、发件邮箱和发件人名称。
6. 用户在网页设置里绑定自己的收件邮箱。

## Telegram Bot

1. 在 Telegram 找到 `@BotFather`。
2. 创建 Bot 并复制 Token。
3. 访问 `/admin?token=你的ADMIN_SECRET` 进入独立管理员页面。
4. 填写 Telegram Bot Token。
5. 部署完成后，在网页设置里查看自己的绑定码。
6. 用户向 Bot 发送 `/start 绑定码`。
7. 也可以直接在网页设置里填写自己的 Chat ID。
8. 如需 Webhook，设置为 `https://你的域名/telegram/webhook`。

## 管理员后台

管理员后台不需要管理员账号，使用单个 Secret 认证：

```text
ADMIN_SECRET
```

访问：

```text
/admin?token=你的ADMIN_SECRET
```

访问 URL 中的 `token` 正确时会直接打开独立管理员页面。请保存完整管理入口为书签；管理链接包含 Secret，不要分享给其他人。

管理员后台可配置：

- Brevo API Key
- 发件邮箱
- 发件人名称
- Telegram Bot Token
- 已读状态保留天数，默认 30 天
- RSS 帖子保留天数，默认 365 天
- 推送日志保留天数，默认 30 天

敏感配置会使用 `ADMIN_SECRET` 加密后存入 D1。如果更换 `ADMIN_SECRET`，需要重新填写 Brevo API Key 和 Telegram Bot Token。

Webhook 设置示例：

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://your-worker.workers.dev/telegram/webhook"}'
```

## 本地开发

```bash
npm install
npx wrangler login
npm run db:migrate:local
npm run dev
```

## CLI 部署

```bash
npm install
npx wrangler login
npm run deploy
```

## 自动 D1 失败时

正常情况下不需要手动创建数据库。如果 Cloudflare GitHub 构建环境没有足够权限执行 `wrangler d1 create` 或 `wrangler d1 migrations apply`，构建日志会提示失败原因。

备用 CLI 修复方式：

```bash
npm install
npx wrangler login
npm run cf:build
npm run deploy:generated
```

这仍然不需要手动复制 SQL 或手动编辑 `database_id`。

## 部署检查

部署完成后打开：

```text
https://你的域名/health
```

正常返回示例：

```json
{
  "ok": true,
  "dbBinding": true,
  "tables": {
    "posts": true,
    "users": true,
    "sync_state": true
  }
}
```

如果看到 `dbBinding: false`，说明当前 Worker 没有 D1 绑定 `DB`。请确认 Cloudflare 构建命令是 `npm run deploy`，并重新部署。

如果 Cloudflare 面板里有旧 Worker 或旧 Cron 仍在报 `D1 database ... has been deleted`，请删除旧 Worker，或在旧 Worker 的 Triggers 中禁用 Cron。

## 更新

- 手动：打开你 Fork 的 GitHub 仓库，点击 `Sync fork`，然后在 Cloudflare 重新部署。
- GitHub 集成：Cloudflare Workers 会在仓库更新后按你的项目设置重新构建部署。

## 注意

- Cloudflare Workers 不能直接使用传统 SMTP socket，本项目使用 Brevo HTTPS API。
- 首次同步只入库，不推送历史帖子，避免第一次部署产生大量通知。
- 主部署流程不需要手动创建 D1，不需要手动替换 `database_id`。
- `workspace/nodeseek.js` 未在当前工作区找到，右下角按钮已实现为圆润上下箭头固定按钮。
