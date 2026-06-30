# 任务推进闭环（Rubric 推进准则）架构

## 需求区

### 任务推进闭环（Rubric 推进准则）

- **本质需求**：用户发“任务”就是目标表达；知行默认负责推进到完成，不做显式 Goal 模式。执行侧负责干活，推进侧独立负责验收、续推和退出判断。
- **触发边界**：主 Agent 负责判断当前输入是“问题”还是“任务”；问题直接回答，任务由主 Agent 触发推进流程。具体触发机制（如工具调用）后置。
- **Rubric 定位**：Skill 教执行侧怎么做事；Rule 约束 Agent 不能 / 必须怎样；Rubric 按场景组织和检索，交给推进侧判断是否完成、未完成如何续推、何时退出。
- **Rubric 契约**：第一次 run 前，推进侧按场景命中已有 Rubric，或参照已有 Rubric 生成新的 Rubric，经用户一次确认后成为本次任务契约；开始推进后不再每轮协商。
- **运行骨架**：每轮 run 后，推进侧按确认版 Rubric 审查执行结果；未通过时，按 Rubric 中用户确认过的固定 / 非随机推进内容代理回复主线，并在显示区用特殊标记区分。
- **隔离与边界**：推进侧有独立上下文，记录用户任务、确认版 Rubric、执行结果、验收判断和代理回复；上下文尺寸复用现有注意力窗口规则，不另造窗口体系；不污染执行侧判断历史，cache 各自稳定。
- **退出条件**：验收通过则结束；判断进入死胡同、触发风险/成本/底线边界，或不能继续有效推进时退出并说明原因。

## 用户需求起点

```text
用户发任务就是目标，知行应默认负责完成，把claudecode和codex的 Goal目标模式的能力内化到 系统中
原来的agent主线 成为 执行侧，负责推进 到下一个run的 agent工作线成为 推进侧，推进侧独立于执行侧
推进侧有一套类似于 主线agent与它的skill关系的规则，像 Skill 一样加载用户长期写的推进 / 审查准则，按场景区分；run 后按命中的准则验收，未命中 参考和学习已有 规则制订
未过继续，卡住或有风险再退出。

我突然有了新的想法，就是在用户发布完一个任务以后，推进测的这个 Agent，它应该先去这个库里面找匹配的东西。

我先说一下前提：首先你得假设我们已经有一套类似于 Skill 的东西，是给推进测 Agent 用的。

流程如下：
1. 在用户发布完任务的第一个 Run 之前，推进策略应该先去这个库里面找匹配的这个类似于 Skill 的东西。
2. 如果有命中，就直接提示给用户让用户确认。用户确认完之后就按这个推进就完事了。
3. 如果没有命中，Agent 立刻就写一套这个验收规则。写完以后，这就立马成为一个独立的、类似于 Skill 的验收标准，并且是针对这个场景下的。这是一个新的场景。
   - 如果用户同意，它就被沉淀下来，未来也可以复用。
   - 如果用户不同意，那就立刻修改。用户说想法，让 Agent 现场修改。修改完以后，用户确认，这个场景的新验收规则就被沉淀下来了。

也就是说，我们把这个验收标准都放在接收到任务以后、第一次 Run 之前的这个场景就确认好，是用户主动确认好的这么一个东西。那就没有问题了，那就是一个确定的东西了。这就避免了那个模糊性，就是怕这个 Agent 写的验收标准不符合用户需求，就把这个完全给排除了。因为我们把时机放到了接收到用户任务以后、第一次 Run 之前，让 Agent 先去做这个事儿。有命中的就提示给用户要用这个了，就是问用户是否同意，同意的话就直接推进。如果没有命中的话，推进测 Agent 现写一套基于这个场景的验收标准，然后让用户确认。用户确认的话也表明了他的意图，他是认可的。如果用户不认可的话，现场修改。

所以我觉得这个思路很好。



我其实之前很早就有这个想法了，就是关于主线 Agent 的执行侧，负责推进任务执行的这一条支线（或者说另一条主线，具体是主是支不好定，关键看产品定义上怎么看待它的重要性）。我理解它是另一条主线，即“推进侧”。

按照我们刚才的理解，推进侧只负责：
1. 命中验收标准或制定验收标准；
2. 根据验收标准去推进任务执行；
3. 守住底线边界：不能随随便便几个 run 就结束（这会极大影响产品质量），也不能无限跑下去，要有最低边界。

这是我的初步想法，再补充一点：

关于主线 Agent 和支线 Agent，就像球员和裁判的关系，他们要分开。



确实不应该是用户的每一个问题都进入这个推进的流程。比如用户问“今天天气怎么样”、“我的文档中有什么内容”或“这个项目有什么信息”，这种属于问题而非任务，因此需要对问题和任务进行拆分。
问题是不需要进入这个推进流程的，只有任务需要。

关于这个判断节点，我在考虑两种方案：
1. 由主 Agent 自己触发：给它加一个提示词，让它自己去触发这个流程。
2. 新增一个判断节点：专门用来判断是否要触发这个流程。



主agent工作线，也就是 执行侧的 前缀cache不动，推进侧 的 前缀cache也不动，各自工作互不打扰；



执行侧的这个 Agent，在处理的不是问题而是一个任务的情况下，会进入我们的推进流程。

进入流程后，我们不能假设任务的大小。它可能需要连续工作几个小时，也可能只需要几分钟。如果需要工作数小时，由于时间长、内容多，显然会涉及很多个生命周期窗口（即上下文注意力窗口）。

在这种情况下，推进侧的 Agent 也会面临上下文尺寸的问题。在我看来，它不需要新造一套上下文尺寸规则，直接按照现有的注意力上下文窗口规则来处理就行了。

我的理解应该是这样的：虽然它的内容和主 Agent 执行侧的内容不太一样（它接收的核心是从任务开始后的后续内容），但它仍然可能产生大量的上下文。所以针对尺寸这件事，它们通用一套规则就好了，这个逻辑很清晰吧？

我们来详细描述一下推进侧 Agent 的具体职能和工作流程：

1. 任务接收与触发
   首先由执行侧（即主 Agent）负责接收任务，因为用户是直接与它沟通的。主 Agent 在沟通中判断：
   (a) 如果是普通问题，由主 Agent 直接处理。
   (b) 如果判定为任务，则由主 Agent 调用工具或通过特定逻辑来触发进入推进流程。

2. 场景规则匹配与生成
   工作流转入推进侧后，在第一次 Run 执行之前，推进侧会先进行规则触发判断：
   (a) 检索是否命中已有的场景规则（类似于一套 Ski/SOP 逻辑）。
   (b) 如果未命中，推进侧会基于已有规则进行临时的学习和借鉴，制作出一套新的场景规则并将其落地。

3. 用户确认环节
   无论是命中了已有规则，还是新生成的规则，推进侧都需要将这套验收规则（即结束条件）交给用户确认。只有在用户确认没有问题后，推进侧才正式开始推进。

4. 循环推进逻辑
   正常流程下，一次 Run 结束后工作就停止了，由用户判断是否完成。但在推进模式下：
   (a) 推进侧会在每次 Run 结束后，提取用户确认过的推进条件进行逻辑判断。
   (b) 推进判断的逻辑不会进入主 Agent 的历史对话。
   (c) 如果判断任务未完成，推进侧将按照规则中预设的信息进行回复。这些回复信息不是随机生成的，而是写在规则里的固定内容。

5. 代理回复机制
   推进侧会代替用户将规则信息发送给主 Agent。在产品定义上，这相当于一次用户消息，但需要加一个特殊的标记，表明这是由“推进侧”自动触发的，以便在前端显示上进行区分。

通过这种代替用户回消息的方式，工作将持续推进，直到最终完成。



推进侧结束工作条件很清晰：
1、按照结束条件、验收条件通过，完成任务
2、推进侧判断 执行侧进入 死胡同，无法完成任务
3、一条底线，不允许 执行侧无限执行；

由主agent 来判断是 问题，还是任务，如果是任务，主agent调用工具，或者以其他形式 触发 推进流程，感觉这个说过了，很清晰；



推进侧的 类似于 skill 的 规则 名称已定，叫 Rubric（推进准则）；
Skill 教执行侧怎么做事；Rule 约束 Agent 不能/必须怎样；Rubric 交给推进侧判断任务是否完成、未完成如何续推、何时退出。

Rubric 不是每轮协商的东西，是开跑前一次确认后的任务契约
```

## 架构内容

### 0. 设计裁决

任务推进闭环不是显式 Goal 模式，也不是 runtime 在 `onAfterRun` 里递归调用自己。它是会话 owner 级能力：在用户真实任务进入执行前建立一次 Rubric 契约，在每个已接受 run 之后由推进侧验收，未通过则把一条带来源标记的代理消息排回同一会话串行队列，直到验收通过或触发退出边界。

核心裁决：

- 用户发任务就是目标表达；系统默认负责把任务推进到完成。
- 主 Agent 的推进准入策略负责区分问题 / 普通任务 / 推进任务；问题和普通任务直接进入普通执行，只有值得启动闭环的推进任务才进入 Rubric 契约流程。
- 准入分级只决定交互重量，不决定知行是否负责完成；普通任务仍是目标表达，只是不启动开跑前确认与每轮独立验收。
- Rubric 经用户一次确认后成为本次任务不可变契约；开始推进后不再每轮协商。
- 推进侧是裁判，不是执行者；它可以验收、归因、按 Rubric 代理续推，但不得替执行侧干活。
- 续推不设固定最大 run 次数；每次续推必须基于 Rubric 证明还有有效推进内容，否则退出并说明原因。
- 推进侧状态独立于执行侧历史；只有代理消息进入主线，并且必须带产品层来源标记。

### 1. 范围

本文定义“任务推进闭环”系统架构：触发、Rubric 契约、推进会话、验收、代理消息、退出、持久化、事件与实施路径。

不在本文展开：

- Rubric 文件协议本身，见 [`rubric-protocol.md`](./rubric-protocol.md)。
- Rubric 内容写作规范的长期演化。
- 多视角发散收敛、BackgroundAgent、Workflow 等通用编排能力。
- 让用户在每次发任务时手写验收标准。

### 2. 现有地基判断

知行已经具备可承接本能力的关键地基：

- `ConversationManager` 是会话 owner，持有注意力窗口、turnCount、接受协议和 per-conversation 串行队列；它是推进闭环的正确挂载层。
- `runtime.run()` 是纯执行体，返回 `RunResult`，其中含 `runRecord`、`newMessages`、`windowCompact` 等结果；它不应自行决定下一轮调度。
- `recordTurn` 已经落实“先持久化 / pending 入列成功，后 acceptRun”的接受协议；推进验收必须发生在 run 被接受之后。
- `AgentRuntimeLifecycle.onBeforeRun/onAfterRun` 是 run 边界地基，但它只适合观测、注入和状态更新，不适合直接递归续跑。
- 注意力窗口、SegmentManager、prompt cache 稳定前缀、Skill Store 机制都可复用；推进侧不需要另造窗口尺寸规则。

因此终态不是“新增一个工具让主 Agent 自己循环”，而是在会话 owner 外围增加 `AdvancementController`，由它驱动任务级状态机。

### 3. 终态拓扑

```text
ConversationManager（会话 owner / 串行点）
├─ ManagedSession
│  ├─ main runtime（执行侧，现有 AgentRuntime）
│  ├─ attention window（执行侧窗口，现有）
│  └─ advancementSession?（当前任务推进会话，至多一个 active）
├─ AdvancementController（任务推进闭环控制器）
│  ├─ AdvancementAdmissionStrategy（主 Agent 推进准入策略：问题 / 普通任务 / 推进任务）
│  ├─ RubricContractBuilder（命中 / 生成 / 确认 Rubric）
│  ├─ AdvancementRuntime（推进侧独立判断运行体）
│  ├─ ProxyMessageScheduler（代理消息入同一会话队列）
│  └─ AdvancementStore（推进会话控制日志）
└─ RubricStore（Rubric 一等资产库，协议见 rubric-protocol）
```

职责分界：

| 组件                  | 职责                                           | 不做                             |
| --------------------- | ---------------------------------------------- | -------------------------------- |
| 执行侧 main runtime   | 按用户 / 代理消息执行任务                      | 不判断自己是否完成               |
| AdvancementController | 任务级状态机、调度下一轮                       | 不生成执行方案、不替执行侧改文件 |
| AdvancementRuntime    | 按确认版 Rubric 验收、选择未通过处理、判断退出 | 不写主线历史、不每轮找用户确认   |
| RubricStore           | 存储、检索、版本化 Rubric                      | 不参与 run 调度                  |
| ConversationManager   | 串行、持久化、窗口接受、事件组播               | 不内嵌 Rubric 语义               |

### 4. 核心数据模型

#### 4.1 AdvancementAdmissionDecision

```typescript
interface AdvancementAdmissionDecision {
  kind: "question" | "direct-task" | "advancement-task";
  reason: string;
  objectiveSignals: ObjectiveSignalKind[];
  requiresRubricContract: boolean;
}
```

`direct-task` 仍是任务，仍由执行侧尽力完成；它只是不启动“开跑前 Rubric 确认 + 每轮独立验收 + 自动代理续推”的重型闭环。准入策略不向用户要模式选择，也不要求用户额外写验收标准。

```typescript
type ObjectiveSignalKind =
  | "file-diff"
  | "test-result"
  | "build-result"
  | "log"
  | "artifact"
  | "conversation-fact"
  | "none";

interface EvidenceRequirementSpec {
  id: string;
  kind: ObjectiveSignalKind;
  description: string;
  required?: boolean;
}
```

`EvidenceRequirementSpec` 只描述推进侧应核验什么证据，不描述执行侧怎么产生证据。

#### 4.2 AdvancementSession

`AdvancementSession` 是一次用户任务的推进状态，归属某个 conversation，至多一个 active。

```typescript
interface AdvancementSession {
  id: string;
  conversationId: string;
  status:
    | "awaiting-rubric-confirmation"
    | "active"
    | "completed"
    | "exited"
    | "cancelled";

  originalUserTask: UserTurnInputSnapshot;
  createdAt: string;
  updatedAt: string;

  pendingRubricDraft?: RubricContractDraftSnapshot;
  confirmedRubric?: ConfirmedRubricSnapshot;
  runs: AdvancementRunReview[];
  proxyMessages: AdvancementProxyMessage[];
  outstandingProxyMessageId?: string;
  exit?: AdvancementExit;
}
```

`pendingRubricDraft` 只存在于 `awaiting-rubric-confirmation` 状态，属于控制面草案，不进入主线 transcript。`confirmedRubric` 是本次任务契约快照。Rubric 库里的文件后续变化，不影响已经 active 的推进会话。`outstandingProxyMessageId` 用来保证同一推进会话同时最多只有一条尚未执行的代理消息。

#### 4.3 RubricContractDraftSnapshot

```typescript
interface RubricContractDraftSnapshot {
  draftId: string;
  originalTurnId: string;
  source: "matched" | "generated";
  candidateRubricIds: string[];
  title: string;
  description: string;
  content: {
    passCriteria: string;
    evidenceRequirements?: EvidenceRequirementSpec[];
    failureHandling: FailureHandlingSpec[];
  };
  createdAt: string;
}
```

草案是等待用户一次确认的控制面对象。它可以来自命中的 Rubric，也可以由推进侧按协议生成；但在用户确认前，它既不是执行侧消息，也不是本次任务的最终契约。

#### 4.4 ConfirmedRubricSnapshot

```typescript
interface ConfirmedRubricSnapshot {
  rubricId: string;
  rubricVersion: string;
  title: string;
  description: string;
  content: {
    passCriteria: string;
    evidenceRequirements?: EvidenceRequirementSpec[];
    failureHandling: FailureHandlingSpec[];
  };
  confirmedAt: string;
  confirmedBy: "user";
}
```

如果没有命中已有 Rubric，推进侧生成新 Rubric 草案，经用户确认后先进入 RubricStore，再把保存后的版本作为本 session 的快照。`evidenceRequirements` 是推进侧独立取证的协议入口；并非每类任务都必须有客观证据，但一旦任务存在文件、测试、构建、日志、差异等可核对信号，Rubric 草案应尽量把证据要求写入契约，供推进侧独立验收。

#### 4.5 AdvancementRunReview

```typescript
interface AdvancementRunReview {
  id: string;
  runIndex: number;
  runRecordRef?: { shardId: string; runIndex: number };
  reviewedAt: string;
  decision: "passed" | "failed" | "exit";
  evidence: ReviewEvidence[];
  unmetCriteria: string[];
  selectedFailureHandlingId?: string;
  proxyMessageId?: string;
  exitReason?: AdvancementExitReason;
}
```

推进侧审查基于已接受的 run：run 未持久化 / 未入窗，不进入推进判断，避免把失败或回滚中的半成品当事实。

#### 4.6 AdvancementProxyMessage

```typescript
interface AdvancementProxyMessage {
  id: string;
  sessionId: string;
  reviewId: string;
  content: UserTurnInputSnapshot;
  rubricFailureHandlingId: string;
  variables: Record<string, string>;
  createdAt: string;
}
```

代理消息的文本来自 Rubric 的 `failureHandling`。推进侧只允许填事实变量，不允许改写推进意图。

### 5. 生命周期流程

#### 5.1 用户输入进入

用户消息进入 `session.send` 后，由会话 owner 先确定 conversation 身份，再交给 `AdvancementController.prepareUserTurn`：

1. 若当前会话已有 `awaiting-rubric-confirmation` 或 `active` 推进会话，用户真实输入优先，按“用户中途输入”规则处理。
2. 若无待确认或 active 推进会话，主 Agent 推进准入策略判断本输入是问题、普通任务还是推进任务。
3. 问题：直接走现有 `runTurnWithCommit`。
4. 普通任务：直接走现有 `runTurnWithCommit`，不进入 Rubric 契约。
5. 推进任务：进入 Rubric 契约准备，不立刻执行 main runtime。

这里的“主 Agent 推进准入策略”属于主 Agent 的任务识别与成本判断策略，不是推进侧裁判。它只回答“这次是否值得启动任务推进闭环”，不制定验收标准，不要求用户补写验收条件。

实现上，准入策略运行在执行 run 之前的控制面：可以使用主 Agent 的身份、会话投影与轻量判断调用，但这次判断不写主线 transcript，不产生 RunRecord，不调用执行工具。这样既满足“主 Agent 判断是否进入推进”，也保证 Rubric 确认发生在第一次执行 run 之前。

推进准入的核心不是“用户有没有说成任务”，而是“这次是否值得付出开跑前确认与后续验收成本”。典型进入推进闭环的信号包括：任务存在明确客观完成信号、可能跨多轮 run、失败代价较高、用户显式要求审查/验证/完成到某标准、或需要沉淀可复用 Rubric。轻量、即时、低风险任务应直接执行，避免把重流程压到日常小需求上。

准入判断必须有自然语言逃生阀，但不暴露“Goal 模式”开关：

- **用户显式升级**：用户用自然语言表达“盯到验收通过”“帮我改到测试全绿”“持续推进到完成”等意图时，即使任务本身不复杂，也按推进任务处理。
- **用户显式降级**：用户在待确认阶段表达“别确认了，直接做”“不用盯后续，先完成这一下”等意图时，取消待确认推进会话，把原始任务按普通任务执行。
- **执行后升级**：普通任务执行后，用户追加“这个继续盯到完成 / 按标准验收”时，视为新的推进任务；在下一次执行 run 前建立 Rubric 契约。

#### 5.2 第一次执行 run 前：Rubric 契约

推进任务进入推进流程后：

1. `RubricContractBuilder` 用用户任务检索 RubricStore。
2. 命中：生成 `RubricContractDraft`，展示给用户确认。
3. 未命中：参考已有 Rubric 与协议规格生成新 Rubric 草案，展示给用户确认。
4. 用户确认后，写入 `AdvancementSession.confirmedRubric`；若是新 Rubric，同步写入 RubricStore。
5. 会话状态进入 `active`，原始用户任务作为第一条执行 turn 入队。

用户确认只发生在这里。进入 `active` 后，推进侧按确认版 Rubric 自动推进，不再每轮询问用户。

Rubric 确认是控制面流程，不是一次执行 run：

- `session.send` 判断为任务后，创建 `awaiting-rubric-confirmation` 的 `AdvancementSession`，返回包含 `advancementSessionId`、`rubricDraftId`、`status: "awaiting-rubric-confirmation"` 的结果。
- 控制面向 CLI / RPC 显示 Rubric 草案与确认操作；此时不调用 `runTurnWithCommit`，不写 RunRecord。
- CLI 接入面不得新造 Rubric 专用确认面板；Rubric 草案确认必须适配现有 `SelectionService`，由 CLI 把控制面草案映射成 `SelectionRequest`，再把 `SelectionResult` 翻译为确认 / 取消 / 后续编辑动作。
- 若现有 `SelectionService` 表达力不足，不得在 Rubric 侧补专用面板、专用状态机或专用字段；应先把选择模块升级成领域无关的通用能力，再由 Rubric 适配器消费。
- Rubric 确认面必须提供降级动作：用户选择“直接执行不启用推进”时，关闭待确认推进会话，原始任务按普通任务进入执行，并复用原始 `turnId`。
- `session.complete` 仍只表示执行 run 的终止结果，不用它伪装 Rubric 草案完成；等待确认、取消、草案更新走 `session.event` 的控制面事件。
- 原始 `turnId` 绑定原始用户任务，并由 RPC / 控制面保存。用户确认通过独立确认方法进入：确认后构造闭包持有原始 `turnId` 的 `makeTask`，再把原始用户任务交给 `ConversationManager.admitTurn`；`admitTurn` 不接收 `turnId`，只负责准入、排队和返回 admission。后续 delta / complete 仍使用该原始 `turnId`；取消则 session 标记 `cancelled`，发控制面取消事件，原始任务不执行。
- 确认草案与确认记录进入 AdvancementStore，不进入执行侧注意力窗口。

#### 5.3 执行 run

执行 run 完全复用现有路径：

```text
run 输入 = [...执行侧注意力窗口, 当前用户/代理消息]
  → main runtime.run()
  → completed 时 manager.recordTurn()
  → appendRun 成功
  → execution window.acceptRun()
```

推进侧不插入主线 system prompt，不改 tools，不改执行侧窗口。

#### 5.4 run 接受后验收

`recordTurn` 成功后，`AdvancementController.afterTurnCommitted` 读取 active session 与本次 run 事实：

1. 把 `runRecord`、最终 assistant 回复、工具调用投影、推进侧独立读取的证据交给 AdvancementRuntime。
2. AdvancementRuntime 按确认版 Rubric 通过裁判判定工具输出 `passed` / `failed` / `exit`。
3. 记录 `AdvancementRunReview` 到 AdvancementStore。

验收通过：

- session 标记 `completed`。
- 不生成代理消息。
- 向显示层发 `advancement:completed` 事件。

未通过：

- 从 Rubric 的固定 `failureHandling` 中选择对应项。
- 填入事实变量，生成 `AdvancementProxyMessage`。
- 通过 `ProxyMessageScheduler` 安排为同一 conversation 的下一条内部代理 turn。

代理续推不是普通用户排队：

- 每次验收最多生成一条代理消息；该消息执行前，不得为同一 session 再生成新的代理消息。
- 代理消息不占用户 pending 上限，也不绕过串行执行；它只是在当前 run 完成后接续进入同一 conversation。
- 若代理消息执行前收到用户真实输入，用户输入优先，未执行的代理消息取消，active 推进会话按用户输入重新判断或退出。

用户中途输入要分层处理，不能一概终止推进：

- **补充 / 微调**：用户输入仍服务同一目标，且不改变已确认 Rubric 的通过标准；取消未执行的代理消息，把用户输入作为下一条真实用户 turn 执行，推进会话保持 active，run 接受后继续按原 Rubric 验收。
- **目标变更 / 接管**：用户输入改变任务目标、改变验收标准、要求停止自动推进，或开启新任务；当前推进会话 `exited` 或 `cancelled`，再按新输入重新准入。
- **代理 run 正在执行时用户输入到来**：会话 owner 先调用现有 abort 能力中止 in-flight 代理 run；未 completed 的代理 run 不落盘、不入窗、不触发推进验收。若代理 run 已完成并被接受，则按已接受事实处理，再让新用户输入进入上述分层。

退出：

- session 标记 `exited`。
- 展示退出原因。
- 不再自动续推。

#### 5.5 代理消息执行

代理消息进入主线时，在模型协议上仍是 `role: "user"`，因为它承担“下一轮用户等价输入”的语义；但在产品事实上它不是用户本人输入，必须带来源元数据。

需要扩展：

```typescript
type TurnSource = "interactive" | "scheduler" | "channel" | "advancement";

interface RunRecord {
  // 既有字段...
  source?: TurnSource;
  advancement?: {
    sessionId: string;
    proxyMessageId: string;
    reviewId: string;
  };
}
```

显示层据 `source: "advancement"` 使用特殊标记；LLM 只看到 Rubric 固定内容生成的 user message，不看到推进侧思考过程。

`source` 与 `advancement` 是 run 级来源元数据，不是 `Message` 字段。模型协议里的消息仍保持纯净的 `role/content`；history、RPC wire、CLI 渲染从 `RunRecord` 读取来源信息，避免把产品来源标记泄漏进模型上下文。

### 6. 推进侧运行体

`AdvancementRuntime` 是独立判断运行体，不复用 Task 子 Agent：

- Task 子 Agent 是一次工具调用内部委托，不跨 run，不持久化中间过程。
- 推进闭环跨多个主线 run，需要任务级状态、持久化、代理消息和恢复能力。

AdvancementRuntime 第一版能力：

- 使用独立 system prompt / profile：身份是“推进侧裁判”。
- 默认使用当前执行侧同 provider / model / account 的可靠验收档模型，形成独立缓存链；以后可做专用 evaluator role，但不能降低验收可靠性。
- 具备受限的独立只读取证通道：可按 Rubric 的 `evidenceRequirements` 读取文件差异、测试/构建结果、日志、产物状态等客观证据；不得写文件、执行副作用工具或替执行侧完成任务。
- 需要新增证据但当前证据不存在时，通过代理消息要求执行侧补充；推进侧不得把“执行侧自述”当成客观证据的替代品。
- 有独立 AdvancementWindowState，窗口尺寸复用现有注意力窗口规则。
- 上下文只包含：用户任务、确认版 Rubric、每轮执行结果、验收判断、代理回复。

证据策略分层：

- 有客观信号的任务，推进侧必须优先独立核验证据，再做判断。
- 无客观信号的任务，推进侧以已确认 Rubric 的文本标准、执行侧产出和对话事实做审查，并更保守地退出或请求用户裁决。
- LLM 判断只负责解释证据和对照 Rubric，不负责替代证据本身。

验收成本也按可靠性分层：能由确定性证据或轻量模型可靠判断的，不强制每轮使用 main 档；只有语义判断复杂、证据不充分或风险较高时才使用高质量验收档。成本分层不能牺牲验收可靠性，也不能变成固定最大 run 次数。

当前 LLM 请求协议没有框架级 structured output / json schema 原语。推进侧不得把裁判结论建立在“纯文本 + 正则 / 宽松 JSON 解析”上；第一版应通过专用裁判工具调用提交结论，工具 input schema 强约束 `decision`、`evidence`、`unmetCriteria`、`selectedFailureHandlingId`、`exitReason` 等字段，工具执行体只做校验和返回，不产生副作用。

实现上可以复用 provider 调用、prompt 组装、工具调用、注意力窗口与 SegmentManager 等底层原语，但不得复用执行侧 main runtime 的 loop / tools / lifecycle。若第一版为了装配便利使用 runtime 能力，也必须是专用 evaluator runtime，且只暴露只读取证工具与裁判判定工具，禁用执行工具与主线 transcript 写入。

推进侧不写主线 transcript；它的判断过程只进入 AdvancementStore。

### 7. 退出边界

本能力不设置“最多连续 N 次 run”一类固定上限。退出由有效性与边界驱动：

- **通过退出**：Rubric 的通过标准满足。
- **无有效推进内容退出**：未通过但 Rubric 没有可适用的固定 failureHandling，或填不出新的事实变量。
- **死胡同退出**：连续推进无法产生新证据、新缺口或新策略，继续发送同类代理消息只会重复消耗。
- **风险退出**：触发安全、权限、外部副作用、用户底线或成本风险，推进侧不擅自升级。
- **用户接管 / 目标变更退出**：用户真实输入改变目标、修改验收标准、要求停止自动推进，或开启新任务。

死胡同判断的核心不是 run 次数，而是“下一条代理消息是否还能带来新的有效推进”。不能证明有效，就退出。

### 8. RubricStore 与资产模型

Rubric 是与 Skill / Rule 同级的一等资产。第一版 Store 采用与 Skill 相同的资产组织模式，但必须独立实现 Rubric 语义：

```text
~/.zhixing/rubrics/
├── index.json
├── own/<id>/RUBRIC.md
├── linked/<id>/RUBRIC.md
└── archived/<id>/RUBRIC.md
```

这里的“同构”只指资产目录与索引模式相似，不指直接复用 `SkillStore` 代码。`SkillStore` 绑定 `SKILL.md`、frontmatter、mode、pinned、skill source 等技能语义，不能作为 RubricStore 的实现捷径。若后续确实需要复用，应先提取领域无关的 ManagedAssetStore / ManagedDocumentStore 基础设施，再让 SkillStore 与 RubricStore 分别承载各自协议。

`id` 是 Rubric 的稳定资产身份，首次保存时写入 `RUBRIC.md` frontmatter；后续 `title` 只作为可编辑展示名，不再反向改变资产身份。

第一版只要求：

- `listForMatching()`：返回 id / title / description 等轻量索引。
- `load(id)`：加载全文。
- `saveOwn(draft)`：保存用户确认后的新 Rubric。
- `archive(id)`：归档。

匹配只看 Rubric 的 title / description / 场景描述；正文按需加载，保持渐进披露。Rubric 索引只进入推进侧上下文，不进入执行侧 system prompt。

### 9. Cache 与上下文边界

执行侧与推进侧各自拥有稳定前缀：

- 执行侧：现有 main runtime 的 tools / system / messages 规则不变。
- 推进侧：独立 profile、独立 Rubric 索引、独立判断历史。
- 代理消息只追加到执行侧 messages 尾部，是正常对话增长，不改执行侧 tools/system。
- 推进侧判断过程不进入执行侧 messages，避免污染主线判断与 cache。

这与提示词缓存文档的结论一致：支线/推进侧不会顶掉主线 cache；真正要守住的是两条链各自前缀稳定。

### 10. 事件与产品显示

新增事件面：

| 事件                               | 时机                               | 用途                 |
| ---------------------------------- | ---------------------------------- | -------------------- |
| `advancement:contract_draft`     | Rubric 草案生成                    | UI 展示确认面        |
| `advancement:contract_confirmed` | 用户确认 Rubric                    | 标记任务进入推进     |
| `advancement:contract_cancelled` | 用户取消或新真实输入覆盖待确认草案 | 清理确认面与等待态   |
| `advancement:run_reviewed`       | 每轮 run 验收完成                  | 展示验收摘要 / 调试  |
| `advancement:proxy_enqueued`     | 代理消息入队                       | 显示“推进侧将继续” |
| `advancement:completed`          | 验收通过                           | 显示任务完成         |
| `advancement:exited`             | 退出                               | 显示退出原因         |

这些事件经 `session.event` 的带外通道发出，不混入 `session.delta` / `session.complete` 的执行流。

显示规则：

- 用户真实消息保持原样。
- 推进侧代理消息在对话流中显示，但用明确来源标记区分。
- 推进侧判断详情默认折叠；需要时可展开。
- Rubric 确认面是任务开始前的一次控制面，不是主线聊天内容；CLI 投影复用 `SelectionService`，其它接入面按同一控制面事件投影自己的确认 UI。
- 选择模块的演进必须保持通用：新增能力只能抽象为短决策、说明展示、详情展开、输入补充、二次确认、编辑承接等领域无关交互能力，不能出现 Rubric 专属协议。

### 11. 包与代码落点

| 包                        | 新增/改造                                                                              | 说明                                                   |
| ------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `@zhixing/core`         | `rubrics/`、`advancement/` 基础类型、TurnSource 扩展                               | 资产协议、纯类型、存储原语                             |
| `@zhixing/orchestrator` | `AdvancementRuntime`、RubricContractBuilder、推进准入判断、评价 prompt、代理消息构造 | LLM 判断与执行侧 runtime 同层装配                      |
| `@zhixing/server`       | `ConversationManager` 接入 `AdvancementController`、RPC 确认方法、事件组播         | 会话 owner 与串行队列                                  |
| `@zhixing/cli`          | Rubric 确认适配器、代理消息标记、推进事件渲染                                          | 接入面投影，不持状态；确认交互复用`SelectionService` |

关键改造点：

- `ConversationManager` 增加 `advancement?: AdvancementController` 依赖。
- `session.send` 仍是入口，但返回结果需要扩展出 `awaiting-rubric-confirmation` 状态：先由会话 owner 确定 conversation 身份，再交给 AdvancementController；若进入 Rubric 契约，不执行 main runtime，也不发执行态 `session.complete`。
- 新增 Rubric 确认 RPC / CLI action：确认后由 RPC / 控制面在 `makeTask` 闭包中复用原始 `turnId`，再把原始用户任务交给 `ConversationManager.admitTurn`；取消则关闭推进会话、发控制面事件且不执行原任务。
- CLI action 通过现有 `SelectionService.choose` 承载一次性确认；Rubric 领域只提供 `SelectionRequest` 映射器，不直接依赖 TUI region。
- 若 Rubric 确认需要选择模块当前没有的能力，改造点归 `packages/cli/src/tui/selection/` 的通用协议与 presenter，不落在 Rubric 业务适配器里；选择模块不得 import 或感知 Rubric。
- `recordTurn` 成功持久化并入窗后，才调用 `afterTurnCommitted`；可复用现有 `onTurnCommitted` 信号，但调度下一条内部代理 turn 的权限留在 server 层 controller。
- 推进侧新增受限只读取证通道，只读客观产物，不复用执行侧写工具，不通过执行侧自述替代证据。
- `pendingQueues` 增加内部来源 `advancement` 的调度语义：同一推进会话最多一条 outstanding 代理消息，不占用户 pending 上限，不允许堆积。
- `RunRecord` 增加 run 级 advancement 元数据，history / RPC wire / CLI 渲染同步透传；不得把来源元数据塞进 `Message`。

### 12. 实施路径索引

§15 的 C1-C9 是唯一的提交与审查执行计划。本节不再维护独立 M1-M6 实施路径，避免两套计划并存。

旧阶段语义与 §15 的对应关系：

| 原阶段语义               | §15 执行单元 |
| ------------------------ | ------------- |
| Rubric 协议与资产        | C1            |
| 推进会话控制日志         | C3            |
| 准入与契约控制面         | C4 + C5       |
| Selection 通用升级       | C2            |
| 执行后验收 / 取证 / 裁判 | C6 + C7       |
| 代理续推与队列           | C8            |
| 窗口、恢复、观测、端到端 | C9            |

后续实施和审查只按 §15 执行；若本节映射与 C1-C9 冲突，以 C1-C9 为准。

### 13. 测试拓扑

必须覆盖：

- 问题输入不进入推进流程。
- 普通任务直接执行，不生成 Rubric 草案，不进入推进会话。
- 推进任务先生成 / 命中 Rubric，并在用户确认前不执行 main runtime。
- 用户显式升级时进入推进任务；用户在 Rubric 待确认阶段显式降级时按普通任务执行。
- Rubric 确认流程返回控制面状态，不生成主线 RunRecord，不发送执行态 `session.complete`。
- Rubric 确认后执行第一轮 run 时，RPC / 控制面通过 `makeTask` 闭包复用原始 `turnId`；`admitTurn` 接口不新增 `turnId` 参数。
- CLI Rubric 确认调用现有 `SelectionService`，不直接 import `security/select-operation-region`，不新增专用选择状态机。
- 选择模块不出现 Rubric 专属字段、分支或文案；Rubric 只通过适配器映射通用 `SelectionRequest`。
- 用户确认后的 Rubric snapshot 不随库文件变化。
- run 未 completed 或持久化失败时不触发推进验收。
- 有客观信号的任务，推进侧必须通过受限只读通道独立核验证据。
- 裁判结论必须通过强 schema 的裁判判定工具产生；缺失工具调用、字段非法或纯文本结论不得被接受。
- 验收通过后不生成代理消息。
- 未通过时代理消息内容只来自 Rubric failureHandling + 事实变量。
- 同一 active session 同时最多一条 outstanding 代理消息。
- 代理消息进入主线 transcript，RunRecord 带 `source: "advancement"` 与 metadata，显示层可区分。
- `Message` 不承载 advancement 元数据，模型上下文只看到纯 `role/content`。
- 推进侧判断过程不进入主线 messages。
- active session 恢复后继续使用确认版 Rubric。
- 用户真实输入到来时区分补充 / 微调与目标变更 / 接管；代理 run in-flight 时优先 abort，未 completed 不入窗不验收。
- 无固定最大 run 次数；死胡同退出由“无有效推进内容”触发。
- 执行侧 tools/system 不因推进流程变化。

### 14. 不变量

1. 用户真实任务就是目标表达；不得要求用户在发任务时额外写验收标准。
2. Rubric 确认只在第一次执行 run 前发生。
3. active 后不得每轮协商 Rubric。
4. 推进侧不得把自己的思考写进主线历史。
5. 代理消息必须带来源标记，不得伪装成用户本人输入。
6. 推进侧只验收和续推，不替执行侧执行任务。
7. 不设置固定最大 run 次数。
8. 不能产生有效代理消息时必须退出。
9. 推进侧上下文尺寸复用现有注意力窗口规则。
10. 执行侧和推进侧 cache 链各自稳定，互不顶掉。
11. Rubric 确认不得削弱公共选择模块边界；选择模块能力不足时只能做通用升级，不能做 Rubric 专用绑定。
12. 只有推进任务启动 Rubric 闭环；普通任务不被重型确认流程拖慢。
13. 推进侧必须优先独立核验证据，不得把执行侧自述当成客观证据。
14. 准入自动判断必须允许用户用自然语言纠错：可升级为推进任务，也可在待确认阶段降级为普通任务。

### 15. 提交与审查拆分计划

本能力不适合一次性提交。后续实施必须按下列提交单元递进；每个单元都应能独立审查、独立解释设计边界，并且必须独立构建通过、相关测试通过。不得提交半成品公共 API；引入类型、入口或 wire 契约的单元必须同时包含最小可验证实现和测试。审查也按同一拆分进行，避免把协议、交互、运行体、队列和恢复问题混审。

这些单元不是任意顺序的并行任务，而是带依赖的可执行提交链。只有前置依赖满足后，后置单元才允许开工；如果实施时发现某个后置单元缺少前置能力，必须回到依赖单元补齐，不得在当前单元里临时拼接绕过。

依赖总表：

| 单元 | 依赖                                                                         | 可独立审查点                                                     |
| ---- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| C1   | 无                                                                           | Rubric 协议与资产存储可独立落地                                  |
| C2   | 无；若现有`SelectionService` 已满足确认需求，可作为 no-op 审查单元记录结论 | 选择模块通用能力，不依赖 Rubric 业务                             |
| C3   | C1                                                                           | advancement 基础类型、RunRecord 元数据、AdvancementStore         |
| C4   | C1、C3；若确认交互需要 C2 能力，则同时依赖 C2                                | 推进准入与 Rubric 契约控制面                                     |
| C5   | C2、C4                                                                       | CLI 对控制面事件的 SelectionService 适配                         |
| C6   | C1、C3                                                                       | 推进侧 evaluator runtime、取证、裁判判定工具，可先以单元测试落地 |
| C7   | C3、C4、C6                                                                   | run accepted 后验收与事件投影                                    |
| C8   | C3、C4、C7                                                                   | 代理消息续推、队列来源、用户中断处理                             |
| C9   | C1-C8                                                                        | 恢复、观测与端到端验收                                           |

因此，只有 C1 与 C2 可以无前置并行；C6 在 C1+C3 后可与 C4/C5 分支并行推进；C7-C9 是严格后置集成单元。尤其 C9 不是“最后再想想”的补丁，而是全链路恢复与验收的封口单元，不能在 C1-C8 未完成时实施。

#### C1：Rubric 协议与 RubricStore

落地提交：

- `7968622` `feat(core/rubrics): add rubric protocol asset store`

内容：

- 落地 Rubric 协议类型、解析、校验和测试。
- 落地独立 `RubricStore`：`own / linked / archived / index.json`。
- 不复用 `SkillStore` 代码；如需抽共性，先提领域无关基础设施。

审查重点：

- Rubric 与 Skill / Rule 边界是否清楚。
- `证据要求` 是否是一等可选内容。
- Store 是否独立承载 Rubric 语义，没有混入 Skill 语义。

#### C2：SelectionService 通用能力升级

落地提交：

- `e63ffe9` `feat(cli/selection): add reusable details disclosure`
- `b9a441b` `fix(cli/selection): unify keypress translation`

内容：

- 若 Rubric 确认需要详情展开、编辑承接或多步短决策，先升级 `packages/cli/src/tui/selection/` 的通用协议与 presenter。
- 不出现 Rubric 专属字段、分支或文案。
- 保持 `/stop` 等既有调用不退化。

审查重点：

- 选择模块是否仍是领域无关短决策基础设施。
- 交互能力是否可被其它场景复用。
- 是否避免在 Rubric 侧临时拼 UI。

#### C3：推进基础类型、RunRecord 元数据与 AdvancementStore

落地提交：

- `dc0b7f9` `feat(core/advancement): add advancement session control log`

内容：

- 新增 advancement 核心类型、`TurnSource: "advancement"` 与 RunRecord advancement 元数据。
- 落地 `AdvancementStore` 控制日志，记录草案、确认、review、proxy、退出状态。
- 保证推进元数据不进入 `Message role/content`。

审查重点：

- transcript / history / RPC wire / CLI 渲染是否同源透传。
- 主线消息是否保持纯净。
- `AdvancementStore` 命名和职责是否统一。

#### C4：推进准入与 Rubric 契约控制面

落地提交：

- `22a6319` `feat(core/advancement): add rubric admission and contract primitives`
- `11d54c8` `feat(rpc/events): scope session events for control-plane traffic`
- `8eff575` `feat(server/advancement): add rubric contract control plane`
- `3efb6b3` `fix(server/session): clean up advancement state on conversation delete`

内容：

- 实现 `AdvancementAdmissionStrategy`：问题 / 普通任务 / 推进任务。
- 扩展 `session.send` 返回 `awaiting-rubric-confirmation`。
- 新增确认 / 取消 RPC action；确认后通过 `makeTask` 闭包复用原始 `turnId`，不改 `admitTurn` 接口。
- 支持自然语言升/降级逃生阀。

审查重点：

- 普通任务是否不被重型流程拖慢。
- 准入判断是否不要求用户选择模式。
- `turnId` 流转是否符合现有 RPC / `admitTurn` 事实。

#### C5：CLI Rubric 确认适配器

内容：

- CLI 监听 `advancement:contract_draft` 等控制面事件。
- 将 Rubric 草案映射为通用 `SelectionRequest`。
- 将 `SelectionResult` 翻译为确认、取消、编辑承接或降级直接执行。

审查重点：

- CLI 是否复用 `SelectionService`。
- 是否没有直接 import `security/select-operation-region`。
- 确认面是否不写入主线聊天内容。

#### C6：推进侧运行体、独立取证与裁判判定工具

内容：

- 实现 `AdvancementRuntime` 专用 evaluator runtime。
- 实现受限只读取证通道，按 `evidenceRequirements` 读取客观证据。
- 实现强 schema 的裁判判定工具，生成 `AdvancementRunReview`。
- 禁止纯文本 / 正则 / 宽松 JSON 解析裁判结论。

审查重点：

- 裁判是否能独立核验证据。
- 裁判工具是否无副作用且 schema 强约束。
- 成本分层是否不牺牲验收可靠性。

#### C7：run 接受后验收与事件投影

内容：

- 在 run accepted 之后触发 `afterTurnCommitted`。
- 生成并持久化 `AdvancementRunReview`。
- 发出 `advancement:run_reviewed`、`completed`、`exited` 等事件。

审查重点：

- 只有 completed 且已接受的 run 才触发验收。
- 持久化失败、abort、error 不被当成事实。
- 事件走 `session.event`，不混入 `session.delta / complete` 执行流。

#### C8：代理消息续推、队列与用户中断

内容：

- 实现 `ProxyMessageScheduler`。
- `pendingQueues` 支持内部来源 `advancement` 与单条 outstanding 代理消息。
- 用户真实输入到来时区分补充 / 微调、目标变更 / 接管、代理 run in-flight。
- in-flight 代理 run 优先 abort；未 completed 不入窗不验收。

审查重点：

- 自动推进不受用户 pending 上限误伤，也不无限堆积。
- 代理消息带来源标记，不伪装成用户本人。
- 用户输入优先级和 abort 语义是否与现有 ConversationManager 对齐。

#### C9：恢复、观测与端到端验收

内容：

- host 重启 / 会话恢复后恢复 active advancement session。
- 推进侧独立窗口接入与诊断信息落地。
- 补全端到端测试：准入、确认、验收、续推、退出、恢复、选择模块边界、cache / message 不污染。

审查重点：

- 恢复后是否仍使用确认版 Rubric snapshot。
- 推进侧上下文是否复用现有注意力窗口规则。
- 全链路是否满足本文不变量。
