# 实现路线图 (Implementation Roadmap)

> 连接设计规格与代码实现的执行计划。已完成的 Step 只保留状态行，细节见 git history。

## 主线脉络

```
实际执行路线:
  S1 ✅ Scheduler
    → S2 ✅ Server (HTTP/WS/RPC)
      → S2.7 ✅ 对话模型统一
        → S5 ✅ Channel Adapter (飞书 MVP，E2E 已验证)
          → S3 ✅ Delivery Pipeline (核心 + 集成 + 路由 + 自动路由)
            → S4 🔜 Daemon Level 1 (always-on)     ← 当前
              → Active Hours + 飞书流式卡片
                → Active Hours + 飞书流式卡片
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
| 14 | DeliveryRouter 路由决策 | ✅ | ✅ 设计完备 (server-gateway.md §7.2) | Step 13 |
| 15 | Delivery 自动路由 | ✅ | ✅ 设计完备 (implementation-roadmap.md) | Step 14 |

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

### Step 14: DeliveryRouter 路由决策 ✅

- 纯决策组件：`DefaultDeliveryRouter.resolve(request, context) → DeliveryTarget | null`
- 4 级决策链：显式指定（connected）→ 触发来源通道 → 最近活跃通道 → null（入队等待）
- `RoutingContext`：channelStatus / channelActivity / triggerChannel / defaultChannel / channelDefaults
- `channelDefaults` 扩展 spec — 跨通道路由需要知道每个通道上的用户 ID（`to` 字段）
- `buildRoutingContext(statuses, options)` 工具函数：从 `ChannelStatus[]` 构建上下文，不依赖 ChannelRegistry 类
- 活跃度排序 tiebreaker：defaultChannel 优先
- 19 个测试覆盖：每级决策 / fallthrough / 边界条件 / 完整优先级链 / buildRoutingContext

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
| 7 | Pipeline 30s flush 间隔导致投递延迟 | **低** | enqueue 后可加立即 flush，性能优化时 |
| 8 | Scheduled task 共享默认会话（上下文串扰） | **中** | 用 `task:${id}` 隔离会话，AgentOrchestrator 时 |
| 9 | 无 `defaultChannel` 配置（多通道 tiebreaker） | **低** | 第二通道接入时 |

---

## 下一阶段：投递闭环 + 持久化收官

### 设计决策：投递路由是调度器的关注点

S3 Delivery Pipeline 的三步（核心 / 集成 / 路由）都已完成且单元测试通过，但发现一个端到端缺口：
用户通过 AI（schedule tool）创建的任务没有 delivery 配置，执行结果无处投递。

**根因：** Scheduler 的 `enqueueDelivery` 仅处理显式指定了 `delivery: { kind: "channel" }` 的任务。
schedule tool 不应该知道投递细节（违反关注点分离）。正确方案是 Scheduler 自动解析投递目标。

**设计方案：**

```
Schedule Tool → 只管 { prompt, schedule, priority }（不变）
                ↓
Scheduler     → 执行完成后解析投递：
                1. 任务有显式 delivery → 用它（现有路径，不变）
                2. 任务无 delivery → resolveDeliveryTarget(task)
                   → DefaultDeliveryRouter + ChannelRegistry 状态 + channelDefaults
                3. 解析失败 → 跳过（静默任务，不变）
                ↓
Pipeline      → enqueue → retry → send（不变）
```

**注入方式：**

```typescript
// SchedulerDeps 新增一个可选函数（非 Router 实例——最松耦合）
resolveDeliveryTarget?: (task: ScheduledTask) => DeliveryTarget | null

// command.ts 组装时注入闭包（捕获 router + registry + channelDefaults）
```

**上游配置变更：**

```typescript
// ChannelConfigEntry 新增 defaultTarget — 用户配置"我在这个通道上的 ID"
interface ChannelConfigEntry {
  // ... existing
  defaultTarget?: { to: string };  // owner 在此通道上的用户 ID
}
```

`ChannelConfig.defaultTarget` 类型早已预留但从未填充。此步将其激活。

### 路线（修订后）

| Step | 名称 | 说明 | 依赖 |
|------|------|------|------|
| 15 | Delivery 自动路由 | ✅ Scheduler 自动解析投递目标，激活 defaultTarget 配置 | Step 14 |
| 16 | Daemon Level 1 | `--daemon` + PID + 日志 + `zhixing stop/status` | Step 15 |
| 17 | Active Hours 免打扰 | DeliveryFilter 实现 + 配置解析 | Step 15 |
| 18 | 飞书流式卡片 | StreamableChannel trait + Feishu 实现 | 独立 |

```
战略逻辑：

  Step 15 已完成 — S3 端到端闭环，"定时任务→通道推送" 可 E2E 验证
  Step 16 下一个 — Daemon 是 persistent-service 的收官之作，没有它就不 persistent
  Step 17 伴随 — Daemon 上线后 7×24 运行，免打扰成为日用刚需，且只是一个 Filter
  Step 18 独立 — UX 跃升，不阻塞主线
```

### Step 15: Delivery 自动路由 ✅

- 三层实现：配置穿透 → Scheduler 自动解析 → command.ts 接线
- `ChannelConfigEntry` 新增 `defaultTarget?: { to: string }`，`setupChannels` 展开为完整 `DeliveryTarget`
- `SchedulerDeps` 新增 `resolveDeliveryTarget?: (task) => DeliveryTarget | null`
- `enqueueDelivery` 三步决策链：显式配置 → auto-resolve → 跳过（显式优先，resolver 不被调用）
- command.ts 组装：从 config 构建 `channelDefaults` Map → `DefaultDeliveryRouter` + `buildRoutingContext` 闭包 → 注入 Scheduler
- 3 个新测试：自动解析成功 / resolver 返回 null 跳过 / 显式优先级高于 resolver
- 设计决策：Scheduler 不依赖 Router/Registry 实例，只接受一个函数——最松耦合

### 延后方向

| 顺序 | 方向 | 规格来源 | 说明 |
|------|------|---------|------|
| 5 | AgentOrchestrator | persistent-service.md §3.6 | 背景 Agent、spawn/push — 需 daemon 先就绪 |
| 6 | 第二社交通道 | server-gateway.md §8.1 | 钉钉/企微 — 横向扩展，需独立调研 |
| 7 | OpenAI 兼容端点 | server-gateway.md §9 | /v1/chat/completions — 第三方工具接入 |
| 8 | Web UI | 待设计 | 浏览器交互界面 |
