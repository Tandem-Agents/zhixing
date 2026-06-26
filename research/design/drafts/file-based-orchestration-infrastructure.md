# 文件化可编排基础设施

## 第一部分 · 需求区

### 文件化可编排基础设施

- **本质需求**：为知行提供基于文件 / 文档 / 配置的内部编排定义基础设施，用有限规则表达多步骤、单节点执行、顺序执行和单轮多节点并发；它是多视角发散收敛等上层能力的基础设施，不绑定具体业务模块。
- **核心边界**：基础设施只负责协议、规则、校验和执行约束；由谁编写定义（产品预设 / Agent 生成 / 用户手写）不是本需求核心；角色、收敛、具体工作方法等属于上层业务，不写入底层抽象。
- **稳定性要求**：定义必须有限、可解析、可验证，应用前强制检查；拒绝无终点、失控循环、无界并发、非法引用、缺失输出契约等会导致不稳定执行的结构。
- **安全要求**：默认保守，工具、资源、并发、预算、超时和权限都必须有边界；规则检查通过前不得应用，避免 Agent 自由生成不可控流程。
- **演进方向**：第一版从多视角发散收敛这个真实消费者长出来，只覆盖它需要的有限编排与单轮并发；多轮对话、更多并发形态等更大边界作为未来延伸，等新的真实拓扑出现后再增量扩展。

## 第二部分 · 架构区

### 0. 架构结论

这是一个**内部产品基础设施**，不是第一眼暴露给用户的独立功能。

它要解决的本质不是“让用户写流程”，而是让知行可以把一组智能体动作变成**有限、可验证、可控、可观测、可复用的产品能力**。用户感知到的应该是：复杂任务被系统稳定地拆开、并行处理、按边界收回结果，而不是学习一套编排语言。

第一版只服务一个真实消费者：多视角发散收敛。架构必须允许未来扩展，但首版实现不得为尚未出现的拓扑预先建大系统。

核心设计选择：

- 编排控制在确定性侧完成，不交给主 LLM 在上下文里“读文件后自由执行”。
- 定义文件是产品资产，必须先解析、校验、归一化，通过后才允许执行。
- 首版编排模型是有限 DAG：节点、依赖、节点执行策略、输出契约。
- 首版节点类型只开放 `agent`，不引入循环、动态分支、跨轮持久化、人类裁决点、后台长任务。
- 首版必须支持“继承主注意力窗口只读快照”作为一等上下文来源；它不是 run input，也不能被塞进节点 instruction 或 system prompt。
- 角色、收敛、审查方法、业务视角不进入底层抽象，只作为上层定义里的指令内容存在。
- 首版产品入口采用可信产品模板填参：系统持有定义模板，主 LLM 只给模板参数；LLM 自由撰写任意定义文件不进入首版产品入口。
- 现有 Task / sub-agent 能力只能作为可复用地基，不是免死金牌；如果现有形态限制了正确架构，应提炼新的执行层接口，而不是把新能力塞进旧工具语义里。

### 1. 产品本质判断

顶层产品价值一句话：

> 让知行把多个受控智能体按明确步骤可靠跑完，并把结构化结果交给上层产品能力使用。

第一版用户不应该看到“编排文件”“协议”“节点 DAG”这些概念。用户应该看到的是更好的任务结果，例如一个审查请求会自然得到多个角度的并行分析和统一回收。

产品分层：

- 对普通用户：这是体验增强，不是新概念。
- 对系统内置能力：这是可复用的任务组织方式。
- 对 Agent / 开发者：这是受规则保护的定义格式和执行基础设施。

不要把“技术上可以让用户写定义文件”误判成“产品上应该让用户写定义文件”。首版定义文件可以由产品预设、内部模块或后续 Agent 生成，但基础设施只关心定义是否合规、是否安全、是否可执行。

### 2. 地基审查

现有地基有价值，但不能直接等同于本需求的架构。

可复用部分：

- `runChildAgent` 已经提供子 agent 派发、三态结果、预算、abort、事件 lineage、工具过滤和清理纪律。
- 当前工具执行器已经支持并发执行 `isParallelSafe` 工具调用。
- Task 工具证明了“父 run 内派生子 agent 并回收结果”这条执行路径是可行的。

不能直接沿用为架构的部分：

- Task 是 LLM 工具，不是确定性编排执行器。
- Task 的并发由主 LLM 发起，缺少定义级拓扑校验、全局策略约束、输出契约校验和可复用定义资产。
- Task input 只有 `description` / `prompt`，承载不了节点依赖、全局并发上限、节点预算、输出契约等基础设施语义。
- 让主 LLM 读一个文件后自行调用 Task，本质仍是 prompt 约定，不是可验证基础设施。

架构决策：

- 与 Task 并列新增独立的编排基础设施，不把 Task 当成协议层，也不通过 Task 间接执行。
- `runChildAgent` 可作为首版 `agent` 节点执行原语。
- 如果节点级预算、工具策略、输出契约需要比当前 `runChildAgent` 更细，应抽出 `AgentNodeExecutor`，反向优化地基，而不是牺牲编排模型。

### 3. 系统分层

首版分为四层：

1. **定义层**：文件 / 文档 / 配置中的编排定义。
2. **确定性内核层**：解析、schema 校验、语义校验、归一化、DAG 计划、状态机。
3. **执行适配层**：把归一化节点交给具体执行器，例如 agent 节点执行器。
4. **业务使用层**：多视角发散收敛等上层能力选择定义并消费结果。

包边界建议：

- `@zhixing/core`
  - 放纯类型、schema、validator、normalizer、DAG planner、run state 类型。
  - 放 `OrchestrationContextSnapshotV1` 与 `snapshotAttentionWindowV1`；快照来自 core 的注意力窗口，不让 runner 反向依赖活窗口实现。
  - 不依赖 orchestrator，不知道子 agent 如何运行。
- `@zhixing/orchestrator`
  - 放 `OrchestrationRunner` 和 `AgentNodeExecutor`。
  - 负责把 `agent` 节点映射到子 agent 执行。
  - 复用或重构现有 sub-agent 地基。
- 上层业务模块
  - 只拿定义和结果，不接触底层调度细节。
  - 可以内置多视角定义，但不能把“多视角”写进基础设施抽象。

#### 3.1 公共 API 契约

`@zhixing/core` 对外暴露纯函数，不执行任何 agent：

```ts
export function loadOrchestrationDefinitionV1(
  source: string,
  caps: OrchestrationSystemCaps,
): OrchestrationLoadResultV1;

export function instantiateTrustedOrchestrationTemplateV1(
  templateSource: string,
  params: JsonValue,
  caps: OrchestrationSystemCaps,
): OrchestrationLoadResultV1;

export function parseOrchestrationDefinitionV1(
  source: string,
): OrchestrationParseResultV1;

export function validateOrchestrationDefinitionV1(
  definition: unknown,
  caps: OrchestrationSystemCaps,
): OrchestrationValidationResultV1;

export function normalizeOrchestrationDefinitionV1(
  definition: OrchestrationDefinitionV1,
  caps: OrchestrationSystemCaps,
): NormalizedOrchestrationV1;

export function planOrchestrationV1(
  definition: NormalizedOrchestrationV1,
): OrchestrationPlanV1;
```

`@zhixing/orchestrator` 对外暴露执行入口：

```ts
export async function runOrchestrationV1(
  opts: RunOrchestrationOptionsV1,
): Promise<OrchestrationRunResult>;

export interface RunOrchestrationOptionsV1 {
  executable: OrchestrationExecutableV1;
  input: unknown;
  contextSnapshot?: OrchestrationContextSnapshotV1;
  executor: OrchestrationNodeExecutor;
  parent: OrchestrationParentContext;
}

export interface OrchestrationParentContext {
  abortSignal: AbortSignal;
  bus: EventBus<AgentEventMap>;
  lineage: string;
}
```

错误返回必须结构化，不用 throw 表达可预期校验失败：

```ts
export type OrchestrationLoadResultV1 =
  | {
      ok: true;
      executable: OrchestrationExecutableV1;
    }
  | { ok: false; issues: OrchestrationValidationIssueV1[] };

export interface OrchestrationExecutableV1 {
  definition: NormalizedOrchestrationV1;
  plan: OrchestrationPlanV1;
  caps: OrchestrationSystemCaps;
  sourceMode: "trusted";
}

export interface OrchestrationContextSnapshotV1 {
  source: "attention_window";
  strategy: "full_or_fail" | "tail";
  messages: readonly Message[];
  estimatedTokens: number;
  capturedAt: number;
}

export type OrchestrationParseResultV1 =
  | { ok: true; value: unknown }
  | { ok: false; issues: OrchestrationValidationIssueV1[] };

export type OrchestrationValidationResultV1 =
  | { ok: true; definition: OrchestrationDefinitionV1 }
  | { ok: false; issues: OrchestrationValidationIssueV1[] };

export interface OrchestrationValidationIssueV1 {
  path: string;
  code: string;
  message: string;
}
```

API 纪律：

- 业务调用方优先使用 `loadOrchestrationDefinitionV1`，一次完成解析、校验、归一化和计划生成。
- 多视角等首版业务入口优先使用 `instantiateTrustedOrchestrationTemplateV1`，把有界参数注入受控模板后再进入同一条 load 管线。
- `parse` / `validate` / `normalize` / `plan` 是给测试、诊断和编辑器能力使用的拆分接口。
- `normalize` 只接受已通过 `validate` 的定义，不负责容错修复。
- `plan` 只接受 `NormalizedOrchestrationV1`。
- 执行器只接受 `OrchestrationExecutableV1`，不接触原始定义，也不在运行时重新解释拓扑。
- `caps` 在生成 executable 时固化为快照；如果系统上限变化，必须重新 load，不在 run 入口再传第二份 caps。
- `sourceMode` 首版固定为 `trusted`；这表示定义来自产品内置模板或仓库内受控资产，不表示可以跳过解析、校验、归一化。

#### 3.2 首版定义来源

首版不开放“主 LLM 自由撰写 JSONC 定义文件后直接应用”的产品入口。

首版真实路径是：

1. 产品 / 开发者维护受控定义模板。
2. 主 LLM 或业务模块只提供有界参数，例如视角数量、视角名称、任务输入。
3. 系统把模板和参数实例化为定义。
4. 定义仍然经过解析、schema 校验、语义校验、归一化和计划生成。
5. 只有得到 `OrchestrationExecutableV1` 后才能执行。

这个决定避免两种债务：

- 不为了未来不可信定义来源提前建设完整治理系统、编辑器、修复器和权限模型。
- 不因为模板可信就绕过校验，导致基础设施名义上有规则、实际执行面没有规则。

未来如果出现第二个真实拓扑，且确实需要 Agent / 用户生成完整定义，再新增 source mode；新增 source mode 必须先定义信任边界、校验强度、失败反馈和安全审计，不复用 `trusted` 的语义。

### 4. 核心抽象

首版核心对象围绕四个概念。

#### 4.1 OrchestrationDefinition

编排定义。它描述“有什么节点、节点之间如何依赖、资源边界是什么、输出契约是什么”。

首版建议使用 JSONC 作为作者友好的源格式，运行时归一化为 TypeScript 对象。JSONC 只是源格式选择，不是架构核心；核心是归一化后的定义对象。

```ts
export interface OrchestrationDefinitionV1 {
  version: 1;
  id: string;
  title: string;
  description?: string;
  policy: OrchestrationPolicyV1;
  input?: OrchestrationInputContractV1;
  nodes: OrchestrationNodeV1[];
}

export interface OrchestrationInputContractV1 {
  required?: boolean;
  format: "text" | "json";
  schema?: JsonSchema;
  maxChars?: number;
}

export interface OrchestrationPolicyV1 {
  maxParallel: number;
  maxRunMs: number;
  defaultNodeTimeoutMs: number;
  defaultMaxTurns: number;
  defaultMaxTokens?: number;
  contextSnapshot?: OrchestrationContextSnapshotPolicyV1;
  allowedTools: string[];
  failureMode?: "fail_fast";
}

export interface OrchestrationContextSnapshotPolicyV1 {
  strategy: "full_or_fail" | "tail";
  maxTokens?: number;
}

export interface OrchestrationNodeV1 {
  id: string;
  kind: OrchestrationNodeKindV1;
  title?: string;
  dependsOn?: string[];
  instruction: string;
  context?: OrchestrationNodeContextV1;
  output: OrchestrationOutputContractV1;
  policy?: OrchestrationNodePolicyV1;
}

export type OrchestrationNodeKindV1 = "agent";

export interface OrchestrationNodeContextV1 {
  includeRunInput?: boolean;
  includeContextSnapshot?: boolean;
  includeNodeOutputs?: "dependencies" | string[];
}

export interface OrchestrationNodePolicyV1 {
  timeoutMs?: number;
  maxTurns?: number;
  maxTokens?: number;
  tools?: string[];
}

export interface OrchestrationOutputContractV1 {
  required: true;
  format: "text" | "json";
  schema?: JsonSchema;
  maxChars?: number;
}
```

关键取舍：

- 用 `dependsOn` 表达拓扑，不引入脚本式 `next`。
- 用 `instruction` 表达节点任务，不提供任意模板表达式。
- `context` 只允许注入 run input、显式主注意力窗口快照和依赖节点输出，不允许任意引用全局状态。
- 主注意力窗口快照是一次 run 的只读资产，必须由持有活窗口的调用方在调用 `runOrchestrationV1` 前捕获并冻结；runner 不依赖 AttentionWindow 类型，只校验和分发冻结后的纯 snapshot。
- snapshot 不属于 run input，不受 input `maxChars` 约束，但受独立 token 上限约束。
- snapshot 捕获策略必须显式：`full_or_fail` 表示整窗超限就失败；`tail` 表示按最近上下文截取有界尾部，且结果必须标记为 tail，避免上层误以为拿到了完整窗口。
- `output` 必填，因为没有输出契约的节点不可被稳定消费。
- `policy.allowedTools` 是上限，节点 `policy.tools` 只能取其子集。
- 节点 `policy.tools` 省略时默认空工具集；需要工具的节点必须显式声明，避免权限随全局策略意外扩散。
- `maxNodes` 不写进定义文件；节点数量是定义自身事实，由系统硬上限校验，避免“定义声明的节点数”和真实节点数出现双重真相源。
- `failureMode` 首版只允许 `fail_fast`，省略时归一化为 `fail_fast`；不用需要作者填写但没有选择空间的布尔字段。

#### 4.2 NormalizedOrchestration

归一化定义。它是唯一允许进入执行器的数据结构。

```ts
export interface NormalizedOrchestrationV1 {
  version: 1;
  id: string;
  title: string;
  description?: string;
  policy: NormalizedOrchestrationPolicyV1;
  input?: OrchestrationInputContractV1;
  nodeIds: string[];
  nodesById: Record<string, NormalizedAgentNode>;
}

export interface NormalizedOrchestrationPolicyV1 {
  maxParallel: number;
  maxRunMs: number;
  defaultNodeTimeoutMs: number;
  defaultMaxTurns: number;
  defaultMaxTokens?: number;
  contextSnapshot?: NormalizedContextSnapshotPolicyV1;
  allowedTools: readonly string[];
  failureMode: "fail_fast";
}

export interface NormalizedContextSnapshotPolicyV1 {
  strategy: "full_or_fail" | "tail";
  maxTokens: number;
}

export interface NormalizedAgentNode {
  id: string;
  kind: OrchestrationNodeKindV1;
  title?: string;
  dependsOn: readonly string[];
  instruction: string;
  context: NormalizedNodeContextV1;
  output: OrchestrationOutputContractV1;
  policy: NormalizedNodePolicyV1;
}

export interface NormalizedNodeContextV1 {
  includeRunInput: boolean;
  includeContextSnapshot: boolean;
  includeNodeOutputs: "dependencies" | readonly string[];
}

export interface NormalizedNodePolicyV1 {
  timeoutMs: number;
  maxTurns: number;
  maxTokens: number;
  tools: readonly string[];
}
```

归一化后必须满足：

- 节点已建立稳定 id 索引。
- 所有默认策略已显式展开。
- 所有工具、预算、超时都已解析成最终值。
- 所有引用都已绑定到确定节点。
- 定义对象不可变。

#### 4.3 OrchestrationPlan

计划是从归一化定义派生出来的确定性调度索引，不包含业务语义。

```ts
export interface OrchestrationPlanV1 {
  topologicalOrder: string[];
  dependencies: Record<string, string[]>;
  dependents: Record<string, string[]>;
  rootNodeIds: string[];
}
```

计划生成必须是纯函数：同一个 `NormalizedOrchestrationV1` 永远得到同一个 plan。runner 按 plan 推进状态，不在执行中重新理解依赖。

#### 4.4 OrchestrationRun

一次运行实例。首版只存在于当前父 run 内，不跨重启恢复，不跨多轮对话挂起。

```ts
export interface OrchestrationRunState {
  runId: string;
  definitionId: string;
  status: "running" | "completed" | "failed" | "aborted";
  startedAt: number;
  endedAt?: number;
  nodes: Record<string, OrchestrationNodeState>;
  outputs: Record<string, OrchestrationNodeOutput>;
}

export interface OrchestrationNodeState {
  id: string;
  status: "pending" | "running" | "completed" | "failed" | "aborted" | "skipped";
  startedAt?: number;
  endedAt?: number;
  error?: OrchestrationError;
}
```

### 5. 校验规则

原则：不过检，不执行；不自动修正；不静默降级。

校验分四段：

1. 解析校验：源文件必须能被解析成对象。
2. schema 校验：字段、类型、必填项、枚举、额外字段必须符合版本 schema。
3. 语义校验：依赖、预算、工具、输出契约、上下文引用必须成立。
4. 系统上限校验：定义内策略不能超过调用方和系统硬上限。

首版必须拒绝：

- `version` 不支持。
- `id` / `node.id` 不符合稳定 ID 规则。
- 节点数为 0 或超过 `systemCaps.maxNodes`。
- `policy.maxParallel` 小于 1 或超过 `systemCaps.maxParallel`。
- `policy.failureMode` 不是 `fail_fast`。
- 任一节点声明 `includeContextSnapshot`，但 `policy.contextSnapshot` 缺失。
- `policy.contextSnapshot.maxTokens` 超过 `systemCaps.maxContextSnapshotTokens`。
- 使用 `tail` 快照策略但受控模板 / 定义未显式声明。
- 依赖不存在、自依赖、循环依赖。
- `context.includeContextSnapshot` 非布尔值，或定义来源不允许继承上下文快照。
- `context.includeNodeOutputs` 引用非依赖节点。
- 节点没有 `output` 契约。
- `instruction` 为空或超过长度上限。
- 节点工具不属于全局允许工具集合。
- 任一节点预算、超时超过系统上限。
- 出现首版不支持的节点类型、循环、动态分支、人类裁决、后台任务、跨 run 状态。

系统硬上限建议由调用方注入，默认保守：

```ts
export interface OrchestrationSystemCaps {
  maxNodes: number;
  maxParallel: number;
  maxRunMs: number;
  maxNodeTimeoutMs: number;
  maxNodeTurns: number;
  maxNodeTokens: number;
  maxContextSnapshotTokens: number;
  maxInstructionChars: number;
  maxInputChars: number;
  maxOutputChars: number;
  allowedNodeKinds: readonly OrchestrationNodeKindV1[];
  allowedTools: readonly string[];
}
```

### 6. 执行模型

首版执行器是轻量确定性调度器。

输入：

- `OrchestrationExecutableV1`
- run input
- 主注意力窗口只读快照（当节点声明需要时必填）
- executable 中固化的 system caps
- parent run context
- node executor
- abort signal

输出：

- `OrchestrationRunResult`
- 每个节点的结构化状态
- 每个节点的输出或错误
- 总 usage / duration / partial 信息

执行流程：

1. 创建 `runId` 和初始 `RunState`。
2. 按定义的 input contract 校验 run input；不过检则发出结构化失败事件并返回 failed，不启动任何节点。
3. 若任一节点声明 `includeContextSnapshot`，校验本次 run 已提供 snapshot，且 snapshot strategy 与 executable 中的 snapshot policy 一致、`estimatedTokens <= policy.maxTokens <= executable.caps.maxContextSnapshotTokens`；不过检则不启动任何节点。
4. 发出 `orchestration:run_start` 事件。
5. 按 plan 找出依赖已完成的 pending 节点。
6. 在 `policy.maxParallel` 和系统上限内启动 ready 节点。
7. 节点运行时只接收确定性拼装的上下文：run input、显式主窗口快照、声明依赖的输出、节点 instruction、输出契约。
8. 节点完成后写入 `outputs[nodeId]`，更新状态并发出事件。
9. 任一必需节点失败时，按 `failureMode: "fail_fast"` 中止未开始节点并 abort 正在运行节点。
10. 所有节点完成后返回 completed；失败或中止时返回 failed / aborted 和 partial outputs。

调度伪代码：

```ts
while (hasPendingNodes(state) && !abortSignal.aborted) {
  const ready = findReadyNodes(state, executable.plan);
  startUpToParallelLimit(ready);

  if (runningCount(state) === 0) {
    return fail("No runnable nodes; definition should have been rejected by validator");
  }

  const settled = await waitForNextNodeSettled();
  applyNodeResult(settled);

  if (
    settled.status !== "completed" &&
    executable.definition.policy.failureMode === "fail_fast"
  ) {
    abortRunningNodes();
    markBlockedNodesSkipped();
    return buildFailedResult(state);
  }
}
```

这里的关键是：LLM 只负责节点内的智能判断，不负责决定下一步该跑哪个节点。下一步由确定性调度器根据 DAG 和状态决定。

#### 6.1 Abort 模型

runner 必须拥有自己的 run 级 `AbortController`，并为每个运行中节点派生 node 级 controller。

- parent abort 触发时，runner 的 run controller abort，所有 node controller 级联 abort。
- fail-fast 触发时，只 abort 本次编排的 node controller，不反向 abort 父 run。
- 用户主动停止父 run 时，编排返回 `aborted`，而不是把它伪装成节点失败。
- 节点失败导致的 fail-fast 返回 `failed`，并保留已完成节点输出和失败节点错误。

这个模型保证编排内部可以收束并发，同时不污染父 run 的生命周期。

#### 6.2 上下文快照模型

多视角首版的关键不是“并发几个 agent”，而是“多个隔离子 agent 基于同一份主注意力窗口快照独立产出”。因此快照必须是一等运行资产。

首版需要新增两个底座原语：

- `snapshotAttentionWindowV1(attentionWindow, policy, caps)`：由持有活窗口的会话 / 业务层调用，从当前主注意力窗口生成不可变快照，返回 strategy、messages、估算 tokens、捕获时间。runner 不调用它，也不依赖 AttentionWindow 类型。
- `runChildAgent({ backgroundMessages })`：子 agent 执行时接收只读背景消息，背景消息进入子 loop 的 messages 前缀，不进入 system prompt，不拼进 task/instruction。

快照纪律：

- 同一次 orchestration run 内，所有声明 `includeContextSnapshot` 的节点共享同一个 snapshot。
- snapshot 捕获发生在调用 `runOrchestrationV1` 前；节点执行期间主窗口变化不影响本次 run。
- snapshot 不属于 run input，不能用 input `maxChars` 约束，也不能把大体量对话背景塞进 instruction。
- `full_or_fail` 策略下，整窗超过 `maxTokens` / `maxContextSnapshotTokens` 必须明确失败，不静默截断。
- `tail` 策略下，只取最近上下文的有界尾部，snapshot 必须携带 `strategy: "tail"`，让节点任务和上层结果能明确知道背景不是完整窗口。
- snapshot 注入必须保持子 agent system prompt byte-equal；变量背景放在 messages 通道，保留 system prompt cache 的基本收益。
- snapshot 是只读上下文，子节点不得修改、追加或把它写回主窗口。

### 7. Agent 节点执行

首版唯一节点类型是 `agent`。

`AgentNodeExecutor` 的职责：

- 把节点 instruction、run input、依赖输出和 output contract 拼成子 agent 任务。
- 当节点声明 `includeContextSnapshot` 时，把主窗口快照作为 background messages 注入子 agent，而不是拼进 instruction 或 system prompt。
- 注入节点级预算、工具边界、超时和 abort signal。
- 执行子 agent。
- 把子 agent 三态结果转换成 `OrchestrationNodeResult`。
- 在 `format: "json"` 时尝试结构化解析并按 schema 校验；不过检则节点失败。

建议接口：

```ts
export interface OrchestrationNodeExecutor {
  runAgentNode(
    node: NormalizedAgentNode,
    ctx: OrchestrationNodeExecutionContext,
  ): Promise<OrchestrationNodeResult>;
}

export interface OrchestrationNodeExecutionContext {
  runId: string;
  definitionId: string;
  runInput: unknown;
  contextSnapshot?: OrchestrationContextSnapshotV1;
  dependencyOutputs: Record<string, OrchestrationNodeOutput>;
  abortSignal: AbortSignal;
  lineage: string;
}

export interface OrchestrationNodeResult {
  status: "completed" | "failed" | "aborted";
  output?: OrchestrationNodeOutput;
  error?: OrchestrationError;
  usage?: OrchestrationUsage;
  durationMs: number;
}

export interface OrchestrationNodeOutput {
  format: "text" | "json";
  value: string | JsonValue;
  charCount: number;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface OrchestrationError {
  type: string;
  message: string;
  origin: "validation" | "node" | "abort" | "system";
  nodeId?: string;
}

export interface OrchestrationUsage {
  inputTokens: number;
  outputTokens: number;
  toolUses: number;
}
```

与现有地基的关系：

- 首版可以用 `runChildAgent` 承载 agent 节点。
- 不应通过 Task 工具间接执行，因为 Task 是给主 LLM 的工具表面，不是基础设施 API。
- `runChildAgent` 必须补 `backgroundMessages` 参数，作为主注意力窗口快照进入子 loop 的唯一通道。
- 如果首版模板只使用只读工作区工具，可以先沿用现有 sub-agent 只读 profile；若模板需要节点级工具差异，再把 profile / budget / tool filtering 提炼成可配置执行参数。

### 8. 输出契约

输出契约是首版稳定性的关键，不能后补。

输入契约：

- 如果定义声明 `input.required: true`，运行时必须提供 input。
- `format: "text"` 时，input 必须能稳定转成文本且不超过 `maxChars`。
- `format: "json"` 时，input 必须是 JSON 值；如声明 schema，必须通过 schema 校验。
- input 不过检时，不启动任何节点，直接返回结构化失败。

文本输出：

- 节点必须返回非空文本。
- 超过 `maxChars` 时节点失败或按明确策略截断。首版建议失败，避免上层误用不完整内容。

JSON 输出：

- 子 agent 返回内容必须能解析为 JSON。
- 如声明 schema，必须通过 schema 校验。
- 不允许执行器让主 LLM“猜测修复”非法 JSON。

运行结果建议：

```ts
export interface OrchestrationRunResult {
  status: "completed" | "failed" | "aborted";
  runId: string;
  definitionId: string;
  outputs: Record<string, OrchestrationNodeOutput>;
  errors: {
    run?: OrchestrationError;
    nodes: Record<string, OrchestrationError>;
  };
  usage: OrchestrationUsage;
  durationMs: number;
}
```

### 9. 安全边界

安全默认保守。

首版不支持：

- 任意文件路径引用。
- 任意 URL / 网络资源声明。
- 脚本执行节点。
- 动态工具选择。
- 无界并发。
- 无界重试。
- 循环。
- 跨 run 状态读写。
- Agent 生成后直接执行未校验定义。

工具权限规则：

- 调用方传入 `allowedTools` 作为本次运行最高权限。
- 定义的全局 `policy.allowedTools` 必须是调用方权限子集。
- 节点 `policy.tools` 必须是定义全局工具子集。
- 子 agent 实际拿到的工具必须由执行层再次过滤。

预算规则：

- 定义内所有预算只能更小，不能突破系统上限。
- run 总超时优先于节点超时。
- parent abort 必须级联到所有正在运行节点。

### 10. 可观察性

该基础设施必须可调试，否则长期会变成黑箱。

编排事件不另起事件系统，必须直接扩展 `AgentEventMap`，通过既有 per-run `EventBus` 发射，并沿用 `meta.lineage` 冒泡、CLI 状态条和 RPC 投影机制。

首版事件：

- `orchestration:validation_failed`
- `orchestration:run_start`
- `orchestration:node_start`
- `orchestration:node_end`
- `orchestration:run_end`

事件最小字段：

- `runId`
- `definitionId`
- `nodeId`
- `status`
- `durationMs`
- `error.type`
- `usage`
- `lineage`

事件接入要求：

- `@zhixing/core` 在 `AgentEventMap` 中新增 `orchestration:*` 事件类型。
- runner 使用 `parent.bus.emit(...)`，不持有私有 `emit` callback。
- CLI / server 如需展示编排状态，只扩展既有状态条订阅和 `UI_EVENT_PROJECTION`，不引入第二套事件桥。
- 子 agent 自身的 LLM / tool / abort 事件继续走 child EventBus，并通过 lineage 冒泡到同一条总线。

日志原则：

- 定义校验失败要指出具体字段路径。
- 节点失败要保留子 agent 结构化错误类型。
- 不把完整敏感 prompt 默认打进普通日志。

### 11. 首版落地路径

第一步：核心内核

- 新增 `packages/core/src/orchestration/types.ts`
- 新增 `packages/core/src/orchestration/schema.ts`
- 新增 `packages/core/src/orchestration/validator.ts`
- 新增 `packages/core/src/orchestration/planner.ts`
- 在 core 注意力窗口侧新增或扩展 `snapshotAttentionWindowV1`，输出不可变 `OrchestrationContextSnapshotV1`。
- 新增可信模板实例化入口；首版只接受产品内置模板和有界参数，不开放 LLM 自由撰写完整定义。
- 从 `packages/core/src/index.ts` 导出公开类型和纯函数。

必须有单测：

- 合法定义通过并归一化。
- 循环依赖拒绝。
- 未知依赖拒绝。
- `failureMode` 非 `fail_fast` 拒绝。
- 非依赖输出引用拒绝。
- 超过节点数 / 并发 / 超时 / instruction 长度拒绝。
- 节点需要 context snapshot 但定义缺少 context snapshot policy 时拒绝。
- context snapshot policy 超过系统 token 上限时拒绝。
- `tail` 策略必须来自受控模板 / 定义的显式声明，不能由 runner 在超限时自动降级。
- 非允许工具拒绝。
- 缺输出契约拒绝。
- run input 缺失或不符合 input contract 时不启动节点。
- 需要 context snapshot 但未提供 snapshot 时不启动节点。
- snapshot 超过 `maxContextSnapshotTokens` 时不启动节点。

第二步：执行器

- 新增 `packages/orchestrator/src/orchestration/runner.ts`
- 新增 `packages/orchestrator/src/orchestration/agent-node-executor.ts`
- runner 只依赖归一化定义和 `OrchestrationNodeExecutor` 接口。
- agent executor 复用 `runChildAgent`，但 v1 必须补 `backgroundMessages` 注入通道。
- 编排事件直接使用 `AgentEventMap` 和 per-run `EventBus`。

必须有单测：

- 两个无依赖节点会并发执行。
- `maxParallel = 1` 时按调度顺序串行执行。
- 下游节点等待依赖输出。
- 多个并行节点收到同一份 context snapshot。
- context snapshot 进入子 agent messages，不进入 system prompt。
- runner 只接收冻结后的 snapshot，不依赖 AttentionWindow 类型。
- `full_or_fail` 超限失败；`tail` 只产生带 `strategy: "tail"` 标记的有界尾部快照。
- 节点失败时 fail-fast，并中止仍在运行节点。
- fail-fast 只中止本次编排的节点，不中止父 run。
- parent abort 时 run 返回 aborted。
- JSON 输出不符合 schema 时节点失败。
- 编排事件出现在 `AgentEventMap` 总线上，并携带 lineage。

第三步：首个真实消费者

- 用一个内置定义驱动多视角发散收敛的首版形态。
- 多视角首版从当前主注意力窗口捕获一次只读 snapshot，并让所有发散节点共享这份 snapshot。
- 这个定义可以包含多个并行 `agent` 节点。
- 如果需要最终汇总，上层可把“汇总”表达为普通依赖节点，但基础设施不命名它为收敛节点，也不理解其业务含义。

第四步：产品接入

- 普通用户入口仍是自然语言能力。
- 内部模块选择编排定义并调用 runner。
- UI 只展示任务进度和结果，不展示协议细节。

### 12. 暂不做清单

这些能力不进入首版，即使架构要保留未来空间：

- 多轮对话挂起和恢复。
- 跨进程 / 跨重启持久化运行。
- 人类确认节点。
- 后台长任务。
- 动态分支。
- 循环。
- 重试策略。
- 用户自定义编排编辑器。
- 远程定义仓库。
- 角色市场 / 角色系统。
- 业务级收敛策略。

不做这些不是能力不足，而是为了让第一版从真实拓扑长出来，避免平台化过早。

### 13. 未来扩展点

只有出现第二、第三个真实拓扑后，才考虑扩展。

可预留但不实现的方向：

- 新节点类型：`tool`、`compose`、`human_gate`。
- 有界重试：只允许固定次数、固定退避、固定失败语义。
- 跨 run 持久化：需要单独的 run store、恢复协议、幂等模型。
- 更丰富输出资产：文件、结构化对象、引用清单。
- 定义来源治理：产品预设、Agent 生成、用户导入的信任等级。

扩展原则：

- 每新增一个节点类型，必须先证明有真实消费者。
- 每新增一个控制结构，必须能被确定性校验。
- 每新增一个状态能力，必须先有可观测性和恢复语义。

### 14. 审查通过条件

进入实现前，这份架构必须同时满足：

- 需求区原文不被架构区反向改写。
- 首版只围绕真实消费者生长，不预置未验证的大拓扑。
- 底层只表达节点、依赖、策略、输入输出契约，不表达角色、收敛、审查方法等业务语义。
- 主注意力窗口快照是一等上下文来源，和 run input、instruction、system prompt 分离。
- 快照由持有活窗口的调用方捕获，runner 只接收冻结后的 snapshot，不依赖 AttentionWindow 类型。
- 快照策略必须显式，支持 `full_or_fail` 和 `tail`，不得在超限时静默自动降级。
- 定义文件不过检不执行，且校验失败有可定位 issue。
- 首版定义来源明确为可信模板填参；LLM 自由撰写完整定义不在首版入口内。
- 执行下一步由确定性调度器决定，不由主 LLM 临场解释文件决定。
- 并发、工具、预算、超时、权限、输入、输出都有明确边界。
- 失败、abort、partial output、usage、事件都有结构化结果，且事件进入既有 `AgentEventMap` / `EventBus`。
- 现有地基可复用但不绑死；如果旧地基不够好，优先提炼正确执行接口。

按这些条件审查，当前方案可以进入详细设计和实现拆解。

### 15. 最终架构判断

这个需求已经清晰到可以进入详细设计与实现拆解。

最优架构不是在现有 Task 上包一层提示词，也不是一次性建设万能引擎，而是建立一个小而硬的确定性编排内核：有限定义、强校验、轻调度、节点执行可替换、业务语义外置。

这样做既能支撑当前多视角并发需求，也不会把未来多轮、更多并发形态和更复杂业务场景提前变成首版债务。

### 16. 实现提交拆分

这不是一次提交应该完成的改动。一次性提交会把 core 协议、注意力窗口、子 agent 底座、runner、事件接入和首个消费者混在一起，难以审查，也难以定位回归。

拆分原则：

- 每个提交都必须能独立构建和测试通过。
- 每个提交都围绕一个可验证的架构边界，而不是按文件数量机械切分。
- 不提交半成品公共 API；如果一个提交引入类型或入口，它必须同时带上最小可验证实现和测试。
- 后续提交可以复用前序提交能力，但不能要求审查者跨多个提交才能理解一个单点行为。

如果当前只实现“文件化可编排基础设施”，建议拆成前 3 个独立提交。第 4 个属于首个上层消费场景进入实现时的提交；第 5 个属于消费场景产品化接入用户入口时的提交，不属于当前基础设施交付。

完整链路最多可拆成 5 个独立提交：

1. **Core 编排定义内核**
   - 新增 `@zhixing/core` 的 orchestration 类型、schema、validator、normalizer、planner。
   - 新增可信模板实例化入口与 `sourceMode: "trusted"`。
   - 将 `orchestration:*` 事件类型并入 `AgentEventMap`。
   - 覆盖合法定义、循环依赖、未知依赖、预算 / 并发 / 工具 / 输出契约 / snapshot policy 等校验测试。

2. **上下文快照与子 agent 背景注入**
   - 在 core 注意力窗口侧实现 `snapshotAttentionWindowV1`，支持 `full_or_fail` 与 `tail`。
   - 为 `runChildAgent` 增加 `backgroundMessages`，让快照进入子 loop messages，而不是 system prompt。
   - 保证 prompt cache 相关 system prompt 仍 byte-equal。
   - 覆盖整窗超限失败、tail 标记、冻结快照、背景消息注入位置等测试。

3. **Orchestrator 编排执行器**
   - 新增 `OrchestrationRunner` 与 `AgentNodeExecutor`。
   - runner 只接收 `OrchestrationExecutableV1` 和冻结 snapshot，不依赖 AttentionWindow 类型。
   - 实现 DAG 调度、`maxParallel`、fail-fast、abort 隔离、输出契约校验和 `AgentEventMap` 事件发射。
   - 覆盖并发、串行、依赖等待、节点失败、parent abort、JSON schema 输出失败、事件 lineage 等测试。

4. **多视角首个可信模板消费者**
   - 新增多视角发散收敛的受控模板和参数实例化路径。
   - 业务层在调用 runner 前捕获一次主窗口 snapshot，并让并行发散节点共享同一份 snapshot。
   - 上层可以用普通依赖节点表达汇总，但基础设施不引入“收敛”业务语义。
   - 覆盖模板参数边界、共享 snapshot、多节点并发和结果回收测试。

5. **消费场景接入（后置提交，不属于当前基础设施交付）**
   - 只有当多视角等上层消费场景正式进入实现时，才把它接到用户入口；当前基础设施阶段不凭空新增用户使用面。
   - 届时普通用户仍不直接接触编排协议，只通过上层产品能力触发编排。
   - 如用户入口需要展示编排进度，再扩展 CLI 状态条和 RPC `UI_EVENT_PROJECTION`，消费既有 `AgentEventMap` 里的 `orchestration:*` 事件。
   - 端到端验证应属于消费场景提交：用户入口触发具体场景、事件可见、失败可解释、构建产物可运行。

不建议再拆得更细。比如把 schema、validator、planner 拆成三个提交，会让每个提交都缺少完整生效面；把 snapshot 和 `backgroundMessages` 分开，则第一个提交没有真实消费者，第二个提交又无法解释为什么需要这个通道。
