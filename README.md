# NodeSeek RSS Reader

运行在 Cloudflare Workers 上的 NodeSeek RSS 阅读与订阅网站，只适配 `https://rss.nodeseek.com/`。

[![Powered by Cloudflare](https://img.shields.io/badge/Powered%20by-Cloudflare-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)

## 功能

- 每分钟抓取一次 NodeSeek RSS。
- 首次运行导入当前 RSS 全部帖子，不推送历史通知。
- 浏览器刷新当前页面即可看到最新帖子。
- D1 数据库存储帖子、用户、阅读进度、规则和推送日志。
- 数据库达到容量阈值时自动清理最旧帖子：索引在首个 UTC 23:30–00:00 窗口按 0→1→2 状态机建立并验证（与当前库大小无关），验证通过后，cron 在 UTC 23:30–00:00 先完成 RSS 同步再裁剪；免费默认 480MB 触发、目标为触发阈值减 30 MB（默认 450 MB）；付费默认 9850MB → 9000MB（触发阈值≤9000MB 时按阈值-30MB）；每个 UTC 日最多 10,000 条；超过套餐最大容量减 2MB 时新帖每轮最多写入 5 条。
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
- 搜索基于 D1 FTS5 索引（标题 + 正文）。新帖同步入库时即时建索引；内联索引在每次同步的首个失败后停止尝试，帖子仍全部入库，循环结束后只记录一对索引错误与重试标记（固定 2 条诊断查询），由 `complete=0` 让 cron 回填修复所有未索引帖子。历史帖子由 cron 每分钟最多回填 20 条，可断点续跑，不做一次性全量回填，无需手动执行任何批量 SQL。回填保留为首次构建与写入失败后的修复路径，历史索引构建完成后不再单独执行。
- 历史索引构建完成前，搜索只覆盖已建立索引的帖子，页面会显示「历史搜索索引仍在构建中」提示；构建状态与最近错误可通过 `/api/debug/status`（管理员 token）的 `searchIndex` 字段查看。

## Cloudflare 免费资源

本项目使用：

- Cloudflare Workers 免费额度。
- Cloudflare D1 免费额度（单库上限 500MB；数据库接近上限时由自动清理删除最旧帖子腾出空间）。
- Cloudflare Queues 免费额度（每天 10,000 次操作，消息最长保留 24 小时）。
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
7. 构建脚本会自动创建或复用 D1 数据库 `nodeseek-rss-reader`，自动创建或复用 Queue `nodeseek-rss-reader-ingest` 与死信队列 `nodeseek-rss-reader-ingest-dlq`，生成 D1/Queue 绑定配置，并自动执行数据库迁移。
8. 部署后在 Workers Logs 观察 `cron_route` 日志：`INGEST_MODE=inline` 已保证每个 UTC 分钟最多执行一次 sync；先确认 sync / notify / maintenance 三个 role 分别触发，再考虑后续 Queue 阶段。
9. 部署完成后打开 Workers 域名，注册第一个用户。
10. 如需邮件或 Telegram 推送，在 Cloudflare 项目设置中添加对应 Secrets 和变量，然后重新部署。

## 自动构建命令

Cloudflare GitHub 集成里只需要填写这一个构建命令：

```bash
npm run deploy
```

这个命令会执行：

- 查询当前 Cloudflare 账号下是否已有 `nodeseek-rss-reader` D1 数据库。
- 不存在时自动创建该 D1 数据库。
- 查询并幂等创建 Queue `nodeseek-rss-reader-ingest` 及其死信队列 `nodeseek-rss-reader-ingest-dlq`（已存在时复用）。
- 生成 `wrangler.generated.jsonc`，包含三个 Cron Triggers、Queue producer/consumer/DLQ、D1 绑定和运行时变量。
- 同步更新根目录 `wrangler.jsonc`，确保 Cloudflare 最终部署阶段也带有 `DB` 与 `INGEST_QUEUE` 绑定。
- 自动执行全部待应用的数据库迁移（`migrations/` 目录）。
- 验证 `posts`、`users`、`sync_state` 表已经存在。
- 执行 Worker 打包 dry-run 校验。
- 使用自动生成的配置部署 Worker。

迁移链为 `0001..0012` 与 `0014`（中间编号有意空缺）。搜索索引迁移（`migrations/0012_search_indexes.sql`）会随上述迁移步骤自动应用；`migrations/0014_read_states_post_id_index.sql` 是 ledger-only/no-op 迁移，不会在部署时预建 `read_states(post_id)` 索引。cron 在首个 UTC 23:30–00:00 窗口按 0→1→2 状态机建立该索引，并用 `sqlite_schema` + `PRAGMA index_info` 独立验证，验证通过后才启用容量裁剪。旧版显式 `"450"` 在运行时按 480 生效，无需迁移；管理员重新保存 450 仍按 450 生效。部署完成后由 cron 每分钟最多回填 20 条历史帖子，逐步补齐搜索索引，可断点续跑；回填保留为首次构建与写入失败后的修复路径，完成历史索引后不再单独执行；无需手动执行任何批量 SQL。

## Queue 摄取与分阶段启用

**当前版本请保持 `INGEST_MODE=inline`。** Queue 模式已实现，原 6 个阻塞项（首同步时序、快照范围与 retry cap、`sendBatch` 分批、FTS 崩溃恢复、通知 lease、canary 5 帖/消息）已在本地修复并通过复审；启用前仍需用部署日志确认三 cron 是否合并、免费套餐 CPU 与 Queue ops，并由 owner 放行。详见 `AGENTS.md`「Queue 阻塞项修复状态」。

以下描述目标架构，部署后按阶段启用；各阶段以本节末尾的说明为准。

新架构把 RSS 完整解析、清洗、入库与搜索索引从每分钟同步 cron 移到 Cloudflare Queue 消费者：同步 cron 只做轻量 GUID 预筛与入队，通知和搜索回填各自独立 cron。免费套餐 Queues 配额为每天 10,000 次操作（每条消息约 3 次操作，消息最长保留 24 小时），本项目的业务目标是每天不超过 6,000 次操作。

首同步使用 10 分钟有界重试窗口；窗口到期会原子推进通知游标并保留缺失 GUID 审计，之后普通新帖正常入队。被放行的历史 GUID 即使晚到入库也不会触发通知；非法或缺失的首同步起点会修复为新的 10 分钟窗口，不会立即放行。

三个 Cron Triggers（部署配置顺序固定）：

| 表达式 | 角色 |
| --- | --- |
| `*/1 * * * *` | sync：抓取 RSS 并投递摄取消息 |
| `* * * * *` | notify：按游标分批发送订阅通知 |
| `0-59 * * * *` | maintenance：搜索索引回填 |

sync 与 notify 的表达式文本不同，但语义都是每分钟；Cloudflare 是否把它们合并成一次触发需要部署后验证。首次上线先保持 `INGEST_MODE=inline`，在 Workers Logs 里查看 `cron_route` 日志：能分别看到 sync / notify / maintenance 路由后，再按阶段推进。Queue 模式本身的原 6 个代码阻塞项已修复，但仍需先用 inline 部署验证平台行为；在 owner 放行前不要切换。如果平台把三个 cron 合并成一次触发，回退到独立 Worker，或把通知 cron 调整为 `*/2 * * * *`（需 owner 批准）。

### 切换与回滚

构建脚本读取环境变量决定部署后的运行模式：

- `INGEST_MODE=inline`（默认）：同步 cron 内联解析、入库与建索引，不依赖 Queue 消费者。
- `INGEST_MODE=queue`：同步 cron 只入队，由 `nodeseek-rss-reader-ingest` 消费者完成解析入库。
- `HTML_MODE=regex`（默认）/ `HTML_MODE=rewriter`：正文清洗路径，按阶段启用。
- `INGEST_ITEMS_PER_MESSAGE=5|3|1`：queue 模式下每条摄取消息携带的帖子数（默认 5）；canary 可降档后重新部署，已入队的 5 帖消息不受影响。

切换方式：在 Cloudflare Workers 构建项目设置里添加同名环境变量，或在本地执行 `INGEST_MODE=queue npm run deploy`。回滚把变量改回 `inline`（或删除变量）后重新部署；从 `queue` 回滚到 `inline` 时，先保持 consumer 部署到队列积压排空（消息最长保留 24 小时）再移除 consumer，避免已入队消息丢失。

本仓库的 Queue 代码路径已实现；部署模板与构建脚本能创建 Queue/DLQ 并写入三个 cron。原 6 个阻塞项已修复并通过本地验证；在完成部署日志验证并由 owner 放行前，请保持 `INGEST_MODE=inline`。

## 环境变量

`wrangler.jsonc` 已内置：

```json
{
  "RSS_URL": "https://rss.nodeseek.com/",
  "INGEST_MODE": "inline",
  "HTML_MODE": "regex"
}
```

`COMMIT_VERSION` 由构建脚本按当前 Git commit 注入，不要手动填写。`INGEST_MODE` 与 `HTML_MODE` 可在构建环境变量中覆盖（见上文「Queue 摄取与分阶段启用」）。

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
- 数据库自动清理触发阈值（MB），免费默认 480、付费默认 9850，范围 100-9850；清理目标免费 450MB、付费 9000MB（触发阈值≤9000MB 时按阈值-30MB）；正常删除窗口 UTC 23:30–00:00；索引未验证不删帖，每个 UTC 日最多 10,000 条。
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

Cloudflare 免费版 D1 每个数据库上限 500MB；管理员可在后台打开「付费版 D1」，最大容量变为 10GB。索引在首个 UTC 23:30–00:00 窗口按 0→1→2 状态机建立并验证，与当前库大小无关。数据库达到「数据库自动清理触发阈值」（免费默认 480MB，付费默认 9850MB，可在 100-9850MB 之间调整）后，cron 会在 UTC 23:30–00:00 先完成 RSS 同步，再按最旧优先删除帖子，免费版清理到 450MB、付费版清理到 9GB 停止。

- 触发与目标：免费默认 480MB 触发，目标为触发阈值减 30 MB（默认 450 MB）；付费默认 9850MB → 9000MB（触发阈值≤9000MB 时按阈值-30MB）；免费保留 30MB 滞回；正常删除窗口 UTC 23:30–00:00。索引在首个 UTC 23:30–00:00 窗口建立并验证，与当前库大小无关。
- 索引状态机：`sync_state.db_prune_index_state` 为 `"0"`（未验证：正常 RSS、零裁剪）、`"1"`（建索引/恢复：只做状态读写、0014、独立验证和错误日志，暂停 RSS/订阅/保留清理/FTS 孤儿/搜索回填/裁剪，HTTP 不关闭）、`"2"`（已验证终态，不再执行 0014）。状态 0 在窗口内且本轮同步/订阅完成后按观测到的 `updated_at` 原子领取 `"1"`（过期读者不能覆盖更新的失败标记）并执行幂等 `CREATE INDEX IF NOT EXISTS idx_read_states_post_id ON read_states(post_id)`；DDL 后用 `sqlite_schema` 与 `PRAGMA index_info` 独立验证，通过才写 `"2"`；失败/超时/验证失败写回 `"0"` 并在本窗口不再重试。崩溃在 `"1"` 时下一轮先验证，不重跑 DDL；索引在 `"2"` 下丢失时只记录异常并停止裁剪，不自动重建。
- 5 帖限流：当 `size > 套餐最大容量 - 2MB`（免费 498MB，付费 9998MB）时，每次同步最多写入 5 条新帖；正常低于该阈值时按 RSS feed 窗口写入。任何情况下都不设 0。
- 每日上限：每个 UTC 日最多删除 10,000 条（含建索引当日）；每批删除前先做原子配额预留，跨 UTC 日自动重置。
- D1 日写配额耗尽时：没有应用级总写入上限，只记录 Workers Logs、结束本轮，不循环/重试/休眠；等待 00:00 UTC 重置后，仍需等到下一个 UTC 23:30–00:00 窗口才继续裁剪。日写配额错误不会进入满库降级路径。
- 设置读取：缺 `d1_paid_enabled` / `db_prune_limit_mb` 行时按当前套餐默认；D1 读取错误不是默认值：本轮 cron 继续 RSS 同步与订阅，但跳过容量裁剪与 FTS 孤儿清理，且只记录 Workers Logs，不写状态或错误键。
- 双重时间护栏：只删除 `published_at` 和 `fetched_at` 都早于 24 小时前的帖子，避免误删刚导入的旧帖。
- 正常删除顺序：按 `published_at ASC, id ASC` 取最旧帖子，依次删除 `read_states`、两个搜索索引表和 `posts`，四条语句在同一个 D1 batch 内执行。
- 满库自愈：如果四条语句的 batch 因容量上限失败，改为单语句先删 `read_states`、再删 `posts` 释放正文空间；对应 FTS 行暂时留作孤儿，并在确认已删除帖子后立即把 `sync_state.db_prune_fts_orphans_pending` 置为 `"1"`（早于任何退款或本轮提前返回，正常四语句路径绝不设置）。标记为 `"1"` 时，等空间恢复后由独立游标每轮每表最多清理 25 行，两个游标都完成后清回 `"0"`，部分失败保留标记与游标；标记非 `"1"` 时完全跳过扫描。不 DROP 索引表，也不建 JSON 队列。
- 满库保护与计数：`read_states` 删除失败不会阻止 `posts` 删除（日写配额错误除外）；`blocked_full=1` 不再暂停容量裁剪，库仍达到触发阈值时窗口内下一分钟继续重试初始化、候选查询与删除（保留上次错误作为基础诊断），该标记只作为诊断与 FTS 孤儿清理的闸门，降到阈值以下才清除；只有当 100 行单语句 `posts` 删除因 `Exceeded maximum DB size` 失败时才进入 1 行降级；非容量错误视为未知并保留配额预留、结束本轮（不降级）。降级时同一轮对同批前 10 个 ID 逐条重试（每个 ID 最多删 `read_states` 与 `posts` 两条语句），确认删除计入计数、确认未删及未尝试退款、缺失或非数字 `changes` 视为未确认并保留预留，随后立即结束本轮并设置 `blocked_full=1`；数字 `changes` 缺失或非容量异常视为未知，保留配额预留并结束本轮；状态键初始化失败时本轮零删除。
- 计数：只按实际删除的 `posts` 行数结算；`"1100.0"` 会规范为 `"1100"` 并视为当天已用，不按帖子总数差值退款。
- 单次 cron：状态 `"2"` 先完成 RSS 同步、订阅和保留清理，再按窗口、索引、容量、日额度裁剪；正常循环最多 5 批、500 条帖子；状态键初始化失败时本轮零删除。失败只记录到 `sync_state.db_prune_last_error`，不会阻断同步；00:00Z 后不再启动新批次。
- 帖子删除只由容量裁剪执行；不设年龄清理。
- 搜索回填：`SEARCH_BACKFILL_BATCH=20`，只回填历史索引，不限制新帖；每分钟最多 20 条。`search_index_state.complete=1` 后不再单独执行，回填只作为首次构建与写入失败后的修复路径。
- 诊断：`/api/debug/status`（管理员 token）的 `storage` 字段包含 `indexState`、`indexStateRaw`、`indexStateInvalid`、`indexDay`、`dailyCap`、`sizeBytes`、`limitBytes`、`targetBytes`、`active`、`deletedToday`、`lastPruneAt`、`lastPruneError`、`paidPlan`、`maxCapacityBytes`、`fivePostThresholdBytes`、`blockedFull`，并在 `timings` 中记录 `storageMs`。
- 配置：`db_prune_limit_mb`（免费 480 / 付费 9850，clamp 100..9850）、`d1_paid_enabled`（默认 false）；目标免费 450MB / 付费 9000MB（触发阈值≤9000MB 时按阈值-30MB）；正常删除窗口 UTC 23:30–00:00；旧版显式 `"450"` 在运行时按 480 生效，无需迁移；管理员重新保存 450 仍按 450 生效；`migrations/0014_read_states_post_id_index.sql` 是 ledger-only/no-op，索引由 `db_prune_index_state` 状态机在窗口内创建并验证。库大小通过 `SELECT 1` 的 `meta.size_after` 读取，不使用 `PRAGMA page_count`/`dbstat`、Cloudflare REST API 或 VACUUM。

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

默认按 `INGEST_MODE=inline` 部署；Queue 模式的代码阻塞项已修复，但需先用部署日志验证三 cron、CPU 与 Queue ops，并由 owner 放行后再用 `INGEST_MODE=queue npm run deploy` 切换。

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

### 自动 Queue 创建失败时

构建脚本用 `npx wrangler queues info <name>` 检查 Queue 是否存在，不存在时执行 `npx wrangler queues create <name>`；DLQ 先创建，已存在则复用。创建成功后脚本会轮询 `queues info`（最多 10 次、每次间隔 5 秒），等待 Cloudflare Queue 传播到 deploy 校验可见，避免创建后立即部署触发 `Queue ... does not exist`。如果 Workers Builds 的 token 没有 Queues 权限，构建日志会明确失败并提示对应命令，不会被静默忽略。此时先手动创建两个 Queue，再重新部署：

```bash
npx wrangler queues create nodeseek-rss-reader-ingest-dlq
npx wrangler queues create nodeseek-rss-reader-ingest
```

也可以在 Cloudflare 控制台的 Queues 页面创建同名队列。创建后重新部署即可复用，不需要删除 Worker 或手动改配置文件。

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
- 通知按游标分批投递：每个 cron 最多 20 个 channel attempts（含 500 个匹配单元），积压最坏延迟为 `ceil((积压+新增)/20)×60s`（0 订阅无通知，100 个订阅单渠道 ≤5 分钟、双渠道 ≤10 分钟）；外部发送失败不推进游标，下一分钟重试，不会静默丢弃。
- 通知发送前先预留推送日志预算：已启用渠道必须在发送前留出日志与游标写额度，发送后立即写 `push_logs`；若最终游标持久化没有头寸则跳过并记录日志，下一次 cron 依据 `push_logs` 去重，不会重复发送；按订阅禁用的渠道不产生日志行、也不占 20 次尝试上限。
- 主部署流程不需要手动创建 D1，不需要手动替换 `database_id`。
- 右下角悬浮按钮为单个方向切换按钮：向下滚动时快速到底部，向上滚动时快速到顶部；电脑端按钮贴帖子右缘，手机端贴窗口右缘。
- 索引在首个 UTC 23:30–00:00 窗口建立并验证（与当前库大小无关），数据库达到自动清理触发阈值后会在此窗口删除最旧的帖子；索引未验证（状态 0）或状态为建索引/恢复（状态 1）时不删帖。不设年龄清理，需要保留更久请调高「数据库自动清理触发阈值（MB）」。
