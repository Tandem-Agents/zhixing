# OpenClaw — 子 Agent 与 Task 工具机制分析

> **分析状态**: 已分析(2026-04-28)
>
> **分析范围**:`sessions_spawn` 工具入口、子 agent 启动路径、生命周期 registry、完成回调(announce)、控制层(steer/kill/cascade)、深度限制、工具子集策略、上下文模式(isolated/fork)、双 runtime(subagent / acp)。

## 模块定位

OpenClaw **没有** Anthropic 官方 Claude Code 那种命名为 `Task` 的工具。它有功能等价物——名为 `sessions_spawn` 的工具(见 `src/agents/tools/sessions-spawn-tool.ts:199`)。**OpenClaw 没有"独立子 agent loop"的抽象**:子 agent 不是新进程、也不是新的 agent loop 类,而是**通过 gateway RPC `method:"agent"` 启动的另一个普通 chat run**——和主 agent 用同一份 `dispatchInboundMessage` 入口,共享同一份 attempt 实现(`pi-embedded-runner/run/attempt.ts`),只是 sessionKey 不同(`agent:<id>:subagent:<uuid>`)。"子 agent" 这个概念在 OpenClaw 里实际是**带有 spawnDepth 标记的另一种 session 形态 + 一组反向通知机制(announce)+ 一组控制 RPC(subagents tool)**。

OpenClaw 同时支持两套子 agent runtime:

1. **`runtime: "subagent"`(原生)**:在自己 daemon 内启动新的 chat run,共用 OpenClaw 的 attempt loop。**这是本文件分析的主要对象**。
2. **`runtime: "acp"`(外部)**:通过 ACP 协议把子任务委派给 claudecode/gemini/opencode/codex 等外部 CLI。本文档只在 12 决策对照中提到。

跨两个 runtime 的统一抽象:`subagent-registry.ts` 维护一份"子 run 表",通过 `subagent-announce.ts` 把子 run 完成结果反向注入父 session 的 transcript(internal event)。

---

## 信息来源

| 来源 | 路径 | 可信度 |
|------|------|--------|
| 工具定义(schema/参数) | `src/agents/tools/sessions-spawn-tool.ts` | ★★★★★(源码直读) |
| Spawn 直接入口 | `src/agents/subagent-spawn.ts` | ★★★★★(完整阅读) |
| Spawn 运行时桥接 | `src/agents/subagent-spawn.runtime.ts` | ★★★★★ |
| 子 agent system prompt | `src/agents/subagent-system-prompt.ts` | ★★★★★ |
| 第一轮 user message | `src/agents/subagent-initial-user-message.ts` | ★★★★★ |
| 工具子集 deny list | `src/agents/pi-tools.policy.ts` | ★★★★★ |
| 深度计算 | `src/agents/subagent-depth.ts` | ★★★★★ |
| Capabilities(role/scope) | `src/agents/subagent-capabilities.ts` | ★★★★★ |
| 默认深度/并发上限 | `src/config/agent-limits.ts` | ★★★★★ |
| Spawn registry(主表 + 状态) | `src/agents/subagent-registry.ts`、`subagent-registry.types.ts` | ★★★★★ |
| 完成 announce 流程 | `src/agents/subagent-announce.ts`(开头 600 行) | ★★★★★ |
| Announce 输出读取/超时 | `src/agents/subagent-announce-output.ts` | ★★★★★ |
| 控制层(kill/steer/cascade) | `src/agents/subagent-control.ts`、`subagent-control.runtime.ts` | ★★★★★ |
| Gateway agent 方法(运行子 run) | `src/gateway/server-methods/agent.ts:971-1221` | ★★★★★ |
| Chat abort 全局表(每 run AbortController) | `src/gateway/chat-abort.ts` | ★★★★★ |
| Session fork(transcript 物理分支) | `src/auto-reply/reply/session-fork.runtime.ts:48-92` | ★★★★★ |
| Orphan recovery(daemon 重启后子 run 残留处理) | `src/agents/subagent-orphan-recovery.ts` | ★★★★☆(读关键段落) |
| ACP 子 runtime(对照分支) | `src/agents/acp-spawn.ts:1-100` | ★★★☆☆(只读结构) |
| 已有调研:abort 全链路 | `research/source-analysis/openclaw/interruption-and-abort.md` | ★★★★★(被本文引用) |

---

## 一、Spawn 入口与启动链路

### 1.1 工具名:`sessions_spawn`(不是 `Task`)

工具注册在 `src/agents/tools/sessions-spawn-tool.ts:197-406`,核心字段:

| 参数 | 必选 | 说明 |
|---|---|---|
| `task` | 是 | 给子 agent 的任务文本(不会出现在子 user message 里,只放系统提示) |
| `agentId` | 否 | 跨 agent 委派(目标 agent 身份);留空 = 同 agent |
| `runtime` | 否 | `"subagent"`(默认)或 `"acp"` |
| `model` / `thinking` | 否 | 覆盖模型 / 思考级别 |
| `runTimeoutSeconds` | 否 | 子 run 超时 |
| `mode` | 否 | `"run"`(一次性,默认)或 `"session"`(持久会话,要求 `thread:true`) |
| `cleanup` | 否 | `"delete"` 完成后删 session,`"keep"` 保留(`session` 模式强制 keep) |
| `sandbox` | 否 | `"inherit"` 或 `"require"` |
| `context` | 否 | `"isolated"`(默认,空白 transcript)或 `"fork"`(物理 fork 父 transcript) |
| `lightContext` | 否 | 用 lightweight bootstrap context |
| `attachments` | 否 | 内联附件(byte 入参,会物化到子 workspace) |
| `attachAs.mountPath` | 否 | 附件挂载路径提示 |
| `expectsCompletionMessage` | 否 | 是否在完成时把结果通过 announce 投递给父 session(默认 true) |

显式被 reject 的参数(`UNSUPPORTED_SESSIONS_SPAWN_PARAM_KEYS`,`sessions-spawn-tool.ts:33-42`):`target/transport/channel/to/threadId/replyTo`——这些必须经 `message` 或 `sessions_send` 工具,不能在 spawn 时直传。

### 1.2 Spawn 启动 5 步(`subagent-spawn.ts:625-1252`)

```
[父 agent 调用 sessions_spawn 工具]
        │
        ▼
1. 生成 childSessionKey = "agent:<targetAgentId>:subagent:<uuid>"   (subagent-spawn.ts:763)
        │
        ▼
2. 检查准入:
   - depth < maxSpawnDepth(默认 1)            → 否则 "forbidden"
   - 当前 session 子 run 数 < maxChildrenPerAgent(默认 5)
   - sandbox 兼容性(沙箱 session 不能 spawn 非沙箱子)
   - targetPolicy 跨 agent 白名单
        │
        ▼
3. 准备子 session 元数据(写 sessions store 文件):
   - spawnDepth = parentDepth + 1
   - subagentRole = orchestrator | leaf
   - subagentControlScope = children | none
   - spawnedBy = parentSessionKey
   - 可选:运行时模型/provider override
   - 可选:context="fork" 时调 SessionManager.createBranchedSession 物理
     fork 父 JSONL → 新 sessionId / 新 sessionFile,header 含 parentSession 字段
        │
        ▼
4. 物化附件、构建 system prompt、构建第一轮 user message
        │
        ▼
5. callGateway({ method:"agent", params:{...} })  (subagent-spawn.ts:1057-1086)
   - sessionKey = childSessionKey
   - extraSystemPrompt = subagent system prompt
   - lane = AGENT_LANE_SUBAGENT(单独排队 lane)
   - deliver = false(默认,除非 thread 模式有 binding)
   - idempotencyKey = uuid
   - timeout = runTimeoutSeconds
        │
        ▼
   gateway 内部:registerChatAbortController(runId)
              + dispatchInboundMessage(...)         ← 普通 agent loop
              + 返回 runId
        │
        ▼
6. registerSubagentRun({ runId, childSessionKey, requesterSessionKey, ... })
   写入内存 Map subagentRuns(并 persist 到磁盘 ~/.openclaw/subagent-runs)
        │
        ▼
7. emitSessionLifecycleEvent + 可选触发 subagent_spawned hook
        │
        ▼
8. 工具立即返回 { status:"accepted", childSessionKey, runId, mode } —— 不等子完成
```

工具是**立即返回**的:返回时子 run 在 daemon 后台跑;父 agent 继续做自己的事(orchestrator 模式),通过后续的 announce 事件得知子完成。

### 1.3 关键事实:子 agent 与主 agent 共享 attempt loop

子 run 通过 `callGateway({ method:"agent" })` 启动(`subagent-spawn.ts:1057`),进入 `src/gateway/server-methods/agent.ts:971-1221`。这个 handler 与处理普通用户消息(`chat.send` 路径)使用同一套基础设施:

- `new AbortController()` 每 run 一个,记入 `chatAbortControllers` Map(`agent.ts:1330` / `chat-abort.ts:172`)
- `dispatchInboundMessage(...)` 调用同一个 `attempt.ts` 实现(`agent.ts:1083`,与 chat.send 在 `chat.ts:1741` 等同)
- 同样的 streamWithIdleTimeout、同样的 abort signal 透传、同样的工具循环

差异点(`attempt.ts` 内部以 `isSubagentSessionKey(sessionKey)` 分支):

| 行为 | 主 session | 子 session |
|---|---|---|
| Bootstrap 风格(`attempt.prompt-helpers.ts:210`) | `"full"` | `"minimal"` |
| Bootstrap 是否注入(`isPrimaryBootstrapRun`,attempt.ts:384) | 是 | 否 |
| `requireExplicitMessageTarget`(`attempt.ts:746`) | 否 | 是(必须显式指定 channel/to) |
| 工具子集(deny list,见 §3) | 全部 | 至少删 6 个(见下) |

---

## 二、System Prompt 与第一轮 User Message

### 2.1 子 agent system prompt(`subagent-system-prompt.ts`)

不是覆盖父 prompt,而是作为 `extraSystemPrompt` 拼到目标 agent 默认 system prompt 之后(`subagent-spawn.ts:927`):

主要内容(`subagent-system-prompt.ts:56-133`):

- `# Subagent Context` 标题块
- **Your Role**:把 task 嵌入(多行用 ``` fenced;单行内联)
- **Rules**:5 条(stay focused / complete the task / don't initiate / be ephemeral / trust push-based completion)
- **Output Format**:输出格式约定
- **What You DON'T Do**:no user conversations / no external messages / no cron
- **Sub-Agent Spawning** 段:
  - 当 `childDepth < maxSpawnDepth` 时,告诉子 agent 它**可以**继续 spawn 自己的子 agent(`canSpawn=true`)
  - 当 leaf 时,显式说"You are a leaf worker and CANNOT spawn further sub-agents"
- **Session Context**:label / requesterSessionKey / requesterChannel / 自己的 sessionKey

### 2.2 第一轮 user message(`subagent-initial-user-message.ts`)

故意**不**重复 task 内容(见文件头部注释引用 issue #72019:重复会让首次请求 input token 翻倍)。只发出极短的提示:

```
[Subagent Context] You are running as a subagent (depth N/M). Results auto-announce to your requester; do not busy-poll for status.

Begin. Your assigned task is in the system prompt under **Your Role**; execute it to completion.
```

`persistentSession=true`(session 模式)时多一行说明此 session 持久。

---

## 三、工具子集策略(子 agent 能用什么工具)

`pi-tools.policy.ts:31-79` 是核心。OpenClaw 的策略分两层:**总是 deny** 和 **leaf 才 deny**。

### 3.1 总是禁用(`SUBAGENT_TOOL_DENY_ALWAYS`)

```typescript
const SUBAGENT_TOOL_DENY_ALWAYS = [
  "gateway",        // System admin - dangerous from subagent
  "agents_list",
  "session_status",  // Status/scheduling - main agent coordinates
  "cron",
  "sessions_send",   // Direct session sends - subagents communicate through announce chain
];
```

`sessions_send` 被禁的语义关键:子 agent **不能**主动给父发消息;它只能"完成 task,把最终回复留在 transcript",由 announce 机制反向推送。

### 3.2 Leaf 额外禁用(`SUBAGENT_TOOL_DENY_LEAF`,深度 ≥ maxSpawnDepth)

```typescript
const SUBAGENT_TOOL_DENY_LEAF = [
  "subagents",        // 控制其他 subagent 的工具
  "sessions_list",
  "sessions_history",
  "sessions_spawn",   // 不能再 spawn
];
```

### 3.3 没有"破坏性工具默认禁用"

`bash` / `read` / `write` / `edit` 等工具**没有**被 subagent 显式禁用——子 agent 默认能跑 shell 和写文件。沙箱与 confirmation 机制是另外的层(沙箱 policy 见 `sandbox-tool-policy.ts`,exec approval 见 `bash-tools.exec-approval-request.ts`),与子 agent 身份无关——子 agent 调 bash 时和主 agent 调 bash 走同一条 approval 链。

### 3.4 用户配置覆盖

`cfg.tools.subagents.tools.allow / alsoAllow / deny` 可以覆盖默认 deny list(`pi-tools.policy.ts:81-129`)。`alsoAllow` 列入的工具会从默认 deny 中移除。

---

## 四、Spawn Registry 与生命周期

### 4.1 `subagentRuns: Map<runId, SubagentRunRecord>`(内存表)

定义在 `src/agents/subagent-registry-memory.ts`(只导出 Map),状态字段在 `subagent-registry.types.ts`:

```typescript
type SubagentRunRecord = {
  runId: string;                  // gateway 给的 runId
  childSessionKey: string;        // agent:<id>:subagent:<uuid>
  controllerSessionKey?: string;  // 谁有权 kill/steer 这个 run(默认 = requester)
  requesterSessionKey: string;    // 谁 spawn 的(父)
  requesterOrigin?: DeliveryContext;  // 父所在 channel/to/threadId,announce 投递目标
  task: string;
  cleanup: "delete" | "keep";
  spawnMode?: "run" | "session";
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  outcome?: { status: "ok"|"error"|"timeout"|"unknown"; error?: string; ... };
  expectsCompletionMessage?: boolean;
  announceRetryCount?: number;
  pauseReason?: "sessions_yield";
  // ...
};
```

### 4.2 持久化

`persistSubagentRunsToDisk(subagentRuns)`(`subagent-registry-state.ts`)落盘到 `~/.openclaw/...`。daemon 重启后 `restoreSubagentRunsFromDisk` + `subagent-orphan-recovery.ts:scheduleOrphanRecovery` 处理"重启时还在跑的子 run":

- `subagent-orphan-recovery.ts:290`:把因重启被 abort 的子 run 标记为 timeout outcome,触发 cleanup 流程

### 4.3 完成/超时检测

`subagent-registry.ts` 通过 `onAgentEvent` 监听 lifecycle 事件(`schedulePendingLifecycleError` / `schedulePendingLifecycleTimeout`,`subagent-registry.ts:397-467`):

- error 事件先延期 15 秒(`LIFECYCLE_ERROR_RETRY_GRACE_MS`),期间若收到 start/end 取消;超时仍在则触发 `completeSubagentRun({ outcome: { status:"error" } })`
- timeout 事件同样有 15 秒 grace
- session-mode 完成后保留 5 分钟(`SESSION_RUN_TTL_MS`)

### 4.4 完成后 announce 流程(`subagent-announce.ts:222-580`)

完成 → `runSubagentAnnounceFlow` 执行:

1. 等待子 sessionId 落盘(`waitForEmbeddedPiRunEnd`)
2. `waitForSubagentRunOutcome(runId, settleTimeoutMs)` 拿 outcome
3. 若有 pending 后代 run,**推迟 cleanup**(`pendingChildDescendantRuns > 0` → `return false; shouldDeleteChildSession = false`),即子 agent 完成但孙子还在跑时不立即处理
4. `readSubagentOutput / readLatestSubagentOutputWithRetry` 从子 transcript 读最后一条 assistant message
5. **wake-on-descendant-settle 路径**:若父 run 因等待子完成已经 yield 但子有结果,通过 `wakeSubagentRunAfterDescendants` 给父 run 发一个新的内部 wake message(本质是再调一次 `callGateway({ method:"agent" })`),把后代结果作为 internal event 注入
6. 构造 `internalEvents: [{ type:"task_completion", source:"subagent", taskLabel, statusLabel, result, replyInstruction, statsLine }]`
7. `deliverSubagentAnnouncement(...)`:
   - 如果父是 subagent(嵌套):`deliver=false`,作为 internal injection,父转一份 user-facing 文本给它的父
   - 如果父是顶层 main:`expectsCompletionMessage=true` 时直接通过父的 channel 投递给用户

`replyInstruction`(`subagent-announce.ts:78-90`)会指示父 agent:
- 父是 subagent 时:"Convert this completion into a concise internal orchestration update for your parent agent. Reply ONLY: <SILENT_TOKEN> if duplicate."
- 父是 main + expects completion:"A completed subagent task is ready for user delivery. Convert the result above into your normal assistant voice and send that user-facing update now."

### 4.5 cleanup 决策(`subagent-registry-cleanup.ts:33-71`)

完成后是 retry / give-up / defer-descendants:

- 有 active 后代 + completion-message-flow → `defer-descendants`(等到后代结算)
- announce retryCount ≥ MAX_ANNOUNCE_RETRY_COUNT 或超过 expiry → `give-up`
- 否则 retry,延迟由 `resolveAnnounceRetryDelayMs(retryCount)` 决定

---

## 五、控制层(kill / steer / cascade)

`subagent-control.ts` 暴露给主 agent 的 `subagents` 工具使用,提供 list/kill/steer 操作。

### 5.1 ResolvedSubagentController(`subagent-control.ts:115-143`)

调用方(可能是 main agent,也可能是 orchestrator subagent)被解析为 controller:

```typescript
type ResolvedSubagentController = {
  controllerSessionKey: string;       // 自己的 sessionKey
  callerIsSubagent: boolean;
  controlScope: "children" | "none";   // leaf 是 "none"
};
```

`controlScope === "none"` 时所有 kill/steer 都返回 `forbidden`。

### 5.2 `killSubagentRun`(`subagent-control.ts:172-219`)

```typescript
const sessionId = resolved.entry?.sessionId;
const aborted = sessionId ? runtime.abortEmbeddedPiRun(sessionId) : false;
const cleared = runtime.clearSessionQueues([childSessionKey, sessionId]);
//  ... 把 store 里 abortedLastRun=true ...
markSubagentRunTerminated({ runId, childSessionKey, reason: "killed" });
```

`abortEmbeddedPiRun` 是 `pi-embedded-runner/runs.js` 导出——直接 abort 那个子 sessionId 对应的 run AbortController。等价于一个内部 RPC 触发的 chat.abort。

### 5.3 `cascadeKillChildren`(`subagent-control.ts:221-283`)

DFS 遍历当前 session 所有 active 子 run,逐个 `killSubagentRun`,然后递归到孙子 run。**这是显式级联**——abort 一个 sessionKey 的 chat run 不会自动级联到孙子,必须通过 cascadeKillChildren 显式实现(因为孙子是另一个 sessionKey 的 chat run,在另一个 chatAbortController 下)。

### 5.4 `steerControlledSubagentRun`(`subagent-control.ts:443-`)

让 controller 给已运行的子 run 发"修正消息"的能力:abort 当前 attempt,清队列,然后再起一个新 run (`replaceSubagentRunAfterSteer` 把 runId 切换到新 runId,保留 frozenResult)。受 `STEER_RATE_LIMIT_MS = 2000ms` 限流。

### 5.5 ownership 校验(`subagent-control.ts:161-170`)

```typescript
function ensureControllerOwnsRun({ controller, entry }) {
  const owner = entry.controllerSessionKey?.trim() || entry.requesterSessionKey;
  if (owner === controller.controllerSessionKey) return undefined;
  return "Subagents can only control runs spawned from their own session.";
}
```

子 agent A 不能 kill 子 agent B(除非 admin scope)——只能控制自己 spawn 的子。

### 5.6 admin 级 kill(`subagent-control.ts:409-441`)

`killSubagentRunAdmin`:不校验 ownership,直接由 `gateway` 工具 + ADMIN_SCOPE 触发。这是给系统级清理用的。

---

## 六、Spawn 模式与上下文模式

### 6.1 spawnMode = "run" vs "session"(`subagent-spawn.types.ts`)

- **`run`**(默认):一次性子 task。完成后由 cleanup 决定 keep/delete(默认 keep)。typical 是 orchestration 拆 task。
- **`session`**:持久子 session,要求 `thread:true` 且通道支持 thread binding(Discord/Slack/Telegram thread)。强制 `cleanup="keep"`。完成后保留 thread,以便后续追问。

### 6.2 contextMode = "isolated" vs "fork"(`subagent-spawn.types.ts`)

- **`isolated`**(默认):子 sessionFile 全新空白,只有 system prompt + initial user message。
- **`fork`**:调 `forkSessionFromParent`(`session-fork.runtime.ts:48-92`),`SessionManager.open(parentSessionFile).createBranchedSession(leafId)` 物理创建一个分叉 JSONL,header 含 `parentSession` 字段指回父文件。子 agent 启动时它的 SessionManager 已有完整父历史。要求:同 agent;父 totalTokens ≤ `forkMaxTokens`(可配置);否则 fork 失败,需要先 compact 或换 isolated。

### 6.3 lightContext

`params.lightContext === true` 时设 `bootstrapContextMode: "lightweight"` + `bootstrapContextRunKind: "default"`,attempt.ts 的 bootstrap context 注入会走 minimal 路径(只放最少的 AGENTS.md / 项目摘要)。

---

## 七、Token / 资源 / 成本归属

### 7.1 子 transcript 独立、token usage 各自记账

- isolated 模式:子 sessionFile 是新文件,LLM usage 写到子的 JSONL 里;父 transcript 完全不受影响
- fork 模式:子 sessionFile 是父文件分叉出来的新文件(物理两份);父继续往父文件追加,子在自己的分叉文件追加。**fork 之后的 token 各自记**

OpenClaw **没有"父子合并 token usage"**的概念。子 agent 跑了多少 token,只在子 sessionFile 的 usage 字段里。

### 7.2 模型 / thinking 独立

`resolveSubagentModelAndThinkingPlan`(`subagent-spawn-plan.ts`)允许 `params.model` / `params.thinking` 完全覆盖目标 agent 默认值,生成独立的 modelOverride 持久化到子 session entry。子 agent 用什么模型与父无关。

### 7.3 timeout 独立

`runTimeoutSeconds` 是子 run 自己的 wall-clock timeout;`resolveSubagentAgentGatewayTimeoutMs(runTimeoutSeconds)`(`subagent-spawn.ts:205-217`)把子 gateway RPC 的 timeoutMs 设成 `max(60s, min(300s, runTimeoutSeconds*1000+5s))`——给子 run 一定缓冲。

### 7.4 并发上限(`config/agent-limits.ts`)

```typescript
DEFAULT_AGENT_MAX_CONCURRENT = 4              // 全 agent 并发主 run 上限
DEFAULT_SUBAGENT_MAX_CONCURRENT = 8           // 全 agent 并发 subagent run 上限
DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT = 5   // 单父 session 最多 5 个 active 子
DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 1          // 默认深度 1(子不能再 spawn)
```

`countActiveRunsForSession(requesterInternalKey)` 实时检查当前 session 已有多少 active 子,达到上限直接 forbidden。

---

## 八、流式可见性与 transcript

### 8.1 子 stream 是否可见取决于 `deliver` 字段

`subagent-spawn.ts:1046-1051`:

```typescript
const deliverInitialChildRunDirectly =
  requestThreadBinding && spawnMode === "session" && hasBoundThreadDeliveryOrigin;
const shouldAnnounceCompletion = deliverInitialChildRunDirectly
  ? false
  : expectsCompletionMessage;
```

- **session 模式 + thread binding 可用**:`deliver=true`,子 run 输出**实时流到自己的 thread**(用户在该 thread 直接看到子 agent 说话);**不再 announce 给父**
- **run 模式 / 无 thread binding**:`deliver=false`,子 run 输出在子 sessionFile 累积**,父和用户都看不到中间步骤**;最终通过 announce 把"汇总后"投递到父 session

### 8.2 主 transcript 是否含子步骤?

主 transcript(父 sessionFile)只含:
- 父调用 `sessions_spawn` 工具的 `toolUse` + `toolResult`(`{ status:"accepted", childSessionKey, runId, ... }`)
- 子完成后 announce 投递的 internal event(注入为 user message,带 task_completion 标签)和父对它的回复

**子的工具调用、子的 LLM 步骤、子的中间 reasoning 全部不进父 transcript**。

### 8.3 transcript 持久化的两份独立 JSONL

子 sessionFile 路径在 `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`,与父并列。`cleanup="delete"` 时调 `sessions.delete + deleteTranscript:true` 物理删除子 JSONL;`cleanup="keep"` 时保留。

---

## 九、错误传播与 abort 双向

### 9.1 子失败 → 父收到的内容

子 run outcome 的 status 决定 announce 文本(`subagent-announce.ts:454-462`):

```typescript
const statusLabel =
  outcome.status === "ok"
    ? "completed successfully"
    : outcome.status === "timeout"
      ? "timed out"
      : outcome.status === "error"
        ? `failed: ${outcome.error || "unknown error"}`
        : "finished with unknown status";
```

`internalEvents[0].statusLabel + result + statsLine` 被注入父 transcript。父 agent 看到一个 user-message 风格的 system event,自己决定是否把"失败"翻译成 user-facing 输出。**子失败不抛错给父——是把失败"包装成数据"通过 announce 送达。**

### 9.2 父 abort → 子怎么停?

父 run 被 abort,父 session 的 chat run 终止,但**子 run 在 daemon 内是独立 chat run,默认不会自动停**。OpenClaw 的解决方案:

1. **手动级联**:父 agent 在被 abort 前可以(或者通过 `subagents kill all` 工具)显式 cascade kill 自己的子(`cascadeKillChildren`)
2. **completionMessageFlow defer**:子完成时若父已 cleanup,announce 流程会 retry / give-up,不会强行投递
3. **session/thread 路径**:thread 还在的情况下,投递走 thread,不依赖父 session 是否还活着
4. **没有自动级联 abort**:父 chat run 的 AbortController 不订阅子 run 的 AbortController

### 9.3 子 fail → 反向 abort 父?

**不会**。子的 outcome.status === "error" 只会让 announce 投递一段"failed: <error>"文本,父 agent 自己决定怎么处理。

### 9.4 daemon 重启时的孤儿恢复

`subagent-orphan-recovery.ts`:

- daemon 启动时 restore `subagentRuns` 表,扫描 `endedAt` 未设的 entry
- 配合 session entry 的 `status` 字段判断真实状态:`done` / `failed` / `timeout` / `running` / `killed`
- "running 但实际无 active context" + 超过 `STALE_ACTIVE_SUBAGENT_GRACE_MS = 60_000ms` → 标记为 timeout,触发 announce 投递剩余结果

---

## 十、双 runtime:subagent vs ACP

`sessions_spawn.runtime` 参数支持 `"subagent"` 和 `"acp"`。

| 维度 | runtime=subagent | runtime=acp |
|---|---|---|
| 在哪里跑 | OpenClaw daemon 自己 | 外部 CLI 进程(claudecode/gemini/opencode/codex) |
| 注册位置 | `subagent-spawn.ts:spawnSubagentDirect` | `acp-spawn.ts:spawnAcpDirect` |
| sessionKey | `agent:<id>:subagent:<uuid>` | `agent:<id>:acp:<uuid>` |
| 通讯协议 | gateway 内部 `method:"agent"` | ACP(Anthropic 推的标准协议) |
| 工具集 | OpenClaw 工具库(可裁剪) | 由外部 CLI 决定 |
| context fork | 支持 | 不支持(`acp-spawn-tool.ts:243`) |
| attachments | 支持 | 不支持(`acp-spawn-tool.ts:269`) |
| stream-to-parent | 不支持(用 announce) | 支持 `streamTo:"parent"` |
| 完成回调 | announce | announce(共用 registry / announce 流程) |

ACP runtime 是外部 CLI(可能是另一个 Claude 或 Gemini 实例)作为 subagent,OpenClaw 只起 orchestrator 角色。registry 与 announce 流程**两个 runtime 共用**。

---

## 十一、12 决策对照(逐条事实)

### 1. State 边界:子 agent 与父共享什么 / 独立什么?

**事实**:
- **共享**:gateway 进程、`chatAbortControllers` Map 注册位、`subagentRuns` 全局 Map、`sessions store` JSON(同一份共享存储,父子各占自己 key)、磁盘 `~/.openclaw` 目录、global config、context engine、approval system、auth profile pool
- **独立**:sessionKey、sessionId、sessionFile(JSONL transcript)、AbortController(每个 chat run 一个独立)、model/thinking override、workspace 可独立(`spawnedWorkspaceDir`)、attachments 物化目录、子 spawnDepth/role/controlScope 元数据
- fork 模式下,子的 sessionFile 是父 JSONL 的物理分叉(SessionManager.createBranchedSession),**有共同前缀但分叉之后独立扩展**;header 字段 `parentSession` 记录链接关系(`session-fork.runtime.ts:81`)

### 2. ConfirmationBroker(权限):子 agent 调用工具时,permission 走父的 broker 还是独立的?

**事实**:走全局 broker,不分父子。`bash-tools.exec-approval-request.ts:89-108`:`registerExecApprovalRequest` 统一通过 `callGatewayTool("exec.approval.request", ...)` 注册到 gateway 进程级的 approval registry。这个 registry 不按 sessionKey 分桶(从代码路径看,decision 仅按 approvalId 检索,见 `waitForExecApprovalDecision`)。**子 agent 触发 bash exec 时,approval prompt 出现在与父 agent 同样的位置(用户的 TUI / IM 通道),由用户人工 decide,decide 后子 agent 拿到 decision 继续**。`shouldSuppressExecDeniedFollowup(sessionKey)` 在 `bash-tools.exec-approval-followup.ts:77-79` 对 subagent session **抑制 followup user message**(子被 deny 后不再发 user-facing followup),只在子 transcript 留 result。

### 3. 工具子集契约:子 agent 默认能用哪些工具?Bash/Edit/Write 这种破坏性工具是否禁用?

**事实**:见 §3。默认 deny:`gateway`、`agents_list`、`session_status`、`cron`、`sessions_send`(总是);leaf 子 agent 额外 deny:`subagents`、`sessions_list`、`sessions_history`、`sessions_spawn`。**`bash` / `read` / `write` / `edit` 等破坏性工具默认未禁用,与主 agent 一样可用**——破坏性是通过沙箱 + approval 链(全局 broker)管理,不是通过子 agent 身份禁用。用户可在 `cfg.tools.subagents.tools.deny/allow/alsoAllow` 中覆盖默认 deny。

### 4. 资源预算:max-turns / timeout / token budget 是父子共享还是独立配额?

**事实**:
- **`runTimeoutSeconds`(wall-clock):独立**。父调 spawn 时给的值,只用于子 run。父自己的 timeout 不受影响。
- **token budget:独立**。子 transcript 单独 JSONL,context overflow / compaction 各自判定。
- **max-turns:不存在**。OpenClaw 没有显式 turn 上限;只有 LLM idle timeout 60s + run wall-clock timeout(见 `interruption-and-abort.md`)。
- **并发上限:每 session 5 个 active 子(`maxChildrenPerAgent`)、daemon 全局 8 个 subagent run(`maxConcurrent`)、深度上限(`maxSpawnDepth=1`)**。这三个上限在 spawn 时校验,违反 → forbidden。
- **fork 模式下,父 transcript 的 totalTokens 必须 ≤ `forkMaxTokens`** 才允许 fork(`subagent-spawn.ts:354-362`),否则要求父先 compact。这是唯一的"父子之间的资源约束"。

### 5. Orchestrator 模块归属:子 agent 实现代码在哪个层?

**事实**:在 `src/agents/`(与主 agent 同层,不是单独的 `subagents/` 子目录),~30 个 `subagent-*.ts` 文件。spawn 工具入口 `src/agents/tools/sessions-spawn-tool.ts`。**没有"子 agent runtime"独立模块——它就是主 agent runtime 的一组扩展函数 + 一组 RPC 拼接**。Gateway server method 也是同一个 `agent.ts`(`server-methods/agent.ts`),不区分父子调用。

### 6. 流式可见性:子 agent 输出是否冒泡到主?用户是否能看到中间步骤?

**事实**:取决于 deliver 字段(§8.1)。
- **`run` 模式 / 无 thread binding**:`deliver=false`,子的中间 stream 用户和主 agent 都**看不到**;只在子完成时通过 announce 把"最后 assistant message"作为 internal event 注入主 transcript。**这是 Claude Code 风格行为**(主 agent 看到压缩结果,看不到子的工具调用)。
- **`session` 模式 + thread**:`deliver=true`,子 stream 实时流到自己绑定的 thread;此时**不再 announce**给主(`shouldAnnounceCompletion=false`)。
- 主 transcript 中只看到 `sessions_spawn` 工具的 `accepted` 返回 + 之后 announce 的 internal event,看不到子的 toolCalls/reasoning。

### 7. 错误传播语义:子 agent 失败 → 主 agent 收到什么?

**事实**:子失败被包装成 `internalEvent.task_completion` 的一段文本注入主(`statusLabel: "failed: <error>"` + `result: <whatever transcript captured>` + `statsLine`),**不抛错、不中断主**。主 agent 自己决定怎么读、怎么向用户呈现。如果子在 announce 投递阶段都失败(网络错误/重试达上限),`subagent-registry-cleanup.ts` 的 `give-up` 路径让该 run 直接 expire,主**永远不会知道**——这是显式的 best-effort 设计。

### 8. 递归限制:子 agent 能否再起子 agent?

**事实**:**默认不能**。`DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 1`(`config/agent-limits.ts:7`,注释 "Keep depth-1 subagents as leaves unless config explicitly opts into nesting")。配置 `cfg.agents.defaults.subagents.maxSpawnDepth = 2` 才允许嵌套。深度计算在 `subagent-depth.ts:117`:`spawnDepth` 字段从 session store 读取,配合 `spawnedBy` 链回溯。`resolveSubagentCapabilities` 把深度映射到 role(`main` / `orchestrator` / `leaf`),leaf 角色被 deny 工具集排除 `sessions_spawn`(§3.2)+ system prompt 显式告知"You are a leaf worker and CANNOT spawn further sub-agents"(`subagent-system-prompt.ts:113-117`)。

### 9. 审计与 transcript:子 agent transcript 是否持久化?主 transcript 是否含子步骤?

**事实**:
- **子 transcript**:持久化为独立 JSONL 文件(`~/.openclaw/agents/<id>/sessions/<sessionId>.jsonl`),`cleanup="delete"` 时完成后被物理删除(连带 session entry),`cleanup="keep"`(默认/session 模式)时保留
- **fork 模式**:子 JSONL 是父 JSONL 的分叉,header 字段 `parentSession` 链接;两份物理独立
- **主 transcript**:只含 `sessions_spawn` 工具的 toolUse/toolResult + announce 的 internal event 注入。**不含子的 toolCalls、不含子的 reasoning**。
- **registry 持久化**:`subagentRuns` Map 落盘(`persistSubagentRunsToDisk`),daemon 重启可恢复 + orphan recovery 流程

### 10. abort 双向传播:父 abort → 子怎么停?子 fail → 是否反向 abort 主?

**事实**:
- **父 abort → 子**:**不自动级联**。父 chat run 的 AbortController 与子 chat run 的 AbortController 是独立两个,父 abort 不订阅子。需要主 agent 显式调 `subagents` 工具的 kill 操作(背后是 `cascadeKillChildren`,`subagent-control.ts:221-283`)才会级联到子和孙子。
- **子 fail → 主**:**不反向 abort**。子失败包装成 announce 内的 internal event,主继续运行(§7)。
- **手动级联机制**:`cascadeKillChildren` DFS 遍历当前 session 所有 active 子 run,逐个调 `abortEmbeddedPiRun(sessionId)` + `clearSessionQueues` + `markSubagentRunTerminated`。
- **daemon 重启**:重启会 abort 所有 in-flight 子 run(进程级丢失 AbortController 状态),`subagent-orphan-recovery.ts` 把状态修复成 timeout/killed 并触发 cleanup announce。

### 11. token / 成本归属:子 agent 消耗的 token 算在哪里?

**事实**:子 LLM 调用的 usage 落在子 sessionFile 的 usage 字段(JSONL 每条 message 后面带 usage 元数据)。**主和子 sessionFile 物理独立**,token 各自记账。OpenClaw 没有"父子合并 usage"的统计点。fork 模式下,fork 之前的 token 在父原始 JSONL 里(子 JSONL 也有副本因为是物理 branch),fork 之后的 token 父在父文件、子在子文件,**不会重复计数**(假设统计基于 sessionFile 而不是 sessionId 链)。

### 12. CLI / Gateway / Channel 三方 UX:openclaw 在 TUI / RPC / 其他通道下子 agent 怎么呈现?

**事实**:
- **TUI**:子 agent stream 默认看不到(`run` 模式 deliver=false);用户只在最后看到主 agent 复述子结果。`session` 模式 + thread 在 TUI 没有意义(TUI 不是 thread channel),所以基本永远走 announce 路径。`session_status` 工具被 deny 给子,不会在 TUI 显示子状态;主可调 `subagents list` 工具看子状态。
- **Gateway/RPC**:子 run 完全可见(独立 runId 注册到 `chatAbortControllers`,可独立 abort、可独立查 `agent.wait`)。webchat / 其他 RPC client 可订阅子 run 的 SSE 事件,理论上能看到子的所有 stream。
- **IM/Discord/Slack 等 thread-capable channel**:`mode=session, thread=true` 时,子 agent 绑定到一个独立 thread,用户在该 thread 直接和子 agent 对话(`deliver=true`,stream 实时);完成后 thread 保留(`cleanup=keep` 强制),用户后续可继续在子 thread 追问(走该 thread 的 inbound 路径,被识别为 subagent session 的新 message)。
- **没有"子 agent 在主 chat 里产生分支视图"** 这种 UI——在主 thread/会话里只能看见 announce 文本,中间步骤要去子 sessionFile / 子 thread / `subagents` 工具列表里查。

---

## 十二、关键代码片段

### 12.1 工具定义(`tools/sessions-spawn-tool.ts:197-205`)

```typescript
return {
  label: "Sessions",
  name: "sessions_spawn",
  displaySummary: acpAvailable
    ? SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY
    : SESSIONS_SPAWN_SUBAGENT_TOOL_DISPLAY_SUMMARY,
  description: describeSessionsSpawnTool({ acpAvailable }),
  parameters: createSessionsSpawnToolSchema({ acpAvailable }),
  execute: async (_toolCallId, args) => { /* ... 367-403 ... */ },
};
```

### 12.2 子 sessionKey 命名 + 深度校验(`subagent-spawn.ts:695-713, 763`)

```typescript
const callerDepth = getSubagentDepthFromSessionStore(requesterInternalKey, { cfg });
const maxSpawnDepth =
  cfg.agents?.defaults?.subagents?.maxSpawnDepth ?? DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
if (callerDepth >= maxSpawnDepth) {
  return {
    status: "forbidden",
    error: `sessions_spawn is not allowed at this depth (current depth: ${callerDepth}, max: ${maxSpawnDepth})`,
  };
}

const maxChildren =
  cfg.agents?.defaults?.subagents?.maxChildrenPerAgent ?? DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT;
const activeChildren = countActiveRunsForSession(requesterInternalKey);
if (activeChildren >= maxChildren) {
  return {
    status: "forbidden",
    error: `sessions_spawn has reached max active children for this session (${activeChildren}/${maxChildren})`,
  };
}
// ...
const childSessionKey = `agent:${targetAgentId}:subagent:${crypto.randomUUID()}`;
```

### 12.3 启动子 run 用 gateway agent method(`subagent-spawn.ts:1057-1086`)

```typescript
const response = await callSubagentGateway({
  method: "agent",
  params: {
    message: childTaskMessage,
    sessionKey: childSessionKey,
    channel: childSessionOrigin?.channel,
    to: childSessionOrigin?.to ?? undefined,
    accountId: childSessionOrigin?.accountId ?? undefined,
    threadId:
      childSessionOrigin?.threadId != null
        ? stringifyRouteThreadId(childSessionOrigin.threadId)
        : undefined,
    idempotencyKey: childIdem,
    deliver: deliverInitialChildRunDirectly,
    lane: AGENT_LANE_SUBAGENT,
    cleanupBundleMcpOnRunEnd: spawnMode !== "session",
    extraSystemPrompt: childSystemPrompt,
    thinking: thinkingOverride,
    timeout: runTimeoutSeconds,
    label: label || undefined,
    // ...
  },
  timeoutMs: resolveSubagentAgentGatewayTimeoutMs(runTimeoutSeconds),
});
```

### 12.4 工具子集 deny list(`pi-tools.policy.ts:31-72`)

```typescript
const SUBAGENT_TOOL_DENY_ALWAYS = [
  // System admin - dangerous from subagent
  "gateway",
  "agents_list",
  // Status/scheduling - main agent coordinates
  "session_status",
  "cron",
  // Direct session sends - subagents communicate through announce chain
  "sessions_send",
];

const SUBAGENT_TOOL_DENY_LEAF = [
  "subagents",
  "sessions_list",
  "sessions_history",
  "sessions_spawn",
];

function resolveSubagentDenyList(depth: number, maxSpawnDepth: number): string[] {
  const isLeaf = depth >= Math.max(1, Math.floor(maxSpawnDepth));
  if (isLeaf) {
    return [...SUBAGENT_TOOL_DENY_ALWAYS, ...SUBAGENT_TOOL_DENY_LEAF];
  }
  return [...SUBAGENT_TOOL_DENY_ALWAYS];
}
```

### 12.5 系统提示中的 leaf vs orchestrator 分支(`subagent-system-prompt.ts:85-117`)

```typescript
if (canSpawn) {
  lines.push(
    "## Sub-Agent Spawning",
    "You CAN spawn your own sub-agents for parallel or complex work using `sessions_spawn`.",
    "Use the `subagents` tool to steer, kill, or do an on-demand status check for your spawned sub-agents.",
    "Your sub-agents will announce their results back to you automatically (not to the main agent).",
    // ...
  );
} else if (childDepth >= 2) {
  lines.push(
    "## Sub-Agent Spawning",
    "You are a leaf worker and CANNOT spawn further sub-agents. Focus on your assigned task.",
    "",
  );
}
```

### 12.6 fork 物理分支 transcript(`session-fork.runtime.ts:48-92`)

```typescript
export function forkSessionFromParentRuntime(params: {
  parentEntry: SessionEntry;
  agentId: string;
  sessionsDir: string;
}): { sessionId: string; sessionFile: string } | null {
  const parentSessionFile = resolveSessionFilePath(/*...*/);
  if (!parentSessionFile || !fs.existsSync(parentSessionFile)) {
    return null;
  }
  const manager = SessionManager.open(parentSessionFile);
  const leafId = manager.getLeafId();
  if (leafId) {
    const sessionFile = manager.createBranchedSession(leafId) ?? manager.getSessionFile();
    const sessionId = manager.getSessionId();
    if (sessionFile && sessionId) {
      return { sessionId, sessionFile };
    }
  }
  // fallback: 写一个新 JSONL header 含 parentSession 字段
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp,
    cwd: manager.getCwd(),
    parentSession: parentSessionFile,
  };
  fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, /*...*/);
  return { sessionId, sessionFile };
}
```

### 12.7 完成 announce 注入 internal event(`subagent-announce.ts:507-522`)

```typescript
const internalEvents: AgentInternalEvent[] = [
  {
    type: "task_completion",
    source: announceType === "cron job" ? "cron" : "subagent",
    childSessionKey: params.childSessionKey,
    childSessionId: announceSessionId,
    announceType,
    taskLabel,
    status: outcome.status,
    statusLabel,
    result: findings,
    statsLine,
    replyInstruction,
  },
];
const triggerMessage = buildAnnounceSteerMessage(internalEvents);
```

### 12.8 cascade kill 子和孙子(`subagent-control.ts:221-283`,节选)

```typescript
async function cascadeKillChildren(params: {
  cfg: OpenClawConfig;
  parentChildSessionKey: string;
  cache: Map<string, Record<string, SessionEntry>>;
  seenChildSessionKeys?: Set<string>;
}): Promise<{ killed: number; labels: string[] }> {
  // ... 遍历 listSubagentRunsForController(params.parentChildSessionKey) ...
  for (const run of childRuns) {
    if (!run.endedAt) {
      const stopResult = await killSubagentRun({/*...*/});
      // ...
    }
    const cascade = await cascadeKillChildren({  // 递归
      cfg: params.cfg,
      parentChildSessionKey: childKey,
      cache: params.cache,
      seenChildSessionKeys,
    });
    killed += cascade.killed;
    labels.push(...cascade.labels);
  }
  return { killed, labels };
}
```

### 12.9 默认上限常量(`config/agent-limits.ts:1-7`)

```typescript
export const DEFAULT_AGENT_MAX_CONCURRENT = 4;
export const DEFAULT_SUBAGENT_MAX_CONCURRENT = 8;
export const DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT = 5;
// Keep depth-1 subagents as leaves unless config explicitly opts into nesting.
export const DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 1;
```

### 12.10 subagent session 在 attempt 中的特殊化(`pi-embedded-runner/run/attempt.prompt-helpers.ts:210`)

```typescript
return isSubagentSessionKey(sessionKey) || isCronSessionKey(sessionKey) ? "minimal" : "full";
```

---

## 十三、未确定 / 存疑点

1. **Approval system 的 sessionKey 隔离**:`exec.approval.request` registry 看上去是 gateway 进程级、按 approvalId 查询的;但子 agent 的 approval prompt 投递目标(到哪个 channel/thread)需要进一步追代码到 `gateway/server-methods/exec-approvals.ts` 才能确认是否会被正确地 routed 到主 thread 或子 thread。本文未深入读这部分。

2. **`hasGatewayClientCap` / `senderIsOwner` 在子 run 上的语义**:子 run 经 `callSubagentGateway` 触发,`scopes` 默认是 write 而非 admin(`subagent-spawn.ts:177-195`),原因注释说为了避免被识别为 owner 而暴露 owner-only 工具。但实际 `senderIsOwner` 在 attempt 内的所有分支(如某些工具是否解锁、provider override 是否允许)需要进一步确认。

3. **fork 模式下子 transcript 的 token 计数**:`createBranchedSession` 在 SessionManager(pi-coding-agent npm 包)内实现,branch 之后子 sessionFile 是否物理 copy 全部历史 message,还是只写一个分叉 header 然后引用父?如果是引用,父被 compact 时会不会影响子读历史?本文未读 SessionManager 源码。

4. **`internalEvents` 注入主 transcript 的具体格式**:`task_completion` event 在主 sessionFile 里以什么 message 形态出现(role=user 还是 system),需要看 `formatAgentInternalEventsForPrompt` 的实现细节(`internal-events.ts`)。本文未深入。

5. **session-mode + thread + non-thread channel 的 fallback 行为**:thread binding hook 失败时返回 `error: buildThreadBindingUnavailableError`,但已经 spawn 一半的子 session 是否会立即 cleanup(代码看上去是 yes,通过 `callSubagentGateway({ method:"sessions.delete" })`),竞态情况未细读。

6. **announce 的"silent token"语义**:`SILENT_REPLY_TOKEN` / `NO_REPLY` 出现在 announce reply instruction 中,`stripAndClassifyReply` 决定是否跳过投递。这个设计跟 thread binding / message-tool 的交互需要更深入读 `tokens.ts`。

7. **`subagentRuns` Map 的并发安全**:多 chat run 并发完成时同时修改 `subagentRuns` Map 的边界条件。`pendingLifecycleErrorByRunId` 用 grace timer 解决了 lifecycle 事件的乱序;但 `complete` / `kill` / `restore` 三路并发的锁定语义本文未彻查。

8. **`cleanup="delete"` 与 announce 投递的竞态**:announce 流程会延迟 cleanup 直到 announce 投递完成或 give-up;但 `defer-descendants` 的 timeout 边界、`announceCompletionHardExpiryMs` 的具体值未读出来。

9. **acp runtime 的 cancel/abort 怎么和 OpenClaw subagent registry 联动**:本文只对照式提到 ACP,未读 ACP 子完整路径。`acp-spawn.ts` 全文 1000+ 行,本次只读前 100 行。
