# Claude Code — 子 Agent 与 Task 工具实现分析

> **分析状态**: 已分析(2026-04-28)
>
> **分析范围**: Task 工具(源码内称 AgentTool)的 LLM 接口、子 agent 创建链路、state 边界、权限模型、资源预算、错误传播、abort 级联、流式可见性、UX 呈现

## 模块定位

Claude Code 的"子 agent 委托"在面向 LLM 的 schema 上叫 `Task`,在源码里叫 `AgentTool`(`AGENT_TOOL_NAME = 'Task'`,带 `LEGACY_AGENT_TOOL_NAME` 别名以兼容旧名 `Agent`)。它是一个**工具**(挂在 `src/tools/AgentTool/`),不是独立的 orchestrator 层。call() 内部直接调用 `runAgent()`,后者把同一个 `query()` 主循环再跑一次,但传入一个**克隆派生**的 `ToolUseContext`(由 `createSubagentContext()` 构造)、独立的 agentId、独立的 transcript 文件(sidechain)、可能独立的 abortController。换句话说子 agent 不是 fork-process,也不是 worker thread,而是**同进程内的另一个 query loop 实例,通过 ToolUseContext 隔离 mutable 状态**。Task 工具的 outputSchema 是个 union — `completed`(同步,完整内容直接回 LLM)、`async_launched`(后台,只回 agentId/output_file 路径)、内部还有 `teammate_spawned` / `remote_launched` 两种隐藏状态用 dead code elimination 控制。

## 信息来源

| 来源 | 路径 | 可信度 | 用途 |
|------|------|--------|------|
| AgentTool 主入口实现 | `_refs/claude-code-analysis/src/tools/AgentTool/AgentTool.tsx`(1397 行) | ★★★★★ | call() 完整调度 + 同步/异步分支 + worktree/teammate/远程隔离 + tool_result 序列化 |
| runAgent 执行函数 | `_refs/claude-code-analysis/src/tools/AgentTool/runAgent.ts`(973 行) | ★★★★★ | 子 agent 内部 query loop、MCP 初始化、系统提示组装、frontmatter hook 注册 |
| createSubagentContext(state 边界核心) | `_refs/claude-code-analysis/src/utils/forkedAgent.ts:345-462` | ★★★★★ | 父子 ToolUseContext 共享/隔离的精确字段表 |
| Fork 子 agent 实现 | `_refs/claude-code-analysis/src/tools/AgentTool/forkSubagent.ts`(210 行) | ★★★★★ | FORK_AGENT 隐式 fork、cache 共享、递归守护 |
| 工具子集白/黑名单 | `_refs/claude-code-analysis/src/constants/tools.ts:36-112` | ★★★★★ | ALL_AGENT_DISALLOWED_TOOLS / ASYNC_AGENT_ALLOWED_TOOLS / COORDINATOR_MODE_ALLOWED_TOOLS |
| 父 abort 子级联实现 | `_refs/claude-code-analysis/src/utils/abortController.ts`(99 行) | ★★★★★ | createChildAbortController WeakRef 单向传播 |
| 后台 agent 注册/kill | `_refs/claude-code-analysis/src/tasks/LocalAgentTask/LocalAgentTask.tsx`(killAsyncAgent / registerAsyncAgent) | ★★★★★ | 后台 agent 生命周期、ESC 不杀、Ctrl+X Ctrl+K 双击杀 |
| Task 工具实际 schema | `_refs/claude-code-reverse/results/tools/Task.tool.yaml` | ★★★★★ | 模型实际收到的 description/inputSchema 文本(v1 抓取) |
| ESC / kill-agents 键路由 | `_refs/claude-code-analysis/src/hooks/useCancelRequest.ts:130-273` | ★★★★★ | chat:cancel 不杀 bg agent、chat:killAgents 双击模式 |
| 系统提示 prompt | `_refs/claude-code-analysis/src/tools/AgentTool/prompt.ts`(287 行) | ★★★★★ | 给 LLM 的 Task 工具描述生成器(动态条件:fork/coordinator/teammate) |
| general-purpose 内置 agent | `_refs/claude-code-analysis/src/tools/AgentTool/built-in/generalPurposeAgent.ts` | ★★★★★ | 默认 subagent_type 的 systemPrompt + tools=['*'] |
| sidechain transcript 写入 | `_refs/claude-code-analysis/src/utils/sessionStorage.ts:1451-1462` | ★★★★★ | recordSidechainTranscript:子 agent 消息进独立 sidechain 文件 |
| SDK / 非交互输出 | `_refs/claude-code-analysis/src/cli/print.ts:880-908`、`2238` | ★★★★ | stream-json 模式下 task_notification / task_progress / task_started 事件 |
| 架构索引 | `_refs/claude-code-analysis/DOCUMENTATION.md`(§9 Task System、§7 工具表) | ★★★ | AgentTool / TaskCreateTool / SendMessageTool 大纲(对应实现细节去 src/) |
| 已有兄弟分析 | `zhixing/research/source-analysis/claude-code/{interruption-and-abort,agent-loop,tool-system}.md` | ★★★ | 上下文,abort 链路与本文交叉 |

> 注:`_refs/claude-code-deobfuscation/claude-code/src/`(另一份社区 cleanroom)体量较小且**不包含 AgentTool / Task 工具实现**,只有顶层 `client.ts`/`prompts.ts`/`commands` 等。本文 ★★★★★ 数据全部出自 `_refs/claude-code-analysis/src/`(v2.1.88 较完整反混淆)。

---

## 一、Task 工具的 LLM 接口

### 1.1 工具 schema(从 reverse 抓的实际 input_schema)

来源:`_refs/claude-code-reverse/results/tools/Task.tool.yaml:135-152`(原文按 JSON Schema draft-07):

```yaml
input_schema:
  type: object
  properties:
    description:
      type: string
      description: A short (3-5 word) description of the task
    prompt:
      type: string
      description: The task for the agent to perform
    subagent_type:
      type: string
      description: The type of specialized agent to use for this task
  required:
    - description
    - prompt
    - subagent_type
  additionalProperties: false
```

源码侧 schema 比 reverse 抓到的更全(`_refs/claude-code-analysis/src/tools/AgentTool/AgentTool.tsx:82-125`),包含 `model`(`'sonnet'|'opus'|'haiku'` 可选 override)、`run_in_background`(可选 boolean,默认 false)、`isolation`(`'worktree'` 或 ant-only 的 `'remote'`)、`cwd`(KAIROS gate 启用时绝对路径 override)、以及 swarm 多 agent 的 `name`/`team_name`/`mode`。这些字段**根据 feature flag 动态从 schema 中 omit 掉**(代码注释解释:防止"模型看到 schema 字段但 runtime 忽略"的 mismatch),所以实抓 reverse 的 schema 是 baseline 状态(swarm + fork + KAIROS 都关)。

### 1.2 工具描述(系统提示中给 LLM 的措辞)

来源:`_refs/claude-code-reverse/results/tools/Task.tool.yaml:1-134`(实抓的 v1 prompt)。关键段落原文:

```
Launch a new agent to handle complex, multi-step tasks autonomously.

Available agent types and the tools they have access to:
- general-purpose: General-purpose agent for researching complex questions,
  searching for code, and executing multi-step tasks. ... (Tools: *)

When using the Task tool, you must specify a subagent_type parameter ...

When to use the Agent tool:
- When you are instructed to execute custom slash commands. Use the Agent tool
  with the slash command invocation as the entire prompt. ...

When NOT to use the Agent tool:
- If you want to read a specific file path, use the Read or Glob tool instead ...
- If you are searching for a specific class definition like "class Foo", use
  the Glob tool instead ...
- If you are searching for code within a specific file or set of 2-3 files,
  use the Read tool instead ...

Usage notes:
1. Launch multiple agents concurrently whenever possible ...
2. When the agent is done, it will return a single message back to you. The
   result returned by the agent is not visible to the user. ...
3. Each agent invocation is stateless. You will not be able to send additional
   messages to the agent ...
4. The agent's outputs should generally be trusted
5. Clearly tell the agent whether you expect it to write code or just to do
   research ...
6. If the agent description mentions that it should be used proactively, then
   you should try your best to use it without the user having to ask for it
   first.
```

源码侧的 prompt 生成器 `getPrompt()`(`_refs/claude-code-analysis/src/tools/AgentTool/prompt.ts:66-287`)按 4 个开关组合输出:
- `forkEnabled`(FORK_SUBAGENT feature):若开,subagent_type 变可选;省略 = 隐式 fork(继承父全部上下文)。会插入"When to fork / Don't peek / Don't race"段。
- `isCoordinator`(CLAUDE_CODE_COORDINATOR_MODE):返回精简 prompt,因为 coordinator 系统提示已含规则。
- `listViaAttachment`(growthbook `tengu_agent_list_attach`):agent 列表不内嵌 description,改成 attachment message,避免 agent 列表变动 bust 整个 tool schema 的 prompt cache。
- `isTeammate()` / `isInProcessTeammate()`:teammate 上下文里禁用 `name`/`team_name`/`mode` 等(扁平 roster 限制)。

### 1.3 outputSchema:status union 三态

来源:`_refs/claude-code-analysis/src/tools/AgentTool/AgentTool.tsx:141-191`:

```typescript
const syncOutputSchema = agentToolResultSchema().extend({
  status: z.literal('completed'),
  prompt: z.string()
});
const asyncOutputSchema = z.object({
  status: z.literal('async_launched'),
  agentId, description, prompt, outputFile, canReadOutputFile?
});
return z.union([syncOutputSchema, asyncOutputSchema]);

// 私有(不导出 schema 但 runtime 出现的额外两种)
type TeammateSpawnedOutput = { status: 'teammate_spawned'; ... };
type RemoteLaunchedOutput  = { status: 'remote_launched'; ... };
```

**LLM 能看到的回包文本**由 `mapToolResultToToolResultBlockParam()` 构造(`AgentTool.tsx:1298-1378`):

- `completed`:子 agent 最后 assistant 文本 + `agentId: ... (use SendMessage with to: '...' to continue this agent)` + `<usage>total_tokens / tool_uses / duration_ms</usage>` 三段。"one-shot built-ins"(Explore/Plan)略过 SendMessage 提示和 usage trailer 以省 token。
- `async_launched`:`Async agent launched successfully. agentId: <id>` + `output_file: <path>` + 提示 LLM 不要重叠工作或可用 Read/Bash tail 看进度。
- `teammate_spawned`:`Spawned successfully. agent_id / name / team_name`,告知"将通过 mailbox 接收指令"。
- `remote_launched`:`Remote agent launched in CCR. taskId / session_url / output_file`,提示自动通知。

---

## 二、子 agent 创建链路(从 deobfuscation 读)

### 2.1 入口 + 调用链

```
LLM 发出 Task tool_use
  │
  ▼
src/services/tools/toolExecution.ts (统一 tool dispatcher)
  │
  ▼
AgentTool.call({ prompt, subagent_type, description, ... }, toolUseContext, canUseTool, assistantMessage, onProgress)
  │  src/tools/AgentTool/AgentTool.tsx:239-1262
  │
  ├─ 选择 agent 定义 (effectiveType = subagent_type ?? GENERAL_PURPOSE_AGENT.agentType)
  │  └ 若 fork gate 开 + 省略 subagent_type → selectedAgent = FORK_AGENT
  │
  ├─ filterDeniedAgents() 用 toolPermissionContext 过滤被规则禁的 agent type
  │
  ├─ MCP requiredMcpServers 等待(最多 30s 轮询 connect)
  │
  ├─ resolveTeamName / spawnTeammate(swarm 路径,与本主题正交)
  │
  ├─ createAgentWorktree(若 isolation === 'worktree')
  │
  ├─ assembleToolPool(workerPermissionContext, mcpTools)  ← 子 agent 自己的工具池,不直接继承父过滤后的池
  │
  ├─ buildEffectiveSystemPrompt(...) 或继承父系统提示(fork 路径)
  │
  ├─ shouldRunAsync = run_in_background || agentDef.background || isCoordinator || forkEnabled || ...
  │
  ├─ 同步分支(shouldRunAsync === false)
  │  └─ runWithAgentContext + wrapWithCwd + runAgent({...}) AsyncGenerator
  │      └─ 主线程 await for-of 流,边收消息边 onProgress() 给 SDK / UI
  │      └─ 同时监听 backgroundPromise(ctrl+x ctrl+b 把 sync 转 async)
  │
  └─ 异步分支(shouldRunAsync === true)
     └─ registerAsyncAgent({ agentId, description, ..., parentAbortController: 不传 })
        └─ runWithAgentContext + wrapWithCwd + runAsyncAgentLifecycle({...})
            └─ for await runAgent(...) 后台跑,把消息写入 task.messages、emitTaskProgress、completeAsyncAgent
        立即返回 { status: 'async_launched', agentId, outputFile }
```

`runAgent`(`src/tools/AgentTool/runAgent.ts:248-860`)做的核心事:

1. `getAgentSystemPrompt()` 组装(若没传 override)
2. `getUserContext()` / `getSystemContext()`,**Explore/Plan 把 gitStatus 删掉**,`omitClaudeMd` agent 把 CLAUDE.md 删掉(显式省 token,代码注释:Explore 每周 ~5-15 Gtok)
3. `agentAbortController` = override > 异步建新 controller > 同步用父的(关键!同步子 agent **复用**父 controller,异步子 agent 是**新独立** controller)
4. `executeSubagentStartHooks()` 跑 hook 收 additionalContexts
5. `registerFrontmatterHooks()` 注册 agent frontmatter 里定义的 hook(Stop → SubagentStop)
6. 预加载 skills(agentDef.skills)
7. `initializeAgentMcpServers()` 接 agentDef.mcpServers(累加在父 mcpClients 之上)
8. `createSubagentContext(toolUseContext, {...})` 构造隔离 context
9. `recordSidechainTranscript(initialMessages, agentId)` 写 sidechain transcript 文件
10. `for await query({...})` 跑子 agent 的 main loop(同一个 `query.ts` 函数)
11. `finally`:mcpCleanup、clearSessionHooks、cleanupAgentTracking、unregisterPerfettoAgent、`killShellTasksForAgent(agentId)`(防 PPID=1 zombie)

### 2.2 state 边界 — 共享 vs 独立

精确字段表(出自 `createSubagentContext` `forkedAgent.ts:345-462` + `runAgent.ts:332-499`):

| 资源 | 父子关系 | 实现位置 |
|------|----------|---------|
| LLM 客户端(anthropic SDK) | **共享**(模块单例) | `src/services/api/claude.ts` (单 instance) |
| API key / auth 信息 | **共享**(模块状态 / `bootstrap/state.ts`) | 同上 |
| 模型(mainLoopModel) | **可独立**:agentDef.model > Task.input.model > 父 mainLoopModel | `runAgent.ts:340-345`、`utils/model/agent.ts` |
| 工具池(tools) | **独立装配**:`assembleToolPool(workerPermissionContext, mcpTools)`,可用 fork 路径下复用父 exact tools | `AgentTool.tsx:573-577`、`runAgent.ts:500-518` |
| 工具子集过滤 | **独立**:`filterToolsForAgent` 应用 ALL_AGENT_DISALLOWED_TOOLS / CUSTOM_AGENT_DISALLOWED_TOOLS / ASYNC_AGENT_ALLOWED_TOOLS | `agentToolUtils.ts:70-115` |
| Memory(CLAUDE.md / userContext) | **默认继承**;Explore/Plan 显式删 gitStatus + claudeMd | `runAgent.ts:380-410` |
| 系统提示 | **独立**:`agentDef.getSystemPrompt()` + envDetails 增强;fork 路径**直接继承父已渲染的系统提示字节** | `runAgent.ts:506-518`、`forkSubagent.ts:60-71` |
| Context window | **独立**:每个子 agent 走自己的 query loop,独立 context | `query.ts:748` |
| 历史消息 | **隔离**:`initialMessages = [...forkContextMessages, ...promptMessages]`,fork 路径才传父消息;非 fork 路径子 agent 完全不见父对话 | `runAgent.ts:368-373`、`forkSubagent.ts:107-169` |
| Permission context (toolPermissionContext) | **隔离派生**:`agentDef.permissionMode` override 父 mode(除非父是 bypassPermissions/acceptEdits/auto);`shouldAvoidPermissionPrompts` 异步默认 true | `runAgent.ts:413-498` |
| AbortController | **同步:复用父**;**异步:新建独立 controller(不 link 父)** | `AgentTool.tsx:694-698`、`runAgent.ts:520-528` |
| readFileState 缓存 | **clone**(`cloneFileStateCache`) | `forkedAgent.ts:379-381` |
| contentReplacementState | clone(forkedAgent 默认),override(resume/inProcessRunner) | `forkedAgent.ts:399-403` |
| AppState (setAppState) | **默认 no-op**(完全隔离写);`shareSetAppState=true` 才透传;`setAppStateForTasks` 始终透传(否则后台 bash 任务永远没法注册/kill) | `forkedAgent.ts:410-417` |
| Tool decisions / yolo classifier | **fresh per-subagent**(`toolDecisions: undefined` + `localDenialTracking: createDenialTrackingState()`) | `forkedAgent.ts:387-422` |
| Skills 注册表 | **per-agent 调用栈隔离**(`clearInvokedSkillsForAgent(agentId)` finally) | `runAgent.ts:828`、`AgentTool.tsx:1032/1187` |
| Todo 列表(AppState.todos) | **per-agentId key**;子 agent 退出时 finally 清掉自己的 entry | `runAgent.ts:838-843` |
| MCP clients | **累加**:父的 + agentDef.mcpServers 自带的,inline 定义的退出时 cleanup | `runAgent.ts:95-218` |
| Hook 注册(frontmatter) | **session-scoped to agentId**,Stop → SubagentStop;退出 `clearSessionHooks` | `runAgent.ts:567-575` |
| Transcript 持久化 | **独立 sidechain 文件**(`recordSidechainTranscript`,UUID chain 链回主线程) | `runAgent.ts:735-805`、`sessionStorage.ts:1451-1462` |
| Token 计费 | **共享 SDK 计费**:子 agent 流走父的 `pushApiMetricsEntry`(TTFT/OTPS),completed 时把 totalTokens/toolUses/durationMs 拼进 tool_result 文本回 LLM | `runAgent.ts:761-767`、`AgentTool.tsx:1369-1371` |

---

## 三、12 决策对照(逐条记录 Claude Code 怎么做)

### 3.1 决策 1:state 边界

详见上表 §2.2。归纳:

- **进程级共享**:LLM 客户端、API key、bootstrap state、模块单例。
- **per-agent clone**:readFileState、contentReplacementState、todos[agentId]、skills 调用栈、`nestedMemoryAttachmentTriggers` Set。
- **per-agent 完全独立**:context window、历史消息(非 fork 路径)、agentId、queryTracking.depth+1、新 `chainId` UUID、独立 sidechain transcript 文件、独立 toolDecisions。
- **可选共享(必须 opt-in)**:`shareSetAppState` / `shareSetResponseLength` / `shareAbortController`。默认全部 false。

### 3.2 决策 2:ConfirmationBroker(权限)

**子 agent 走的是父的 toolPermissionContext 派生**,不是独立的 permission broker。

- `runAgent` 通过 `agentGetAppState` 包装父 `getAppState()`,追加规则:
  - `agentDef.permissionMode` 覆盖父 mode(条件:父 mode 不是 `bypassPermissions` / `acceptEdits` / TRANSCRIPT_CLASSIFIER 下的 `auto`)
  - 异步 agent 强制 `shouldAvoidPermissionPrompts: true`(没 UI 不能弹框)
  - `bubble` 模式:agent 不能弹框,把 permission 请求"冒泡"回父终端(主线程显示)
  - `await Automated checks`:异步 agent 显式批准前先 await classifier + permission hooks(只在分类器/hook 都不能解决时才打断用户)
- `allowedTools` 参数:若 SDK / agent 提供,**替换 session 级规则**(保留 cliArg 规则,session 清空再用 allowedTools 列表填),防止"父 alwaysAllow 泄漏到子 agent"。
- 默认行为(无 hook、非 auto 模式):`AgentTool.checkPermissions()` 返回 `{ behavior: 'allow' }`。注释明确:"Auto-approve sub-agent generation"(`AgentTool.tsx:1281-1297`)。
- 唯一例外:`appState.toolPermissionContext.mode === 'auto'`(ant-only),返回 `passthrough` 让 yolo classifier 决定。
- AgentTool 自己 `isReadOnly() => true` 注释:"delegates permission checks to its underlying tools"(子工具各自走 permission 检查)。

**结论**:Claude Code 不是给子 agent 一个独立 broker,而是用**派生上下文 + 工具 disallow 列表 + 强制 avoid prompt 标志**三者组合控制权限。

### 3.3 决策 3:工具子集契约

`src/constants/tools.ts:36-112` 三个白/黑名单常量(完整字段在源码):

```typescript
ALL_AGENT_DISALLOWED_TOOLS = {
  TaskOutput, ExitPlanMode, EnterPlanMode,
  // 关键:非 ant 用户禁用 AgentTool 防递归;ant 用户允许嵌套 agent
  ...(USER_TYPE === 'ant' ? [] : [AGENT_TOOL_NAME]),
  AskUserQuestion, TaskStop,
  ...(WORKFLOW_SCRIPTS feature ? [WorkflowTool] : []),
}

CUSTOM_AGENT_DISALLOWED_TOOLS = ALL_AGENT_DISALLOWED_TOOLS  // 自定义 agent 同样

ASYNC_AGENT_ALLOWED_TOOLS = {  // 异步 agent 只允许这些
  Read, WebSearch, TodoWrite, Grep, WebFetch, Glob,
  ...SHELL_TOOL_NAMES, Edit, Write, NotebookEdit,
  Skill, SyntheticOutput, ToolSearch,
  EnterWorktree, ExitWorktree,
}
// 异步 agent 显式禁用:AgentTool / TaskOutput / ExitPlanMode / TaskStop / Tungsten
// (注释明确说为防 recursion)

COORDINATOR_MODE_ALLOWED_TOOLS = { AgentTool, TaskStop, SendMessage, SyntheticOutput }
// coordinator 模式只允许编排,自己不能 Read/Edit
```

`general-purpose` 默认 agent 的 `tools: ['*']`(`generalPurposeAgent.ts:29`),意为通配,`resolveAgentTools` 在 `filterToolsForAgent` 之后给它"非 disallow 的全部"。

`Bash/Edit/Write` 这种破坏性工具**默认不禁用**(只对异步 agent 在 `ASYNC_AGENT_ALLOWED_TOOLS` 里显式放行了);只对自定义 agent 增加 `permissionMode` / `allowedTools` 这层 frontmatter 控制。

**Task 能否再调 Task(递归)**:对 ant 内部用户**允许**(USER_TYPE='ant' 时 AGENT_TOOL_NAME 不在 disallow);对外部用户**禁止**(AgentTool 在 ALL_AGENT_DISALLOWED_TOOLS)。异步 agent 一律禁用 AgentTool。Fork 路径有显式 `isInForkChild()` 检查阻止递归 fork(`AgentTool.tsx:332-334`,匹配 `<FORK_BOILERPLATE_TAG>`)。

### 3.4 决策 4:资源预算

- **maxTurns**:可选,来自 `agentDef.maxTurns`(frontmatter `maxTurns` field,zod `z.number().int().positive().optional()` `loadAgentsDir.ts:89`)或 runAgent 调用方 override。FORK_AGENT 默认 `maxTurns: 200`(`forkSubagent.ts:65`)。query loop 跑到 turn > maxTurns 时 yield `attachment:max_turns_reached` 并 break(`query.ts:1508-1515`、`runAgent.ts:773`)。
- **timeout**:**没有显式时长上限**。子 agent 跑多久取决于:
  - 异步 agent 自身的 abortController 永远不超时,只有人工(Ctrl+X Ctrl+K)或 abort
  - SSE stream-watchdog(默认 90s 默认沉默超时)是父 query 共享的,同步 agent 用同一个 controller 自然受影响;异步 agent 因为新 controller 不受父 watchdog 影响
  - `auto-background` 默认 0(关);env `CLAUDE_AUTO_BACKGROUND_TASKS` 或 growthbook `tengu_auto_background_agents` 启用后 120s 自动转后台(`AgentTool.tsx:72-77`)
- **token budget**:无父子配额隔离。子 agent 消耗 token 直接从父的 API 配额扣;同步子 agent 通过 `pushApiMetricsEntry` 把 TTFT/OTPS 推回父 metrics(共享显示)。子 agent 完成后 totalTokens 写入 tool_result 的 `<usage>` 文本回 LLM。
- **MCP 等待**:`requiredMcpServers` 启动前最多 `MAX_WAIT_MS = 30_000` 轮询连接(`AgentTool.tsx:378-391`)。
- **后台并发数**:无显式上限。`registerAsyncAgent` 把 task 加入 `appState.tasks`,UI 通过 BackgroundTasksDialog 列出。

**硬上限**:仅 maxTurns(可选,无默认 cap 给非 fork agent),没有 token-budget 硬上限,没有 wall-clock 硬上限。

### 3.5 决策 5:Orchestrator 模块归属

**Task 工具就是普通工具**,挂在 `src/tools/AgentTool/`,通过 `buildTool({...})` 注册(`AgentTool.tsx:196-1387`)。它通过 `tools.ts` 的 `assembleToolPool` 进入主线程工具列表,通过 `services/tools/toolExecution.ts` 的统一 dispatcher 调度。

**没有"Orchestrator 层"**。子 agent 的执行函数 `runAgent` 在 `src/tools/AgentTool/runAgent.ts`,内部直接 `query()` 调用 `src/query.ts` 的同一个主循环。换句话说**主 agent 和子 agent 跑同一个 query loop 函数**,只是上下文不同。

辅助模块:
- `src/utils/forkedAgent.ts` — 共享的 ToolUseContext 派生 helper,`createSubagentContext` 是核心
- `src/tasks/LocalAgentTask/LocalAgentTask.tsx` — 后台 agent 在 AppState 里的注册/进度/kill API
- `src/utils/abortController.ts` — child controller WeakRef 单向传播
- `src/services/AgentSummary/` — 后台 agent 周期性进度摘要(独立 fork)
- `src/coordinator/coordinatorMode.ts` — coordinator 编排模式开关

### 3.6 决策 6:流式可见性

**同步子 agent**:
- `runAgent` 是 `AsyncGenerator<Message, void>`。`AgentTool.call()` 同步分支 `agentIterator.next()` 边迭代边:
  - 调用 `onProgress({ toolUseID: 'agent_<msgId>', data: { type: 'agent_progress', ... } })` 把每条 tool_use/tool_result 转发给 SDK / UI
  - 调用 `setResponseLength(len => len + contentLength)` 把子 agent 的 token count 加到父 spinner
  - 转发 `bash_progress` / `powershell_progress` 给父(让父 SDK 看到 tool_progress)
- UI 侧 `_refs/.../tools/AgentTool/UI.tsx` 把 progress messages 折叠展示(Search/Read 自动 group),Ctrl+O 展开 sub-agent 详细。
- `assistantMessage.message.id` 用作 `toolUseID` 命名空间(`agent_${id}`),让 UI 能把子 agent 的 progress 关联到那次 Task tool_use。

**异步子 agent**:
- 不冒泡到主 agent 事件流。`runAsyncAgentLifecycle` 把消息写入 `task.messages`(若 retain)和 `appState.tasks[taskId].progress`,完成后用 `enqueueAgentNotification` 加入 pending notification 队列,下一轮父 agent 拿到 `<task-notification>` user message 才得知。
- UI 在 BackgroundTasks 面板独立显示;主线程不可见 sub-agent 的工具用细节。
- SDK 侧 `enqueueSdkEvent({ type: 'system', subtype: 'task_notification', task_id, status })` 推 task_notification / task_progress / task_started(`print.ts:892-908`),供 stream-json 消费者(IDE 插件等)显示。

**fork 路径**:同步子 agent + `useExactTools`(继承父 thinking config),为了 prompt cache 命中,流式行为同步 agent 一样冒泡。

**用户视角**:同步子 agent 工具步骤会展开(Ctrl+O 详细;默认折叠 Search/Read 摘要 + 最近 N 条 progress);异步子 agent 完全静默,只在面板内可见,完成时通过 `<task-notification>` 文本通知主 agent。

### 3.7 决策 7:错误传播语义

- **同步路径** (`AgentTool.tsx:1127-1234`):
  - `AbortError` instanceof:**re-throw**,让父 query loop 捕到设置 `wasAborted = true` 并 yield user-interruption message;`logEvent('tengu_agent_tool_terminated', { reason: 'user_cancel_sync' })`;最后 throw 给上层。
  - 其他 error:存入 `syncAgentError`,**try 让步给 finalize 阶段**;若 `agentMessages` 至少有一条 assistant message,把已有消息 `finalizeAgentTool` 后返回 `{ status: 'completed', ... }` 让父 LLM 看到部分结果(代码注释:"This allows the parent agent to see partial progress even after an error")。否则 re-throw,被工具框架包成 `tool_result.is_error: true`。
  - 内部检测 `agentMessages.findLast(...)` 是 isSyntheticMessage(API 异常的占位):识别为 abort,throw `new AbortError()`。

- **异步路径** (`runAsyncAgentLifecycle` `agentToolUtils.ts:638+`):
  - `AbortError`:`killAsyncAgent(taskId)`(状态置 'killed'),`enqueueAgentNotification({ status: 'killed' })`。
  - 其他 error:`failAsyncAgent(taskId, errMsg)`,`enqueueAgentNotification({ status: 'failed', error })`。
  - 通知作为 user-role message 在下一轮投递给父 agent,父 LLM 由此感知失败。

- **错误细节**:`AbortError` 来自 `src/utils/errors.ts`,re-throw 时携带 `signal.reason`(主线程 abort 时 reason 是 `'user-cancel'` / `'interrupt'`等字符串 — 见 `interruption-and-abort.md`)。其他 error 被 `errorMessage(error)` 字符串化后通过 `enqueueAgentNotification.error` 传回。

- **partial result 提取**:`extractPartialResult(agentMessages)`(异步 abort 时使用)、`finalizeAgentTool`(同步异常时使用)都会拿出已有的 assistant 文本拼成 finalMessage。

### 3.8 决策 8:递归限制

无硬深度上限。已有的限制:

1. **AgentTool 自己进 disallow 列表**(非 ant + 异步):
   ```typescript
   ALL_AGENT_DISALLOWED_TOOLS = { ..., AGENT_TOOL_NAME (除非 USER_TYPE='ant'), ... }
   ```
   — 这意味着外部用户的非 coordinator 子 agent 拿不到 Task 工具,无法递归。
2. **fork 路径递归守卫**(`AgentTool.tsx:332-334`):若调用方 `querySource === 'agent:builtin:fork'` 或消息历史含 `<FORK_BOILERPLATE_TAG>`,直接 throw。
3. **异步 agent 永远禁用 AgentTool**(`ASYNC_AGENT_ALLOWED_TOOLS` 不含 AGENT_TOOL_NAME)— 注释:"Blocked to prevent recursion"。
4. **In-process teammate 不能 spawn 后台 agent**(运行时检查 `AgentTool.tsx:278-280` / 361-363)。
5. **Coordinator 不能跑同步 sub-agent**(只能 async,见 `forceAsync || isCoordinator`,`AgentTool.tsx:557-567`)。
6. **`queryTracking.depth`**:仅做 telemetry,不强制(`forkedAgent.ts:451-455`,每次 `createSubagentContext` `depth + 1`)。

工程上**没有 N 层数字上限**,递归通过工具子集隔离来实现"尽量不让递归发生"。Ant 内部用户允许递归。

### 3.9 决策 9:审计与 transcript

- **每个子 agent 写独立 sidechain transcript**:`recordSidechainTranscript(messages, agentId, parentUuid)`(`runAgent.ts:735-805`、`sessionStorage.ts:1451-1462`)。子 agent 的每条 message 用 UUID parent chain 链回主线程的最后一条消息,初始 message 链回 invocation tool_use。
- **主会话 transcript 不含子 agent 的 step**;只含 Task 工具的 tool_use 和 tool_result(完成后由 `mapToolResultToToolResultBlockParam` 序列化成的最终文本块)。
- **resume 链路**:`resumeAgentBackground`(`resumeAgent.ts`)读取 `getAgentTranscript(agentId)` + `readAgentMetadata` 还原一个 agent 继续跑。
- **Perfetto tracing**:可选(`isPerfettoTracingEnabled()`),`registerPerfettoAgent(agentId, agentType, parentId)` 把父子 agent 关系注册进 trace,可视化层级。
- **Analytics**:`logEvent('tengu_agent_tool_selected' / 'tengu_agent_tool_terminated' / 'tengu_agent_memory_loaded' / 'tengu_fork_agent_query')`,带 `queryChainId` + `queryDepth` 维度。
- **dump prompts**(`dumpPrompts.ts`):可选,把每次 API 请求 dump 到 `getDumpPromptsPath(agentId)` 文件,方便审计 / 重放(ant-only logForDebugging 输出路径)。

### 3.10 决策 10:abort 双向传播

**用户 → 主 agent → 子 agent**:

- **同步子 agent**:在 `runAgent.ts:520-528` 中 `agentAbortController = isAsync ? new AbortController() : toolUseContext.abortController`。同步子 agent **直接复用父 controller**,父 abort 即子 abort,无需 propagation。
- **异步子 agent**:**显式不 link 父**(`AgentTool.tsx:694-698`):
  ```
  // Don't link to parent's abort controller -- background agents should
  // survive when the user presses ESC to cancel the main thread.
  // They are killed explicitly via chat:killAgents.
  ```
  ESC(`chat:cancel`)只 abort 主线程的当前 turn,不杀后台 agent(useCancelRequest.ts 的 `handleCancel` 不 enumerate 后台 agent)。
- **杀全部后台 agent**:`Ctrl+X Ctrl+K`(`chat:killAgents`,双击模式 — 第一次显示提示,第二次在 `KILL_AGENTS_CONFIRM_WINDOW_MS` 内真杀)。`killAllAgentsAndNotify` 遍历 running 的 local_agent task,调 `killAllRunningAgentTasks`(对每个 task `task.abortController.abort()`),enqueue 一条聚合通知。
- **viewing teammate 时**:Ctrl+C 也会 `killAllAgentsAndNotify` + 退出 teammate 视图。
- **WeakRef child controller**:`createChildAbortController` 给 fork 路径或显式 share 时使用(`abortController.ts:68-99`):父 abort → 子 abort(WeakRef 防止父保留废弃子的强引用);子 abort 自动注销父监听器。**单向**(子 abort 不影响父)。

**子 agent → 主 agent**:**单向(不反向 abort)**。子 agent 内部异常 / 超时 / API 失败,只把错误传成 `tool_result.is_error` 或 `<task-notification>` 文本,不会触发父 controller.abort()。父 LLM 自己读 tool_result 决定下一步。

**SDK 控制路径**(`controlSchemas.ts`):`control_cancel_request` 可被外部 SDK 客户端发出 abort 请求,SDK 实现侧 trigger 主 controller。

### 3.11 决策 11:token / 成本归属

- **同步子 agent**:
  - 每条 stream_event message_start 通过 `pushApiMetricsEntry(message.ttftMs)`(`runAgent.ts:765-767`)推到父 metrics(spinner / TTFT / OTPS 显示)。
  - assistant message 的 `getAssistantMessageContentLength()` 通过 `setResponseLength(len => len + contentLength)` 累加到父 response 长度。
  - 完成时把 `<usage>total_tokens / tool_uses / duration_ms</usage>` 拼进 tool_result 文本(`AgentTool.tsx:1369-1371`),LLM 直接看到 token 消耗。
- **异步子 agent**:不进父 metrics 流。完成通知 `enqueueAgentNotification.usage = { totalTokens, toolUses, durationMs }` — 这个 usage 写入 `<task-notification>` 消息 body 给父 LLM 看。
- **Analytics 上**:`tengu_fork_agent_query` event 带 `inputTokens / outputTokens / cacheReadInputTokens / cacheCreationInputTokens / cacheHitRate`(`forkedAgent.ts:656-688`),按 `forkLabel` 分类,可以在分析侧拆解"这个 turn 因为 fork 多消耗多少 token"。
- **API 配额**:进程级共享(单 anthropic SDK 实例),无 per-agent 配额。

用户视角:UI 不显式区分"主 vs 子"消耗,都进 spinner。但 SDK 输出和 transcript 可以拆分到 agentId。

### 3.12 决策 12:CLI / IDE / 异步通道 三方 UX

- **CLI(REPL/Ink TUI)**:
  - 同步子 agent 默认折叠展示(Box + AgentProgressLine 摘要),`Ctrl+O` 展开详细 transcript(`UI.tsx` 的 `CtrlOToExpand` + `SubAgentProvider`),最近 `MAX_PROGRESS_MESSAGES_TO_SHOW = 3` 条 progress。
  - Search/Read 自动合并成"Searched X / Read Y"摘要(`processProgressMessages`)。
  - 后台 agent 的 BackgroundHint UI 在 2000ms 后弹出(`PROGRESS_THRESHOLD_MS`)提示可 background。
  - Ctrl+X Ctrl+B 把 sync 转 async(`backgroundPromise` race);转后立刻 `async_launched` tool_result 给 LLM,继续后台跑。
  - BackgroundTasks 面板(`Ctrl+T` 或 spinner hint 显示快捷键):列后台 agent,可点开看 transcript,可选 kill。
  - `/agents` slash command 入口管理 agent 定义。

- **IDE 插件 / VS Code subagent panel**:
  - `enqueueSdkEvent({ type: 'system', subtype: 'task_started' / 'task_progress' / 'task_notification' })` 通过 SDK event queue 推给外部消费者。
  - sync 子 agent 边跑边 `emitTaskProgress(tracker, taskId, ...lastToolName)` 让 IDE 可显示工具进度。
  - 异步子 agent 完成时 `task_notification.status = 'completed' / 'failed' / 'stopped'` + `usage` blob。

- **API 模式 / `claude -p` 非交互**:
  - `print.ts:880-908` 在非 stream-json 输出时**过滤掉** `task_notification` / `task_started` / `task_progress` / `post_turn_summary`(只保留 result message,让 lastMessage 对齐 result)。
  - stream-json 模式 + verbose 时全量推送。
  - 异步 agent 完成的 `<task-notification>` 内容会作为 user message 进入下一轮,直接出现在最终 transcript 输出。
  - SDK 侧 `controlSchemas.ts` 提供 control_request 接口可远程 abort。

- **Remote / CCR**:`isolation: 'remote'` 把 agent 跑到 CCR 远程沙盒,只回 `taskId / sessionUrl / outputFile`,本地不可见执行细节。

- **Coordinator 模式**(`isCoordinatorMode()` ant-only):**强制全部 sub-agent 异步**,coordinator 自己几乎只能编排(只有 AgentTool/TaskStop/SendMessage/SyntheticOutput),不能自己 Read/Edit。

---

## 四、关键代码片段

### 4.1 AgentTool 工具注册主体

`_refs/claude-code-analysis/src/tools/AgentTool/AgentTool.tsx:196-238`:

```typescript
export const AgentTool = buildTool({
  async prompt({ agents, tools, getToolPermissionContext, allowedAgentTypes }) {
    // ... filterDeniedAgents, MCP 检查
    return await getPrompt(filteredAgents, isCoordinator, allowedAgentTypes);
  },
  name: AGENT_TOOL_NAME,                     // 'Task'
  searchHint: 'delegate work to a subagent',
  aliases: [LEGACY_AGENT_TOOL_NAME],         // 旧名 'Agent'
  maxResultSizeChars: 100_000,
  async description() { return 'Launch a new agent'; },
  get inputSchema(): InputSchema { return inputSchema(); },
  get outputSchema(): OutputSchema { return outputSchema(); },
  async call({ prompt, subagent_type, description, model, run_in_background, ... }, toolUseContext, canUseTool, assistantMessage, onProgress?) {
    // ... 见 §2.1 调度流程
  },
  isReadOnly() { return true; },             // 委托给被调用工具自检 permission
  isConcurrencySafe() { return true; },
  // ...
});
```

### 4.2 子 agent ToolUseContext 派生

`_refs/claude-code-analysis/src/utils/forkedAgent.ts:345-462`(精简):

```typescript
export function createSubagentContext(parentContext, overrides?) {
  const abortController =
    overrides?.abortController ??
    (overrides?.shareAbortController
      ? parentContext.abortController
      : createChildAbortController(parentContext.abortController));

  return {
    readFileState: cloneFileStateCache(overrides?.readFileState ?? parentContext.readFileState),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    toolDecisions: undefined,
    contentReplacementState: overrides?.contentReplacementState ??
      (parentContext.contentReplacementState
        ? cloneContentReplacementState(parentContext.contentReplacementState)
        : undefined),
    abortController,
    getAppState,
    setAppState: overrides?.shareSetAppState ? parentContext.setAppState : () => {},
    setAppStateForTasks: parentContext.setAppStateForTasks ?? parentContext.setAppState,
    localDenialTracking: overrides?.shareSetAppState
      ? parentContext.localDenialTracking
      : createDenialTrackingState(),
    setInProgressToolUseIDs: () => {},
    setResponseLength: overrides?.shareSetResponseLength ? parentContext.setResponseLength : () => {},
    pushApiMetricsEntry: overrides?.shareSetResponseLength ? parentContext.pushApiMetricsEntry : undefined,
    addNotification: undefined,
    setToolJSX: undefined,
    options: overrides?.options ?? parentContext.options,
    messages: overrides?.messages ?? parentContext.messages,
    agentId: overrides?.agentId ?? createAgentId(),
    queryTracking: {
      chainId: randomUUID(),
      depth: (parentContext.queryTracking?.depth ?? -1) + 1,
    },
    // ...
  };
}
```

### 4.3 异步 agent 不 link 父 controller

`_refs/claude-code-analysis/src/tools/AgentTool/AgentTool.tsx:686-712`:

```typescript
if (shouldRunAsync) {
  const agentBackgroundTask = registerAsyncAgent({
    agentId: asyncAgentId,
    description, prompt, selectedAgent,
    setAppState: rootSetAppState,
    // Don't link to parent's abort controller -- background agents should
    // survive when the user presses ESC to cancel the main thread.
    // They are killed explicitly via chat:killAgents.
    toolUseId: toolUseContext.toolUseId
  });
  // ... runWithAgentContext + runAsyncAgentLifecycle
  return { data: { isAsync: true, status: 'async_launched', agentId, ..., outputFile } };
}
```

### 4.4 abort 单向 WeakRef 级联

`_refs/claude-code-analysis/src/utils/abortController.ts:68-99`:

```typescript
export function createChildAbortController(parent: AbortController, maxListeners?) {
  const child = createAbortController(maxListeners);
  if (parent.signal.aborted) {
    child.abort(parent.signal.reason);
    return child;
  }
  // WeakRef 防止父保留废弃子的强引用
  const weakChild = new WeakRef(child);
  const weakParent = new WeakRef(parent);
  const handler = propagateAbort.bind(weakParent, weakChild);
  parent.signal.addEventListener('abort', handler, { once: true });
  // 子 abort 时反向移除父 listener,避免悬挂监听
  child.signal.addEventListener(
    'abort',
    removeAbortHandler.bind(weakParent, new WeakRef(handler)),
    { once: true }
  );
  return child;
}
```

### 4.5 工具子集 disallow

`_refs/claude-code-analysis/src/constants/tools.ts:36-71`:

```typescript
export const ALL_AGENT_DISALLOWED_TOOLS = new Set([
  TASK_OUTPUT_TOOL_NAME, EXIT_PLAN_MODE_V2_TOOL_NAME, ENTER_PLAN_MODE_TOOL_NAME,
  // 关键决策:ant 用户允许嵌套 agent;外部用户禁用以防递归
  ...(process.env.USER_TYPE === 'ant' ? [] : [AGENT_TOOL_NAME]),
  ASK_USER_QUESTION_TOOL_NAME, TASK_STOP_TOOL_NAME,
  ...(feature('WORKFLOW_SCRIPTS') ? [WORKFLOW_TOOL_NAME] : []),
]);

export const ASYNC_AGENT_ALLOWED_TOOLS = new Set([
  FILE_READ_TOOL_NAME, WEB_SEARCH_TOOL_NAME, TODO_WRITE_TOOL_NAME,
  GREP_TOOL_NAME, WEB_FETCH_TOOL_NAME, GLOB_TOOL_NAME,
  ...SHELL_TOOL_NAMES, FILE_EDIT_TOOL_NAME, FILE_WRITE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME, SKILL_TOOL_NAME, SYNTHETIC_OUTPUT_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME, ENTER_WORKTREE_TOOL_NAME, EXIT_WORKTREE_TOOL_NAME,
]);
// 异步 agent 显式禁用:AgentTool / TaskOutput / ExitPlanMode / TaskStop / Tungsten
```

### 4.6 fork 路径递归守卫

`_refs/claude-code-analysis/src/tools/AgentTool/AgentTool.tsx:330-336`、`forkSubagent.ts:78-89`:

```typescript
// AgentTool.tsx
if (isForkPath) {
  if (toolUseContext.options.querySource === `agent:builtin:${FORK_AGENT.agentType}` ||
      isInForkChild(toolUseContext.messages)) {
    throw new Error('Fork is not available inside a forked worker. ...');
  }
  selectedAgent = FORK_AGENT;
}

// forkSubagent.ts
export function isInForkChild(messages: MessageType[]): boolean {
  return messages.some(m => {
    if (m.type !== 'user') return false;
    const content = m.message.content;
    if (!Array.isArray(content)) return false;
    return content.some(
      block => block.type === 'text' && block.text.includes(`<${FORK_BOILERPLATE_TAG}>`)
    );
  });
}
```

### 4.7 子 agent transcript 写到 sidechain

`_refs/claude-code-analysis/src/tools/AgentTool/runAgent.ts:735-805`(精简):

```typescript
// 起始 messages 一次性写
void recordSidechainTranscript(initialMessages, agentId).catch(_err => ...);

let lastRecordedUuid: UUID | null = initialMessages.at(-1)?.uuid ?? null;

for await (const message of query({ messages, systemPrompt, ..., toolUseContext: agentToolUseContext, querySource, maxTurns: maxTurns ?? agentDefinition.maxTurns })) {
  // ...
  if (isRecordableMessage(message)) {
    await recordSidechainTranscript([message], agentId, lastRecordedUuid).catch(...);
    if (message.type !== 'progress') lastRecordedUuid = message.uuid;
    yield message;
  }
}
```

`sessionStorage.ts:1451-1462`:

```typescript
export async function recordSidechainTranscript(messages, agentId?, startingParentUuid?) {
  await getProject().insertMessageChain(
    cleanMessagesForLogging(messages),
    true,                      // isSidechain = true
    agentId,
    startingParentUuid,
  );
}
```

### 4.8 同步异常恢复(返回部分结果)

`_refs/claude-code-analysis/src/tools/AgentTool/AgentTool.tsx:1127-1234`(精简):

```typescript
} catch (error) {
  if (error instanceof AbortError) {
    wasAborted = true;
    logEvent('tengu_agent_tool_terminated', { reason: 'user_cancel_sync', ... });
    throw error;            // 用户中断:re-throw
  }
  syncAgentError = toError(error);    // 其他错误:暂存
  logForDebugging(`Sync agent error: ${errorMessage(error)}`, { level: 'error' });
} finally {
  // ... cleanup
}

// 之后:
if (syncAgentError) {
  const hasAssistantMessages = agentMessages.some(msg => msg.type === 'assistant');
  if (!hasAssistantMessages) throw syncAgentError;
  logForDebugging(`Sync agent recovering from error with ${agentMessages.length} messages`);
}
const agentResult = finalizeAgentTool(agentMessages, syncAgentId, metadata);
return { data: { status: 'completed', prompt, ...agentResult } };
```

### 4.9 ESC(chat:cancel)不杀后台 agent

`_refs/claude-code-analysis/src/hooks/useCancelRequest.ts:197-273`(精简):

```typescript
// Ctrl+C 在 viewing teammate 时才杀 bg agent
const handleInterrupt = useCallback(() => {
  if (isViewingTeammate) {
    killAllAgentsAndNotify();
    exitTeammateView(setAppState);
  }
  if (canCancelRunningTask || hasQueuedCommands) handleCancel();
}, [...]);

// 双击 Ctrl+X Ctrl+K 才显式杀全部 bg agent
const handleKillAgents = useCallback(() => {
  const tasks = store.getState().tasks;
  const hasRunningAgents = Object.values(tasks).some(t => t.type === 'local_agent' && t.status === 'running');
  if (!hasRunningAgents) { /* notify "No background agents running" */ return; }
  const elapsed = Date.now() - lastKillAgentsPressRef.current;
  if (elapsed <= KILL_AGENTS_CONFIRM_WINDOW_MS) {
    // 第二次按:真杀
    killAllAgentsAndNotify();
    return;
  }
  // 第一次按:显示提示
  addNotification({ key: 'kill-agents-confirm', text: `Press ${shortcut} again to stop background agents`, ... });
}, [...]);
```

### 4.10 tool_result 序列化(LLM 实际看到的子 agent 输出)

`_refs/claude-code-analysis/src/tools/AgentTool/AgentTool.tsx:1327-1373`:

```typescript
if (data.status === 'async_launched') {
  const prefix = `Async agent launched successfully.\nagentId: ${data.agentId} (internal ID - do not mention to user. Use SendMessage with to: '${data.agentId}' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes.`;
  const instructions = data.canReadOutputFile
    ? `Do not duplicate this agent's work — avoid working with the same files or topics it is using. ...output_file: ${data.outputFile}\nIf asked, you can check progress before completion by using ${FILE_READ_TOOL_NAME} or ${BASH_TOOL_NAME} tail on the output file.`
    : `Briefly tell the user what you launched and end your response. Do not generate any other text — agent results will arrive in a subsequent message.`;
  return { tool_use_id: toolUseID, type: 'tool_result', content: [{ type: 'text', text: `${prefix}\n${instructions}` }] };
}
if (data.status === 'completed') {
  const contentOrMarker = data.content.length > 0 ? data.content : [{ type: 'text', text: '(Subagent completed but returned no output.)' }];
  // one-shot built-ins(Explore/Plan)略过 SendMessage trailer 省 token
  if (data.agentType && ONE_SHOT_BUILTIN_AGENT_TYPES.has(data.agentType) && !worktreeInfoText) {
    return { tool_use_id: toolUseID, type: 'tool_result', content: contentOrMarker };
  }
  return {
    tool_use_id: toolUseID, type: 'tool_result',
    content: [...contentOrMarker, {
      type: 'text',
      text: `agentId: ${data.agentId} (use SendMessage with to: '${data.agentId}' to continue this agent)${worktreeInfoText}
<usage>total_tokens: ${data.totalTokens}
tool_uses: ${data.totalToolUseCount}
duration_ms: ${data.totalDurationMs}</usage>`
    }]
  };
}
```

---

## 五、未确定 / 存疑点

1. **`runAsyncAgentLifecycle` 完整 catch 分支(后台 agent 异常处理)** — 截到 `agentToolUtils.ts:638` 后未读完(只确认了 `completeAsyncAgent` 路径),完整 fail / abort 通知细节需要再读 638-686 行,但已通过 `AgentTool.tsx:992-1037` 的 backgrounded-from-sync 分支交叉验证了 `failAsyncAgent` + `enqueueAgentNotification({ status: 'failed' })` 模式与该函数语义一致。
2. **`SendMessage` 工具实现细节** — 存在(`SendMessageTool` 在工具表)但本主题未深读其代码;只知它通过 `appState.agentNameRegistry`(name → agentId Map)路由消息到 running async agent,以及 in-process teammate mailbox。是否走"重启 agent 的 query loop"还是"投递消息进现有 loop 的 input queue"未确认。
3. **`isolation: 'worktree'` 的 git 物理细节** — `createAgentWorktree` / `removeAgentWorktree` / `hasWorktreeChanges` 在 `utils/worktree.ts`,本文未展开;只确认 worktree 的退出策略("无 changes 时清理,有 changes 保留并把 path/branch 写进 tool_result")。
4. **MCP server 在子 agent 销毁时的引用计数** — `initializeAgentMcpServers` 区分 `newlyCreatedClients`(inline) vs `agentClients`(shared by name),只 cleanup 前者。是否存在多个子 agent 共享同一 named server 时的并发清理竞态,未深查。
5. **`SDK control_cancel_request` 到子 agent abort 的精确路径** — 知道主 agent abort controller 来自 `query.ts` 的 `toolUseContext.abortController`(由 REPL 的 onCancel 调 abort);SDK 远程 cancel 是否能精确指向某个具体 agentId 或只能 abort 当前 turn,未在控制路径源码里直接验证。
6. **`tengu_agent_list_attach`(growthbook)对 prompt cache 的实际命中率** — 注释提到"agent 列表是 fleet 10.2% cache_creation token",代码侧只能看到开关与切换逻辑,实际命中改善数字未在 fleet 层度量数据中读到。
7. **dump prompts 的格式** — `getDumpPromptsPath(agentId)` 返回路径,具体落盘格式(JSONL?完整 API request body?)在 `dumpPrompts.ts` 内,本文未读。
8. **`buildSubagentLookups`(UI 折叠相关)的具体实现** — 只在 UI.tsx 引用,未定位详细算法。
9. **`AgentSummary` 服务的周期性进度摘要触发频率与提示** — `startAgentSummarization(taskId, agentId, params, setAppState)` 已知由 `getSdkAgentProgressSummariesEnabled()` 控制,但摘要 LLM 调用的 prompt / 频率 / token 计费归属未读 `services/AgentSummary/agentSummary.ts`。
10. **Reverse 抓的 schema 与最新源码的版本差** — `_refs/claude-code-reverse/results/tools/Task.tool.yaml` 是早期 v1 版,源码侧的 `inputSchema` 含 `model / run_in_background / isolation / cwd / name / team_name / mode`,但 reverse 只抓到 `description / prompt / subagent_type` 三个 required。这是 feature gate 决定的(KAIROS / FORK_SUBAGENT / AGENT_SWARMS),不是版本损坏 — 但需注意:**模型实际看到的 schema 取决于 runtime feature 状态**,不是源码静态字段。
11. **Coordinator 模式下 sub-agent abort 的传播** — coordinator 强制 `forceAsync`,但 coordinator 自己的 abortController 与子 agent 的关系是否有特殊 link 没在 `coordinator/coordinatorMode.ts` 内深查。
