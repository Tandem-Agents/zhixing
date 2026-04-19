# 实现路线图 (Implementation Roadmap)

> 连接设计规格与代码实现的执行计划。已完成的 Step 只保留状态行，细节见 git history。

## 主线脉络

```
persistent-service.md 原始路线:
  S1 ✅ Scheduler → S2 ✅ Server → S2.7 对话模型(大部分✅) → S5 Channel → S3 Delivery → S2.5 Orchestrator

调整说明:
  S5 Channel Adapter 提前至 S2.7 之后 — 这是让 Server 拥有真实用户的关键特性。
  S3 Delivery Pipeline 推迟 — MVP 只需同步回复，异步投递(Scheduler→通道)按需追加。
  S2.5 AgentOrchestrator 推迟 — 背景Agent能力需要先有活跃用户基础。
```

**规格引用：** [conversation-model.md](specifications/conversation-model.md) · [context-architecture.md](specifications/context-architecture.md) · [persistent-service.md](specifications/persistent-service.md) · [server-gateway.md](specifications/server-gateway.md)

---

## 状态总览

### S2.7 对话模型统一（大部分完成）

| Step | 名称 | 状态 | 依赖 |
|------|------|------|------|
| 0 | 词汇对齐 | ✅ | 无 |
| 1 | ConversationRepository | ✅ | Step 0 |
| 2 | TranscriptStore 适配 | ✅ | Step 0, 1 |
| 3 | CLI 对接 Conversation | ✅ | Step 2 |
| 4 | ScenarioEvaluator + ContextProfile | ✅ | Step 0 |
| 5 | LayerAssembler + TurnDigest | ✅ | Step 4 |
| 6 | WindowManager + Pinning | ✅ | Step 5 |
| 7 | ConversationManager + SessionRuntime | ✅ | Step 3, 6 |
| 7a | PendingQueue 并发互斥 | ✅ | Step 7 |
| 7b | TranscriptStore 集成 + AbortSignal | ✅ | Step 7a |
| 8a | Ephemeral + recordTurn + promote | ✅ | Step 7b |

### S5 Channel Adapter（下一主线）

| Step | 名称 | 状态 | 设计状态 | 依赖 |
|------|------|------|---------|------|
| 9 | Channel 接口层 + Registry | ✅ | ✅ 设计完备 (server-gateway.md §4) | Step 8a |
| 10 | InboundRouter + Server 集成 | ✅ | ✅ 设计完备 (server-gateway.md §6) | Step 9 |
| 11 | 飞书 Adapter MVP | ✅ | ✅ 设计完备 (channel-platforms.md §7.2) | Step 10 |

### 延后 / 可选

| Step | 名称 | 状态 | 说明 |
|------|------|------|------|
| 3b | Transcript 段轮转 | 🔲 延后 | 内部优化，文件膨胀时再做 |
| 8b | Ephemeral 接入点 | ❌ 跳过 | CLI -p 已天然不落盘，Server 等有流量再做 |
| 8c | /delete 命令 | 🔲 可选 | REPL 卫生，不阻塞主线 |
| 8d | 移除 -c/-r 启动参数 | 🔲 可选 | CLI 清理，不阻塞主线 |

---

## 待实施

### Step 9: Channel 接口层 + Registry ✅

已完成。交付 `packages/core/src/channels/`（types / capabilities / registry / index），32 项单测通过。

**已知偏离（有意裁剪，Step 10 按需补齐）：**
- `ChannelContext` 省略 3 个 connection 管理方法（registerConnection / unregisterConnection / subscribe）— 钉钉 MVP 用 sessionWebhook 单次回复，不需要 connection 管理
- `ChannelCapabilities` 声明与 Trait guard 双轨检测 — capabilities 用于信息展示，guard 用于运行时路由，后续可加 `validateCapabilities()` 校验

### Step 10: InboundRouter + Server 集成 ✅

已完成。交付 `packages/server/src/channels/`（conversation-binder / inbound-router），19 项新测试 + 全部 194 项服务端测试通过。

**交付内容：**
- `ConversationBinder`：InboundMessage → conversationId 归组（DM per-user / group per-group / thread per-thread）
- `InboundRouter`：完整管道 — 归组 → getOrCreate → enqueue → agent turn → adapter.send()
- `TurnSource` 类型：Turn.source 字段（P1 技术债务清除）
- `ServerContext.channels` 字段 + server.ts 关闭时 dispose 通道

**已知设计取舍：**
- `onMessage` 回调签名为 `void`，实际传入 async 函数 — 语义为 fire-and-forget。Step 11 Phase B 在 `setupChannels` 中增加了 `.catch()` 防御性捕获
- `runChannelTurn` 与 session.ts `runManagedTurn` 模式相似但未共享 — I/O 路径不同（Push delta to WS vs. Collect-then-send to channel），共享会引入 flag coupling
- DM 归组当前带 channelId 前缀（无跨通道漫游）— 漫游需要用户身份联邦，不改签名只改映射逻辑

### Step 11: 飞书 Adapter MVP ✅

已完成。分两个阶段交付：Phase A（适配器包）+ Phase B（系统接线）。

**Phase A — `@zhixing/channel-feishu` 包：**

交付 `packages/channels/feishu/`，7 个源文件 + 7 个测试文件，66 项单测通过。
- `FeishuAdapter`：connect / disconnect / send，capabilities 诚实声明（streaming:false, edit:false, media:false）
- `FeishuClient`：lark.Client REST 封装 + `FeishuApiError` code-based retryable 分类（99991429/99991500/99991504 可重试）
- WSClient 长连接（`@larksuiteoapi/node-sdk` ≥ 1.60.0），不需要公网 IP
- EventDispatcher 事件接收 → messageId 去重（24h TTL, LRU max 2048）→ InboundMessage 标准化 → ctx.onMessage()
- Card JSON 2.0 卡片消息（6 种状态 + Markdown 内容）
- `toFeishuMarkdown`：Markdown 表格 → 项目列表转换 + 代码块保护 + UTF-16 surrogate pair 安全截断
- `resolveConfig`：完整边界验证（domain / dedupTtlMs / dedupMaxSize / botOpenId）
- connect() 原子性：WSClient.start() 失败时清理所有内部状态
- AbortSignal 集成：信号触发时自动关闭 WSClient

**Phase B — 系统接线：**

6 个文件变更，打通 `zhixing serve` → 飞书消息接收 → Agent 处理 → 卡片回复全链路。
- `providers/src/types.ts`：新增 `ChannelConfigEntry` 类型 + `ZhixingConfig.channels` 字段
- `providers/src/config-loader.ts`：`deepMergeConfig` 支持 channels 按 key 字段级合并
- `cli/package.json`：添加 `@zhixing/channel-feishu` 工作区依赖
- `cli/src/serve/channels.ts`（新文件）：适配器工厂（动态 import）+ `setupChannels()` — 创建 ChannelRegistry + InboundRouter，逐通道注册连接，失败隔离
- `cli/src/serve/command.ts`：接线 — loadConfig → setupChannels → channels 注入 ServerContext → 启动横幅显示通道状态 → 启动失败时 dispose channels

**设计决策：**
- `ChannelConfigEntry` vs `ChannelConfig` 分离：用户级配置（可选字段多、type 可省略）vs runtime 级配置（完整字段），setupChannels 负责转换
- 动态 import 适配器：无通道配置时零加载成本，新增通道类型只需在 `ADAPTER_FACTORIES` 添加一行
- 通道失败隔离：单通道 connect 失败不阻塞其他通道和服务启动
- onMessage → InboundRouter.handleMessage 的 Promise 通过 `.catch()` 防御性捕获，防止进程级 unhandled rejection
- 启动失败路径 channels.dispose() 确保 WSClient 不泄漏

**不做（后续增量）：**
- StreamableChannel（流式卡片 — 增量 1）
- ApprovableChannel（审批卡片 — 增量 2）
- ReactableChannel（ACK 表情回执 — 增量 3）
- 群聊策略（groupPolicy / requireMention — 增量 3）
- Webhook 模式
- Credential `"env:"` / `"helper:"` 解析（见 P2 债务 #4）

**验证：** 待 E2E — 飞书 DM 发消息 → zhixing 回复卡片 Markdown 消息

---

## 已知技术债务

### P1-已解决

| # | 问题 | 解决时机 |
|---|------|---------|
| 1 | ~~TurnSource 参数缺失~~ | **Step 10** ✅ — Turn.source?: TurnSource 已添加 |

### P2-计划中

| # | 问题 | 影响 | 计划时机 |
|---|------|------|---------|
| 1 | session.abort 不中断当前 turn — 只影响下次 run() | **中** | Channel Adapter 阶段 |
| 2 | AgentRuntime.run() 不接受 AbortSignal — 底层 HTTP 继续执行 | **低** | Provider 层支持时 |
| 3 | promote() 并发 TOCTOU — 外部 promote 与 auto-promote 竞争 | **低** | 实现 /keep 时 |
| 4 | Channel credentials 无 `env:` / `helper:` 解析 — 用户必须明文写凭证 | **中** | 第二通道接入前，复用 Provider 已有的凭证解析逻辑到 setupChannels |
| 5 | loadConfig 在 serve 流程中重复加载 — command.ts 显式调用 + createProviderFromConfig 内部再调用 | **低** | RuntimeFactory 重构时 thread config 参数 |
| 6 | 同类型多实例通道配置会硬崩溃 — adapter.id 冲突无清晰诊断 | **低** | 多实例需求出现时，引入 instanceId 机制 |

---

## 后续路线（Step 11 之后）

| 方向 | 规格来源 | 优先级 | 说明 |
|------|---------|--------|------|
| 飞书增量能力 | channel-platforms.md §7.2 | **高** | 流式卡片、审批卡片、群聊策略、ACK 回执 |
| Delivery Pipeline | persistent-service.md §4.7 | **高** | Scheduler 任务结果 → 通道推送 |
| 钉钉 Adapter | server-gateway.md §8.1 | **高** | P0 第二社交通道（待独立调研确认） |
| AgentOrchestrator | persistent-service.md §3.6 | **中** | 背景 Agent、spawn/push、Monitor |
| Daemon 后台模式 | persistent-service.md §7 | **中** | --daemon + PID + CLI 远程连接 |
| 企业微信 Adapter | channel-platforms.md §2.3 | **中** | P1 原生流式回复，需企业认证 |
| 微信 iLink Adapter | channel-platforms.md §3.3 | **中低** | P2 C 端覆盖大但不能主动推送，仅被动应答 |
| OpenAI 兼容端点 | server-gateway.md §9 | **低** | /v1/chat/completions |
| Web UI | 待设计 | **低** | 浏览器交互界面 |
| OS 级服务安装 | persistent-service.md §7.3 | **低** | launchd / systemd |
