# Hermes Agent 确认交互 UX — 源码解析

> **所属系统**: Hermes Agent (Python, Nous Research)  
> **焦点**: CLI 交互式审批对话框  
> **源码位置**: `e:/Dev/longxia/hermes-agent-main/`  
> **分析日期**: 2026-04-13  
> **核对方式**: 直接阅读 `cli.py`、`tools/approval.py`，记录真实行号

## 核心洞察：三系统中 CLI 审批 UX 最像样的一个

Hermes 是**唯一把审批面板做成 prompt_toolkit 一等公民组件的系统**——上下箭头导航、选中项高亮、命令超长时动态加 View 选项、Ctrl+C 触发"拒绝"而非"崩溃"、严格用 `_approval_lock` 串行并发请求。它还是**唯一把 LLM 辅助分诊直接做进审批流**的：`approvals.mode=smart` 时先让一个 Claude 模型判断命令到底危不危险，只有"escalate"才真正弹给人看。

它有两个严重缺陷：**永久 allowlist 是正则模式且无元数据**，以及**非交互模式 fail-open**（不设环境变量就全部放行）。

## 整体审批流程

```
┌─────────────────────────────────────────────┐
│  terminal_tool.execute()                    │
│           │                                 │
│           ▼                                 │
│  check_all_command_guards(command, env)     │  tools/approval.py:683
│           │                                 │
│    ┌──────┴──────┐                          │
│    │ Tirith scan │ ← 可选二进制扫描器        │
│    ├─────────────┤                          │
│    │ regex detect│ ← detect_dangerous_command│
│    └──────┬──────┘                          │
│           ▼                                 │
│  warnings list (tirith + dangerous)         │
│           │                                 │
│    ┌──────┴──────┐                          │
│    │ mode=smart? │──► _smart_approve()      │  approval.py:524
│    │             │    approve/deny/escalate │
│    └──────┬──────┘                          │
│           ▼                                 │
│    ┌─────────────┐                          │
│    │ is_gateway? │──► _gateway_queues[...]  │
│    │             │    entry.event.wait()    │
│    └──────┬──────┘    (threading.Event)     │
│           │                                 │
│           ▼                                 │
│   prompt_dangerous_approval()               │  approval.py:399
│      │                                      │
│      ├── approval_callback 已注册？          │
│      │       ▼ 是                           │
│      │   prompt_toolkit 富面板               │  cli.py:6722
│      │       ▼ 否                           │
│      └── plain input() 兜底                 │  approval.py:427
└─────────────────────────────────────────────┘
```

## 四个执行模式

| 环境变量 / 配置 | 模式 | 未命中 allowlist 时的行为 |
|---|---|---|
| `HERMES_INTERACTIVE=1` | CLI 交互 | prompt_toolkit 富面板 |
| `HERMES_GATEWAY_SESSION=...` | Gateway 异步 | 入队 + `threading.Event.wait(300s)` |
| `HERMES_EXEC_ASK=1` | Ask mode | 同 gateway 路径 |
| `HERMES_YOLO_MODE=1` | Yolo | 跳过所有检查 |
| `approvals.mode=off` | 全局关闭 | 跳过所有检查 |
| `approvals.mode=smart` | LLM 分诊 | 先走辅助 LLM，再按其裁决 |
| *都没设* | 非交互兜底 | **fail-open** — 全部放行 ⚠️ |

`tools/approval.py:607-611`：

```python
is_cli = os.getenv("HERMES_INTERACTIVE")
is_gateway = os.getenv("HERMES_GATEWAY_SESSION")
if not is_cli and not is_gateway:
    return {"approved": True, "message": None}  # 非交互直接放行
```

> ⚠️ 这是个严重的安全姿态问题——在 CI 里忘记设 flag 就会让一切命令无需确认。知行必须走反方向：`fail-to-confirm`，非交互时默认拒绝未匹配操作。

## CLI 富面板：prompt_toolkit 实现

### 状态机与并发保护（`cli.py:6722-6775`）

```python
def _approval_callback(self, command: str, description: str,
                       *, allow_permanent: bool = True) -> str:
    """
    Prompt for dangerous command approval through the prompt_toolkit UI.
    Called from the agent thread. Shows a selection UI similar to clarify
    with choices: once / session / always / deny. When allow_permanent
    is False (tirith warnings present), the 'always' option is hidden.
    Long commands also get a 'view' option so the full command can be
    expanded before deciding.

    Uses _approval_lock to serialize concurrent requests (e.g. from
    parallel delegation subtasks) so each prompt gets its own turn
    and the shared _approval_state / _approval_deadline aren't clobbered.
    """
    import time as _time

    with self._approval_lock:                      # ① 串行化并发审批
        timeout = 60                                # ② 60s 硬超时
        response_queue = queue.Queue()

        self._approval_state = {                   # ③ 共享状态 → UI 渲染依据
            "command": command,
            "description": description,
            "choices": self._approval_choices(command, allow_permanent=allow_permanent),
            "selected": 0,
            "response_queue": response_queue,
        }
        self._approval_deadline = _time.monotonic() + timeout

        self._invalidate()                          # ④ 强制 prompt_toolkit 重绘

        _last_countdown_refresh = _time.monotonic()
        while True:
            try:
                result = response_queue.get(timeout=1)   # ⑤ 每秒 poll
                self._approval_state = None
                self._approval_deadline = 0
                self._invalidate()
                return result
            except queue.Empty:
                remaining = self._approval_deadline - _time.monotonic()
                if remaining <= 0:
                    break
                now = _time.monotonic()
                if now - _last_countdown_refresh >= 5.0:  # ⑥ 倒计时每 5s 重绘
                    _last_countdown_refresh = now
                    self._invalidate()

        self._approval_state = None
        self._approval_deadline = 0
        self._invalidate()
        _cprint(f"\n{_DIM}  ⏱ Timeout — denying command{_RST}")
        return "deny"
```

**关键设计点**：
- **`_approval_lock` 串行化**：多个 subagent 并行调用时，审批按顺序一个个弹，不会乱
- **共享可变状态 + `_invalidate()`**：agent 线程设状态，UI 线程通过 `_get_approval_display_fragments()` 读状态并重绘
- **queue.Queue 轮询**：每秒 get(timeout=1) 一次；timeout 时检查 deadline 并按需重绘倒计时
- **倒计时每 5 秒才重绘一次**：防止 Kitty/Ghostty 等终端在频繁 repaint 时的闪烁
- **硬 60s 超时**：其它系统要么 30 分钟要么 30 秒，Hermes 取了中间值

### 选项裁剪（`cli.py:6777-6782`）

```python
def _approval_choices(self, command: str, *, allow_permanent: bool = True) -> list[str]:
    """Return approval choices for a dangerous command prompt."""
    choices = ["once", "session", "always", "deny"] if allow_permanent else ["once", "session", "deny"]
    if len(command) > 70:
        choices.append("view")
    return choices
```

两层条件化：
1. `allow_permanent=False`（tirith 扫描到内容级威胁时）→ **隐藏 "always" 选项**。核心判断：「基于上下文威胁类型动态裁剪选项集」。
2. `len(command) > 70` → 追加 "view" 选项，允许用户展开查看完整命令。

### 面板渲染（`cli.py:6808-6885`）

```python
def _get_approval_display_fragments(self):
    state = self._approval_state
    if not state:
        return []

    def _panel_box_width(title_text, content_lines, min_width=46, max_width=76) -> int:
        term_cols = shutil.get_terminal_size((100, 20)).columns
        longest = max([len(title_text)] + [len(line) for line in content_lines] + [min_width - 4])
        inner = min(max(longest + 4, min_width - 2), max_width - 2, max(24, term_cols - 6))
        return inner + 2

    command = state["command"]
    description = state["description"]
    choices = state["choices"]
    selected = state.get("selected", 0)
    show_full = state.get("show_full", False)

    title = "⚠️  Dangerous Command"
    cmd_display = command if show_full or len(command) <= 70 else command[:70] + '...'
    choice_labels = {
        "once": "Allow once",
        "session": "Allow for this session",
        "always": "Add to permanent allowlist",
        "deny": "Deny",
        "view": "Show full command",
    }
    # ... wrap lines, build panel frame with ╭/╯ + border styles
    for i, choice in enumerate(choices):
        label = choice_labels.get(choice, choice)
        style = 'class:approval-selected' if i == selected else 'class:approval-choice'
        prefix = '❯ ' if i == selected else '  '
        # append to lines
```

**可学习细节**：
- 面板宽度**自适应终端列数**（`shutil.get_terminal_size()`）但有最小/最大约束
- 命令太长时默认截断到 70 字符 + `...`，通过 "view" 选项展开
- 选中项用 `❯` + `class:approval-selected` 样式类，其它用空格 + `class:approval-choice`
- 边框用 `class:approval-border`，完全走 prompt_toolkit 的 style sheet 系统

### 键盘绑定（`cli.py:7866-7877`）

```python
@kb.add('up', filter=Condition(lambda: bool(self._approval_state)))
def approval_up(event):
    if self._approval_state:
        self._approval_state["selected"] = max(0, self._approval_state["selected"] - 1)
        event.app.invalidate()

@kb.add('down', filter=Condition(lambda: bool(self._approval_state)))
def approval_down(event):
    if self._approval_state:
        max_idx = len(self._approval_state["choices"]) - 1
        self._approval_state["selected"] = min(max_idx, self._approval_state["selected"] + 1)
        event.app.invalidate()
```

**`filter=Condition(...)` 是 prompt_toolkit 的关键能力**——同一个键绑定可以被**多种模态**复用（approval / clarify / sudo / secret），按当前状态决定哪个 handler 生效。这是一种**软模态 UI**：没有真正的阻塞，主输入框照常存在，但键绑定的语义随 `_approval_state` 切换。

### Enter 键选中与 "view" 的自移除（`cli.py:6784-6806`）

```python
def _handle_approval_selection(self) -> None:
    """Process the currently selected dangerous-command approval choice."""
    state = self._approval_state
    if not state:
        return
    selected = state.get("selected", 0)
    choices = state.get("choices") or []
    if not (0 <= selected < len(choices)):
        return

    chosen = choices[selected]
    if chosen == "view":
        state["show_full"] = True
        state["choices"] = [choice for choice in choices if choice != "view"]
        if state["selected"] >= len(state["choices"]):
            state["selected"] = max(0, len(state["choices"]) - 1)
        self._invalidate()
        return                                      # view 不退出面板，只展开

    state["response_queue"].put(chosen)             # 其它选项退出并返回决定
    self._approval_state = None
    self._invalidate()
```

**"view" 选中后的三步动作**：
1. 把 `show_full=True` 写进状态（命令全文显示）
2. 从 choices 里移除自己（不能再选）
3. 修正 `selected` 索引避免越界

这是一个**微型状态机**：同一个面板内多次 Enter 的语义不同。

### Ctrl+C 模态优先级（`cli.py:7897-7959`）

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
    # ... voice recording cancel
    # sudo prompt → response_queue.put("")
    # secret prompt → _cancel_secret_capture()
    if self._approval_state:
        self._approval_state["response_queue"].put("deny")  # Ctrl+C = deny
        self._approval_state = None
        event.app.invalidate()
        return
    # clarify prompt → "The user cancelled. Use your best judgement..."
    # agent running → interrupt
    # double Ctrl+C within 2s → force exit
```

**Ctrl+C 的语义按模态栈优先级处理**：
1. 先取消音频录制
2. 再取消 sudo/secret/approval/clarify 等任何 modal prompt
3. 再中断运行中的 agent
4. 最后双击才强退

审批被 Ctrl+C 取消时**确定性地发送 "deny"**，不是 None 也不是异常——干净。

## Smart 分诊（`tools/approval.py:524-573`）

```python
def _smart_approve(command: str, description: str) -> str:
    """Use the auxiliary LLM to assess risk and decide approval.

    Returns 'approve' if the LLM determines the command is safe,
    'deny' if genuinely dangerous, or 'escalate' if uncertain.

    Inspired by OpenAI Codex's Smart Approvals guardian subagent
    (openai/codex#13860).
    """
    try:
        from agent.auxiliary_client import get_text_auxiliary_client, auxiliary_max_tokens_param
        client, model = get_text_auxiliary_client(task="approval")
        if not client or not model:
            return "escalate"

        prompt = f"""You are a security reviewer for an AI coding agent. A terminal command was flagged by pattern matching as potentially dangerous.

Command: {command}
Flagged reason: {description}

Assess the ACTUAL risk of this command. Many flagged commands are false positives — for example, `python -c "print('hello')"` is flagged as "script execution via -c flag" but is completely harmless.

Rules:
- APPROVE if the command is clearly safe (benign script execution, safe file operations, development tools, package installs, git operations, etc.)
- DENY if the command could genuinely damage the system (recursive delete of important paths, overwriting system files, fork bombs, wiping disks, dropping databases, etc.)
- ESCALATE if you're uncertain

Respond with exactly one word: APPROVE, DENY, or ESCALATE"""

        response = client.chat.completions.create(
            model=model, messages=[{"role": "user", "content": prompt}],
            **auxiliary_max_tokens_param(16), temperature=0,
        )
        answer = (response.choices[0].message.content or "").strip().upper()
        if "APPROVE" in answer: return "approve"
        elif "DENY" in answer: return "deny"
        else: return "escalate"
    except Exception:
        return "escalate"
```

**关键设计点**：
- 独立辅助客户端（不同 API key / 更便宜模型）
- `max_tokens=16`、`temperature=0` — 最小化成本 + 确定性
- **三态输出**：approve / deny / escalate — 不确定时**升级给人**，不自动决定
- **仅 CLI + smart 模式启用**；gateway 路径不经过 smart → **一个漏洞**

## 会话类型 + 持久化

### 两个内存态字典（`tools/approval.py:194-196`）

```python
_session_approved: dict[str, set] = {}  # {session_key: {pattern_key, ...}}
_permanent_approved: set = set()         # 跨会话永久规则
```

### YAML 持久化（`tools/approval.py:366-393`）

```python
def save_permanent_allowlist(patterns: set):
    config = load_config()
    config["command_allowlist"] = list(patterns)
    save_config(config)
```

结果是 `~/.hermes/config.yaml` 里的一段：

```yaml
command_allowlist:
  - 'rm.*tmp'
  - 'curl.*http'
  - 'sudo.*passwd'
```

**这是全系统最弱的环节**：
1. **全部是正则模式字符串**——没有 scope、没有 metadata、没有 createdAt、没有 createdBy、没有撤销 UI
2. **`command_allowlist` 顶层 key**——没有 per-agent 隔离
3. **session 层只是 in-memory set**，进程退出全丢
4. **没有 deny 规则**——只能 allow，无法"永远别做 X"

## Gateway 异步模式（`tools/approval.py:683-865`）

```python
if is_gateway or is_ask:
    notify_cb = _gateway_notify_cbs.get(session_key)
    if notify_cb is not None:
        approval_data = {
            "command": command,
            "pattern_key": primary_key,
            "pattern_keys": all_keys,
            "description": combined_desc,
        }
        entry = _ApprovalEntry(approval_data)
        with _lock:
            _gateway_queues.setdefault(session_key, []).append(entry)
        try:
            notify_cb(approval_data)   # 推送到 Discord / Web / 任何已注册通道
        except Exception:
            # 清理并返回 BLOCKED
            ...
        timeout = int(_get_approval_config().get("gateway_timeout", 300))
        resolved = entry.event.wait(timeout=timeout)   # 阻塞 agent 线程 5 分钟
        # ... 用户决定后消费 entry.result
```

**和 OpenClaw 的区别**：
- OpenClaw 走正式 RPC（两阶段注册），Hermes 用进程内 `threading.Event` + 全局字典
- OpenClaw 的 gateway 是独立进程；Hermes 的 "gateway" 是同一 Python 进程内的协程+线程混合
- OpenClaw 每个审批有 UUID 形式的 id；Hermes 用 session_key 维度的队列

## 值得借鉴

| # | 模式 | 来源行 |
|---|------|------|
| 1 | **prompt_toolkit 软模态** — 同键多语义 + `Condition` 过滤 | cli.py:7866 |
| 2 | **命令长度自适应裁剪 + View 选项自移除** | cli.py:6777, 6796 |
| 3 | **Ctrl+C = deny**（确定性而非异常） | cli.py:7944 |
| 4 | **tirith 威胁时隐藏 always 选项** | approval.py:736, allow_permanent=False |
| 5 | **并发审批用 `_approval_lock` 串行化** | cli.py:6739 |
| 6 | **倒计时降频重绘（每 5 秒）避免闪烁** | cli.py:6767 |
| 7 | **Smart LLM 分诊 = approve/deny/escalate 三态** | approval.py:524 |
| 8 | **`approvals.mode=smart` 配置项而非代码开关** | approval.py:510 |
| 9 | **tirith scanner 作为可插拔外部扫描器** | approval.py:718 |

## 局限与坑

| # | 问题 | 严重度 |
|---|------|-------|
| 1 | **非交互模式 fail-open** | 🔴 严重安全姿态问题 |
| 2 | Smart 模式只在 CLI 路径生效，gateway 绕过 | 🟡 |
| 3 | allowlist 是裸正则字符串，无 scope/metadata/撤销 UI | 🟡 |
| 4 | 无 per-agent 隔离 | 🟡 |
| 5 | 无"编辑后再批准" | 🟡 |
| 6 | 无"拒绝并告诉 agent 原因"回路 | 🟡 |
| 7 | session 规则仅内存、无持久化 | 🟢 |
| 8 | 永久规则写 YAML 需手动编辑撤销 | 🟢 |

## 可拿来的设计元素（给知行）

- ✅ **prompt_toolkit 式软模态架构** — 通过 `Condition` 过滤器让同键多语义共存，不需要真正阻塞 REPL
- ✅ **Ctrl+C = deny**（确定性而非异常）
- ✅ **命令长度自适应 + View 自移除**
- ✅ **选项按威胁类型动态隐藏** — 内容级威胁时不给 "always"
- ✅ **Smart LLM 分诊**（作为 Phase 3 可选层，三态输出 + escalate 不自动决定）
- ✅ **串行锁保护并发审批** — 知行的 `ConfirmationBroker` 也需要
- ✅ **倒计时低频重绘** — 终端兼容性保底
- ❌ **非交互 fail-open** — 知行走反方向
- ❌ **YAML 裸正则 allowlist** — 知行 PermissionStore 的 glob + scope + metadata 远胜
- ❌ **进程内 threading.Event 做 gateway 等待** — 不可扩展，知行要走事件总线
