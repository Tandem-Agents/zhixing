# 远程权限确认执行规格

<!-- ══════════════════════════ 文档写作规约 · 请勿删除 ══════════════════════════ -->
> **📌 本文档是执行规格（execution spec），不是修订日志。**
>
> **只写**：
> - 当前生效的架构、方案、执行计划
> - 架构决策及其"为什么"(帮助理解当前设计)
> - 与真实代码的对接点(精确到文件路径 + 行号)
>
> **不写**（协作者修订时一并清理，不要叠加）：
> - 版本号、状态徽章、修订日期、"最后更新"行
> - `修订要点 / 修订历史 / vX.X vs vY.Y` 对比表
> - 决策演化标签（`v1.0 错误 / v2.0 修正 / v2.1 新增 / v2.x 上调` 等）
> - 废案与新案的对比（只保留当前采用方案，不写"为什么从 A 换成 B"）
> - 决策追溯链（"当初这么想 → 后来审查发现 → 于是改成"这种叙事）
>
> **演化方式**：设计变化时**原地修改**，不追加"v2.1 修订段"。历史与演化留给 `git log` / 专门的 ADR 文档，不在本文。
>
> **适用于**：所有 `research/design/specifications/*-execution.md` 规格文档。
<!-- ═════════════════════════════════════════════════════════════════════════ -->

> **文件作用**：远程权限确认（路线图 `Step 20`）的权威执行规格——基于纯文本往返协议的**通道无关**基础设施。
>
> Daemon 模式下无交互式终端，所有 `requiresConfirmation` 工具调用被永久拒绝——本 spec 解决这个硬阻塞。
>
> **前置规格**：
> - [confirmation-ux.md](./confirmation-ux.md) — Phase 1 已落地（Broker + TerminalRenderer + DisplayBody）
> - [conversation-model.md §5.3](./conversation-model.md) — TurnId / Turn / SessionRuntime 生命周期
> - [message-outbox.md](./message-outbox.md) — Outbox / EmissionSource / TurnSlot
> - [persistent-service.md §7](./persistent-service.md) — daemon 定位
>
> **已建基础（必读）**：
> - [packages/core/src/confirmation/broker.ts](../../../packages/core/src/confirmation/broker.ts) — Broker（onRequest / resolve / 超时 / cancelAll）
> - [packages/core/src/confirmation/types.ts](../../../packages/core/src/confirmation/types.ts) — Request / Decision / Renderer
> - [packages/core/src/channels/types.ts](../../../packages/core/src/channels/types.ts) — `ChannelAdapter.send` + onMessage 原语
> - [packages/cli/src/security/terminal-renderer.ts](../../../packages/cli/src/security/terminal-renderer.ts) — TTY 渲染器（本地路径，不影响远程）
> - [packages/cli/src/security/secure-executor.ts](../../../packages/cli/src/security/secure-executor.ts) — 双路径（broker / legacy）
> - [packages/server/src/channels/inbound-router.ts](../../../packages/server/src/channels/inbound-router.ts) — 入站路由 + TurnContext 构造
> - [packages/server/src/runtime/conversation-manager.ts](../../../packages/server/src/runtime/conversation-manager.ts) — Session 生命周期

---

## 0. 概念与背景

### 0.1 什么是远程确认

当智能体需要执行危险操作（bash 命令、写文件、发消息等），安全系统要求用户确认。CLI 交互模式下，终端弹出 select-with-input 面板（`packages/cli/src/tui/select-with-input.ts`）——`confirmation-ux.md` Phase 1 已实现这条路径。

**远程确认**是指：当**没有交互式终端**时（daemon 模式、定时任务执行、通道消息触发的 turn），确认请求通过任何用户可达的通道送达，用户回复后决策回传给 agent。

### 0.2 为什么是硬阻塞

当前代码路径（`packages/cli/src/security/secure-executor.ts`）：

```
serve 模式 → ConversationManager.getOrCreate() → createAgentRuntime()
    → 创建 confirmationBroker 但不 attach 任何 renderer
    → 工具调用触发 confirmation → broker 永远 pending
      → 无人 resolve → 超时 expired → secure-executor 抛 SecurityBlockError
```

Daemon 模式下：定时任务不能执行 bash 命令 / 通道消息触发的 agent 不能写文件 / 任何 `external` / `critical` 操作都被阻塞。

**不解决远程确认，daemon 模式只能跑 observe / internal 级别的"安全"工具——大幅削弱 Agent 能力。**

### 0.3 核心设计：文本往返协议

远程确认 = **一次文本消息往返**：

```
① broker.onRequest → Renderer 发一条纯文本消息到目标通道
② 用户在通道回复任意文本
③ InboundRouter 按词集匹配 → broker.resolve
     · 匹配允许词集 → allow-once
     · 匹配拒绝词集 → deny（无 reason，结构化拒绝）
     · 其他任意文本 → deny + reason（整条消息作为 reason 传给 LLM，自由文本拒绝）
```

**通道能力要求**：仅需 `ChannelAdapter.send(target, content)` + `onMessage(listener)`——所有通道天然满足，**不要求任何富交互能力**（按钮 / 卡片 / 状态更新 / SDK 约束）。

**为什么不用按钮 / 卡片**：

- OpenClaw / Hermes / Claude Code 都选"平台原生按钮"——因为它们是社交平台机器人，按钮是平台第一等 UX
- 知行是 **agent harness**，远程确认是 daemon 模式的工具安全闸，不是聊天交互；用户回复天然就是"对 agent 问题的答案"
- 自由文本理由可直接作为 `{ kind: "deny", reason }` 的 reason 回流给 LLM——**知行相对竞品的核心差异化价值**（按钮模型传不了自由文本）
- 一旦引入按钮 trait，每个通道都要实现一套；文本协议下新通道**零额外代码**

按钮 UX 作为某通道未来的可选增强，作为独立的 `channel-{platform}-approval-enhancement.md` spec 接入；本 spec 不依赖、不感知。

### 0.4 与已有 Broker 架构的关系

Phase 1 的 `ConfirmationBroker` 架构天然支持文本往返：

```
ConfirmationBroker（per-AgentRuntime，既有）
  onRequest(listener)   ← Renderer 订阅
  resolve(id, decision) ← 任何来源解决（原子抢占，首次 true 后续 false）
  cancelAll(cause)      ← session-end 时清场

├─ TerminalRenderer（既有）            ← CLI 本地 TTY
└─ TextConfirmationRenderer（新增）    ← 远程通道
   └─ 仅调用 adapter.send(target, text)
```

`InboundRouter` 已有命令拦截机制（处理 `/approve` `/deny`），本 spec 将其**泛化**为 pending-aware 词集匹配——不再限于 `/` 前缀命令。

---

## 1. 竞品对比

| 维度 | OpenClaw | Hermes | Claude Code | 知行本 spec |
|------|---------|--------|-------------|-----------|
| 交互主路径 | 平台按钮（`ChannelApprovalAdapter` per-plugin） | 平台按钮（`send_exec_approval` per-platform）| Channel MCP 通知（Telegram/iMessage/Discord）| **纯文本往返**，任何通道天然支持 |
| 文本命令 fallback | ❌ | ✅ `/approve` `/deny`（6 变体）| ❌ | **pending-aware 词集匹配**（中英文各 20+ 表达 + 任意文本 = 理由）|
| 新通道接入 | 实现 `ChannelApprovalAdapter` + 按钮渲染 | 实现平台按钮逻辑 | 实现 MCP notification | **0 额外代码**（通道支持 `send` + `onMessage` 即可）|
| 多赛道竞赛 | ❌ 串行优先级 | ❌ 单一来源 | ✅ 5 赛道原子 `claim()` | ✅ Broker 原生 `resolve()` 原子 |
| LLM 理由回流 | 需额外 UI 表单 | ❌（按钮枚举）| ❌ | ✅ **用户自由文本 → `{ kind: "deny", reason }` → LLM 看到调整方案** |
| 无人响应 | `askFallback` 三档 | `mode=smart` LLM 分诊 | `shouldAvoidPermissionPrompts` 自动拒绝 | `confirmationFallback`：deny（默认）/ auto-approve-safe |
| 回原对话路由 | ✅ 四元组 | ❌ 只有 session_key | ❌ 固定路由 | ✅ **TurnOrigin**（channel + target + triggeredBy）|

**本 spec 的核心超越点**：把**通道无关**做到底——不造新 trait、不包特定平台 SDK；所有通道用同一套文本协议，LLM 友好性内建。

---

## 2. 范围

### 2.1 本规格覆盖

| 能力 | 产出文件 |
|------|---------|
| **ConfirmationHub**（server 级聚合层）| `packages/server/src/confirmation/hub.ts`（新增）|
| **TurnOrigin 类型 + 全链路注入** | `packages/core/src/confirmation/types.ts` 扩展 + 3 个 turn 入口（InboundRouter / RPC session / Scheduler）+ 2 个透传点（ephemeral-executor / task-executor）|
| **TextConfirmationRenderer** | `packages/server/src/confirmation/text-renderer.ts`（新增）|
| **文本匹配规则 + pending-aware 拦截** | `packages/server/src/confirmation/match.ts`（新增）+ `inbound-router.ts` 扩展 |
| **ConfirmationBridge**（RPC 推送单一出口）| `packages/server/src/rpc/confirmation-bridge.ts`（新增）|
| **确认 RPC 方法** | `packages/server/src/rpc/methods/confirmation.ts`（新增）|
| **超时降级策略** | `packages/server/src/types.ts` 新增 `confirmationFallback` |

### 2.2 非范围

- **通道按钮 / 卡片增强**（飞书 Interactive Card、钉钉 ActionCard 等）——若需要作为独立 `channel-{platform}-approval-enhancement.md` spec 接入，不在本 spec
- **LLM 辅助分诊**（Smart mode）——依赖 `confirmation-ux.md` Phase 3
- **Web UI 前端**——RPC 协议已备好，客户端项目启动后接入
- **二次验证**（验证码 / 生物识别）——安全增强，远期
- **持久授权**（`allow-session` / `allow-workspace` / `allow-global`）——远程路径不支持；持久授权走本地 `/trust` 命令，与 Phase 1 对齐

### 2.3 依赖既有能力

| 既有能力 | 落地位置 | 复用方式 |
|---------|---------|---------|
| `ConfirmationBroker` | `packages/core/src/confirmation/broker.ts` | `onRequest` / `resolve` / `cancelAll` / `listPending` 直接用；**扩展 `onResolved` 事件** |
| `ConfirmationRequest` / `Decision` | `packages/core/src/confirmation/types.ts` | 扩展可选 `turnOrigin` 字段 |
| `ChannelAdapter.send` + onMessage | `packages/core/src/channels/types.ts` | Renderer 唯一的通道调用 |
| `secure-executor.ts` | `packages/cli/src/security/secure-executor.ts` | 既有 broker 路径零改动（仅 `handleBrokerPath` 透传 turnContext）|
| `request-builder.ts` | `packages/cli/src/security/request-builder.ts` | 扩展填充 `turnOrigin` |
| `TurnContext` | `packages/core/src/types/tools.ts` | 扩展可选 `turnOrigin` |
| `InboundRouter` | `packages/server/src/channels/inbound-router.ts` | `handleMessage` 入口加 pending-aware 拦截 |
| `ConversationManager.addObserver` | `packages/server/src/runtime/conversation-manager.ts:209` | Bridge 按 observer 定向推送 |
| `RpcConnection.notify` | `packages/server/src/rpc/connection.ts:37` | Bridge 推送 RPC 通知 |

---

## 3. 架构设计

### 3.1 整体架构

```
┌─ @zhixing/core（零改动核心 + 小扩展）────────────────────────┐
│  ConfirmationBroker（既有，per-AgentRuntime 实例）           │
│   + onResolved 事件（新增 ~5 行 API）                        │
│  ConfirmationRequest（扩展可选 turnOrigin）                  │
└────────────────────┬─────────────────────────────────────────┘
                     │
      ┌──────────────┼─────────────────────────┐
      ▼                                        ▼
┌───────────────────────────┐    ┌───────────────────────────┐
│ ConfirmationHub           │    │ ConfirmationBridge        │
│ （@zhixing/server，新增） │←───│ （@zhixing/server，新增） │
│                           │订阅│                           │
│ attach/detach per broker  │    │ RPC 推送单一出口          │
│ listAllPending            │    │  · request 事件 → pending │
│ resolve（跨 broker 路由） │    │  · resolved 事件 → resolved│
│ findBrokerByConversation  │    │ 按 conversation observer  │
│ onEvent                   │    │ 定向过滤推送              │
└──────────┬────────────────┘    └───────────────────────────┘
           │ onEvent("request")
           ▼
┌────────────────────────────┐
│ TextConfirmationRenderer   │
│ （@zhixing/server，新增）  │
│                            │
│ 解析 turnOrigin.target →   │
│ adapter.send(target,       │
│   formatConfirmationMsg()) │
│                            │
│ 不感知 resolved 事件       │
│ （Bridge 独立推 RPC）      │
└────────────────────────────┘

InboundRouter.handleMessage 入口（conversations.enqueue 之前）：
  hub.findBrokerByConversation(convId).listPending().length > 0
    ├ 匹配允许词集 → broker.resolve(allow-once)
    ├ 匹配拒绝词集 → broker.resolve({ kind: "deny" })（结构化拒绝）
    └ 其他任意文本 → broker.resolve({ kind: "deny", reason: 整条消息 })（自由文本拒绝）
  无 pending → 正常进 agent 流程
```

**多赛道竞赛**：
- TerminalRenderer 和 TextConfirmationRenderer 不会同时 attach 同一个 broker（CLI 模式无 server；serve 模式无 TTY）
- **同一 broker 内的多来源竞赛**：通道用户回复 + RPC 客户端调 `confirmation.resolve` → 都经 `broker.resolve()` 原子 claim（首次 true 后续 false）

### 3.2 ConfirmationHub：聚合 per-runtime broker

`AgentRuntime` 每次创建都 `new ConfirmationBroker()`（`run-agent.ts:214`），server 中存在 N+1 个 broker：N 个会话各一个 + 1 个 ephemeralRuntime（定时任务专用）。Hub 作为聚合层，保持 broker per-runtime（zero-touch REPL），对外提供统一查询 / 解决面。

**ConversationManager 接口对接点**：
- API：`getOrCreate`（:151）/ `delete`（:412）/ `disposeAll`（:423）/ 私有 `releaseIfEmpty`（:465）/ `startIdleReaper` 内清理（:477-500）
- `session.runtime.dispose()` 调用点共 4 处：`:417` / `:436` / `:470` / `:493`——**每一处 dispose 之前都必须先 `hub.detach(brokerId)`**
- `AgentRuntime.confirmationBroker` 是 public readonly 字段（`run-agent.ts:93`），Hub 直接读取，无需 getter
- `SessionRuntime` 接口（`runtime/types.ts:27-47`）新增可选 `confirmationBroker?: IConfirmationBroker`（`AgentRuntime` 天然满足）

```typescript
// packages/server/src/confirmation/hub.ts（新增 ~200 行）

import type {
  IConfirmationBroker, ConfirmationDecision, ConfirmationRequest,
  ConfirmationRequestId, CancelCause,
} from "@zhixing/core";

export type BrokerId = string;

export interface HubEntry {
  readonly request: ConfirmationRequest;
  readonly brokerId: BrokerId;
  readonly conversationId?: string;
}

export type HubEvent =
  | { type: "request";  entry: HubEntry }
  | { type: "resolved"; requestId: ConfirmationRequestId; brokerId: BrokerId; conversationId?: string; decision: ConfirmationDecision };

interface BrokerRegistration {
  readonly brokerId: BrokerId;
  readonly broker: IConfirmationBroker;
  readonly conversationId?: string;
  readonly unsubscribeOnRequest: () => void;
  readonly unsubscribeOnResolved: () => void;
}

export class ConfirmationHub {
  private readonly brokers = new Map<BrokerId, BrokerRegistration>();
  private readonly requestIndex = new Map<ConfirmationRequestId, BrokerId>();
  /** conversationId → brokerId 反向索引（findBrokerByConversation 的 O(1) 路径） */
  private readonly conversationIndex = new Map<string, BrokerId>();
  private readonly listeners = new Set<(event: HubEvent) => void>();

  attach(brokerId: BrokerId, broker: IConfirmationBroker, opts?: { conversationId?: string }): void {
    if (this.brokers.has(brokerId)) {
      throw new Error(`Broker ${brokerId} already attached`);
    }
    const convId = opts?.conversationId;
    if (convId && this.conversationIndex.has(convId)) {
      // INV-H1：同一 conversationId 至多 attach 一个 broker
      throw new Error(`Conversation ${convId} already has attached broker`);
    }
    const unsubReq = broker.onRequest((request) => {
      this.requestIndex.set(request.id, brokerId);
      this.emit({ type: "request", entry: { request, brokerId, conversationId: convId } });
    });
    const unsubRes = broker.onResolved((requestId, decision) => {
      this.requestIndex.delete(requestId);
      this.emit({ type: "resolved", requestId, brokerId, conversationId: convId, decision });
    });
    this.brokers.set(brokerId, { brokerId, broker, conversationId: convId, unsubscribeOnRequest: unsubReq, unsubscribeOnResolved: unsubRes });
    if (convId) this.conversationIndex.set(convId, brokerId);
  }

  /**
   * detach 顺序：先 cancelAll 触发 pending 的 resolved 事件 → 再取消订阅 → 清索引。
   * 防止 pending 请求的 resolved 事件丢失（导致客户端界面卡住在"待确认"）。
   */
  detach(brokerId: BrokerId, opts?: { cancelPending?: boolean; cause?: CancelCause }): void {
    const reg = this.brokers.get(brokerId);
    if (!reg) return;

    if (opts?.cancelPending ?? true) {
      reg.broker.cancelAll(opts?.cause ?? "session-end");
    }
    reg.unsubscribeOnRequest();
    reg.unsubscribeOnResolved();
    for (const [reqId, bId] of this.requestIndex) {
      if (bId === brokerId) this.requestIndex.delete(reqId);
    }
    if (reg.conversationId) this.conversationIndex.delete(reg.conversationId);
    this.brokers.delete(brokerId);
  }

  listAllPending(): HubEntry[] {
    const out: HubEntry[] = [];
    for (const reg of this.brokers.values()) {
      for (const req of reg.broker.listPending()) {
        out.push({ request: req.request, brokerId: reg.brokerId, conversationId: reg.conversationId });
      }
    }
    return out;
  }

  resolve(requestId: ConfirmationRequestId, decision: ConfirmationDecision): boolean {
    const brokerId = this.requestIndex.get(requestId);
    if (!brokerId) return false;
    const reg = this.brokers.get(brokerId);
    if (!reg) return false;
    return reg.broker.resolve(requestId, decision);
  }

  /** O(1) 反向索引查找——热路径（InboundRouter 每条入站消息都调）*/
  findBrokerByConversation(conversationId: string): IConfirmationBroker | undefined {
    const brokerId = this.conversationIndex.get(conversationId);
    if (!brokerId) return undefined;
    return this.brokers.get(brokerId)?.broker;
  }

  onEvent(listener: (event: HubEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: HubEvent): void {
    for (const fn of this.listeners) {
      try { fn(event); } catch { /* swallow */ }
    }
  }
}
```

**Hub 不变量**：

- **INV-H1**：同一 `conversationId` 至多 attach 一个 broker——由 `ConversationManager.getOrCreate` 对 conversationId 去重保证。`findBrokerByConversation` 依赖此不变量
- **INV-H2**：`brokerId` 全局唯一（`attach` 重复抛错）。命名规约：会话 broker = `conv:${conversationId}`，定时任务 broker = `ephemeral`
- **INV-H3**：`detach` 顺序为"先 cancelAll → 取消订阅 → 清索引"——防止 pending 请求的 resolved 事件丢失

**与 ConversationManager 的协同**（M2b 实现）：

```typescript
// conversation-manager.ts（+30 行）

// 构造参数新增 confirmationHub?: ConfirmationHub
// getOrCreate 返回前 attach：
async getOrCreate(conversationId?: string, options?: { ephemeral?: boolean }): Promise<ManagedSession> {
  // ... 既有逻辑 ...
  const session = /* 新建或已存在 */;
  if (this.confirmationHub && session.runtime.confirmationBroker && !this.attachedBrokers.has(session.conversationId)) {
    this.confirmationHub.attach(
      `conv:${session.conversationId}`,
      session.runtime.confirmationBroker,
      { conversationId: session.conversationId },
    );
    this.attachedBrokers.add(session.conversationId);
  }
  return session;
}

// 四处 session.runtime.dispose() 之前插入 detach（:417 / :436 / :470 / :493）：
private detachFromHub(conversationId: string): void {
  if (!this.confirmationHub || !this.attachedBrokers.has(conversationId)) return;
  this.confirmationHub.detach(`conv:${conversationId}`);
  this.attachedBrokers.delete(conversationId);
}

// 新增：observer 单一数据源——Bridge 推送用
getObserverConnectionIds(conversationId: string): ReadonlySet<string> {
  return this.sessions.get(conversationId)?.observers ?? EMPTY_SET;
}
```

**EphemeralRuntime 协同**：

```typescript
// serve/command.ts（+5 行）
const ephemeralRuntime = await createAgentRuntime({ ... });
hub.attach("ephemeral", ephemeralRuntime.confirmationBroker);  // public 字段，直接读
// 进程生命周期内不 detach
```

### 3.3 TurnOrigin：确认请求的回程地址

**设计意图**：确认请求必须能路由回"发起这个 turn 的地方"。

| 来源 | turnOrigin | 回程目标 |
|------|------------|---------|
| 通道用户消息 | `{ channel: "feishu", target: { channelId, to, threadId }, triggeredBy: userId }` | 原通道的同一对话 |
| RPC `session.send`（Web UI / IDE）| `{ channel: "rpc", triggeredBy: connectionId }` | 仅 RPC 推送（按 observer 过滤）|
| Scheduler → ephemeralRuntime | `{ channel: "scheduler", target?: defaultTarget, triggeredBy: taskId }` | task.deliveryTarget / 配置的 defaultTarget / 仅 RPC |

```typescript
// packages/core/src/types/tools.ts（与 TurnContext 同文件；依赖方向向下）

export interface TurnOrigin {
  /** 入口通道标识符 */
  channel: "feishu" | "dingtalk" | "wechat" | "rpc" | "cli" | "scheduler" | string;
  /** 投递目标——若可达则确认请求路由到这里 */
  target?: DeliveryTarget;
  /** 触发者（用户 ID / connectionId / taskId）——审计 + 推送过滤 + 发起者校验 */
  triggeredBy?: string;
}

// TurnContext / ToolExecutionContext 也新增 turnOrigin?: TurnOrigin 字段
// （per-turn 透传路径）

// packages/core/src/confirmation/types.ts 引用：
export interface ConfirmationRequest {
  // ...既有字段
  turnOrigin?: TurnOrigin; // import from "../types/tools.js"
}
```

> **放置位置说明**：`TurnOrigin` 定义在 `types/tools.ts`（与 `TurnContext` 同文件），
> 而非 `confirmation/types.ts`。原因：`TurnOrigin` 是 turn 层通用元信息，`ConfirmationRequest`
> 是其使用者之一——让 confirmation 依赖 types 比反向更符合"依赖向下"原则。

**与 EmissionSource 的关系**（[message-outbox.md §3.3](./message-outbox.md)）：`EmissionSource` 标"消息从哪里来"，`TurnOrigin` 标"确认请求要回哪里去"。两者正交，共用 `DeliveryTarget` 类型。

**全链路注入清单**（3 个 turn 入口 + 2 个透传点）：

| # | 类型 | 文件 | 改动 |
|---|------|------|------|
| 1 | 🎯 入口 | `packages/server/src/channels/inbound-router.ts` `runChannelTurn` | 已构造 turnContext，加 `turnOrigin: { channel: msg.channelId, target: replyTarget, triggeredBy: msg.from }` |
| 2 | 🎯 入口 | `packages/server/src/rpc/methods/session.ts` `runManagedTurn` | `runtime.run(text, signal)` → `runtime.run(text, { abortSignal: signal, turnContext: { turnId, turnOrigin: { channel: "rpc", triggeredBy: connection.id } } })`。`SessionRuntime.run` 第二参已兼容 `AbortSignal \| RunTurnOptions`（`runtime/types.ts:22-39`），零接口改动 |
| 3 | 🎯 入口 | `packages/cli/src/serve/command.ts` `runAgentTurn`（Scheduler 注入）| `runEphemeralTurn({ ..., turnContext: { turnId, turnOrigin: { channel: "scheduler", target: task.deliveryTarget, triggeredBy: task.id } } })` |
| 4 | ↪ 透传 | `packages/cli/src/serve/ephemeral-executor.ts` `runEphemeralTurn` | 新增可选 `turnContext?: TurnContext`，透传到 `runtime.run`。`AgentRuntime.RunParams.turnContext?` 已存在（`run-agent.ts:125`）|
| 5 | ↪ 透传 | `packages/core/src/scheduler/task-executor.ts` | `AgentTurnParams` 加可选 `taskId + deliveryTarget?`，`executeTask` 调用 `runAgentTurn` 时从 `task` 读取透传 |

**REPL 模式**：本地 TTY，走 TerminalRenderer，turnOrigin 缺省 `undefined`。
**CLI 一次性命令**：单次执行，同上。

### 3.4 TextConfirmationRenderer

```typescript
// packages/server/src/confirmation/text-renderer.ts（新增 ~120 行）

import type {
  ConfirmationRequest, DisplayBody,
  ChannelLogger, ChannelRegistry, DeliveryTarget,
} from "@zhixing/core";
import type { ConfirmationHub, HubEntry, HubEvent } from "./hub.js";

export interface TextRendererOptions {
  hub: ConfirmationHub;
  channels: ChannelRegistry;
  /** scheduler ephemeral 无 turnOrigin.target 时的兜底投递目标 */
  defaultTarget?: DeliveryTarget;
  logger: ChannelLogger;
}

export class TextConfirmationRenderer {
  readonly name = "text-remote";
  private unsubHub?: () => void;

  constructor(private readonly opts: TextRendererOptions) {}

  start(): void {
    this.unsubHub = this.opts.hub.onEvent((event) => {
      if (event.type === "request") void this.dispatch(event.entry);
      // resolved 事件由 Bridge 统一推 RPC；本渲染器不处理。
      // 超时/取消场景下通道消息无需"更新已失效状态"——纯文本消息发出去就发出去了，
      // 用户超时后回复会收到 InboundRouter 的"已处理"回执（§3.5）。
    });
  }

  stop(): void {
    this.unsubHub?.();
  }

  private async dispatch(entry: HubEntry): Promise<void> {
    const target = entry.request.turnOrigin?.target ?? this.opts.defaultTarget;
    if (!target) {
      // 无可达通道——只靠 RPC（Bridge 独立推送），文本路径 skip
      this.opts.logger.info?.("confirmation.remote.no-target", { requestId: entry.request.id });
      return;
    }
    const adapter = this.opts.channels.get(target.channelId);
    if (!adapter) {
      this.opts.logger.warn?.("confirmation.remote.send-failed", {
        requestId: entry.request.id,
        channelId: target.channelId,
        error: "adapter-not-found",
      });
      return;
    }
    try {
      await adapter.send(target, { text: formatConfirmationMessage(entry.request) });
      this.opts.logger.info?.("confirmation.remote.sent", {
        requestId: entry.request.id,
        channelId: target.channelId,
        conversationId: entry.conversationId,
      });
    } catch (err) {
      this.opts.logger.warn?.("confirmation.remote.send-failed", {
        requestId: entry.request.id,
        channelId: target.channelId,
        error: err,
      });
    }
  }
}

/** 格式化确认消息——通道无关纯文本 */
export function formatConfirmationMessage(request: ConfirmationRequest): string {
  const detail = formatOperationDetail(request.display.body);
  const riskLevel = request.decision?.riskLevel ?? "medium";
  const minutes = Math.max(1, Math.round((request.expiresAt - Date.now()) / 60000));
  return [
    `🔒 需要批准：${request.display.title}`,
    ``,
    detail,
    ``,
    `风险等级：${riskLevel} · ${minutes} 分钟内回复：`,
    `• 允许本次：好 / y / yes / 可以 / 同意 / 干吧 / 1`,
    `• 拒绝：   不 / n / no / 拒绝 / 算了 / 2`,
    `• 或直接说明拒绝理由（会传给 AI 参考）`,
  ].join("\n");
}

function formatOperationDetail(body: DisplayBody): string {
  switch (body.kind) {
    case "bash":
      return "```\n" + body.commandPreview + "\n```";
    case "file-write":
      return `文件：${body.path}` + (body.preview ? `\n内容预览：${body.preview.slice(0, 200)}` : "");
    case "file-edit":
      return `文件：${body.path}`;
    case "file-read":
      return `文件：${body.path}`;
    case "generic":
      return body.summary;
  }
}
```

**关键不变量**：

- **INV-T1**：同一 request 只发一次消息——由 Hub 的 `request` 事件只触发一次（broker FIFO + 首次 showing 保证）
- **INV-T2**：`send` 失败不重试——记 warn；request 自然超时由 broker `expire` 机制兜底
- **INV-T3**：无"已失效"通道侧更新——文本协议下消息就是消息，用户超时回复会收到 InboundRouter 的回执（§3.5 `ok=false` 分支）

### 3.5 InboundRouter pending-aware 拦截

**拦截位置**：必须在 `InboundRouter.handleMessage` 的入口、`this.conversations.enqueue(...)` **之前**（`inbound-router.ts:130` 之前）——命令不占用 conversation 队列位，不触发 agent 推理，不计入 transcript。否则高并发下用户回复可能被当成普通提问排队。

```typescript
// packages/server/src/channels/inbound-router.ts（约 +80 行）

async handleMessage(msg: InboundMessage): Promise<void> {
  const conversationId = await resolveConversationId(msg, ...);

  // ── ① pending-aware 拦截（在 enqueue 之前） ──
  if (this.confirmationHub) {
    const handled = await this.tryHandleAsConfirmationReply(msg, conversationId);
    if (handled) return;
  }

  // ── ② 正常调度：enqueue → runChannelTurn ──
  // ...既有逻辑
}

private async tryHandleAsConfirmationReply(
  msg: InboundMessage,
  conversationId: string,
): Promise<boolean> {
  const broker = this.confirmationHub!.findBrokerByConversation(conversationId);
  const pending = broker?.listPending() ?? [];
  if (pending.length === 0) return false;

  const text = msg.text.trim();
  if (!text) return false;  // 空消息不拦截，让正常流程处理

  const target = pending[0];  // broker FIFO 保证队首在 showing

  // ── 发起者身份校验（防止群聊下 B 用户误批准 A 的 pending） ──
  // DEFAULT_BINDING_POLICY.group="per-group" 时群成员共享 conversationId——
  // 必须校验 msg.from === 原请求发起者，否则 B 说"好"会误批准 A 的操作。
  const originSender = target.request.turnOrigin?.triggeredBy;
  const originChannel = target.request.turnOrigin?.channel;
  if (originSender && originChannel === msg.channelId && originSender !== msg.from) {
    this.logger.info("confirmation.reply.not-owner-skip", {
      requestId: target.request.id, channelId: msg.channelId,
      expectedSender: originSender, actualSender: msg.from,
    });
    return false;  // 不匹配 → 不拦截，让消息走正常 agent 流程
  }

  const decision = matchTextToDecision(text);
  const ok = broker!.resolve(target.request.id, decision);

  // 可观测性埋点（§3.10 契约）
  const channelId = msg.channelId;
  if (!ok) {
    this.logger.info("confirmation.reply.stale", { requestId: target.request.id, channelId });
  } else if (isFreeTextDeny(decision)) {
    this.logger.info("confirmation.reply.matched-reason", {
      requestId: target.request.id, channelId,
      reasonLength: decision.reason.length,
    });
  } else {
    this.logger.info("confirmation.reply.matched-structured", {
      requestId: target.request.id, channelId, decision: decision.kind,
    });
  }

  // 回执：**控制流直接 adapter.send 绕过 Outbox**（§3.7），与 TextRenderer 同源同策
  const replyTarget = buildReplyTarget(msg);
  const adapter = this.channels.get(replyTarget.channelId);
  if (adapter) {
    await adapter.send(replyTarget, {
      text: formatResolutionReceipt(target.request, decision, ok),
    }).catch(/* log error */);
  }

  return true;  // 已处理，不进入 agent 流程
}
```

**已知限制**（非本 spec 范围的后续增强）：群聊场景下 TextRenderer 仍然把 confirmation 消息
发送到群 target，其他群成员可见（隐私）。误批准已通过发起者校验杜绝；隐私泄露需要
adapter 能力扩展以支持"从群 message 降级发 DM"，作为独立 `channel-{platform}-*` spec 接入。

### 3.6 文本匹配规则

匹配前做标准化：`text.trim().replace(TRAILING_PUNCT_RE, "").normalize("NFKC").toLowerCase()`。采用**保守完全匹配**——必须完全等于集合中的词才识别为结构化决策；其他任何文本作为自由文本拒绝，产出 `{ kind: "deny", reason }`（与结构化 deny 共用 kind，通过 reason 是否存在区分；`@zhixing/core` 的 `isFreeTextDeny` 提供统一判别入口）。

```typescript
// packages/server/src/confirmation/match.ts（新增 ~60 行）

import type { ConfirmationDecision, ConfirmationRequest } from "@zhixing/core";

/** 允许本次——覆盖常见肯定表达（中英文 + 数字 + 口语） */
const APPROVE_SET = new Set<string>([
  // 英文
  "y", "yes", "yep", "yeah", "yup", "ok", "okay", "sure", "approve",
  // 数字
  "1",
  // 中文短词
  "好", "好的", "好啊", "行", "行的", "可以", "同意", "允许",
  "批准", "通过", "执行", "继续", "没问题",
  // 口语 / 情绪
  "干吧", "去吧", "做吧", "来", "来吧", "嗯", "嗯嗯",
]);

/** 拒绝——覆盖常见否定表达（中英文 + 数字 + 口语） */
const DENY_SET = new Set<string>([
  // 英文
  "n", "no", "nope", "cancel", "stop", "deny", "reject",
  // 数字
  "2",
  // 中文短词
  "不", "不行", "不要", "不用", "拒绝", "否",
  "不同意", "不可以", "不批准", "不通过",
  // 口语 / 情绪
  "算了", "别", "停", "取消", "不了",
]);

/**
 * 拒绝理由最大长度——超过截断，防止膨胀 LLM 上下文与 token 成本。
 * 2000 字符约 500-700 token，足够完整表达绝大多数拒绝意图。
 */
export const MAX_REASON_LENGTH = 2000;

/**
 * 末尾标点 / 空白 trim——中英文 IM 习惯性在短回复后加标点（"好。" / "好的！" / "yes."），
 * 不处理会被当成自由文本拒绝导致批准命中率塌方。只 trim **末尾**，保守避免误伤
 * （"不要删！"里的 `！` 不能 trim——那是理由的一部分）。
 */
const TRAILING_PUNCT_RE = /[。！？、，：;；\!\?\.\,\:\;~～\s]+$/u;

/**
 * 文本 → ConfirmationDecision。
 * - 完全匹配允许词集（去末尾标点后）→ allow-once
 * - 完全匹配拒绝词集（去末尾标点后）→ { kind: "deny" }（结构化，无 reason）
 * - 其他任意非空文本 → { kind: "deny", reason: 原文 }（自由文本，保留原文 trim 后的内部格式）
 * - 空白输入调用方应提前过滤，本函数不处理（见 §3.5 `!text` 分支）
 */
export function matchTextToDecision(text: string): ConfirmationDecision {
  const trimmed = text.trim();
  // 结构化匹配前再去末尾标点
  const key = trimmed.replace(TRAILING_PUNCT_RE, "").toLowerCase();
  if (APPROVE_SET.has(key)) return { kind: "allow-once" };
  if (DENY_SET.has(key)) return { kind: "deny" };
  // 自由文本作为拒绝理由——过长时截断 + 标注省略
  const reason = trimmed.length > MAX_REASON_LENGTH
    ? trimmed.slice(0, MAX_REASON_LENGTH) + "…（理由已截断）"
    : trimmed;
  return { kind: "deny", reason };
}

export function formatResolutionReceipt(
  request: ConfirmationRequest,
  decision: ConfirmationDecision,
  ok: boolean,
): string {
  if (!ok) {
    return `⚠️ 操作已被处理（可能已超时或在其他端批准 / 拒绝）：${request.display.title}`;
  }
  switch (decision.kind) {
    case "allow-once":
      return `✅ 已允许：${request.display.title}`;
    case "deny":
      // reason 可选：有 reason 带理由段，无 reason 为结构化拒绝
      return decision.reason
        ? `❌ 已拒绝：${request.display.title}\n理由已转给 AI：${decision.reason}`
        : `❌ 已拒绝：${request.display.title}`;
    default:
      return `已处理：${request.display.title}`;
  }
}
```

**关键语义**：

| 用户回复 | 匹配结果 | 回执 |
|---------|---------|------|
| `y` / `好` / `可以` / `干吧` / `1` | `allow-once` | `✅ 已允许：<title>` |
| `好。` / `好的！` / `yes.` / `可以～` | `allow-once`（末尾标点自动 trim）| `✅ 已允许：<title>` |
| `n` / `不` / `算了` / `2` / `不行！` | `deny`（无 reason） | `❌ 已拒绝：<title>` |
| `不要删数据库！那是生产环境` | `deny` + reason=原文（自由文本拒绝） | `❌ 已拒绝：<title>\n理由已转给 AI：不要删数据库！那是生产环境` |
| （>2000 字符的长文本）| `deny` + reason 截断至 2000 + `…（理由已截断）` | 同上 |
| （超时后回复任意）| broker `resolve` 返 false | `⚠️ 操作已被处理（...）` |
| （空白消息）| 不拦截 | 正常进入 agent 流程 |

**设计原则**：

- **末尾标点 trim**：`好。` / `yes.` / `好的！` 一律识别为允许——IM 用户 80%+ 的短回复带句末标点，不 trim 会导致批准命中率塌方
- **只 trim 末尾不 trim 中间**：`"不要删！那是生产"` 的内部 `！` 保留——**那是理由的一部分**
- **保守完全匹配**：去末尾标点后仍必须完全等于集合成员，防"好啊我知道了"被误判为 allow
- **reason 长度截断**：上限 2000 字符（约 500-700 token）+ `…（理由已截断）` 标注——防止超长消息膨胀 LLM 上下文 / token 成本
- **LLM 友好**：不在集合的文本一律作为自由文本拒绝（`{ kind: "deny", reason }`）回流，语义由 LLM 解读
- **无持久授权**：不支持 `allow-session` / `allow-workspace`——远程路径只管单次授权，持久授权走本地 `/trust` 命令（与 Phase 1 对齐）

### 3.7 Outbox 协同：确认消息绕过 Outbox

**问题**：Outbox（[message-outbox.md](./message-outbox.md)）为同一 `(channelId, to)` 提供 FIFO 串行化 + 因果依赖（`afterSlot`）。确认消息走 Outbox 会死锁：

```
turn 开始 → outbox.openSlot(turnId)        ← slot 打开
     → 工具触发 confirmation
     → send 确认消息（如走 outbox）→ 排队等 slot fill
     → slot fill 需要工具完成 → 工具完成需要用户回复 → 用户回复需要看到消息 → 消息等 slot
     → 死锁
```

**决策**：确认消息是**控制流**，与"内容流"（LLM 回复 / 工具承诺 / 定时任务结果）正交。**控制流绕过 Outbox**，`TextConfirmationRenderer` 直接调 `adapter.send()`。

**理由**：
1. 确认消息必须立即可见——用户不应等 LLM 回复 fill slot 才看到
2. 超时由 broker 内部 timer 保证（30 分钟），不需要 Outbox 的 expired
3. 回执（"✅ 已允许"）走正常 send（InboundRouter 既有命令回复也是这模式）

**未来演进**：若引入"控制流 Outbox"（独立队列、独立优先级），可将确认消息接入；本 spec 不做。

### 3.8 超时与降级策略

```typescript
// packages/server/src/types.ts（扩展 ServerConfig）

export type ConfirmationFallbackStrategy =
  | "deny"                // 默认：拒绝所有超时请求
  | "auto-approve-safe";  // 仅 observe/internal 自动批准
```

**超时流程**：
1. Broker `expiresAt` 到期 → 内部 timer → `resolve(id, { kind: "expired" })` 自动触发
2. Hub 收到 resolved 事件 → Bridge 推 RPC（可选前端展示"已超时"）
3. `secure-executor` 收到 `expired` decision → 按 `confirmationFallback`：
   - `deny` → 抛 SecurityBlockError（默认）
   - `auto-approve-safe` → 检查 operationClass：observe/internal 放行，external/critical 拒绝

**默认超时**：30 分钟（已有，`request-builder.ts:43`）。可通过 `ServerConfig.confirmationTimeoutMs` 覆盖。

### 3.9 RPC 推送与 ConfirmationBridge

**定位**：Bridge 是 RPC 通知的**单一出口**。TextConfirmationRenderer 只负责发通道消息；RPC 推送完全由 Bridge 处理，同时处理 `request` 和 `resolved` 事件。这种职责分层避免了"Renderer 和 Bridge 同时订阅 resolved 导致重复推送 / 遗漏推送"的歧义。

**隐私过滤**：`confirmation.pending` 暴露 `tool / operationDetail / turnOrigin.triggeredBy`——多客户端共享 server 时不能广播。Bridge 复用 `ConversationManager.getObserverConnectionIds`（M2b 新增方法）定向推送。

```typescript
// packages/server/src/rpc/confirmation-bridge.ts（新增 ~140 行）

import type { RpcConnection } from "./connection.js";
import type { ConfirmationHub, HubEvent, HubEntry } from "../confirmation/hub.js";
import type { ConversationManager } from "../runtime/index.js";
import type { DisplayBody } from "@zhixing/core";

export interface ConfirmationBridgeDeps {
  connections: ReadonlySet<RpcConnection>;
  hub: ConfirmationHub;
  conversations: ConversationManager;
}

export function createConfirmationBridge(deps: ConfirmationBridgeDeps) {
  const { connections, hub, conversations } = deps;

  const notifyTargets = (targets: Iterable<RpcConnection>, method: string, params: unknown) => {
    for (const conn of targets) {
      if (conn.authenticated && !conn.closed) conn.notify(method, params);
    }
  };

  /** 按 conversationId 解析推送目标（observer-scoped） */
  const resolveTargets = (conversationId?: string): RpcConnection[] => {
    if (conversationId) {
      const observerIds = conversations.getObserverConnectionIds(conversationId);
      return [...connections].filter((c) =>
        c.authenticated && !c.closed && observerIds.has(c.id),
      );
    }
    // 无 conversationId（scheduler ephemeral 兜底）→ admin-scoped
    // MVP：广播到所有 authenticated；多租户时加 role 过滤
    return [...connections].filter((c) => c.authenticated && !c.closed);
  };

  const unsubHub = hub.onEvent((event: HubEvent) => {
    if (event.type === "request") {
      const targets = resolveTargets(event.entry.conversationId);
      notifyTargets(targets, "confirmation.pending", buildPendingPayload(event.entry));
    } else {
      const targets = resolveTargets(event.conversationId);
      notifyTargets(targets, "confirmation.resolved", {
        requestId: event.requestId,
        conversationId: event.conversationId,
        decision: event.decision.kind,  // 不暴露 reason / note
        resolvedAt: Date.now(),
      });
    }
  });

  return {
    dispose() { unsubHub(); },
  };
}

function buildPendingPayload(entry: HubEntry) {
  const req = entry.request;
  return {
    requestId: req.id,
    conversationId: entry.conversationId,
    tool: req.tool,
    operationSummary: req.display.title,
    operationDetail: flattenDisplayBody(req.display.body),
    riskLevel: req.decision?.riskLevel,
    expiresAt: req.expiresAt,
    turnOrigin: req.turnOrigin,
  };
}

function flattenDisplayBody(body: DisplayBody): string {
  switch (body.kind) {
    case "bash":       return body.commandPreview;
    case "file-write": return body.path + (body.preview ? ` — ${body.preview.slice(0, 100)}` : "");
    case "file-edit":  return body.path;
    case "file-read":  return body.path;
    case "generic":    return body.summary;
  }
}
```

**RPC 方法**：

```typescript
// packages/server/src/rpc/methods/confirmation.ts

// 远程可使用的 decision kind 白名单——spec §2.2 禁止远程创建持久授权规则
const REMOTE_ALLOWED_KINDS = new Set(["allow-once", "deny"]);

/** 列出当前连接可见的 pending（按 observer 过滤；显式传 conversationId 也须是 observer）*/
"confirmation.list": (params: { conversationId?: string }, ctx) => {
  const all = ctx.confirmationHub.listAllPending();
  const callerId = String(ctx.connection.id);
  const visible = params.conversationId
    ? ctx.conversations.getObserverConnectionIds(params.conversationId).has(callerId)
      ? all.filter((e) => e.conversationId === params.conversationId)
      : []  // 非 observer → 过滤为空
    : all.filter((e) => {
        if (!e.conversationId) return false;  // ephemeral 不对普通 observer 暴露
        return ctx.conversations.getObserverConnectionIds(e.conversationId).has(callerId);
      });
  return { items: visible.map(toListItem) };
};

/** 解决一个 pending（Web UI 按钮点击调用）—— 三层校验：kind 白名单 + 权限 + race */
"confirmation.resolve": (params, ctx) => {
  // 1. 参数 shape（invalidParams）
  if (!params.requestId || !params.decision?.kind) throw RpcErrors.invalidParams(...);
  // 2. kind 白名单——远程不允许持久授权（防绕过本地 /trust 审计）
  if (!REMOTE_ALLOWED_KINDS.has(params.decision.kind)) throw RpcErrors.invalidParams(...);
  // 3. 按 requestId 反查 entry + 权限校验
  const entry = ctx.confirmationHub.findEntry(params.requestId);
  if (!entry) return { ok: false, reason: "already-resolved-or-not-found" };
  if (entry.conversationId) {
    const observerIds = ctx.conversations.getObserverConnectionIds(entry.conversationId);
    if (!observerIds.has(String(ctx.connection.id))) throw RpcErrors.unauthorized(...);
  } else {
    throw RpcErrors.unauthorized("ephemeral resolve needs admin role (not implemented)");
  }
  // 4. 实际 resolve（权限通过后可能仍因 race 返 false）
  const ok = ctx.confirmationHub.resolve(params.requestId, params.decision);
  return ok ? { ok: true } : { ok: false, reason: "already-resolved-or-not-found" };
};
```

**安全不变量**：
- **INV-R1（kind 白名单）**：远程路径仅接受 `allow-once` / `deny`；持久授权（`allow-workspace` 等）
  只能通过本地 `/trust` 命令创建——防止远程客户端绕过本地审计
- **INV-R2（observer-scoped resolve）**：`confirmation.resolve` 的 caller 必须是目标 conversation
  的 observer——防止多客户端共享 token 时 A 解决 B 的请求
- **INV-R3（ephemeral 拒绝远程 resolve）**：scheduler/ephemeral 的 pending 暂不允许远程
  解决（MVP 保守），等 admin role 体系

**推送 schema**：

```typescript
/** 新 pending 请求到达 */
"confirmation.pending": {
  requestId: string;
  conversationId?: string;
  tool: string;
  operationSummary: string;      // display.title
  operationDetail: string;        // flatten 后的操作细节（命令 / 文件路径 / 摘要）
  riskLevel: "low" | "medium" | "high" | "critical";
  expiresAt: number;
  turnOrigin?: TurnOrigin;
}

/** 请求被解决（任何来源） */
"confirmation.resolved": {
  requestId: string;
  conversationId?: string;
  decision: ConfirmationDecision["kind"];  // 不暴露 reason / note
  resolvedAt: number;
}
```

### 3.10 可观测性事件约定

远程确认的**真实使用数据**是词集迭代、超时调优、故障告警的唯一信号来源。本 spec 定义以下事件契约——实施时在对应代码点通过 `logger.info` 以事件名为首参数的结构化形式输出（或未来接入 EventBus 订阅）。

| 事件 | 触发点 | payload | 产品 / 工程用途 |
|------|--------|---------|----------------|
| `confirmation:requested` | `broker.requestConfirmation`（既有，`broker.ts:175`）| tool / operationClass / riskLevel / queueDepth | 工具触发频率；按 tool 分布分析风险热点 |
| `confirmation:resolved` | broker 的 resolve 路径（既有，`broker.ts:223`）| tool / decision.kind / durationMs | 批准率；平均决策耗时 |
| `confirmation:expired` | broker 的 expire 路径（既有，`broker.ts:346`）| tool / durationMs | **超时率——过高意味着用户意识不到 / 通道不可达 / 文案不清晰** |
| `confirmation.remote.sent` | `TextRenderer.dispatch` 成功调用 `adapter.send`（M4 新增）| requestId / channelId / conversationId? | 通道投递成功率 |
| `confirmation.remote.send-failed` | `TextRenderer.dispatch` `adapter.send` 抛错（M4 新增）| requestId / channelId / error | **通道故障告警基础——连续失败触发降级 / 报警** |
| `confirmation.remote.no-target` | `TextRenderer.dispatch` 无 turnOrigin.target 且无 defaultTarget（M4 新增）| requestId | 定时任务未配置兜底 target 的频率 |
| `confirmation.reply.matched-structured` | InboundRouter 匹配 allow-once / deny（M5 新增）| requestId / decision.kind / channelId | **结构化匹配比例——低则词集覆盖不足**（驱动 APPROVE_SET / DENY_SET 扩容） |
| `confirmation.reply.matched-reason` | InboundRouter 匹配自由文本拒绝（`isFreeTextDeny(decision)`，M5 新增）| requestId / channelId / reasonLength | 自由文本比例 / 长度分布（驱动 MAX_REASON_LENGTH 调整） |
| `confirmation.reply.stale` | InboundRouter 已有 pending 但 `broker.resolve` 返 false（M5 新增）| requestId / channelId | 超时 race 频率（B1 边界评估） |
| `confirmation.reply.not-owner-skip` | InboundRouter 收到回复但 `msg.from !== turnOrigin.triggeredBy`（群聊防误批准，Fix-3 新增）| requestId / channelId / expectedSender / actualSender | **群聊误回复频率——持续非零意味着需要用户端教育或 DM 降级** |
| `confirmation.remote.reply-sent` | InboundRouter 回执 `adapter.send` 成功（Fix-4 绕 Outbox 后新增，可选）| requestId / channelId | 回执成功率对照参考 |

**埋点原则**：
- **不要求新建 EventBus 订阅者**——埋点即契约，未来 analytics 模块按契约订阅
- **事件名可作为 grep 字符串使用**——开发联调直接用 `rg 'confirmation\.remote\.sent'` 定位行为
- **payload 不含 reason / note / operationDetail**——避免日志里落用户隐私内容
- **减法原则**：本清单已覆盖全部设计目标；M4 / M5 实施时**不要添加**本清单之外的新事件，保持埋点集合稳定

---

## 4. 核心决策汇总

| # | 决策 | 选择 |
|---|------|------|
| A1 | 远程确认核心模型 | **纯文本往返**——通道无关，仅依赖 `ChannelAdapter.send` + `onMessage` |
| A2 | 通道能力依赖 | **无新 trait**——不引入 `ApprovableChannel` 之类的富交互抽象 |
| A3 | 多赛道竞赛 | Broker 原生 `resolve()` 原子 claim，零额外代码 |
| A4 | Broker 注入策略 | `ConfirmationHub` 聚合 per-runtime broker——REPL 零改动 |
| A5 | TurnOrigin 入口 | **3 个 turn 入口全链路注入**：InboundRouter（通道）/ RPC `session.send` / Scheduler→Ephemeral |
| A6 | 文本匹配规则 | 允许词集 + 拒绝词集 + 其他 = 自由文本拒绝（`{ kind: "deny", reason }`）；**保守完全匹配**防误判 |
| A7 | 无人响应策略 | `confirmationFallback`：deny（默认）/ auto-approve-safe |
| A8 | 通道目标解析 | `origin.target → defaultTarget → 仅 RPC`（绝不 fan-out 到所有通道）|
| A9 | RPC 推送粒度 | **Observer-scoped**：按 `ConversationManager.getObserverConnectionIds` 定向；无 conversationId → admin-scoped |
| A10 | Bridge 职责 | **RPC 推送的单一出口**——同时处理 request + resolved；Renderer 不与 Bridge 共享推送职责 |
| A11 | Outbox 协同 | 确认消息绕过 Outbox（控制流与内容流分离，避免 slot 死锁）|
| A12 | 持久授权 | **远程路径不支持** `allow-session` / `allow-workspace`——持久授权走本地 `/trust` |
| A13 | `IConfirmationBroker.onResolved` | core 独立扩展（M2a），与 server Hub（M2b）解耦 |
| A14 | `SessionRuntime.confirmationBroker` | 接口新增可选字段；`AgentRuntime` 天然满足，零实现改动 |
| A15 | InboundRouter 拦截位置 | `handleMessage` 入口、`conversations.enqueue` 之前（不占队列位，不触发 agent 推理）|
| A16 | Hub.detach 顺序 | **先 cancelAll → 取消订阅 → 清索引**——防止 pending 的 resolved 事件丢失导致客户端 stuck |

---

## 5. 渐进实现（8 个独立可验证里程碑）

设计原则：**每个里程碑独立可 merge、可验证、可回滚**。M0 / M1 / M2a / M2b / M3 / M4 / M5 / M6 / M7 共 8 个，总计 **~11 工作小时**（约 1.5 工作日）。

### M0 — RFC 定稿（0h）

本 spec 即是 RFC。无代码改动。

### M1 — TurnOrigin 类型扩展 + 全链路注入（3.5h）

> 实现 A5 决策。远程确认的最基础依赖。

**接口对接点**：
- `SessionRuntime.run(text, AbortSignal | RunTurnOptions)` 已原生兼容对象参数（`runtime/types.ts:22-39`）——不改接口
- `AgentRuntime.RunParams.turnContext?` 已存在（`run-agent.ts:125`）——不改接口
- 所有改动都是新增字段或新增可选参数，零破坏性变更

**改动清单**：

| 文件 | 行数 | 说明 |
|------|------|------|
| `packages/core/src/confirmation/types.ts` | +15 | 新增 `TurnOrigin` + `ConfirmationRequest.turnOrigin?` |
| `packages/core/src/types/tools.ts` | +5 | `TurnContext.turnOrigin?: TurnOrigin` |
| `packages/core/src/scheduler/types.ts` | +5 | `AgentTurnParams` 加可选 `taskId` + `deliveryTarget?` |
| `packages/core/src/scheduler/task-executor.ts` | +5 | `executeTask` 调用 `runAgentTurn` 时从 `task` 读取并透传 |
| `packages/server/src/channels/inbound-router.ts` | +8 | `runChannelTurn`（:156）在 turnContext（:171）上加 `turnOrigin` |
| `packages/server/src/rpc/methods/session.ts` | +15 | `runManagedTurn`（:100-112）改用对象参数透传 turnContext |
| `packages/cli/src/serve/ephemeral-executor.ts` | +5 | `EphemeralTurnOptions` 加可选 `turnContext?: TurnContext` |
| `packages/cli/src/serve/command.ts` | +10 | `runAgentTurn` 构造 turnContext 并透传 |
| `packages/cli/src/security/request-builder.ts` | +8 | `BuildConfirmationRequestParams` 加 `turnContext` 并写入 request |
| `packages/cli/src/security/secure-executor.ts` | +3 | `handleBrokerPath`（:189-208）透传 `context.turnContext` |

**验证**：
- 全量测试 green（仅扩展可选字段，零行为变化）
- 新增 ~70 行测试：InboundRouter / RPC / Scheduler 三路径都生成正确 turnOrigin；secure-executor 守护断言 `buildConfirmationRequest` 被调用时 `turnContext` 非空

**前置**：无。**并行**：与 M2a。**回滚**：revert 可选字段——零影响。

### M2a — Broker.onResolved 事件扩展（core 包，1h）

> 实现 A13 决策。core 独立 merge，避免跨包 PR 阻塞。

**背景**：Hub 需要知道"某请求已被解决"才能推 resolved 事件。目前 `IConfirmationBroker` 只有 `onRequest`（`types.ts:346`），必须在 core 扩展。

**改动清单**：

| 文件 | 行数 | 说明 |
|------|------|------|
| `packages/core/src/confirmation/types.ts` | +5 | `IConfirmationBroker.onResolved(listener: (requestId, decision) => void): BrokerUnsubscribe` |
| `packages/core/src/confirmation/broker.ts` | +25 | 新增 `resolvedListeners` + `onResolved()` 方法；在 `resolve`/`cancel`/`expire` 三处成功路径末尾触发；`requestConfirmation` 的"无监听器兜底"和"backpressure"两条非交互路径也必须触发（保持事件完整性）|
| `packages/core/src/confirmation/__tests__/broker.test.ts` | +60 | 三路径触发 / 取消订阅后不触发 / 兜底路径触发 / backpressure 路径触发 |

**前置**：无。**并行**：与 M1。**回滚**：revert 纯新增，无下游依赖。

### M2b — ConfirmationHub + ConversationManager 钩子（server 包，2h）

> 实现 A4 + A14 + A16 决策。

**改动清单**：

| 文件 | 行数 | 说明 |
|------|------|------|
| `packages/server/src/confirmation/hub.ts` | +200（新增）| Hub 类（attach / detach / listAllPending / resolve / findBrokerByConversation / onEvent）；detach 先 cancelAll 再取消订阅 |
| `packages/server/src/confirmation/__tests__/hub.test.ts` | +150（新增）| 多 broker 隔离 / 跨 broker resolve / detach 顺序（cancelAll → resolved 事件到达 Hub listener → 清索引）/ INV-H1~H3 守护 |
| `packages/server/src/context.ts` | +3 | `ServerContext.confirmationHub?: ConfirmationHub` 可选 |
| `packages/server/src/runtime/types.ts` | +3 | `SessionRuntime.confirmationBroker?: IConfirmationBroker` 可选字段 |
| `packages/server/src/runtime/conversation-manager.ts` | +30 | 构造参数 `confirmationHub?`；`getOrCreate` 返回前 attach（`attachedBrokers: Set<string>` 去重）；4 处 `session.runtime.dispose()` 之前调 `detachFromHub`（:417 / :436 / :470 / :493）；新增 `getObserverConnectionIds(convId): ReadonlySet<connId>` 方法 |
| `packages/cli/src/serve/command.ts` | +8 | 创建 Hub 实例 + 注入 `ServerContext`；`ConversationManager` 构造时传 hub；`ephemeralRuntime` 直接 `hub.attach("ephemeral", ephemeralRuntime.confirmationBroker)` |

**前置**：M1 + M2a。**并行**：无。**回滚**：删 hub.ts + 移除 ConversationManager 钩子——等价当前 serve 模式（confirmation 永久 pending → 30min expire → 拒绝）。

### M3 — ConfirmationBridge + 确认 RPC 方法（2h）

> 实现 A9 + A10 决策。

**改动清单**：

| 文件 | 行数 | 说明 |
|------|------|------|
| `packages/server/src/rpc/confirmation-bridge.ts` | +140（新增）| `createConfirmationBridge`：订阅 `hub.onEvent` → 按 observer 过滤 → `conn.notify`；request 和 resolved 统一处理 |
| `packages/server/src/rpc/methods/confirmation.ts` | +100（新增）| `confirmation.list`（按 observer 过滤）+ `confirmation.resolve`（结构化调用——Web UI 按钮用）|
| `packages/server/src/rpc/methods/index.ts` | +3 | 注册新命名空间 |
| `packages/server/src/rpc/__tests__/confirmation-bridge.test.ts` | +150（新增）| observer 过滤 / admin-scoped 兜底 / request+resolved 都按 conversationId 定向 / dispose 取消订阅 |
| `packages/server/src/rpc/methods/__tests__/confirmation.test.ts` | +80（新增）| list 过滤 / resolve 成功 / 已解决返 `{ ok: false }` |
| `packages/cli/src/serve/command.ts` | +5 | 创建 Bridge + 注入 + `disposeOnShutdown` |

**前置**：M2b。**并行**：与 M4 / M5。**回滚**：删 bridge.ts + confirmation.ts + 注销方法。

### M4 — TextConfirmationRenderer（1h）

> 实现 A1 + A8 决策。远程确认的核心渲染器。

**改动清单**：

| 文件 | 行数 | 说明 |
|------|------|------|
| `packages/server/src/confirmation/text-renderer.ts` | +120（新增）| Renderer 类（start/stop）+ `formatConfirmationMessage` + `formatOperationDetail` |
| `packages/server/src/confirmation/__tests__/text-renderer.test.ts` | +100（新增）| 有 target → `adapter.send` / 无 target → skip / adapter 找不到 → warn / send 失败不抛 / 消息格式快照（含词集提示行）/ **埋点事件**（`confirmation.remote.sent` / `.send-failed` / `.no-target`）按 §3.10 契约触发 |
| `packages/cli/src/serve/command.ts` | +8 | 创建 Renderer + `start()`，挂到 ServerContext `disposeOnShutdown` |

**前置**：M2b。**并行**：与 M3 / M5。**回滚**：删 text-renderer.ts——serve 模式回到 expired-deny。

### M5 — InboundRouter pending-aware 匹配（1.5h）

> 实现 A6 + A15 决策。

**改动清单**：

| 文件 | 行数 | 说明 |
|------|------|------|
| `packages/server/src/confirmation/match.ts` | +60（新增）| `APPROVE_SET` + `DENY_SET` 词集 + `matchTextToDecision` + `formatResolutionReceipt` |
| `packages/server/src/channels/inbound-router.ts` | +80 | `tryHandleAsConfirmationReply` 方法 + `handleMessage` 入口调用（在 `enqueue` 之前）|
| `packages/server/src/confirmation/__tests__/match.test.ts` | +80（新增）| APPROVE_SET 全覆盖 / DENY_SET 全覆盖 / 中文词 / 大小写无关 / 前后空白 trim / **末尾标点 trim**（"好。"/"Yes."/"好的！"/"可以～"→ allow-once；"不行！"→ deny）/ **NFKC 归一化**（"ｙｅｓ"/"Ｏｋ" 全角识别）/ 内部标点保留（"不要删！那是生产" → `{ kind: "deny", reason }` 且 reason 含 `！`）/ 其他文本 → 自由文本拒绝保留原文 / **超长 reason 截断**（>2000 字符 → 截断 + "…（理由已截断）"）|
| `packages/server/src/channels/__tests__/inbound-router.test.ts` | +120 | 有 pending + y/n/其他 / 无 pending 不拦截 / 多 broker 隔离（B 会话回复不影响 A）/ 空消息不拦截 / 回执文案 / **埋点事件**（`confirmation.reply.matched-structured` / `.matched-reason` / `.stale`）按 §3.10 契约触发 |

**前置**：M2b（`hub.findBrokerByConversation`）。**并行**：与 M3 / M4。**回滚**：还原 handleMessage 入口拦截块。

### M6 — 超时策略 + UX 文案（1h）

> 实现 A7 决策。

**改动清单**：

| 文件 | 行数 | 说明 |
|------|------|------|
| `packages/server/src/types.ts` | +5 | `ServerConfig.confirmationFallback?: ConfirmationFallbackStrategy` |
| `packages/cli/src/security/secure-executor.ts` | +10 | `expired` decision 分支按 `confirmationFallback` 决定（deny / auto-approve-safe）|
| `packages/server/src/confirmation/__tests__/fallback.test.ts` | +50（新增）| `deny` 策略 → expired = SecurityBlockError；`auto-approve-safe` → observe/internal 放行，external/critical 拒绝 |

**前置**：M4 / M5 完成。**回滚**：revert secure-executor 改动。

### M7 — E2E 验收 + 文档（1h）

**E2E 场景**（任意支持 `send` + `onMessage` 的通道验证，MVP 用 feishu adapter 的文本发送能力即可）：

```
场景 1：通道消息 → 工具 → 词集批准
  用户："帮我创建 README.md"
  agent 调 write → server 发确认消息（包含文件路径、允许/拒绝词集提示）
  用户回复："好" → 工具执行 → 结果回同一对话

场景 2：定时任务 → 工具 → 自由文本拒绝
  schedule 任务到期 → agent 调 bash rm 命令
  → server 发确认消息到创建任务时的会话
  → 用户回复："不要碰这个目录，生产环境"
  → 工具被拒绝，reason 回流 LLM → LLM 调整方案重试

场景 3：超时降级
  确认消息发出 → 30 分钟无回复 → broker expire
  → secure-executor 按 fallback=deny 抛 SecurityBlockError
  → 用户事后回复"好" → 收到"⚠️ 操作已被处理"回执

场景 4：多 broker 隔离
  会话 A 有 pending → 用户在会话 B 回复"好"
  → B 无 pending，正常进入 agent 流程（不影响 A 的 pending）

场景 5：RPC 客户端
  WebSocket 客户端连接 + `session.observe(conv1)` → conv1 触发 confirmation
  → 客户端收到 confirmation.pending 通知
  → 客户端调 confirmation.resolve → broker 解决
  → 所有 observer 客户端收到 confirmation.resolved

场景 6：用户中文表达覆盖
  用户分别回复："可以"/"干吧"/"嗯嗯" → 都识别为 allow-once
  用户分别回复："不行"/"算了"/"停" → 都识别为 deny

场景 7：跨端抢占
  会话有 pending → 通道用户回复"好"（同一毫秒）+ RPC 客户端调 resolve(deny)
  → broker.resolve 先到者返 true，后到者返 false
  → 后到者端看到"⚠️ 操作已被处理"
```

**文档同步**：
- `research/design/implementation-roadmap.md` P2：依赖修正为 `Step 17 ✅ + confirmation-ux.md Phase 1 ✅`（移除 `ApprovableChannel` 依赖）
- `research/_meta/progress.md`：更新 Step 20 为 ✅

**前置**：M3 / M4 / M5 / M6 完成。

---

## 6. 工作量与依赖图

```
M0 (0h)   RFC 定稿（本 spec）
  │
  ├── M1  (3.5h)  TurnOrigin + 全链路注入
  ├── M2a (1h)    Broker.onResolved 扩展（core 包）      ← 与 M1 并行
  │       │
  │       └─── M1 + M2a 完成 → M2b
  │              │
  │              ├── M2b (2h)  ConfirmationHub + ConversationManager
  │              │       │
  │              │       ├── M3 (2h)   Bridge + RPC methods                ← 与 M4 / M5 并行
  │              │       ├── M4 (1h)   TextConfirmationRenderer            ← 与 M3 / M5 并行
  │              │       └── M5 (1.5h) InboundRouter pending-aware 匹配    ← 与 M3 / M4 并行
  │              │               │
  │              │               └── M6 (1h)  超时策略 + fallback
  │              │                     │
  │              │                     └── M7 (1h)  E2E + 文档
```

**总计 ~11 小时**（约 1.5 工作日）。

**关键路径**：M1 (3.5h) → M2b (2h) → M5 (1.5h) → M6 (1h) → M7 (1h) = **9h**；M2a / M3 / M4 在关键路径外并行。

**合并顺序建议**（3 个 PR）：
1. **PR-1（M0 + M2a）**：纯 core 改动——`onResolved` 事件扩展 → ~1h
2. **PR-2（M1）**：类型扩展 + 全链路注入 + secure-executor 承接 → ~3.5h
3. **PR-3（M2b → M7）**：Hub + Bridge + Renderer + Router + 超时 + E2E → ~6.5h（可进一步拆 M2b+M3+M4+M5 和 M6+M7 两个 PR）

---

## 7. 风险与回滚

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 用户对 pending-aware 拦截预期错位（想插入聊天反被当成拒绝理由）| 中 | 非预期自由文本拒绝 | ① 确认消息文案明确"任意文本 = 拒绝理由"；② LLM 看到理由可再问一次；③ 超时兜底 |
| 词集覆盖不全，用户表达识别不到 | **低** | 本应 allow 的回复被当成自由文本拒绝 | ① 末尾标点 trim 已覆盖"好。"/"Yes."/"好的！"等 IM 典型输入（§3.6）；② NFKC 归一化识别全角字母；③ 词集中英文 + 数字 + 口语 + 情绪共 40+ 条；④ 可观测性事件 `confirmation.reply.matched-reason` 跟踪自由文本比例，高则补集合；⑤ LLM 仍能从 reason 推断意图 |
| 超时 expire 与用户回复的 race（30:05 回复但 30:00 已 expire）| 低 | 用户消息进入正常 agent 流程，体验尴尬但无安全风险 | ① 文案明确"30 分钟内回复"；② 未来优化：InboundRouter 查 `broker.resolvedRecent`（grace 15s 内）识别"晚到的确认回复"；MVP 不做 |
| 长 reason 膨胀 LLM 上下文 | 低 | 单次工具拒绝消耗 1500+ token | `matchTextToDecision` 截断到 2000 字符 + `…（理由已截断）` 标注（§3.6 `MAX_REASON_LENGTH`）|
| 群聊环境跨用户误批准 | 低 | B 用户回复"好"误批准 A 的 pending | **依赖前提**：`conversation-model.md` 按 `(channelId + userId)` 隔离 conversation（§9 已声明）；未来"共享 conversation"语义需重新评估 |
| Hub.detach 没 cancelAll 导致 pending stuck | 低 | 客户端卡片一直"待确认" | INV-H3：detach 先 cancelAll 触发 resolved 事件再清索引（§3.2 + M2b 测试守护）|
| 多 broker 内存泄漏 | 低 | session release 未 detach | M2b 的 ConversationManager 钩子保证 4 处 dispose 前 detach + 单元测试守护 |
| RPC 通知泄漏他人会话 | 低 | 多客户端看到别人操作细节 | Bridge observer-scoped 过滤；admin-scoped 兜底仅作用于单用户 daemon |
| 持久授权能力缺失（用户想要"始终允许"）| 低 | 远程路径每次都要回复 | 本 spec 主动不实现——持久授权走本地 `/trust`（与 Phase 1 对齐）；远程用户想持久授权需 CLI 本地登录 |
| Hub 引入额外间接层导致延迟 | 低 | broker → hub → renderer / bridge | 实测内存事件转发 <0.1ms；`findBrokerByConversation` 已用反向索引 O(1)（§3.2）|
| 空消息 / 异常字符拦截 | 低 | 空白消息不该触发 | `tryHandleAsConfirmationReply` 前做 trim；空字符串跳过拦截（§3.5 `!text`）|

**整体回滚策略**：
- 所有改动集中在**新增文件** + **可选字段扩展**
- **无核心 broker / 安全管线 / agent-loop 的破坏性修改**
- M1 单独 merge：仅可选字段，完全等价
- M2b 单独 merge：Hub 存在但无 Renderer/Bridge → 等价当前 serve 模式（永久 pending → expire → 拒绝）
- M4 + M5 单独 merge：有文本路径但无 RPC → 通道用户可确认，Web UI 客户端看不到推送
- 最保守回滚：删除 text-renderer.ts + InboundRouter 拦截 + bridge.ts → serve 模式回到 expired-deny

---

## 8. 架构可扩展性

| 未来方向 | 本 spec 已铺垫的扩展点 |
|---------|----------------------|
| **任意新通道接入** | 只要通道实现 `ChannelAdapter.send` + `onMessage`（已是核心接口）即自动支持，**零额外代码** |
| **平台原生按钮 / 卡片**（飞书 / 钉钉 / 微信 / Slack）| 作为独立 `channel-{platform}-approval-enhancement.md` spec：在 InboundRouter 拦截前注入一层"native action callback → `broker.resolve`"；Renderer 前置一层 trait 检测发按钮。本 spec 的文本协议作为 fallback 不变 |
| **Web UI 前端** | RPC 已备好：`confirmation.pending` / `confirmation.resolved` 推送 + `confirmation.list` / `confirmation.resolve` 调用——客户端自由渲染 UI（按钮 / 对话框 / 通知栏），调 `confirmation.resolve` 即可 |
| **IDE 插件** | 同 Web UI——通过 WebSocket RPC |
| **LLM 辅助分诊**（confirmation-ux Phase 3）| 在 InboundRouter 拦截前或 Renderer 前置一层 classifier（APPROVE/DENY/ESCALATE），不破坏架构 |
| **批量操作**（"全部允许" / "全部拒绝"）| 词集扩展 + broker 遍历 pending 解决 |
| **二次验证**（危险操作需额外验证码）| 在 `allow-once` 决策前插一个验证步骤（发验证码到备用通道）|
| **控制流 Outbox** | 当前确认消息绕过 Outbox；未来若需引入控制流因果保证，可加独立 ControlOutbox 队列 |

**关键原则**：

1. **核心层（本 spec）只管通道无关的文本协议 + Broker 协议**——不感知任何特定平台
2. **富交互增强作为可选上层模块**——绝不污染核心层
3. **新客户端通过 WebSocket RPC 接入**——`confirmation.*` 是稳定协议

---

## 9. 与其他规格的边界

| 规格 | 关系 | 边界 |
|------|------|------|
| `confirmation-ux.md` | 父规格 | 本 spec 是 `ConfirmationRenderer` 接口的远程实现；TerminalRenderer 不变；远程路径**不引入** `allow-session` / `allow-workspace`（与 Phase 1 CLI 选项对齐）|
| `conversation-model.md` | 兄弟规格 | ① 本 spec 的 Hub 通过 ConversationManager 生命周期钩子接入；新增 `getObserverConnectionIds` 复用既有 observer 映射（observer 单一数据源）；② **关键前提假设**：conversation-model 按 `(channelId + userId)` 隔离 conversation——群聊场景下不同用户拥有各自独立的 conversation，因此 B 用户在 A 会话的通道里回复"好"会路由到 B 自己的 conversation（无 pending，正常进 agent 流程），**不会误批准 A 的操作**。未来若引入"共享 conversation"语义（多用户协作），本 spec 的 pending-aware 拦截需同步重新评估 |
| `message-outbox.md` | 兄弟规格 | 本 spec 的确认消息**绕过** Outbox（控制流，§3.7）；回执走正常 send（不强制 Outbox）|
| `persistent-service.md` | 父规格 | 本 spec 是 daemon 模式可用性的关键阻塞修复；持久层不变 |
| `security-system.md` | 兄弟规格 | 本 spec 不修改 SecurityPipeline；仅改 secure-executor 的 expired 处理（M6）|
| `server-gateway.md` | 兄弟规格 | **不依赖** §4.2 `ApprovableChannel` trait；仅依赖核心 `ChannelAdapter.send` + `onMessage` |

---

## 10. 附录：术语表

| 术语 | 定义 |
|------|------|
| **ConfirmationBroker** | per-AgentRuntime 的确认调度器（`onRequest` / `resolve` / `timeout` / `cancelAll`）。`packages/core/src/confirmation/broker.ts` |
| **ConfirmationHub** | server 级聚合层，聚合所有 per-runtime broker 的事件，提供统一查询/解决面 |
| **TextConfirmationRenderer** | 文本协议渲染器，仅调 `ChannelAdapter.send` 发确认消息；不处理 resolved（Bridge 推 RPC）|
| **ConfirmationBridge** | RPC 推送的**单一出口**；订阅 Hub 的 request + resolved 事件，按 conversation observer 定向推给 RPC 客户端 |
| **pending-aware 拦截** | InboundRouter 在 `enqueue` 前检查当前会话是否有 pending confirmation；有则按词集匹配规则解决（不占队列、不触发 agent 推理）|
| **TurnOrigin** | turn 发起入口的元数据（channel + target? + triggeredBy?）；确认请求的回程地址 |
| **EmissionSource** | `message-outbox.md` 的消息来源标签——与 TurnOrigin 正交 |
| **TurnId** | `conversation-model.md §5.3` 的全局 turn 唯一标识 |
| **confirmationFallback** | 超时降级策略（`deny` / `auto-approve-safe`）|
| **APPROVE_SET / DENY_SET** | 词集匹配规则的允许/拒绝短词集合——中英文 + 数字 + 口语共 40+ 条，完全匹配识别 |
