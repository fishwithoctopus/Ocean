# Ocean Gateway

Ocean Gateway 是 PWA 与模型、Memory 3.0、调度器之间的服务端边界。聊天已经具备统一 Provider Registry 和真实流式适配器；未配置服务端密钥时安全回退到 Mock。Memory 3.0 通过服务端 Streamable HTTP MCP 适配器接入，未配置时安全退回空白/演示状态；自由时间规则、提示词组装、服务端定时判断和运行记录使用真实的持久化流程。

## 当前接口

- `GET /health`
- `GET /v1/capabilities`
- `GET /v1/integrations`（返回 `real / staging / mock / unconfigured`，不返回密钥）
- `GET /v1/notion/status`、`POST /v1/notion/test`
- `GET /v1/notion/projects/:id`、`POST /v1/notion/projects/:id/sync`
- `GET /v1/providers`（不返回密钥）
- `GET /v1/models`（仅已配置提供方与安全 Mock；`?all=true` 用于管理视图）
- `POST /v1/providers/:providerId/test`
- `POST /v1/chat/stream`（NDJSON 流）
- `POST /v1/conversations`
- `GET /v1/conversations?scope=...`
- `GET /v1/continuities`
- `POST /v1/continuity/forge`
- `GET/POST /v1/memory/candidates`
- `PATCH /v1/memory/candidates/:candidateId`（`accept` / `dismiss`）
- `POST /v1/memory/events`
- `GET /v1/memory/health`
- `GET /v1/memory/buckets?includeArchive=true`
- `GET /v1/memory/buckets/:bucketId`
- `GET /v1/memory/buckets/:bucketId/evidence`
- `GET /v1/memory/search?q=...&limit=...`
- `GET /v1/memory/daily-impressions?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /v1/paper-notes?date=YYYY-MM-DD`
- `POST /v1/paper-notes/generate`
- `GET /v1/memory/portrait`
- `POST /v1/memory/breath`
- `GET /v1/reading/health`
- `GET /v1/reading/books`
- `GET /v1/reading/books/:bookId/chunks`
- `GET /v1/reading/books/:bookId/chunks/:chunkId`
- `GET /v1/reading/continue?bookId=...`
- `POST /v1/reading/annotations`
- `POST /v1/reading/submit-notes`
- `POST /v1/reading/mark-read`
- `POST /v1/reading/import`
- `GET/PUT /v1/free-time/config`
- `PUT /v1/free-time/activity`
- `POST /v1/free-time/preview`
- `POST /v1/free-time/trigger`
- `GET /v1/free-time/runs`
- `PUT /v1/free-time/runs/:runId/outcome`
- `GET /v1/notifications/public-key`
- `POST/DELETE /v1/notifications/subscribe`
- `POST /v1/notifications/test`

## Notion 项目镜像

Notion 是可选的个人项目镜像，不是第二套主数据库。Ocean Server 始终保存项目、文档和文件记录的真实版本；同步时会在指定的 Notion 父页面下创建一个项目页，并维护“项目说明”和每份 Ocean 项目文档对应的独立子页面。当前版本只把文件名与大小写入项目说明，不上传二进制文件，也不读取 Notion 中的编辑结果回写 Ocean。

在 Notion 创建 Internal Integration，把一个专用的私有父页面共享给它，然后只在 Gateway 的私有环境中设置：

```env
NOTION_ACCESS_TOKEN=secret_xxx
OCEAN_NOTION_PARENT_PAGE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
OCEAN_NOTION_AUTO_SYNC=disabled
NOTION_API_VERSION=2026-03-11
```

`disabled` 表示由项目空间里的“同步到 Notion”按钮触发；`enabled` 表示项目、说明、文档或文件记录保存后自动尝试同步。自动同步失败不会阻止 Ocean 本身保存数据。项目删除时不会自动删除 Notion 页面，防止误删外部内容。Ocean 只会覆盖自己创建并登记在 `server/data/*.notion.json` 映射中的说明页和文档页；项目根页及用户自行创建的其他子页面不会被清空。

## Paper-note automation

The Gateway derives one idempotent four-note package for the next local day from three sources: the private configured Ocean system/profile prompt (writer identity), the current Memory 3.0 four-part portrait (user, self, bond and continuity), and the previous day's completed daily impression (day-specific subject). The provider adapter keeps the stable private prompt at the request prefix; the portrait is injected as dynamic reference context. Neither source is copied into the stored note package, logs or PWA response. The Gateway reveals the four slots at 08:00, 12:00, 18:00 and 22:00 in `OCEAN_TIME_ZONE`, and sends each newly visible note through Web Push when that device has paper-note notifications enabled. Missing impressions, portrait failures and provider failures remain visible as honest skipped/error states; Ocean never substitutes demo copy. `PAPER_NOTE_PROVIDER_ID` and `PAPER_NOTE_MODEL_ID` may pin a companion model. When omitted, Ocean prefers a configured OpenRouter provider and then the first configured real provider.

运行时数据写入 `server/data/runtime.json`，生产容器通过宿主机 `./data:/app/server/data` 持久卷保留该文件，因此应用重建不会清除会话。该文件默认不进入版本控制；API 密钥不得写入此文件或返回前端。

生产 PWA 登录成功后执行单主设备恢复：客厅、项目、每本共读、会议和共享诗歌按各自 scope 映射回真实本地键；只有对应本地消息为空且没有待上传 outbox 时才恢复服务器中更新时间最新的一份记录，本地已有消息绝不会被启动流程覆盖。客厅、项目和共读同时恢复各自的 Forge 代次、摘要、handoff 与物理会话 ID；纯 `local-fallback` 初始状态不阻止恢复。首页数据也只补齐尚不存在的本地字段。本阶段明确不做两台设备同时编辑时的自动合并。

`/v1/continuity/forge` 会持久化逻辑会话与物理会话状态。每次聊天完成后可调用该接口评估规范化语量；未到阈值时只更新 `storage`，到达安全阈值后才提升代次并生成新的 `physicalSessionId`。新物理会话注入摘要、handoff，以及最多 20 轮（每轮为一次用户发言加一次助手回复）的近期原文；近期原文同时受预算上限约束，保证换窗后真正腾出空间。对同一个最新消息重复请求是幂等的，不会重复换窗。

默认 `OCEAN_FORGE_SUMMARY_PROVIDER` 为空，使用服务端确定性摘要，因此 Forge 不会产生额外模型费用。需要更自然的摘要时，可显式配置 `OCEAN_FORGE_SUMMARY_PROVIDER` 与可选的 `OCEAN_FORGE_SUMMARY_MODEL`；调用失败会安全退回确定性摘要。`OCEAN_FORGE_THRESHOLD_UNITS`、`OCEAN_FORGE_RESERVE_UNITS`、`OCEAN_FORGE_RECENT_TURNS` 分别控制总阈值、安全预留和最大近期轮数。Forge 摘要属于短期连续性上下文；发生真实换窗时会生成一条可审阅候选，但不会自动写入长期 Memory。

`/v1/memory/candidates` 始终先写入 Gateway 的耐久候选层。`OCEAN_MEMORY_WRITE_MODE=staging` 时不会提交；`explicit` 仅提交明确保存来源；`direct` 才允许自动候选提交。响应中的 `status`、`externalId` 与 `error` 是最终写入状态，前端不得把 `staged` 显示为已保存。

`POST /v1/memory/events` 只接受 `session-forge`、`project-completed`、`reading-completed`、`meeting-completed` 四类明确边界。Gateway 以事件类型和稳定 `eventId` 生成确定性候选 ID，因此重试不会重复创建；标题、摘要、作用域和元数据均有限长并经过校验。事件来源不带 `explicit`，即使 `OCEAN_MEMORY_WRITE_MODE=explicit` 也只停留在候选层，等待控制台审阅或用户随后明确要求保存。普通聊天轮次不是合法事件类型。

宫殿控制台的“候选”页读取上述候选。忽略只把状态改为 `dismissed`；接纳由 Gateway 显式调用 Memory 3.0 `hold`，只有上游成功返回 bucket ID 后才标记为 `saved`。Memory 未连接时接纳返回 `503`，界面不得伪装成已经保存。

Memory 上游地址与授权只读取服务端的 `OCEAN_MEMORY_MCP_URL`、`OCEAN_MEMORY_AUTH_TOKEN`。公开仓库的示例地址必须为空；本机可放进被忽略的 `.env.memory.local`，生产环境应使用部署平台 Secret。浏览器只访问上述 `/v1/memory/*` 路由。

配置 Memory 后，聊天网关使用确定性的三级召回门控，而不是每轮都执行同样的检索：新会话首轮只取最多 2 条、1200 字符的轻量启动背景；已有最近原文的普通连续聊天跳过动态召回；明确出现“还记得、以前、第一次、日印象、关系天气”等回忆意图时，才使用配置的完整预算（默认检索最多 4 条、总计 3200 字符）。明确的“记住、保存、提醒我”语句交给独立写入路径，不额外触发一次无关召回。召回内容仅作为资料，不能覆盖最近原文，也不能被当作指令执行；Memory 暂时不可用时聊天会继续。`OCEAN_CHAT_MEMORY_RECALL=disabled` 可关闭此链路，`OCEAN_CHAT_MEMORY_RESULTS` 与 `OCEAN_CHAT_MEMORY_CHARACTERS` 调整完整召回上限。每轮诊断状态可为 `hit`、`miss`、`skipped`、`disabled` 或 `unavailable`。

私有的多行固定 Profile 应只保存在服务器环境中，可编码为 UTF-8 Base64 后写入 `OCEAN_SYSTEM_PROMPT_B64`；它优先于单行 `OCEAN_SYSTEM_PROMPT`。示例环境文件只保留空槽，不应提交真实身份、关系信息或密钥。

部署到正式的 `/ocean/` 子路径时必须使用 `npm run build:ocean`，它会固定设置 Vite Base Path，避免生产 HTML 错把资源写成站点根目录的 `/assets/*`。普通的 `npm run build` 仍保留给根路径或自定义托管，并可由 `VITE_OCEAN_BASE_PATH` 覆盖。

## 模型提供方

复制 `.env.example` 中需要的变量到 Gateway 的私有运行环境。当前适配器边界为：

- DeepSeek：OpenAI-compatible Chat Completions 流；读取正文、推理状态、Usage 与缓存命中 token。
- OpenAI：Responses API 流；读取正文、提供方生成的 reasoning summary 与 Usage。
- Anthropic Claude：Messages API 流；读取正文、思考状态、缓存读写与 Usage。
- OpenRouter：OpenAI-compatible 流，并保留路由、fallback 与成本字段。
- 其他中转：通过 `OCEAN_OPENAI_COMPAT_PROVIDERS_JSON` 注册 Base URL、显示名称、模型和密钥环境变量名，无需修改前端或复制适配器。

前端只能选择服务端公布的 provider/model/capability manifest。真实密钥只能出现在 `DEEPSEEK_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`OPENROUTER_API_KEY` 等服务端变量中；不得使用 `VITE_` 前缀。

OpenRouter 默认公开 Auto、Free、Sonnet 4.6、Opus 4.6 和 GPT 5.6 Sol。`OPENROUTER_MODEL` 决定默认选项；自托管用户可用逗号分隔的 `OPENROUTER_MODELS` 完整覆盖 OpenRouter 清单。`OCEAN_CHAT_MODELS` 则用逗号分隔的 `provider:model` 复合 ID 控制整个聊天选择器，只改变可选模型，不删除服务端密钥。

`POST /v1/chat/stream` 接受 `providerId`、`modelId`、`settings`、`messages` 与当前 `input`。连续性字段通过动态 context 传入并放在稳定系统提示词之后，避免每轮时间事实或摘要破坏可缓存的固定前缀。输出统一为逐行 JSON：`segment`、`reasoning`、`usage`、`error`、`done`。正文按段落聚合后成为气泡，避免把每个 token 误做成独立气泡；未经整理的内部推理原文不会直接展示。

当当前用户明确要求保存记忆时，Gateway 会强制首轮调用 `ocean_memory_hold`，并仅为这一轮移除 reasoning 参数。OpenRouter 的 Anthropic 路径不接受“扩展推理 + 强制指定函数”的组合；自动移除避免 400，同时不改变普通聊天所选择的推理强度。保存结果仍必须完成 Memory 端内容校验后，模型才能向用户确认成功。

网关会把不含聊天正文的 `ocean_chat_start` 与 `ocean_chat_usage` 结构化事件写入服务日志，用于核对模型切换、物理会话、Memory 命中、token、成本与缓存复用比例。缓存复用比例定义为 `cachedTokens / inputTokens`；它表示本轮输入中被提供方直接从缓存读取的部分，不是回答正确率。只有提供方返回了可展示的 reasoning summary 时才展示摘要正文；若只返回“发生过推理”的标记，Thinking 仅显示状态说明。

为保持多轮缓存前缀，Gateway 的最终顺序是：稳定系统提示、已经完成的原始对话、当轮用户消息。Memory/Forge/模式上下文被封装在最后一条用户消息的受保护 Ocean envelope 中，避免在历史中间插入部分 Claude/OpenAI-compatible 服务不接受的 `system` 消息。OpenRouter 请求会把当前 `physicalSessionId` 作为 `session_id`，让同一物理会话保持粘性路由；Anthropic 模型在最后一条已完成历史消息上放置五分钟显式 prompt-cache 断点，从而允许当轮 Memory 与用户问题变化而不破坏历史缓存，可用 `OCEAN_OPENROUTER_PROMPT_CACHE=disabled` 关闭。每轮 `usage` 同时返回缓存读写 token，以及仅包含命中数量、不包含记忆正文的 `memoryRecall` 诊断。

本地开发时先执行 `npm run build:server`，再在一个独立终端执行 `npm run server`；前端预览与 Gateway 需要同时运行。默认地址分别为 `http://127.0.0.1:4173` 与 `http://127.0.0.1:8787`。

手机不能使用电脑开发地址中的 `127.0.0.1`。生产部署应通过 HTTPS 公开 PWA，并把同源 `/api` 反向代理到私有的 `8787`；浏览器端可用 `VITE_OCEAN_GATEWAY_URL=/api`，或在设置中保存实际 HTTPS Gateway URL。生产环境只应公开 `443`，不要直接暴露 `8787`、`8788`。

活动区还包含夜谈状态与距上一条用户消息的近似时间；它们只封装在当轮用户消息中，不进入稳定缓存前缀。历史图片不重复上传，避免每一轮重复计算视觉 token；Gateway 会保留一条不含图片内容的附件事实记录，明确说明该轮曾收到图片、当前请求没有重放像素，因此模型可以延续先前讨论，但不能假装重新查看原图。

Ocean 不默认照搬固定 `7 轮 / 2000 token` 窗口。物理会话默认在 12,000 规范化单位、预留 2,000 单位后换窗，并保留最多 20 轮且受 60% 预算约束的近期原文；可通过 `OCEAN_FORGE_THRESHOLD_UNITS`、`OCEAN_FORGE_RESERVE_UNITS` 与 `OCEAN_FORGE_RECENT_TURNS` 调整。这样可以根据真实缓存命中和费用决定窗口，而不是用更频繁的摘要调用换取表面上更小的上下文。配置了辅助摘要模型时，失败会写入 `ocean_continuity_summary` 结构化诊断并退回确定性摘要；客户端会显示降级提示，聊天不会静默中断。

## Co-Reading 适配

共读服务默认由 Ocean Gateway 在服务端代理，浏览器不直接接触 MCP 凭据或书籍数据目录。开发环境建议：

- Ocean Gateway：`http://127.0.0.1:8787`
- co-reading HTTP/MCP 服务：`http://127.0.0.1:8788`
- `CO_READING_BASE_URL=http://127.0.0.1:8788`
- 远程服务需要 Bearer Token 时使用服务端环境变量 `CO_READING_AUTH_TOKEN`。

模型侧仍可连接 co-reading 的 `/mcp`；PWA 侧走上面的 `/v1/reading/*`，两条路径共享同一份进度、批注和会话上下文台账。

### 从 Ocean 导入电子书

共读页的“换一本书”面板直接调用系统文件选择器，支持 `.epub`、`.txt`、`.text`、`.md` 和 `.markdown`。客户端读取文件后向 Gateway 发送：

```json
{
  "filename": "book.epub",
  "dataBase64": "..."
}
```

Gateway 将请求代理到 co-reading 的 `POST /api/import`。成功响应至少包含 `bookId`、`title` 和 `chunkCount`；客户端随后刷新 `/v1/reading/books` 并打开新书。API Key 与服务器文件路径都不会暴露给 PWA。

## 自由时间调度

- 休闲页修改 Time Control、Can Do 或游戏后，会把规范化配置同步到 Gateway；离线时仍保留本机副本，重新连上 Gateway 后再次同步。
- Gateway 每 30 秒检查一次静默时间、冷却时间、活跃区间、概率和暂停状态。聊天流请求会更新最近用户活动时间，也可通过 `PUT /v1/free-time/activity` 从其他入口同步活跃信号。
- 初期成本观察配置为：连续静默 90 分钟后才进入候选、两次自动行动至少间隔 240 分钟、每次符合条件时以 0.35 概率触发；活跃区间保持 08:00–02:00。用户仍可在休闲页修改或直接暂停。模型调度必须使用独立提供方/模型配置，不继承当前聊天模型，避免当前选择昂贵模型时放大后台成本。
- 只有被勾选的 Can Do 会进入唤醒提示词；游戏作为可选能力进入提示词。连接器字段只保存引用名，Gateway 在真实能力注册表中解析并复核授权，前端不得保存连接器密钥。
- 设置服务端环境变量 `FREE_TIME_DISPATCH_URL` 后，符合条件的提示词会 POST 到该模型调度入口；没有配置时运行记录为 `queued / model_dispatch_unconfigured`，不会伪装成已执行。
- `POST /v1/free-time/trigger` 使用 `{ "manual": true }` 可用于调试，但暂停状态仍然优先。
- 调度目标完成行动后，通过 `PUT /v1/free-time/runs/:runId/outcome` 回写 `summary`、可选的 `valence / arousal` 与 `completedAt`。只有完成且有摘要的运行会出现在休闲页“今天做了什么”中；未回写的 queued/dispatched 记录不会被伪装成已执行。
- Web Push 的 VAPID 私钥只存在服务器环境文件中。前端仅取得公钥并上传浏览器生成的 Push Subscription；设置页可启用、测试、关闭当前设备，并同步纸条/自由时间开关、锁屏内容预览和静默时段。自由时间只有在运行状态真实变为 `completed` 后才发送通知。
- 通知点击后优先唤醒已打开的 Ocean 并跳转客厅；没有现存窗口时打开已安装 PWA。失效订阅在推送服务返回 `404/410` 时自动清理。
- 内置调度使用 `FREE_TIME_PROVIDER_ID` 与 `FREE_TIME_MODEL_ID` 指定独立模型。手动触发可直接执行；只有显式设置 `FREE_TIME_AUTO_DISPATCH=enabled` 才允许定时器产生模型调用。每次运行保存 action、模型、输入/输出/缓存 token、费用、摘要及 V/A；阅读只取当前章节快照，钓鱼命令交给已连接的个人游戏引擎，未注册能力不会进入提示词或模型工具。

旧的 Windows 自动触发脚本只作为规则和语气迁移参考，不再作为 PWA 的运行依赖。旧脚本中若存在硬编码通知或服务凭据，应轮换后迁移到服务端环境变量，不能复制进 Ocean 仓库。
