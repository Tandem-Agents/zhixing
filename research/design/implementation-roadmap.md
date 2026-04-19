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
| 10 | InboundRouter + Server 集成 | 🔲 待开始 | ✅ 设计完备 (server-gateway.md §6) | Step 9 |
| 11 | 钉钉 Adapter MVP | 🔲 待开始 | ⚠️ 需调研 | Step 10 |

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

### Step 10: InboundRouter + Server 集成

**目标：** server-gateway.md §6 — 通道消息进入 Agent 处理的完整路径

**做什么：**
- `InboundRouter`：normalize → conversation-bind → agent turn → result routing
- 对话归组（ChannelBindingPolicy）：DM 按用户归组，群按群归组
- 将 Channel 注册到 ServerContext，serve 命令启动时连接已注册通道
- 处理 P1 技术债务：Turn 增加 `source` 字段（interactive / scheduler / channel）
- Channel EventBus 事件（channel:connected / disconnected / message-received）

**不做：** 去抖（MVP 不需要）、DeliveryRouter（MVP 只做同步回复）

**交付：**
```
packages/server/src/
  ├── channels/
  │   ├── inbound-router.ts     # 入站路由
  │   └── conversation-binder.ts # 对话归组
  ├── context.ts                # ServerContext 新增 channels 字段
  └── server.ts                 # Channel 生命周期集成
```

**验证：** Mock ChannelAdapter + 集成测试：消息 → InboundRouter → Agent → 回复到 Mock adapter

### Step 11: 钉钉 Adapter MVP

**目标：** server-gateway.md §8.1 — 首个真实社交通道

**做什么：**
- `DingTalkAdapter` 实现 `ChannelAdapter` 核心接口
- `dingtalk-stream` SDK 长连接（不需要公网 IP）
- 消息接收 → InboundRouter → Agent 处理 → sessionWebhook 回复
- Markdown 消息格式化（agent 输出 → 钉钉 Markdown）
- 钉钉配置项（appKey / appSecret / robotCode）加入 zhixing.config.json

**不做（后续增量）：**
- ApprovableChannel（ActionCard 审批按钮）
- StreamableChannel（流式消息更新）
- ConfirmationRenderer（安全审批转发到钉钉）
- 代理配置

**交付：**
```
packages/channels/dingtalk/     # 新包 @zhixing/channels-dingtalk
  ├── package.json
  ├── src/
  │   ├── adapter.ts            # DingTalkAdapter
  │   ├── format.ts             # Markdown 格式化
  │   └── index.ts
```

**验证：** 钉钉机器人收到消息 → 知行回复 Markdown 消息

**前置调研（实现前完成）：**
- `dingtalk-stream` Node.js SDK API（连接、鉴权、消息接收回调）
- sessionWebhook 回复机制（URL 生命周期、请求格式、响应格式）
- 钉钉机器人创建流程 + 所需配置项（appKey / appSecret / robotCode）
- 钉钉 Markdown 消息语法限制（与标准 Markdown 的差异）
- Hermes ��钉适配器参考实现（D:\ZhixingWorkspace\src 中已有调研材料）

---

## 已知技术债务

### P1-计划中

| # | 问题 | 计划时机 |
|---|------|---------|
| 1 | TurnSource 参数缺失（scheduler/channel/interactive 区分） | **Step 10** |

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
| Delivery Pipeline | persistent-service.md §4.7 | **高** | Scheduler 任务结果 → 通道推送 |
| 钉钉增量能力 | server-gateway.md §8.1 | **高** | ActionCard 审批、流式消息、ConfirmationRenderer |
| AgentOrchestrator | persistent-service.md §3.6 | **中** | 背景 Agent、spawn/push、Monitor |
| Daemon 后台模式 | persistent-service.md §7 | **中** | --daemon + PID + CLI 远程连接 |
| 飞书 Adapter | server-gateway.md §8.2 | **中** | 第二个社交通道 |
| OpenAI 兼容端点 | server-gateway.md §9 | **低** | /v1/chat/completions |
| Web UI | 待设计 | **低** | 浏览器交互界面 |
| OS 级服务安装 | persistent-service.md §7.3 | **低** | launchd / systemd |
