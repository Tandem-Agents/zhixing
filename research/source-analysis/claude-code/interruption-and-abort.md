# Claude Code — 中断与 Abort 传播机制分析

> **分析状态**: ✅ 已分析（2026-04-26）
>
> **分析范围**: 按键事件（Esc / Ctrl+C）→ Ink TUI → AbortController → SSE 关闭 → tool abort 全链路；LLM stream idle-timeout watchdog；多源 abort 汇聚；submit-during-running 的 'interrupt' 语义层叠

## 模块定位

Claude Code 的中断系统是一个由 **AbortController + reason 字符串协议**串起来的多层结构。最外层是 Ink 键盘事件→keybinding 路由→单点 `onCancel()` 回调；中间是 query.ts 持有的"当前轮次 AbortController"；最内层是工具与 SSE 流通过 `signal.aborted` 与 `signal.reason` 实时检查决定该 kill 还是 background。整个系统并行还跑一个独立的 stream idle-timeout watchdog（`setTimeout` 90s 默认），用来兜底没人按 Esc 但 SSE 沉默挂死的情况。

## 信息来源

| 来源 | 路径 | 可信度 |
|---|---|---|
| Claude Code analysis（自有总结） | `zhixing/research/source-analysis/claude-code/{agent-loop,resilience,api-layer}.md` | ★★★★ (二手分析，部分过时) |
| Claude Code deobfuscation（v2.1.88 cleanroom 源码） | `_refs/claude-code-analysis/src/...`（512K 行 TS） | ★★★★★ (源码层，本文主要依据) |
| Claude Code deobfuscation specs | `_refs/claude-code-deobfuscation/specs/...` | ★★★ (社区精简版规格) |
| Claude Code reverse | `_refs/claude-code-reverse/...` | ★★★★★ (实抓 prompt) — 本主题不涉及 |

> 注：`_refs/claude-code-analysis/` 的 `src/` 是 v2.1.88 泄露源码全量；`_refs/claude-code-deobfuscation/claude-code/src/` 是另一个更小的 cleanroom 重写，本文以前者为准。
>
> 已有的 `resilience.md §8.3` 写"目前没有流看门狗机制"——此结论**已过时**，本文以最新源码（`services/api/claude.ts:1868-1928`）为准：watchdog 存在，由 `CLAUDE_ENABLE_STREAM_WATCHDOG` 启用，默认 90s。

---

## 一、用户中断（按键 → AbortController）链路

### 1.1 总览

```
键盘字节流 (raw mode)
    ↓
src/ink/parse-keypress.ts      ── 解析 ESC 序列、Kitty/CSI-u/modifyOtherKeys 多协议
    ↓
src/ink/hooks/use-input.ts     ── EventEmitter 'input' 事件
    ↓
src/keybindings/useKeybinding.ts ── action 解析（'chat:cancel' / 'app:interrupt'）
    ↓
src/hooks/useCancelRequest.ts  ── CancelRequestHandler 优先级判定
    ↓
REPL.tsx onCancel()            ── abortController.abort('user-cancel')
    ↓
分叉:
  ├─ SSE 流：anthropic SDK 捕获 signal.aborted → 抛 APIUserAbortError
  ├─ tool 内部：每个 tool 的 abort handler 调 child.kill() / response.cancel()
  └─ query.ts 主循环：检查 signal.aborted → return { reason: 'aborted_streaming'/'aborted_tools' }
```

### 1.2 键盘字节 → key event

`useInput` 是 Ink 的输入入口（`src/ink/hooks/use-input.ts:42-90`）：

```typescript
const useInput = (inputHandler: Handler, options: Options = {}) => {
  const { setRawMode, internal_exitOnCtrlC, internal_eventEmitter } = useStdin()

  // useLayoutEffect (not useEffect) so that raw mode is enabled synchronously
  // during React's commit phase, before render() returns.
  useLayoutEffect(() => {
    if (options.isActive === false) return
    setRawMode(true)
    return () => { setRawMode(false) }
  }, [options.isActive, setRawMode])

  const handleData = useEventCallback((event: InputEvent) => {
    if (options.isActive === false) return
    const { input, key } = event
    if (!(input === 'c' && key.ctrl) || !internal_exitOnCtrlC) {
      inputHandler(input, key, event)
    }
  })

  useEffect(() => {
    internal_eventEmitter?.on('input', handleData)
    return () => { internal_eventEmitter?.removeListener('input', handleData) }
  }, [internal_eventEmitter, handleData])
}
```

值得注意的细节（直接来自源码注释）：

- `useLayoutEffect`（不是 `useEffect`）：保证 raw mode 在 React commit 阶段同步启用，避免按键被 cooked mode 回显。
- 监听器**永久注册**（`isActive` 不进 deps），通过 `useEventCallback` 读最新 closure，从而保持 EventEmitter listener slot 顺序稳定 —— 这是为了让 `stopImmediatePropagation()` 优先级正确（`src/ink/hooks/use-input.ts:62-68` 的注释明确解释了这点）。

### 1.3 ESC 键的特殊解析

`src/ink/parse-keypress.ts:715` 设置 `key.name = 'escape'`，但 Claude Code 还要处理 Kitty / CSI-u 协议下"被字面注入为 `escape` 字符串"的退化场景（`parse-keypress.ts:414-416` 注释）。

### 1.4 keybinding 路由：`chat:cancel` vs `app:interrupt`

`src/keybindings/defaultBindings.ts:40,66`：

```typescript
'ctrl+c': 'app:interrupt',
'ctrl+d': 'app:exit',
// ...
escape: 'chat:cancel',
```

注意 ctrl+c / ctrl+d 是**硬保留**：可以出现在配置里但 `reservedShortcuts.ts` 不让用户改（`defaultBindings.ts:36-40` 的注释）。

`useKeybinding(action, handler, options)` (`src/keybindings/useKeybinding.ts:33`) 在 useInput 里判断 keybinding 上下文，匹配则调 handler 并 `event.stopImmediatePropagation()`。它支持 chord（如 `ctrl+x ctrl+k`）。

### 1.5 CancelRequestHandler 的优先级语义（核心）

整个中断系统的核心是 `src/hooks/useCancelRequest.ts:63` 的 `CancelRequestHandler` 组件，注册三个 keybinding：

| Keybinding | Action | 触发条件 |
|---|---|---|
| Esc | `chat:cancel` | 有运行中任务 OR 队列中有命令 + 不在特殊模式 |
| Ctrl+C | `app:interrupt` | 有运行中任务 OR 队列中有命令 OR 在 teammate 视图 |
| Ctrl+X Ctrl+K | `chat:killAgents` | 总是 active（双击窗口杀所有后台 agent） |

`handleCancel` 的优先级判定（`useCancelRequest.ts:87-122`）：

```typescript
const handleCancel = useCallback(() => {
  // Priority 1: If there's an active task running, cancel it first
  if (abortSignal !== undefined && !abortSignal.aborted) {
    logEvent('tengu_cancel', cancelProps)
    setToolUseConfirmQueue(() => [])
    onCancel()                       // ← 这里 abortController.abort('user-cancel')
    return
  }

  // Priority 2: Pop queue when Claude is idle
  if (hasCommandsInQueue()) {
    if (popCommandFromQueue) {
      popCommandFromQueue()
      return
    }
  }

  // Fallback: nothing to cancel or pop
  logEvent('tengu_cancel', cancelProps)
  setToolUseConfirmQueue(() => [])
  onCancel()
}, [abortSignal, popCommandFromQueue, setToolUseConfirmQueue, onCancel, streamMode])
```

**单次 Esc 语义**（按"上下文优先级"层叠）：

1. 弹出活跃 overlay（ModelPicker / ThinkingToggle / ...）—— overlay 自己注册 useRegisterOverlay，不到 CancelRequestHandler
2. 退出特殊输入模式（bash/background mode 且空输入）—— 让 PromptInput 自己处理
3. 如果当前在看 teammate transcript —— useBackgroundTaskNavigation 处理
4. 如果有运行中 task —— **触发 onCancel() → abortController.abort('user-cancel')**
5. 否则 pop 队列里的下一条命令

可以看到 Esc 在 Claude Code 里**不仅仅是"取消"，而是"context-aware undo/back"**（`useCancelRequest.ts:124-154` 的多个 isActive 守卫）。

### 1.6 `onCancel()` 的实际工作（REPL.tsx:2106）

```typescript
function onCancel() {
  if (focusedInputDialog === 'elicitation') {
    // Elicitation dialog handles its own Escape
    return;
  }

  // Pause proactive mode
  if (feature('PROACTIVE') || feature('KAIROS')) {
    proactiveModule?.pauseProactive();
  }
  queryGuard.forceEnd();
  skipIdleCheckRef.current = false;

  // Preserve partially-streamed text so user can read what was generated before Esc
  if (streamingText?.trim()) {
    setMessages(prev => [...prev, createAssistantMessage({
      content: streamingText
    })]);
  }
  resetLoadingState();

  // Clear active token budget so backstop doesn't fire on stale budget
  if (feature('TOKEN_BUDGET')) {
    snapshotOutputTokensForTurn(null);
  }
  if (focusedInputDialog === 'tool-permission') {
    // Tool use confirm handles the abort signal itself
    toolUseConfirmQueue[0]?.onAbort();
    setToolUseConfirmQueue([]);
  } else if (focusedInputDialog === 'prompt') {
    for (const item of promptQueue) {
      item.reject(new Error('Prompt cancelled by user'));
    }
    setPromptQueue([]);
    abortController?.abort('user-cancel');
  } else if (activeRemote.isRemoteMode) {
    activeRemote.cancelRequest();
  } else {
    abortController?.abort('user-cancel');
  }

  // Clear the controller so subsequent Escape presses don't see a stale aborted signal
  setAbortController(null);

  void mrOnTurnComplete(messagesRef.current, true);
}
```

引用：`src/screens/REPL.tsx:2106-2163`。

几个值得注意的源码注释（直接抄录）：

- 行 2121-2124：**保留半流式文本**到消息列表，让用户能看到 Esc 前生成了什么。Push 必须发生在 `resetLoadingState()` 清掉 `streamingText` 之前，也必须发生在 `query.ts` yield 异步中断 marker 之前，最终顺序：`[user, partial-assistant, [Request interrupted by user]]`。
- 行 2155-2158：**清空 abortController 引用**，否则连按 Esc 看到的是 stale aborted signal，`canCancelRunningTask` 变成 false，keybinding 不再 active。
- 行 2161：`forceEnd()` 跳过 finally，所以这里手动 fire `mrOnTurnComplete(..., aborted=true)`。

### 1.7 abort 的"reason 字符串协议"（重要）

`abortController.abort(reason)` 传的字符串**不是日志**，而是**协议**。下游的 listener 全部基于 `signal.reason` 分支：

| reason | 来源 | 含义 |
|---|---|---|
| `'user-cancel'` | REPL.tsx onCancel (`REPL.tsx:2147,2152`) | 用户按 Esc / Ctrl+C |
| `'interrupt'` | useEffect on queuedCommands (`REPL.tsx:4102`) + handlePromptSubmit (`handlePromptSubmit.ts:331`) + bridge / WebSocket (`bridgeMessaging.ts:362`) | **用户在任务运行中再次提交了一条新消息** |
| `'background'` | REPL.tsx 初始化路径 (`REPL.tsx:2528`) | 用户主动把当前轮 background 化 |
| `'sibling_error'` | StreamingToolExecutor (`StreamingToolExecutor.ts:362`) | Bash 工具失败导致并发兄弟工具一起取消 |
| `'streaming_fallback'` | StreamingToolExecutor (隐式 via `discarded`) | 流式失败要回退非流式，丢弃投机执行的工具 |

下游的"分歧点"集中在 ShellCommand 与 query.ts：

#### Bash 工具 abort handler (ShellCommand.ts:186-193)

```typescript
#abortHandler(): void {
  // On 'interrupt' (user submitted a new message), don't kill — let the
  // caller background the process so the model can see partial output.
  if (this.#abortSignal.reason === 'interrupt') {
    return
  }
  this.kill()
}
```

**`'user-cancel'` 直接 kill；`'interrupt'` 不杀**——让 BashTool 把进程 background 化（这样模型能看到当前 stdout snapshot 后继续）。

#### query.ts 中断消息生成 (query.ts:1046-1051, 1501-1505)

```typescript
// Skip the interruption message for submit-interrupts — the queued
// user message that follows provides sufficient context.
if (toolUseContext.abortController.signal.reason !== 'interrupt') {
  yield createUserInterruptionMessage({ toolUse: false })
}
return { reason: 'aborted_streaming' }
```

**`'user-cancel'` 注入 "[Request interrupted by user]" 消息；`'interrupt'` 不注入**——因为紧接着会 enqueue 用户的新消息，那条新消息本身就提供了上下文，再插一条 "interrupted" 反而冗余。

#### StreamingToolExecutor 行为分歧 (StreamingToolExecutor.ts:219-230)

```typescript
if (this.toolUseContext.abortController.signal.aborted) {
  // 'interrupt' means the user typed a new message while tools were
  // running. Only cancel tools whose interruptBehavior is 'cancel';
  // 'block' tools shouldn't reach here (abort isn't fired).
  if (this.toolUseContext.abortController.signal.reason === 'interrupt') {
    return this.getToolInterruptBehavior(tool) === 'cancel'
      ? 'user_interrupted'
      : null
  }
  return 'user_interrupted'
}
```

`'interrupt'` 触发 fine-grained 决策：`Tool.interruptBehavior()` 返回 `'cancel'` 的（如 SleepTool）才取消，返回 `'block'` 的（默认，包括大多数工具）继续运行。`'user-cancel'` 是粗粒度全部取消。

### 1.8 双源 abort 汇聚：createChildAbortController 与 createCombinedAbortSignal

Claude Code 有两个抽象处理 abort 的"加性"组合：

#### `createChildAbortController` (`src/utils/abortController.ts:68-99`)

子 controller 在父 abort 时也 abort，但子 abort 不影响父。**用 WeakRef 防止父 controller 被 abandoned 的子拽住不能 GC**：

```typescript
export function createChildAbortController(
  parent: AbortController,
  maxListeners?: number,
): AbortController {
  const child = createAbortController(maxListeners)
  if (parent.signal.aborted) {
    child.abort(parent.signal.reason)
    return child
  }
  const weakChild = new WeakRef(child)
  const weakParent = new WeakRef(parent)
  const handler = propagateAbort.bind(weakParent, weakChild)
  parent.signal.addEventListener('abort', handler, { once: true })
  child.signal.addEventListener(
    'abort',
    removeAbortHandler.bind(weakParent, new WeakRef(handler)),
    { once: true },
  )
  return child
}
```

StreamingToolExecutor 用它给每个并发 tool 一个独立 abort，单个工具失败可以 abort 自己（影响兄弟）而不直接 abort 整个 turn（`StreamingToolExecutor.ts:301-318`）。

#### `createCombinedAbortSignal` (`src/utils/combinedAbortSignal.ts:15-47`)

OR 多个 signal + 一个可选 timeoutMs 起 setTimeout，返回 `{ signal, cleanup }`。**为什么不直接用 `AbortSignal.timeout(ms)`**——源码注释（行 9-13）：

> Use `timeoutMs` instead of passing `AbortSignal.timeout(ms)` as a signal — under Bun, `AbortSignal.timeout` timers are finalized lazily and accumulate in native memory until they fire (measured ~2.4KB/call held for the full timeout duration). This implementation uses `setTimeout` + `clearTimeout` so the timer is freed immediately on cleanup.

主要用于 hooks 系统（per-hook timeout）和 MCP 调用（合并父 signal 与协议级 timeout）。

### 1.9 setMaxListeners(50) 防警告 (`abortController.ts:16-22`)

```typescript
export function createAbortController(
  maxListeners: number = DEFAULT_MAX_LISTENERS,  // 50
): AbortController {
  const controller = new AbortController()
  setMaxListeners(maxListeners, controller.signal)
  return controller
}
```

Node 的 EventEmitter 默认 10 个 listener 就警告。一个长 turn 的 abortSignal 会被 SDK、所有并发 tool、所有 hook、idle watchdog 等加各种 listener，10 个根本不够用。Claude Code 把上限拉到 50 直接绕过 noise。

---

## 二、LLM Stream Idle-Timeout

### 2.1 存在性结论

**存在**。位于 `src/services/api/claude.ts:1868-1928`，由环境变量 `CLAUDE_ENABLE_STREAM_WATCHDOG` 启用（**默认关闭**），阈值由 `CLAUDE_STREAM_IDLE_TIMEOUT_MS` 配置（**默认 90,000 ms**）。

> 已有 `zhixing/research/source-analysis/claude-code/resilience.md:237` 写"目前没有流看门狗机制"——**该结论已过时**，本文基于最新源码修订。

### 2.2 实现细节（chunk-arrival idle）

```typescript
// src/services/api/claude.ts:1868-1928
const streamWatchdogEnabled = isEnvTruthy(
  process.env.CLAUDE_ENABLE_STREAM_WATCHDOG,
)
const STREAM_IDLE_TIMEOUT_MS =
  parseInt(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS || '', 10) || 90_000
const STREAM_IDLE_WARNING_MS = STREAM_IDLE_TIMEOUT_MS / 2
let streamIdleAborted = false
let streamWatchdogFiredAt: number | null = null
let streamIdleWarningTimer: ReturnType<typeof setTimeout> | null = null
let streamIdleTimer: ReturnType<typeof setTimeout> | null = null

function clearStreamIdleTimers(): void {
  if (streamIdleWarningTimer !== null) {
    clearTimeout(streamIdleWarningTimer)
    streamIdleWarningTimer = null
  }
  if (streamIdleTimer !== null) {
    clearTimeout(streamIdleTimer)
    streamIdleTimer = null
  }
}

function resetStreamIdleTimer(): void {
  clearStreamIdleTimers()
  if (!streamWatchdogEnabled) return
  streamIdleWarningTimer = setTimeout(/* ... 45s warn ... */)
  streamIdleTimer = setTimeout(() => {
    streamIdleAborted = true
    streamWatchdogFiredAt = performance.now()
    logForDebugging(
      `Streaming idle timeout: no chunks received for ${STREAM_IDLE_TIMEOUT_MS / 1000}s, aborting stream`,
      { level: 'error' },
    )
    logEvent('tengu_streaming_idle_timeout', { /* ... */ })
    releaseStreamResources()         // ← 真正杀连接
  }, STREAM_IDLE_TIMEOUT_MS)
}
resetStreamIdleTimer()

// in for-await loop:
for await (const part of stream) {
  resetStreamIdleTimer()              // ← 每个 chunk 重置
  // ...
}
```

### 2.3 关键设计点

**(a) Idle vs 整体 timeout 是分开的**

| 计时器 | 阈值 | 触发条件 | 实现位置 |
|---|---|---|---|
| **stream chunk-idle watchdog** | 90s（可调） | 任意两个 SSE chunk 之间静默时长 | `claude.ts:1868-1928` |
| **stall detection** | 30s | 同上，但只 log 不 abort（仅遥测） | `claude.ts:1936-1965` |
| **non-streaming fallback timeout** | 300s（remote 120s） | 整个非流式 HTTP 请求 | `claude.ts:807-811` |
| **SDK 顶层 timeout** | 600s（10min，可调 `API_TIMEOUT_MS`） | 给 Anthropic SDK 的 `timeout` 参数 | `services/api/client.ts:144` |
| **SDK 内置 retry** | maxRetries: 0 | **关闭** | `client.ts:143` |

**watchdog 是 chunk-arrival idle**，不是"整个流的总长度"。每个 SSE event 到达就 reset。这是为了"TCP 连接静默死亡"的场景：HTTP 200 已经回，但代理或对端把 socket 静默丢了，SDK 的 fetch timeout 已经满足，body 永远 hang。

**(b) 90s + 45s warning 双阈值**

```typescript
const STREAM_IDLE_WARNING_MS = STREAM_IDLE_TIMEOUT_MS / 2  // 45s
streamIdleWarningTimer = setTimeout(
  warnMs => {
    logForDebugging(
      `Streaming idle warning: no chunks received for ${warnMs / 1000}s`,
      { level: 'warn' },
    )
    logForDiagnosticsNoPII('warn', 'cli_streaming_idle_warning')
  },
  STREAM_IDLE_WARNING_MS,
  STREAM_IDLE_WARNING_MS,
)
```

警告只 log，不 abort —— 用于事后回归分析"45s 警告了多少次但 90s 实际没触发"。

**(c) 触发后的"两阶段"行为**

watchdog 触发不是直接抛错，而是：

1. 设置 `streamIdleAborted = true`，记录 `streamWatchdogFiredAt = performance.now()`
2. 调 `releaseStreamResources()`（`claude.ts:1519-1526`）：cleanup stream + cancel response.body
3. for-await 循环本应因 stream cancel 抛 `APIUserAbortError`，**或干净退出**
4. 退出后再判 `if (streamIdleAborted)` (`claude.ts:2310`) → 显式 throw 内部 `Error('Stream idle timeout - no chunks received')`
5. 该错误进入 catch block (`claude.ts:2404`) → 走 **non-streaming fallback** 路径

```typescript
// claude.ts:2310-2335
if (streamIdleAborted) {
  const exitDelayMs = streamWatchdogFiredAt !== null
    ? Math.round(performance.now() - streamWatchdogFiredAt)
    : -1
  logEvent('tengu_stream_loop_exited_after_watchdog', {
    request_id: streamRequestId ?? 'unknown',
    exit_delay_ms: exitDelayMs,           // ← 测量 abort 传播延迟
    exit_path: 'clean',
    model: options.model,
  })
  streamWatchdogFiredAt = null
  throw new Error('Stream idle timeout - no chunks received')
}
```

`exit_delay_ms` 是个亮眼的可观测性细节：测量"从 watchdog 触发 abort 到 for-await 实际退出"的延迟。0-10ms 表示 abort 工作；>>1000ms 说明 stream 实际是被别的什么唤醒的。

**(d) abort 分类：用户 vs SDK**

```typescript
// claude.ts:2434-2462
if (streamingError instanceof APIUserAbortError) {
  if (signal.aborted) {
    // This is a real user abort (ESC key was pressed)
    throw streamingError
  } else {
    // The SDK threw APIUserAbortError but our signal wasn't aborted
    // This means it's a timeout from the SDK's internal timeout
    throw new APIConnectionTimeoutError({ message: 'Request timed out' })
  }
}
```

通过检查"是不是我们自己的 signal aborted"区分**用户 Esc** 与 **SDK 内部 timeout**。

**(e) 资源释放 (`claude.ts:1515-1526`)**

```typescript
function releaseStreamResources(): void {
  cleanupStream(stream)
  stream = undefined
  if (streamResponse) {
    streamResponse.body?.cancel().catch(() => {})
    streamResponse = undefined
  }
}
```

注释（行 1515-1518）：

> The Response object holds native TLS/socket buffers that live outside the V8 heap (observed on the Node.js/npm path; see GH #32920), so we must explicitly cancel and release it regardless of how the generator exits.

——这是从生产事故倒推出来的：`Response.body.cancel()` 必须显式调，否则 native TLS buffer 累积到 OOM。

### 2.4 另一个 idle timeout：SDK 模式的 session-level

`src/utils/idleTimeout.ts:11-53` 的 `createIdleTimeoutManager` 是**完全不同的另一个东西**——SDK / headless 模式下，整个 process 多久没有活动后退出。由 `CLAUDE_CODE_EXIT_AFTER_STOP_DELAY` 配置，调 `gracefulShutdownSync()`。**不与 LLM 流相关**，仅在 `cli/print.ts:1747` 实例化一次。

---

## 三、Tool Call 的 Abort 传播

### 3.1 abortController 怎么进入工具

工具签名（`Tool.ts:158-180`）：

```typescript
export type ToolUseContext = {
  options: { /* ... */ }
  abortController: AbortController     // ← 整个 ToolUseContext 持一个
  readFileState: FileStateCache
  // ...
}
```

`runToolUse(toolUse, assistantMessage, canUseTool, toolUseContext)` (`services/tools/toolExecution.ts:337`) 在执行**前**先检查一次：

```typescript
// toolExecution.ts:415-453
if (toolUseContext.abortController.signal.aborted) {
  logEvent('tengu_tool_use_cancelled', { /* ... */ })
  const content = createToolResultStopMessage(toolUse.id)
  content.content = withMemoryCorrectionHint(CANCEL_MESSAGE)
  yield {
    message: createUserMessage({
      content: [content],
      toolUseResult: CANCEL_MESSAGE,
      sourceToolAssistantUUID: assistantMessage.uuid,
    }),
  }
  return
}
```

——已经 abort 的 tool **完全不执行**，直接 yield 一个合规的 `tool_result`（必须有，否则后续 user message 会因为 unmatched tool_use 被 API 拒）。

工具的 `call` 函数从 `toolUseContext` 解构 `abortController`：

```typescript
// BashTool.tsx:624-635
async call(input, toolUseContext, _canUseTool, parentMessage, onProgress) {
  // ...
  const { abortController, getAppState, setAppState, setToolJSX } = toolUseContext;
  // ...
}

// WebFetchTool.ts:208-211
async call(
  { url, prompt },
  { abortController, options: { isNonInteractiveSession } },
) {
  const response = await getURLMarkdownContent(url, abortController)
  // ...
}
```

### 3.2 BashTool：abort 把 child process 真正 SIGKILL

链路：

1. `BashTool.call()` (`BashTool.tsx:624-635`) 解 `abortController`
2. 调 `runShellCommand({ ..., abortController, ... })` (`BashTool.tsx:646-657`)
3. 内部 `await exec(command, abortController.signal, 'bash', { ... })` (`BashTool.tsx:881`)
4. `exec()` (`utils/Shell.ts:181-186`) 接 `abortSignal: AbortSignal`
5. `exec` 检查 `if (abortSignal.aborted) return createAbortedCommand()` (`Shell.ts:241-243`)
6. 否则 spawn child + 调 `wrapSpawn(childProcess, abortSignal, ...)` (`Shell.ts:339-345`)
7. `ShellCommandImpl` 构造时 `addEventListener('abort', this.#abortHandler, { once: true })` (`ShellCommand.ts:264-267`)
8. abortHandler 检查 reason:

```typescript
// ShellCommand.ts:186-193
#abortHandler(): void {
  if (this.#abortSignal.reason === 'interrupt') {
    return  // ← 'interrupt' 不杀，让调用方自己 background
  }
  this.kill()
}

// ShellCommand.ts:337-343
#doKill(code?: number): void {
  this.#status = 'killed'
  if (this.#childProcess.pid) {
    treeKill(this.#childProcess.pid, 'SIGKILL')   // ← treeKill 杀整个进程树
  }
  this.#resolveExitCode(code ?? SIGKILL)
}
```

**`treeKill` 而不是 `process.kill`**——bash 命令通常会 fork 子进程（`make`、`pytest` 等），普通 kill 会留孤儿。

#### 同步取消 vs 等下个 chunk

`treeKill` 是**同步发 SIGKILL**，但 `result` Promise 在 child 真正退出（`'exit'` 事件）后才 resolve（`ShellCommand.ts:272`）。所以：

- **abort 是同步发出**的（不等任何 chunk 边界）
- **结果回收是异步的**（要等 OS reap process）
- **数据不丢**：stdout 已经写到磁盘（file mode）或内存 buffer（pipe mode），`#handleExit` (`ShellCommand.ts:291-335`) 把已收到的部分包装为 `ExecResult { interrupted: true, ... }` 返回

### 3.3 WebFetchTool：abort 让 axios 抛 CanceledError

```typescript
// WebFetchTool/utils.ts:262-282
export async function getWithPermittedRedirects(
  url: string,
  signal: AbortSignal,
  redirectChecker: (originalUrl: string, redirectUrl: string) => boolean,
  depth = 0,
): Promise<AxiosResponse<ArrayBuffer> | RedirectInfo> {
  // ...
  return await axios.get(url, {
    signal,
    timeout: FETCH_TIMEOUT_MS,    // 60_000
    maxRedirects: 0,
    responseType: 'arraybuffer',
    maxContentLength: MAX_HTTP_CONTENT_LENGTH,
    headers: { /* ... */ },
  })
}
```

直接把 `abortController.signal` 透传给 axios。axios 看到 signal aborted 会同步 abort 底层 http request 并抛 `CanceledError`。**没有 graceful 等下个 chunk**——HTTP 请求直接 RST。

### 3.4 per-tool timeout vs abort 是分开的两套

以 BashTool 为例：

| 维度 | 实现 | 触发后行为 |
|---|---|---|
| **abort（外部）** | abortController.signal | reason='user-cancel' → SIGKILL 进程树；reason='interrupt' → 让调用方 background 化 |
| **timeout（内部）** | `setTimeout(handleTimeout, this.#timeout)` (`ShellCommand.ts:275-279`) | 默认 SIGTERM；如果 `shouldAutoBackground` 为 true 且有 onTimeoutCallback，则改为 background 化 |

```typescript
// ShellCommand.ts:135-141
static #handleTimeout(self: ShellCommandImpl): void {
  if (self.#shouldAutoBackground && self.#onTimeoutCallback) {
    self.#onTimeoutCallback(self.background.bind(self))
  } else {
    self.#doKill(SIGTERM)
  }
}
```

WebFetch 的 timeout 是 axios 内的 `timeout: 60_000`，与 abortSignal 完全独立。如果 axios timeout 先到，会抛 `ECONNABORTED`，与 abort 不冲突。

### 3.5 并发工具：兄弟 abort 链

`StreamingToolExecutor` 里每个并发工具拿一个 `createChildAbortController(siblingAbortController)`（`StreamingToolExecutor.ts:301-318`）：

```typescript
const toolAbortController = createChildAbortController(
  this.siblingAbortController,
)
toolAbortController.signal.addEventListener(
  'abort',
  () => {
    if (
      toolAbortController.signal.reason !== 'sibling_error' &&
      !this.toolUseContext.abortController.signal.aborted &&
      !this.discarded
    ) {
      this.toolUseContext.abortController.abort(
        toolAbortController.signal.reason,
      )
    }
  },
  { once: true },
)

const generator = runToolUse(
  tool.block,
  tool.assistantMessage,
  this.canUseTool,
  { ...this.toolUseContext, abortController: toolAbortController },  // ← 传 child
)
```

——**工具看到的 abortController 不是 turn-level 那个，而是它自己的 child**。

#### 兄弟错误传播的非对称性 (`StreamingToolExecutor.ts:347-364`)

```typescript
if (isErrorResult) {
  thisToolErrored = true
  // Only Bash errors cancel siblings. Bash commands often have implicit
  // dependency chains (e.g. mkdir fails → subsequent commands pointless).
  // Read/WebFetch/etc are independent — one failure shouldn't nuke the rest.
  if (tool.block.name === BASH_TOOL_NAME) {
    this.hasErrored = true
    this.erroredToolDescription = this.getToolDescription(tool)
    this.siblingAbortController.abort('sibling_error')
  }
}
```

——只有 **Bash 失败才波及兄弟**，因为 bash 命令常有隐式依赖（`mkdir foo && cd foo` 失败后，后面的命令也没意义）。文件读、WebFetch 等独立操作的失败不会取消同批兄弟。这是一条非常具体的"血泪教训型"决策。

### 3.6 interruptBehavior：单工具决定中断态度 (`Tool.ts:407-416`)

```typescript
/**
 * What should happen when the user submits a new message while this tool
 * is running.
 *
 * - `'cancel'` — stop the tool and discard its result
 * - `'block'`  — keep running; the new message waits
 *
 * Defaults to `'block'` when not implemented.
 */
interruptBehavior?(): 'cancel' | 'block'
```

`StreamingToolExecutor.ts:233-241` 在 reason='interrupt' 路径上读这个：

```typescript
private getToolInterruptBehavior(tool: TrackedTool): 'cancel' | 'block' {
  const definition = findToolByName(this.toolDefinitions, tool.block.name)
  if (!definition?.interruptBehavior) return 'block'
  try {
    return definition.interruptBehavior()
  } catch {
    return 'block'
  }
}
```

唯一注释里点名的 `'cancel'` 工具是 SleepTool（`handlePromptSubmit.ts:320` 注释）——干睡的工具，submit 新消息时直接取消是显然的。其余工具默认 `'block'`，新消息排队等当前工具自然结束。

### 3.7 Tool abort 的最终 yield (`query.ts:1485-1516`)

工具执行循环退出后再查一次：

```typescript
if (toolUseContext.abortController.signal.aborted) {
  if (feature('CHICAGO_MCP') && !toolUseContext.agentId) {
    try {
      const { cleanupComputerUseAfterTurn } = await import(
        './utils/computerUse/cleanup.js'
      )
      await cleanupComputerUseAfterTurn(toolUseContext)
    } catch { /* silent */ }
  }
  if (toolUseContext.abortController.signal.reason !== 'interrupt') {
    yield createUserInterruptionMessage({ toolUse: true })
  }
  // Check maxTurns before returning
  const nextTurnCountOnAbort = turnCount + 1
  if (maxTurns && nextTurnCountOnAbort > maxTurns) {
    yield createAttachmentMessage({
      type: 'max_turns_reached',
      maxTurns,
      turnCount: nextTurnCountOnAbort,
    })
  }
  return { reason: 'aborted_tools' }
}
```

注意 `reason='aborted_streaming'` (`query.ts:1051`) vs `'aborted_tools'` (`query.ts:1515`) 是**两种不同的 Terminal**——前者表示用户在模型 stream 阶段中断，后者表示在并发工具执行阶段中断。

### 3.8 孤立 tool_use 的安全网

`query.ts:1011-1029`（streaming abort 路径）：

```typescript
if (toolUseContext.abortController.signal.aborted) {
  if (streamingToolExecutor) {
    // Consume remaining results - executor generates synthetic tool_results for
    // aborted tools since it checks the abort signal in executeTool()
    for await (const update of streamingToolExecutor.getRemainingResults()) {
      if (update.message) {
        yield update.message
      }
    }
  } else {
    yield* yieldMissingToolResultBlocks(
      assistantMessages,
      'Interrupted by user',
    )
  }
  // ...
}
```

**目标**：保证 protocol invariant —— 每个 `tool_use` 必须有匹配的 `tool_result`，否则下一轮 API 会 400。即使被 abort，也要造一条合成的 `{ type: 'tool_result', is_error: true, content: 'Interrupted by user' }`。

### 3.9 Esc 触发的多次 abort 路径汇总

```
Esc keypress
  ↓ (Ink useInput → keybinding 'chat:cancel' → CancelRequestHandler)
onCancel()                                                  REPL.tsx:2106
  ↓
abortController.abort('user-cancel')                        REPL.tsx:2147 / 2152
  ↓ (signal.aborted = true, reason = 'user-cancel')
  ├──→ ShellCommandImpl.#abortHandler()                     ShellCommand.ts:186
  │       └ treeKill(pid, 'SIGKILL')                        ShellCommand.ts:340
  ├──→ axios.get({signal}) 抛 CanceledError                 WebFetchTool/utils.ts:272
  ├──→ Anthropic SDK 抛 APIUserAbortError                   claude.ts:2434 处理
  │       └ throw streamingError ↑ to query.ts
  ├──→ runToolUse for-await 退出 (signal.aborted)           toolExecution.ts:415
  │       └ yield 合成的 tool_result
  └──→ query.ts main loop 检查 signal.aborted
          └ yield createUserInterruptionMessage
          └ return { reason: 'aborted_streaming' or 'aborted_tools' }
```

---

## 四、关键设计模式

### 4.1 Reason 字符串作为协议（不是日志）

Claude Code 把 `abortController.abort(reason)` 的 reason 当作**轻量级 enum 协议**：每个下游 listener 都基于 `signal.reason === '...'` 做行为分支。

| reason | 设计意图 |
|---|---|
| `'user-cancel'` | 显式用户取消，全部清理 |
| `'interrupt'` | 用户submit 新消息（后续会有上下文），保留状态、轻量取消 |
| `'background'` | 主动放后台，不要 yield interruption message |
| `'sibling_error'` | 并发兄弟取消，不再升级到 turn-level |
| `'streaming_fallback'` | 投机执行作废，但不视为用户中断 |

这种设计的好处：**不需要新增 controller 字段或独立机制**就能区分多种"abort 但语义不同"的情况。

### 4.2 三层超时分工

| 层 | 超时 | 默认值 | 触发后果 |
|---|---|---|---|
| L1 SDK fetch | API_TIMEOUT_MS | 600s | 抛 APIUserAbortError → 我们识别为 SDK timeout |
| L2 Stream chunk-idle watchdog | CLAUDE_STREAM_IDLE_TIMEOUT_MS | 90s（需开关启用） | release stream → throw 内部 Error → 走非流式 fallback |
| L3 Per-tool timeout | tool-specific（Bash 默认 2min；WebFetch 60s） | — | 抛工具内部错或 SIGTERM child |

每层目标不同：L1 防 socket 永远不收 first-byte；L2 防 SSE 中途静默死亡；L3 防工具自己 hang。

### 4.3 Esc 双语义（context-aware undo）

单次 Esc **不一定**取消任务，按上下文优先级层叠：弹 overlay → 退特殊模式 → 离开 teammate 视图 → 取消任务 → pop 队列。CancelRequestHandler 通过多个 isActive 守卫精确路由（`useCancelRequest.ts:124-167`）。

Ctrl+C 双击退出（`useExitOnCtrlCD.ts` + `useDoublePress.ts`）：第一次显示"再按一次退出"提示，800ms 内再次按下才真正 `exit()`。

### 4.4 WeakRef 防 abort 链泄漏

`createChildAbortController` 用 WeakRef 是对**长生命周期 controller + 大量短命 child** 模式的针对性优化（`abortController.ts:80-91`）。一个 main turn 可能跑数十个并发工具，每个工具一个 child controller；如果 parent 强引用所有 child，Garbage Collector 即使 child 早被 abandoned 也回收不了。

### 4.5 中断后保留半流式输出

REPL.tsx:2125-2129 在 abort 前把 `streamingText` 物化为一条 assistant message。这意味着用户按 Esc 后**屏幕上保留住"打了一半的回答"**，避免"按下 Esc → 屏幕瞬间清空"的体验断层。

### 4.6 'interrupt' 不杀 child process

ShellCommand.ts:186-193 的 `'interrupt'` early-return 是个非常人性化的设计：用户在长 bash 命令运行中再次提交（比如"把刚才那个换成另一个 flag"），不应该干掉正在运行的东西，应该让它继续在后台跑——模型下一轮可以拉 partial output 决定要不要 kill。

### 4.7 abort 传播延迟可观测性

`exit_delay_ms` 上报（`claude.ts:2314-2330`）：

```typescript
const exitDelayMs = streamWatchdogFiredAt !== null
  ? Math.round(performance.now() - streamWatchdogFiredAt)
  : -1
```

测量"我 abort 了，多久后 for-await 真正退出"——这是个非显然的指标，但对调试"我 abort 了为什么还在跑"类问题极有用。

---

## 五、值得 zhixing 借鉴的细节

1. **abort reason 作为协议串起多语义中断**。zhixing 当前的 `runAgentLoop` 也是 AsyncGenerator，`AbortController` 也已经有，但 reason 是 plain abort()。引入 `'user-cancel' | 'interrupt' | 'background'` 这样的 enum 字符串，就能让"用户按 Esc"和"用户中途加新消息"走两条不同的下游路径，而不需要新增结构。

2. **stream chunk-idle watchdog 比"整体 timeout"更合适**。SSE 流的失败模式是"first-byte 之后静默"，单一的 SDK fetch timeout 在 first-byte 之后就满足了，挡不住 hang。`setTimeout` 在每个 chunk 上 reset 是非常便宜的实现（`claude.ts:1895-1928`），代价就是几行代码 + 一个 setTimeout 句柄。**45s warn + 90s abort 的双阈值**也值得参考——警告先飞遥测，事后能数据驱动决定阈值是否合理。

3. **中断时显式把半流式文本物化**（`REPL.tsx:2125-2129`）。这是 UX 细节但很关键：避免"按 Esc 屏幕清空"的不连贯。zhixing 当前的 REPL（packages/cli/src/repl.ts）应该有类似策略，至少把已经渲染到屏幕的内容固化为一条 assistant message。

4. **孤立 tool_use 安全网**（`query.ts:1019-1028, 1485-1516`）。中断时必须为每个未完成的 `tool_use` 合成一条 `tool_result`，否则下一轮 API 会 400。这是个 protocol invariant，zhixing 实现 stream agent loop 时不可绕过。

5. **WeakRef child abortController + setMaxListeners(50)**。前者防泄漏，后者绕开 EventEmitter 警告（`abortController.ts:16-22`）。任何"一个父 abort 衍生出多个子操作"的场景（并发 tool、并发 hook、并发 MCP 调用）都会遇到，照抄即可。

6. **'interrupt' reason 不 kill child process** (`ShellCommand.ts:186-193`)。zhixing 的 Bash 工具如果做并发或长跑命令支持，应当考虑这个语义：用户加新消息≠用户想 kill 进程。

---

## 六、不适合 zhixing 的部分

1. **Ink 自有的 keybinding 框架（chord、context、useRegisterOverlay 优先级）**。这是为完整 TUI 应用设计的，zhixing 当前是简单 REPL，引入完整 keybinding 系统是 over-engineering。**直接监听 stdin 'keypress'** 处理 Ctrl+C / Esc 即可。

2. **`createChildAbortController` 的 WeakRef 优化**。仅在"父 controller 长寿，子 controller 大量短命被 abandoned"的极端场景才有意义。zhixing 单 turn 的并发度远低于 Claude Code，普通 child（强引用 + 显式 cleanup）够用；过早引入 WeakRef 反而难调试。

3. **多种 abort reason 的全套语义**。Claude Code 的 5 种 reason 是逐步演化堆出来的（`'sibling_error'` 来自并发执行器、`'streaming_fallback'` 来自投机执行）。zhixing 当前阶段先实现 `'user-cancel' | 'idle-timeout'` 两种就足够，等真有"用户加新消息"或"并发兄弟错误"场景再增量加。

4. **CancelRequestHandler 的多上下文层叠优先级**。zhixing 没有 dialog overlay、teammate view、bash mode 等多种 UI 模式，单一"运行中→取消"路径足够。

5. **session-level idle timeout（`utils/idleTimeout.ts`）**。这是 SDK headless 模式专用——服务化部署时多久没活动后退出 process。zhixing 当前是交互式 REPL，进程应一直活到用户 exit，无需此机制。

6. **`'interrupt'` 时让 BashTool 主动 background 化**。这个语义依赖 BashTool 自身有 background task 子系统（`runShellCommand` 的 spawnBackgroundTask 路径），zhixing 当前 BashTool 没这个能力。要么一并实现 background tasks，要么干脆 `'interrupt'` = `'user-cancel'`（直接 kill）。

7. **prompt-cache-aware 的 abort 处理（`claude.ts:2114` 区块）**。Claude Code 在 abort 后还要小心不破坏 prompt cache 前缀（fast mode 切换有 10min 冷却期），这是因为 Anthropic 计费模型有 cache 折扣。zhixing 的多 provider 抽象层目前不暴露 cache 概念，无需关心。

---

## 附：源码引用索引

### 中断/Abort 入口与路由
- `_refs/claude-code-analysis/src/ink/hooks/use-input.ts:42-90` — Ink useInput
- `_refs/claude-code-analysis/src/ink/parse-keypress.ts:1-60, 414-416, 715` — 键盘字节解析
- `_refs/claude-code-analysis/src/keybindings/defaultBindings.ts:32-66` — 默认 keybinding（escape/ctrl+c/ctrl+d）
- `_refs/claude-code-analysis/src/keybindings/useKeybinding.ts:33-97` — keybinding 路由
- `_refs/claude-code-analysis/src/hooks/useCancelRequest.ts:63-276` — CancelRequestHandler 全文（核心）
- `_refs/claude-code-analysis/src/hooks/useExitOnCtrlCD.ts:1-95` — Ctrl+C/D 双击退出
- `_refs/claude-code-analysis/src/hooks/useDoublePress.ts:1-62` — 800ms 双击实现
- `_refs/claude-code-analysis/src/screens/REPL.tsx:2106-2163` — REPL onCancel
- `_refs/claude-code-analysis/src/screens/REPL.tsx:4098-4104` — 'now' priority command 触发 'interrupt'
- `_refs/claude-code-analysis/src/utils/handlePromptSubmit.ts:319-332` — submit-during-running 触发 'interrupt'

### AbortController 工具
- `_refs/claude-code-analysis/src/utils/abortController.ts:16-99` — createAbortController + createChildAbortController（WeakRef）
- `_refs/claude-code-analysis/src/utils/combinedAbortSignal.ts:15-47` — createCombinedAbortSignal

### LLM Stream Idle Watchdog
- `_refs/claude-code-analysis/src/services/api/claude.ts:1510-1526` — releaseStreamResources
- `_refs/claude-code-analysis/src/services/api/claude.ts:1820-1836` — beta.messages.create({signal})
- `_refs/claude-code-analysis/src/services/api/claude.ts:1868-1928` — watchdog 完整实现
- `_refs/claude-code-analysis/src/services/api/claude.ts:1936-1965` — stall detection (30s, log only)
- `_refs/claude-code-analysis/src/services/api/claude.ts:2305-2335` — 退出时的 exit_delay_ms 测量
- `_refs/claude-code-analysis/src/services/api/claude.ts:2404-2462` — APIUserAbortError 处理（区分用户/SDK）
- `_refs/claude-code-analysis/src/services/api/client.ts:144` — SDK 顶层 timeout（600s）
- `_refs/claude-code-analysis/src/services/api/claude.ts:807-811` — non-streaming fallback timeout
- `_refs/claude-code-analysis/src/utils/idleTimeout.ts:1-53` — session-level idle (SDK 模式)

### Tool Abort
- `_refs/claude-code-analysis/src/Tool.ts:158-203, 407-416` — ToolUseContext.abortController + interruptBehavior
- `_refs/claude-code-analysis/src/services/tools/toolExecution.ts:337-490` — runToolUse + 预检查 abort
- `_refs/claude-code-analysis/src/services/tools/StreamingToolExecutor.ts:155-241, 300-405` — 并发 tool abort 协调
- `_refs/claude-code-analysis/src/utils/Shell.ts:181-345` — exec 把 abortSignal 传到 wrapSpawn
- `_refs/claude-code-analysis/src/utils/ShellCommand.ts:114-403` — ShellCommandImpl 全文（abort handler + treeKill）
- `_refs/claude-code-analysis/src/tools/BashTool/BashTool.tsx:624-921` — BashTool.call + runShellCommand
- `_refs/claude-code-analysis/src/tools/WebFetchTool/WebFetchTool.ts:208-299` — WebFetchTool.call
- `_refs/claude-code-analysis/src/tools/WebFetchTool/utils.ts:262-329` — getWithPermittedRedirects axios + signal

### Query Loop Abort 检查点
- `_refs/claude-code-analysis/src/query.ts:1011-1052` — streaming abort 路径（`'aborted_streaming'`）
- `_refs/claude-code-analysis/src/query.ts:1484-1516` — tool abort 路径（`'aborted_tools'`）
- `_refs/claude-code-analysis/src/query.ts:1046-1051, 1501-1505` — `'interrupt'` reason 不 yield interruption message

### Cross-reference
- `zhixing/research/source-analysis/claude-code/agent-loop.md:128-141` — Terminal reasons 与 abort 相关项
- `zhixing/research/source-analysis/claude-code/resilience.md:235-237` — **过时的 SSE watchdog 结论（已被本文修订）**
- `zhixing/research/source-analysis/claude-code/api-layer.md:67-77` — idle 看门狗（与本文 §2.2 一致）
