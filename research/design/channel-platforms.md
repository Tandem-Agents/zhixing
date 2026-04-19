# 通道平台调研（Channel Platforms）

> 可用的 IM/通讯平台 Bot API 全景。本文档持续更新，各平台具体接入细节在对应章节追加。

**调研时间：** 2026-04-19
**调研来源：** 各平台官方文档 · npm 生态数据 · OpenClaw/Hermes 源码 · 社区实践

---

## 一、全景对比

> ⚠️ 本表为初步调研汇总，各平台在进入实施阶段前需独立确认最新信息。已确认 ✅ / 待确认 ⏳

| 平台 | 归属 | Bot API | 推荐协议 | Node.js SDK | 企业认证 | 主动推送 | 流式回复 | 优先级 | 状态 |
|------|------|---------|---------|-------------|---------|---------|---------|--------|------|
| **钉钉** | 阿里 | 官方 | Stream 长连接 | `dingtalk-stream-sdk-nodejs` | 否（可建测试企业） | **是** | 需自行分段 | **P0** | ⏳ |
| **飞书** | 字节 | 官方 | WebSocket 长连接 | `@larksuiteoapi/node-sdk` | 否（有免费版） | **是** | **流式卡片（原生）** | **P0** | ✅ |
| **企业微信** | 腾讯 | 官方 | WebSocket (aibot) | `@wecom/aibot-node-sdk` | **是** | **是** | **原生支持** | **P1** | ⏳ |
| **微信个人号 (iLink)** | 腾讯 | **官方（2026.3）** | HTTP 长轮询 | 社区 SDK | 否 | **否（被动）** | 否 | **P2** | ✅ |
| 微信公众号 | 腾讯 | 官方 | HTTP 回调 | 社区包 | 服务号需要 | 否（48h 窗口） | 否 | P3 | ⏳ |
| QQ | 腾讯 | 官方 | WebSocket | 官方 NodeSDK | 群聊需要 | 否（2025.4 起） | 否 | P3 | ⏳ |

---

## 二、企业/协作平台（详细）

### 2.1 钉钉 DingTalk（阿里巴巴）

> ⏳ 待独立调研确认。以下为初步信息，实施前需验证。

**初步信息（来源：官方文档初读 + Hermes 源码）：**
- 用户规模：月活 ~2 亿，注册 ~7 亿
- 推荐模式：Stream 长连接（免公网 IP）
- SDK：`dingtalk-stream-sdk-nodejs`（官方）
- 认证门槛：可免费创建"测试企业"
- 回复机制：sessionWebhook

**实施前需确认：** Stream SDK 的 Node.js API 稳定性、sessionWebhook 生命周期、主动推送能力细节、速率限制、流式消息支持现状

---

### 2.2 飞书 Feishu / Lark（字节跳动）

**用户规模：** 月活 ~3000 万（三平台最小，但开发者生态最好）

**两种机器人类型：**

| 类型 | 能力 | 说明 |
|------|------|------|
| **企业自建应用机器人（推荐）** | **收发消息、主动 DM、群聊、流式卡片** | 需企业管理员审批发布，支持完整 API |
| 自定义 Webhook 机器人 | 仅出站推送 | 群内添加，不能接收消息，不能 DM |

**三种事件接收模式：**

| 模式 | 方向 | 需公网 IP | 说明 |
|------|------|----------|------|
| 自定义 Webhook 机器人 | 仅出站 | 否 | 群内添加，outbound-only |
| **WebSocket 长连接（推荐）** | **双向** | **否** | `WSClient`，SDK >= 1.24.0 |
| HTTP 回调 | 双向 | 是 | 传统 webhook |

**Node.js SDK：**
- `@larksuiteoapi/node-sdk` — **npm 周下载 ~1.1M**（三平台最高，含国际版 Lark 贡献）
- 99.9% TypeScript，SDK 质量公认最好
- 支持 `EventDispatcher` + `WSClient` 长连接
- GitHub 258 stars

**认证门槛：** 低。飞书免费版即可创建企业自建应用，个人开发者可用。

**主动推送能力：** 企业自建应用机器人可向可用范围内的用户**主动发起单聊**和群消息。

**流式卡片更新（CardKit Streaming）：**
- 原生"打字机效果" — 专为 AI 场景设计
- 流程：创建卡片实体（`streaming_mode: true`）→ 发送卡片消息 → 流式推送文本 → 关闭流式模式
- 流式期间无 QPS 限制（非流式时 10 ops/s/card）
- 需 JSON 2.0 卡片结构 + 飞书客户端 7.20+
- 10 分钟未关闭自动结束
- 流式期间卡片不可转发、不响应交互回调

**速率限制：**
- 单群消息：最大 5 QPS
- 批量发送：每应用每日 50 万条
- 卡片消息内容：JSON ≤ 30KB / Protobuf ≤ 100KB

**关键限制：**
- 长连接模式消息处理需 **3 秒内完成**，否则触发超时重推（卡片回调同理）
- 集群部署下只有一个随机客户端收到消息（不支持广播）
- 外部用户交互需企业认证

**与 ChannelAdapter 映射：**
- `connect()` → `WSClient` 建立 WebSocket 长连接
- `ctx.onMessage()` → `EventDispatcher` 事件回调（`im.message.receive_v1`）
- `send()` → `client.im.message.create()`（支持 Interactive Card）
- `disconnect()` → 关闭 WSClient
- `StreamableChannel` trait → **流式卡片原生支持**（createStreamMessage → 创建 streaming card，updateStream → 推送文本，finalizeStream → 关闭流式模式）

**规格引用：** server-gateway.md §8.2

---

### 2.3 企业微信 WeCom（腾讯）

> ⏳ 待独立调研确认。以下为初步信息，实施前需验证。

**初步信息（来源：官方文档初读 + npm 生态数据）：**
- 用户规模：月活 ~1 亿
- 推荐模式：aibot 智能机器人（WebSocket 长连接，2025 年推出）
- SDK：`@wecom/aibot-node-sdk`（官方）
- 认证门槛：需企业微信企业资质认证（硬性前提）
- 特色：原生流式回复

**实施前需确认：** aibot SDK API 细节、WebSocket 协议具体行为、企业认证最低要求、速率限制、主动推送能力范围

---

## 三、消费者平台

### 3.1 微信公众号（服务号/订阅号）

> ⏳ 待独立调研确认。初步判断 P3 — 5 秒超时 + 48h 窗口是 AI 助手的结构性限制。

### 3.2 QQ 机器人

> ⏳ 待独立调研确认。初步判断 P3 — 2025 年起取消主动推送 + 需企业主体。

### 3.3 微信个人号 — iLink Bot 协议（腾讯官方）

**重大变化（2026 年 3 月）：** 腾讯通过 iLink（智联）平台首次为微信个人号提供官方 Bot API，随 WeChat ClawBot 插件发布。

#### 协议概览

| 项目 | 详情 |
|------|------|
| 基础 URL | `https://ilinkai.weixin.qq.com` |
| 协议 | HTTP/JSON（无 SDK 亦可直接 fetch 调用） |
| 消息接收 | HTTP 长轮询 `getupdates`（35 秒超时） |
| 消息发送 | REST POST `sendmessage` + `context_token` 关联 |
| 认证方式 | 微信扫码登录（QR Code），获得 Bearer Token |
| 鉴权头 | `AuthorizationType: ilink_bot_token` + `X-WECHAT-UIN`（每请求随机） |
| 媒体加密 | AES-128-ECB + CDN 上传/下载 |
| 消息类型 | 文本、图片、语音、视频、文件 |
| 单消息上限 | 4000 字符 |
| 打字提示 | 支持（`sendtyping` + `typing_ticket`，TTL ~24h） |

#### 核心机制 — context_token

- 每条入站消息携带该对话对端的 `context_token`
- **每条出站消息必须回传对应 peer 的最新 `context_token`**
- 本质是 per-peer 的会话状态绑定 — 无 token 则消息无法路由
- 需本地持久化（按 `account_id:user_id` 键值对存储）
- **静默失败风险：`sendmessage` 即使缺少 token 也返回 HTTP 200 + `{}`，不报错**

#### 登录流程

1. GET `get_bot_qrcode?bot_type=3` → 返回二维码
2. 用户微信扫码
3. 轮询 `get_qrcode_status` → `wait` → `scaned` → `confirmed`
4. 确认后获得 `bot_token`、`base_url`、`account_id`、`user_id`

#### ⚠️ 结构性短板（影响优先级判定）

| 短板 | 影响 | 对 zhixing 的意义 |
|------|------|------------------|
| **不能主动推送** | Bot 必须先收到用户消息，拿到 `context_token` 后才能回复。无法主动发起对话 | Scheduler 定时任务、提醒推送、背景 Agent 结果 — **全部无法通过此通道投递** |
| **24 小时 session 过期** | 用户超过 ~24h 未发消息 → `context_token` 失效（错误码 -14）→ Bot 等同下线 | 用户必须每天至少发一条消息保持连接，否则助手"消失" |
| **灰度发布中** | ClawBot 插件尚未全量开放，逐步放量。未灰度到的用户无法使用 | 初期无法保证目标用户都能接入 |
| **Markdown 渲染差** | 微信消息框的 Markdown 支持极有限 | Agent 输出的格式化内容（代码块、表格等）展示受损 |
| **无官方速率限制文档** | 腾讯保留随时限流/停服的权利，无 SLA | 生产环境稳定性无保障 |
| **协议稳定性** | 上线 72 小时内因 OpenClaw 版本更新导致全面不可用（已修复） | 协议仍在快速迭代中，breaking change 风险 |

**以下不构成短板：**
- 仅移动端 — zhixing 面向个人用户，移动端即主场景
- 仅 1:1 私聊 — zhixing 定位为个人 AI 助手，私聊即核心交互形态

#### 积极面

- **官方协议** — 合法合规，无封号风险，有《微信 ClawBot 功能使用条款》法律保障
- **13 亿用户触达** — 覆盖中国最大即时通讯用户群（灰度全量后）
- **零认证门槛** — 个人微信扫码即可，无需企业资质
- **协议简单** — 纯 HTTP/JSON，无需 SDK 即可对接
- **社区生态活跃** — 已有多语言 SDK（Node.js / Python / Go / Rust）、管理平台（openilink-hub）
- **打字指示器** — 唯一支持 TypingChannel trait 的平台

#### SDK 生态

| 包 | 性质 | 说明 |
|---|------|------|
| `@tencent-weixin/openclaw-weixin` | 腾讯官方 | OpenClaw 插件，非独立 SDK。v2.0.x 需 OpenClaw ≥ 2026.3.22 |
| `wechat-ilink-client` | 社区（MIT） | **独立 TypeScript 客户端**，零运行时依赖，Node ≥ 20。40 stars，早期阶段 |
| `@wechatbot/wechatbot` | 社区 | Node.js SDK，corespeed-io 出品 |
| `wechatbot-sdk` (Python) | 社区 | Python SDK |
| `wechat-robot-go` | 社区 | Go SDK |

**参考实现：** Hermes Agent `gateway/platforms/weixin.py`（~1670 行 Python，协议版本 2.2.0）

#### 适配评估

**可行但受限（P2）。** 作为"被动应答"通道完全可行 — 用户问、Bot 答。但 zhixing 作为 **持久化个人 AI 助手**，核心价值之一是主动服务（Scheduler 推送、背景 Agent 通知），而 iLink 的"不能主动推送 + 24h 过期"恰好砍掉了这些能力。

**建议策略：** 企业平台三件套（钉钉/飞书/企微）优先 → iLink 作为 C 端扩展通道接入 → 利用跨通道投递能力弥补（如定时任务结果推送到钉钉，但保留微信作为日常 Q&A 入口）。

---

## 四、与 zhixing ChannelAdapter 架构的映射

各平台的长连接 / 长轮询模式与 `ChannelAdapter` 核心接口天然吻合：

```
ChannelAdapter.connect()     ←→ 建立长连接 / 启动轮询循环
ChannelAdapter.disconnect()  ←→ 关闭长连接 / 停止轮询
ChannelAdapter.send()        ←→ 平台消息发送 API
ChannelContext.onMessage()   ←→ 平台消息回调事件 / 轮询消息派发
```

**已确认的平台映射：**

飞书 ✅：
- `connect()` → `WSClient` 建立 WebSocket 长连接
- `ctx.onMessage()` → `EventDispatcher` 事件回调（`im.message.receive_v1`）
- `send()` → `client.im.message.create()`（支持 Interactive Card + 流式卡片）
- `disconnect()` → 关闭 WSClient

微信 iLink ✅（⚠️ 注意限制）：
- `connect()` → QR 码扫码登录 + 启动 `getupdates` 长轮询循环
- `ctx.onMessage()` → 轮询到消息后派发（需缓存 per-peer `context_token`）
- `send()` → REST `sendmessage`（必须附带对应 peer 的 `context_token`）— **仅回复有效，不能主动推送**
- `disconnect()` → 停止轮询循环
- ⚠️ Delivery Pipeline 无法通过此通道投递（无 `context_token` 则无法 send）

**Capability Traits 映射（仅含已确认平台）：**

| Trait | 飞书 ✅ | 微信 iLink ✅ |
|-------|--------|-------------|
| EditableChannel | 是（更新消息卡片） | 否 |
| StreamableChannel | **是（流式卡片 CardKit）** | 否 |
| ApprovableChannel | 是（Interactive Card） | 否 |
| ThreadableChannel | 是（话题群/回复） | 否 |
| TypingChannel | 否 | **是（原生）** |

> 钉钉、企微的映射待各自独立调研后补充。

---

## 五、优先级建议与实施节奏

```
P0  飞书 Adapter ✅         — SDK 质量最好，原生流式卡片，WSClient 免公网，支持主动推送
P0  钉钉 MVP ⏳             — 用户基数最大，接入门槛低（待独立确认）
P1  企业微信 Adapter ⏳     — 原生流式回复，但需企业认证（待独立确认）
P2  微信个人号 (iLink) ✅   — 13 亿用户，但不能主动推送 + 24h 过期，只适合被动应答
P3  微信公众号 ⏳           — 结构性限制重（待独立确认）
P3  QQ ⏳                   — 结构性限制重（待独立确认）
```

**优先级排序逻辑 — "主动推送"是分水岭：**

zhixing 定位为**持久化个人 AI 助手**，核心特性包括：
1. 用户提问 → Agent 回答（被动应答 — 所有通道都支持）
2. Scheduler 定时任务 → 结果推送到用户（**需要主动推送能力**）
3. 背景 Agent 完成 → 通知用户（**需要主动推送能力**）

能力 2 和 3 是 zhixing 区别于普通 chatbot 的关键差异化。因此：
- **P0（飞书 ✅ / 钉钉 ⏳）**：支持主动推送 → 完整支持 zhixing 全部特性
- **P2（iLink ✅）**：不能主动推送 → 只能做 Q&A 入口，Scheduler/Agent 通知需走其他通道

**iLink 定级 P2 的理由（✅ 已确认）：**
- 积极面：腾讯官方协议、13 亿用户覆盖、零认证门槛、协议简单、社区 TypeScript 客户端可用
- 短板：不能主动推送、24h session 过期、灰度发布中、协议稳定性待验证

---

## 六、合规注意事项

2025 年 12 月国家网信办发布《人工智能拟人化互动服务管理暂行办法（征求意见稿）》：
- 交互界面须显著标注"您正在与人工智能进行互动"
- 自研/微调模型独立对外服务需大模型备案
- 涉及特定内容（音乐、视频等）需额外行业许可证

zhixing 当前使用第三方 LLM API（非自研模型），合规负担较轻，但公开部署时需关注最终生效版本。

---

## 七、各平台具体接入（按实施顺序追加）

### 7.1 钉钉接入详情

> 待 Step 11 实施时填充

### 7.2 飞书接入详情

> ✅ 调研完成（2026-04-19）。基于 Hermes feishu.py（3619 行）、OpenClaw openclaw-lark（TypeScript，2000 stars）、ZeroClaw Lark channel（Rust）三套实现分析。

#### 7.2.1 现有实现分析

**三套参考实现的核心差异：**

| 维度 | Hermes Agent (Python) | OpenClaw Lark (TypeScript) | ZeroClaw (Rust) |
|------|----------------------|---------------------------|-----------------|
| 流式回复 | ❌ 不支持 | ✅ 流式卡片（CardKit） | ❌ 编辑消息模拟 |
| 消息去重 | 24h TTL + LRU 持久化 | 未知 | 未知 |
| 消息批次合并 | ✅ 文本 0.6s + 媒体 0.8s | ❌ | ❌ |
| 安全审批卡片 | ✅ 4 按钮（允许一次/会话/永久/拒绝） | ✅ 确认按钮 | ❌ |
| Per-chat 串行 | ✅ asyncio.Lock per chat_id | ✅ createChatQueue | ❌ |
| Webhook 安全 | SHA256 签名 + 验证 token + IP 限流 | 验证 token | 未知 |
| 多账号 | ❌ | ✅ accounts.\<id\> | ❌ |
| ACK 表情回执 | ✅ 收到消息加 OK 表情 | ✅ 可配置 | ✅ locale-aware |
| 群聊策略 | allowlist / blacklist / disabled | allowlist / open / disabled | allowed_users |
| 格式降级 | post → text 自动回退 | 未知 | 卡片 markdown 截断 |

**现有实现的共同短板：**

1. **流式体验不完整** — Hermes 完全没有流式；OpenClaw 有流式卡片但 Issue #384 表明是后加的，block-level streaming（分段发）是默认，token-level streaming（打字机）需额外开启
2. **Agent 执行过程不透明** — 用户发送消息后只能等待最终结果，看不到 Agent 正在做什么（搜索、思考、调工具）
3. **错误恢复粗糙** — 发送失败要么静默丢弃要么返回通用错误文本，无重试引导
4. **对话上下文割裂** — 飞书侧看到的是消息流，无法感知 zhixing 内部的对话状态（是否在队列等待、是否正在处理）

#### 7.2.2 zhixing 飞书 Adapter 设计

**设计原则：** 不做"又一个聊天机器人"，做"在飞书里的 AI 助手工作台"。

**核心差异化：**

| 能力 | 现有实现 | zhixing 设计 |
|------|---------|-------------|
| 回复体验 | 等待 → 一次性返回 / 分段发 | **流式卡片**：即时 → 打字机效果 → 最终结果 |
| 过程透明 | 无 | **状态卡片**：Thinking → Calling tool X → Generating |
| 安全审批 | 简单按钮卡片 | 复用 zhixing ConfirmationModule → **飞书 Interactive Card 渲染** |
| 主动推送 | 各自实现 | 复用 zhixing Delivery Pipeline → **adapter.send() 投递** |
| 队列反馈 | 无 / "请稍后" | **入队即回执**：立即发送"正在处理…"状态卡片 |
| 消息去重 | 各自实现 | 复用 InboundMessage.messageId + Router 层去重 |

**架构分层：**

```
@zhixing/channel-feishu
├── adapter.ts          # FeishuAdapter — 实现 ChannelAdapter + StreamableChannel + EditableChannel + ApprovableChannel + ReactableChannel
├── client.ts           # FeishuClient — 封装 @larksuiteoapi/node-sdk，统一 API 调用 + 重试 + token 管理
├── events.ts           # 事件分发 — WSClient/EventDispatcher → InboundMessage 标准化
├── cards.ts            # 卡片构建器 — 流式卡片、状态卡片、审批卡片的 JSON 2.0 结构生成
├── format.ts           # 内容格式化 — Agent 输出 Markdown → 飞书卡片 Markdown 子集
├── dedup.ts            # 消息去重 — messageId TTL 缓存（内存，可选持久化）
├── config.ts           # 配置定义 — appId/appSecret/domain/groupPolicy 等
└── index.ts            # 导出
```

**关键设计决策：**

**1. 流式卡片（StreamableChannel 实现）**

```
用户发消息 → InboundRouter 收到
  ↓
InboundRouter 调 adapter.createStreamMessage(target)
  ↓
cards.ts 创建 streaming card（streaming_mode: true）
client.ts 发送初始卡片 → 返回 StreamHandle { card_id, message_id }
  ↓
Agent 执行中 → StreamHandle.update(partialText)
  → cards.ts 调 stream text API（增量推送，飞书自动计算 diff 逐字渲染）
  ↓
Agent 完成 → StreamHandle.finalize(fullContent)
  → cards.ts 设 streaming_mode: false → 更新为最终卡片（含完整格式化内容）
  ↓
Agent 出错 → StreamHandle.abort()
  → 更新卡片为错误状态
```

对比现有实现：Hermes 无流式；OpenClaw 有流式但作为可选配置且晚于核心功能加入。zhixing 将流式作为**默认且唯一**的回复模式 — 每条回复都是一张卡片，从创建到完成全程流式。

**2. 状态可见性（过程透明）**

在流式卡片的 header 区域显示当前 Agent 状态：

| Agent 阶段 | 卡片 Header | 颜色 |
|-----------|------------|------|
| 已入队等待 | ⏳ 排队中… | grey |
| 正在思考 | 🤔 思考中… | blue |
| 调用工具 | 🔧 正在搜索… / 正在执行… | blue |
| 正在生成 | ✍️ 生成中… | blue |
| 完成 | ✅ 完成 | green |
| 错误 | ❌ 出错 | red |

这需要 InboundRouter 与 Agent runtime 之间有 delta/event 机制。当前 `runtime.run()` 返回 `AsyncGenerator<AgentDelta, AgentResult>` — 流式卡片消费 delta 中的 text chunk 和 tool_call 事件。

**3. 审批卡片（ApprovableChannel 实现）**

复用 zhixing 已有的 `ConfirmationModule`，在飞书渲染为 Interactive Card：

```
ConfirmationRequest → cards.ts 构建审批卡片（命令预览 + 允许/拒绝按钮）
  → client.ts 发送卡片
  ↓
用户点击按钮 → 飞书 card action 回调
  → events.ts 拦截 action，解析 approval_id
  → ApprovalHandle.onDecision() 回调 → ConfirmationModule 解决等待
  → cards.ts 更新卡片为已审批状态
```

对比 Hermes：同样的 4 按钮模式，但 Hermes 用自建的 approval 状态管理。zhixing 直接复用 ConfirmationModule 的 Promise-based 等待机制，不重复造轮子。

**4. 3 秒超时应对策略**

飞书长连接模式要求 3 秒内完成消息处理。策略：

- EventDispatcher 回调内**只做标准化 + 去重 + 转发**，不做 Agent 执行
- `ctx.onMessage(inboundMsg)` 是 fire-and-forget，立即返回
- Agent 处理在 InboundRouter 的 enqueue 流程中异步执行
- 这与 Hermes 的策略一致（用 `asyncio.run_coroutine_threadsafe` 脱离回调线程）

**5. 格式化降级（format.ts）**

Agent 输出标准 Markdown → 飞书卡片 Markdown 子集的转换：

- 代码块：保留（飞书支持）
- 表格：转换为缩进列表（飞书卡片 Markdown 不支持表格渲染）
- 标题：`#` → 飞书 Markdown header
- 超长消息：按 8000 字符截断，分多张卡片（Hermes 策略，已验证可行）

对比 Hermes：Hermes 用 post 格式（富文本嵌套数组），格式复杂且经常触发 API 拒绝需要回退到纯文本。zhixing 统一用卡片 Markdown — 格式能力更强且飞书主推。

**6. 消息去重（dedup.ts）**

飞书长连接在超时时会重推消息，必须去重：

- 基于 `message_id` 的 TTL 缓存（默认 24h，与 Hermes 一致）
- LRU 淘汰（默认上限 2048 条）
- 可选持久化到磁盘（跨重启保持去重状态）

**7. ACK 回执（ReactableChannel 实现）**

收到消息后立即添加 emoji 表情反应（如 ✅），让用户知道消息已被接收：

- 轻量级 — 不占用消息流
- 与流式卡片互补 — 表情秒回 + 卡片逐步更新
- Hermes 和 OpenClaw 都已验证此模式的用户体验

**8. 配置项设计**

```typescript
interface FeishuChannelConfig {
  appId: string;
  appSecret: string;
  domain?: "feishu" | "lark";             // 默认 feishu
  connectionMode?: "websocket" | "webhook"; // 默认 websocket

  // 访问控制
  dmPolicy?: "open" | "allowlist";         // 默认 allowlist
  allowedUsers?: string[];                 // open_id 列表
  groupPolicy?: "open" | "allowlist" | "disabled"; // 默认 disabled
  allowedGroups?: string[];                // chat_id 列表
  requireMention?: boolean;                // 群聊需 @bot，默认 true

  // 行为调优
  ackReaction?: string | false;            // 收到消息的回执 emoji，false 禁用
  dedupTtlMs?: number;                     // 去重缓存 TTL，默认 86400000 (24h)
  dedupMaxSize?: number;                   // 去重缓存上限，默认 2048
  maxMessageLength?: number;               // 单消息截断长度，默认 8000

  // Webhook 模式专用
  webhookPath?: string;
  encryptKey?: string;
  verificationToken?: string;
}
```

#### 7.2.3 与 zhixing 架构的集成点

| zhixing 模块 | 集成方式 |
|-------------|---------|
| `ChannelAdapter` 接口 | FeishuAdapter 实现 connect/disconnect/send |
| `StreamableChannel` trait | 通过 CardKit Streaming API 实现 createStreamMessage → StreamHandle |
| `EditableChannel` trait | 通过 message.update API 实现 editMessage |
| `ApprovableChannel` trait | 通过 Interactive Card + action 回调实现 renderApproval → ApprovalHandle |
| `ReactableChannel` trait | 通过 reaction API 实现 addReaction/removeReaction |
| `InboundRouter` | onMessage → handleMessage → runChannelTurn（已实现） |
| `ConversationBinder` | DM → per-user / Group → per-group（已实现） |
| `ConfirmationModule` | ApprovableChannel.renderApproval 桥接 |
| `Delivery Pipeline`（未来） | adapter.send() 直接投递 Scheduler 结果 |

#### 7.2.4 实施计划

**MVP（最小可行）：**
- FeishuAdapter：connect（WSClient）+ disconnect + send（卡片 Markdown）
- events.ts：EventDispatcher → InboundMessage 标准化 + 去重
- format.ts：基础 Markdown → 飞书卡片 Markdown
- config.ts：appId / appSecret / domain
- 验证：飞书 DM 发消息 → zhixing 回复卡片消息

**增量 1 — 流式体验：**
- cards.ts：流式卡片构建器
- StreamableChannel 实现
- InboundRouter 改造：消费 AgentDelta 推送到 StreamHandle

**增量 2 — 安全审批：**
- cards.ts：审批卡片构建器
- ApprovableChannel 实现
- events.ts：card action 回调拦截

**增量 3 — 群聊 + 访问控制：**
- groupPolicy / allowedUsers / requireMention
- ACK 表情回执（ReactableChannel）

### 7.3 企业微信接入详情

> 待实施时填充

### 7.4 微信个人号 (iLink) 接入详情

**协议调研已完成（见 §3.3）。以下为实施时的技术决策点：**

**SDK 选型：**
- 首选 `wechat-ilink-client`（MIT，TypeScript，零依赖，独立于 OpenClaw）
- 备选：直接基于 Hermes `weixin.py` 协议移植（~1670 行 Python → TypeScript）
- `@tencent-weixin/openclaw-weixin` 是 OpenClaw 插件，不适合独立使用

**实施前需确认：**
- `wechat-ilink-client` 的 API 稳定性和覆盖度（目前 40 stars，2 commits，早期阶段）
- `context_token` 持久化方案（per-peer 键值对，需与 zhixing 配置目录集成）
- 扫码登录 UX（Server 模式下如何展示二维码 + 等待确认 — 可能需要 REST 端点暴露二维码）
- AES-128-ECB 媒体加解密（Node.js `crypto` 模块原生支持，不需要额外依赖）
- 24 小时 session 过期的自动恢复策略

**架构特殊点：**
- iLink Adapter 的 `send()` 需要维护 per-peer `context_token` 缓存 — 这比其他 Adapter 多一个状态层
- Delivery Pipeline 不能直接使用此通道 — 需要 `ChannelCapabilities` 中标记"不支持主动推送"
- 长轮询循环需要 AbortSignal 配合 `disconnect()` 优雅停止

**腾讯微信 AI 生态的其他路线（参考，不影响 iLink 实施）：**

| 路线 | 说明 | 与 zhixing 的关系 |
|------|------|------------------|
| iLink Bot | 个人号官方 Bot API，HTTP 长���询 | **直接接入 — ChannelAdapter** |
| 企业微信 aibot | 企微 AI 机器人 WebSocket 长连接 | 已覆盖（§2.3 企业微信 Adapter） |
| 腾讯元器 | 零代码 AI Agent 平���，托管运行 | 竞品/互补，非接入目标 |
| openilink-hub | 开源 iLink 管理平台 + App 市场 | 参考架构，非依赖 |
