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
| 11 | 飞书 Adapter MVP | 🔲 待开始 | ✅ 设计完备 (channel-platforms.md §7.2) | Step 10 |

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
- `onMessage` 回调签名为 `void`，实际传入 async 函数 — 语义正确（fire-and-forget），handleMessage 内部全路径 catch 保证不泄漏 rejection
- `runChannelTurn` 与 session.ts `runManagedTurn` 模式相似但未共享 — I/O 路径不同（Push delta to WS vs. Collect-then-send to channel），共享会引入 flag coupling
- DM 归组当前带 channelId 前缀（无跨通道漫游）— 漫游需要用户身份联邦，不改签名只改映射逻辑

### Step 11: 飞书 Adapter MVP

**目标：** 首个真实社交通道。设计详情见 channel-platforms.md §7.2。

**做什么（MVP）：**
- `FeishuAdapter` 实现 `ChannelAdapter` 核心接口
- `@larksuiteoapi/node-sdk` WSClient 长连接（不需要公网 IP）
- EventDispatcher 事件接收 → 消息去重 → InboundMessage 标准化 → ctx.onMessage()
- 卡片 Markdown 消息回复（agent 输出 → 飞书卡片 Markdown）
- 飞书配置项（appId / appSecret / domain）加入 zhixing.config.json

**不做（后续增量）：**
- StreamableChannel（流式卡片 — 增量 1）
- ApprovableChannel（审批卡片 — 增量 2）
- ReactableChannel（ACK 表情回执 — 增量 3）
- 群聊策略（groupPolicy / requireMention — 增量 3）
- Webhook 模式

**交付：**
```
packages/channels/feishu/       # 新包 @zhixing/channel-feishu
  ├── package.json
  ├── src/
  │   ├── adapter.ts            # FeishuAdapter
  │   ├── client.ts             # SDK 封装 + 重试 + token 管理
  │   ├── events.ts             # WSClient 事件 → InboundMessage
  │   ├── cards.ts              # 卡片 JSON 2.0 构建
  │   ├── format.ts             # Markdown → 飞书卡片 Markdown
  │   ├── dedup.ts              # 消息去重（messageId TTL）
  │   ├── config.ts             # 配置类型定义
  │   └── index.ts
```

**验证：** 飞书 DM 发消息 → zhixing 回复卡片 Markdown 消息

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
