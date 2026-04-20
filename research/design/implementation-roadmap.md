# 实现路线图 (Implementation Roadmap)

> 连接设计规格与代码实现的执行计划。已完成的 Step 只保留状态行，细节见 git history。

## 主线脉络

```
实际执行路线:
  S1 ✅ Scheduler
    → S2 ✅ Server (HTTP/WS/RPC)
      → S2.7 ✅ 对话模型统一
        → S5 ✅ Channel Adapter (飞书 MVP，E2E 已验证)
          → S3 ✅ Delivery Pipeline (核心 + Scheduler 集成)
            → S3.14 🔜 DeliveryRouter       ← 当前
              → 飞书增量 (流式卡片)
              → Daemon 后台模式
                → S2.5 AgentOrchestrator

战略逻辑:
  S5 提前 — 让 Server 拥有真实用户（飞书 E2E 已跑通）
  S3 紧随 — 闭环"触发→执行→投递"，从聊天机器人跃迁为主动式个人助手
  S2.5 推迟 — 背景 Agent 需要先有投递通道才能向用户推送结果
```

**规格引用：** [conversation-model.md](specifications/conversation-model.md) · [context-architecture.md](specifications/context-architecture.md) · [persistent-service.md](specifications/persistent-service.md) · [server-gateway.md](specifications/server-gateway.md)

---

## 状态总览

### S2.7 对话模型统一 ✅

| Step | 名称 | 状态 |
|------|------|------|
| 0 | 词汇对齐 | ✅ |
| 1 | ConversationRepository | ✅ |
| 2 | TranscriptStore 适配 | ✅ |
| 3 | CLI 对接 Conversation | ✅ |
| 4 | ScenarioEvaluator + ContextProfile | ✅ |
| 5 | LayerAssembler + TurnDigest | ✅ |
| 6 | WindowManager + Pinning | ✅ |
| 7 | ConversationManager + SessionRuntime | ✅ |
| 7a | PendingQueue 并发互斥 | ✅ |
| 7b | TranscriptStore 集成 + AbortSignal | ✅ |
| 8a | Ephemeral + recordTurn + promote | ✅ |

### S5 Channel Adapter ✅

| Step | 名称 | 状态 |
|------|------|------|
| 9 | Channel 接口层 + Registry | ✅ |
| 10 | InboundRouter + Server 集成 | ✅ |
| 11 | 飞书 Adapter MVP + 系统接线 | ✅ E2E 已验证 |

### S3 Delivery Pipeline（当前主线）

| Step | 名称 | 状态 | 设计状态 | 依赖 |
|------|------|------|---------|------|
| 12 | DeliveryPipeline 核心 | ✅ | ✅ 设计完备 (persistent-service.md §4.7) | Step 11 |
| 13 | Scheduler → Delivery 集成 | ✅ | ✅ 设计完备 (persistent-service.md §4.7) | Step 12 |
| 14 | DeliveryRouter 路由决策 | 🔜 下一步 | ✅ 设计完备 (server-gateway.md §7.2) | Step 13 |

### 延后 / 可选

| Step | 名称 | 状态 | 说明 |
|------|------|------|------|
| 3b | Transcript 段轮转 | 🔲 延后 | 内部优化，文件膨胀时再做 |
| 8c | /delete 命令 | 🔲 可选 | REPL 卫生，不阻塞主线 |
| 8d | 移除 -c/-r 启动参数 | 🔲 可选 | CLI 清理，不阻塞主线 |

---

## 已完成 Step 记录

> 细节从略，完整记录见 git history。仅保留关键设计取舍。

### Step 9-10: Channel 接口层 + InboundRouter ✅

- 交付 `core/src/channels/`（types / capabilities / registry）+ `server/src/channels/`（conversation-binder / inbound-router）
- 已知取舍：`runChannelTurn` 与 `runManagedTurn` 模式相似但未共享（I/O 路径不同，共享会引入 flag coupling）
- 已知取舍：DM 归组带 channelId 前缀，跨通道漫游需用户身份联邦

### Step 11: 飞书 Adapter MVP ✅

- Phase A：`@zhixing/channel-feishu` 包（7 源文件 + 66 测试），WSClient 长连接 + Card JSON 2.0 + FeishuApiError retryable 分类
- Phase B：系统接线（`ChannelConfigEntry` 类型 + `setupChannels()` 工厂 + `command.ts` 接线 + 启动横幅）
- 设计决策：动态 import 适配器、通道失败隔离、onMessage `.catch()` 防御、启动失败 `dispose()` 清理
- 附带修复：`deepMergeConfig` agent 字段覆盖遗漏、`toSafePathSegment()` Windows 路径兼容

### Step 12: DeliveryPipeline 核心 ✅

- 交付 `core/src/delivery/`（types / queue / dedup / pipeline / index）+ 30 测试
- `DeliverySender` 接口解耦 ChannelRegistry — 可插拔发送（channel / 未来 webhook）
- `DeliveryFilter` 可插拔链 — 内置 DedupFilter，可注入自定义过滤器（Active Hours 等）
- 持久化队列 write-rename 原子写入，crash recovery
- 重试语义：channel-not-ready 不消耗 attempts（固定延迟推迟），send 失败才消耗（指数退避）
- `itemTtlMs` 过期安全网（默认 1h）— 与 attempts 正交的独立关注点
- 时间注入链路完整：pipeline `now()` → DedupFilter `nowMs()`

### Step 13: Scheduler → Delivery 集成 ✅

- `IDeliveryPipeline` 作为可选依赖注入 `SchedulerDeps`（非 EventBus — 投递是任务生命周期的一部分）
- `enqueueDelivery()` 私有方法：仅在 task 成功 + 有 `delivery` 配置 + 有 output 时触发
- `command.ts` 接线：`DeliverySender` 包装 `ChannelRegistry`（`get()` + `send()` + `getStatus()`）
- 生命周期：pipeline 在 channels 之后创建、在 scheduler 之前启动；停机顺序 scheduler → delivery → channels
- 3 个集成测试覆盖：成功投递 / 无配置跳过 / 失败跳过
- 设计决策：enqueue 失败仅 warn 不影响任务结果（投递是 best-effort 的副作用）

---

## 待实施

### Step 14: DeliveryRouter 路由决策

**目标：** 智能选择投递通道，而非硬编码默认通道。

**设计来源：** server-gateway.md §7.2

**做什么：**
- 路由决策链：显式指定 → 触发源通道 → 最近活跃通道 → 默认通道
- `RoutingContext`：通道活跃度追踪
- 与 ChannelRegistry 集成：只路由到 connected 状态的通道

---

## 已知技术债务

### P1-已解决

| # | 问题 | 解决时机 |
|---|------|---------|
| 1 | ~~TurnSource 参数缺失~~ | **Step 10** ✅ |

### P2-计划中

| # | 问题 | 影响 | 计划时机 |
|---|------|------|---------|
| 1 | session.abort 不中断当前 turn | **中** | Provider 层支持时 |
| 2 | AgentRuntime.run() 不接受 AbortSignal | **低** | Provider 层支持时 |
| 3 | promote() 并发 TOCTOU | **低** | 实现 /keep 时 |
| 4 | Channel credentials 无 `env:` / `helper:` 解析 | **中** | 第二通道接入前 |
| 5 | loadConfig 在 serve 流程中重复加载 | **低** | RuntimeFactory 重构时 |
| 6 | 同类型多实例通道配置硬崩溃 | **低** | 多实例需求出现时 |

---

## 后续路线（Delivery Pipeline 之后）

| 顺序 | 方向 | 规格来源 | 说明 |
|------|------|---------|------|
| 1 | 飞书流式卡片 | channel-platforms.md §7.2 | StreamableChannel — 长文本回复 UX 跃升 |
| 2 | Daemon 后台模式 | persistent-service.md §7 | --daemon + PID — 个人助手必须 always-on |
| 3 | AgentOrchestrator | persistent-service.md §3.6 | 背景 Agent、spawn/push — 复杂多步任务 |
| 4 | 第二社交通道 | server-gateway.md §8.1 | 钉钉/企微 — 横向扩展，需独立调研 |
| 5 | Active Hours 免打扰 | persistent-service.md §4.7 | Delivery 过滤层 — 用户偏好驱动 |
| 6 | OpenAI 兼容端点 | server-gateway.md §9 | /v1/chat/completions — 第三方工具接入 |
| 7 | Web UI | 待设计 | 浏览器交互界面 |
