# OpenClaw — 中断与 Abort 传播机制分析

> **分析状态**: ✅ 已分析（2026-04-26）
>
> **分析范围**: 用户中断（SIGINT/Ctrl+C）→ stream 关闭 → tool abort 全链路；LLM idle-timeout watchdog；abort 多源汇聚；partial output 落库

## 模块定位

OpenClaw 没有"统一的可中断 stream agent loop"抽象。它把中断/abort 拆成 **5 个独立机制层叠**：客户端按键 → RPC 命令 → Gateway AbortController → attempt-level `runAbortController`（汇聚多源）→ 工具内部 `signal.aborted`。**没有 SIGINT 直接传到 chat run** —— Ctrl+C 经过 TUI 的双击哨兵 + RPC 中转，最终调用一个普通的 `AbortController.abort()`，所有下游清理都通过 AbortSignal 事件传播。LLM idle-timeout 是套在 streamFn 之上的独立 wrapper，触发后产生一个"看起来像普通 abort"的事件。

## 信息来源

| 来源 | 路径 | 可信度 |
|------|------|--------|
| TUI Ctrl+C / Esc 处理 | `src/tui/tui.ts` | ★★★★★（源码直读）|
| TUI session abort 入口 | `src/tui/tui-session-actions.ts` | ★★★★★ |
| Gateway abort 控制器存储与广播 | `src/gateway/chat-abort.ts` | ★★★★★ |
| Gateway chat.send/chat.abort 路由 | `src/gateway/server-methods/chat.ts` | ★★★★★ |
| Attempt 级 abort 汇聚（runAbortController） | `src/agents/pi-embedded-runner/run/attempt.ts` | ★★★★★ |
| LLM idle-timeout wrapper | `src/agents/pi-embedded-runner/run/llm-idle-timeout.ts` | ★★★★★（完整阅读）|
| 工具 abort signal 注入 | `src/agents/pi-tools.abort.ts` | ★★★★★ |
| Bash 工具 abort 行为 | `src/agents/bash-tools.exec.ts` | ★★★★★ |
| Bash 进程级 timeout/kill | `src/agents/bash-tools.exec-runtime.ts` | ★★★★★ |
| 全局 undici body/headers timeout | `src/infra/net/undici-global-dispatcher.ts` | ★★★★★ |
| OpenAI WS transport abort | `src/agents/openai-ws-stream.ts` | ★★★★☆ |
| OpenAI Responses transport abort | `src/agents/openai-transport-stream.ts` | ★★★★☆ |
| Abort 错误识别 | `src/agents/pi-embedded-runner/abort.ts`、`src/agents/failover-error.ts` | ★★★★★ |
| Sleep with abort 工具 | `src/infra/backoff.ts` | ★★★★★ |
| 文本型 abort 触发（messaging） | `src/auto-reply/reply/abort-primitives.ts` | ★★★★★ |
| Resilience 已有分析 | `research/source-analysis/openclaw/resilience.md` | ★★★★☆（已被本文超越的部分会标注）|

---

## 一、用户中断（SIGINT / Ctrl+C）链路

### 1.1 链路总览

```
[键盘]
   │
   │  按 Ctrl+C / Esc
   ▼
[TUI editor]
   │  editor.onCtrlC / editor.onEscape
   ▼
[handleCtrlC] ────► resolveCtrlCAction（双击哨兵）
   │                   │
   │                   ├─ 有输入 → 清空输入框，返回
   │                   ├─ 1s 内连按 → requestExit（process.exit(0)）
   │                   └─ 其它 → "press ctrl+c again to exit"
   │
   │  （Esc 跳过哨兵，直接 abortActive）
   ▼
[abortActive]
   │  client.abortChat({ sessionKey, runId })
   │  （TUI → gateway WebSocket RPC）
   ▼
[Gateway: "chat.abort" handler]
   │  abortChatRunById(ops, { runId, sessionKey, stopReason: "rpc" })
   │
   ├─► chatAbortControllers.get(runId).controller.abort()  ← 唯一发动机
   ├─► chatRunBuffers.get(runId)  ← 拿出 partial text
   ├─► broadcast({ state: "aborted", message: { text: partialText } })
   └─► persistAbortedPartials（如有 partial）
   │
   ▼  AbortSignal "abort" 事件
[Attempt: onAbort listener]
   │  abortRun(timeout, reason) →
   │     runAbortController.abort(reason)
   │     activeSession.abort()  ← Pi-Agent-Core SDK 关闭流
   │     activeSession.abortCompaction()  ← 若正在压缩
   │
   ▼
[底层 streamFn / 工具]
   通过 signal 传播；wrapToolWithAbortSignal 注入到每个工具的 execute(signal)
```

### 1.2 SIGINT 的真正归宿：仅用于退出 TUI 进程

OpenClaw 的 `process.on("SIGINT", ...)` 只在两处出现：

**TUI 进程**（`src/tui/tui.ts:910-917`）：

```typescript
const sigintHandler = () => {
  handleCtrlC();
};
const sigtermHandler = () => {
  requestExit();
};
process.on("SIGINT", sigintHandler);
process.on("SIGTERM", sigtermHandler);
```

注意 SIGINT 复用 `handleCtrlC`，所以**用户在 raw mode 下按 Ctrl+C 触发 `editor.onCtrlC`，操作系统层的 SIGINT 不会到达**（terminal raw mode 拦截了）。`process.on("SIGINT")` 是 raw mode 失效时的兜底。

**ACP server**（`src/acp/server.ts:110-111`）：

```typescript
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
```

ACP 的 SIGINT 只 graceful 关 gateway WebSocket，**不直接 abort 任何 chat run**。chat 是通过 ACP 自己的 `prompt.cancel` → `chat.abort` 路径中断的（见 `src/acp/translator.ts:786`）。

**关键发现**：Gateway server（daemon）本身**没有 SIGINT 处理 chat abort 的代码**。Daemon 进程被 SIGINT 时，所有进行中的 chat run 都通过 `process.exit` 强制结束，依赖 Node 的进程退出回收 fd / 子进程。这意味着 **chat abort 永远是显式的 RPC 请求**，没有"信号即中断"的捷径。

### 1.3 双击 Ctrl+C 哨兵

`resolveCtrlCAction`（`src/tui/tui.ts:163-186`）实现三态决策：

```typescript
export function resolveCtrlCAction(params: {
  hasInput: boolean;
  now: number;
  lastCtrlCAt: number;
  exitWindowMs?: number;
}): { action: CtrlCAction; nextLastCtrlCAt: number } {
  const exitWindowMs = Math.max(1, Math.floor(params.exitWindowMs ?? 1000));
  if (params.hasInput) {
    return { action: "clear", nextLastCtrlCAt: params.now };
  }
  if (params.now - params.lastCtrlCAt <= exitWindowMs) {
    return { action: "exit", nextLastCtrlCAt: params.lastCtrlCAt };
  }
  return { action: "warn", nextLastCtrlCAt: params.now };
}
```

| 输入状态 | 距上次 Ctrl+C | 行为 |
|---|---|---|
| 输入框有文字 | 任意 | 清空输入框（不会 abort 也不会 exit）|
| 输入框为空 | > 1000ms | 提示 "press ctrl+c again to exit" |
| 输入框为空 | ≤ 1000ms | `requestExit()` → `process.exit(0)` |

**Ctrl+C 默认不 abort 进行中的 LLM 流**——用户必须按 **Esc** 才能 abort 当前 run。`editor.onEscape`（`src/tui/tui.ts:784-791`）：

```typescript
editor.onEscape = () => {
  if (chatLog.hasVisibleBtw()) {
    chatLog.dismissBtw();
    tui.requestRender();
    return;
  }
  void abortActive();
};
```

这是 OpenClaw 与 Claude Code（Ctrl+C 直接中断）的显著差异。设计原因推测：messaging-channel 优先（OpenClaw 主战场是 IM 通道，TUI 是次要），所以"中断"语义更接近 IDE（Esc 中止编辑），而不是 shell（Ctrl+C 中止当前命令）。

### 1.4 中断的"传输面"：abortActive 走 RPC，不是本地句柄

`abortActive`（`src/tui/tui-session-actions.ts:377-394`）：

```typescript
const abortActive = async () => {
  if (!state.activeChatRunId) {
    chatLog.addSystem("no active run");
    tui.requestRender();
    return;
  }
  try {
    await client.abortChat({
      sessionKey: state.currentSessionKey,
      runId: state.activeChatRunId,
    });
    setActivityStatus("aborted");
  } catch (err) {
    chatLog.addSystem(`abort failed: ${String(err)}`);
    setActivityStatus("abort failed");
  }
  tui.requestRender();
};
```

TUI 不持有 attempt 级的 AbortController 句柄。它只知道 `runId`，通过 gateway WebSocket 发 `chat.abort` RPC。这意味着：

- TUI 进程崩了，正在跑的 chat 不会被 abort（gateway 那边的 `chatAbortControllers` 还在）
- TUI 离线一段时间再重连，可以发 abort 终止旧 run
- 多端协作场景：另一台机器/手机上的 webchat 客户端也能 abort 同一 run

### 1.5 Gateway 的 AbortController 注册与触发

**注册**（`src/gateway/server-methods/chat.ts:1559-1569`）发生在 `chat.send` handler：

```typescript
const abortController = new AbortController();
context.chatAbortControllers.set(clientRunId, {
  controller: abortController,
  sessionId: entry?.sessionId ?? clientRunId,
  sessionKey: rawSessionKey,
  startedAtMs: now,
  expiresAtMs: resolveChatRunExpiresAtMs({ now, timeoutMs }),
  ownerConnId: normalizeOptionalText(client?.connId),
  ownerDeviceId: normalizeOptionalText(client?.connect?.device?.id),
});
```

`abortController.signal` 被注入 `dispatchInboundMessage` 的 `replyOptions.abortSignal`（`src/gateway/server-methods/chat.ts:1741`），最终成为 attempt 的 `params.abortSignal`。

**触发**（`src/gateway/chat-abort.ts:76-108`）：

```typescript
export function abortChatRunById(
  ops: ChatAbortOps,
  params: { runId: string; sessionKey: string; stopReason?: string },
): { aborted: boolean } {
  const { runId, sessionKey, stopReason } = params;
  const active = ops.chatAbortControllers.get(runId);
  if (!active) return { aborted: false };
  if (active.sessionKey !== sessionKey) return { aborted: false };

  const bufferedText = ops.chatRunBuffers.get(runId);
  const partialText = bufferedText && bufferedText.trim() ? bufferedText : undefined;
  ops.chatAbortedRuns.set(runId, Date.now());
  active.controller.abort();                                  // ← 唯一一次 .abort() 调用
  ops.chatAbortControllers.delete(runId);
  ops.chatRunBuffers.delete(runId);
  ops.chatDeltaSentAt.delete(runId);
  ops.chatDeltaLastBroadcastLen.delete(runId);
  const removed = ops.removeChatRun(runId, runId, sessionKey);
  broadcastChatAborted(ops, { runId, sessionKey, stopReason, partialText });
  ops.agentRunSeq.delete(runId);
  if (removed?.clientRunId) {
    ops.agentRunSeq.delete(removed.clientRunId);
  }
  return { aborted: true };
}
```

**关键观察**：

1. abort 是**只能调用一次**的——controller 被 delete 后第二次 abort 找不到 entry，返回 `{ aborted: false }`
2. abort 同时回收 buffer / delta 时间戳 / sequence number 等所有相关状态
3. **partial text 优先广播给 UI** —— 用户看到"abort 时"AI 已经写到哪儿
4. 对应的 chat 状态被广播为 `state: "aborted"`，partialText 嵌在 message 中

### 1.6 文本型 abort：messaging 通道的"自然语言中断"

OpenClaw 还支持纯文本"stop / wait / abort / 停止 / やめて"作为 abort 触发（`src/auto-reply/reply/abort-primitives.ts:3-46`）：

```typescript
const ABORT_TRIGGERS = new Set([
  "stop", "esc", "abort", "wait", "exit", "interrupt",
  "detente", "deten", "detén", "arrete", "arrête",
  "停止", "やめて", "止めて", "रुको", "توقف",
  "стоп", "остановись", "останови", "остановить", "прекрати",
  "halt", "anhalten", "aufhören", "hoer auf", "stopp", "pare",
  "stop openclaw", "openclaw stop",
  "stop action", "stop current action",
  "stop run", "stop current run",
  "stop agent", "stop the agent",
  "stop don't do anything", "stop dont do anything",
  ...
]);
```

`isAbortRequestText()`（`src/auto-reply/reply/abort-primitives.ts:69-83`）将其归一化后匹配。这是给 IM 通道（WhatsApp / Telegram / 微信）用的——用户没法按 Esc，直接发"停止"就能中断。最终也走 `chat.abort` 路径。

### 1.7 stream 是怎么真正"被关掉"的

abort 触发后，`runAbortController.signal` 翻为 aborted。在 attempt.ts 中，**实际关闭 stream 的方式是 `void activeSession.abort()`**（`src/agents/pi-embedded-runner/run/attempt.ts:1276`）—— 这是 Pi-Agent-Core SDK 的 session 方法，由 SDK 内部决定：

- 关闭 fetch 的 ReadableStream
- 设置 `stopReason = "aborted"`
- 在下一次 `iterator.next()` 时抛 AbortError

OpenClaw 不直接关 socket，它委托给 SDK。但是**也准备了 fetch 层的兜底**（见下文 §2.3）。

底层 transport 层（pi-ai 的 streamSimple）也监听 abortSignal。例如 OpenAI Responses transport（`src/agents/openai-transport-stream.ts:685-697`）：

```typescript
if (options?.signal?.aborted) {
  throw new Error("Request was aborted");
}
if (output.stopReason === "aborted" || output.stopReason === "error") {
  throw new Error("An unknown error occurred");
}
stream.push({ type: "done", reason: output.stopReason as never, message: output as never });
stream.end();
} catch (error) {
  output.stopReason = options?.signal?.aborted ? "aborted" : "error";
  output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
  stream.push({ type: "error", reason: output.stopReason as never, error: output as never });
  stream.end();
}
```

OpenAI WebSocket transport（`src/agents/openai-ws-stream.ts:894-927`）同样监听 abort：

```typescript
await new Promise<void>((resolve, reject) => {
  const abortHandler = () => {
    cleanup();
    reject(new Error("aborted"));
  };
  if (signal?.aborted) {
    reject(new Error("aborted"));
    return;
  }
  signal?.addEventListener("abort", abortHandler, { once: true });

  const closeHandler = (code: number, reason: string) => {
    cleanup();
    // ...
  };
  session.manager.on("close", closeHandler);

  const cleanup = () => {
    signal?.removeEventListener("abort", abortHandler);
    session.manager.off("close", closeHandler);
    unsubscribe();
  };
  // ...
});
```

注意：abort 是**立即 reject**，不等任何 chunk 边界。WS 连接不会被关闭（manager 是复用的），只是当前的 `await` 退出。

### 1.8 abort 后"是否 chunk 边界 graceful"

**结论：不 graceful，立即生效。**

证据链：

1. attempt 中所有 await 都通过 `abortable()` 包装（`src/agents/pi-embedded-runner/run/attempt.ts:1281-1303`）：

```typescript
const abortable = <T>(promise: Promise<T>): Promise<T> => {
  const signal = runAbortController.signal;
  if (signal.aborted) {
    return Promise.reject(makeAbortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(makeAbortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
};
```

`abortable(activeSession.prompt(...))` 在 abort 触发瞬间就 reject 整个 prompt 调用，**不等 streamFn 自己处理完**。底层 SDK 还在跑，但被丢弃。

2. LLM idle-timeout 触发也是立即 reject 当前 `iterator.next()`（见 §2.1），不等 chunk。

3. partial text 通过 gateway 端的 `chatRunBuffers` 单独维护，不依赖 stream graceful close（见 §1.5）。

---

## 二、LLM Stream Idle-Timeout

### 2.1 核心实现（`llm-idle-timeout.ts`）

完整文件 119 行（`src/agents/pi-embedded-runner/run/llm-idle-timeout.ts`）。三个核心导出：

#### `DEFAULT_LLM_IDLE_TIMEOUT_MS = 60_000`（`llm-idle-timeout.ts:11`）

默认 60 秒无 chunk 视为 idle。

#### `resolveLlmIdleTimeoutMs(cfg)`（`llm-idle-timeout.ts:23-33`）

```typescript
export function resolveLlmIdleTimeoutMs(cfg?: OpenClawConfig): number {
  const raw = cfg?.agents?.defaults?.llm?.idleTimeoutSeconds;
  // 0 means disabled (no timeout)
  if (raw === 0) {
    return 0;
  }
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.floor(raw) * 1000, MAX_SAFE_TIMEOUT_MS);
  }
  return DEFAULT_LLM_IDLE_TIMEOUT_MS;
}
```

特别值约定：
- `idleTimeoutSeconds === 0` → 完全禁用（永不 timeout）
- 负数 / Infinity / 非数字 / 缺省 → 走默认 60s
- 上限 `MAX_SAFE_TIMEOUT_MS = 2_147_000_000`（约 24.8 天，即 setTimeout 32-bit 上限）

#### `streamWithIdleTimeout(baseFn, timeoutMs, onIdleTimeout?)`（`llm-idle-timeout.ts:44-119`）

包裹 streamFn，在每个 `iterator.next()` 时启动一个 `setTimeout(timeoutMs)` 与 `iterator.next()` 赛跑：

```typescript
return {
  async next() {
    clearTimer();
    try {
      // Race between the actual next() and the timeout
      const result = await Promise.race([iterator.next(), createTimeoutPromise()]);
      if (result.done) {
        clearTimer();
        return result;
      }
      clearTimer();
      return result;
    } catch (error) {
      clearTimer();
      throw error;
    }
  },

  return() {
    clearTimer();
    return iterator.return?.() ?? Promise.resolve({ done: true, value: undefined });
  },

  throw(error?: unknown) {
    clearTimer();
    return iterator.throw?.(error) ?? Promise.reject(error);
  },
};
```

`createTimeoutPromise`（`llm-idle-timeout.ts:59-69`）：

```typescript
const createTimeoutPromise = (): Promise<never> => {
  return new Promise((_, reject) => {
    idleTimer = setTimeout(() => {
      const error = new Error(
        `LLM idle timeout (${Math.floor(timeoutMs / 1000)}s): no response from model`,
      );
      onIdleTimeout?.(error);
      reject(error);
    }, timeoutMs);
  });
};
```

### 2.2 计时方式：每 chunk 重置

**这是 chunk-arrival idle timeout，不是 wall-clock total timeout。** 每收到一个 chunk（无论是 text_delta、thinking_delta、还是 toolcall_delta）`clearTimer()` 都会执行，下次 `next()` 重新挂表。这样：

- 30s 一直在快速 stream → 永远不 timeout
- 0s 收到 start，60s 后才到下一个 token → timeout 触发
- 10s 收到 1 个 chunk，再过 65s 才到下一个 → 第 75 秒 timeout

测试用例（`llm-idle-timeout.test.ts:122-141`）验证 "resets timer on each chunk"：

```typescript
it("resets timer on each chunk", async () => {
  const chunks = [{ text: "a" }, { text: "b" }, { text: "c" }];
  const mockStream = createMockAsyncIterable(chunks);
  const baseFn = vi.fn().mockReturnValue(mockStream);
  const wrapped = streamWithIdleTimeout(baseFn, 1000);
  // ...
  expect(results).toEqual(chunks);
});
```

### 2.3 触发后行为：转化为 abort（不重试、不 failover）

idle 触发后**不直接抛错给用户**，而是经过两层转换：

**第一步：onIdleTimeout 回调把 timeout 包装为 abort 信号**（`src/agents/pi-embedded-runner/run/attempt.ts:1127-1137`）：

```typescript
let idleTimeoutTrigger: ((error: Error) => void) | undefined;

if (idleTimeoutMs > 0) {
  activeSession.agent.streamFn = streamWithIdleTimeout(
    activeSession.agent.streamFn,
    idleTimeoutMs,
    (error) => idleTimeoutTrigger?.(error),
  );
}
```

**第二步：idleTimeoutTrigger 调用 abortRun(true, error)**（`src/agents/pi-embedded-runner/run/attempt.ts:1278-1280`）：

```typescript
idleTimeoutTrigger = (error) => {
  abortRun(true, error);
};
```

`abortRun(true, error)`（`src/agents/pi-embedded-runner/run/attempt.ts:1265-1277`）：

```typescript
const abortRun = (isTimeout = false, reason?: unknown) => {
  aborted = true;
  if (isTimeout) {
    timedOut = true;
  }
  if (isTimeout) {
    runAbortController.abort(reason ?? makeTimeoutAbortReason());
  } else {
    runAbortController.abort(reason);
  }
  abortCompaction();
  void activeSession.abort();
};
```

idle timeout 走的是 `isTimeout=true`，把原始 error 作为 abort reason 挂到 signal 上（`makeAbortError` 在 attempt.ts:1238-1250 会 unwrap）：

```typescript
const makeAbortError = (signal: AbortSignal): Error => {
  const reason = getAbortReason(signal);
  // If the reason is already an Error, preserve it to keep the original message
  // (e.g., "LLM idle timeout (60s): no response from model" instead of "aborted")
  if (reason instanceof Error) {
    const err = new Error(reason.message, { cause: reason });
    err.name = "AbortError";
    return err;
  }
  const err = reason ? new Error("aborted", { cause: reason }) : new Error("aborted");
  err.name = "AbortError";
  return err;
};
```

**第三步：外层 run.ts 看到 timedOut=true 后决定是否压缩重试**（`src/agents/pi-embedded-runner/run.ts:644-666`）：

```typescript
// ── Timeout-triggered compaction ──────────────────────────────────
// When the LLM times out with high context usage, compact before
// retrying to break the death spiral of repeated timeouts.
if (timedOut && !timedOutDuringCompaction) {
  // Only consider prompt-side tokens here. API totals include output
  // tokens, which can make a long generation look like high context
  // pressure even when the prompt itself was small.
  const lastTurnPromptTokens = derivePromptTokens(lastRunPromptUsage);
  const tokenUsedRatio =
    lastTurnPromptTokens != null && ctxInfo.tokens > 0
      ? lastTurnPromptTokens / ctxInfo.tokens
      : 0;
  if (timeoutCompactionAttempts >= MAX_TIMEOUT_COMPACTION_ATTEMPTS) {
    log.warn(...);
  } else if (tokenUsedRatio > 0.65) {
    timeoutCompactionAttempts++;
    log.warn(`[timeout-compaction] LLM timed out with high prompt token usage (${...}%); attempting compaction before retry`);
    // ...
  }
}
```

**关键点**：

1. idle timeout 不是 "errno"，它通过 abort 机制传播，下游不需要区别对待
2. 触发后不 failover 到别的模型；先看 prompt token 占比，>65% 才压缩重试，否则进 retry 循环
3. 最多 `MAX_TIMEOUT_COMPACTION_ATTEMPTS = 2` 次压缩尝试

### 2.4 与整体 timeout 的区别

OpenClaw 同时维护 **两个独立的 timeout**：

| 类型 | 实现位置 | 默认值 | 触发条件 | 行为 |
|---|---|---|---|---|
| Run 级整体 timeout | `attempt.ts:1363-1415` `scheduleAbortTimer` | 配置 `params.timeoutMs` | wall-clock 超过阈值 | abortRun(true) + compaction grace 延期 |
| LLM stream idle timeout | `attempt.ts:1127-1137` `streamWithIdleTimeout` | 60s | 距离上一个 chunk 超过阈值 | 等价 abortRun(true) |
| Compaction grace | `attempt.ts:1379` `scheduleAbortTimer(compactionTimeoutMs, "compaction-grace")` | 配置 | run 超时时若正在压缩，给一次延期 | 二次延期后才真 abort |
| 全局 fetch body/headers timeout | `infra/net/undici-global-dispatcher.ts:6` `DEFAULT_UNDICI_STREAM_TIMEOUT_MS = 30 * 60 * 1000` | 30 分钟 | undici socket 读写无活动 | TCP 层强制 reset |

**关系图**（数值上）：

```
run timeout (配置, 比如 600s)
└── compaction grace (配置, 比如 +60s)

llm idle timeout (60s, 独立计时器, 每 chunk 重置)

undici global (30min, 兜底, 几乎不会触发)
```

这三个机制**完全独立计时**，谁先到谁触发。idle timeout 是最频繁的实战兜底（gateway/rate limit/连接卡住时常见），run timeout 是上限闸门，undici 是 fetch 层最后兜底。

### 2.5 为什么用 stream wrapper 而不是 transport timeout

设计考虑（推断自代码组织）：

1. **不同 transport 行为不一致** —— anthropic-vertex / openai-ws / openai-responses 等各 provider transport 都有自己的连接池和 timeout 默认值，统一不了
2. **配置粒度需要在 attempt 级** —— per-config `idleTimeoutSeconds` 必须能被 attempt 看到
3. **复用 abort 机制** —— 把 idle 转 abort 一次，所有下游清理（tool kill、compaction abort、partial broadcast）都自动跑

代价是：**这是 streamFn 之上的纯 JS 计时器，不能感知 fetch 实际是否还在收 packet**。如果 OS TCP buffer 里堆了 65s 的数据但 JS 没读，idle timer 会误触发——这种情况下 undici 的 `bodyTimeout` 是更准的兜底。

---

## 三、Tool Call 的 Abort 传播

### 3.1 abortSignal 怎么进入工具内部

`createOpenClawCodingTools` 接受 `abortSignal` 参数（`src/agents/pi-tools.ts:271`）。在 tools-list 末尾用 `wrapToolWithAbortSignal` 把 signal 注入每个工具（`src/agents/pi-tools.ts:678-679`）：

```typescript
const withAbort = options?.abortSignal
  ? withHooks.map((tool) => wrapToolWithAbortSignal(tool, options.abortSignal))
  : withHooks;
```

`wrapToolWithAbortSignal`（`src/agents/pi-tools.abort.ts:48-72`）：

```typescript
export function wrapToolWithAbortSignal(
  tool: AnyAgentTool,
  abortSignal?: AbortSignal,
): AnyAgentTool {
  if (!abortSignal) {
    return tool;
  }
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  const wrappedTool: AnyAgentTool = {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const combined = combineAbortSignals(signal, abortSignal);
      if (combined?.aborted) {
        throwAbortError();
      }
      return await execute(toolCallId, params, combined, onUpdate);
    },
  };
  copyPluginToolMeta(tool, wrappedTool);
  copyChannelAgentToolMeta(tool as never, wrappedTool as never);
  return wrappedTool;
}
```

**关键设计**：

1. 工具 `execute` 已经从 SDK 拿到一个 `signal`（可能来自单 tool call 的取消），`wrapToolWithAbortSignal` **再合并** attempt 级 abortSignal，让工具看到的 `signal` 是两个的并集
2. 进入 `execute` 前先检查 `combined.aborted`，已经 abort 就直接抛 AbortError，不进 execute
3. `copyPluginToolMeta` / `copyChannelAgentToolMeta` 是为了不破坏插件元数据——这是个被反复踩坑后加的修补点

### 3.2 多源 abort 汇聚：`combineAbortSignals`

`src/agents/pi-tools.abort.ts:21-46`：

```typescript
function combineAbortSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a && !b) return undefined;
  if (a && !b) return a;
  if (b && !a) return b;
  if (a?.aborted) return a;
  if (b?.aborted) return b;
  if (typeof AbortSignal.any === "function" && isAbortSignal(a) && isAbortSignal(b)) {
    return AbortSignal.any([a, b]);
  }

  const controller = new AbortController();
  const onAbort = bindAbortRelay(controller);
  a?.addEventListener("abort", onAbort, { once: true });
  b?.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}
```

**关键设计**：

1. **优先用 `AbortSignal.any`**（Node 19.7+ / 现代浏览器原生支持）—— 自动管理 listener 生命周期、避免内存泄漏
2. **fallback 到手动 controller** —— 兼容老环境，但有内存泄漏风险（onAbort listener 没清理逻辑）
3. **`bindAbortRelay`**（`src/utils/fetch-timeout.ts:5-12`）用 `.bind()` 而非闭包：

```typescript
function relayAbort(this: AbortController) {
  this.abort();
}

export function bindAbortRelay(controller: AbortController): () => void {
  return relayAbort.bind(controller);
}
```

注释明确："Using .bind() avoids closure scope capture (memory leak prevention)."—— 这是踩过坑后的优化。

### 3.3 SDK 层的 signal 来源

`tool.execute(toolCallId, params, signal, onUpdate)` 中的 `signal` 由 Pi-Agent-Core 的 agent loop 提供。OpenClaw 没有 pi-agent-core 的源码（npm 包），但根据 OpenClaw 用法推断：

- pi-agent-core 内部维护了一个 per-attempt 的 AbortController
- 每次 `executeToolCalls` 调用时把 signal 透传给每个 tool.execute
- session.abort() 调用就是 abort 这个内部 controller

OpenClaw 通过 `wrapToolWithAbortSignal` 在外层再叠一层 attempt 级 controller（runAbortController），双源汇聚。这就是为什么 `combineAbortSignals` 必须存在的原因——SDK signal 和 OpenClaw signal 是两个独立的 source。

### 3.4 Bash 工具的 abort 行为：直接 SIGKILL

`src/agents/bash-tools.exec.ts:1563-1575`：

```typescript
// Tool-call abort should not kill backgrounded sessions; timeouts still must.
const onAbortSignal = () => {
  if (yielded || run.session.backgrounded) {
    return;
  }
  run.kill();
};

if (signal?.aborted) {
  onAbortSignal();
} else if (signal) {
  signal.addEventListener("abort", onAbortSignal, { once: true });
}
```

`run.kill()` 调用 `managedRun.cancel("manual-cancel")`（`src/agents/bash-tools.exec-runtime.ts:806-808`）：

```typescript
kill: () => {
  managedRun?.cancel("manual-cancel");
},
```

由 process supervisor 真正发送信号（SIGTERM/SIGKILL，根据 supervisor 实现）。**关键设计**：

1. **同步取消**——立即给进程发信号，不等命令完成
2. **背景化进程豁免**——如果工具调用已经 yield（命令进入 background queue），后续 abort 不杀该进程；用户必须显式用 `process kill` 工具
3. **timeout 不豁免**——backgrounded 与否的判断只对"用户/LLM abort"生效，timeout 还是杀

**timeout vs abort 是不同机制**（`src/agents/bash-tools.exec-runtime.ts:618-621`）：

```typescript
const timeoutMs =
  typeof opts.timeoutSec === "number" && opts.timeoutSec > 0
    ? Math.floor(opts.timeoutSec * 1000)
    : undefined;
```

timeout 通过 `supervisor.spawn({ ..., timeoutMs })` 传给进程 supervisor（`src/agents/bash-tools.exec-runtime.ts:709, 746`），由 supervisor 内部计时和 kill。**OpenClaw 这里的 per-tool timeout 与 attempt 级 abort 是两条独立链路，但都最终走 supervisor.kill**。Bash 默认 30 分钟（1800 秒，`src/agents/bash-tools.exec.ts:1180`）。

### 3.5 工具粒度的 abort 检查

不少工具在 execute 入口先检查 `signal.aborted`，例如 messaging tool（`src/agents/tools/message-tool.ts:678-684`）：

```typescript
execute: async (_toolCallId, args, signal) => {
  // Check if already aborted before doing any work
  if (signal?.aborted) {
    const err = new Error("Message send aborted");
    err.name = "AbortError";
    throw err;
  }
  // ...
}
```

这种 fast-path 在 abort 风暴时避免不必要的工作（特别是 messaging 这种有副作用的工具）。

### 3.6 工具 timeout 的另一种实现：fetch withTimeout

Web 类工具（如 web-shared）用一个 abort+timeout 合并工具`withTimeout`（`src/agents/tools/web-shared.ts:63-87`）：

```typescript
export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  if (timeoutMs <= 0) {
    return signal ?? new AbortController().signal;
  }
  const controller = new AbortController();
  const timer = setTimeout(controller.abort.bind(controller), timeoutMs);
  if (signal) {
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        controller.abort();
      },
      { once: true },
    );
  }
  controller.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
    },
    { once: true },
  );
  return controller.signal;
}
```

注意这里**没用 `AbortSignal.any`**——是更早期的实现风格。`fetch-timeout.ts:14-46` 的 `buildTimeoutAbortSignal` 也是同样的手写风格。两者都返回 `cleanup` 函数让调用方清理 timer。这与 §3.2 中 tool-level 的合并方式不一致——证明 OpenClaw 的 abort 机制是"按需修补"演化的，不是统一抽象。

---

## 四、关键设计模式

### 4.1 多源 abort 汇聚的两种方式并存

OpenClaw 实际有 **3 种不同**的多源 abort 合并实现：

| 位置 | 实现 | 优点 | 缺点 |
|---|---|---|---|
| `pi-tools.abort.ts:21-46` `combineAbortSignals` | 优先 `AbortSignal.any`，fallback 手写 | 现代浏览器零泄漏 | fallback 路径有泄漏 |
| `web-shared.ts:63-87` `withTimeout` | 手写 controller + bind/cleanup | 控制 timer 清理 | 不能合并多个 source signal |
| `fetch-timeout.ts:14-46` `buildTimeoutAbortSignal` | 手写 controller + cleanup | 显式 cleanup 函数 | 也只能单 source signal |

设计教训：当 `AbortSignal.any` 普及后（Node 19.7+），所有手写的 `controller + listener` 模式都可以替换掉，但 OpenClaw 没做这个统一重构。

### 4.2 abort reason 透传：把 timeout 装进 AbortError

attempt.ts 用一个 `makeAbortError` helper 把 abort reason 转成完整 Error（`src/agents/pi-embedded-runner/run/attempt.ts:1238-1250`）：

```typescript
const makeAbortError = (signal: AbortSignal): Error => {
  const reason = getAbortReason(signal);
  // If the reason is already an Error, preserve it to keep the original message
  // (e.g., "LLM idle timeout (60s): no response from model" instead of "aborted")
  if (reason instanceof Error) {
    const err = new Error(reason.message, { cause: reason });
    err.name = "AbortError";
    return err;
  }
  const err = reason ? new Error("aborted", { cause: reason }) : new Error("aborted");
  err.name = "AbortError";
  return err;
};
```

**为什么这么做**：用 `AbortController.abort(reason)` 把"为什么 abort"塞进 signal.reason；`getAbortReason` 把它取出来；如果 reason 是 Error 就用其 message，否则用 "aborted"。这样：

- LLM idle timeout 触发后，最终错误信息是 "LLM idle timeout (60s): no response from model"，而不是泛泛的 "aborted"
- yield 触发后，message 是 "sessions_yield" 字符串
- 用户 RPC abort 触发后，message 是 "aborted"

**配合 `isTimeoutError`**（`src/agents/failover-error.ts:179-196`）识别 abort 的本质类型：

```typescript
export function isTimeoutError(err: unknown): boolean {
  if (hasTimeoutHint(err)) return true;
  if (!err || typeof err !== "object") return false;
  if (readErrorName(err) !== "AbortError") return false;
  const message = getErrorMessage(err);
  if (message && ABORT_TIMEOUT_RE.test(message)) return true;
  const cause = "cause" in err ? (err as { cause?: unknown }).cause : undefined;
  const reason = "reason" in err ? (err as { reason?: unknown }).reason : undefined;
  return hasTimeoutHint(cause) || hasTimeoutHint(reason);
}
```

外层 retry 逻辑判断 timeout 与普通 abort 走完全不同的恢复路径（compaction vs 退出）。

### 4.3 attempt 内部的 abort 汇聚：所有 source 收敛到 runAbortController

attempt.ts 单独再起一个 `runAbortController = new AbortController()`（`src/agents/pi-embedded-runner/run/attempt.ts:304`），所有 source 都汇聚到它：

| Abort 源 | 触发路径 | 触发处 |
|---|---|---|
| 外部 RPC abort（Esc / chat.abort RPC） | params.abortSignal.addEventListener('abort', onAbort) → abortRun | `attempt.ts:1420-1442` |
| LLM idle timeout | streamWithIdleTimeout 回调 → abortRun(true, error) | `attempt.ts:1127-1137, 1278-1280` |
| Run wall-clock timeout | scheduleAbortTimer → abortRun(true) | `attempt.ts:1363-1416` |
| sessions_yield 工具调用 | onYield 回调 → runAbortController.abort("sessions_yield") | `attempt.ts:468-474` |
| Compaction failure（隐式） | runAbortController.abort(reason) 在 abortRun 中 | `attempt.ts:1265-1277` |

**关键设计**：所有 source 都流入同一个 controller，下游（streamFn / 工具 / abortable wrapper）只需要监听这一个 signal。这就是"多源汇聚"的 zhixing 意义上的标准模式——在 attempt 级别建立单一 ground truth。

### 4.4 Yield 是一种伪装成 abort 的"良性中断"

OpenClaw 的 `sessions_yield` 工具允许 agent 主动让出（用于多 agent 协作）。它通过 abort 机制实现，但被特殊识别：

`attempt.ts:468-474`：

```typescript
onYield: (message) => {
  yieldDetected = true;
  yieldMessage = message;
  queueYieldInterruptForSession?.();
  runAbortController.abort("sessions_yield");      // 用字符串作 reason
  abortSessionForYield?.();
},
```

abort reason 是字符串 `"sessions_yield"`。下游识别：

`attempt.ts:1077-1085`：

```typescript
activeSession.agent.streamFn = (model, context, options) => {
  const signal = runAbortController.signal as AbortSignal & { reason?: unknown };
  if (yieldDetected && signal.aborted && signal.reason === "sessions_yield") {
    return createYieldAbortedResponse(model) as unknown as Awaited<
      ReturnType<typeof innerStreamFn>
    >;
  }
  return innerStreamFn(model, context, options);
};
```

`attempt.ts:1665-1690`：

```typescript
} catch (err) {
  // Yield-triggered abort is intentional — treat as clean stop, not error.
  yieldAborted =
    yieldDetected &&
    isRunnerAbortError(err) &&
    err instanceof Error &&
    err.cause === "sessions_yield";
  if (yieldAborted) {
    aborted = false;        // 重置 aborted 标记！
    // ...
    stripSessionsYieldArtifacts(activeSession);
    if (yieldMessage) {
      await persistSessionsYieldContextMessage(activeSession, yieldMessage);
    }
  } else {
    promptError = err;
    promptErrorSource = "prompt";
  }
}
```

**关键洞察**：abort 不必是"用户/系统失败"，可以是"agent 主动 cooperative yield"。同一个 controller 通过 reason 区分语义。

### 4.5 partial output 的存放与广播

partial text 不在 attempt 内维护，而是在 **gateway 层独立维护**（`chatRunBuffers` Map）。abort 触发时：

`src/gateway/chat-abort.ts:93-102`：

```typescript
const bufferedText = ops.chatRunBuffers.get(runId);
const partialText = bufferedText && bufferedText.trim() ? bufferedText : undefined;
ops.chatAbortedRuns.set(runId, Date.now());
active.controller.abort();
ops.chatAbortControllers.delete(runId);
ops.chatRunBuffers.delete(runId);
ops.chatDeltaSentAt.delete(runId);
ops.chatDeltaLastBroadcastLen.delete(runId);
const removed = ops.removeChatRun(runId, runId, sessionKey);
broadcastChatAborted(ops, { runId, sessionKey, stopReason, partialText });
```

广播 payload 包含 partial 内容（`chat-abort.ts:64-71`）：

```typescript
message: partialText
  ? {
      role: "assistant",
      content: [{ type: "text", text: partialText }],
      timestamp: Date.now(),
    }
  : undefined,
```

外加 `persistAbortedPartials`（在 `chat.ts:1342-1360`）把 partial 落盘——abort 后用户回头看历史还能看到"中断时 AI 写到哪儿"。

**关键设计**：partial text 跟 attempt 解耦，由 gateway 在 stream 转发时累积。即使 attempt 进程崩了（OOM 等），partial 已经在 gateway 内存中。

### 4.6 finally 块的 abort cleanup 链

`attempt.ts:1882-1904`：

```typescript
} finally {
  clearTimeout(abortTimer);
  if (abortWarnTimer) {
    clearTimeout(abortWarnTimer);
  }
  if (!isProbeSession && (aborted || timedOut) && !timedOutDuringCompaction) {
    log.debug(`run cleanup: ...`);
  }
  try {
    unsubscribe();
  } catch (err) {
    log.error(`CRITICAL: unsubscribe failed, possible resource leak: runId=${params.runId} ${String(err)}`);
  }
  clearActiveEmbeddedRun(params.sessionId, queueHandle, params.sessionKey);
  params.abortSignal?.removeEventListener?.("abort", onAbort);
}
```

**关键观察**：

1. `abortSignal.removeEventListener` 必须显式调用——避免 attempt 结束后旧 listener 还挂着 controller
2. unsubscribe 失败被特殊标记为"CRITICAL: possible resource leak"——这是踩过资源泄漏后加的告警

外层还有 `flushPendingToolResultsAfterIdle`（`src/agents/pi-embedded-runner/wait-for-idle-before-flush.ts`）：

```typescript
export async function flushPendingToolResultsAfterIdle(opts: {
  agent: IdleAwareAgent | null | undefined;
  sessionManager: ToolResultFlushManager | null | undefined;
  timeoutMs?: number;
  clearPendingOnTimeout?: boolean;
}): Promise<void> {
  const timedOut = await waitForAgentIdleBestEffort(
    opts.agent,
    opts.timeoutMs ?? DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS,  // 30_000
  );
  if (timedOut && opts.clearPendingOnTimeout && opts.sessionManager?.clearPendingToolResults) {
    opts.sessionManager.clearPendingToolResults();
    return;
  }
  opts.sessionManager?.flushPendingToolResults?.();
}
```

abort 后等 SDK 30 秒进入 idle（防止 in-flight tool result 被 lost），再决定 flush 还是 clear。这是 pi-agent-core 的 race condition 修补（`attempt.ts:2025-2066` 处明确标注 "BUGFIX: Wait for the agent to be truly idle..."，引用了 issue #8643）。

### 4.7 abort 三层兜底：JS 计时 + SDK abort + 全局 fetch timeout

```
        请求开始
          │
   ┌──────┴──────┐
   │ JS 应用层    │  streamWithIdleTimeout（60s 默认）
   │ idle timer   │  触发 → abortRun → session.abort() → AbortError
   └──────┬──────┘
          │
   ┌──────┴──────┐
   │ SDK 层       │  pi-agent-core 内部 AbortController
   │ session.abort│  关闭 ReadableStream / 中止 fetch
   └──────┬──────┘
          │
   ┌──────┴──────┐
   │ 全局 fetch   │  undici Agent bodyTimeout/headersTimeout（30 分钟）
   │ socket 兜底   │  TCP 强制 reset
   └─────────────┘
```

`src/infra/net/undici-global-dispatcher.ts:6, 111-150`：

```typescript
export const DEFAULT_UNDICI_STREAM_TIMEOUT_MS = 30 * 60 * 1000;

export function ensureGlobalUndiciStreamTimeouts(opts?: { timeoutMs?: number }): void {
  // ...
  setGlobalDispatcher(
    new Agent({
      bodyTimeout: timeoutMs,
      headersTimeout: timeoutMs,
      ...(connect ? { connect } : {}),
    }),
  );
  // ...
}
```

attempt 启动时 `ensureGlobalUndiciStreamTimeouts()` 被无条件调用（`attempt.ts:307-308`）。这个 30 分钟兜底主要是为了防止"JS 计时器都失效"的极端情况（如 event loop 卡死）。日常场景永远是 idle timeout 先触发。

---

## 五、值得 zhixing 借鉴的细节

> 只列 OpenClaw 这样做的"非显然"细节，不写"我们应该"。

1. **`AbortSignal.any` + 手动 fallback 的双路径**（`pi-tools.abort.ts:37-45`）。新环境用原生零泄漏，老环境降级，这两套要在同一个 helper 里写齐。光用 `AbortSignal.any` 在 Node 18 / 旧浏览器上会运行时报错。

2. **`bindAbortRelay` 用 `.bind(controller)` 而不是闭包**（`utils/fetch-timeout.ts:5-12`）。注释明确："Using .bind() avoids closure scope capture (memory leak prevention)." 在长期运行的 daemon 中，每个 listener 都通过闭包捕获 controller 会让 controller 永生不死。这是个微小但累积致命的细节。

3. **abort reason 用 Error 实例 + cause 链**（`attempt.ts:1238-1250`）。`makeAbortError` 把 reason 的 message 提到 outer Error，但保留 cause 链以备深层判断。这样下游 logging 看到"LLM idle timeout (60s): no response from model"而不是"aborted"。

4. **多 source abort 收敛到 attempt-level controller**（`attempt.ts:304, 1265-1280, 1420-1442`）。LLM idle / wall-clock timeout / 用户 RPC / agent yield 全部塞进同一个 `runAbortController`，下游只 wire 一个 signal。这把"abort 的扇出"从 N 倒挂回 1。

5. **idle timeout 用 stream wrapper 而非 transport flag**（`llm-idle-timeout.ts:44-119`）。把 idle 检查放在 streamFn 之外（包装层）让它跨 provider 通用，而不依赖各 transport 提供 idle 配置。每个 `iterator.next()` 重置 timer 也比一次性 setTimeout 更准。

6. **partial text 在 gateway 维护，不在 attempt**（`chat-abort.ts:93-102`）。即使 attempt 进程崩了，partial 已在 gateway 内存中并已广播给客户端。abort 时立即 broadcast + persist 的双路径保证 UI 永远看到"AI 写到哪儿"。

7. **abort 后 30s wait-for-idle 再 flush tool results**（`wait-for-idle-before-flush.ts:43-58` + `attempt.ts:2025-2066` 的 BUGFIX 注释）。直接 flush 会与 in-flight 工具竞态，导致"虚假 missing tool result 错误"。这是踩过 #8643 后的修补。

8. **`makeTimeoutAbortReason` 用 `err.name = "TimeoutError"` 区分**（`attempt.ts:1233-1237`）。AbortError 太宽，TimeoutError 在 `isTimeoutError` 中作为快速识别路径。一个 abort 是 timeout 还是 user cancel，决定了下游是 retry 还是 surface error——这两条路径不能混。

9. **Bash backgrounded 进程在 abort 时不杀**（`bash-tools.exec.ts:1564-1569`）。命令 yield 进 background queue 后，后续 abort 不应该误杀；只有 timeout（per-command）能杀。这种"中断豁免"语义需要工具单独实现。

10. **`finally` 块里 `removeEventListener` 和 `clearTimeout` 双清理**（`attempt.ts:1882-1903`）。abort listener 不清理 = controller 泄漏；timer 不清理 = 进程不退出。daemon 长期运行下两者都是慢性死亡源。

---

## 六、不适合 zhixing 的部分

1. **5 层 abort 机制叠加（TUI / Gateway RPC / attempt / SDK / undici）**。OpenClaw 是 daemon 架构 + 多通道（IM、Web、TUI、ACP），所以 abort 必须经过 RPC 中转。zhixing 是单进程 CLI，应该 SIGINT 直接 abort 当前 attempt，不需要 chatAbortControllers Map / WebSocket 广播 / partial buffer 维护这些 daemon 概念。

2. **"自然语言 abort 触发"（`abort-primitives.ts`）**。给 messaging channel 用的"用户发'停止'就 abort"逻辑（含 30+ 多语言关键词）是 IM 场景特化，CLI/TUI 不需要——按 Esc 就够了。

3. **3 套手写 abort+timeout 合并实现并存**（`pi-tools.abort.ts` / `web-shared.ts` / `fetch-timeout.ts`）。OpenClaw 历史包袱，zhixing 起新项目应该统一在一个 helper（直接用 `AbortSignal.any` + `AbortSignal.timeout`，Node 19.7+ 已经原生支持）。

4. **Compaction grace period（abort 时若正在压缩则延期）**（`attempt.ts:1366-1380`）。这是为了避免"超时杀掉正在跑的压缩"导致下次 attempt 再溢出。zhixing 当前没有自动压缩，不需要这个 grace。

5. **sessions_yield 这种"良性 abort"语义**（`attempt.ts:468-474, 1665-1690`）。是 multi-agent 协作（一个 agent 把控制权交给另一个）的产物。zhixing 单 agent 模型不需要。

6. **30 分钟 undici 全局 timeout**（`undici-global-dispatcher.ts:6`）。这是给"daemon 进程跑几个月、JS event loop 偶尔卡死"的兜底；CLI 进程生命周期短，靠 idle timeout 和应用层 abort 就够了。

7. **TUI 双击 Ctrl+C 才 exit、Esc 才 abort**（`tui.ts:792-815`）。这是 IDE 风格设计；zhixing 用户期待的更可能是 Claude Code 风格（首次 Ctrl+C 中断 stream，二次 Ctrl+C 退出 REPL，类似 Python 风格）。借鉴双击哨兵思路，但触发的动作要换。

8. **partial text 在 gateway 层维护、abort 时广播**（`chat-abort.ts:93-102`）。CLI 直接 stdout 输出，partial 早已落屏，不需要单独 buffer + 广播 + persist 这一套。

9. **abort listener 走 process-wide event** 的理念（`abortChatRunsForSessionKey` 可以同时 abort 一个 sessionKey 下所有 runs）。zhixing 同一时间只跑一个 attempt，不需要按 sessionKey 批量 abort。

10. **chatAbortedRuns Map 记录"最近 abort 过"用于幂等去重**（`chat-abort.ts:95`）。这是因为 RPC 网络层可能重发；CLI 本地调用不会。
