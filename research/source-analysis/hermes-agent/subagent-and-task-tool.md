# Hermes Agent — 子 Agent / Task 工具实现分析

> **分析状态**: 已分析（2026-04-28）
>
> **分析范围**: hermes 的 `delegate_task` 工具及其底层 subagent 架构（child AIAgent 实例化、toolset 子集裁剪、并行调度、abort 传播、approval handling、session 持久化、cost 上卷、Skills 与 subagent 的边界）

## 模块定位

Hermes Agent **存在标准意义的"子 agent"概念**，承载者是 `tools/delegate_tool.py`（2525 行），暴露给 LLM 的工具名为 `delegate_task`，所属 toolset 为 `delegation`。其本质是：**在父 AIAgent 进程内、通过 `ThreadPoolExecutor` 启动一个全新的子 `AIAgent` 实例**（不是 subprocess、也不是新协程），子 agent 拥有：

- 独立的 conversation（不继承父 history）
- 独立的 `task_id`（独立的 terminal session、file ops cache）
- 受限的 toolset 子集（与父交集后再剥离 5 个永远禁止的工具）
- 独立的、根据 goal+context 重写的 system prompt
- 独立的迭代预算（`iteration_budget=None`，重新创建）

父 agent 在子 agent 跑完之前**阻塞**（同步 `_run_single_child` 或 `as_completed` 池化等待），最终只把 child 的 `final_response`（自报 summary）+ 一份元信息写回 LLM 上下文，**子 agent 的中间 tool_call、reasoning 都不进父的 message 队列**。

Skills（`skills/` 目录、`tools/skills_tool.py`、`tools/skill_manager_tool.py`）是**独立机制**，不是 subagent —— 详见末尾"Skills 与 subagent 的边界辨析"一节。

## 信息来源

| 来源 | 路径 | 可信度 |
|---|---|---|
| 子 agent 主体实现 | `tools/delegate_tool.py` 全文 2525 行 | 全文阅读 |
| 子 agent 工具 schema 注册 | `tools/delegate_tool.py:2352-2525` | 直接引证 |
| `delegation` toolset 定义 | `toolsets.py:190-194` | 直接引证 |
| 父 AIAgent 上的子 agent state | `run_agent.py:1120-1123`（`_delegate_depth` / `_active_children` / lock）| 直接引证 |
| Interrupt 传播到 children | `run_agent.py:4108-4114` | 直接引证 |
| Per-turn vs full close children | `run_agent.py:4415-4429`、`4475-4486` | 直接引证 |
| 子 session 持久化 schema | `hermes_state.py:50`（`parent_session_id` FK）、`525-545`（`create_session`）| 直接引证 |
| 子 session 在 list 时被隐藏 | `hermes_state.py:893-970` | 直接引证 |
| 父 broker 与子 approval 分流 | `tools/delegate_tool.py:52-107`、`tools/approval.py:27-82` | 直接引证 |
| Gateway-side TUI 控制 RPC | `tui_gateway/server.py:2113-2150`（`delegation.status` / `delegation.pause` / `subagent.interrupt`）| 直接引证 |
| TUI 端调用代码 | `ui-tui/src/components/agentsOverlay.tsx:772-976` | 引证 |
| Subagent 进度回调 | `tools/delegate_tool.py:648-832` | 直接引证 |
| Tool trace 抽取 | `tools/delegate_tool.py:1559-1591` | 直接引证 |
| Cost rollup 到父 | `tools/delegate_tool.py:1606-1640`、`2141-2184` | 直接引证 |
| 子 agent 启动诊断 dump | `tools/delegate_tool.py:1099-1241` | 直接引证 |
| Subagent_stop hook 触发 | `tools/delegate_tool.py:2125-2162`、`hermes_cli/plugins.py:73`、`hermes_cli/hooks.py:179-186` | 直接引证 |
| 配置默认值 / 文档 | `cli-config.yaml.example:790-808`、`AGENTS.md:92,624-625` | 直接引证 |
| File-state 跨 agent 协调 | `tools/file_state.py` 全文（约 60 行 docstring + 实现）| 引证 |
| 测试用例 | `tests/agent/test_subagent_progress.py`、`tests/cli/test_cli_interrupt_subagent.py`、`tests/tools/test_delegate_subagent_timeout_diagnostic.py`、`tests/agent/test_subagent_stop_hook.py` | 引证 |
| Skills 系统对比 | `tools/skills_tool.py:1-67`、`tools/skill_manager_tool.py:1-33`、`skills/software-development/subagent-driven-development/SKILL.md` | 直接引证 |

> 行号皆来自 `E:/Dev/longxia/_refs/hermes-agent-main/`。`tools/delegate_tool.py` 全文 2525 行；`run_agent.py` 全文 9000+ 行；`hermes_state.py` 全文约 2000 行。

## 一、详细机制分析

### 1.1 工具暴露

`delegate_task` 注册在 `tools/registry`，所属 toolset = `delegation`，emoji = 🔀。schema 关键字段（`tools/delegate_tool.py:2397-2501`）：

- `goal`: 单任务模式必填
- `context`: 给子 agent 的背景信息（子 agent 不知道父 conversation history）
- `toolsets`: 子 agent 启用的 toolset 列表，缺省继承父
- `tasks`: 数组形式的批量模式，每项独立 goal/context/toolsets/role/acp_command
- `role`: `"leaf"`（默认，不能再 delegate）或 `"orchestrator"`（可继续 delegate，受 `max_spawn_depth` 约束）
- `acp_command` / `acp_args`: 可选，让子 agent 走 ACP 子进程 transport（如 `claude --acp --stdio`）

**永远不可被子 agent 调用的工具**（`tools/delegate_tool.py:41-49`，`DELEGATE_BLOCKED_TOOLS`）：

```python
DELEGATE_BLOCKED_TOOLS = frozenset([
    "delegate_task",   # no recursive delegation (除非 role="orchestrator" 重新放回)
    "clarify",         # no user interaction
    "memory",          # no writes to shared MEMORY.md
    "send_message",    # no cross-platform side effects
    "execute_code",    # children should reason step-by-step, not write scripts
])
```

`_strip_blocked_tools`（`:637-645`）通过 toolset 名称（`delegation` / `clarify` / `memory` / `code_execution`）过滤而不是逐工具，所以子 agent 是**整个 toolset 被裁掉**。

### 1.2 子 agent 构造

`_build_child_agent`（`:835-1096`）做的事：

1. **Role 解析**（`:869-878`）：检查 kill switch + depth 判定 `effective_role`，degrade 到 leaf 是单点门控。
2. **Subagent_id 生成**（`:885`）：`f"sa-{task_index}-{_uuid.uuid4().hex[:8]}"`，跨事件、跨 registry 共享。
3. **Toolset 解析**（`:891-930`）：
   - 子 toolset 默认继承父（如果父 `enabled_toolsets is None` 即"all enabled"，从父 `valid_tool_names` 反查 toolset）
   - 父 toolset 求**交集**，确保子不会拿到父没有的工具
   - 调用 `_strip_blocked_tools` 剥离 4 个固定 toolset
   - 如果 `inherit_mcp_toolsets=True`（默认），把父的 MCP toolset 强行保留
   - `orchestrator` 角色重新加回 `delegation` toolset
4. **System prompt**（`:932-940`，调用 `_build_child_system_prompt:534-607`）：模板化，分四部分：subagent 介绍 + goal + context + workspace path + summary 要求；orchestrator 多一段说明可以再 delegate。
5. **Credential 解析**（`:983-1009`）：`override_*` > 父继承。`delegation.provider` 配置允许子 agent 走完全不同的 provider:model 对（如父跑 Nous Portal，子跑 OpenRouter cheap model）。
6. **AIAgent 实例化**（`:1030-1059`）传入：
   - 关键：`iteration_budget=None`（强制 fresh budget）
   - `quiet_mode=True`、`skip_context_files=True`、`skip_memory=True`、`clarify_callback=None`
   - `session_db=getattr(parent, "_session_db", None)` （**共享同一个 SQLite 库**）
   - `parent_session_id=parent.session_id` （建立 FK 链）
   - `tool_progress_callback=child_progress_cb` （把进度上报给父）
7. **State 标记**（`:1060-1071`）：
   - `child._delegate_depth = parent._delegate_depth + 1`
   - `child._delegate_role = effective_role`
   - `child._subagent_id = subagent_id`
   - `child._parent_subagent_id = parent_subagent_id`
8. **Credential pool 共享**（`:1074-1076`、`_resolve_child_credential_pool:2197-2227`）：同 provider 共享父池（cooldown / rotation 同步），不同 provider 自加载该 provider 的池。
9. **挂到父的活跃 children 列表**（`:1079-1085`，`parent._active_children.append(child)`）。
10. **立即广播 `subagent.spawn_requested` 事件**（`:1090-1094`）：即使 child 还在排队等 ThreadPool slot，TUI 也已经看到这个节点。

### 1.3 子 agent 执行

`_run_single_child`（`:1243-1811`），在 ThreadPoolExecutor worker 里跑：

1. **Approval callback 注入**（`:1414-1422`）：ThreadPoolExecutor 用 `initializer=_set_subagent_approval_cb, initargs=(cb,)`，给每个 worker 线程的 TLS（`threading.local()`）安装一个非交互 approval 回调（auto-deny 或 auto-approve）。
2. **TUI registry 注册**（`:1373-1389`）：把 child 信息塞进模块全局 `_active_subagents`（`subagent_id → record`），方便 TUI 通过 RPC 查询和 interrupt。
3. **Heartbeat 线程**（`:1283-1361`）：每 30s 调用 `parent._touch_activity(desc)`，防止 gateway inactivity timeout 误杀父 agent；同时做 stale 检测（idle 阈值 5 cycles=150s，in-tool 阈值 20 cycles=600s）。
4. **Hard timeout**（`:1414-1532`）：内层再开一个单 worker 的 ThreadPoolExecutor，`future.result(timeout=child_timeout)`（默认 600s）。超时则 `child.interrupt()`，executor `shutdown(wait=False)`，返回 `status="timeout"`。0-API-call 超时还会调 `_dump_subagent_timeout_diagnostic` 写诊断 log（`:1099-1241`，issue #14726）。
5. **任务执行**（`:1429-1432`）：`child.run_conversation(user_message=goal, task_id=child_task_id)`。`child_task_id` 复用 `subagent_id`，让 file_state、active_subagents registry、TUI 事件**共享同一个 key**。
6. **Tool trace 抽取**（`:1557-1591`）：从 child 的 `messages` 列表反推每次 tool_call + result 的 `args_bytes` / `result_bytes` / `status`，配对靠 `tool_call_id`。
7. **结果聚合**（`:1606-1640`）：返回 `task_index, status, summary, api_calls, duration_seconds, model, exit_reason, tokens.{input,output}, tool_trace, _child_role, _child_cost_usd`。
8. **Cross-agent file-state reminder**（`:1644-1676`）：如果子 agent 写了"父之前读过的文件"，往 summary 末尾追加 `[NOTE: subagent modified files the parent previously read — re-read before editing: …]`。
9. **Cleanup**（`:1764-1810`，finally 块）：
   - 停 heartbeat 线程
   - 卸载 active_subagents registry
   - 释放 credential pool lease
   - 恢复 `model_tools._last_resolved_tool_names` process-global（构造子 agent 时被改写过）
   - 从 `parent._active_children` 移除
   - 调 `child.close()` 释放 terminal sandbox / browser daemon / process_registry / httpx client

### 1.4 调度（单任务 vs 批量）

`delegate_task`（`:1813-2194`）：

- **single 模式**：直接 `_run_single_child(0, …)` 同步跑，无 ThreadPool overhead（`:1976-1980`）。
- **batch 模式**（`:1981-2098`）：
  - `ThreadPoolExecutor(max_workers=max_concurrent_children)`（默认 3，无硬上限，>10 警告）
  - `wait(pending, timeout=0.5, return_when=FIRST_COMPLETED)` 而非 `as_completed`，每 0.5s 检查一次父的 `_interrupt_requested`，被中断则给所有还没完成的 future 伪造 `status="interrupted"` 条目并跳出（`:2008-2044`）
  - 完成顺序乱序，结尾按 `task_index` 排序（`:2098`）
- **Pause kill switch**（`:1841-1848`）：进程级 `_spawn_paused: bool`，TUI 一键暂停**新** spawn（已运行的不影响）。

### 1.5 进度回调（progress relay）

`_build_child_progress_callback`（`:648-832`）构建一个"事件转发器"，把子 agent 内部产生的事件（thinking、tool.started、tool.completed、subagent.start/complete/spawn_requested）转换成两路：

- **CLI 路径**：父 `_delegate_spinner` 的 `print_above`，渲染成树状 `[1] ├─ 🔀 ...` 形式打印在 spinner 上方。
- **Gateway 路径**：父的 `tool_progress_callback`，附带 `subagent_id` / `parent_id` / `depth` / `model` / `toolsets` / `tool_count` 等"identity kwargs"，让 TUI 重建 spawn 树。
- **Event 类型**（`DelegateEvent` enum，`:497-526`）：`task_spawned` / `task_progress` / `task_completed` / `task_failed` / `task_thinking` / `task_tool_started` / `task_tool_completed`，外加 `_LEGACY_EVENT_MAP` 把旧字符串映射到 enum。
- **Tool batching**：每 5 个 tool 名打包成一条 `subagent.progress` 事件转发给上游，避免事件洪流（`:817-822`）。
- **批模式 prefix**：`[task_index+1] ` 前缀只在 `task_count>1` 时加（`:682`）。

### 1.6 中断传播

父 → 子（`run_agent.py:4108-4114`）：`AIAgent.interrupt()` 末尾遍历 `_active_children`，逐个调 `child.interrupt(message)`。子 agent 自身的 `_interrupt_requested` 被翻起来后，子 agent 的 main loop 在下一次 polling 时退出；同时它自己的 `_active_children`（孙子）也会递归 interrupt。

子 → 父（无显式上行）：子 agent 的 `interrupted=True` 出现在结果 dict 里，父在 `_run_single_child` 里把 `status` 设为 `"interrupted"`（`:1547-1548`），并不会自动停掉父的 loop。父收到的就是一份正常的 result 条目，由父 agent 自己决定怎么继续。

TUI 单独中断子 agent：`subagent.interrupt(subagent_id)` RPC（`tui_gateway/server.py:2141-2149`）→ 模块级 `interrupt_subagent(:184-204)` → 在 `_active_subagents` registry 里查记录 → `record["agent"].interrupt(...)`，**不影响兄弟和父**。

### 1.7 Approval 双路径

代码里两套并行的 approval 机制（`tools/delegate_tool.py:52-68` 注释明文说明）：

- **CLI 父进程**：`prompt_dangerous_approval` 通过 `terminal_tool` 模块的 `threading.local()` 存交互回调。**子 worker 线程不继承 TLS**，所以父的"问 stdin"回调不能在子线程跑（会和父的 prompt_toolkit 抢 stdin 死锁）。
  - 解决：子 ThreadPoolExecutor 用 `initializer=_set_subagent_approval_cb` 安装非交互回调（`_subagent_auto_deny` 或 `_subagent_auto_approve`），由 `delegation.subagent_auto_approve` 配置决定（默认 deny）。
  - 两个回调都打 `logger.warning`，留 audit trace。
- **Gateway 会话**：`tools/approval.py` 的 per-session queue，按 `_approval_session_key` ContextVar 路由。ContextVar **会被** `ThreadPoolExecutor` 通过 `copy_context()` 自动继承到子 worker 线程，所以子 agent 的 dangerous-command approval 仍然走父 session 的 `_gateway_queues[session_key]`，由用户在 gateway 客户端正常 `/approve` `/deny`。

### 1.8 Cost 上卷

`_run_single_child` 在 child.close() **之前**抓 `session_estimated_cost_usd`（`:1632-1639`），存到 result 的 `_child_cost_usd`。`delegate_task` 末尾（`:2141-2184`）累加所有子的 cost 加到 `parent.session_estimated_cost_usd`，并升级 `cost_source` 到 `"subagent"`、`cost_status` 到 `"estimated"`。port 自 Kilo-Org/kilocode#9448。

嵌套 orchestrator → worker 链路天然 roll up：每层 `delegate_task()` 把直接子的 cost 折回自己，orchestrator 完成时它的父再把 orchestrator 已经膨胀的 total 折回去。

### 1.9 Hooks

- **`subagent_stop` hook**（`hermes_cli/plugins.py:73`、`hermes_cli/hooks.py:179-186`）：每个 child 完成时触发一次（包括 batch 中每个），**在父线程串行触发**（`tools/delegate_tool.py:2125-2162`），所以 hook 作者不用关心并发。
- 携带的 kwargs：`parent_session_id` / `child_role` / `child_summary` / `child_status` / `duration_ms`。
- 这是**唯一**在 subagent lifecycle 上专门设计的 hook，没有 `subagent_start` 对偶事件。

### 1.10 Gateway TUI 观测面

`tui_gateway/server.py:2107-2150` 提供三个 RPC：

- `delegation.status`：返回 `{active: list_active_subagents(), paused, max_spawn_depth, max_concurrent_children}`，TUI overlay 用来渲染整个 spawn 树。
- `delegation.pause`：set 全局 spawn 暂停标志。
- `subagent.interrupt`：按 `subagent_id` 单独中断一个 child。

TUI 端：`ui-tui/src/components/agentsOverlay.tsx`，快捷键 `x kill` / `X subtree` / `p pause/resume`，`/agents` slash 命令打开。完整 spawn 树快照在 turn 完成时落盘到 `$HERMES_HOME/spawn-trees/<session_id>/<timestamp>.json`（`tui_gateway/server.py:2152-2189`）。

## 二、12 决策对照

### 1. State 边界（子与父共享/独立）

**事实**：

| 维度 | 共享 | 独立 |
|---|---|---|
| Conversation messages | — | 子全新（不继承父 history）|
| `task_id` / terminal session / browser daemon | — | 子独立（subagent_id 复用作 task_id）|
| File ops cache | — | 子独立 |
| `iteration_budget` | — | 子重新构造（`iteration_budget=None`）|
| `_session_db` (SQLite handle) | **共享** | — |
| `parent_session_id` FK 链 | **建立** | — |
| Credential pool（同 provider）| **共享** | — |
| Credential pool（不同 provider）| — | 子加载该 provider 自己的池 |
| `_active_children` 引用 | 父持有子 | — |
| `process_registry` / `terminal sandbox` | — | task_id 隔离 |
| `model_tools._last_resolved_tool_names` process-global | 临时被子改写后再恢复 | — |
| Memory provider / `MEMORY.md` 写入 | — | 子被剥离 `memory` toolset |

### 2. ConfirmationBroker（权限）

**事实**：父子 broker **分流**，按运行平台决定。

- **CLI**：父和子用**两套独立**的 approval callback。父走 `prompt_dangerous_approval` + 交互式 `input()`；子走 `_subagent_auto_deny`（默认）或 `_subagent_auto_approve`（opt-in）。原因：`terminal_tool` 的 callback 用 `threading.local()`，子 worker 线程不继承。配置位 `delegation.subagent_auto_approve`（默认 false）。
- **Gateway**：父子**共享同一个** `_gateway_queues[session_key]`。原因：approval 路由靠 `tools/approval.py:27` 的 ContextVar `_approval_session_key`，ThreadPoolExecutor 通过 `copy_context()` 自动继承，子 worker 线程的 session_key 与父一致，所以子 agent 的 dangerous-command 也排进父 session 的 queue，由用户在 gateway 客户端 `/approve` 或 `/deny`。

### 3. 工具子集契约

**事实**：

- 默认行为：子 toolset 继承父（`enabled_toolsets`），与父 `valid_tool_names` 求交集。
- 强制剥离的 toolset：`delegation` / `clarify` / `memory` / `code_execution`（`_strip_blocked_tools:637-645`）。
- 强制剥离的工具名：`delegate_task` / `clarify` / `memory` / `send_message` / `execute_code`（`DELEGATE_BLOCKED_TOOLS:41-49`）。
- MCP toolset：默认 `inherit_mcp_toolsets=True`，即使 caller 缩窄 toolset 列表，父的 MCP toolset 会被强行保留；可通过 `delegation.inherit_mcp_toolsets: false` 切换为严格交集。
- LLM 可在 schema 里指定 `toolsets: [...]` 缩窄；如果指定的工具父没有，会被求交集后丢掉（不会让子获得父没有的工具）。
- `orchestrator` role 重新把 `delegation` toolset 加回（无视 parent 是否有），是 role-based 而非 inherited 的能力授予。

### 4. 资源预算（max-turns / timeout / token budget）

**事实**：父子**独立**预算。

- `iteration_budget=None`（`:1058`）→ 子在自己的构造函数里 `IterationBudget(max_iterations)` 重新建。
- `max_iterations` 走 `delegation.max_iterations` 配置（默认 50）；caller 即使在 schema 里塞 `max_iterations` 也被忽略并 log（`:1872-1882`），权威值来自 config。
- 子 timeout：`delegation.child_timeout_seconds`（默认 600s，floor 30s）。超时后父收到 `status="timeout"`，子被 interrupt，executor `shutdown(wait=False)`。
- Token budget：父子完全独立，`session_prompt_tokens` / `session_completion_tokens` 在子上自己累计；最后 cost 折回父（决策 11）。
- 唯一"共享" token budget 的语境：`AGENTS.md:92` 注释把 `max_iterations` 描述为 "tool-calling iterations (shared with subagents)" — 但这是**上限语义**而非真正共享池：父和子各自有自己 50 turn 上限，total 跨父子可超出（注释明文说明）。

### 5. Orchestrator 模块归属

**事实**：实现集中在 `tools/delegate_tool.py`（2525 行单文件）。无单独 orchestrator 子模块、无单独 service 层。

调用方：

- LLM 把 `delegate_task` 当普通工具调用（function-calling）→ `tools.registry` 路由到 handler。
- handler 拿到 `parent_agent` reference（kwargs 里），所以子 agent 知道父的所有 state（toolsets / credential / depth / session_db / 中断标志）。
- 没有"父 agent 不知道子 agent"的解耦：父 agent 的 `_active_children` list 是父持有的字段。

模块内部分层：

- `_normalize_role` / `_get_max_concurrent_children` / `_get_max_spawn_depth` / `_get_orchestrator_enabled`：配置读取层
- `_build_child_system_prompt` / `_strip_blocked_tools` / `_preserve_parent_mcp_toolsets`：prompt + toolset 构造层
- `_build_child_progress_callback`：事件中继层
- `_build_child_agent`：构造层
- `_run_single_child`：执行+timeout+heartbeat+cleanup 层
- `delegate_task`：调度+aggregation+hook 触发层
- `_resolve_delegation_credentials` / `_resolve_child_credential_pool` / `_load_config`：辅助层
- `set_spawn_paused` / `interrupt_subagent` / `list_active_subagents` / `_register_subagent` / `_unregister_subagent`：跨 invocation 的进程级 registry，被 TUI/gateway RPC 反向调用

### 6. 流式可见性

**事实**：**子的中间 tool_call / reasoning 不进父 LLM 上下文**。父只在 LLM 上下文里看到 `delegate_task` 工具的最终 JSON 结果（results 数组，每条含 summary）。

但是子的进度事件**会**冒泡到父的 UI 层（不进 LLM context）：

- CLI：子的 thinking、tool start 渲染成 `[1] ├─ 💭 "..."` / `[1] ├─ 🔀 ...` 树状打印，由父 spinner 的 `print_above` 输出。
- Gateway：子的事件批处理后通过父的 `tool_progress_callback` 转发到 SSE/WebSocket 流，TUI 用 `subagent_id` 重建树。
- API server（OpenAI-compatible）：`gateway/platforms/api_server.py:2338` 注释明文 "_thinking and subagent_progress are intentionally not forwarded" — API 流里不暴露 subagent 中间事件。

子的最终 summary 形态：`results: [{task_index, status, summary, api_calls, duration_seconds, model, exit_reason, tokens, tool_trace}, ...]`，作为 `delegate_task` tool_result 的 content 写回父 message 队列。

### 7. 错误传播语义

**事实**：子失败 → 父收到结构化 result 条目，父 agent 不会因此自动失败。

`status` 取值（`:1547-1555`）：

- `"interrupted"`：子 agent 收到 interrupt 信号
- `"completed"`：子有 summary（`final_response` 非空）
- `"failed"`：子无 summary，附 `error` 字段
- `"timeout"`：单 worker timeout（包括 0-API-call 时附 `diagnostic_path`）
- `"error"`：worker 抛异常（包括 `concurrent.futures` 包装的）

异常被吃在 worker 边界，转成 result dict（`:1740-1762`），父的 LLM 拿到的是普通 tool_result JSON。

`exit_reason` 字段独立提供："completed" / "max_iterations" / "interrupted" / "timeout" / "error"，比 `status` 信息更细。

### 8. 递归限制

**事实**：

- 默认 `max_spawn_depth=1`（**flat**，父 0 → 子 1，孙子被拒绝）。
- 可通过 `delegation.max_spawn_depth` 提到 2 或 3（`_MAX_SPAWN_DEPTH_CAP=3` 硬上限）。
- 即使 `max_spawn_depth>=2`，子默认 `role="leaf"` 不能再 spawn；必须父显式传 `role="orchestrator"` 给子，子才保留 `delegation` toolset。
- Kill switch：`delegation.orchestrator_enabled=false`（默认 true）→ 所有 `role="orchestrator"` 静默 degrade 到 leaf。
- 二层防护：`delegate_task` 入口检查 `depth >= max_spawn_depth` 直接 return error；`_strip_blocked_tools` 默认剥离 `delegation` toolset。两道防线，role-based 解锁需要同时通过两道。

### 9. 审计与 transcript

**事实**：

- **SQLite session DB 持久化**：子 agent 拿到父的 `_session_db`，调 `create_session(session_id=…, parent_session_id=parent.session_id, source=…)`（`run_agent.py:1565-1578`），子的所有 message 都通过 `_flush_messages_to_session_db`（`:3451-3490`）落盘。
- **默认在 list 视图被隐藏**（`hermes_state.py:893-970`，`list_sessions_rich`）：默认 `include_children=False` 排除 subagent 子 session，避免 UI 列表被 spawn 子会话污染。
- **Trajectory JSONL**：父 `save_trajectories` flag 不显式传给子（`_build_child_agent` 没有这个参数）→ 子的 `save_trajectories=False`（默认）。所以**子不写 trajectory_samples.jsonl**。
- **Spawn-tree 快照**（`tui_gateway/server.py:2152-2189`）：TUI 在 turn 完成时把组装好的 spawn 树（含每个 subagent 的 metadata、tools、duration、tokens、cost、files_read/written、output_tail）写到 `$HERMES_HOME/spawn-trees/<session_id>/<timestamp>.json`，并在 `_index.jsonl` 留索引。`/replay` `/replay-diff` 可回放。
- **Subagent_stop hook 留 audit**：每个 child 完成触发一次，hook 作者可写 log。
- **0-API-call timeout 诊断**：写到 `~/.hermes/logs/subagent-timeout-<sid>-<ts>.log`，包含 child config、prompt/tool schema 大小、activity summary、worker thread 的 Python stack（`:1099-1241`）。
- **Cross-agent file-state**：`tools/file_state.py` 的进程内 registry 跟踪 (mtime, read_ts, partial)，子 agent 完成时自动检查"子写了父读过的文件"并往 summary 末尾追加 reminder（`:1644-1676`）。

### 10. Abort 双向传播

**事实**：

- **父 abort → 子**：`AIAgent.interrupt()` 末尾遍历 `self._active_children`（`run_agent.py:4108-4114`）逐个 `child.interrupt(message)`，递归到孙子。
- **批模式入口轮询父中断**：`delegate_task` 用 `wait(pending, timeout=0.5, FIRST_COMPLETED)` 替代 `as_completed`，每 0.5s 检查父 `_interrupt_requested`，被中断则给所有 pending future 伪造 `interrupted` 条目（`:2008-2044`）。
- **子 fail → 父**：子失败**不**自动中断父。父收到的是 `delegate_task` tool_result 里的 `status="failed"` 条目，由父的 LLM 决定后续行为。
- **TUI 单点中断**：`subagent.interrupt(subagent_id)` 只中断一个 subagent，不影响兄弟/父。
- **Per-turn 清理 vs 完全 close**（`run_agent.py:4415-4486`）：
  - `release_clients`（per-turn）：仅清子 agent 的 OpenAI/httpx client + `_active_children.clear()`，**不**杀 task_id 关联的 process_registry / terminal sandbox / browser daemon（这些跨 turn 持续）。
  - `close`（hard teardown）：杀 process_registry、清 terminal sandbox、关 browser daemon、close 所有 children、关 OpenAI client。

### 11. Token / 成本归属

**事实**：

- 子 agent 自己的 `session_prompt_tokens` / `session_completion_tokens` / `session_estimated_cost_usd` 在子身上独立累计。
- `_run_single_child` 在 `child.close()` **之前**抓快照存到 result（`:1602-1640`，包括 `tokens.input/output` + `_child_cost_usd`）。
- `delegate_task` 末尾把所有子的 cost 折回父：`parent.session_estimated_cost_usd += sum(_child_cost_usd)`（`:2141-2184`）。
- `cost_source` 升级到 `"subagent"`、`cost_status` 升级到 `"estimated"`，避免 UI 把 subagent-only 的 turn 错标为 "none"。
- 嵌套 orchestrator → worker 自动 roll up：每层 delegate_task 折回直接子，orchestrator 完成时它已经膨胀的总数被它的父再折一次。
- 进度回调里也带 token / cost / api_calls / reasoning_tokens 的 per-branch 数据（`:1705-1730`，`subagent.complete` 事件 payload），TUI overlay 据此显示。

### 12. CLI / Gateway / Channel 三方 UX

**事实**：

- **CLI**：父 spinner 用 `print_above`，渲染成 `[1] ├─ 🔀 短 goal` / `[1] ├─ 💭 "短 thinking"` / `[1] ├─ 🔧 toolname "短 args"` 树形。批模式末尾打 `✓ [1/3] task label  (duration s)` + 更新 spinner 文本 `🔀 N tasks remaining`。
- **Gateway TUI（ink+react，`ui-tui/`）**：通过 `delegation.status` RPC 拉 active subagents 列表 + spawn 树；`/agents` 命令打开 overlay；快捷键 `x kill` / `X subtree` / `p pause/resume`；overlay 显示每分支 tokens / cost / files_touched / output tail。
- **Gateway 平台（telegram / discord / signal / slack / matrix / email / 等）**：子的 thinking 和 subagent_progress 事件**默认不**通过 platform message channel 转发出去（`gateway/platforms/api_server.py:2338` 注释；platform 实现各自决定是否抛弃低层事件）。最终用户只看父 agent 的 final response，summary 已经把子的成果合并写入。
- **ACP（Agent-Client-Protocol）外部子 agent**：`acp_command` / `acp_args` 参数允许从任何父（CLI / Discord / Telegram）通过 ACP subprocess 启动一个 Claude Code / Copilot 等外部 ACP agent 当作子。设置 `acp_command="claude", acp_args=["--acp", "--stdio"]`，子的 provider 强制为 `"copilot-acp"`（`:1005-1009`），子 agent 通过 `CopilotACPClient` 走 stdio JSON-RPC 与外部 agent 通信。

## 三、关键代码片段

### 3.1 子 agent 整体阻塞 contract（`tools/delegate_tool.py:1-17`）

```python
"""
Delegate Tool -- Subagent Architecture

Spawns child AIAgent instances with isolated context, restricted toolsets,
and their own terminal sessions. Supports single-task and batch (parallel)
modes. The parent blocks until all children complete.

Each child gets:
  - A fresh conversation (no parent history)
  - Its own task_id (own terminal session, file ops cache)
  - A restricted toolset (configurable, with blocked tools always stripped)
  - A focused system prompt built from the delegated goal + context

The parent's context only sees the delegation call and the summary result,
never the child's intermediate tool calls or reasoning.
"""
```

### 3.2 永远禁止的工具（`tools/delegate_tool.py:41-49`）

```python
DELEGATE_BLOCKED_TOOLS = frozenset(
    [
        "delegate_task",  # no recursive delegation
        "clarify",  # no user interaction
        "memory",  # no writes to shared MEMORY.md
        "send_message",  # no cross-platform side effects
        "execute_code",  # children should reason step-by-step, not write scripts
    ]
)
```

### 3.3 Approval 双路径分流注释（`tools/delegate_tool.py:52-68`）

```python
# Subagents run inside a ThreadPoolExecutor worker. The CLI's interactive
# approval callback is stored in tools/terminal_tool.py's threading.local(),
# so worker threads do NOT inherit it. Without a callback,
# prompt_dangerous_approval() falls back to input() from the worker thread,
# which deadlocks against the parent's prompt_toolkit TUI that owns stdin.
#
# Fix: install a non-interactive callback into every subagent worker thread
# via ThreadPoolExecutor(initializer=_set_subagent_approval_cb, initargs=(cb,)).
# The callback is chosen by the `delegation.subagent_auto_approve` config:
#   false (default) → _subagent_auto_deny (safe; matches leaf tool blocklist)
#   true            → _subagent_auto_approve (opt-in YOLO for cron/batch)
# Both emit a logger.warning for audit; gateway sessions are unaffected
# because they resolve approvals via tools/approval.py's per-session queue,
# not through these TLS callbacks.
```

### 3.4 父 → 子 interrupt 传播（`run_agent.py:4107-4114`）

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

### 3.5 子 AIAgent 实例化的关键参数（`tools/delegate_tool.py:1030-1059`）

```python
child = AIAgent(
    base_url=effective_base_url,
    api_key=effective_api_key,
    model=effective_model,
    provider=effective_provider,
    api_mode=effective_api_mode,
    acp_command=effective_acp_command,
    acp_args=effective_acp_args,
    max_iterations=max_iterations,
    max_tokens=getattr(parent_agent, "max_tokens", None),
    reasoning_config=child_reasoning,
    prefill_messages=getattr(parent_agent, "prefill_messages", None),
    enabled_toolsets=child_toolsets,
    quiet_mode=True,
    ephemeral_system_prompt=child_prompt,
    log_prefix=f"[subagent-{task_index}]",
    platform=parent_agent.platform,
    skip_context_files=True,
    skip_memory=True,
    clarify_callback=None,
    thinking_callback=child_thinking_cb,
    session_db=getattr(parent_agent, "_session_db", None),
    parent_session_id=getattr(parent_agent, "session_id", None),
    providers_allowed=parent_agent.providers_allowed,
    providers_ignored=parent_agent.providers_ignored,
    providers_order=parent_agent.providers_order,
    provider_sort=parent_agent.provider_sort,
    tool_progress_callback=child_progress_cb,
    iteration_budget=None,  # fresh budget per subagent
)
```

### 3.6 子 agent 子 task 执行 + 超时（`tools/delegate_tool.py:1411-1436`）

```python
# Run child with a hard timeout to prevent indefinite blocking
# when the child's API call or tool-level HTTP request hangs.
child_timeout = _get_child_timeout()
_timeout_executor = ThreadPoolExecutor(
    max_workers=1,
    # Install a non-interactive approval callback in the worker thread
    # so dangerous-command prompts from the subagent don't fall back to
    # input() and deadlock the parent's prompt_toolkit TUI.
    # Callback (deny vs approve) is governed by delegation.subagent_auto_approve.
    initializer=_set_subagent_approval_cb,
    initargs=(_get_subagent_approval_callback(),),
)

def _run_with_thread_capture():
    _worker_thread_holder["t"] = threading.current_thread()
    return child.run_conversation(
        user_message=goal,
        task_id=child_task_id,
    )

_child_future = _timeout_executor.submit(_run_with_thread_capture)
result = _child_future.result(timeout=child_timeout)
```

### 3.7 Cross-agent file-state reminder（`tools/delegate_tool.py:1644-1676`）

```python
# Cross-agent file-state reminder.  If this subagent wrote any
# files the parent had already read, surface it so the parent
# knows to re-read before editing — the scenario that motivated
# the registry.
try:
    if parent_task_id and parent_reads_snapshot:
        sibling_writes = file_state.writes_since(
            parent_task_id, wall_start, parent_reads_snapshot
        )
        if sibling_writes:
            mod_paths = sorted({p for paths in sibling_writes.values() for p in paths})
            if mod_paths:
                reminder = (
                    "\n\n[NOTE: subagent modified files the parent "
                    "previously read — re-read before editing: "
                    + ", ".join(mod_paths[:8])
                    ...
                )
                if entry.get("summary"):
                    entry["summary"] = entry["summary"] + reminder
```

### 3.8 Cost roll-up 到父（`tools/delegate_tool.py:2164-2184`）

```python
# Fold the aggregated child cost into the parent's session total.  This is
# additive — each delegate_task call contributes its own children — so
# nested orchestrator→worker trees roll up naturally
if _children_cost_total > 0.0:
    try:
        current = float(getattr(parent_agent, "session_estimated_cost_usd", 0.0) or 0.0)
        parent_agent.session_estimated_cost_usd = current + _children_cost_total
        if getattr(parent_agent, "session_cost_source", "none") in (None, "", "none"):
            parent_agent.session_cost_source = "subagent"
        if getattr(parent_agent, "session_cost_status", "unknown") in (None, "", "unknown"):
            parent_agent.session_cost_status = "estimated"
```

### 3.9 配置默认值（`cli-config.yaml.example:790-808`）

```yaml
# Subagent Delegation
delegation:
  max_iterations: 50                          # Max tool-calling turns per child (default: 50)
  # max_concurrent_children: 3                # Max parallel child agents per batch (default: 3)
  # max_spawn_depth: 1                        # Delegation tree depth cap (range: 1-3, default: 1 = flat)
  # orchestrator_enabled: true                # Kill switch for role="orchestrator" children (default: true)
  # subagent_auto_approve: false              # When a subagent hits a dangerous-command approval prompt, auto-deny (default: false) or auto-approve "once" (true)
  # inherit_mcp_toolsets: true                # When explicit child toolsets are narrowed, also keep the parent's MCP toolsets (default: true)
  # model: "google/gemini-3-flash-preview"    # Override model for subagents (empty = inherit parent)
  # provider: "openrouter"                    # Override provider for subagents (empty = inherit parent)
```

### 3.10 Gateway TUI RPC 入口（`tui_gateway/server.py:2113-2150`）

```python
@method("delegation.status")
def _(rid, params: dict) -> dict:
    from tools.delegate_tool import (
        is_spawn_paused, list_active_subagents,
        _get_max_concurrent_children, _get_max_spawn_depth,
    )
    return _ok(rid, {
        "active": list_active_subagents(),
        "paused": is_spawn_paused(),
        "max_spawn_depth": _get_max_spawn_depth(),
        "max_concurrent_children": _get_max_concurrent_children(),
    })


@method("delegation.pause")
def _(rid, params: dict) -> dict:
    from tools.delegate_tool import set_spawn_paused
    paused = bool(params.get("paused", True))
    return _ok(rid, {"paused": set_spawn_paused(paused)})


@method("subagent.interrupt")
def _(rid, params: dict) -> dict:
    from tools.delegate_tool import interrupt_subagent
    subagent_id = str(params.get("subagent_id") or "").strip()
    if not subagent_id:
        return _err(rid, 4000, "subagent_id required")
    ok = interrupt_subagent(subagent_id)
    return _ok(rid, {"found": ok, "subagent_id": subagent_id})
```

## 四、Skills 系统与 subagent 的边界辨析

> 本节回应任务前置判断："hermes 的 Skills 系统是个差异化机制（skills 自主创建/迭代）— 注意区分 skills 和 sub-agent 是不是同一概念"。

**结论**：Skills 与 subagent 是**完全独立的两个机制**，**不**承担类似职责。

### 4.1 Skills 是什么

来自 `tools/skills_tool.py:1-67`、`tools/skill_manager_tool.py:1-33`：

> Skills are the agent's procedural memory: they capture *how to do a specific type of task* based on proven experience. General memory (MEMORY.md, USER.md) is broad and declarative. Skills are narrow and actionable.

Skills 是**目录 + Markdown 文档**：

```
skills/
├── my-skill/
│   ├── SKILL.md           # Main instructions (required)
│   ├── references/        # Supporting documentation
│   ├── templates/         # Templates for output
│   ├── scripts/
│   └── assets/
└── category/
    └── another-skill/
        └── SKILL.md
```

`SKILL.md` 用 YAML front-matter（`agentskills.io` 兼容）描述元信息：name / description / version / platforms / prerequisites / tags。

提供的工具：

- `skills_list`：列出所有 skills（仅 metadata，progressive disclosure tier 1）
- `skill_view`：加载某个 skill 的全文或某个支持文件（tier 2-3）
- `skill_manager`（`tools/skill_manager_tool.py`）：让 agent **自己** create / edit / patch / delete / write_file / remove_file，把成功经验沉淀成新 skill 文档；用户 skill 落到 `~/.hermes/skills/`

借鉴自 Anthropic 的 Claude Skills 概念（progressive disclosure + 标准目录布局）。

### 4.2 Skills 与 subagent 的对照

| 维度 | Skills | Subagent (`delegate_task`) |
|---|---|---|
| 本质 | Markdown 文档 + 元数据，**procedural memory** | 进程内子 AIAgent 实例，**execution unit** |
| 加载时机 | LLM 主动调 `skill_view(name)` 把内容读进 context | LLM 主动调 `delegate_task` 触发 spawn |
| 上下文 | 内容**进入**父 agent context | 内容**不进入**父 agent context（只看 summary）|
| 隔离 | 没有隔离，是 context 增强 | conversation / task_id / toolset / 预算全独立 |
| 工具 | 不持有 toolset，本身不执行任何东西 | 持有受限 toolset，自己跑 conversation |
| 中断 | N/A（静态文档）| 父 → 子级联中断 |
| Token 成本 | 进父 prompt 消耗父 tokens | 子独立 cost，按规则 roll up 给父 |
| 持久化 | 文档存盘 `~/.hermes/skills/` | session 行存 SQLite + spawn-tree 快照 JSON |
| 谁能"改"它 | `skill_manager` 工具：agent 自己可以创建/编辑 skill | 父 agent 用 `delegate_task` 触发，无法"改"子 agent 自身 |
| 安全扫描 | `tools/skills_guard.py` 在 install 时扫描；agent 创建可选扫描 | DELEGATE_BLOCKED_TOOLS 永远剥离危险工具 |

### 4.3 一个边界案例：`subagent-driven-development` skill

`skills/software-development/subagent-driven-development/SKILL.md` 是一个"教 agent 如何使用 `delegate_task`"的 skill 文档。它本身**不是** subagent，是一份 procedural memory，告诉父 agent："读 plan、抽出所有 task、对每个 task 调 `delegate_task` 派 implementer subagent + 调 `delegate_task` 派 reviewer subagent"。

也就是说：**Skills 是给父 agent 看的"如何使用 subagent"教程，subagent 才是真正执行任务的运行实体**。两个机制有协同（skill 教 LLM 怎么 delegate）但完全不重叠。

### 4.4 Skills 不能替代 subagent 做的事

- 不能开 fresh conversation
- 不能持有独立 toolset 子集
- 不能并发跑 N 个独立任务
- 不能受 timeout / iteration budget 控制
- 不能被中断
- 不能跑在不同 provider/model 上
- 不能通过 ACP 协议把外部 Claude Code / Copilot 当成 worker

反过来，subagent 也不能替代 skill：subagent 是**一次性运行实体**，跑完就 close，没有"沉淀经验给下次用"的语义。子 agent 写出的 summary 写回父 message 队列，父 agent 决定是否调 `skill_manager_tool` 把这次经验保存成新 skill。

## 五、未确定 / 存疑点

1. **`save_trajectories=True` 时子 agent 的 trajectory 是否落盘**：`_build_child_agent` 没显式传 `save_trajectories` 给子，子构造时该参数取默认 False。但这是**显式 design** 还是**遗漏**——未在源码注释中找到说明。**事实**：子的 trajectory_samples.jsonl **不写**；但 SQLite 的 messages 表照常写。

2. **嵌套 orchestrator 时的"孙子"工具集**：父 0 → orchestrator 1 → leaf 2，`max_spawn_depth=2`。orchestrator 1 spawn 时 `child_depth=2`，`max_spawn=2`，`orchestrator_ok = enabled and child_depth < max_spawn = false` → orchestrator 1 的子（leaf 2）一定 degrade 到 leaf。逻辑正确，但 `_build_child_system_prompt` 里 orchestrator 注释 "Your own children MUST be leaves" 已经写明这个事实，**问题在于**：当 `max_spawn_depth=3` 时这条注释会自动改为 "your own children can themselves be orchestrators"（`:577-585`）— 这段动态文案靠 `child_depth + 1 >= max_spawn_depth` 的预测，但 grandchild 实际能否 delegate 还取决于运行时的 kill switch；prompt 不读 kill switch，存在模型期望与运行时不一致的窗口。

3. **`session_db=None` 时子 agent 的隔离行为**：当 parent `_session_db=None`（如 batch_runner / 测试场景），子 agent 拿到 `session_db=None`，子的 messages 不会落 SQLite，但仍会跑完。此时 `subagent.complete` payload 里的 `files_read` / `files_written` 仍然来自 `tools/file_state` registry（进程内）而非 DB。**未验证**这种场景下 spawn-tree 快照是否会落盘（TUI 不连接时不会触发）。

4. **MCP toolset 子集合并的最终 schema**：`_preserve_parent_mcp_toolsets` 把父的 MCP toolset 强行加到子，但 `DELEGATE_BLOCKED_TOOLS` 不区分 MCP 工具。如果 MCP server 注册了名叫 `memory` 或 `send_message` 的工具，是否被 `_strip_blocked_tools`（按 toolset 名）漏掉而被子拿到？**代码层面**：`_strip_blocked_tools` 按 toolset 名过滤，不按工具名；MCP toolset 命名是 `mcp-*` 前缀（`_is_mcp_toolset_name`），不会撞 `delegation` / `clarify` / `memory` / `code_execution` 这四个名字 → MCP toolset 整体保留。但如果 MCP server 暴露的某个**工具**叫 `memory`，schema 层面会和 hermes 内置 `memory_tool` 冲突，这种命名冲突的解决在 `tools/registry` 层而非 delegate 层。**未深挖**。

5. **`role="orchestrator"` 与 `acp_command` 的交互**：当父用 `acp_command="claude"` 把子 agent 走 ACP 子进程，那个外部 Claude Code 实例**自己**有 sub-agent 概念（Claude Code 有 Task 工具）。hermes 的 `_delegate_depth` 只在 hermes 进程内自增，跨 ACP 进程边界的"孙子"不在 hermes registry 里。`max_spawn_depth` 因此**只约束 hermes 进程内**的递归，不能阻止外部 ACP agent 自己再 spawn。

6. **`subagent_stop` 是唯一的 lifecycle hook**：没有 `subagent_start` 对偶。`hermes_cli/plugins.py` 里 VALID_HOOKS 没有看到 spawn 时的 hook（只在 progress callback 里发 `subagent.spawn_requested` 事件给 TUI，但 plugin hook 不收）。**事实未变**：plugin 作者只能在 child 完成时拿到 audit 信息，无法在 spawn 前拦截/审批。

7. **批模式的"Too many tasks"硬错**（`:1899-1905`）：tasks 数量 > `max_concurrent_children` 时整个 `delegate_task` 调用失败返回错误，而不是把 tasks 排队跑（每批 N 个并发跑完再下一批）。LLM 必须自己拆批，或者用户调高配置。**这是显式 design**。

