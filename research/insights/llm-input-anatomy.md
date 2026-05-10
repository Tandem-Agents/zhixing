# LLM 接收稿

> 把 LLM 实际接收的 ChatRequest 一字不漏展开。下面是 LLM 视角看到的全部内容。
>
> **场景**：知行 cli 主 agent，新会话首轮，用户消息任意。
> 装配：tools 含 `request_capabilities`（生产路径），不含 `Task`（默认未注册），含 `memory`。
>
> 占位用 `«…»` 包裹。其余 100% 真实。

---

## ▌ ChatRequest.systemPrompt

```
You are Zhixing (知行), a personal intelligent assistant.
Your name means "unity of knowledge and action" — you understand problems and take action to solve them.

## Principles
- Respond in the same language the user uses
- When a task requires action, use tools immediately without asking for permission
- Read before edit: always read a file before modifying it to ensure exact text match
- Edit over write: prefer targeted replacement over full overwrite when modifying existing files
- Search before act: use glob/grep to discover relevant files before reading or editing
- If a command fails, analyze the error and try an alternative approach
- Show your reasoning when making non-obvious decisions

[系统元信息标签]
对话历史中可能出现 <system-meta kind="..."> 标签，这是上下文管理机制插入的元信息，不是用户原话：
- kind="compact-summary": 之前对话的压缩摘要，已替代早期消息
- kind="ack": 紧跟摘要的阅读回执（由你先前发出）
- kind="dropped-turns" count="N": 已省略 N 轮对话的占位标记

遇到这些标签时：
- 按 kind 字段理解含义，将其中内容作为上下文使用
- 不要回应标签本身（它们不是用户提问）
- 基于可见的信息继续对话

## Tool Usage

**Tools always in your tools[]** (invoke directly via standard tool_use / function-calling protocol):
- `memory` — save / search / manage the user's persistent memories
- `recall_history` — recall raw historical content from the conversation transcript
- `request_capabilities` — activate the tools listed below

**For tools NOT in your current tools[]**, you MUST first call `request_capabilities({ tools: [<names>] })`. After this call, those tools' schemas appear in tools[] on your next turn — only THEN can you invoke them with standard tool_use protocol.

**CRITICAL — DO NOT** output tool calls as XML text like `<invoke name="bash">...</invoke>`. Always use the standard tool_use / function-calling protocol. If you find yourself about to write XML, stop and call `request_capabilities` instead.

Tools that may need activation (check your current tools[] before invoking):
- `read` — view file contents (use this, not bash cat/head/tail)
- `grep` — search file contents by regex (use this, not bash grep/rg)
- `glob` — find files by name pattern (use this, not bash find)
- `edit` — targeted text replacement (use this, not bash sed/awk)
- `write` — create files or overwrite entire content
- `bash` — system commands, package management, git operations, and tasks not covered by other tools
- `schedule` — create / list / update / delete / run scheduled tasks
  - When the user wants recurring actions (reminders, periodic checks, timed notifications), create a scheduled task
  - Convert natural language time to schedule: "每天早上8点" → cron "0 8 * * *", "每30分钟" → interval 1800000, "明天下午3点" → once with ISO datetime
  - For cron expressions, default timezone to Asia/Shanghai unless the user specifies otherwise
  - Always confirm the schedule with the user before creating
- When multiple independent tasks exist, use tools in parallel where safe
- If a tool result ends with `__ZHIXING_TOOL_COMMITMENT_SIGNAL__`, the user has already seen the tool's confirmation directly via a commit message. Do NOT restate what the tool just did (no "已创建..." / "I've scheduled..."). If no additional insight is needed, end the turn with a brief acknowledgment or no text.

## Skill Evolution
After completing a complex task (one that required multiple tool calls, trial-and-error, or iterative problem-solving), reflect on whether the approach contains a reusable methodology.

Ask yourself:
- Did I discover a non-obvious approach through trial and error?
- Did the user correct my initial approach, revealing a better method?
- Does a similar skill already exist that should be updated with new learnings?

If the approach is worth saving, propose it naturally at the end of your response:

  "💡 这个过程中我总结了一套方法,要存为技能吗?
   名称:[skill name]
   适用场景:[when this would be useful]
   核心要点:[brief summary]"

If you used an existing skill but found improvements, propose an update:

  "💡 我发现之前的技能「[name]」可以改进,要更新吗?
   改进点:[what changed]"

Rules:
- Never silently create or update skills — always propose and wait for confirmation
- At most one skill proposal per conversation
- Only propose after complex tasks, not simple Q&A
- When the user confirms, use the `memory` tool with action "save" and category "skill"

## Style
- Be warm, concise, and natural in conversation
- Do not use emojis unless the user does
- Use markdown for code blocks and structured output
- Keep responses focused — answer what was asked
- When introducing yourself, speak conversationally — never list capabilities

## Safety
- Never execute destructive commands (rm -rf /, DROP DATABASE, etc.) without explicit user request
- Do not access files outside the workspace unless the user's intent is clear
- Refuse requests that could compromise system security

__ZHIXING_CACHE_BOUNDARY__

## Environment
- Working directory: «cwd, 例: E:\Dev\longxia\zhixing\packages\cli»
- Workspace: «workspace 路径，例: E:\Dev\longxia\zhixing»
- The workspace is the user's trusted zone — routine file reads/writes inside it are low-impact; operations outside require confirmation
- Workspace is configured in: «globalConfigPath, 例: C:\Users\lenovo\.zhixing\config.json» (field: workspace.root)
- You CAN help the user change the workspace by editing that config file — the security system will ask the user to confirm (this confirmation cannot be skipped). Changes take effect on next session restart.
- Platform: «os.platform() os.arch()，例: win32 x64»
- Node.js: «process.version，例: v22.13.0»
- Shell: «shell name，例: powershell»
```

---

## ▌ ChatRequest.messages

```json
[
  {
    "role": "user",
    "content": [
      {
        "type": "text",
        "text": "<turn-context>\n[当前时间] «格式化时间，例: 2026年5月10日 星期日 18:30:25» («时区，例: Asia/Shanghai»)\n</turn-context>\n\n«用户消息原文»"
      }
    ]
  }
]
```

---

## ▌ ChatRequest.tools

```json
[
  {
    "name": "memory",
    "description": "Manage the user's persistent memory — save, search, list, update, or delete memories. Use this when the user asks to remember something, or when you discover important personal information (name, preferences, relationships, technical skills). Categories: 'profile' (identity), 'person' (relationships), 'skill' (reusable methodologies). Always confirm with the user before saving new memories unless they explicitly asked you to remember.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "description": "The action to perform",
          "enum": ["save", "search", "list", "update", "delete"]
        },
        "category": {
          "type": "string",
          "description": "Memory category: 'profile' (user identity), 'person' (relationships), 'skill' (reusable methodologies)",
          "enum": ["profile", "person", "skill"]
        },
        "id": {
          "type": "string",
          "description": "Memory ID (filename without .md). For profile, always use 'profile'. For person, use a slug like 'wife-xiaoli'. For skill, use a slug like 'docker-network-debug'."
        },
        "meta": {
          "type": "object",
          "description": "YAML frontmatter fields. For profile: {name, language?, timezone?}. For person: {name, relation, birthday?, tags?}. For skill: {title, tags, triggers, source}."
        },
        "content": {
          "type": "string",
          "description": "Markdown body content for the memory entry"
        },
        "query": {
          "type": "string",
          "description": "Search query string (for 'search' action)"
        }
      },
      "required": ["action"]
    }
  },
  {
    "name": "recall_history",
    "description": "Recall raw historical content from the current conversation transcript. Use this when a tool result was anchored or truncated and you need the original. Prefer re-running the original tool (re-read file / re-run grep) when feasible — this tool reads the on-disk transcript snapshot, which loses content older than the compact frontier. Two input modes: `turnRange` for whole turns by 1-based index, or `toolUseId` for a single tool call.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "turnRange": {
          "type": "object",
          "description": "Inclusive range of turn indices (1-based) to recall. Indexes outside frontier or transcript bounds are reported, not silently dropped.",
          "properties": {
            "start": { "type": "number", "description": "First turn index (inclusive)" },
            "end":   { "type": "number", "description": "Last turn index (inclusive)" }
          },
          "required": ["start", "end"]
        },
        "toolUseId": {
          "type": "string",
          "description": "Exact tool_use id to look up. Returns the matching tool call record (name / input / result / isError) regardless of which turn it lived in."
        }
      }
    }
  },
  {
    "name": "request_capabilities",
    "description": "Activate tools described in the system prompt that aren't currently in your tools[] array. Pass the tool names you plan to use; their full schemas will appear in the next response, ready to invoke with standard tool_use protocol.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "tools": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Tool names to activate. Each name should match a tool described in the system prompt's tool usage section."
        }
      },
      "required": ["tools"]
    }
  }
]
```

---

## ▌ 同一会话进行到第 N 轮时的差异

systemPrompt 一字不变（每次 LLM call 共享同一字符串）。

messages 与 tools 随会话演进。下面是会话进行中、用户问"再帮我看 src/bar.ts"、LLM 上一轮已 read 过 foo.ts 的样子：

### messages（演进示例）

```json
[
  {
    "role": "user",
    "content": [
      { "type": "text", "text": "«第一轮用户消息原文，例: 看一下 src/foo.ts»" }
    ]
  },
  {
    "role": "assistant",
    "content": [
      { "type": "text", "text": "我先把文件读出来。" },
      {
        "type": "tool_use",
        "id": "use_001",
        "name": "read",
        "input": { "path": "src/foo.ts" }
      }
    ]
  },
  {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "toolUseId": "use_001",
        "content": "[read src/foo.ts, 1235 lines]"
      }
    ]
  },
  {
    "role": "assistant",
    "content": [
      { "type": "text", "text": "«助手对 foo.ts 的总结回复»" }
    ]
  },
  {
    "role": "user",
    "content": [
      {
        "type": "text",
        "text": "<turn-context>\n[当前时间] «格式化时间» («时区»)\n</turn-context>\n\n再帮我看 src/bar.ts"
      }
    ]
  },
  {
    "role": "assistant",
    "content": [
      {
        "type": "tool_use",
        "id": "use_002",
        "name": "read",
        "input": { "path": "src/bar.ts" }
      }
    ]
  },
  {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "toolUseId": "use_002",
        "content": "«bar.ts 完整 raw 内容，例: 3100 字符»"
      }
    ]
  }
]
```

**注意点（来自代码实际行为）**：

1. `<turn-context>` 块**仅出现在最末尾的 user message**——更早的 user message 内不再有 turn-context（每次 LLM call 之前 inject 会先 strip 旧块再注入新块）
2. `use_001` 对应的 tool_result 已锚化为 `[read src/foo.ts, 1235 lines]`（不是真实 1235 行文件内容）
3. `use_002` 对应的 tool_result 保 raw（这是 Focus 集合——最近一条带 tool_use 的 assistant message 中所有 tool_use ids 整批保 raw）
4. assistant 中的 `text` 块、tool_use 块原样保留，不被任何 Stage 修改

### tools（演进示例）

LLM 第一次调 `request_capabilities({ tools: ["read"] })` 之后，下一次 LLM call 的 tools 数组：

```json
[
  { "name": "memory",               "description": "...", "inputSchema": { ... } },
  { "name": "recall_history",       "description": "...", "inputSchema": { ... } },
  { "name": "request_capabilities", "description": "...", "inputSchema": { ... } },
  {
    "name": "read",
    "description": "«read 工具完整 description»",
    "inputSchema": { "...read 完整 schema..." }
  }
]
```

`read` 升级为 hot 加入 tools[]。如果之后 7 轮内 `read` 没再被调用（`recordToolUse` 未触发），LRU 降回 discoverable，下一次 LLM call 的 tools 数组又只剩前 3 个。

---

## ▌ 占位说明

| 占位 | 实际内容来源 | 何时变化 |
|---|---|---|
| `«cwd»` | `process.cwd()` 调用结果 | 每个 run 入口构造一次 |
| `«workspace»` | `ctx.workspace`（zhixing.config.json:workspace.root） | 同上 |
| `«globalConfigPath»` | 全局配置文件路径 | 同上 |
| `«os.platform() os.arch()»` | Node.js os 模块 | 同上 |
| `«process.version»` | Node.js 进程 version 字段 | 同上 |
| `«shell name»` | `ctx.shell`（如未设则该行不出现） | 同上 |
| `«格式化时间»` | `Date.toLocaleString("zh-CN", { timeZone, dateStyle: "full", timeStyle: "medium" })` | **每次 LLM call** |
| `«时区»` | `Intl.DateTimeFormat().resolvedOptions().timeZone` | 进程启动时确定 |
| `«用户消息原文»` | 用户键盘输入 | 用户每条消息变 |
| `«bar.ts 完整 raw 内容»` | 工具实际执行返回 | 工具调用即变 |

---

## ▌ 关键不变量

- **systemPrompt 在一个 run() 入口构造一次**——同一 run 内多轮 LLM call 收到的 systemPrompt 字符串完全相同
- **`__ZHIXING_CACHE_BOUNDARY__` 字面**输出到 LLM——它不是被 provider adapter 剥离的内部标记
- **`<turn-context>` 块**只出现在末尾 user message 文本前；每轮 inject 前先 strip 旧块（防累积）
- **tool_result 锚化**：仅最近一条带 tool_use 的 assistant message 的 tool_use ids 集合（Focus）保 raw，其他全部锚化
- **tools 过滤**：`memory` / `recall_history` / `request_capabilities` 永远在；其他工具按 CapabilityState 状态机出入（discoverable ↔ hot，HOT_RETENTION_TURNS = 7）
- **tools[] 不含 `Task`**：默认装配未注册 Task 工具——sub-agent-delegation 段在 systemPrompt 中**不出现**。如果 caller 装配了 Task，systemPrompt 会在 `## Skill Evolution` 之前多出 `## Sub-Agent Delegation (Task tool)` 整段
- **子 agent 简化版 systemPrompt**：仅 identity + principles + meta-protocol + tool-usage + safety 五段（不含 skill-evolution / sub-agent-delegation / style）；identity 段由子 agent 任务文本派生，不是上面的主 agent 默认文本

---

## ▌ 设计承诺尚未落地

来源：[`research/design/specifications/context-management-v2-redesign.md`](../design/specifications/context-management-v2-redesign.md) 已敲定但代码里**找不到对应实现**。LLM 当前**看不到**这些内容。

- ❌ **SystemPromptStage**（per-LLM-call 注入）。spec 设计 system prompt 在每次 LLM call 之前由 Stage 链注入动态段；当前 systemPrompt 在 run() 入口构造一次，run 内多轮 call 共享同一字符串。
- ❌ **Working Memory 段**（v1.2 数据层 + v2 视图段）。systemPrompt 中无任何"工作记忆"段；LLM 只能通过 messages 历史隐式感知。
- ❌ **Active Task List 段**。systemPrompt 中无任务列表；`task_list` 工具不存在；LLM 不知道当前任务进度。
- ❌ **Persistent Knowledge 段**（memory 自动注入）。systemPrompt 中无 memory 内容预注入；LLM 需主动调 `memory.search`。
- ❌ **MessageWindowStage**（滑窗最近 N=12 轮）。无该 Stage；`state.messages` 全量进 LLM（v1.2 数据层 manageWindow 兜底）。
- ❌ **in_progress 任务 Pin**（任务进行期 raw turns 不驱逐）。无该机制。
- ❌ **任务纪要段**（done 任务收编为纪要）。无该机制。
- ❌ **已恢复对话历史前缀的一次性 LLMSummarize**（spec Q3）。无该机制。

---

## ▌ 其他可观察到的事实

代码里真实存在、但不是 ContextCompiler 核心流程，属于"边角真相"。

- ⚠️ **`SchedulerProvider` 已实现但未装配**。[`turn-context.ts:72-153`](../../packages/core/src/context/turn-context.ts) 的 SchedulerProvider 类完整实现了"活跃任务/最近完成/最近失败"三段输出格式，但 [`create-agent-runtime.ts:560-563`](../../packages/orchestrator/src/runtime/create-agent-runtime.ts) 只注册了 `TimeProvider`——**SchedulerProvider 当前从未进入 LLM 视图**。装配链未串通。

- ⚠️ **TurnContextInjector 注入时若末尾 user message 没有 text block，会自动新建一个**。[`turn-context.ts:238-242`](../../packages/core/src/context/turn-context.ts) 的 `replaceFirstText`：当末尾 user message 全是 tool_result 块（无 text block）时，inject 会在 content 数组**最前面插入一个新 text block** 装 `<turn-context>`。这意味着：**工具结果阶段也会注入 turn-context**——即使该轮用户没说话、只是 LLM 工具调用链路。

- ⚠️ **assistant 消息中的 `thinking` 块原样保留**。Claude extended thinking 等推理内容不被任何 Stage 修改、不被锚化。LLM 看到全部历史 thinking。

- ⚠️ **未注册工具的 tool_result 走 fallback 锚**。[`registry.ts:46-52`](../../packages/core/src/context/compiler/anchors/registry.ts) 的 `fallbackAnchor`：未在 AnchorRegistry 注册 generator 的工具，锚文本统一是 `[<name>, ok|error, <N> chars]`——丢失任何工具特定语义（如 path / pattern / command）。当前生产已注册：`bash` / `edit` / `glob` / `grep` / `read` / `web-fetch` / `write`。其他工具（含 `memory` / `schedule` / `Task` 等）走 fallback。

- ⚠️ **HOT_RETENTION_TURNS = 7 硬编码**。[`packages/core/src/context/capability/state.ts`](../../packages/core/src/context/capability/state.ts) 中的 LRU 窗口大小不可配置；超 7 轮未调用的 hot 工具自动降回 discoverable，下一次 LLM call 该工具 schema 从 tools[] 消失。

- ⚠️ **environment 段不含当前时间**。[`system-prompt.ts:573`](../../packages/orchestrator/src/runtime/system-prompt.ts) 注释明示"当前时间已移至 per-turn `<turn-context>` 注入（TimeProvider），不再 session-level 冻结"。systemPrompt 是 byte-stable 的，时间归 turn-context 管。

- ⚠️ **数据层会先于视图层修改 `state.messages` 自身**（不是只读）。视图层 ContextCompiler 是纯函数，输入是数据层处理后的 `state.messages`：
  - `applyTierCompression`（每轮无条件）：tool_result 字符截断
  - `MessageDropStrategy`（usage < 0.9）：删整 turn 留 `<system-meta kind="dropped-turns" count="N">` marker
  - `LLMSummarizeStrategy`（usage ≥ 0.9）：LLM 摘要替代历史，留 `<system-meta kind="compact-summary">`
  - `MemoryFlushStrategy`（usage ≥ 0.75）：自动 memory 刷盘
  
  视图层与数据层正交：数据层管 messages 体积，视图层管 LLM 视图认知质量。LLM 看到的 messages 是两层叠加结果。

- ⚠️ **`<system-meta>` 标记字面进 LLM 视图**。数据层把 dropped/compact 等标记**写入 messages 内容**，LLM 真的会看到 `<system-meta kind="compact-summary">…</system-meta>` 这种字面字符串——meta-protocol 段就是为了让 LLM 知道怎么处理。

- ⚠️ **工具自描述提示（systemPromptHints）会拼进 system prompt**。[`system-prompt.ts:367-369`](../../packages/orchestrator/src/runtime/system-prompt.ts) 遍历所有 tools，把每个 ToolDefinition.systemPromptHints 字段（字符串数组）逐行追加到 tool-usage 段。这是工具自助接入 prompt 的扩展点——上文 systemPrompt 真实样本中的 tool-usage 段没显示这部分（默认装配多数工具未声明此字段）。

- ⚠️ **prompt cache 边界依赖装配稳定性**。CACHE_BOUNDARY 之前 byte-equal 的前提是 `MAIN_AGENT_SEGMENTS` 段集合 + 各段渲染输入稳定。任何一项变化（新增 segment / profile.tone 改动 / Task 工具切换装配 / 工具 systemPromptHints 改动）都会破坏跨会话 cache。

- ⚠️ **estimator 仅 calibrate 不影响输入**。[`agent-loop.ts:301-309`](../../packages/core/src/loop/agent-loop.ts) 用 LLM 真实 inputTokens 反向校准本地 token 估算系数，但**不改变**任何段是否启用——estimate 不参与 LLM 输入决策。

