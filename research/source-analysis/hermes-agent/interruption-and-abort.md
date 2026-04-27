# Hermes Agent — 中断与 Abort 传播机制分析

> **分析状态**: 已分析（2026-04-26）
>
> **分析范围**: 用户中断（SIGINT/Ctrl+C）→ stream 关闭 → tool abort 全链路；LLM idle/stale-timeout；Hermes 在 asyncio + 同步线程混合架构下的取消模型

## 模块定位

Hermes Agent 的中断与 abort 链路并不基于 `asyncio.CancelledError`，也不基于 `Task.cancel()` 把取消信号沿协程栈传播。它建立在两个底层原语上：
- 一个全局 `threading.Event`（`tools/interrupt.py` 的 `_interrupt_event`），由所有同步工具循环 polling；
- AIAgent 实例上的 `self._interrupt_requested: bool` 布尔位，由 agent 主循环和 streaming/non-streaming API 调用循环 polling。

`AIAgent.run_conversation()` 是同步阻塞函数，跑在线程池里（`asyncio.to_thread` / `loop.run_in_executor`）。所有"中断"本质是另一个线程把布尔位翻起来，然后 in-flight HTTP 客户端被强制关闭（`socket.shutdown(SHUT_RDWR)` 直接 reach into httpx transport 内部），生成器里的 `for chunk in stream:` 循环要么因为 socket close 抛异常，要么在下一次 polling 时主动 break。

整个机制是 cooperative + force-close 混合：cooperative 部分由各处 `if self._interrupt_requested: break` 实现；force-close 由 worker-local httpx client 的 socket 强关实现。

## 信息来源

| 来源 | 路径 | 可信度 |
|---|---|---|
| 中断核心原语 | `tools/interrupt.py` | 全文阅读 |
| Agent 中断主循环 | `run_agent.py:2540-2683`、`run_agent.py:7437-8160` | 直接引证 |
| 可中断 API 调用 | `run_agent.py:4318-4377` | 直接引证 |
| 可中断 streaming + stale watchdog | `run_agent.py:4428-4980` | 直接引证 |
| Force-close TCP 技巧 | `run_agent.py:3685-3741` | 直接引证 |
| CLI 端 Ctrl+C | `cli.py:7897-7980` | 直接引证 |
| CLI 端 SIGTERM/SIGHUP | `cli.py:8947-8985` | 直接引证 |
| Gateway SIGINT/SIGTERM | `gateway/run.py:7820-7829`、`1512-1569` | 直接引证 |
| Gateway 消息层中断 | `gateway/platforms/base.py:1340-1410`、`1640-1727` | 直接引证 |
| Gateway 端 inactivity watchdog | `gateway/run.py:7370-7488` | 直接引证 |
| Tool 端 polling 实现 | `tools/environments/base.py:369-420`、`tools/web_tools.py:1270-1310` | 直接引证 |
| Subprocess kill 行为 | `tools/environments/local.py:263-279` | 直接引证 |
| ACP 协议 cancel | `acp_adapter/server.py:310-319`、`388-389`、`466` | 直接引证 |
| ACP 入口 KeyboardInterrupt | `acp_adapter/entry.py:75-82` | 直接引证 |
| Stream consumer cancel | `gateway/stream_consumer.py:230-236` | 直接引证 |
| 已有项目分析（参考用）| `research/source-analysis/hermes-agent/persistent-service.md` | 不替代源码 |

> 行号皆来自 `E:/Dev/longxia/_refs/hermes-agent-main/`。`run_agent.py` 全文 9910 行；`gateway/run.py` 7900+ 行；`cli.py` 9000+ 行。三大入口都是单文件巨石，但内部行号定位精确。

## 一、用户中断（SIGINT / Ctrl+C）链路

### 1.1 三个独立的入口

Hermes 的"中断"不是一个统一的链路，而是**按运行形态分三套**：

| 入口 | 运行形态 | 触发源 | 触发方式 |
|---|---|---|---|
| `cli.py` REPL | 进程内交互 | 用户按 Ctrl+C | **prompt_toolkit KeyBinding**（`@kb.add('c-c')`），不是 OS 信号 |
| `cli.py` REPL | 进程外终止 | SSH 断开 / `kill -TERM` / `kill -HUP` | 裸 `signal.signal` 注册的 handler，转发为 `KeyboardInterrupt` |
| `gateway/run.py` 常驻 | 网关进程 | `kill -INT` / `kill -TERM` | `loop.add_signal_handler(SIGINT, ...)` |
| `acp_adapter/entry.py` ACP | 远端 IDE 调用 | IDE 发 ACP `cancel` RPC | RPC 处理函数手动 set `cancel_event` + `agent.interrupt()` |
| `acp_adapter/entry.py` ACP | 进程外 | `kill -INT` | `try/except KeyboardInterrupt` 包住 `asyncio.run()` |

也就是说，**Hermes 的 CLI 终端用户按下 Ctrl+C 时，OS 不会真正发 SIGINT 到进程**（或者说 prompt_toolkit 已经把终端切到 raw mode 拦截了 0x03 字节，不让它变成 SIGINT），而是被 prompt_toolkit 当成普通按键事件分发给 KeyBinding。

### 1.2 CLI 内 Ctrl+C：prompt_toolkit KeyBinding 路径

入口在 `cli.py:7897`：

```python
@kb.add('c-c')
def handle_ctrl_c(event):
    """Handle Ctrl+C - cancel interactive prompts, interrupt agent, or exit.

    Priority:
    0. Cancel active voice recording
    1. Cancel active sudo/approval/clarify prompt
    2. Interrupt the running agent (first press)
    3. Force exit (second press within 2s, or when idle)
    """
```

优先级层叠（`cli.py:7910-7980`）：

1. **录音状态** → 取消语音录制，`_recorder_ref.cancel()` 在后台线程跑（防止 CoreAudio/锁阻塞 prompt_toolkit 的 event loop）。
2. **sudo / secret / approval / clarify** 等模态输入状态 → 把"取消"信号塞进对应的 `response_queue`（`Queue.put`），让等待的工具线程读到一个 deny 值。
3. **agent 正在跑** + **2 秒内连按两次** → `_should_exit = True; event.app.exit()`，强制退出。
4. **agent 正在跑** + **首次按下** → `self._last_ctrl_c_time = now; self.agent.interrupt()`，soft interrupt。
5. **idle 状态** → buffer 里有文本就清空（类 bash 行为），全空才退出。

注意 4 和 3 的"双击 Ctrl+C 强退"语义。第一次按下是 soft interrupt，第二次（2 秒内）是 hard exit。`_last_ctrl_c_time` 是 monotonic 时间戳。

### 1.3 CLI 进程外信号：裸 signal.signal 路径

`cli.py:8947-8985`：

```python
def _signal_handler(signum, frame):
    """Handle SIGHUP/SIGTERM by triggering graceful cleanup."""
    logger.debug("Received signal %s, triggering graceful shutdown", signum)
    raise KeyboardInterrupt()

try:
    import signal as _signal
    _signal.signal(_signal.SIGTERM, _signal_handler)
    if hasattr(_signal, 'SIGHUP'):
        _signal.signal(_signal.SIGHUP, _signal_handler)
except Exception:
    pass  # Signal handlers may fail in restricted environments
```

这里**没有注册 SIGINT**——SIGINT 在 prompt_toolkit raw mode 下被拦截了（参见 1.1）。SIGTERM/SIGHUP 转译成 `KeyboardInterrupt`，由外层 try/except 捕获：

```python
try:
    with patch_stdout():
        ...
        app.run()
except (EOFError, KeyboardInterrupt, BrokenPipeError):
    pass
finally:
    self._should_exit = True
    # Flush memories before exit (only for substantial conversations)
    if self.agent and self.conversation_history:
        try:
            self.agent.flush_memories(self.conversation_history)
        except (Exception, KeyboardInterrupt):
            pass
    ...
```

注意 `flush_memories` 也用 `except (Exception, KeyboardInterrupt)` 兜底——防止用户连按 Ctrl+C 把"刷新 memory"这一步打断后引发未捕获异常。这是 Hermes 一个细微的鲁棒性设计：**关闭路径上的每一步都是双重 try/except，对再次到来的中断免疫。**

### 1.4 Gateway：loop.add_signal_handler 路径

`gateway/run.py:7820-7829`：

```python
runner = GatewayRunner(config)

# Set up signal handlers
def signal_handler():
    asyncio.create_task(runner.stop())

loop = asyncio.get_event_loop()
for sig in (signal.SIGINT, signal.SIGTERM):
    try:
        loop.add_signal_handler(sig, signal_handler)
    except NotImplementedError:
        pass
```

这是 Python asyncio 在 Unix 下的标准做法：`loop.add_signal_handler` 让 signal 在 event loop 安全的边界上被回调（用 self-pipe / signalfd 实现），而不是在任意 C 栈帧里中断 Python interpreter。Windows 不支持，所以包了 `try/except NotImplementedError`。

`runner.stop()` 内部（`gateway/run.py:1512-1569`）：

```python
async def stop(self) -> None:
    """Stop the gateway and disconnect all adapters."""
    logger.info("Stopping gateway...")
    self._running = False

    for session_key, agent in list(self._running_agents.items()):
        if agent is _AGENT_PENDING_SENTINEL:
            continue
        try:
            agent.interrupt("Gateway shutting down")
            ...
```

**关键设计**：`runner.stop()` 先 `agent.interrupt("Gateway shutting down")` 让所有跑在线程池里的 AIAgent 主动结束，再 `adapter.cancel_background_tasks()` cancel 所有 `asyncio.create_task` 创建的消息处理任务，最后 `disconnect()` 各平台连接。

`adapter.cancel_background_tasks()`（`gateway/platforms/base.py:1712-1727`）：

```python
async def cancel_background_tasks(self) -> None:
    """Cancel any in-flight background message-processing tasks."""
    tasks = [task for task in self._background_tasks if not task.done()]
    for task in tasks:
        self._expected_cancelled_tasks.add(task)
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    self._background_tasks.clear()
    self._expected_cancelled_tasks.clear()
    self._pending_messages.clear()
    self._active_sessions.clear()
```

注意：`task.cancel()` 抛 `CancelledError` 到 `_process_message_background`，**但这只能 cancel 那个 async 协程包装层**——里面的 `loop.run_in_executor(_executor, run_sync)` 把 `agent.run_conversation()` 派给了线程池，被 cancel 的 future 不会强行 kill 线程，只是放弃等待。所以才需要前面那一步先 `agent.interrupt()` 让线程内部主动停。

`_expected_cancelled_tasks` set 用来区分"被预期取消"和"异常取消"——前者不上报为 failure（`gateway/platforms/base.py:1668-1674`）。

### 1.5 ACP：协议级 cancel RPC

`acp_adapter/server.py:310-319`：

```python
async def cancel(self, session_id: str, **kwargs: Any) -> None:
    state = self.session_manager.get_session(session_id)
    if state and state.cancel_event:
        state.cancel_event.set()
        try:
            if getattr(state, "agent", None) and hasattr(state.agent, "interrupt"):
                state.agent.interrupt()
        except Exception:
            logger.debug("Failed to interrupt ACP session %s", session_id, exc_info=True)
        logger.info("Cancelled session %s", session_id)
```

ACP（Agent Client Protocol，用于 IDE 集成）每个 session 有自己的 `cancel_event: threading.Event`（`acp_adapter/session.py:67`），编辑器可以发 cancel RPC，server 同时 set 这个 event 并调 `agent.interrupt()`。

`prompt()` 完成后用 `cancel_event` 推断 stop_reason（`acp_adapter/server.py:466`）：

```python
stop_reason = "cancelled" if state.cancel_event and state.cancel_event.is_set() else "end_turn"
```

ACP 入口 `acp_adapter/entry.py:75-82` 还有传统的 `KeyboardInterrupt` 兜底：

```python
try:
    asyncio.run(acp.run_agent(agent, use_unstable_protocol=True))
except KeyboardInterrupt:
    logger.info("Shutting down (KeyboardInterrupt)")
```

### 1.6 `agent.interrupt()` 的传播链

无论从哪个入口进来，最终都会调到 `AIAgent.interrupt()`（`run_agent.py:2540-2577`）：

```python
def interrupt(self, message: str = None) -> None:
    """
    Request the agent to interrupt its current tool-calling loop.

    Call this from another thread (e.g., input handler, message receiver)
    to gracefully stop the agent and process a new message.

    Also signals long-running tool executions (e.g. terminal commands)
    to terminate early, so the agent can respond immediately.
    """
    self._interrupt_requested = True
    self._interrupt_message = message
    # Signal all tools to abort any in-flight operations immediately
    _set_interrupt(True)
    # Propagate interrupt to any running child agents (subagent delegation)
    with self._active_children_lock:
        children_copy = list(self._active_children)
    for child in children_copy:
        try:
            child.interrupt(message)
        except Exception as e:
            logger.debug("Failed to propagate interrupt to child agent: %s", e)
```

三件事：

1. 把 `self._interrupt_requested` 翻成 True（这个 agent 实例的本地标志，主循环 polling）。
2. 把全局 `tools.interrupt._interrupt_event` set 起来（所有 tool 实现 polling 的全局位）。
3. 递归对所有子 agent（`_active_children`，由 `delegate_task` 工具创建）调 `interrupt()`。

注意：`interrupt()` **本身不抛异常**、**不释放锁**、**不关闭 socket**，只是设置布尔位。实际"破坏"动作由各处 polling 循环 + force-close socket 完成。

`clear_interrupt()`（`run_agent.py:2579-2583`）相反：把布尔位归零，把全局 event clear。在每次 turn 完成或 interrupt 处理完后调用。

### 1.7 输入排队：busy_input_mode

CLI 在 agent 跑的时候有两种用户输入模式（`cli.py:1525-1526`）：

- `busy_input_mode = "interrupt"`（默认）：用户按 Enter 提交时直接调 `agent.interrupt(text)`，把新消息作为 interrupt 触发。
- `busy_input_mode = "queue"`：把 Enter 提交的文本塞 `_pending_input`，等当前 turn 自然结束。

两个 queue 严格分开（`cli.py:7631-7632`）：

```python
self._pending_input = queue.Queue()     # For normal input (commands + new queries)
self._interrupt_queue = queue.Queue()   # For messages typed while agent is running
```

`chat()` 主循环（`cli.py:7138-7163`）在 agent 跑的时候 100ms 周期 poll `_interrupt_queue`：

```python
while agent_thread.is_alive():
    if hasattr(self, '_interrupt_queue'):
        try:
            interrupt_msg = self._interrupt_queue.get(timeout=0.1)
            if interrupt_msg:
                ...
                print("\n⚡ New message detected, interrupting...")
                # Signal TTS to stop on interrupt
                if stop_event is not None:
                    stop_event.set()
                self.agent.interrupt(interrupt_msg)
                ...
```

interrupt 完成后，`pending_message` 会被回写到 `_pending_input` 让下一轮 turn 处理（`cli.py:7324-7345`）：

```python
if pending_message and hasattr(self, '_pending_input'):
    all_parts = [pending_message]
    while not self._interrupt_queue.empty():
        try:
            extra = self._interrupt_queue.get_nowait()
            if extra:
                all_parts.append(extra)
        except queue.Empty:
            break
    combined = "\n".join(all_parts)
    ...
    self._pending_input.put(combined)
```

也就是说：被 interrupt 的消息不会丢——会在 agent 完成 cleanup 后立即作为下一条 user message 重新排入主队列。

### 1.8 Gateway 端的"新消息触发 interrupt"

Gateway 用类似机制：当一个 session 已有活跃 agent，新消息到达时（`gateway/platforms/base.py:1393-1398`）：

```python
# Default behavior for non-photo follow-ups: interrupt the running agent
logger.debug("[%s] New message while session %s is active — triggering interrupt", self.name, session_key)
self._pending_messages[session_key] = event
# Signal the interrupt (the processing task checks this)
self._active_sessions[session_key].set()
return  # Don't process now - will be handled after current task finishes
```

注意此处 `self._active_sessions[session_key]` 是个 `asyncio.Event`，**用于通知 async 协程层**——不是直接调 `agent.interrupt()`。Gateway 真正调 `agent.interrupt()` 的地方在 `gateway/run.py:1980-1992`（处理 `/stop` 命令时）和 `gateway/run.py:1517-1521`（gateway 关闭时）。

照片连拍是特殊情况（`gateway/platforms/base.py:1378-1391`）——Telegram 的相册会拆成多条消息几乎同时到，不能让每张照片都触发 interrupt，而是在 `_pending_messages` 里 merge，等当前 turn 完成后一起投。

## 二、LLM Stream Idle-Timeout

**Hermes 实现了完整的 stream idle/stale timeout 机制。** 整体可分为三层 timeout：

| Timeout 层 | 类型 | 默认值 | 作用 |
|---|---|---|---|
| `HERMES_STREAM_READ_TIMEOUT` | httpx 层 | 120 s（local provider 自动放大到 1800 s） | 任意 chunk 之间最大等待，由 httpx 在 socket level 抛 `ReadTimeout` |
| `HERMES_STREAM_STALE_TIMEOUT` | 应用层 watchdog | 180 s（context 大时分级到 240/300 s） | 判定"虽然连接活着但没真实数据"，主动 close socket 触发 retry |
| `HERMES_AGENT_TIMEOUT` | gateway 层 | 1800 s（30 min idle） | gateway poll agent 的 activity tracker，超时强行 interrupt |

### 2.1 httpx 层：read timeout（chunk-arrival timeout）

`run_agent.py:4477-4499`：

```python
def _call_chat_completions():
    """Stream a chat completions response."""
    import httpx as _httpx
    _base_timeout = float(os.getenv("HERMES_API_TIMEOUT", 1800.0))
    _stream_read_timeout = float(os.getenv("HERMES_STREAM_READ_TIMEOUT", 120.0))
    # Local providers (Ollama, llama.cpp, vLLM) can take minutes for
    # prefill on large contexts before producing the first token.
    # Auto-increase the httpx read timeout unless the user explicitly
    # overrode HERMES_STREAM_READ_TIMEOUT.
    if _stream_read_timeout == 120.0 and self.base_url and is_local_endpoint(self.base_url):
        _stream_read_timeout = _base_timeout
        logger.debug(
            "Local provider detected (%s) — stream read timeout raised to %.0fs",
            self.base_url, _stream_read_timeout,
        )
    stream_kwargs = {
        **api_kwargs,
        "stream": True,
        "stream_options": {"include_usage": True},
        "timeout": _httpx.Timeout(
            connect=30.0,
            read=_stream_read_timeout,
            write=_base_timeout,
            pool=30.0,
        ),
    }
```

httpx 的 read timeout 是**两个连续 socket recv 之间的最大间隔**，所以这层 timeout 实际就是 chunk-arrival idle timeout。注意四个细分：

- `connect=30.0` 建连超时
- `read=120.0` chunk 间超时
- `write=1800.0` 写请求体超时（正常很快，1800 是兜底）
- `pool=30.0` 从 connection pool 拿连接超时

Anthropic 对应的是 `agent/anthropic_adapter.py:246`：

```python
kwargs = {
    "timeout": Timeout(timeout=900.0, connect=10.0),
}
```

### 2.2 应用层 stale watchdog

光靠 httpx 还不够：很多代理（OpenRouter, llm gateway）会发 SSE keep-alive ping（注释或 retry 字段），这些 ping 让 socket recv 持续返回数据但没有真实 token，httpx 的 read timeout 永远不会触发。Hermes 在外层加了一个 watchdog（`run_agent.py:4881-4940`）：

```python
_stream_stale_timeout_base = float(os.getenv("HERMES_STREAM_STALE_TIMEOUT", 180.0))
# Local providers (Ollama, oMLX, llama-cpp) can take 300+ seconds
# for prefill on large contexts.  Disable the stale detector unless
# the user explicitly set HERMES_STREAM_STALE_TIMEOUT.
if _stream_stale_timeout_base == 180.0 and self.base_url and is_local_endpoint(self.base_url):
    _stream_stale_timeout = float("inf")
    ...
else:
    # Scale the stale timeout for large contexts: slow models (like Opus)
    # can legitimately think for minutes before producing the first token
    # when the context is large.  Without this, the stale detector kills
    # healthy connections during the model's thinking phase, producing
    # spurious RemoteProtocolError ("peer closed connection").
    _est_tokens = sum(len(str(v)) for v in api_kwargs.get("messages", [])) // 4
    if _est_tokens > 100_000:
        _stream_stale_timeout = max(_stream_stale_timeout_base, 300.0)
    elif _est_tokens > 50_000:
        _stream_stale_timeout = max(_stream_stale_timeout_base, 240.0)
    else:
        _stream_stale_timeout = _stream_stale_timeout_base

t = threading.Thread(target=_call, daemon=True)
t.start()
while t.is_alive():
    t.join(timeout=0.3)

    # Detect stale streams: connections kept alive by SSE pings
    # but delivering no real chunks.  Kill the client so the
    # inner retry loop can start a fresh connection.
    _stale_elapsed = time.time() - last_chunk_time["t"]
    if _stale_elapsed > _stream_stale_timeout:
        ...
        try:
            rc = request_client_holder.get("client")
            if rc is not None:
                self._close_request_openai_client(rc, reason="stale_stream_kill")
        except Exception:
            pass
        # Rebuild the primary client too — its connection pool
        # may hold dead sockets from the same provider outage.
        try:
            self._replace_primary_openai_client(reason="stale_stream_pool_cleanup")
        except Exception:
            pass
        # Reset the timer so we don't kill repeatedly while
        # the inner thread processes the closure.
        last_chunk_time["t"] = time.time()
```

`last_chunk_time["t"]` 在每次 stream chunk 到达时被更新（`run_agent.py:4530, 4707`）：

```python
for chunk in stream:
    last_chunk_time["t"] = time.time()
    ...
```

watchdog 触发后**不抛异常**、**不让 stream 自然结束**，而是：

1. 调 `_close_request_openai_client(rc, reason="stale_stream_kill")` 关闭这个 worker-local httpx client。关闭的 socket 会让生成器 `for chunk in stream:` 抛 `RemoteProtocolError` 或 `httpx.ReadTimeout`。
2. 调 `_replace_primary_openai_client` 重建主 client，因为 connection pool 里可能有同一个 provider 的死连接。
3. reset timer。

异常被内层 `_call()` 的 try/except 捕获（`run_agent.py:4767-4848`）：

```python
except Exception as e:
    if deltas_were_sent["yes"]:
        # Streaming failed AFTER some tokens were already
        # delivered.  Don't retry or fall back — partial
        # content already reached the user.
        logger.warning(
            "Streaming failed after partial delivery, not retrying: %s", e
        )
        result["error"] = e
        return

    _is_timeout = isinstance(
        e, (_httpx.ReadTimeout, _httpx.ConnectTimeout, _httpx.PoolTimeout)
    )
    _is_conn_err = isinstance(
        e, (_httpx.ConnectError, _httpx.RemoteProtocolError, ConnectionError)
    )
    ...
    if _is_timeout or _is_conn_err or _is_sse_conn_err:
        # Transient network / timeout error. Retry the
        # streaming request with a fresh connection first.
        if _stream_attempt < _max_stream_retries:
            ...
            continue
```

注意一个非常微妙的设计：**如果已经有 token 通过 stream callback 投递给用户/平台，绝不重试也不回退到非 streaming**——避免重复消息（重发会让用户看到两份）。`deltas_were_sent["yes"]` 用一个可变 dict 在闭包里追踪。这是 Hermes 比朴素 retry 模式精细的地方。

### 2.3 Gateway 层 inactivity watchdog

Gateway 上每个 agent run 有一个独立的 inactivity 检测（`gateway/run.py:7376-7488`）：

```python
_agent_timeout_raw = float(os.getenv("HERMES_AGENT_TIMEOUT", 1800))
_agent_timeout = _agent_timeout_raw if _agent_timeout_raw > 0 else None
_agent_warning_raw = float(os.getenv("HERMES_AGENT_TIMEOUT_WARNING", 900))
_agent_warning = _agent_warning_raw if _agent_warning_raw > 0 else None
_warning_fired = False
loop = asyncio.get_event_loop()
_executor_task = asyncio.ensure_future(
    loop.run_in_executor(None, run_sync)
)

_inactivity_timeout = False
_POLL_INTERVAL = 5.0

if _agent_timeout is None:
    # Unlimited — just await the result.
    response = await _executor_task
else:
    # Poll loop: check the agent's built-in activity tracker
    # (updated by _touch_activity() on every tool call, API
    # call, and stream delta) every few seconds.
    response = None
    while True:
        done, _ = await asyncio.wait(
            {_executor_task}, timeout=_POLL_INTERVAL
        )
        if done:
            response = _executor_task.result()
            break
        # Agent still running — check inactivity.
        _agent_ref = agent_holder[0]
        _idle_secs = 0.0
        if _agent_ref and hasattr(_agent_ref, "get_activity_summary"):
            try:
                _act = _agent_ref.get_activity_summary()
                _idle_secs = _act.get("seconds_since_activity", 0.0)
            except Exception:
                pass
        # Staged warning: fire once before escalating to full timeout.
        if (not _warning_fired and _agent_warning is not None
                and _idle_secs >= _agent_warning):
            _warning_fired = True
            ...
            await _warn_adapter.send(
                source.chat_id,
                f"⚠️ No activity for {_elapsed_warn} min. ...",
            )
        if _idle_secs >= _agent_timeout:
            _inactivity_timeout = True
            break
```

要点：

- 不是 wall-clock timeout，是 **inactivity timeout**——`_touch_activity()` 在每次 tool 调用、API 调用、stream delta 时更新（参见 `run_agent.py:2585-2588` 和很多 `self._touch_activity(...)` 调用点）。
- **分级警告**：到达 50% 阈值（`HERMES_AGENT_TIMEOUT_WARNING=900`）时给用户发一条提醒消息"⚠️ No activity for X min...."，给用户在硬超时前手动 `/reset` 的机会。
- 触发后也是调 `_timed_out_agent.interrupt("Execution timed out (inactivity)")`（`run_agent.py:7462-7463`），不是 `Task.cancel()`。这呼应了 1.6 的设计——所有路径最终都收敛到 `interrupt()`。

### 2.4 三层 timeout 之间的关系

| 触发顺序（短延时 → 长延时） | 行为 |
|---|---|
| chunk read 间隔 > 120s（默认） | httpx 抛 ReadTimeout → 内层重试 ≤ 2 次 |
| chunk 间持续有 SSE ping 但无真实 token > 180s | watchdog force-close socket → 走和上面同样的重试路径 |
| Agent 完全静默（无 API、无 tool）> 30 min | gateway 调 `agent.interrupt()` 让线程退出 |

三层是分工互补：httpx 处理"socket 真死了"，watchdog 处理"socket 假活着但没数据"，gateway 处理"agent 自己卡死了（如死循环、tool 内部 hung）"。

### 2.5 检索证据：搜过的关键词

为了确认没有遗漏，搜过：
- `asyncio.wait_for` / `asyncio.timeout` / `asyncio.shield` — 16 个文件，绝大多数在 mcp_tool.py 和 web_tools.py 的工具内部 timeout，非 LLM stream 路径。
- `idle_timeout` / `stale` / `watchdog` — 主要命中 `_stream_stale_timeout` 和 gateway inactivity 路径，已覆盖。
- `HERMES_STREAM` 环境变量 — 三个：`STREAM_READ_TIMEOUT`、`STREAM_STALE_TIMEOUT`、`STREAM_RETRIES`，全部用于本节描述的机制。

## 三、Tool Call 的 Abort 传播

### 3.1 总体模型：cooperative polling

Tool 端**不接收 cancel 信号**，而是**主动 polling** 全局 `_interrupt_event`：

```python
# tools/interrupt.py — 全文
import threading

_interrupt_event = threading.Event()

def set_interrupt(active: bool) -> None:
    """Called by the agent to signal or clear the interrupt."""
    if active:
        _interrupt_event.set()
    else:
        _interrupt_event.clear()

def is_interrupted() -> bool:
    """Check if an interrupt has been requested. Safe to call from any thread."""
    return _interrupt_event.is_set()
```

任何 tool 实现都按这个模式：

```python
from tools.interrupt import is_interrupted
if is_interrupted():
    return {"output": "[interrupted]", "returncode": 130}
```

返回 130 是 Unix `128 + SIGINT(2)` 的约定，表示"被 SIGINT 终止"。

### 3.2 主循环的两层 pre-flight 检查

`run_agent.py:6577-6593` 在串行执行 tool calls 前（`_execute_tool_calls_sequential`）：

```python
def _execute_tool_calls_sequential(self, assistant_message, messages: list, ...):
    """Execute tool calls sequentially (original behavior). Used for single calls or interactive tools."""
    for i, tool_call in enumerate(assistant_message.tool_calls, 1):
        # SAFETY: check interrupt BEFORE starting each tool.
        # If the user sent "stop" during a previous tool's execution,
        # do NOT start any more tools -- skip them all immediately.
        if self._interrupt_requested:
            remaining_calls = assistant_message.tool_calls[i-1:]
            if remaining_calls:
                self._vprint(f"{self.log_prefix}⚡ Interrupt: skipping {len(remaining_calls)} tool call(s)", force=True)
            for skipped_tc in remaining_calls:
                skipped_name = skipped_tc.function.name
                skip_msg = {
                    "role": "tool",
                    "content": f"[Tool execution cancelled — {skipped_name} was skipped due to user interrupt]",
                    "tool_call_id": skipped_tc.id,
                }
                messages.append(skip_msg)
            break
```

并在每个 tool 完成后还有一次 post-check（`run_agent.py:6868-6879`）：

```python
if self._interrupt_requested and i < len(assistant_message.tool_calls):
    remaining = len(assistant_message.tool_calls) - i
    self._vprint(f"{self.log_prefix}⚡ Interrupt: skipping {remaining} remaining tool call(s)", force=True)
    for skipped_tc in assistant_message.tool_calls[i:]:
        skipped_name = skipped_tc.function.name
        skip_msg = {
            "role": "tool",
            "content": f"[Tool execution skipped — {skipped_name} was not started. User sent a new message]",
            "tool_call_id": skipped_tc.id
        }
        messages.append(skip_msg)
    break
```

注意：被跳过的 tool **依然会写一条 fake tool result message**（`role: tool`, `content: [Tool execution cancelled ...]`）。这是 OpenAI tool-calling 协议的硬性要求——如果 assistant 请求了 N 个 tool，下一轮必须有对应 N 个 tool result，否则模型会拒绝。Hermes 用占位 message 满足协议要求，让 history 保持有效。

主循环开头还有一次（`run_agent.py:7441-7447`）：

```python
while api_call_count < self.max_iterations and self.iteration_budget.remaining > 0:
    ...
    # Check for interrupt request (e.g., user sent new message)
    if self._interrupt_requested:
        interrupted = True
        _turn_exit_reason = "interrupted_by_user"
        if not self.quiet_mode:
            self._safe_print("\n⚡ Breaking out of tool loop due to interrupt...")
        break
```

加上 streaming 内部的 `if self._interrupt_requested: break`（`run_agent.py:4535-4536`、`4709-4710`），整个 turn 周期里 interrupt 检查点遍布——基本保证最坏情况下的延迟不会超过：
- 一次 chunk 到达（streaming 中）
- 一个 tool 完成（tool 之间）
- 200ms（subprocess polling）
- 100ms（CLI 监控 `_interrupt_queue`）

### 3.3 Subprocess 工具：terminal_tool 的 SIGTERM/SIGKILL 升级

`tools/environments/base.py:369-420`，这是所有后端（local/docker/ssh/modal/...）共享的 subprocess 等待逻辑：

```python
def _wait_for_process(self, proc: ProcessHandle, timeout: int = 120) -> dict:
    """Poll-based wait with interrupt checking and stdout draining.

    Shared across all backends — not overridden.
    """
    output_chunks: list[str] = []

    def _drain():
        try:
            for line in proc.stdout:
                output_chunks.append(line)
        except UnicodeDecodeError:
            output_chunks.clear()
            output_chunks.append(
                "[binary output detected — raw bytes not displayable]"
            )
        except (ValueError, OSError):
            pass

    drain_thread = threading.Thread(target=_drain, daemon=True)
    drain_thread.start()
    deadline = time.monotonic() + timeout

    while proc.poll() is None:
        if is_interrupted():
            self._kill_process(proc)
            drain_thread.join(timeout=2)
            return {
                "output": "".join(output_chunks) + "\n[Command interrupted]",
                "returncode": 130,
            }
        if time.monotonic() > deadline:
            self._kill_process(proc)
            drain_thread.join(timeout=2)
            partial = "".join(output_chunks)
            timeout_msg = f"\n[Command timed out after {timeout}s]"
            return {
                "output": partial + timeout_msg
                if partial
                else timeout_msg.lstrip(),
                "returncode": 124,
            }
        time.sleep(0.2)

    drain_thread.join(timeout=5)
    ...
```

**polling 间隔 200ms**——这就是用户按 Ctrl+C 后 terminal command 最长延迟。

local 后端的 `_kill_process` 升级链（`tools/environments/local.py:263-279`）：

```python
def _kill_process(self, proc):
    """Kill the entire process group (all children)."""
    try:
        if _IS_WINDOWS:
            proc.terminate()
        else:
            pgid = os.getpgid(proc.pid)
            os.killpg(pgid, signal.SIGTERM)
            try:
                proc.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        try:
            proc.kill()
        except Exception:
            pass
```

Unix 上：

1. 先 `os.killpg(pgid, SIGTERM)` 给整个进程组——避免 fork 出来的孙进程留为孤儿。这里依赖 `subprocess.Popen` 创建时设置了 `preexec_fn=os.setsid`（`tools/environments/local.py:255`），让 bash 成为新 process group leader。
2. `proc.wait(timeout=1.0)` 等 1 秒。
3. 不退就 `os.killpg(pgid, SIGKILL)` 强杀。

**1 秒 grace period** 是平衡——足够让 bash trap "EXIT" handler 跑、足够让 vim 保存 swap 文件，但不会让用户感觉卡。

Windows 简单：直接 `proc.terminate()`（实际是 TerminateProcess），不区分 process group。

### 3.4 Subprocess timeout 与 interrupt 是同一机制

注意 3.3 的 `_wait_for_process` 中，`is_interrupted()` 和 `time.monotonic() > deadline` 两个条件用的是**同一个 polling 循环 + 同一个 `_kill_process()`**——只是返回的 `returncode` 不同（130 vs 124）。这说明 Hermes **没有为 per-tool timeout 单独设计逻辑**——timeout 就是"自我触发的 interrupt"。

Per-tool timeout 默认是 `TERMINAL_TIMEOUT=180`（`tools/terminal_tool.py:657`），上限 `FOREGROUND_MAX_TIMEOUT=600`（`tools/terminal_tool.py:79`）。

### 3.5 Network 工具：asyncio.wait_for 嵌套 to_thread

Web tool 和 MCP 工具是**异步代码**（部分），所以走的是不同模式。`tools/web_tools.py:1290-1304`：

```python
try:
    scrape_result = await asyncio.wait_for(
        asyncio.to_thread(
            _get_firecrawl_client().scrape,
            url=url,
            formats=formats,
        ),
        timeout=60,
    )
except asyncio.TimeoutError:
    logger.warning("Firecrawl scrape timed out for %s", url)
    results.append({
        "url": url, "title": "", "content": "",
        "error": "Scrape timed out after 60s — page may be too large or unresponsive. Try browser_navigate instead.",
```

要点：
- `asyncio.to_thread` 把同步调用扔到默认线程池。
- `asyncio.wait_for(timeout=60)` 包一层超时。

**注意 race**：`asyncio.wait_for` 超时后会 cancel 包裹的 task，但**不会停掉线程池里跑的同步函数**——线程会继续跑直到 firecrawl client 自己内部超时返回。Python 没有 thread cancellation，这是已知限制。Hermes 的做法是：超时后立即返回错误给 LLM（让 turn 继续），后台那个孤儿线程会自己跑完然后被 GC。如果是付费的 LLM 二级调用，这意味着**实际产生的费用会比 timeout 行为暗示的更多**——这是 trade-off 决策。

URL loop 里也插了显式 polling（`tools/web_tools.py:1270-1274`）：

```python
from tools.interrupt import is_interrupted as _is_interrupted
for url in safe_urls:
    if _is_interrupted():
        results.append({"url": url, "error": "Interrupted", "title": ""})
        continue
```

也就是说一批 URL 处理时，**正在处理的当前 URL 不会被打断，但下一个会被跳过**（间隔等于一次 firecrawl 调用时长）。

### 3.6 Network 工具：MCP 服务连接

`tools/mcp_tool.py:1045-1061`，MCP server task 关闭：

```python
async def shutdown(self):
    """Signal the Task to exit and wait for clean resource teardown."""
    self._shutdown_event.set()
    if self._task and not self._task.done():
        try:
            await asyncio.wait_for(self._task, timeout=10)
        except asyncio.TimeoutError:
            logger.warning(
                "MCP server '%s' shutdown timed out, cancelling task",
                self.name,
            )
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
    self.session = None
```

这是 graceful shutdown 模式：先 set `_shutdown_event` 让 task 自己看到信号退出，**等 10 秒 grace period**，超时才 `task.cancel()`。这个模式只在 MCP server 启停时用，不是 per-call。

### 3.7 Stream consumer 的 cancellation 处理

Gateway 端的 `GatewayStreamConsumer` 是 async task，能被 `task.cancel()`。它处理 `CancelledError` 的方式（`gateway/stream_consumer.py:230-236`）：

```python
except asyncio.CancelledError:
    # Best-effort final edit on cancellation
    if self._accumulated and self._message_id:
        try:
            await self._send_or_edit(self._accumulated)
        except Exception:
            pass
```

被 cancel 时**还是要尝试把已积累的部分内容发出去**，让用户看到截止到取消时刻的输出。这个 best-effort 不 re-raise CancelledError，吞掉了——这违反了一般的 Python asyncio 最佳实践（应该总是 re-raise CancelledError），但 Hermes 这里是有意的：consumer 本身的 cancel 不应阻碍 final edit。

### 3.8 Subagent（delegate_task）的传播

`run_agent.py:2568-2575`：

```python
# Propagate interrupt to any running child agents (subagent delegation)
with self._active_children_lock:
    children_copy = list(self._active_children)
for child in children_copy:
    try:
        child.interrupt(message)
    except Exception as e:
        logger.debug("Failed to propagate interrupt to child agent: %s", e)
```

`_active_children` 是 list，由 `delegate_task` 工具 append/remove。父 agent interrupt 时**递归 interrupt 所有活跃子 agent**——子 agent 的 stream 也会被关闭、子 agent 的 tool 也会停。关注 `with self._active_children_lock` + `children_copy = list(...)` 的 snapshot 模式：避免在遍历时被并发修改。

## 四、关键设计模式

### 4.1 Threading.Event + 主线程 polling，而非 asyncio.cancel

Hermes 几乎完全避开 `asyncio.CancelledError`-based 取消模型。原因可以从架构倒推：

- `AIAgent.run_conversation()` 是**同步阻塞**函数（设计选择，便于测试 + 单线程心智模型）。
- 同步代码不能被 `Task.cancel()` 中断——你必须在线程内主动检查标志。
- Tool 实现可以是同步（terminal_tool, file_tool）也可以是异步（web_tools, mcp_tool），但所有同步工具必须用同一种取消机制 → threading.Event。
- gateway 的 async 协程调 `loop.run_in_executor(None, run_sync)` 把 agent 派给线程池——`task.cancel()` cancel 的是 future 而不是线程，没法停里面的 agent。所以 cancel 协程**只是放弃等待**，agent 还在跑——必须显式 `agent.interrupt()` 让它停。

这套设计对应"**控制信号在 async 边界外用 threading 原语承载**"的范式。

### 4.2 Force-close TCP socket：reach into httpx transport

`run_agent.py:3685-3741`：

```python
@staticmethod
def _force_close_tcp_sockets(client: Any) -> int:
    """Force-close underlying TCP sockets to prevent CLOSE-WAIT accumulation.

    When a provider drops a connection mid-stream, httpx's ``client.close()``
    performs a graceful shutdown which leaves sockets in CLOSE-WAIT until the
    OS times them out (often minutes).  This method walks the httpx transport
    pool and issues ``socket.shutdown(SHUT_RDWR)`` + ``socket.close()`` to
    force an immediate TCP RST, freeing the file descriptors.

    Returns the number of sockets force-closed.
    """
    import socket as _socket

    closed = 0
    try:
        http_client = getattr(client, "_client", None)
        if http_client is None:
            return 0
        transport = getattr(http_client, "_transport", None)
        if transport is None:
            return 0
        pool = getattr(transport, "_pool", None)
        if pool is None:
            return 0
        # httpx uses httpcore connection pools; connections live in
        # _connections (list) or _pool (list) depending on version.
        connections = (
            getattr(pool, "_connections", None)
            or getattr(pool, "_pool", None)
            or []
        )
        for conn in list(connections):
            stream = (
                getattr(conn, "_network_stream", None)
                or getattr(conn, "_stream", None)
            )
            if stream is None:
                continue
            sock = getattr(stream, "_sock", None)
            if sock is None:
                sock = getattr(stream, "stream", None)
                if sock is not None:
                    sock = getattr(sock, "_sock", None)
            if sock is None:
                continue
            try:
                sock.shutdown(_socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
                ...
            except OSError:
                pass
            closed += 1
    except Exception as exc:
        logger.debug("Force-close TCP sockets sweep error: %s", exc)
    return closed
```

正常 `client.close()` 走 graceful shutdown，会等四次握手完成（CLOSE-WAIT 状态），可能挂分钟级别。Hermes 直接从 OpenAI SDK 的 `client._client._transport._pool` reach in，对每个 socket 发 `SHUT_RDWR + close`——触发 TCP RST，瞬间释放 fd。

这是**典型的"对 SDK 私有内部做防御性兼容"代码**：注释里说"depending on version"，并 fallback 多个属性名（`_connections` vs `_pool`，`_network_stream` vs `_stream`）。这种代码脆但有效。

### 4.3 Worker-local client：避免污染共享 pool

`run_agent.py:4318-4350`：每次 API 调用创建一个 worker-local OpenAI client（`_create_request_openai_client`），interrupt 时只关 worker-local client：

```python
def _interruptible_api_call(self, api_kwargs: dict):
    """
    Run the API call in a background thread so the main conversation loop
    can detect interrupts without waiting for the full HTTP round-trip.

    Each worker thread gets its own OpenAI client instance. Interrupts only
    close that worker-local client, so retries and other requests never
    inherit a closed transport.
    """
```

这避免了 share pool 模式下的"interrupt 一个调用，结果其他在跑的调用也死了"的连锁反应。代价是每次 API 调用要建新 client（连接池冷启动），但相比中断响应延迟和稳定性，这点开销可接受。

### 4.4 关闭路径上对再次 interrupt 免疫

`cli.py:8984-9019` 的 finally block 里几乎每一步都是 `try/except (Exception, KeyboardInterrupt)`：

```python
except (EOFError, KeyboardInterrupt, BrokenPipeError):
    pass
finally:
    self._should_exit = True
    # Flush memories before exit (only for substantial conversations)
    if self.agent and self.conversation_history:
        try:
            self.agent.flush_memories(self.conversation_history)
        except (Exception, KeyboardInterrupt):
            pass
    ...
    if hasattr(self, '_session_db') and self._session_db and self.agent:
        try:
            self._session_db.end_session(self.agent.session_id, "cli_close")
        except (Exception, KeyboardInterrupt) as e:
            logger.debug("Could not close session in DB: %s", e)
```

设计意图很明确：用户连按 Ctrl+C / SIGTERM 时，不能让"关闭过程被打断"导致 session 状态损坏。所有写盘、释放资源的步骤都接受 KeyboardInterrupt。

### 4.5 持久化在 interrupt 触发时同步执行

`run_agent.py:8155-8160`：

```python
except InterruptedError:
    if thinking_spinner:
        thinking_spinner.stop("")
        thinking_spinner = None
    if self.thinking_callback:
        self.thinking_callback("")
    api_elapsed = time.time() - api_start_time
    self._vprint(f"{self.log_prefix}⚡ Interrupted during API call.", force=True)
    self._persist_session(messages, conversation_history)
    interrupted = True
    final_response = f"Operation interrupted: waiting for model response ({api_elapsed:.1f}s elapsed)."
    break
```

每一处响应 interrupt 的退出点都先 `_persist_session()` 写一次盘——保证 history 不会因为中断丢失。这是"中断不损失数据"的保证。

### 4.6 双键序列：double-Ctrl+C → force exit

`cli.py:7961-7970`：

```python
if self._agent_running and self.agent:
    if now - self._last_ctrl_c_time < 2.0:
        print("\n⚡ Force exiting...")
        self._should_exit = True
        event.app.exit()
        return

    self._last_ctrl_c_time = now
    print("\n⚡ Interrupting agent... (press Ctrl+C again to force exit)")
    self.agent.interrupt()
```

UX 的两阶段语义：
- **第一次 Ctrl+C** = soft interrupt，给 agent 机会 cleanup（save session、send "interrupted" message）。
- **2 秒内再按一次** = hard exit，不等 cleanup，立即退出。

模仿了 bash / Python REPL 的常见行为，用户心智成本低。

### 4.7 Interrupt-aware sleep 模式

retry 重试间的 `time.sleep(...)` 不能阻塞太久（否则 interrupt 响应延迟太大）。Hermes 把 sleep 拆成 200ms 小步，每步检查一次 interrupt（`run_agent.py:7840-7855`）：

```python
# Sleep in small increments to stay responsive to interrupts
sleep_end = time.time() + wait_time
while time.time() < sleep_end:
    if self._interrupt_requested:
        self._vprint(f"{self.log_prefix}⚡ Interrupt detected during retry wait, aborting.", force=True)
        self._persist_session(messages, conversation_history)
        self.clear_interrupt()
        return {
            "final_response": f"Operation interrupted: retrying API call after rate limit (retry {retry_count}/{max_retries}).",
            ...
            "interrupted": True,
        }
    time.sleep(0.2)
continue  # Retry the API call
```

这种"sleep + poll"模式在 8794-8810 也出现过。是同步代码"近似 cancellable sleep"的标准写法。

### 4.8 `_active_sessions` 是 asyncio.Event，但实际语义是 boolean flag

`gateway/platforms/base.py:1405`：

```python
# Mark session as active BEFORE spawning background task to close
# the race window where a second message arriving before the task
# starts would also pass the _active_sessions check and spawn a
# duplicate task.  (grammY sequentialize / aiogram EventIsolation
# pattern — set the guard synchronously, not inside the task.)
self._active_sessions[session_key] = asyncio.Event()
```

这里用 `asyncio.Event` 的目的不是给协程 await（协程没等过它），而是当成"可以 set 的 boolean flag + 兼容 `is_set()` 查询"。`set()` 在新消息到达时调用（用作 interrupt signal），`is_set()` 在 `has_pending_interrupt` 查询时用。

这是 asyncio.Event 的**非典型用法**（一般应配 `await event.wait()`），但有效——因为 Hermes 的中断检查终归是 polling 而非 await。

### 4.9 Photo burst 不触发 interrupt，而是 merge

`gateway/platforms/base.py:1378-1391`：

```python
# Special case: photo bursts/albums frequently arrive as multiple near-
# simultaneous messages. Queue them without interrupting the active run,
# then process them immediately after the current task finishes.
if event.message_type == MessageType.PHOTO:
    logger.debug("[%s] Queuing photo follow-up for session %s without interrupt", self.name, session_key)
    existing = self._pending_messages.get(session_key)
    if existing and existing.message_type == MessageType.PHOTO:
        existing.media_urls.extend(event.media_urls)
        existing.media_types.extend(event.media_types)
        if event.text:
            existing.text = self._merge_caption(existing.text, event.text)
    else:
        self._pending_messages[session_key] = event
    return  # Don't interrupt now - will run after current task completes
```

这是产品级细节：用户在 Telegram/Discord 里发相册时，平台会拆成多条消息几乎同时到。如果每张照片都触发 interrupt，agent 永远跑不完。这里**消息类型决定 interrupt 语义**。

## 五、值得 zhixing 借鉴的细节

1. **Force-close socket 技巧**（`run_agent.py:3685`）。Node.js 的 `fetch` / `undici` 也面临同样问题：`AbortController.abort()` 只让正在 read 的 stream 抛错，但底层 connection 可能还在 graceful shutdown。需要时可以 reach into agent / dispatcher 的 socket 强制 destroy。这对中国网络环境（GFW 下连接经常半死不活）尤其有用。

2. **Stale stream watchdog**（`run_agent.py:4881-4940`）。SSE keep-alive ping 让 read timeout 失效是真实存在的问题，且只有应用层 watchdog 能解决。Watchdog 阈值随 context size 自动调整（100k/50k/默认三档）很务实——大 context 下 prefill 真的会慢。

3. **三层 timeout 分层**（chunk timeout / stale watchdog / agent inactivity）。每层负责一类失败模式，不重叠也不冲突。zhixing 现在只有 chunk timeout，应该补 watchdog 和 agent-level inactivity。

4. **关闭路径双重 try/except**（`cli.py:8984-9019`）。所有 cleanup 步骤都接受 KeyboardInterrupt——避免"用户连按 Ctrl+C 把 cleanup 打断"导致 session 损坏。Node.js 上对应的是"`SIGINT` listener 内部要再次允许 SIGINT"——容易忽视。

5. **Tool result 占位 message**（`run_agent.py:6585-6593`）。被中断跳过的 tool 必须写一条 fake `role: tool` 占位 message——OpenAI tool-calling 协议硬性要求。否则下一轮 LLM 调用会被服务端拒绝。这是 zhixing 实现 stream interrupt 时极易踩到的坑。

6. **Interrupt-aware sleep**（`run_agent.py:7840-7855`）。任何 retry/backoff 的 sleep 都要拆成小步轮询——不能 `setTimeout(continue, 5000)`。Node.js 的 `Promise.race([sleep, abortPromise])` 模式或 `signal.timeout()` 是对应做法。

7. **Worker-local client**（`run_agent.py:4318-4326`）。每次 API call 用独立 client 实例，避免一个 abort 影响其他在跑的请求。Node.js 上对应的是"不复用全局 fetch agent，每个 stream 用新的 AbortController + 新的 dispatcher"。

8. **Soft interrupt + hard exit 双键序列**（`cli.py:7961-7970`）。Ctrl+C 第一次是 soft，第二次（短时间内）是 hard。比单纯 SIGINT 杀进程对用户更友好，对状态保护更好。

9. **Activity tracker + 分级警告**（`run_agent.py:2585-2588`、`gateway/run.py:7414-7431`）。Inactivity timeout 不是"哐当一下杀掉"，而是先 50% 阈值时给用户发警告"⚠️ 已经 X 分钟没动静了，再 Y 分钟会强制超时"——给用户决策权。

10. **递归 child agent interrupt**（`run_agent.py:2568-2575`）。如果 zhixing 要做 sub-agent / delegation，必须建立类似的"父 agent interrupt 时传播到所有子 agent"机制，否则会出现孤儿子 agent 继续烧 token 的问题。

## 六、不适合 zhixing 的部分

1. **threading.Event + polling 模型**。Hermes 选这个是因为 `run_conversation()` 是同步阻塞的设计选择。zhixing 在 Node.js 上完全可以用 `AbortSignal` + `for await ... of stream`——原生异步取消，无需 polling，无需小步 sleep。这是不要照搬的部分。

2. **prompt_toolkit 拦截 SIGINT**。Hermes CLI 的 Ctrl+C 走 KeyBinding 是因为 prompt_toolkit 已经把终端切到 raw mode 拦下了 ETX 字节。Node.js 的 readline / Ink / blessed 等 TUI 库各有自己的处理方式——不能直接搬这个模型，但 "Ctrl+C 第一次 soft 第二次 hard" 的 UX 模式可以保留。

3. **裸 `signal.signal` + 转译为 KeyboardInterrupt**。这是 Python 特有的"在 C 栈帧里 raise Python 异常"机制，Node.js 没有等价物。Node.js 的 `process.on('SIGTERM', ...)` 完全够用且更直接。

4. **`asyncio.to_thread` + `loop.run_in_executor` 桥接**。这是 Hermes 选了同步 agent 后被迫的桥接代码。zhixing 既然是 Node.js + 全异步，就不应该有这层。但 `gateway/run.py:7396-7434` 那个 "poll executor task while checking activity" 的模式，对应到 Node.js 是 `Promise.race([streamPromise, watchdogPromise])`——值得参考。

5. **`os.killpg(pgid, SIGTERM/SIGKILL)` + `preexec_fn=os.setsid`**。Unix 进程组管理直接搬到 Node.js 需要 `child_process.spawn({ detached: true })` + `process.kill(-pid, 'SIGTERM')`。Windows 行为完全不同（没有进程组概念，要用 job object）——Hermes 直接 `proc.terminate()` 就妥协了，zhixing 在 Windows 上需要更细致的处理。

6. **Reach into httpx transport 内部 + 多版本 fallback**。Node.js 的 fetch / undici 内部结构和 httpx 完全不同，且 Node.js 已经内置 `req.destroy()` / `req.socket.destroy()` 是公开 API。**思想可借鉴**（强 RST 关闭比 graceful shutdown 快），**代码不能照搬**。

7. **同步 + async 混合的 cancel 策略**。Hermes 这套混合是历史包袱——同步 agent 历史早于 streaming 加入。zhixing 没有这个包袱，应该坚持纯 async。但要意识到：**纯 async 下 `AbortSignal` 不能停跑在 worker thread 里的 CPU-bound 同步代码**——这个限制和 Hermes 的 `asyncio.to_thread` race 是同源问题。

---

**一句话总结**: Hermes 的可中断 stream agent loop 是"同步阻塞 agent + threading.Event flag + polling + force-close socket + 三层 timeout watchdog + 关闭路径对再次中断免疫"的组合拳。**机制不优雅但久经实战**——9910 行 `run_agent.py` 中有几十处 `if self._interrupt_requested:` 检查点，覆盖了从 stream 到 retry 到 sleep 的每一个潜在阻塞点。zhixing 在 Node.js 上做对应实现时，应当吸收的是**"中断检查点遍布 + 关闭路径鲁棒 + 三层 timeout 分层 + 子 agent 递归传播"** 这些设计原则，而不是 polling + threading.Event 的具体实现手法。
