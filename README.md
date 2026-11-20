# NodeSeek RSS Reader

运行在 Cloudflare Workers 上的 NodeSeek RSS 阅读与订阅网站，只适配 `https://rss.nodeseek.com/`。

[![Powered by Cloudflare](https://img.shields.io/badge/Powered%20by-Cloudflare-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)

## 功能

- 每分钟抓取一次 NodeSeek RSS。
- 首次运行导入当前 RSS 全部帖子，不推送历史通知。
- 浏览器刷新当前页面即可看到最新帖子。
- D1 数据库存储帖子、用户、阅读进度、规则和推送日志。
- 数据库接近容量上限时自动清理最旧帖子：免费默认 480MB 触发、降到 450MB 停止（付费默认 9850MB → 9820MB），每天最多删除 2 万条；超过套餐最大容量 2MB 时新帖每轮最多写入 5 条。
- 开放注册，用户名密码登录。
- 每用户独立的高亮、屏蔽、订阅正则，支持 `####` 链式多段匹配。
- 搜索由 Worker 端 FTS5 索引按字面关键词匹配标题和正文，结果页在浏览器本地翻页；搜索结果不应用屏蔽规则，高亮规则仍然生效。
- 普通列表在浏览器端应用同步的屏蔽规则；搜索结果不应用屏蔽规则。
- 订阅通过 Brevo 邮件和 Telegram Bot 推送。
- OLED 纯黑暗色模式，适配手机、平板、PC、Mac。
- 每页默认 80 贴（管理员可配置 10-500），支持板块筛选、字面关键词搜索、URL 页码、快速跳页；搜索结果上限管理员可配置 50-500（默认 200）。
- 首页显示部署构建对应的 Git 短 commit 版本号；`npm run deploy` 构建时自动注入，不是 package 版本号。

## 规则书写：`####` 链式正则

高亮、屏蔽、订阅规则统一支持用字面 `####`（四个井号）把一条规则分隔为最多 4 段正则：各段在同一段文本里全部命中时规则才生效；高亮规则会把每个命中的分段都标记出来。

- 分隔符按字面识别，额外井号并入相邻段：`a#####b` 解析为段 `a` 和 `#b`，`a######b` 解析为段 `a` 和 `##b`。
- 最多 4 段；不含 `####` 的规则按单段正则处理，与原有行为完全一致。
- 整条规则先去掉首尾空白，再按完整长度（含分隔符与段内空格）限制在 200 字符以内。
- 分隔符两侧的空格保留在相邻段内部并参与匹配：`Alpha #### Beta` 的两段是 `Alpha ` 和 ` Beta`，而 `Alpha####Beta` 的两段是 `Alpha` 和 `Beta`。
- 完全空白（去掉空格后为空）的段会被拒绝，整条规则不会保存。
- 想匹配连续井号本身时，用量词写法 `#{4}` 表示四个井号字符，避免被当作链式分隔符。
- 搜索关键字（`?q=`）是字面关键词，不是正则；`####` 在搜索里只是普通文本。链式正则语义只适用于高亮、屏蔽、订阅规则。

## 搜索

搜索是字面关键词匹配，不是正则：`.*`、`(`、`[` 等正则符号一律按普通文本处理。

- 输入先去掉首尾空白，再按空格拆分成多个关键词；英文字母 A-Z 不区分大小写（仅限 ASCII，其余字符按原样精确匹配）。
- 整条搜索词最多 200 字符，超长提示「搜索关键词过长（最多 200 字符）」。
- 最多 10 个关键词（去重后），超出提示「搜索关键词过多（最多 10 个）」。
- 至少要有一个不少于 2 个字符的关键词，否则提示「请至少输入一个两字及以上的关键词」；单字关键词不能锚定，只参与命中计数。
- 锚定词优先取最长的不小于 3 字符关键词（同长取输入靠前的），没有则取第一个两字关键词；每条结果都必须包含锚定词。
- 排序：命中关键词个数多的在前，个数相同按发布时间新到旧，再按 id 新到旧。
- 命中结果最多返回「搜索结果上限」条（管理员可配置 50-500，默认 200）；结果页在浏览器本地按「每页数量」翻页，翻页不发新的网络请求。
- 高亮、屏蔽、订阅规则仍按 `####` 链式正则匹配，语义不变；搜索结果不应用屏蔽规则，高亮规则仍然生效。
- 搜索基于 D1 FTS5 索引（标题 + 正文）。新帖同步入库时即时建索引；历史帖子由 cron 每分钟最多回填 25 条，可断点续跑，不做一次性全量回填，无需手动执行任何批量 SQL。
- 历史索引构建完成前，搜索只覆盖已建立索引的帖子，页面会显示「历史搜索索引仍在构建中」提示；构建状态与最近错误可通过 `/api/debug/status`（管理员 token）的 `searchIndex` 字段查看。

## Cloudflare 免费资源

本项目使用：

- Cloudflare Workers 免费额度。
- Cloudflare D1 免费额度（单库上限 500MB；数据库接近上限时由自动清理删除最旧帖子腾出空间）。
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
- 自动执行全部待应用的数据库迁移（`migrations/` 目录）。
- 验证 `posts`、`users`、`sync_state` 表已经存在。
- 执行 Worker 打包 dry-run 校验。
- 使用自动生成的配置部署 Worker。

搜索索引迁移（`migrations/0012_search_indexes.sql`）会随上述迁移步骤自动应用。旧版显式 `"450"` 在运行时按 480 生效，无需迁移；管理员重新保存 450 仍按 450 生效。部署完成后由 cron 每分钟最多回填 25 条历史帖子，逐步补齐搜索索引，可断点续跑；无需手动执行任何批量 SQL。

## 环境变量

`wrangler.jsonc` 已内置：

```json
{
  "RSS_URL": "https://rss.nodeseek.com/"
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

1. 打开 [Brevo 官网](https://www.brevo.com/) 并注册或登录账号。
2. 进入 Brevo 控制台，打开右上角账号菜单。
3. 进入「SMTP & API」。
4. 切换到「API Keys」，也可以尝试直接打开 [Brevo API Keys 页面](https://app.brevo.com/settings/keys/api)。
5. 点击「Generate a new API key」，名称可填写 `NodeSeek RSS Reader`。
6. 复制生成的 API Key。
7. 访问 `/admin?token=你的ADMIN_SECRET` 进入独立管理员页面。
8. 填写 Brevo API Key、发件邮箱和发件人名称。
9. 用户在网页设置里绑定自己的收件邮箱。

注意：发件邮箱必须是 Brevo 允许发送的邮箱或已验证域名下的邮箱；如果邮件发不出去，请先在 Brevo 检查 Sender / Domain 是否已验证。API Key 保存后不会在管理员页明文显示，留空保存不会覆盖旧 Key。

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
- 已读状态保留天数，默认 7 天
- 数据库自动清理触发阈值（MB），免费默认 480、付费默认 9850，范围 100-9850
- 付费版 D1 开关（默认关闭；免费最大容量 500MB，付费 10GB）
- 推送日志保留天数，默认 30 天

敏感配置会使用 `ADMIN_SECRET` 加密后存入 D1。如果更换 `ADMIN_SECRET`，需要重新填写 Brevo API Key 和 Telegram Bot Token。

Webhook 设置示例：

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://your-worker.workers.dev/telegram/webhook"}'
```

## 数据库自动清理

Cloudflare 免费版 D1 每个数据库上限 500MB；管理员可在后台打开「付费版 D1」，最大容量变为 10GB。数据库达到「数据库自动清理触发阈值」（免费默认 480MB，付费默认 9850MB，可在 100-9850MB 之间调整）后，cron 会按最旧优先删除帖子，清理到阈值以下 30MB 停止。

- 触发与目标：免费默认 480MB → 450MB；付费默认 9850MB → 9820MB；保留 30MB 滞回空间。
- 5 帖限流：当 `size > 套餐最大容量 - 2MB`（免费 498MB，付费 9998MB）时，每次同步最多写入 5 条新帖；正常低于该阈值时按 RSS feed 窗口写入。任何情况下都不设 0。
- 每日上限：每个 UTC 日最多删除 20,000 条；每批删除前先做原子配额预留，跨 UTC 日自动重置。
- 双重时间护栏：只删除 `published_at` 和 `fetched_at` 都早于 24 小时前的帖子，避免误删刚导入的旧帖。
- 正常删除顺序：按 `published_at ASC, id ASC` 取最旧帖子，依次删除 `read_states`、两个搜索索引表和 `posts`，四条语句在同一个 D1 batch 内执行。
- 满库自愈：如果四条语句的 batch 因容量上限失败，改为单语句先删 `read_states`、再删 `posts` 释放正文空间；对应 FTS 行暂时留作孤儿，等空间恢复后由独立游标每轮每表最多清理 25 行，不 DROP 索引表，也不建 JSON 队列。
- 满库保护与计数：`read_states` 删除失败不会阻止 `posts` 删除；`blocked_full=1` 不再暂停容量裁剪，库仍达到触发阈值时下一分钟继续重试初始化、候选查询与删除（保留上次错误作为基础诊断），该标记只作为诊断与 FTS 孤儿清理的闸门，降到阈值以下才清除；只有当 100 行单语句 `posts` 删除因 `Exceeded maximum DB size` 失败时才进入 1 行降级；非容量错误会全额退款并向上抛出，不降级。降级时同一轮对同批前 10 个 ID 逐条重试（每个 ID 最多删 `read_states` 与 `posts` 两条语句），确认删除计入计数、确认未删退款、缺失或非数字 `changes` 视为未确认并保留预留，随后立即结束本轮并设置 `blocked_full=1`；同日重试初始化失败时，引导删除不超过当天剩余额度（余额为零则不删除）；引导删除会立即计入当日计数，若配额结算或状态写入失败，按实际删除数尽力落库并设置 `blocked_full=1`。
- 计数：只按实际删除的 `posts` 行数结算；`"1100.0"` 会规范为 `"1100"` 并视为当天已用，不按帖子总数差值退款。
- 单次 cron：正常循环最多 5 批、500 条帖子；满库状态键初始化失败时先做一次最多 100 条的引导删除。清理在 RSS 同步之前执行；失败只记录到 `sync_state.db_prune_last_error`，不会阻断同步。
- 与 365 天保留的关系：原有的 365 天帖子保留仍作为后台兜底每日执行；容量清理可能早于 365 天删除最旧的帖子。
- 搜索回填：`SEARCH_BACKFILL_BATCH=25`，只回填历史索引，不限制新帖；每分钟最多 25 条。
- 诊断：`/api/debug/status`（管理员 token）的 `storage` 字段包含 `sizeBytes`、`limitBytes`、`targetBytes`、`active`、`deletedToday`、`lastPruneAt`、`lastPruneError`、`paidPlan`、`maxCapacityBytes`、`fivePostThresholdBytes`、`blockedFull`，并在 `timings` 中记录 `storageMs`。
- 配置：`db_prune_limit_mb`（免费 480 / 付费 9850，clamp 100..9850）、`d1_paid_enabled`（默认 false）；旧版显式 `"450"` 在运行时按 480 生效，无需迁移；管理员重新保存 450 仍按 450 生效。库大小通过 `SELECT 1` 的 `meta.size_after` 读取，不使用 `PRAGMA page_count`/`dbstat`、Cloudflare REST API 或 VACUUM。

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
- RSS 抓取诊断只记录失败尝试（成功不写库）；过期失败记录由每日清理按滚动 24 小时删除。
- 订阅只推送本次真正入库成功的新帖；已存在的帖子和重复 GUID 不会重复推送。
- 主部署流程不需要手动创建 D1，不需要手动替换 `database_id`。
- 右下角悬浮按钮为单个方向切换按钮：向下滚动时快速到底部，向上滚动时快速到顶部；电脑端按钮贴帖子右缘，手机端贴窗口右缘。
- 数据库达到自动清理触发阈值时会优先删除最旧的帖子，可能早于 365 天保留期；需要保留更久时请调高「数据库自动清理触发阈值（MB）」。
