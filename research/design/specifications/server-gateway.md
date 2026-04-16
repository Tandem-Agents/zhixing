# 知行 Server Gateway 设计方案

> 设计日期：2026-04-16 | 最后更新：2026-04-16（v1.1 — 适配 AgentOrchestrator）
> 状态：v1.1 定稿
> 前置依赖：[persistent-service.md](./persistent-service.md)（Scheduler / Delivery / Daemon / AgentOrchestrator 设计）
> 调研依据：
>   - [OpenClaw 常驻服务分析](../../source-analysis/openclaw/persistent-service.md)（910 行）
>   - [Hermes 常驻服务/消息网关分析](../../source-analysis/hermes-agent/persistent-service.md)（493 行）
>   - [Claude Code 常驻服务分析](../../source-analysis/claude-code/persistent-service.md)（376 行）

## 一、设计定位

### 1.1 本文档覆盖什么

`persistent-service.md` 解决了"知行如何常驻运行"——Scheduler、Delivery Pipeline、Daemon、基础 Channel 接口、Server 进程管理。它的 S1-S6 路线图是正确的。

本文档在其基础上解决**"知行如何连接外部世界"**：

| 主题 | persistent-service.md | 本文档 |
|------|----------------------|--------|
| Scheduler / Delivery / Daemon | ✅ 完整设计 | 不重复，引用 |
| 通道适配器架构 | 6 方法基础接口 | **升级为两层模型** |
| RPC 协议 | REST 端点列表 | **JSON-RPC 2.0 over WebSocket** |
| 入站路由 | 4 行流程图 | **完整设计：去抖、规范化、会话绑定** |
| 跨通道特性 | 未覆盖 | **审批路由、会话漫游、智能投递** |
| 中国平台适配 | 未覆盖 | **钉钉/飞书适配考量** |
| OpenAI 兼容 API | 未覆盖 | **`/v1/chat/completions` 端点** |

### 1.2 整体架构图（更新版）

```
                 ┌─ 入站 ──────────────────────────────────────────┐
                 │                                                  │
  CLI WebSocket ─┤  RPC Protocol (JSON-RPC 2.0 / WebSocket)        │
  Web UI ────────┤                                                  │
  移动端 ────────┤  ┌──────────────────────────────────────────┐   │
                 │  │  InboundRouter                           │   │
  钉钉 ─────────┤  │    normalize → debounce → session-bind   │   │
  飞书 ─────────┤  │    → Agent Turn                          │   │
  企微 ─────────┤  └──────────────────────────────────────────┘   │
  Webhook ──────┤                                                  │
  API (/v1/) ───┘                                                  │
                                      │                            │
                 ┌─ 调度 ─────────────┼────────────────────────────┤
                 │  Scheduler         │                            │
                 │  (persistent-service.md §4)                     │
                 └────────────────────┼────────────────────────────┘
                                      │
                 ┌─ 出站 ─────────────┼────────────────────────────┐
                 │  Delivery Pipeline  │                            │
                 │  (persistent-service.md §4.7)                   │
                 │       │                                         │
                 │       ├→ ChannelAdapter.send()                  │
                 │       ├→ Webhook POST                           │
                 │       └→ RPC push event                         │
                 └─────────────────────────────────────────────────┘
```

## 二、竞品洞察提炼

### 2.1 三个关键发现

**发现 1：通道抽象的粒度决定了生态上限**

| | 方法数 | 上手成本 | 高级能力 | 第三方扩展 |
|--|--------|---------|---------|-----------|
| Hermes | 4 必须 | ✅ 极低 | ❌ 基类太大难扩展 | ⚠️ 一般 |
| OpenClaw | 35 可选 slot | ❌ 极高 | ✅ 极强 | ❌ 门槛高 |
| **知行** | **3 必须 + N 可选 trait** | **✅ 低** | **✅ 强** | **✅ 好** |

**发现 2：客户端协议是多端统一的前提**

只有 OpenClaw 设计了标准化 RPC 协议（v3，60+ 方法）。Hermes 的 CLI 与 Gateway 通过文件间接交互，Claude Code 无此需求。知行需要 RPC 协议，但不需要 60+ 方法——**v1 用 ~15 方法覆盖核心场景**，后续按需扩展。

**发现 3：中国平台是个人助手的刚需差异点**

Hermes 是唯一覆盖中国社交平台的参考项目（钉钉/飞书/企微/微信）。OpenClaw 和 Claude Code 均未覆盖。知行作为中文个人助手，**首个通道应该是钉钉或飞书**，不是 Slack。

### 2.2 设计取舍

| 取 | 来源 | 理由 |
|---|------|------|
| 两层通道适配（核心 + trait） | 知行独创，综合 Hermes + OpenClaw | 简洁且可扩展 |
| JSON-RPC 2.0 over WebSocket | 参考 OpenClaw frame 设计，简化 | 标准协议，降低实现成本 |
| 入站去抖 | OpenClaw `inbound-debounce-policy` | 防止快速连发触发多次 Agent Turn |
| Agent 缓存 | Hermes `_agent_cache` | 复用 LLM prompt cache，降低冷启动 |
| 代理/GFW 支持 | Hermes `resolve_proxy_url` | 中国网络环境刚需 |
| 多投递 surface 审批 | OpenClaw `preferredSurface` | 用户在哪个通道就在哪里审批 |
| 协议版本号 | OpenClaw `PROTOCOL_VERSION = 3` | 从 v1 开始，向前兼容 |

| 舍 | 来源 | 理由 |
|---|------|------|
| 35 个 adapter slot | OpenClaw | 概念过重，用 trait 替代 |
| 7905 行单文件 | Hermes | 反面教材 |
| 60+ RPC 方法 | OpenClaw | v1 不需要 |
| Cloud Remote Triggers | Claude Code | 依赖第三方基础设施 |
| Heartbeat | OpenClaw | persistent-service.md 已论证不需要 |

## 三、核心差异化（vs 竞品）

### 3.1 差异化总览

| # | 差异化 | 比 OpenClaw 好在 | 比 Hermes 好在 | 比 Claude Code 好在 |
|---|--------|----------------|---------------|-------------------|
| 1 | 两层通道适配 | 35 slot → 3+N trait | 4 方法无渐进增强 | 无通道能力 |
| 2 | 统一触发模型 | 无 Heartbeat 架构债 | 无 Lane 隔离 | 无调度能力 |
| 3 | ~15 方法 RPC | 60+ 方法认知负担 | 无标准协议 | 无多端协议 |
| 4 | 中国平台首选 | 无中国平台 | 有但单文件巨石 | 无 |
| 5 | 会话漫游 | 跨通道续聊有但复杂 | 无 | 无 |
| 6 | 智能投递路由 | 无智能选择 | 无 | 无 |
| 7 | ConfirmationBroker 原生多通道 | 需要独立审批系统 | 无跨通道审批 | 无 |

### 3.2 差异化 1：两层通道适配

**洞察**：通道适配需要"5 分钟上手"的简洁性和"渐进增强"的丰富性。Hermes 只有前者，OpenClaw 只有后者。

**方案**：Core Interface + Capability Traits。

### 3.3 差异化 5：会话漫游

**定义**：用户在钉钉开始的对话，可以在 CLI 或 Web 上无缝继续，保留完整上下文。

OpenClaw 有 `lastChannel` 追踪但切换成本高。知行的 Session 层已经是通道无关的（`core/session/`），只需在入站路由时支持"同一用户的多通道消息归入同一 session"。

### 3.4 差异化 6：智能投递路由

**定义**：当 Agent 有结果要投递时，自动选择用户**最可能看到**的通道。

```
投递路由决策：
  1. 任务显式指定了通道 → 用指定通道
  2. 任务从某通道触发 → 回到触发通道
  3. 无明确通道 → 按用户最近活跃度排序 → 选最近活跃的通道
  4. 所有通道不可达 → 入队等待
```

### 3.5 差异化 7：ConfirmationBroker 原生多通道

知行的 `ConfirmationBroker` 已经是**渲染器无关**的（Phase 1 已完成）。扩展到多通道只需实现 `ChannelConfirmationRenderer`——这是架构预判的收益，不需要像 OpenClaw 那样单独建设审批转发系统。

## 四、通道适配器 v2（两层模型）

### 4.1 Layer 1：Core Interface（必须实现）

```typescript
/**
 * 通道适配器核心接口。
 * 实现 3 个方法 + 2 个属性即可接入一个新平台。
 */
interface ChannelAdapter {
  /** 通道唯一标识 */
  readonly id: string;

  /** 通道声明的能力集（用于运行时能力检测） */
  readonly capabilities: ChannelCapabilities;

  /** 建立与平台的连接（WebSocket / Polling / Webhook 注册） */
  connect(ctx: ChannelContext): Promise<void>;

  /** 断开连接，释放资源 */
  disconnect(): Promise<void>;

  /** 发送消息到平台 */
  send(target: DeliveryTarget, content: OutboundContent): Promise<DeliveryResult>;
}

/** 入站消息通过 ctx.onMessage 回调传递，不是适配器方法 */
interface ChannelContext {
  config: ChannelConfig;
  abortSignal: AbortSignal;
  eventBus: IEventBus;
  logger: Logger;

  /** 适配器调用此回调将入站消息传递给路由器 */
  onMessage(msg: InboundMessage): void;

  /** 注册 HTTP 路由（供 webhook 类通道使用） */
  registerHttpRoute(path: string, handler: HttpHandler): void;
}

interface ChannelCapabilities {
  /** 支持的聊天类型 */
  chatTypes: ("dm" | "group" | "channel" | "thread")[];
  /** 是否支持富媒体 */
  media: boolean;
  /** 是否支持消息编辑 */
  edit: boolean;
  /** 是否支持流式消息（边生成边更新） */
  streaming: boolean;
}
```

**对比**：
- Hermes：4 个 `@abstractmethod`（connect / disconnect / send / get_chat_info）— 知行去掉了 `get_chat_info`（按需放到 trait），入站通过回调而非覆写
- OpenClaw：`config` adapter 必须 + 其他全可选 — 知行的 3 方法更直观
- 知行额外提供 `ChannelContext` 注入，避免适配器自行管理 HTTP server

### 4.2 Layer 2：Capability Traits（可选实现）

```typescript
/** 消息编辑 */
interface EditableChannel {
  editMessage(messageId: string, content: OutboundContent): Promise<void>;
  deleteMessage(messageId: string): Promise<void>;
}

/** 线程/回复 */
interface ThreadableChannel {
  resolveThread(messageId: string): Promise<string | null>;
  sendToThread(threadId: string, content: OutboundContent): Promise<DeliveryResult>;
}

/** 流式消息（AI 生成过程中实时更新） */
interface StreamableChannel {
  /**
   * 创建一条可更新的消息。
   * 返回 handle，后续通过 handle.update() 追加内容。
   */
  createStreamMessage(target: DeliveryTarget): Promise<StreamHandle>;
}
interface StreamHandle {
  update(content: string): Promise<void>;
  finalize(content: OutboundContent): Promise<DeliveryResult>;
  abort(): Promise<void>;
}

/** 表情回应 */
interface ReactableChannel {
  addReaction(messageId: string, emoji: string): Promise<void>;
  removeReaction(messageId: string, emoji: string): Promise<void>;
}

/** 审批交互（平台原生按钮） */
interface ApprovableChannel {
  /**
   * 渲染审批请求为平台原生交互组件。
   * 钉钉 → ActionCard 按钮；飞书 → Interactive Card。
   */
  renderApproval(request: ConfirmationRequest, target: DeliveryTarget): Promise<ApprovalHandle>;
}
interface ApprovalHandle {
  /** 用户在平台上点击按钮后回调 */
  onDecision(handler: (decision: ConfirmationDecision) => void): Disposable;
  /** 超时或取消时清理 */
  dismiss(): Promise<void>;
}

/** 打字指示器 */
interface TypingChannel {
  sendTyping(target: DeliveryTarget): Promise<void>;
  stopTyping(target: DeliveryTarget): Promise<void>;
}
```

### 4.3 运行时能力检测

```typescript
/** 类型守卫：检查适配器是否实现了某个 trait */
function isEditable(adapter: ChannelAdapter): adapter is ChannelAdapter & EditableChannel {
  return 'editMessage' in adapter && typeof (adapter as any).editMessage === 'function';
}
function isStreamable(adapter: ChannelAdapter): adapter is ChannelAdapter & StreamableChannel {
  return 'createStreamMessage' in adapter && typeof (adapter as any).createStreamMessage === 'function';
}
function isApprovable(adapter: ChannelAdapter): adapter is ChannelAdapter & ApprovableChannel {
  return 'renderApproval' in adapter && typeof (adapter as any).renderApproval === 'function';
}
// ... 同模式
```

使用方式：
```typescript
// 投递时根据通道能力选择最佳策略
if (isStreamable(adapter)) {
  const handle = await adapter.createStreamMessage(target);
  for await (const chunk of agentStream) {
    await handle.update(chunk);
  }
  await handle.finalize(fullContent);
} else {
  // 降级：等 agent 完成后一次性发送
  await adapter.send(target, fullContent);
}
```

### 4.4 设计评价

| vs Hermes 4 方法 | vs OpenClaw 35 slot |
|-------------------|---------------------|
| ✅ 同样低门槛（3 方法） | ✅ 同样丰富（N 个 trait） |
| ✅ 通过 trait 渐进增强 | ✅ 每个 trait 独立理解 |
| ✅ TypeScript 类型安全 | ✅ 运行时能力检测 |
| ✅ 入站通过回调注入 | ✅ 不需要理解 35 个 slot 的交互 |

## 五、RPC 协议

### 5.1 传输层

- **协议**：JSON-RPC 2.0 over WebSocket
- **选择理由**：标准协议、双向通信、生态成熟（vs OpenClaw 的自定义帧格式）
- **编码**：JSON（text frame）
- **心跳**：WebSocket ping/pong（不是应用层心跳）

### 5.2 连接握手

```
Client                                    Server
  │                                          │
  │──── WebSocket 连接 ───────────────────→ │
  │                                          │
  │──── rpc: auth ────────────────────────→ │
  │     { token, client: { id, version } }   │
  │                                          │
  │ ←── result ───────────────────────────  │
  │     { protocol: 1, server: { version },  │
  │       capabilities: [...] }              │
```

认证方式：
- **共享 Token**：`~/.zhixing/server.token`（Server 启动时生成）
- CLI 自动读取 token 文件连接，无需用户操作

### 5.3 v1 方法列表（~20 个）

> v2.0 更新：新增 `background.*` 和 `monitor.*` 方法组。

```typescript
type RpcMethods = {
  // ─── 连接 ───
  "auth":                  (params: AuthParams) => AuthResult;
  "health":                () => HealthStatus;

  // ─── 会话 ───
  "session.send":          (params: { text: string; sessionId?: string }) => { sessionId: string };
  "session.list":          () => SessionSummary[];
  "session.history":       (params: { sessionId: string; limit?: number }) => Message[];
  "session.abort":         (params: { sessionId: string }) => void;
  "session.delete":        (params: { sessionId: string }) => void;

  // ─── 背景 Agent（v2.0 新增）───
  "background.spawn":     (params: { sessionId: string; prompt: string; model?: string; tools?: string[] }) => BackgroundAgent;
  "background.list":      (params: { sessionId?: string }) => BackgroundAgent[];
  "background.abort":     (params: { agentId: string }) => void;

  // ─── 调度 ───
  "schedule.list":         () => ScheduledTask[];
  "schedule.create":       (params: CreateTaskParams) => ScheduledTask;
  "schedule.update":       (params: { id: string; patch: Partial<ScheduledTask> }) => ScheduledTask;
  "schedule.delete":       (params: { id: string }) => void;
  "schedule.run":          (params: { id: string }) => void;

  // ─── 监控（v2.0 新增）───
  "monitor.create":        (params: CreateMonitorParams) => MonitorSpec;
  "monitor.list":          () => MonitorSpec[];
  "monitor.stop":          (params: { monitorId: string }) => void;

  // ─── 通道 ───
  "channel.status":        () => Record<string, ChannelStatus>;

  // ─── 审批 ───
  "approval.respond":      (params: { requestId: string; decision: ConfirmationDecision }) => void;

  // ─── 状态 ───
  "server.status":         () => ServerStatus;
};
```

### 5.4 推送事件

Server → Client 的单向事件通知（JSON-RPC 2.0 notification，无 id）：

```typescript
type RpcEvents = {
  // ─── 会话 ───
  "session.delta":         { sessionId: string; delta: StreamDelta };
  "session.complete":      { sessionId: string; result: AgentResult };

  // ─── 背景 Agent（v2.0 新增）───
  "background.spawned":    { agentId: string; parentSessionId: string; prompt: string };
  "background.complete":   { agentId: string; status: "done" | "error"; summary?: string };
  "background.progress":   { agentId: string; delta: StreamDelta };

  // ─── 调度 ───
  "schedule.started":      { taskId: string };
  "schedule.completed":    { taskId: string; status: "ok" | "error"; summary?: string };

  // ─── 监控（v2.0 新增）───
  "monitor.triggered":     { monitorId: string; event: unknown };
  "monitor.expired":       { monitorId: string };

  // ─── 通道 ───
  "channel.connected":     { channelId: string };
  "channel.disconnected":  { channelId: string; reason: string };
  "channel.message":       { channelId: string; message: InboundMessage };

  // ─── 审批 ───
  "approval.requested":    { request: ConfirmationRequest };

  // ─── 服务 ───
  "server.shutdown":       { reason: string };
};
```

### 5.5 协议版本

```typescript
const PROTOCOL_VERSION = 1;
// auth 时协商：client 发 { minProtocol: 1, maxProtocol: 1 }
// server 返回 { protocol: 1 }
// 未来 v2 时 server 支持 1 和 2，client 升级后发 maxProtocol: 2
```

### 5.6 对比

| | 知行 v1 | OpenClaw v3 |
|--|---------|-------------|
| 方法数 | ~15 | 60+ |
| 协议 | JSON-RPC 2.0（标准） | 自定义帧格式 |
| 认证 | 共享 token | Token + Device pairing + Bootstrap |
| 心跳 | WebSocket ping/pong | 应用层 tick 事件 |
| 版本协商 | minProtocol/maxProtocol | 同 |

## 六、入站路由器（InboundRouter）

### 6.1 完整消息处理流程

```
通道消息到达
    │
    ▼
① 消息规范化（normalize）
    │ 统一消息格式：text, from, channelId, threadId, mediaUrls, raw
    │ 去除平台特定标记：钉钉 @bot 前缀、飞书 mention tag
    │
    ▼
② 去抖（debounce）
    │ 同一用户 500ms 内的连续文本消息合并
    │ 媒体消息 / 命令消息不去抖
    │ 每通道可配置去抖窗口
    │
    ▼
③ 命令识别（command detect）
    │ 检查是否是 slash 命令（/schedule、/status 等）
    │ 是 → CommandDispatcher（复用 CLI 的命令分发）
    │ 否 → 继续
    │
    ▼
④ 会话绑定（session bind）
    │ 构建 session key = hash(userId, channelId, threadId?)
    │ 查找已有 session 或创建新 session
    │ 记录 lastChannel + lastRoute（用于出站路由）
    │
    ▼
⑤ 并发守卫（concurrency guard）
    │ 检查该 session 是否有活跃 Agent Turn
    │ ├── 有 → 排队到 pendingMessages[sessionKey]
    │ └── 无 → 继续
    │
    ▼
⑥ Agent 执行（agent turn）
    │ 复用 @zhixing/core 的 runAgentLoop
    │ 完全相同的 Agent Loop、Tool Pipeline、Security Pipeline
    │ Agent 缓存：复用 provider 实例保留 prompt cache
    │
    ▼
⑦ 结果路由（result routing）
    │ Agent 完成 → 结果发回触发通道
    │ 流式通道 → 边生成边更新（StreamableChannel）
    │ 非流式通道 → 完成后一次性发送
```

### 6.2 会话绑定策略

```typescript
interface SessionBindingPolicy {
  /** DM 消息：一个用户一个 session */
  dm: "per-user";
  /** 群消息：一个群一个 session（所有人共享） */
  group: "per-group" | "per-user-in-group";
  /** 线程消息：一个线程一个 session */
  thread: "per-thread";
}
```

默认策略：DM = per-user, group = per-group, thread = per-thread。可在 config 中按通道覆写。

### 6.3 会话漫游

同一用户在多个通道的 DM 消息归入**同一 session**（通过 userId 匹配）：

```
钉钉 DM (user: sunhj) ──→ session: sunhj-dm
CLI 对话 (user: sunhj) ──→ session: sunhj-dm  （同一个）
飞书 DM (user: sunhj) ──→ session: sunhj-dm  （同一个）
```

用户可在任意通道说 `/new` 创建新 session。

**实现**：Session key 的生成从 `hash(userId, channelId)` 变为 `hash(userId, "dm")`（DM 场景），使得跨通道的 DM 消息天然落入同一 session。

## 七、跨通道特性

### 7.1 ConfirmationBroker 多通道渲染

知行的 `ConfirmationBroker` 已是渲染器无关架构。扩展步骤：

1. 为每个通道实现 `ConfirmationRenderer`（已有 `TerminalConfirmationRenderer` 作为参考）
2. 如果通道实现了 `ApprovableChannel` trait → 使用平台原生按钮
3. 否则 → 发送文本选项列表，用户回复数字选择

```
Agent 请求工具审批
    │
    ▼
ConfirmationBroker.request()
    │ 当前活跃通道是钉钉？
    ├── 钉钉实现了 ApprovableChannel
    │   → renderApproval() → ActionCard 按钮
    │   → 用户点击 → onDecision 回调 → broker.resolve()
    │
    ├── 当前活跃通道是 CLI
    │   → TerminalConfirmationRenderer（已有）
    │   → SelectWithInput TUI
    │
    └── 当前活跃通道无 ApprovableChannel
        → 文本消息："请回复 1 允许 / 2 拒绝"
        → 解析用户回复 → broker.resolve()
```

### 7.2 智能投递路由

```typescript
interface DeliveryRouter {
  /**
   * 为一个投递项选择最佳通道。
   * 优先级：显式指定 > 触发来源 > 最近活跃 > 默认通道
   */
  resolve(item: DeliveryItem, context: RoutingContext): DeliveryTarget | null;
}

interface RoutingContext {
  /** 任务是从哪个通道触发的 */
  triggerChannel?: string;
  /** 用户各通道最后活跃时间 */
  channelActivity: Map<string, Date>;
  /** 各通道当前连接状态 */
  channelStatus: Map<string, "connected" | "disconnected">;
  /** 用户配置的默认投递通道 */
  defaultChannel?: string;
}
```

### 7.3 流式消息体验

当通道支持 `StreamableChannel` trait 时，Agent 生成过程中实时更新消息：

```
用户提问
    │
    ▼
Agent 开始生成（runAgentLoop yield text_delta）
    │
    ├── StreamableChannel（钉钉/飞书）:
    │   createStreamMessage() → handle
    │   每 300ms 或每段落: handle.update(accumulated)
    │   完成: handle.finalize(fullContent)
    │   视觉效果：消息"长出来"，类似 ChatGPT 网页版
    │
    └── 非流式通道（SMS/Email/Webhook）:
        等 Agent 完成 → 一次性 send()
```

## 八、中国平台适配考量

### 8.1 首选通道：钉钉

**理由**：
- 钉钉开放平台成熟度最高，SDK 完善（dingtalk-stream for Node.js）
- Stream Mode 长连接——不需要公网 IP 或域名，**个人部署零门槛**
- 支持 ActionCard（可做审批按钮）、Markdown 消息、群/单聊
- Hermes 已验证可行性

**关键技术点**：
- 使用 `dingtalk-stream` SDK 建立长连接
- 机器人接收消息 → InboundRouter
- 回复走 Session Webhook（每条消息带 sessionWebhook URL，24h 有效）
- ActionCard 可实现 ApprovableChannel trait

### 8.2 次选通道：飞书

**理由**：
- lark-oapi SDK 支持 WebSocket 订阅
- Interactive Card 可做富交互（审批、表单）
- 企业场景覆盖

### 8.3 网络代理

```typescript
interface ProxyConfig {
  /** HTTP 代理 URL */
  httpProxy?: string;
  /** HTTPS 代理 URL */
  httpsProxy?: string;
  /** SOCKS5 代理 URL */
  socksProxy?: string;
  /** 不走代理的域名 */
  noProxy?: string[];
}

// config 中配置：
// zhixing.config.json
{
  "proxy": {
    "httpsProxy": "http://127.0.0.1:7890"
  }
}
```

Provider 层和 Channel 层共用代理配置。参考 Hermes 的 `resolve_proxy_url()` 实现。

## 九、OpenAI 兼容 API

### 9.1 定位

让知行可以被其他工具和服务调用——Cursor、Continue 等 IDE 工具可以配置知行作为"本地 LLM"。

### 9.2 端点

```
POST /v1/chat/completions
```

兼容 OpenAI Chat Completions API 格式：
- 接收 `messages` 数组
- 返回 `choices[0].message`
- 支持 `stream: true`（SSE）
- 知行在内部走完整的 Agent Loop（工具调用 + 安全检查 + 上下文管理）

### 9.3 与直接 RPC 的区别

| | /v1/chat/completions | RPC session.send |
|--|---------------------|------------------|
| 协议 | HTTP REST | WebSocket JSON-RPC |
| 会话 | 无状态（每次独立） | 有状态（session 持续） |
| 流式 | SSE | RPC push events |
| 认证 | Bearer token | 连接时 auth |
| 场景 | 外部工具调用 | 自有客户端 |

## 十、Server 安全模型

### 10.1 原则

Server 模式引入了新的安全边界：**网络可达 + 多用户可能**。

```
风险层级：
  CLI 模式:     本地进程 → 低风险（用户即操作者）
  Server 本地:  localhost → 中风险（本机其他进程可访问）
  Server 远程:  0.0.0.0 → 高风险（网络可达）
```

### 10.2 防护措施

| 风险 | 防护 |
|------|------|
| 未授权访问 | Token 认证（auth RPC / Bearer header） |
| 默认绑定 | `host: "127.0.0.1"`（仅本机），远程需显式 `host: "0.0.0.0"` |
| SSRF | Webhook 投递过滤内网地址（参考 Hermes `_ssrf_redirect_guard`） |
| 敏感工具 | Server 模式下 Bash/Write 工具默认需要审批（SecurityPipeline 已支持） |
| 通道伪造 | Channel Adapter 验证消息来源签名（平台 SDK 内建） |

### 10.3 工具隔离（渐进）

Phase 1：所有工具在 Server 进程内执行（与 CLI 一致）
Phase 2（可选）：高风险工具 fork worker 进程执行（参考 Claude Code process-per-session 思路）

## 十一、实现路线图

本文档的内容**嵌入** persistent-service.md 的 S1-S6 路线图，不新建独立 phase。

### S1（Scheduler 核心）

**本文档新增**：无。S1 不涉及网关，按原设计执行。

### S2（Server 前台模式）

**本文档新增**：
- RPC 协议 v1 实现（JSON-RPC 2.0 over WebSocket）
- `auth`、`health`、`session.send`、`session.list`、`server.status` 五个核心方法
- 推送事件：`session.delta`、`session.complete`

> CLI 远程连接模式移至 **S4 Daemon** 阶段——S2 是前台运行，Server 占据终端，无 CLI 连接场景。

**验证**：
- `zhixing serve` → 启动 WebSocket server
- `wscat` 手动连接 → 发送 auth → 发送 session.send → 收到流式 delta 事件 → 收到 session.complete

### S3（Delivery Pipeline + Active Hours）

**本文档新增**：无。按原设计执行。

### S4（Daemon 后台模式）

**本文档新增**：无。按原设计执行。

### S5（Channel Adapter 框架 + 首个通道）

**原设计为 Webhook Adapter。本文档调整为两步：**

**S5a：Channel Adapter 框架**
- 实现 Layer 1 Core Interface（`ChannelAdapter`、`ChannelContext`、`ChannelCapabilities`）
- 实现 `ChannelRegistry`（适配器注册 + 发现）
- 实现 `InboundRouter`（normalize → debounce → session-bind → concurrency guard → agent turn）
- 实现 `DeliveryRouter`（智能投递路由）
- Webhook Adapter 作为最简实现验证接口
- 对接 Delivery Pipeline（`channel` 类型投递走 ChannelAdapter.send()）
- Channel EventBus 事件

**验证**：
- 外部 HTTP POST → Webhook Adapter → InboundRouter → Agent 处理 → 回复 POST 到 callback
- 创建定时任务 + channel delivery → 通过 Webhook 投递

**交付**：
```
packages/core/src/channels/
  ├── types.ts                # ChannelAdapter, Traits, InboundMessage, OutboundContent
  ├── capabilities.ts         # 能力检测类型守卫 (isEditable, isStreamable, ...)
  ├── registry.ts             # ChannelRegistry
  └── index.ts
packages/server/src/
  ├── inbound-router.ts       # 入站路由器
  ├── delivery-router.ts      # 智能投递路由
  ├── session-binder.ts       # 会话绑定策略
  └── debouncer.ts            # 入站去抖
packages/channels/webhook/
  └── index.ts                # Webhook Adapter
```

**S5b：首个社交通道（钉钉）**
- `DingTalkAdapter` 实现 Core Interface
- dingtalk-stream SDK 长连接
- Markdown 消息回复
- `ApprovableChannel` trait（ActionCard 审批按钮）
- `ChannelConfirmationRenderer`（对接 ConfirmationBroker）
- 代理配置支持

**验证**：
- 钉钉机器人收到消息 → Agent 回复 → 钉钉显示 Markdown 消息
- Agent 请求工具审批 → 钉钉显示 ActionCard 按钮 → 用户点击 → Agent 继续
- 创建定时任务 + 投递到钉钉 → 到期执行 → 结果发到钉钉
- 代理配置 → 通过代理连接钉钉 SDK

**交付**：
```
packages/channels/dingtalk/
  ├── adapter.ts              # DingTalkAdapter
  ├── approval.ts             # ApprovableChannel trait 实现
  ├── confirmation-renderer.ts # ChannelConfirmationRenderer
  ├── format.ts               # Markdown 格式化
  └── index.ts
```

### S6（OS 级服务安装）

**本文档新增**：无。按原设计执行。

### S7（新增：OpenAI 兼容 API + 会话漫游）

**做什么**：
- `POST /v1/chat/completions` 端点（HTTP REST，非 WebSocket）
- SSE 流式响应
- 会话漫游（跨通道 DM 归入同一 session）
- 更多 RPC 方法：`schedule.*`、`channel.status`、`approval.respond`

**验证**：
- `curl -X POST /v1/chat/completions -d '{"messages":[...], "stream": true}'` → SSE 流式回复
- 钉钉 DM 开始对话 → CLI 继续 → 上下文连续
- RPC `schedule.list` 返回任务列表

**交付**：
```
packages/server/src/
  ├── openai-compat.ts        # /v1/chat/completions 处理
  └── session-roaming.ts      # 会话漫游逻辑
```

## 十二、决策记录

### DR-001: 为什么用 JSON-RPC 2.0 而不是自定义帧

**背景**：OpenClaw 设计了自定义的三帧格式（req/res/event）。

**决策**：使用 JSON-RPC 2.0 标准。

**理由**：
- JSON-RPC 2.0 是成熟标准，有现成客户端库（Python、Go、Rust 等社区适配器无需自写）
- 请求/响应/通知三种模式与 OpenClaw 的 req/res/event 同构，但语义更明确
- batch request 原生支持
- 错误码标准化（-32700 解析错误、-32600 无效请求 等）
- 知行未来可能需要非 JS 客户端（驭灵移动端），标准协议降低适配成本

### DR-002: 为什么首选钉钉而非 Slack

**背景**：OpenClaw 首选 Slack，Hermes 覆盖全部。

**决策**：知行首个社交通道实现钉钉。

**理由**：
- 产品定位是中文个人助手，用户群体首先是中国用户
- 钉钉 Stream Mode **不需要公网 IP / 域名**，个人部署零门槛
- 钉钉开放平台 SDK（dingtalk-stream for Node.js）成熟
- ActionCard 支持交互按钮，可实现 ApprovableChannel trait
- 验证成功后，飞书（lark-oapi）是自然的第二个通道

### DR-003: 为什么入站通过回调而非适配器方法

**背景**：Hermes 用 `handle_message()` 覆写、OpenClaw 用 gateway adapter slot。

**决策**：通过 `ctx.onMessage()` 回调传递入站消息。

**理由**：
- 回调模式下适配器只管"收到消息"，路由/去抖/会话绑定全部由 InboundRouter 统一处理
- 适配器不需要理解 session、agent turn 等核心概念
- 测试时直接调用 `ctx.onMessage()` 即可模拟入站，无需 mock 整个平台 SDK
- 与 Node.js EventEmitter / callback 生态一致

### DR-004: 为什么通道适配器用 trait 而不是装饰器或 mixin

**背景**：可选能力可以通过装饰器、mixin、或 trait（interface + 类型守卫）实现。

**决策**：使用 TypeScript interface + 运行时类型守卫。

**理由**：
- interface 是零运行时开销的编译期契约
- 类型守卫（`isEditable(adapter)`）提供运行时能力检测
- 不需要类继承链（避免 Hermes 基类膨胀问题）
- 适配器作者自由选择实现哪些 interface，不需要 "配置" 或 "注册"
- TypeScript 的 intersection type 天然支持多 trait 组合

### DR-005: 为什么做会话漫游

**背景**：OpenClaw 支持跨通道但需显式切换，Hermes/Claude Code 不支持。

**决策**：DM 场景下同一用户的多通道消息自动归入同一 session。

**理由**：
- 个人助手的核心体验是"它认识我"——不管我从哪个通道说话，它都记得之前聊过什么
- 实现简单：session key 从 `hash(userId, channelId)` 改为 `hash(userId, "dm")`
- 群场景不做漫游（不同群是不同上下文）
- 用户可以 `/new` 显式创建新 session

## 十三、核心类型汇总

```typescript
// ─── 入站消息 ───

interface InboundMessage {
  /** 发送者标识（跨通道统一为 userId） */
  from: string;
  /** 消息文本 */
  text: string;
  /** 来源通道 ID */
  channelId: string;
  /** 聊天类型 */
  chatType: "dm" | "group" | "channel" | "thread";
  /** 群/频道 ID */
  groupId?: string;
  /** 线程 ID */
  threadId?: string;
  /** 媒体附件 URL 列表 */
  mediaUrls?: string[];
  /** 是否是斜杠命令 */
  isCommand?: boolean;
  /** 原始平台消息（调试用） */
  raw?: unknown;
}

// ─── 出站内容 ───

interface OutboundContent {
  text: string;
  /** Markdown 格式（支持的通道会渲染，不支持的降级为纯文本） */
  markdown?: string;
  /** 媒体附件 */
  media?: Array<{ url: string; type: "image" | "file" | "audio" | "video" }>;
}

// ─── 投递目标 ───

interface DeliveryTarget {
  channelId: string;
  /** DM 目标用户 或 群/频道 ID */
  to: string;
  /** 线程 ID（可选） */
  threadId?: string;
}

// ─── 投递结果 ───

interface DeliveryResult {
  success: boolean;
  messageId?: string;
  error?: string;
  /** 是否可重试 */
  retryable: boolean;
}

// ─── 通道配置 ───

interface ChannelConfig {
  /** 通道类型 ID（dingtalk / feishu / webhook / ...） */
  type: string;
  /** 是否启用 */
  enabled: boolean;
  /** 平台凭证 */
  credentials: Record<string, string>;
  /** 默认投递目标（如 home channel） */
  defaultTarget?: DeliveryTarget;
  /** 通道特有设置 */
  options?: Record<string, unknown>;
}

// ─── 通道状态 ───

interface ChannelStatus {
  channelId: string;
  state: "connected" | "connecting" | "disconnected" | "error";
  error?: string;
  lastMessageAt?: string;
  /** 连接建立时间 */
  connectedAt?: string;
}
```

## 十四、文件布局规划

```
packages/
  core/src/
    channels/                    # 通道接口定义（Layer 1 + Layer 2）
      types.ts                   # ChannelAdapter, Traits, Messages
      capabilities.ts            # 类型守卫 (isEditable, isStreamable, ...)
      registry.ts                # ChannelRegistry
      index.ts

  server/                        # 新包：Server 进程
    src/
      index.ts                   # 入口
      server.ts                  # HTTP + WebSocket 服务器
      rpc/
        protocol.ts              # JSON-RPC 2.0 编解码
        methods.ts               # 方法注册表
        handlers/                # 每组方法一个文件
          session.ts
          schedule.ts
          channel.ts
          server.ts
      inbound/
        router.ts                # InboundRouter
        debouncer.ts             # 入站去抖
        session-binder.ts        # 会话绑定
        normalizer.ts            # 消息规范化
      outbound/
        delivery-router.ts       # 智能投递路由
      openai-compat.ts           # /v1/chat/completions
      daemon/
        process.ts               # fork + detach
        pid.ts                   # PID 文件
        service-manager.ts       # OS 服务安装
    package.json
    tsconfig.json

  channels/                      # 新包组：通道实现
    webhook/
      src/index.ts               # Webhook Adapter
      package.json
    dingtalk/
      src/
        adapter.ts
        approval.ts
        confirmation-renderer.ts
        format.ts
        index.ts
      package.json
    feishu/                      # 第二个通道（S5b 后）
      ...
```
