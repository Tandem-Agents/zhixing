# 子 Agent 体系执行规格

> 本文档是知行早期 `Task` / Subagents 能力的权威规格，只描述当前有效的产品定义、架构、协议、UI 和验收边界。实现变化时原地更新，不保留版本记录、阶段记录或旧方案。

## 1. 产品定义

### 1.1 能力定位

Subagents 指主 Agent 在同一轮中通过 `Task` 工具派生一个或多个短命子 Agent，完成需要隔离上下文、多轮只读调研、并行比较或多视角审查的子任务。

它解决的是主 Agent 的临时研究型委派，不等同于：

- 文件化可编排基础设施中的持久节点；
- 后台长期运行的 Agent；
- 用户可独立对话的角色 Agent；
- 新会话或新工作场景。

子 Agent 的最终产物回到主 Agent，由主 Agent综合并直接回答用户。用户不需要看到子 Agent 的完整中间推理和每次内部工具调用，但必须看得到运行进度、失败和最终成本摘要。

### 1.2 使用边界

适合使用 `Task`：

- 同一主题需要多轮 Read / Glob / Grep 调研；
- 已知 URL 或网页需要独立读取，或与本地内容交叉核查；
- A / B / C 多方案并行比较；
- 安全、性能、可维护性等多视角并行审查。

不适合使用 `Task`：

- 单文件、单次只读工具调用即可完成；
- 简单事实或是非问题；
- 需要主 Agent 直接和用户沟通的内容；
- 需要写文件、执行命令或产生外部副作用的子任务。

## 2. 架构边界

### 2.1 分层归属

```text
@zhixing/core
  通用工具调用关联、批次约束、事件和展示元数据
        │
        ▼
@zhixing/orchestrator
  Task 工具、子 Agent 装配、预算、安全、结果折叠
        │
        ├──────────────► @zhixing/cli
        │                 实时状态、完成摘要、/usage
        │
        └──────────────► server / channel
                          按接入面能力投影最终结果
```

职责必须保持：

| 层 | 负责 | 不负责 |
|---|---|---|
| `core` | `toolCallId?`、`maxCallsPerTurn?`、通用 child lifecycle 事件、renderer-only presentation | 不识别 `Task`，不写 Subagents 文案，不决定 CLI 布局 |
| `orchestrator` | 子 Agent 生命周期、工具面、预算、结果协议、Task prompt | 不操作终端、不写接入面专属 UI |
| `cli` | EventBus 消费、Chrome 状态、scrollback 摘要、窄屏布局 | 不解析 orchestrator 私有文本协议来推断实时状态 |
| `server/channel` | 按接入面能力投影 | 不复用终端 ANSI 文案或布局 |

### 2.2 公共模块修改原则

公共能力只能按通用语义演进：

- `ToolExecutionContext.toolCallId?` 表达任意工具内部活动与父调用的关联；每次调用使用浅拷贝上下文，旧工具不读取时行为不变。
- `ToolDefinition.maxCallsPerTurn?` 表达任意工具在单次工具批次内的同名调用上限；默认未设置即无限制。
- `tool:child_start/end` 表达任意工具派生子活动的生命周期，不绑定 `Task` 名称。
- `ToolPresentationArtifact` 是 renderer-only 元数据；不进入 LLM transcript，不进入默认公共 yield。
- `ScreenController` 只理解通用状态行层级，不理解 Subagents、Task 或业务计数。

公共模块变化必须保持其他工具、文件化编排、orchestration executor 和各接入面原有语义不变。

## 3. 运行模型

### 3.1 生命周期

一次 `Task` 调用的生命周期：

```text
主 Agent tool_use(Task)
  → 工具批次校验
  → Task 输入校验
  → 预留 subAgentId / child lineage
  → 构建子 profile、工具面、system prompt、task message
  → 上下文预算预检
  → emit tool:child_start
  → 子 Agent loop
  → 折叠 completed / failed / aborted
  → emit tool:child_end
  → ToolResult + SubAgentResultPresentationArtifact
  → 主 Agent 综合
```

子 Agent 是 `Task.call()` 内部的短命执行体：

- 不创建独立 Conversation；
- 不写独立 Turn；
- 不直接持有 TranscriptStore；
- 不持久化中间消息；
- 不启动 worker thread 或子进程；
- 父 Turn 只记录 Task tool_use / tool_result。

### 3.2 共享与隔离

共享：

- LLM provider、模型和角色化 LLM 能力；
- SecurityPipeline 与 PermissionStore；
- 工作目录和只读项目内容；
- 顶层用户原始意图，供子工具安全研判；
- 父 EventBus 的事件冒泡链。

每次派生隔离：

- `subAgentId` 与 lineage；
- `AgentRoleProfile`；
- 子 EventBus；
- 子 ConfirmationBroker；
- AbortController 与资源预算；
- 子消息列表和运行状态。

### 3.3 Profile 与工具面

子 Agent profile 是工具装配的唯一权威源。当前工具面仅包含：

```text
read / glob / grep / web_fetch
```

约束：

- 不含 `Task`，因此不能递归派生；
- 不含 write / edit / bash 等写入和执行工具；
- 本地工具只有在父运行时真实提供且有工作目录时才进入 child surface；
- `web_fetch` 复用既有网络出口、SSRF、权限和确认链路，不建立旁路；
- Task 描述必须完全由 `childToolNames` 派生，不承诺不存在的能力；
- 同一 profile 与工具面必须生成 byte-stable 描述和 system prompt。

### 3.4 Prompt 隔离

System prompt 只包含稳定角色约束、真实工具说明和环境信息，不包含本次 task 文本。

本次任务通过专用 user message 注入：

```json
{
  "kind": "sub_agent_task",
  "description": "检查并发状态",
  "prompt": "核查状态生产端、消费端和异常路径……"
}
```

JSON envelope 只承载数据，不能覆盖 system 约束。该结构同时实现：

- 任务文本与系统约束隔离；
- 同类子 Agent 静态前缀稳定；
- task 中的围栏、提示词样本和用户原话不会被误判为 system 指令；
- prompt cache 复用是附加收益，不作为安全结构的前提。

## 4. Task 工具契约

### 4.1 输入

```typescript
interface TaskInput {
  description: string;
  prompt: string;
}
```

- `description` 是父侧状态和摘要使用的短标签，schema 与运行期使用同一字符上限。
- `prompt` 是完整任务，只在此字段描述，不在 description 重复。
- 两字段必须是 trim 后非空字符串。
- 不接受额外字段，不对非字符串做强制转换。
- 输入错误返回 `isError: true`，不派生子 Agent，不发 child lifecycle，不进入子任务终态摘要。

### 4.2 单轮并发上限

`Task.maxCallsPerTurn = 3`，含义是单次 `executeToolCalls` 批次最多执行前三个 Task：

- 前三个正常并行执行；
- 超出部分逐个返回输入级 `isError`；
- 不整批拒绝；
- 不跨多个 Agent turn 累计；
- 被拒调用没有 subAgentId，也不渲染成子 Agent 失败。

该限制由 core 的通用批次规划实现，其他工具不声明时不受影响。

### 4.3 工具描述

Task 描述按能力谓词构造：

- 有本地只读工具才出现本地读取/搜索建议；
- 有 `web_fetch` 才出现 URL / 网页建议；
- 两类能力并存时才描述组合使用；
- 比较、多视角、并发、递归、失败和输出规则是通用段；
- 同一 `childToolNames` 必须产生完全相同的字符串。

### 4.4 安全属性

Task 是 orchestrator 内部派生入口：

- `isParallelSafe: true`；
- `interruptBehavior: "cancel"`；
- Task 调度本身不要求用户确认；
- 子 Agent 每个具体工具仍独立经过 SecurityPipeline；
- process/exec 边界只用于准确分类内部派生，不替代具体工具权限。

## 5. 派生与执行

### 5.1 父子关联

Tool executor 为每个调用注入 `ctx.toolCallId = call.id`。Task 将其作为 `parentToolCallId` 传入 `runChildAgent`，形成稳定关系：

```text
parent tool call id
  ↔ child lifecycle event
  ↔ child lineage
  ↔ presentation artifact
  ↔ CLI Task registry
```

关联不依赖事件到达顺序或“第一个未关联子 lineage”等启发式匹配。

### 5.2 上下文预算预检

派生前估算：

```text
system prompt + initial messages + child tool specs
```

只有明显超过模型注意力风险阈值时才拒绝派生；边界附近继续走运行期真实 usage 检查。估算器异常必须 fail-open，回落到既有运行期保护，不能把估算失败误判为 assembly failure。

### 5.3 运行预算

默认预算：

| 维度 | 默认值 | 语义 |
|---|---:|---|
| max turns | 20 | 子任务交互轮次 |
| max tokens | 50,000 | 累计成本软上限 |
| LLM idle timeout | 60s | 流空闲看门狗 |
| wall clock | 10min | 单次派生总时长 |
| context risk | 模型能力值 | 单次输入注意力质量阈值 |

预算在当前 LLM 调用结束后触发，下一次调用前停止，不在流中间硬切。`max_tokens`、`wall_clock`、`context_overflow` 使用 first-wins 结构化原因；`max_turns` 使用 loop 终止原因。

### 5.4 中断与清理

- 父中断向子单向级联，typed reason 为 `parent-abort`；
- 子失败、超时或中断不反向中断父；
- 子结束必须清理 EventBus listeners、wall-clock timer 和 pending confirmation；
- `runChildAgent` 永不向 Task 调用方抛异常，所有异常折叠为结构化 failed 结果；
- 安装了 child lifecycle 后，终态事件必须与结果状态一致。

## 6. 结果与用量协议

### 6.1 ChildAgentResult

```typescript
interface ChildAgentResult {
  status: "completed" | "failed" | "aborted";
  subAgentId: string;
  finalAssistantText: string;
  usage: TokenUsage;
  toolUses: number;
  durationMs: number;
  error?: { type: SubAgentErrorType; message: string };
  abortReason?: AbortReason;
  partial?: string;
}
```

语义：

- completed 必须有非空 assistant answer；空回答归类为 `failed / empty_output`；
- failed / aborted 尽可能保留 partial；
- `toolUses` 统计实际产生的全部 tool_end，包括失败工具；
- provider、认证、限流、预算、上下文风险和基础设施错误使用结构化类型；
- 主 Agent 必须在最终回答中披露 Task 失败，不能静默当作成功。

### 6.2 有界输出

所有进入主上下文或 CLI collector 的可变字段独立有界：

- description 使用 schema 与运行期同源短上限；
- provider error / abort reason 使用同一中等上限，并同时用于文本前缀和 presentation；
- final / partial 各自使用 20,000 字符上限；
- usage trailer 永远最后追加，不使用会截断 trailer 的 core 通用结果截断；
- content 与 presentation 均有可测试的总上界。

### 6.3 ToolResult

三态映射：

- completed：final text + trailer，`isError: false`；
- failed：稳定失败前缀 + 可选 partial + trailer，`isError: true`；
- aborted：稳定中止前缀 + 可选 partial + trailer，`isError: true`。

所有状态使用同一末尾锚定 trailer：

```text
<usage>status: succeeded|failed|aborted, tokens: N, tool_uses: N, duration_ms: N, sub_id: abc123</usage>
```

解析器只认内容末尾的完整结构，字段顺序和名称稳定。用量是可靠的结构化协议，不从任意正文片段或错误前缀猜测状态。

### 6.4 展示元数据

Task 结果同时携带 `SubAgentResultPresentationArtifact`：

```typescript
interface SubAgentResultPresentationArtifact {
  kind: "sub-agent-result";
  toolCallId: string;
  subAgentId: string;
  description: string;
  status: "succeeded" | "failed" | "aborted";
  durationMs: number;
  usage: { inputTokens: number; outputTokens: number };
  toolUses: number;
  errorOrAbortReason?: string;
}
```

它服务本地 renderer：

- 不进入 transcript；
- 不进入主 LLM tool_result 文本；
- 默认 RPC session delta 会剥离；
- 字段可 JSON 序列化、保留父子关联、不携带完整 stream，为未来统一投影保留干净契约。

## 7. EventBus 与状态真相源

### 7.1 Lineage

```text
main
  └─ main/sub-<id>
       └─ main/sub-<id>/...
```

子事件向父 bus 冒泡，lineage 只在 EventMeta 中携带，不注入业务 payload。

### 7.2 Child lifecycle

```typescript
"tool:child_start": {
  parentToolCallId: string;
  childLineage: string;
  childAgentId: string;
  label: string;
}

"tool:child_end": {
  parentToolCallId: string;
  childLineage: string;
  childAgentId: string;
  status: "succeeded" | "failed" | "aborted";
  duration: number;
}
```

### 7.3 CLI Task registry

CLI 使用单一 registry 保存每个父 tool call 的状态：

- tool call 是否存在；
- child 是否启动；
- child 运行/成功/失败/中止；
- child lineage；
- 当前内部工具；
- 父 tool call 是否收口。

运行数和各终态计数全部从 registry 派生，不维护第二套可漂移累加器。

- `tool:child_end` 立即、幂等地终结 child，清理 lineage / subTool，切换焦点并重画；
- `tool:call_end` 只负责父调用收口；
- 未产生 child lifecycle 的前置失败由 call_end fallback 收口；
- child_end 与 call_end 不能重复计数。

### 7.4 事件作用域

消费方必须按事件语义决定作用域：

- agent、LLM、retry、segment、lifecycle、interrupt 等通用主状态只认根 lineage；
- 子 lineage 的 tool / usage 只进入对应 Task registry 和本轮总成本；
- 子 usage 计入本轮总成本，但不驱动主 phase 或主 context cache；
- `orchestration:*` 是文件化编排域事件，不套根 lineage 守卫，只按既有 definitionId / runId 隔离；
- CLI 不耦合 `main/orch-*` 等 lineage 命名规则。

## 8. CLI 信息架构与 UI

### 8.1 终端能力边界

CLI 使用 main buffer + DECSTBM：

- scrollback 与已提交历史不可重绘；
- 当前活跃 segment 只在受控尾部可替换；
- 状态与输入位于滚动区外的 Chrome，可绝对寻址重绘；
- Subagents 实时状态只能放在 Chrome，不能把可变详情写入 scrollback 后回头修改；
- 非 TTY、管道、重定向、dumb 或不支持 Chrome 的终端不显示实时状态，只保留追加式摘要。

### 8.2 常态三部分

输入区是核心。正常交互时底部保持三个稳定部分：

```text
全局信息状态栏
输入区
输入区下方提示行
```

原信息栏是最靠近输入区的稳定锚点行，承载：

```text
全局运行阶段 + 耗时与本轮 token │ 长期任务进度 │ 上下文/cache
```

输入区下方提示行继续承载 `esc 清空` 或候选面板提示。Subagents 不占用这一行。

### 8.3 Subagents 活跃形态

Subagents 不把完整详情塞进原信息栏。活跃期间，在原信息栏上方增加一条临时详情行：

```text
  ⌬ 3 个子任务 · 2 运行 1 完成 · #3 检查并发状态 · grep
  ◈ 子任务中 (8s · ↑ 12.4k ↓ 620) │ 推进审查 (2/5) │ ~ 14k
╭──────────────────────────────────────────────────╮
│ ❯ 输入消息或 / 查看命令                          │
╰──────────────────────────────────────────────────╯
                                           esc 清空
```

信息定义：

| 行 | 承载 |
|---|---|
| 临时详情行 | 子任务总数、运行/完成/失败/中止计数、当前焦点子任务、当前内部工具 |
| 稳定锚点行 | 简洁全局阶段“子任务中”、耗时、全轮次 token、长期任务进度、上下文/cache |
| 输入区 | 用户当前输入 |
| 底部提示行 | 输入 affordance 或候选面板提示 |

产品原则：

- Subagents 详情自身只占一行；连同原信息栏，活跃时输入区上方共两行；
- 不给每个成功子任务单独开实时行；
- Chrome 高度只在批次开始和全部结束时变化，不随单个 child 反复增减；
- 详情消失后，锚点行切回“回复中/已完成”；
- 屏幕控制器只实现“零到多条详情行 + 一条锚点行”的通用模型，不理解 Task。

### 8.4 拼接与宽度规则

两条状态行都禁止终端软折行。

临时详情行字段优先级：

1. 子任务总数及运行/完成/失败/中止计数始终保留；
2. 当前焦点编号保留；
3. 描述使用剩余宽度并安全截断；
4. 空间不足时先省略内部工具，再省略其它次要详情；
5. 不允许从右侧盲裁导致失败或中止状态消失。

稳定锚点行保持独立预算，不被详情行内容侵占。独立 tails 拼到最靠近输入区的锚点行，而不是第一条 status line。普通单行状态行为不变。

窄屏布局必须按语义降级，不按固定描述宽度拼完后整体裁切。24 / 30 / 40 列下至少保留当前状态和关键诊断；固定语义仍放不下时才拆成受宽度约束的两行。

### 8.5 完成后 scrollback

所有 Task 结束后，输出一条聚合总计：

```text
  ⌬ 3 个子任务 · 2 成功 1 失败 (29.7k · 12 次工具调用 · 27.5s)
```

只有失败或中止项增加独立告警：

```text
  ⌬ 子任务 #2 审查终端交互 ⚠ 失败 · provider timeout · sub d4e5f6
```

规则：

- 成功 Task 不逐条落行；
- 失败/中止不能只存在于主 LLM 内部结果；
- 摘要只追加一次，不做历史重绘；
- description、reason、status、成本按字段优先级布局；
- 窄屏优先保留状态、编号、核心诊断和成本，再分配描述宽度。

### 8.6 `/usage`

`/usage` 从 runtime 的结构化 `TaskUsageEntry[]` 读取，不由 CLI 自己解析 trailer。展示：

- 子任务拆分标题；
- 每个 Task 的状态、token、工具调用、耗时、短 sub id；
- 子任务总计；
- 分隔线按实时终端宽度生成。

字段优先级先保成本和状态，再给描述；不得在窄终端只剩描述而丢掉 token 或失败状态。

## 9. 接入面行为

| 接入面 | 运行中 | 完成后 |
|---|---|---|
| CLI Chrome | 临时详情行 + 稳定锚点行 | scrollback 聚合、失败/中止告警、`/usage` 拆分 |
| CLI basic / pipe | 不输出动态中间帧 | 追加式聚合与必要告警 |
| 飞书等非流式 channel | 不展示子中间过程 | 只展示主 Agent 综合答案，失败必须被主回答披露 |
| RPC | 当前不投影 child lifecycle 和 renderer-only presentation | 默认 session delta 不携带 presentation |

实际 RPC 投影随统一核心与多接入面协议统一设计。当前事件和展示元数据只保证可投影，不在局部模块提前固化 wire 契约。

## 10. 验收与回归

### 10.1 Core

- 每个工具调用获得正确且隔离的 `toolCallId`；
- `maxCallsPerTurn` 只限制单批次，前三个执行、超出逐个拒绝；
- 其他工具未声明上限时行为不变；
- presentation 不进入 transcript 和公共 session delta；
- orchestration executor 依赖旧上下文形态时保持兼容。

### 10.2 Orchestrator

- read / glob / grep / web_fetch 各组合生成真实、byte-stable 的 Task 描述；
- Task 输入拒绝错误类型、空值和额外字段；
- 子 task 只进入专用 user message，不进入 system prompt；
- 预检只拒绝明显超限，估算异常 fail-open；
- completed 空回答归类失败；
- 三态 trailer 字段和末尾锚定完全一致；
- final、partial、description、error、abort reason 全部有界；
- child start/end、toolCallId、lineage 和 presentation 关联一致；
- 父中断级联、子失败不反向中断、资源全部清理。

### 10.3 CLI

- 多 Task 按 toolCallId 独立跟踪，混合普通只读工具不串槽；
- child_end 立即更新 registry、计数、焦点和画面，call_end 不重复计数；
- 子 run_start/end 不重置主状态；
- orchestration 真实子 lineage 的进度仍可见；
- Task 活跃时显示一条详情行和一条锚点行，tails 只落锚点行；
- 批次结束详情行消失，Chrome 高度和输入位置稳定；
- 24 / 30 / 40 / 80 / 120 列及长 CJK 文本均不软折，不丢关键状态；
- 成功只进聚合，失败/中止各有告警；
- `/usage` 的状态、成本和分隔线宽度正确。

## 11. 关键实现位置

- `packages/core/src/types/tools.ts`
- `packages/core/src/types/agent-events.ts`
- `packages/core/src/loop/tool-executor.ts`
- `packages/core/src/loop/presentation.ts`
- `packages/orchestrator/src/tools/task.ts`
- `packages/orchestrator/src/tools/task-usage.ts`
- `packages/orchestrator/src/subagent/factory.ts`
- `packages/orchestrator/src/subagent/loop-runner.ts`
- `packages/orchestrator/src/subagent/result-classifier.ts`
- `packages/orchestrator/src/subagent/budget.ts`
- `packages/orchestrator/src/profile/default-profiles.ts`
- `packages/orchestrator/src/runtime/create-agent-runtime.ts`
- `packages/orchestrator/src/runtime/system-prompt.ts`
- `packages/cli/src/status-bar/status-bar.ts`
- `packages/cli/src/screen/screen-controller.ts`
- `packages/cli/src/subtasks/presentation.ts`
- `packages/cli/src/output/output-renderer.ts`
- `packages/cli/src/context-indicator/context-indicator.ts`
- `packages/cli/src/task-tail/task-tail.ts`（与 Subagents 共存的既有锚点行 tail 源，不属于子 agent 本体）
