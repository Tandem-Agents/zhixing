# 任务推进闭环（Rubric 推进准则）架构

> **S7 当前取证边界：** owner 只把目标 executor 经 EvidenceRequest/Bundle 协议生成、验签并耐久绑定的 canonical evidence 交给裁判运行体；裁判运行体不持直接 evidence provider，也不存在本地取证 fallback 或兼容开关。本文后续 `evidenceProvider` 施工记录属于历史交付说明，不代表当前生产入口。

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
- **标准公开、程序私有、验证独立**：用户确认的验收条件（passCriteria 与 evidenceRequirements）是任务契约的公开面，对执行侧每 run 可见——它是任务定义的一部分，不是裁判机密；执行侧知道要核验什么，才会主动产出可核验的证据。failureHandling 模板与裁判过程归推进侧私有。防应试与防欺骗都锚定在证据独立核验上，不锚定标准保密——藏标准防不住应试（标准会经失败反馈碎片化泄露），只会用信息不对称制造可避免的执行轮次。
- 裁判到执行侧的续推通道必须携带结构化归因事实（逐条判定 + 理由 + 独立证据摘录）；failureHandling 模板守住的是推进**意图**不被改写，不是把裁判发现的事实关在门外——否则执行侧与裁判判断分歧时闭环原地打转。

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
server 编排层（ServerContext + session.* RPC 编排）
├─ ConversationManager（会话 owner / 串行点，零 Rubric 语义）
│  └─ ManagedSession
│     ├─ main runtime（执行侧，现有 AgentRuntime）
│     └─ attention window（执行侧窗口，现有）
├─ AdvancementController（任务推进闭环控制器，与 ConversationManager 并列、经 RPC 编排层协作）
│  ├─ AdvancementAdmissionStrategy（推进准入策略：问题 / 普通任务 / 推进任务）
│  ├─ RubricContractBuilder（命中 / 生成 / 确认 Rubric）
│  ├─ AdvancementRuntime（推进侧独立判断运行体）
│  ├─ ProxyMessageScheduler（代理消息入同一会话队列）
│  └─ SessionStatePort（对话 owner 权威日志中的 advancement 状态与事件）
└─ Rubric catalog / GlobalStatePort（Rubric 只读检索与独立全局沉淀）
```

生效面注：`AdvancementController` 挂载在 `ServerContext.advancement`，由 `session.send` 等 RPC handler 编排调用；`ConversationManager` 类本体不持有它的引用——「不内嵌 Rubric 语义」由结构保证，比早稿「ConversationManager 增加 advancement 依赖」的措辞更干净，以此为准。

职责分界：

| 组件                  | 职责                                           | 不做                             |
| --------------------- | ---------------------------------------------- | -------------------------------- |
| 执行侧 main runtime   | 按用户 / 代理消息执行任务                      | 不判断自己是否完成               |
| AdvancementController | 任务级状态机、调度下一轮                       | 不生成执行方案、不替执行侧改文件 |
| AdvancementRuntime    | 按确认版 Rubric 验收、选择未通过处理、判断退出 | 不写主线历史、不每轮找用户确认   |
| Rubric catalog / GlobalStatePort | 只读检索、内容资产与全局版本化沉淀            | 不阻塞会话契约采用、不参与 run 调度 |
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

  originalUserTask: UserTurnInput;
  createdAt: string;
  updatedAt: string;

  pendingRubricDraft?: RubricContractDraftSnapshot;
  rubricDraftVersion: number;
  confirmedRubric?: ConfirmedRubricSnapshot;
  runs: AdvancementRunReview[];
  proxyMessages: AdvancementProxyMessage[];
  outstandingProxyMessageId?: string;
  advancementWindow?: AdvancementWindowState;
  exit?: AdvancementExit;
}
```

`pendingRubricDraft` 只存在于 `awaiting-rubric-confirmation` 状态，属于控制面草案，不进入主线 transcript；`rubricDraftVersion` 随草案修订递增，服务待确认阶段的自然语言修改流。`confirmedRubric` 是本次任务契约快照。Rubric 库里的文件后续变化，不影响已经 active 的推进会话。`outstandingProxyMessageId` 用来保证同一推进会话同时最多只有一条尚未执行的代理消息。`advancementWindow` 是推进侧窗口的持久化蒸馏态（见 §4.7 与 §6）——派生缓存性质，随 review 同事务落盘，为恢复省一次折叠摘要，不构成第二真相源。

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
    passCriteria: string[];
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
    passCriteria: Array<{ id: string; text: string }>;  // 条目 id 快照固化时按序分配（"pc-1"…）
    evidenceRequirements?: EvidenceRequirementSpec[];
    failureHandling: FailureHandlingSpec[];
  };
  confirmedAt: string;
  confirmedBy: "user";
}
```

**通过标准条目化（裁决）**：条目 id 在**契约快照层**分配——快照不可变，故 id 在整个推进会话内恒稳，是归因引用（§4.6 `criterionId`）、跨轮机械对比（§7 死胡同检测）、收场标准矩阵（§7）的稳定锚。资产层 `RUBRIC.md` 与草案阶段保持自然列表（`string[]`），不给用户与生成策略加编号负担；id 由确认固化这一步机械分配。没有稳定 id 时，这三个消费者全靠裁判 LLM 逐字复述标准文本——复述漂移一次全链路断。

命中已有 Rubric 时，会话保存 `source:library` 的不可变快照并记录库身份与版本。未命中时，用户确认先把 `source:local-draft` 的 `snapshotId + contentDigest` 随 advancement 事件写入当前对话 owner，并立即启动原任务；保存或修订全局 Rubric 是独立后续动作，失败或离线不得回滚已经采用的会话契约。锚点在线时正文先进入 ArtifactStore，再经 GlobalStatePort 写目录；本地域离线时先把规范正文写入当前 owner 的既有 ArtifactStore，再由 advancement 注入的 publication 与 schedule producer 共用唯一 DeferredGlobalIntent repository 登记非时效意向，提示“已用于本任务，连接值班设备后保存”。save-new 不依赖目录命中；update-existing 的稳定操作身份包含目标 rubricId，并反绑只读缓存中的 expectedRevision，缺失、过期或损坏目标不得盲写。后续 link 只关联库身份，不改写 active 快照内容。`evidenceRequirements` 是推进侧独立取证的协议入口；并非每类任务都必须有客观证据，但一旦任务存在文件、日志、差异或产物等当前可只读核对的信号，Rubric 草案应尽量把证据要求写入契约，供推进侧独立验收。

#### 4.5 AdvancementRunReview

```typescript
interface AdvancementRunReview {
  id: string;
  runIndex: number;
  runRecordRef?: { shardId: string; runIndex: number };
  reviewedAt: string;
  decision: "passed" | "failed" | "exit";
  evidence: ReviewEvidence[];
  attribution: ReviewAttribution;    // 逐条判定（§4.6）——随 review 持久化，是恢复重建 / 收场矩阵 / 跨轮对比的权威数据源
  unmetCriteria: string[];           // attribution 中 verdict:"unmet" 条目的投影，供轻量消费；attribution 是权威
  usage?: { judge?: TokenUsage; run?: TokenUsage };  // 裁判调用与被审 run 的 usage 两半快照——保险丝（§7）沿 review 序列累加即得会话总量，免于回读 transcript
  selectedFailureHandlingId?: string;
  proxyMessageId?: string;
  exitReason?: AdvancementExitReason;
}
```

**归因随 review 持久化（裁决）**：`attribution` 是裁判判定工具的直接产出（§6 schema），落盘在 review 上而非只在代理消息派发时即时渲染——否则 §5.6 恢复矩阵第二行的「代理消息纯函数重建」拿不到归因、C16 的 byte 等价验收不可满足，收场矩阵与死胡同对比也失去数据源。`unmetCriteria` 降为投影字段，与 attribution 的一致性由裁判工具校验层保证。系统兜底 review（裁判结论性失败的 fail-closed 产物，无裁判工具产出）`attribution.criteria` 为空数组、系统错误消息保留在既有兜底位——字段保持非可选，空数组即「无逐条判定」的诚实表达。项目未发布，条目化等 schema 变更沿 transcript 先例**无迁移义务**：旧形状事件按恢复容错隔离跳过，不建 legacy 读路径。

推进侧审查基于已接受的 run：run 未持久化 / 未入窗，不进入推进判断，避免把失败或回滚中的半成品当事实。

#### 4.6 AdvancementProxyMessage

```typescript
interface AdvancementProxyMessage {
  id: string;
  sessionId: string;
  reviewId: string;
  content: UserTurnInput;
  rubricFailureHandlingId: string;
  variables: Record<string, string>;
  attribution: ReviewAttribution;
  createdAt: string;
}

interface ReviewAttribution {
  criteria: Array<{
    criterionId: string;                     // 引用契约快照的 passCriteria 条目 id（§4.4 条目化）
    verdict: "met" | "unmet" | "unknown";
    reason: string;                          // 裁判结论性理由（一句话，非思考过程）
    evidenceExcerpt?: string;                // 独立证据摘录 / 引用（有独立取证时必填）
  }>;
}
```

`verdict` 三态语义受 §6 信任边界约束：客观 kind 的条目没有独立证据支撑时判定上限是 `unknown`、不得 `met`。`passed` 的裁决条件是**两层门**：criteria 层无 `unmet` + evidence 层 required 证据要求全部有已通过的独立证据（即现行 `validateRequiredObjectiveEvidence` 护栏——`required` 是证据要求的属性、不是标准条目的属性，两层门无需在条目上新增任何标志）。`unknown` 条目不阻断通过（否则回到 required 死锁的翻版），但归因与收场矩阵如实展示 `unknown`，用户看得到哪些条目是「未能独立核验、按执行侧产出与对话事实采信」的。

代理消息的内容 = **意图骨架 + 归因事实块**两部分拼装：意图骨架来自 Rubric 的 `failureHandling`（用户确认过的固定推进内容，推进侧只允许填事实变量、不允许改写推进意图）；归因事实块由 `ReviewAttribution` 确定性渲染追加（逐条判定 / 理由 / 独立证据摘录）。裁决理由：failureHandling 守住的是推进**意图**不被改写；而裁判独立取证发现的事实（如"执行侧自述测试通过，独立核验发现 3 个失败"）恰是协议本就允许的"事实变量"的自然延伸——不把它传给执行侧，判断分歧时裁判握着能一击破局的证据却说不出口，闭环原地打转直到死胡同退出。归因只含**结论与证据事实**，不含裁判思考过程与裁判程序——"不外泄裁判过程"的边界照守。

> 生效面：已落地（C14）——代理消息 content = failureHandling 意图骨架 + `renderReviewAttribution` 确定性渲染的归因事实块；`attribution` 随 review 与 proxy 持久化。

#### 4.7 Advancement 权威状态与生命周期

推进状态不再拥有独立文件事实源。生产实现只经 `SessionStatePort.readAdvancementState` 读取，并把 `SessionControlMutation(kind:"advancement-event")` 交给当前 conversation owner；`AdvancementSnapshot` 与 `AdvancementControlEvent` 是唯一状态和事件联合。会话、草案、确认快照、review、window、proxy、终态，review-attempt 的 `started → invoking → consumed/deferred/expired`，以及 evidence 请求的“已耐久—结果已耐久—settled/deferred”闭环，都进入同一对话权威日志并严格绑定 conversationId、advancementSessionId、ownerEpoch 与 session revision。

窗口与 pending evidence 是从同一事件序列折叠出的有界投影，不构成第二事实源。任意崩溃后只凭会话日志恢复未审 accepted run 与未完成 evidence 义务；owner 换代后旧 epoch 的请求和结果零推进。对话删除与迁移自然携带或清除该会话域状态，不再维护独立 advancement 目录、孤儿 sweep 或旧文件兼容生产路径。

### 5. 生命周期流程

#### 5.1 用户输入进入

用户消息进入 `session.send` 后，由会话 owner 先确定 conversation 身份，再交给 `AdvancementController.prepareUserTurn`：

1. 若当前会话已有 `awaiting-rubric-confirmation` 或 `active` 推进会话，用户真实输入优先，按“用户中途输入”规则处理。
2. 若无待确认或 active 推进会话，主 Agent 推进准入策略判断本输入是问题、普通任务还是推进任务。
3. 问题：直接走现有 `runTurnWithCommit`。
4. 普通任务：直接走现有 `runTurnWithCommit`，不进入 Rubric 契约。
5. 推进任务：进入 Rubric 契约准备，不立刻执行 main runtime。

这里的“主 Agent 推进准入策略”属于主 Agent 的任务识别与成本判断策略，不是推进侧裁判。它只回答“这次是否值得启动任务推进闭环”，不制定验收标准，不要求用户补写验收条件。

实现上，准入策略运行在执行 run 之前的控制面，形态是需求区两方案中的**方案二（独立判断节点）**：一次 light 档 LLM 单发判断调用，不写主线 transcript，不产生 RunRecord，不调用执行工具。选方案二而非「主 Agent run 内工具触发」（方案一）的裁决理由：工具触发意味着先起主 run，与「Rubric 确认发生在第一次执行 run 之前」直接矛盾。

准入判断的输入面（目标态）：当轮用户输入 + 推进会话状态 + **最近会话投影**（执行侧窗口尾部的轻量摘要/末组对话）。没有会话投影，「继续把它弄完」这类上下文依赖输入无法准确分类，而准入误判方向直接决定用户进不进重流程。生效面：已落地（C12）——准入输入携带最近会话投影（活跃会话窗口尾部经 `renderRecentContextFromMessages` 硬裁剪的轻量文本，标注为待分类数据防注入），准入耗时经 `onAdmissionTiming` 回调进 serve 诊断日志作延迟基线。已知边界：投影只覆盖内存中已加载的会话——宿主重启后对既有对话的第一条上下文依赖输入恰好无投影（降级为无投影分类，与「未就绪返回 undefined」语义一致）；会话一经激活即恢复。

延迟代价（诚实记录，不藏在「轻量」措辞后面）：advancement 装配开启后，每条非空用户输入（含纯问题）在 main run 之前串行阻塞一次 light 档 LLM 往返——这是全量消息的首 token 延迟税，换取少数任务的推进闭环准入。接受此串行一跳（推测并行执行会预跑带副作用的工具、不可取），但约束是：准入必须恒用 light 档、prompt 保持小体量、LLM 不可用或超时立即走保守兜底（降级为 direct-task，不阻塞用户）；首 token 延迟基线纳入观测，实测不可接受时再校准（如短输入快速通道），不预先建复杂机制。

准入是语义判断，不是关键词匹配。正则、固定词表、硬编码规则不得成为产品级准入路径；它们最多只能作为不可用时的保守降级或显式高置信命令的边界检查。只要用户表达里同时存在升级和降级意味，不能让低层规则抢判，必须交给语义判断或按更能保护用户目标的方向处理。

推进准入的核心不是“用户有没有说成任务”，而是“这次是否值得付出开跑前确认与后续验收成本”。典型进入推进闭环的信号包括：任务存在明确客观完成信号、可能跨多轮 run、失败代价较高、用户显式要求审查/验证/完成到某标准、或需要沉淀可复用 Rubric。轻量、即时、低风险任务应直接执行，避免把重流程压到日常小需求上。

准入判断必须有自然语言逃生阀，但不暴露“Goal 模式”开关：

- **用户显式升级**：用户用自然语言表达“盯到验收通过”“帮我改到测试全绿”“持续推进到完成”等意图时，即使任务本身不复杂，也按推进任务处理。
- **用户显式降级**：用户在待确认阶段表达“别确认了，直接做”“不用盯后续，先完成这一下”等意图时，取消待确认推进会话，把原始任务按普通任务执行。
- **执行后升级**：普通任务执行后，用户追加“这个继续盯到完成 / 按标准验收”时，视为新的推进任务；在下一次执行 run 前建立 Rubric 契约。

#### 5.2 第一次执行 run 前：Rubric 契约

推进任务进入推进流程后：

1. `RubricContractBuilder` 只经注入的 Rubric catalog 检索索引，并按需读取内容资产。
2. 命中：生成 `RubricContractDraftSnapshot`，展示给用户确认。
3. 未命中：由 Rubric 草案生成策略基于当前任务、候选 Rubric 与协议规格生成新 Rubric 草案，展示给用户确认。
4. 用户确认时，在同一 owner 提交中写入不可变快照与原任务的窄域耐久准入意向；意向只冻结稳定 `turnId`、surface principal、turn origin、必需选项和原任务内容摘要，任务正文仍以会话已有 `originalUserTask` 为唯一事实。
5. 会话进入 `active` 后，owner 以意向原载荷调用既有耐久 turn 准入；取得或全等回放 `runId` 后写入结清事实。暂态或结果不明保持 pending 并由恢复重驱，只有会话不存在、异载荷冲突等确定拒绝才取消。确认版验收条件自此对执行侧每 run 可见（载体见 §5.3）。
6. 若是新 Rubric，全局沉淀与上述本任务准入并行独立；准入先完成，RPC 再等待沉淀任务并把真实 saved / deferred / failed 反馈给用户。沉淀失败不得回滚 active 会话或已准入 run。

用户确认只发生在这里。进入 `active` 后，推进侧按确认版 Rubric 自动推进，不再每轮询问用户。

**场景化生成与沉淀治理（裁决）**：需求本意是「用户同意即沉淀、未来可复用」——沉淀的价值在复用，而复用的前提是 Rubric 天生是**场景级**的。当前生成契约要求草案「贴合当前任务」，与协议「title / description 表达场景、不表达某一次具体任务」自相矛盾：贴合单次任务的标准无条件入库，一百个任务就是一百条一次性条目，检索误命中 + 用户确认面的橡皮图章效应叠加，最终整个任务按别的任务的过期标准裁判——库从资产退化为污染源。裁决从根因修：

- **生成契约改为场景级**：草案的 passCriteria / failureHandling 写场景可复用的标准与处理；本次任务的具体细节走事实变量与证据要求承载。生成 prompt 与协议要求对齐，不再自相矛盾。
- **沉淀治理兜底**：确认前做近邻检测（与既有 Rubric 高相似时提示复用/修订已有条目而非另存新条）；确认即采用，沉淀作为独立后续动作处理，沉淀的是场景资产、不是任务快照。
- 本次任务契约仍以 `ConfirmedRubricSnapshot` 快照隔离——库条目后续演化不影响 active 会话，不变。

> 生效面：生成契约已场景化（C15）——生成与修订 prompt 均改为「场景可复用表述、任务细节归证据要求与 locator」，自相矛盾消除。近邻治理交互已落地（C18）——generated 草案携带达到近邻阈值的候选时，确认面默认提示修订已有条目，且保留「另存新准则」显式选择；确认请求将沉淀选择传回控制面，core 按选择更新 existing own / own 覆盖 linked 或另存新条。

Rubric 草案生成是任务契约生成，不是通用模板填空。未命中 Rubric 时，默认路径应由 LLM 根据当前任务现写场景化验收标准、证据要求和未通过处理；固定通用模板只能作为测试替身，不能成为真实产品行为。若草案生成不可用或失败，受控失败的形态是：generation strategy 直接抛错（core 层无 `contract-failed` 字面量），由 server 控制面捕获并映射为 `advancement:contract_failed` 控制事件、不落空会话——两层各守其责，绝不伪造一份通用 Rubric 继续流程。`RubricContractBuilder` 只负责检索、组装、确认和持久化契约流程，草案内容生成必须通过可替换的 generation strategy 接入，避免把智能生成逻辑写死在控制面类里。

Rubric 确认是控制面流程，不是一次执行 run：

- `session.send` 判断为任务后，创建 `awaiting-rubric-confirmation` 的 `AdvancementSession`，返回包含 `advancementSessionId`、`rubricDraftId`、`status: "awaiting-rubric-confirmation"` 的结果。
- 控制面向 CLI / RPC 显示 Rubric 草案与确认操作；此时不调用 `runTurnWithCommit`，不写 RunRecord。
- CLI 接入面不得新造 Rubric 专用确认面板；Rubric 草案确认必须适配现有 `SelectionService`，由 CLI 把控制面草案映射成 `SelectionRequest`，再把 `SelectionResult` 翻译为确认 / 取消 / 后续编辑动作。
- 若现有 `SelectionService` 表达力不足，不得在 Rubric 侧补专用面板、专用状态机或专用字段；应先把选择模块升级成领域无关的通用能力，再由 Rubric 适配器消费。
- Rubric 确认面必须提供降级动作：用户选择“直接执行不启用推进”时，关闭待确认推进会话，原始任务按普通任务进入执行，并复用原始 `turnId`。
- `session.complete` 仍只表示执行 run 的终止结果，不用它伪装 Rubric 草案完成；等待确认、取消、草案更新走 `session.event` 的控制面事件。
- 原始 `turnId` 与稳定 surface principal 由确认提交中的 admission intent 耐久反绑；在线 RPC 和恢复 owner 均以同一意向重放 `admitDurableTurn`，不得从当前连接猜身份。在线调度仍复用 `ConversationManager.admitTurn`，后续 delta / complete 使用原始 `turnId`；准入结清保留原 `runId`，作为 accepted-run 连续验收的下界。
- 确认草案与确认记录进入对话 owner 的 advancement 权威状态，不进入执行侧注意力窗口。

**awaiting 会话跨重启的行为（定死，防止歧义）**：`awaiting-rubric-confirmation` 会话不进入恢复扫描（恢复只处理 active），重启后不自动重发 `contract_draft` 事件——它静默存活在控制日志里，经 `session.list` / `session.resume` 以状态快照回投给接入面，由接入面据快照重建确认 UI。理由：草案确认是等待用户决策的控制面状态，不是需要系统主动续跑的工作；自动重发事件会在用户未打开会话时空推。接入面必须消费 resume 快照重建确认面，否则待确认任务在重启后对用户不可见（该消费路径与专项测试随 §15 C11 一并验收）。

#### 5.3 执行 run

执行 run 完全复用现有路径：

```text
run 输入 = [...执行侧注意力窗口, 当前用户/代理消息]
  （active 期间：当前 user 消息的发送视图文本被前缀契约验收条件块——消息之内，非独立序列元素）
  → main runtime.run()
  → completed 时 manager.recordTurn()
  → appendRun 成功
  → execution window.acceptRun()
```

推进侧不插入主线 system prompt，不改 tools，不改执行侧窗口。

**契约标准对执行侧可见的载体（裁决）**：active 推进会话期间，确认版验收条件（passCriteria + evidenceRequirements）经执行侧现有的 **run 瞬态注入通道**（`onBeforeRun.injectUserContext`）每 run 注入，标记为「本任务经用户确认的验收条件」。载体选择的推导：

- **注入的真实形态**——`injectUserContext` 的贡献由运行体拼成 `<context>` 块、前缀进当前 run 最后一条 user 消息的**发送视图文本**（`user-context.ts`），与用户原文共存于该 run 的 LLM 输入、run 结束即弃。**落盘 `messages[0]` 恒为用户原始输入、窗口配对派生自落盘原文**——持久化与窗口两处不被任何注入触碰是结构性保证，用户原文的唯一权威在持久化，不产生「第二份用户消息真相」。
- **不进窗口事实**——run 瞬态注入天然不入窗（transcript-persistence §3.2.1 定死的边界），「要每 run 可见就每 run 重注」谓词自然成立，窗口里不堆陈旧副本；active 期间恒定注入、会话终态（completed / exited / cancelled）后停止注入，生命周期由推进会话状态纯函数派生。
- **不动 cache 前缀**——注入落在当前 run 的用户消息上（messages 序列末端），system / tools 与历史前缀不受影响。
- **零新机制**——通道、边界语义、失败语义全部现成。注入订阅者由**宿主装配层注册**（物理落点是 `packages/cli` 的 serve 装配 / RuntimeHost，见 §15 C14），不得经 ConversationManager——否则破坏 §3「CM 不持 advancement 引用」的结构保证。

裁决依据（§0）：passCriteria 是用户确认过的任务契约公开面，属任务定义的一部分——执行侧知道「什么算完成」才能首轮瞄准真目标，而不是靠失败反馈碎片逐轮逆向拼出标准（标准分 k 批暴露 = 最多 k−1 轮纯由信息不对称制造的完整执行 run + 裁判调用，是全系统最大的可避免成本项）。「执行侧不判断自己是否完成」不变量照守：知道标准 ≠ 自我验收，验收权与独立证据仍在推进侧。failureHandling 模板、裁判过程、Rubric 库索引仍不进执行侧。

> 生效面：已落地（C14）——serve 装配注册 `advancement-acceptance-lifecycle` 订阅者，active 期间经 `injectUserContext` 每 run 注入验收条件块（`renderAcceptanceConditions`：通过标准 + 证据要求的完整契约信息，含必需性与核验路径——执行侧知道产物会在哪被核验才能放对地方，与确认面同一口径），终态自然停注；RuntimeHost 新增 lifecycle 订阅者透传。

#### 5.4 run 接受后验收

`recordTurn` 成功后，`AdvancementController.afterTurnCommitted` 读取 active session 与本次 run 事实：

1. 把 `runRecord`、最终 assistant 回复、工具调用投影、推进侧独立读取的证据交给 AdvancementRuntime。
2. AdvancementRuntime 按确认版 Rubric 通过裁判判定工具输出 `passed` / `failed` / `exit`。
3. 经 SessionStatePort 记录 `AdvancementRunReview` 到对话 owner 权威日志。

验收通过：

- session 标记 `completed`。
- 不生成代理消息。
- 向显示层发 `advancement:completed` 事件，携带**收场交付**（见 §7「收场交付」）——验收通过摘要 + 逐条标准的证据链，不是一个裸事件名。

未通过：

- 从 Rubric 的固定 `failureHandling` 中选择对应项作为意图骨架。
- 填入事实变量，并附 `ReviewAttribution` 归因事实块（§4.6），生成 `AdvancementProxyMessage`。
- 通过 `ProxyMessageScheduler` 安排为同一 conversation 的下一条内部代理 turn。

代理续推不是普通用户排队：

- 每次验收最多生成一条代理消息；该消息执行前，不得为同一 session 再生成新的代理消息。
- 代理消息不占用户 pending 上限，也不绕过串行执行；它只是在当前 run 完成后接续进入同一 conversation。
- 若代理消息执行前收到用户真实输入，用户输入优先，未执行的代理消息取消，active 推进会话按用户输入重新判断或退出。

用户中途输入要分层处理，不能一概终止推进：

- **补充 / 微调**：用户输入仍服务同一目标，且不改变已确认 Rubric 的通过标准；取消未执行的代理消息，把用户输入作为下一条真实用户 turn 执行，推进会话保持 active，run 接受后继续按原 Rubric 验收。
- **目标变更 / 接管**：用户输入改变任务目标、改变验收标准、要求停止自动推进，或开启新任务；当前推进会话退出，再按新输入重新准入。**终态归类裁决**：`exited` 与 `cancelled` 按「有无收场意义」切分——已确认且有 review 素材的会话被接管 / 变更时归 `exited`（exitReason: `user-takeover`），**享受 §7 收场交付**（用户接管恰是最想知道「到哪了」的时刻，也是契约再生的前置）；`cancelled` 只留给无收场意义的关闭（awaiting 阶段取消——无执行事实；对话删除——收场无载体），无收场。生效面已随 C17 落地：active 接管归 `exited` 并交付收场报告。
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
    sessionId: string;              // 恒必填：任何 advancement 来源 run 都可归属会话
    proxyMessageId?: string;        // 代理续推 run 才有：指回触发它的代理消息
    reviewId?: string;              // 代理续推 run 才有：指回产生该代理消息的验收
    rubricFailureHandlingId?: string; // 代理续推 run 才有：所用的 failureHandling 条目
  };
}
```

显示层据 `source: "advancement"` 使用特殊标记；LLM 看到的是「意图骨架 + 结构化归因事实」拼装的 user message（§4.6）——逐条判定、理由与独立证据摘录是事实，可见；推进侧思考过程、裁判程序、Rubric 库索引不可见。

`source` 与 `advancement` 是 run 级来源元数据，不是 `Message` 字段。模型协议里的消息仍保持纯净的 `role/content`；history、RPC wire、CLI 渲染从 `RunRecord` 读取来源信息，避免把产品来源标记泄漏进模型上下文。

#### 5.6 恢复契约（中间态全枚举）

推进闭环跨多个主线 run，宿主可能崩溃在任意步骤之间。恢复语义按中间态显式枚举，不留隐式行为：

| 中间态                             | 判定依据                                                                                                                                                                                                                                                                                                              | 恢复动作                                                                                                                                                                                                                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rubric 已确认、原任务准入未结清     | active 会话存在 pending admission intent                                                                                                                                                                                                                                                                             | 以原 turnId、surface principal、turn origin 与内容摘要全等重放既有耐久准入；取得 runId 后结清，暂态/不明保留 pending                                                                                                                                                                            |
| run 已接受、验收未跑               | 从原任务结清 `runId` 起，权威 accepted 集合减去全等 `run_reviewed` 集合的最早缺口；原任务下界尚不可见时无法证明集合连续                                                                                                                                                                                            | 恢复扫描 oldest-first 逐个补审；下界不可见时 fail-closed 并保留当轮未审，最大 review index、时间戳或一次 catch-up 返回都不得证明连续                                                                                                                                                             |
| 验收已跑、review 与 proxy 之间断裂 | **最新 failed review 携带 `proxyMessageId`，但该 proxy 不在 `proxyMessages` 且未 settled**（真实成因：`run_reviewed` 已落盘而 `proxy_enqueued` 行缺失 / 损坏被坏行隔离跳过——此时 `outstandingProxyMessageId` 为空，「outstanding 指向不存在的 proxy」在合法事件折叠下反而造不出来，不能作判定谓词） | **确定性重建**：review 已持久化 `selectedFailureHandlingId` + `unmetCriteria` + 归因，代理消息 content = 模板 + 变量 + 归因渲染的纯函数——重造并补写 `proxy_enqueued` 后入队，不得静默放过。生效面已随 C16 落地：缺失 proxy 由持久化 review 确定性重建并补写 `proxy_enqueued`。 |
| proxy 已入队未执行                 | outstanding proxy 存在且队列中无对应项                                                                                                                                                                                                                                                                                | 重接入队（`proxy_recovered`，已落地；scheduled set + busySource 双重去重）                                                                                                                                                                                                                   |
| 代理 run 执行中崩溃                | run 未 completed                                                                                                                                                                                                                                                                                                      | 不落盘不入窗不验收（completed-gate），恢复按上一行重接 proxy（已落地）                                                                                                                                                                                                                         |
| 裁判 transient / 结果不明挂起      | run 已接受但无对应 review；review-attempt 投影给出当前 generation 及 `started/invoking/deferred/expired`（transient 失败不落盘 review）                                                                                                                                                                                   | `started` 只 exact replay 同一冻结 root；`invoking` 表示 provider 结果不明，禁止在同一 root/usageId 重调，先写 deferred 并终结旧根，再进下一代。terminal attempt 的资源清理先于 already-reviewed、not-active 或 closed-session 早退。补审仍由宿主扫描、`session.resume` 和下一次 turn catch-up 触发；同一 run 进程内单飞 |
| awaiting 会话跨重启                | status = awaiting-rubric-confirmation                                                                                                                                                                                                                                                                                 | 不进恢复扫描、不自动重发草案事件；快照回投由接入面重建确认面（§5.2 已定）                                                                                                                                                                                                                     |

review、其 consumed attempt 与可选 proxy/session 终态保持同事务原子写；terminal attempt 的 root 清理由该 attempt 自身投影重驱，不从会话是否 open 或是否已有 review 反推。review 与 proxy 的断裂态仍是防御性枚举——即便原子性被未来改动破坏，恢复也有确定性出路。

### 6. 推进侧运行体

`AdvancementRuntime` 是独立判断运行体，不复用 Task 子 Agent：

- Task 子 Agent 是一次工具调用内部委托，不跨 run，不持久化中间过程。
- 推进闭环跨多个主线 run，需要任务级状态、持久化、代理消息和恢复能力。

AdvancementRuntime 第一版能力：

- 使用独立 system prompt / profile：身份是“推进侧裁判”。
- 默认使用当前执行侧同 provider / model / account 的可靠验收档模型，形成独立缓存链；以后可做专用 evaluator role，但不能降低验收可靠性。
- 具备受限的独立只读取证通道：owner 从已接受 run 与确认版 Rubric 构造并先耐久记录签名 EvidenceRequest，目标 executor 经独立 evidence handler 生成签名 EvidenceBundle / ObservationToken；owner 验真、绑定并落盘后，才以 canonical evidenceId 输入 AdvancementReviewerPort。裁判 loop 只持裁判判定工具，不带 agentic 读工具；生产路径不得再调用本地 `evidenceProvider.collect()` 或从拓扑对象暗取证据。
- 需要新增证据但当前证据不存在时，通过代理消息要求执行侧补充；推进侧不得把“执行侧自述”当成客观证据的替代品。
- 有独立 AdvancementWindowState，窗口尺寸复用现有注意力窗口规则。
- 上下文只包含：用户任务、确认版 Rubric、每轮执行结果、既往验收判断、已收集证据。（代理回复文本本身存于 Rubric failureHandling，不单列为上下文项。本清单是**裁判阶段**的验收上下文；Rubric 库索引只进入**契约构建阶段**的匹配上下文——两个阶段两份上下文，§8「索引只进入推进侧上下文」指后者，不进裁判验收上下文。）

**取证能力分级（裁决）**——「独立核验」按副作用面分两级，`required` 语义与能力集耦合：

- **第一级 · 纯只读核验**：文件差异 / 文件内容与存在性（`file-diff`）、日志文件（`log`）、产物状态（`artifact`）——目标 executor 在冻结 workspace binding/revision 内只读采集，复用 PathGuard，零副作用、无需权限确认。这是 EvidenceRequest/Bundle 生产实现的范围。
- **第二级 · 验证性执行**：独立重跑测试 / 构建命令以核验 `test-result` / `build-result`——语义是验证、但有执行面副作用。只能执行 Rubric 契约中用户确认过的验证命令、经现有权限管线、不绕确认。第一版不实现，留口不预建。
- **`required` 只能落在系统当前具备独立核验能力的 kind 上**：取证能力集是草案生成策略的输入，生成与确认阶段即约束 `required:true` 不得指向能力集外的 kind；能力集外的证据要求仍可写入契约（作为裁判参考与代理消息素材），但不构成 passed 的硬门槛。未来第二级落地，能力集扩大，`required` 可用面自动扩大——协议不变。
- **能力缺口的退出语义**：若 active 会话中出现 required 客观证据系统无法独立核验的局面（历史契约、能力回退），裁判不得进入「failed → 代理消息要证据 → 执行侧自述 → 仍无 independent 证据」的无效循环——这是死胡同的系统能力变体，应走退出请用户裁决，诚实告知“无法独立核验，请人工验收”。exitReason 新增 `capability-gap` 枚举值，不复用 `system-error`（语义污染）。

**第一级取证施工语义（当前目标形态）**：

- **file-diff 的基线语义**：目标 executor 读取当前 git 工作区事实（`git status` 为事实源、`git diff` 为摘要增强）；workspace 非 git 仓库或 git 不可用时按请求返回 capability-gap，不虚报成功。能力目录只声明 provider kind，具体 workspace 前提在请求级诚实解析；不预建历史文件系统快照。
- **证据定位机制**：`EvidenceRequirementSpec.locator` 是契约的一部分。owner 按确认顺序耐久保存 item→requirement 映射；file-diff 无 locator 时只允许当前 git 工作区变更与该 run 已触碰路径投影，log / artifact 必须严格按 locator 读取，禁止临场猜测或越界降级扫描。
- **能力集的声明与传递**：类型住 core；executor 在签名 CapabilityDescriptor 发布稳定 provider kinds，具体 git / locator 可达性在 EvidenceRequest 处理时核对。owner 发送前全等校验目标 executor、workspace binding/revision 与 provider kind；required 落点约束在生成和确认阶段生效。
- **取证路径安全与一致性**：任何文件访问前先验签并校验 ownerEpoch、目标 executor、workspace binding/revision、子租约和容量 permit。locator 规范化判界后打开 canonical path，字节只从该句柄读取；读取前后 `fstat` 及读后 `realpath/stat` 必须全等绑定同一文件身份，否则丢弃字节并产出 typed-stale。log / artifact 多文件内容按请求顺序承诺每个相对路径的 missing/present、长度与单文件内容摘要，再以该数组的 JCS 字节计算 item 摘要，禁止裸字节拼接。真实路径与秘密不上 wire。
- **裁判与取证的双代际**：每个全等 accepted `runRecordRef` 先在 owner 日志建立严格前进的 `reviewAttemptGeneration`，冻结 review root 合同；`started` 先于 root acquire，`invoking` 先于任何 provider 调用，review 与 `consumed` 同批提交，`deferred/expired` 先于 root 终结。root acquire 响应不明只按同一 workload 检查或 exact replay；active 可续，dequeued / settled / released / reclaimed 是稳定终态，禁止复活。取得 active root 后必须重读 owner 事实，只有同代仍为 active+started 才能继续；并发取消或终态先落盘时立即清理该根，零后续外部调用。终态 attempt 若仍有 queued root，清理者以同一冻结合同有界驱动一次：获准即 settle+release，未获准则由 deadline 写入 dequeue；不得让已关闭业务留下永久队列项。每个 review attempt 内的 `evidenceGeneration` 只拥有 child/request 的 pending/result/settled：未过期同代只回放原请求，旧代先结清再换代；已经耐久的 bundle/capability-gap 先按原请求验真消费，零新 dispatch 且不受当前拓扑漂移影响，typed-stale 先结清再按当前 target 进入 fresh 请求。child 从签发到 dispatch 调用由 coordinator 局部持有，dispatch 接管前异常即时 finish，接管后只由 dispatch finally 终结。

> 生效面：取证由会话 owner 的耐久请求链与 executor 独立 handler 承担；进程内和 mesh 只替换 transport adapter，共用同一 codec、guard、journal 与业务实现。journal 对同 requestId 全等重放原耐久结果、异载荷拒绝，过期请求只可回放既有终态；stale 有限重试后保持 deferred。
>
> **verdict 上限的载体（实施决策记录）**：unknown 上限规则的机械可校验部分在 evidence 层（required 独立证据护栏）；criteria 层的上限由裁判 system prompt 硬指令承载（标准条目无 kind、与证据要求无绑定字段，逐条机械校验不可行——两层门裁决本就声明「无需在条目上新增任何标志」）。能力集事实同时喂入裁判 prompt，使裁判能区分「执行侧未产证据（failed 催证）」与「系统无核验能力（capability-gap 退出）」。
>
> **边界**：本单元只实现第一级只读取证；测试/构建等验证性执行仍属后续能力。无 workspace、目标离线、binding/revision 漂移或请求级前提不满足时诚实返回 capability-gap / deferred，不伪造 cwd 或改选不持有冻结 workspace 的设备。

证据策略分层：

- 有客观信号的任务，推进侧必须优先独立核验证据，再做判断。
- 无客观信号的任务，推进侧以已确认 Rubric 的文本标准、执行侧产出和对话事实做审查，并更保守地退出或请求用户裁决。
- LLM 判断只负责解释证据和对照 Rubric，不负责替代证据本身。

验收成本也按可靠性分层：能由确定性证据或轻量模型可靠判断的，不强制每轮使用 main 档；只有语义判断复杂、证据不充分或风险较高时才使用高质量验收档。成本分层不能牺牲验收可靠性，也不能变成固定最大 run 次数。（生效面现状：裁判恒用 main 档、仅推进侧窗口摘要用 light 档——这是「先保可靠性」的正确保守起点，非缺陷；分层属后续校准项，由真实验收成本数据驱动，不预建机制。）

当前 LLM 请求协议没有框架级 structured output / json schema 原语。推进侧不得把裁判结论建立在“纯文本 + 正则 / 宽松 JSON 解析”上；第一版应通过专用裁判工具调用提交结论，工具 input schema 强约束 `decision`、`criteria`（逐条 `criterionId` / `verdict` / `reason` / `evidenceExcerpt`——即 `ReviewAttribution` 的来源，criterionId 必须属于契约快照条目集）、`evidenceIds`、`selectedFailureHandlingId`、`exitReason` 等字段（`unmetCriteria` 由 criteria 构造派生，不收模型提交），工具执行体只做校验和返回，不产生副作用。

**证据采用是 id 引用，不是内容提交（裁决）**：裁判提交 `evidenceIds` 引用已收集列表，持久化的 evidence 恒为取证层的 canonical 对象——摘要、判定、来源、绑定全部由取证层持有，模型没有任何字段可以改写。裁决理由：「模型复述全字段 + 系统逐字段校验一致」的形态里每个字段都是潜在的校验遗漏面（曾漏掉 summary 造成裁判可改写证据摘要、污染归因链与收场矩阵）；引用化让改写面结构性消失，且与「事实来自工具、判断交 LLM」同源——模型对证据的解读走归因层（criteria 的 reason / evidenceExcerpt），证据事实层零触碰。

**取证信任边界（裁决）**——「独立核验」的强度必须诚实分辨，防线声明不得超出防线覆盖面：

- **读取独立 ≠ 来源独立**：第一级取证（文件系统只读）证明的是「产物存在且记述了 X」，不证明「X 真实发生过」——log / artifact 是执行侧可写的产物。真正的来源独立要第二级验证性执行（独立重跑），第一版不做。
- **verdict 上限规则**：客观 kind（file-diff / test-result / build-result / log / artifact）的条目，没有 `source:"independent"` 证据支撑时判定上限是 `unknown`、不得 `met`——标准公开（C14）后执行侧自述可以精准贴标准写，这条规则堵住「有客观信号、系统核验不了、又非 required」象限的 false-pass 放大面。conversation-fact 类（写作、讨论、决策）按文本标准与对话事实审查可 `met`，既有「无客观信号更保守」分层不变。
- `unknown` 条目不阻断通过判定——两层门（§4.6）里条目层的硬条件只有「无 `unmet`」，`unknown` 不等于 `unmet`；required 硬门槛拦截在 evidence 层（required 证据要求必须全部有已通过的独立证据）。`unknown` 恒在归因与收场矩阵中如实呈现——诚实优于伪装核验。
- 归因 `evidenceExcerpt` 向执行侧暴露裁判核验的证物，在此边界下可接受：伪造证物的防线是来源独立性（第二级）与 required 硬门槛，不是证物保密。

**裁判失败韧性（裁决）**：区分两类失败，语义完全不同——

- **裁判结论性失败**（模型没调裁判工具、提交非法结论）：fail-closed 落终局 `exit`（`system-error`），正确且已落地——结论层不可信就不能继续自动推进。
- **基础设施 transient 失败**（限流 / 网络 / 超时，LLM 调用本身抛错）：**不得落盘为终局 review**。本轮验收放弃、不产生 review，`lastReviewedRunIndex` 不前进——该 run 自然成为「已接受未审」状态，由恢复扫描 / 下次唤醒补审（§5.6 第一行，零新机制）。过夜 20 轮任务不能因第 12 轮撞一次 429 就永久退出；与准入侧「LLM 不可用降级不阻塞用户」的韧性设计对称。

> 生效面：已落地（C16）——`reviewRun` 返回结果联合 `reviewed | deferred(cause: infrastructure | aborted)`，分流判据在 AgentResult 层（`error` 与取证阶段基础设施错误 → deferred；`completed`/`max_turns` 无有效提交 → 结论性终局；`aborted` → deferred 不落盘）；deferred 不落盘 review、不前进已审进度，发 `advancement:review_deferred`，由三个补审触发点收敛（含 turn 提交先 catch-up 再审当轮，带上界排除当轮防吞调度）；afterTurnCommitted 增设 runIndex 幂等护栏防触发点并发双审。

实现上可以复用 provider 调用、prompt 组装、工具调用、注意力窗口与 SegmentManager 等底层原语，但不得复用执行侧 main runtime 的 loop / tools / lifecycle。若第一版为了装配便利使用 runtime 能力，也必须是专用 evaluator runtime，且只暴露只读取证工具与裁判判定工具，禁用执行工具与主线 transcript 写入。

推进侧不写主线 transcript；结论性 review 与归因只进入对话 owner 的 advancement 权威状态。

### 7. 退出边界

本能力不设置“最多连续 N 次 run”一类固定上限。退出由有效性与边界驱动：

- **通过退出**：Rubric 的通过标准满足。
- **无有效推进内容退出**：未通过但 Rubric 没有可适用的固定 failureHandling，或填不出新的事实变量。
- **死胡同退出**：连续推进无法产生新证据、新缺口或新策略，继续发送同类代理消息只会重复消耗。
- **风险退出**：触发安全、权限、外部副作用、用户底线或成本风险，推进侧不擅自升级。
- **用户接管 / 目标变更退出**：用户真实输入改变目标、修改验收标准、要求停止自动推进，或开启新任务。有推进事实的接管归 `exited` 并交付收场（§5.4 终态归类裁决）。
- **系统能力退出**：裁判结论性失败（fail-closed 的 `system-error`）、required 客观证据超出系统当前独立核验能力（§6 能力缺口）——诚实告知用户系统层原因、请人工验收。**基础设施 transient 失败不是退出类别**：不产生 review、挂起待补审（§6 韧性裁决），穷尽重试仍不可用也只挂起，不伪装成任务级结论。

死胡同判断的核心不是 run 次数，而是“下一条代理消息是否还能带来新的有效推进”。不能证明有效，就退出。**死胡同检测机制化（裁决）**：跨轮比较的输入是 owner 权威状态里的结构化 review 序列（以 `criterionId` 锚定的逐条判定集合、证据指纹的逐轮对比——"连续 N 轮 unmet 条目集与证据无变化"是机械可验信号），不依赖推进侧折叠窗口的自然语言记忆——任务越长窗口折叠越早蒸发跨轮细节，而长任务恰是最需要死胡同检测的场景；LLM 裁判在机械信号之上做最终判断，事实来自权威日志、判断交 LLM。

**单会话失控保险丝（裁决）**：需求底线「不允许执行侧无限执行」的机制落点。单个推进会话设 **token 口径**的可配置宽阈值，默认宽到正常任务永不触碰——它是失控保险丝，不是推进机制；触达即以 exitReason `budget-exceeded`（新枚举值）退出 + 收场交付（用户拿到完整进度与卡点，不是静默熔断）。退出分类归位：保险丝是上方「风险退出」类中「成本风险」的机制化落点。选 token 不选 run 次数：token 是用户真正在乎的成本口径，且不与「不设固定最大 run 次数」冲突（后者拒绝的是拿轮数当验收 / 退出机制）。计量数据源 = review 序列所载的 usage 两半快照（被审 run 的 RunRecord usage + 裁判调用 usage，随 review 落盘、沿序列累加即得会话总量，免于回读 transcript，§4.5）。哲学与注意力层「应急地板」同构：正常机制（死胡同检测 / 风险退出）之上的最后保险。owner 级全局预算仍外移宿主层（见下），两层互补不重复。

**契约再生路径（裁决）**：用户中途修正验收标准（"第 3 条写错了，应该是 X"）按目标变更退出后，不得逼用户从头重来——新推进会话的草案从旧契约**预填 + 用户修正**生成（草案修订机制 `rubricDraftVersion` 现成），确认后成为新的不可变快照。语义上仍是「退出 + 新契约」（不可变原则不破：绝无"第 k 轮按哪个版本判"的歧义），体验上是一回合的事。执行侧历史本就留在同一 conversation，执行进度零丢失。

**全局预算（跨模块缺口，记录待决）**：per-conversation 串行与隔离已正确，但 N 个对话并发自动续推没有任何 owner 级预算 / 节流——多个过夜任务可打满 rate limit，并与裁判失败路径共振。该边界不属于本模块（单会话内无从判断全局负载），应挂核心宿主层（调度器 / RuntimeHost 已是全局资源的 owner），与未来其他自动化消费者（scheduler、workflow）共用同一预算面。本文只记录依赖，不在推进侧造局部限流。

**收场交付（裁决）**：`completed` 与 `exited` 不是裸事件名，而是一份收场报告——素材全部来自 owner 权威状态（逐轮 review 的标准判定、证据、已试的 failureHandling、exitReason），退出/完成时一次 LLM 合成：**标准矩阵**（每条 passCriteria 的最终状态 + 最后证据）+ **已尝试策略** + **卡点与建议下一步**（exited 时）/ **验收证据链**（completed 时）。用户过夜发任务，醒来看到的是"推进了 N 轮、完成了 X、卡在 Y、建议 Z"，不是一行退出原因加 20 轮 transcript 考古作业。合成失败降级为结构化数据直出，不阻塞退出。

### 8. Rubric 全局资产与会话快照

Rubric 是与 Skill / Rule 同级的一等全局资产。推进模块只依赖 `RubricCatalogPort` 的轻量索引和按需正文；锚点 adapter 从 GlobalStatePort 的 rubric asset index 读取身份与 revision，再从 ArtifactStore 取得规范正文。写入时正文先落内容资产，GlobalStatePort 只保存 ArtifactRef、元数据和对象级 revision；目录、RPC 或 owner-services 都不得直接打开设备文件 Store。

全局资产身份与会话契约身份分离：库命中快照记录稳定 rubricId/version；新草案快照使用 local-draft snapshotId/contentDigest。全局保存、修订、归档不改变 active 会话内容。匹配只看 title / description / 场景描述，正文按需加载，保持渐进披露；Rubric 索引只进入契约构建上下文，不进入执行侧 system prompt 或裁判验收上下文。

**冷启动（产品缺口，记录待决）**：出厂 RubricStore 为空，意味着用户前 N 个推进任务全部走最重路径（LLM 现写草案 + 阅读 + 确认）——闭环的第一印象由最贵的形态承担。linked 区机制已在，缺的是一批产品预设 Rubric 资产（常见场景：代码开发完成验收、文档审查、需求收敛等）的规划与写作。这属于产品资产投入，不是架构改动；预设内容进 requirement-backlog 立项，不在本文展开。

**Rubric 演化回路（扩展点，留口不实现）**：当前 Rubric 是静态资产——推进失败、死胡同退出的 review 事实不反哺 Rubric 改进。长期形态应与 skill-evolution 同构：从退出/失败的 AdvancementRunReview 中提炼 Rubric 修订建议，经用户确认后才落库（演化不绕确认，与契约不可变原则一致——修订产生新版本，不影响已 active 会话的快照）。本次只保证协议与 Store 不堵这条路（版本化、review 含 unmetCriteria 与 exitReason 已够用），不实现。

### 9. Cache 与上下文边界

执行侧与推进侧各自拥有稳定前缀：

- 执行侧：现有 main runtime 的 tools / system / messages 规则不变。
- 推进侧：独立 profile、独立 Rubric 索引、独立判断历史。
- 代理消息只追加到执行侧 messages 尾部，是正常对话增长，不改执行侧 tools/system。
- 契约验收条件经 run 瞬态注入落在当前 run 用户消息的发送视图文本上（§5.3，messages 序列末端），不动 system / tools 与历史前缀，不进窗口事实——cache 前缀稳定性不受影响。
- 推进侧判断过程不进入执行侧 messages，避免污染主线判断与 cache。

这与提示词缓存文档的结论一致：支线/推进侧不会顶掉主线 cache；真正要守住的是两条链各自前缀稳定。

### 10. 事件与产品显示

新增事件面：

| 事件                               | 时机                               | 用途                                        |
| ---------------------------------- | ---------------------------------- | ------------------------------------------- |
| `advancement:contract_draft`     | Rubric 草案生成                    | UI 展示确认面                               |
| `advancement:contract_confirmed` | 用户确认 Rubric                    | 标记任务进入推进                            |
| `advancement:contract_cancelled` | 用户取消或新真实输入覆盖待确认草案 | 清理确认面与等待态                          |
| `advancement:run_reviewed`       | 每轮 run 验收完成                  | 展示验收摘要 / 调试                         |
| `advancement:proxy_enqueued`     | 代理消息入队                       | 显示“推进侧将继续”                        |
| `advancement:completed`          | 验收通过                           | 交付收场报告（验收摘要 + 证据链，§7）      |
| `advancement:exited`             | 退出                               | 交付收场报告（标准矩阵 + 卡点 + 建议，§7） |
| `advancement:contract_failed`    | 草案生成不可用或失败               | 确认面受控失败提示                          |
| `advancement:proxy_recovered`    | 恢复期重接 outstanding 代理消息    | 恢复可观测                                  |
| `advancement:recovery_failed`    | 恢复扫描单点失败                   | 恢复可观测 / 诊断                           |
| `advancement:review_deferred`    | 裁判 transient 失败、本轮验收挂起  | 挂起可观测（§6 韧性）                      |

这些事件经 `session.event` 的带外通道发出（`scope:"control"` 信封，与 `scope:"run"` 的执行事件物理分流），不混入 `session.delta` / `session.complete` 的执行流。

显示规则：

- 用户真实消息保持原样。
- 推进侧代理消息在对话流中显示，但用明确来源标记区分。
- 推进侧判断详情默认折叠；需要时可展开。
- Rubric 确认面是任务开始前的一次控制面，不是主线聊天内容；CLI 投影复用 `SelectionService`，其它接入面按同一控制面事件投影自己的确认 UI。
- 选择模块的演进必须保持通用：新增能力只能抽象为短决策、说明展示、详情展开、输入补充、二次确认、编辑承接等领域无关交互能力，不能出现 Rubric 专属协议。

**用户可见 framing 与文案是一等设计产物（裁决）**——对一个自主执行的功能，表层就是信任赢或输的地方，不得当作接入面实现细节留白。以下呈现裁决除末条渠道节奏外均随 C11 验收（确认面三条的改造对象是 C5 已落地的确认适配器、收场文案的内容源随 C17 合成，验收锚统一在 C11 的零认知走查）：

- **确认面 framing**：对齐语气而非流程语气——「我打算按这几条判断任务算不算完成，你看对吗」，不把 Rubric / 推进准则作为用户必须理解的概念顶到脸上（可作标签出现，不依赖其被理解）；顺带告知「之后还能改」（契约再生已支持），降低首次确认的心理重量。
- **折叠层级对齐公开 / 私有边界**：确认面主体 = passCriteria + evidenceRequirements（「什么算做完」的公开面）；failureHandling 收进深层详情并标注为「未达标时的续推内容」——它是用户确认的契约但不是决策主体。
- **matched / generated 差异化确认重量**：命中已有 Rubric 用轻确认（一行式「按『××验收』推进？」+ 可展开），现场生成才用通读式——用设计已有的 source 区分缓解长期确认疲劳，不破「确认只在首 run 前」不变量。
- **来源标记自解释**：代理消息标记强到明说（「知行推进 · 自动续推」级），不靠色调暗示——零认知用户不得产生「这是我发的吗」的困惑。
- **归因块的双面呈现**：归因是代理消息 content 的一部分（给 LLM），对用户默认渲染为每轮一行的紧凑判定、细节可展开——「判断详情默认折叠」的对象即归因块。
- **中途插话可见性**：分类结果一句话告知（「已作为当前任务的补充继续推进」/「目标已变更，原推进已退出并附收场」）；in-flight 代理 run 被 abort 时给一句「已中止当前推进以处理你的输入」。
- **unknown 的人话**：收场矩阵不裸露 `unknown`，翻译为「无法独立核验，已按执行侧报告采信」。
- **保险丝透明**：触发时收场报告解释原因（「达到单任务成本上限」）并指向配置项。
- **awaiting 主动浮现**：resume / 打开会话时待确认任务优先呈现，不埋在列表里——持久化不等于可见性。
- **渠道节奏原则**：消息通道（飞书等）的运行期投影用里程碑式批量（确认 / 完成 / 退出必达，逐轮验收摘要聚合），不逐事件刷屏——具体形态归未来渠道投影设计，此处只定原则，**不随 C11（CLI 投影）验收**。

> 生效面：已落地（C11）——控制事件经推进控制面监听器（scope:"control" 的第二条腿）渲染为对话流系统行：验收摘要（unmet 全列、逐条归因折叠、尾注 /advancement 展开入口）、自动续推提示、收场报告（completed / exited 随 closure 直出）、验收挂起与恢复提示；「可展开」由 `/advancement` 查看命令落地（`session.advancementDetail` RPC：open 会话给标准矩阵逐条归因 + 判定理由 + 证据摘录 + 采信证据 + 已试策略 + 消耗，无 open 时给最新终态会话的收场回看——离线错过收场事件后随查随算）；代理消息来源标记「知行推进 · 自动续推」实时（turnOrigin）与历史（RunRecord.source）同源明示；awaiting 恢复呈现经 resume / list / workscene enter-exit 快照携草案全文主动重建确认面（切当前对话指针的全部路径统一），/resume 候选列表标注推进状态；确认面 framing 三条（对齐语气、failureHandling 收详情深层并标注用途、matched 轻确认）落地于确认适配器；中途插话经 send 结果的 continuation 标记一句话告知（helper 与 fall-through 两条 active 路径一致，含 in-flight 中止提示）。contract_* 事件不经监听器重放（发起端同步流承载，避免双渲染）。确认链身份纪律（对抗审查修复）：awaiting 结果的 turnId 恒取草案 originalTurnId（不随二次 send 漂移）；confirm 绑定发起端所见 rubricDraftId（协议层必填强制，不依赖客户端自觉），并发修订后拒绝盲确认；Esc / Ctrl+C 只收起确认面不取消任务（永久取消只走带二次确认的 cancel 选项）；active 会话的输入即便对话正忙也先过准入分类（排队与分类正交，接管 / 修正意图不静默丢进闭环），take-over 后的输入统一重新分类；resume / workscene enter 在恢复前先入组播名册，且接入面事件过滤用「当前对话 + 切换型 RPC 进行中的目标」谓词（isWatching，exitScene 逐候选精确收敛）——恢复期通知帧先于 RPC 响应到达，只认当前对话会在消费端把事件丢掉；带外监听器先于启动 auto-resume 建立（controller 就绪前的启动窗口全放行——该窗口内本连接只 observe 了 resume 目标，放行即精确），启动恢复与 /resume 切换走同一套可见性机制；订阅顺序 / 切换窗口 / 启动时序均有测试锚；验收轮次是会话内 review 计数（随事件与快照下发），不是对话全局 runIndex。

### 11. 包与代码落点

| 包                        | 新增/改造                                                                                                         | 说明                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `@zhixing/core`         | `rubrics/`、`advancement/` 基础类型、RubricContractBuilder、准入 / 草案生成策略、TurnSource 扩展              | 资产协议、纯类型、存储原语与可替换策略接口                                            |
| `@zhixing/orchestrator` | `AdvancementRuntime`、评价 prompt、代理消息构造                                                                 | 推进侧 evaluator runtime 与执行侧 runtime 同层装配                                    |
| `@zhixing/server`       | `ServerContext.advancement` 挂载 `AdvancementController`、RPC 确认方法、事件组播                              | 会话 owner、串行队列与控制面编排（CM 不持 advancement 引用，见 §3）                  |
| `@zhixing/cli`          | Rubric 确认适配器、代理消息标记、推进事件渲染；serve 宿主装配：注入订阅者注册 + RuntimeHost lifecycle 透传（C14） | 接入面投影，不持状态；确认交互复用`SelectionService`；宿主装配层现居本包 serve 命令 |

关键改造点：

- `AdvancementController` 挂载在 `ServerContext.advancement`，由 session.* RPC handler 编排调用；`ConversationManager` 类本体不持有其引用（「不内嵌 Rubric 语义」由结构保证，见 §3 生效面注）。
- `session.send` 仍是入口，但返回结果需要扩展出 `awaiting-rubric-confirmation` 状态：先由会话 owner 确定 conversation 身份，再交给 AdvancementController；若进入 Rubric 契约，不执行 main runtime，也不发执行态 `session.complete`。
- 新增 Rubric 确认 RPC / CLI action：确认后由 RPC / 控制面在 `makeTask` 闭包中复用原始 `turnId`，再把原始用户任务交给 `ConversationManager.admitTurn`；取消则关闭推进会话、发控制面事件且不执行原任务。
- CLI action 通过现有 `SelectionService.choose` 承载一次性确认；Rubric 领域只提供 `SelectionRequest` 映射器，不直接依赖 TUI region。
- 若 Rubric 确认需要选择模块当前没有的能力，改造点归 `packages/cli/src/tui/selection/` 的通用协议与 presenter，不落在 Rubric 业务适配器里；选择模块不得 import 或感知 Rubric。
- `recordTurn` 成功持久化并入窗后，才调用 `afterTurnCommitted`；可复用现有 `onTurnCommitted` 信号，但调度下一条内部代理 turn 的权限留在 server 层 controller。
- 推进侧新增受限只读取证通道，只读客观产物，不复用执行侧写工具，不通过执行侧自述替代证据。
- `pendingQueues` 增加内部来源 `advancement` 的调度语义：同一推进会话最多一条 outstanding 代理消息，不占用户 pending 上限，不允许堆积。
- `RunRecord` 增加 run 级 advancement 元数据，history / RPC wire / CLI 渲染同步透传；不得把来源元数据塞进 `Message`。

### 12. 实施路径索引

§15 的 C1-C17 是唯一的提交与审查执行计划（C1-C9 首轮实现已提交；C10-C13 为第一轮实现一致性审查后的收口单元；C14-C17 为第二轮设计对抗审查后的收口单元）。本节不再维护独立的旧 M 阶段实施路径，避免两套计划并存。

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

后续实施和审查只按 §15 执行；若本节映射与 C1-C17 冲突，以 C1-C17 为准。

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
- 未通过时代理消息 = failureHandling 意图骨架 + 事实变量 + 结构化归因事实块（§4.6）；推进意图不被改写。
- 同一 active session 同时最多一条 outstanding 代理消息。
- 代理消息进入主线 transcript，RunRecord 带 `source: "advancement"` 与 metadata，显示层可区分。
- `Message` 不承载 advancement 元数据，模型上下文只看到纯 `role/content`。
- 推进侧判断过程不进入主线 messages。
- active session 恢复后继续使用确认版 Rubric。
- 用户真实输入到来时区分补充 / 微调与目标变更 / 接管；代理 run in-flight 时优先 abort，未 completed 不入窗不验收。
- 无固定最大 run 次数；死胡同退出由“无有效推进内容”触发。
- 执行侧 tools/system 不因推进流程变化。

收口单元（§15 C10–C13）新增的验收项：

- awaiting 会话跨重启：不进恢复扫描、不自动重发草案事件；resume 快照回投后接入面重建确认面，待确认任务对用户可见（当前缺专项测试）。
- 第一级取证：file-diff / log / artifact 类 required 证据由 evidenceProvider 独立核验产出 `source:"independent"`，验收可 passed；取证只读、无写副作用。
- `required` 与取证能力集耦合：草案生成不产出能力集外的 `required:true`；能力缺口局面走退出请用户裁决，不进入无效 failed 循环。
- CLI 推进投影：代理消息带来源标记渲染、`run_reviewed` / `completed` / `exited` 有终端呈现、判断详情默认折叠可展开；确认面与收场文案按 §10 framing 裁决落地。
- 持久化退役：对话删除连带删除 advancement 目录（清理失败不影响主删除）；孤儿目录被维护 sweep 收走。
- 准入会话投影：上下文依赖输入（“继续把它弄完”类）在有会话投影时分类正确。

第二轮收口单元（§15 C14–C17）新增的验收项：

- 契约验收条件注入：active 期间每 run 发送视图含验收条件块、终态后停注；落盘 `messages[0]` 恒为用户原文、窗口不含注入块；不动 cache 前缀。
- 归因通道：代理消息含逐条判定 + 理由 + 证据摘录；意图骨架仍来自用户确认的 failureHandling；判断分歧场景（执行侧自认已过、裁判独立证据相反）经归因块一轮解开，不再原地打转。
- 场景化沉淀：生成草案的 passCriteria 是场景级表述；库内不出现单次任务快照式条目。
- 裁判韧性：transient 异常不落盘 review、`lastReviewedRunIndex` 不前进、恢复扫描补审；结论性失败仍 fail-closed 终局。
- missing-proxy 自愈：最新 failed review 的 proxyMessageId 缺失于 proxyMessages 且未 settled 时，从 review 确定性重建、补写 proxy_enqueued 后入队，不静默放过。
- 接管终态：有推进事实的接管归 exited 并交付收场报告；awaiting 取消与对话删除仍为 cancelled、无收场。
- 收场交付：completed / exited 携带标准矩阵与证据链 / 卡点建议；合成失败降级为结构化数据直出。
- 契约再生：标准修正退出后新草案从旧契约预填，一次确认即可重启推进。
- 失控保险丝：单会话累计 usage 触达阈值即系统边界退出 + 收场交付；正常任务永不触碰默认阈值。
- 信任边界（验收载体归 C14 裁判 schema + C10 独立证据）：客观 kind 条目无独立证据时 verdict 恒为 unknown 不得 met；unknown 条目不阻断 passed（两层门：条目层仅拦 unmet、required 拦截在证据层）且在收场矩阵如实呈现。

C18 新增的验收项：

- 近邻沉淀治理：生成草案仍可参考低分候选；只有达到近邻阈值的候选才在确认面默认提示复用 / 修订已有条目而非另存，且用户可显式另存。

### 14. 不变量

1. 用户真实任务就是目标表达；不得要求用户在发任务时额外写验收标准。
2. Rubric 确认只在第一次执行 run 前发生。
3. active 后不得每轮协商 Rubric。
4. 推进侧不得把思考过程与裁判程序写进主线历史；进入主线的只有代理消息的意图骨架与结构化归因事实（结论 + 证据摘录）。
5. 代理消息必须带来源标记，不得伪装成用户本人输入。
6. 推进侧只验收和续推，不替执行侧执行任务。
7. 不设置固定最大 run 次数作为验收 / 退出机制；单会话 token 保险丝（§7）是失控异常保护，不参与正常推进判断。
8. 不能产生有效代理消息时必须退出。
9. 推进侧上下文尺寸复用现有注意力窗口规则。
10. 执行侧和推进侧 cache 链各自稳定，互不顶掉。
11. Rubric 确认不得削弱公共选择模块边界；选择模块能力不足时只能做通用升级，不能做 Rubric 专用绑定。
12. 只有推进任务启动 Rubric 闭环；普通任务不被重型确认流程拖慢。
13. 推进侧必须优先独立核验证据，不得把执行侧自述当成客观证据。
14. 准入自动判断必须允许用户用自然语言纠错：可升级为推进任务，也可在待确认阶段降级为普通任务。
15. active 期间确认版验收条件（passCriteria + evidenceRequirements）对执行侧每 run 可见（run 瞬态注入载体，注入只活在当前 run 的发送视图）；落盘 `messages[0]` 恒为用户原文、窗口不含注入块；failureHandling 与裁判过程不下发执行侧。
16. 裁判基础设施 transient 失败不产生终局 review；未审的已接受 run 由恢复扫描补审。
17. 沉淀入库的 Rubric 必须是场景级资产（标准可复用、任务细节归变量与证据要求），不是单次任务快照。

### 15. 提交与审查拆分计划

本能力不适合一次性提交。后续实施必须按下列提交单元递进；每个单元都应能独立审查、独立解释设计边界，并且必须独立构建通过、相关测试通过。不得提交半成品公共 API；引入类型、入口或 wire 契约的单元必须同时包含最小可验证实现和测试。审查也按同一拆分进行，避免把协议、交互、运行体、队列和恢复问题混审。

这些单元不是任意顺序的并行任务，而是带依赖的可执行提交链。只有前置依赖满足后，后置单元才允许开工；如果实施时发现某个后置单元缺少前置能力，必须回到依赖单元补齐，不得在当前单元里临时拼接绕过。

**完成度事实（多轮定稿审查结论，2026-07）**：C1-C9 首轮实现已全部提交，架构骨架（契约模型、状态机、队列语义、fail-closed 裁判、恢复、隔离与 cache 边界）与源码核对成立，外部裁判循环路线经对抗审查确认长期正确。

第一轮审查（实现一致性）发现四处缺口，由 C10-C13 收口：① C6 独立取证空壳 + required 护栏死锁（§6）；② CLI 显示半边缺席（§10）；③ 准入无会话投影（§5.1）；④ 控制日志无退役（§4.7）。

第二轮审查（设计对抗）修订四项承重裁决，由 C14-C17 收口：⑤ 闭环信息结构——验收标准此前对执行侧全程隐藏、裁判归因通道只有两个变量，构成效率天花板与打转风险（§0 新裁决、§4.6、§5.3）；⑥ 确认即沉淀的库腐化（§5.2 场景化治理）；⑦ 裁判 transient 失败被判终局（§6 韧性、§5.6 恢复契约）；⑧ 收场交付与契约再生缺失（§7）。

第三轮审查（实施者推演 + 机械一致性 + 产品旅程三路盲审，含外审复核）修订施工级问题：⑨ 恢复矩阵 missing-proxy 判定谓词按 store 折叠事实修正（§5.6）；⑩ 接管终态归类裁决——有推进事实归 exited 并收场（§5.4）；⑪ C16/C17 对 C14 的依赖补入依赖表；⑫ C10 施工地基裁决（§6 第一级取证施工语义：file-diff = git 工作区变更、locator 定位、能力集探测、capability-gap、路径安全）及 required 缺省生效面事实；⑬ 呈现层 framing 一等化（§10 裁决清单）。

上述缺口已由 C10-C18 收口：C9 的「封口」只覆盖 C1-C8 已实现面，最终验收纲以 C18 落地后的 §13 为准。

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
| C10  | C6                                                                           | 第一级独立取证 provider、required 能力集耦合、能力缺口退出语义   |
| C11  | C5、C7、C9                                                                   | CLI 推进运行期投影 + awaiting 恢复呈现                           |
| C12  | C4                                                                           | 准入会话投影与延迟观测                                           |
| C13  | C3                                                                           | advancement 持久化退役（删除连带 + 孤儿 sweep）                  |
| C14  | C4、C6、C8                                                                   | 闭环信息结构：契约标准 run 瞬态注入 + 结构化归因通道             |
| C15  | C4                                                                           | Rubric 场景化生成与沉淀治理                                      |
| C16  | C6、C9、C14（归因重建半边）                                                  | 裁判 transient 韧性 + missing-proxy 自愈 + 恢复契约测试          |
| C17  | C4、C7、C14（标准矩阵 / criterionId）；CLI 呈现随 C11                        | 收场交付合成 + 契约继承再生                                      |
| C18  | C11、C15                                                                     | Rubric 近邻沉淀治理交互                                          |

因此，只有 C1 与 C2 可以无前置并行；C6 在 C1+C3 后可与 C4/C5 分支并行推进；C7-C9 是严格后置集成单元。尤其 C9 不是“最后再想想”的补丁，而是全链路恢复与验收的封口单元，不能在 C1-C8 未完成时实施。C10-C15 互相独立、可并行开工；**C16 的归因重建半边与 C17 的标准矩阵依赖 C14 的归因持久化**——C14 先行，两者才能完整验收（各自不依赖归因的半边——补审分流、保险丝计量等——可先行）。C18 依赖 C15 的候选机制与 C11 的确认面投影，是沉淀治理的交互收口。全部完成后 §13 验收纲才算走完。收口优先级按承重排序：C14（信息结构是效率天花板、且是 C16/C17 的数据源）与 C10（可靠性支柱）最先，C16（韧性）次之，其余并行。

实际落地波次记录：

- `596b2d1` wave-1：C14 + C10 + C12 + C13 + C15 生成契约半边。组波理由：先落效率天花板、可靠性支柱与可并行的小收口单元。
- `1f2dfd1` wave-2：C16 + C17。组波理由：二者依赖 C14 的归因持久化与 criterionId 数据源，合并实现可避免恢复、收场、保险丝中间态拆裂。
- `a58eef2` wave-3：C11。组波理由：CLI 呈现消费前两波产出的事件、收场报告、归因与信任边界语义，作为用户可见收口最后落地。

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

- 实现 `AdvancementAdmissionStrategy`：用 LLM 语义判断区分问题 / 普通任务 / 推进任务；硬编码规则不得作为产品级准入路径。
- 实现可替换的 Rubric 草案生成策略：未命中 Rubric 时由 LLM 生成场景化草案；固定模板只允许作为测试替身，生成失败走 `contract-failed`。
- 扩展 `session.send` 返回 `awaiting-rubric-confirmation`。
- 新增确认 / 取消 RPC action；确认后通过 `makeTask` 闭包复用原始 `turnId`，不改 `admitTurn` 接口。
- 支持自然语言升/降级逃生阀。

审查重点：

- 普通任务是否不被重型流程拖慢。
- 准入判断是否不要求用户选择模式，且没有退回关键词抢判。
- Rubric 草案是否来自可替换生成策略，真实产品路径没有退回通用固定模板。
- `turnId` 流转是否符合现有 RPC / `admitTurn` 事实。

#### C5：CLI Rubric 确认适配器

落地提交：

- `625591a` `feat(core/advancement): support rubric draft revision`
- `6882c21` `feat(server/advancement): expose rubric revision control plane`
- `47db2f5` `feat(cli/advancement): add rubric contract confirmation flow`

内容：

- CLI 监听 `advancement:contract_draft` 等控制面事件。
- 将 Rubric 草案映射为通用 `SelectionRequest`。
- 将 `SelectionResult` 翻译为确认、取消、编辑承接或降级直接执行。

审查重点：

- CLI 是否复用 `SelectionService`。
- 是否没有直接 import `security/select-operation-region`。
- 确认面是否不写入主线聊天内容。

#### C6：推进侧运行体、独立取证与裁判判定工具

落地提交：

- `79b6864` `feat(orchestrator/advancement): add advancement evaluator runtime`

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

落地提交：

- `c0245b6` `feat(server/runtime): expose accepted turn commit facts`
- `e3a9c75` `feat(server/advancement): review accepted runs after commit`
- `df358be` `feat(cli/advancement): project run review events`

内容：

- 在 run accepted 之后触发 `afterTurnCommitted`。
- 生成并持久化 `AdvancementRunReview`。
- 发出 `advancement:run_reviewed`、`completed`、`exited` 等事件。

审查重点：

- 只有 completed 且已接受的 run 才触发验收。
- 持久化失败、abort、error 不被当成事实。
- 事件走 `session.event`，不混入 `session.delta / complete` 执行流。

#### C8：代理消息续推、队列与用户中断

落地提交：

- `efe1ddd` `feat(core/advancement): add active advancement proxy primitives`
- `c7390fc` `feat(server/runtime): support advancement-sourced queued turns`
- `db91ed6` `feat(advancement): schedule proxy turns after failed reviews`
- `8297487` `feat(server/session): handle active advancement user input`

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

落地提交：

- `a30ccef` `feat(core/advancement): persist reviewer window state`
- `0626990` `feat(advancement): wire reviewer context window state`
- `6b338b0` `feat(advancement): centralize review result dispatch`
- `8a871e1` `feat(advancement): recover active sessions on resume`

内容：

- host 重启 / 会话恢复后恢复 active advancement session。
- 推进侧独立窗口接入与诊断信息落地。
- 补全端到端测试：准入、确认、验收、续推、退出、恢复、选择模块边界、cache / message 不污染。

审查重点：

- 恢复后是否仍使用确认版 Rubric snapshot。
- 推进侧上下文是否复用现有注意力窗口规则。
- 全链路是否满足本文不变量。

#### C10：推进侧第一级独立取证

落地提交：

- `596b2d1` `feat(advancement): land wave-1 closure of the advancement loop`

内容：

- 实现第一级取证 evidenceProvider（按 §6「第一级取证施工语义」）：file-diff = git 工作区变更只读读取（非 git / git 不可用则该 kind 不进能力集）；log / artifact 按契约 `locator.paths` 定位读取；产出 `source:"independent"` 证据；生产装配注入，替换空壳默认 provider。
- `EvidenceRequirementSpec` 扩展可选结构化 `locator`（第一级仅 paths）：草案生成填写、确认面可见可改；file-diff 无 locator 时以工作区全量变更 + 执行侧本轮触碰路径投影兜底；log / artifact 无可执行 locator 不得标 required。
- 取证能力集：类型住 core、运行时探测住 orchestrator（git 可用性 / workspace 形态），经装配传入草案生成输入——`required:true` 只能落在能力集内的 kind；能力集外的证据要求可写入契约但不构成 passed 硬门槛（§6 裁决）。core 侧 required 缺省与 matched 路径已随 C10 改为按能力集约束，避免 required 死锁。
- 能力缺口退出语义：required 客观证据无法独立核验时走退出请用户裁决（exitReason 新增 `capability-gap`），不进入无效 failed 循环。
- 取证路径安全：locator 路径 realpath 归一 + workspace 边界校验（复用 PathGuard），越界按证据缺失处理、不抛权限确认。
- 第二级验证性执行（独立重跑测试/构建，经权限管线）本单元不做，只保证接口不堵。

审查重点：

- required 死锁解除：带 required 客观证据的 Rubric 在证据成立时可 passed；core 侧 required 缺省已按能力集收敛。
- 不变量 13 自此生效：推进侧对客观信号任务真正独立核验，不再依赖执行侧自述。
- 取证严格只读、零写副作用；证据与 requirement 的绑定不可伪造（沿既有裁判校验）；symlink / 越界路径不可逃逸 workspace（权限模块 S1 同款教训）。

#### C11：CLI 推进运行期投影与 awaiting 恢复呈现

落地提交：

- `a58eef2` `feat(advancement): present advancement progress in CLI`

内容：

- 代理消息来源标记渲染：对话流中 `source:"advancement"` 的消息带明确视觉区分（自解释级明示，§10），实时流与历史渲染同源。
- 控制事件终端呈现：`run_reviewed`（验收摘要）、`proxy_enqueued`（推进侧将继续）、`completed`（任务完成）、`exited`（退出原因）接入 CLI 控制面监听器。
- 推进侧判断详情（归因块）默认折叠、可展开。
- awaiting 会话恢复呈现：CLI 消费 `session.resume` / `session.list` 的推进状态快照，重建待确认面并主动浮现（§5.2 定死行为的接入面半边）。
- 确认面 framing 落地（§10 前三条）：对齐语气文案、折叠层级对齐公开 / 私有边界、matched / generated 差异化确认重量——改造对象是 C5 确认适配器。
- 中途插话可见性与收场文案（§10）：分类结果一句话告知、in-flight abort 提示、unknown 人话、保险丝原因解释（收场文案的内容源随 C17 合成，呈现验收在本单元）。

审查重点：

- 零认知用户视角走查：推进运行期的知情与控制完整——用户能分辨代理消息、知道任务在被推进、看到完成与退出。
- 渲染只消费既有 wire 事实（RunRecord 元数据 + control 事件），不新增宿主侧状态。
- 不违反选择模块与渲染层的既有通用性边界。

#### C12：准入会话投影与延迟观测

落地提交：

- `596b2d1` `feat(advancement): land wave-1 closure of the advancement loop`

内容：

- `AdvancementAdmissionInput` 扩展最近会话投影（执行侧窗口尾部轻量摘要/末组对话），server 侧喂入；上下文依赖输入的分类质量以专项用例验收。
- 准入延迟基线纳入观测（light 档往返计时进诊断面），LLM 超时/不可用的保守兜底路径保持不阻塞用户。

审查重点：

- 投影体量受控（轻量摘要，不把窗口整体塞进准入 prompt）。
- 判断仍为纯控制面：不写主线、不产 RunRecord。
- 延迟代价有观测数据支撑后续校准决策，不预建快速通道机制。

#### C13：advancement 持久化退役

落地提交：

- `596b2d1` `feat(advancement): land wave-1 closure of the advancement loop`

内容：

- `session.delete` 连带删除 `advancement/<conversationId>/` 目录，清理失败只 warn 不影响主删除。
- 孤儿目录维护 sweep：沿 `__transcript-gc` 同款「持久层 sweep 能力 + 调度器薄触发壳」模式，清理对应对话已不存在的 advancement 目录。

审查重点：

- 生命周期跟随对话本体（§4.7 裁决），无独立存活的控制日志。
- sweep 幂等、单点失败跳过、只删整目录不重写日志。
- 与 transcript GC 的分层模式一致：算法住持久层，调度层只是触发壳。

#### C14：闭环信息结构

落地提交：

- `596b2d1` `feat(advancement): land wave-1 closure of the advancement loop`

内容：

- 契约验收条件下发：active 会话期间确认版 passCriteria + evidenceRequirements 经 `onBeforeRun.injectUserContext` run 瞬态注入（§5.3 载体裁决——注入进当前 run 用户消息的发送视图文本），终态后停注；生命周期由推进会话状态纯函数派生。**注入订阅者由宿主装配层注册**——物理落点是 `packages/cli` 的 serve 装配（runtime 工厂 / `RuntimeHost.assemble` 现居 cli 包，需新增 lifecycle 透传）；不得经 ConversationManager（守 §3 结构保证）。
- 归因通路整链：契约快照固化分配 passCriteria 条目 id（§4.4）；裁判工具 schema 扩逐条判定结构 `criteria`（§6）；`AdvancementRunReview.attribution` 持久化（§4.5，系统兜底 review 空 criteria、无迁移义务）；代理消息以确定性渲染的归因事实块下发（§4.6）。
- 变量格式表已定案：`{unmet_criteria}`（unmet 条目标准文本、换行分隔，由逐条判定构造派生）、`{review_id}`；归因块非变量、恒定追加。unmetCriteria 投影载体定为标准文本（三个既有消费者——代理变量、exit 消息、窗口条目渲染——都消费文本）。已固化进 rubric-protocol 变量权威格式表。
- 附带落地：`review.usage` 两半快照（judge 随裁判 AgentResult、run 随被审 RunRecord）随本单元 schema 变更一并填充——保险丝求和的消费端归 C17。

审查重点：

- 落盘 `messages[0]` 恒为用户原文、窗口不含注入块（不变量 15）；cache 前缀不受影响。
- 归因只含结论与证据事实，不含裁判思考过程与程序（不变量 4 精确化后的边界）。
- 判断分歧场景端到端：执行侧自认已过 + 裁判独立证据相反 → 归因块使下一轮针对性修复，不打转。
- failureHandling 意图骨架仍是用户确认内容，归因不改写推进意图。

#### C15：Rubric 场景化生成

落地提交：

- `596b2d1` `feat(advancement): land wave-1 closure of the advancement loop`

内容：

- 草案生成契约修订：passCriteria / failureHandling 写场景可复用标准，任务细节归事实变量与证据要求——消除「贴合当前任务」与协议「表达场景」的自相矛盾（§5.2 裁决）。
- 沉淀治理的机制面：草案携带参考候选及评分（candidateRubricIds / candidateRubrics.matchScore），交互面归 C18。

审查重点：

- 生成草案的场景泛化性有专项用例（同场景两个不同任务应命中同一 Rubric）。
- 确认即采用、沉淀独立后续；沉淀物是场景资产而非任务快照（不变量 17）。
- 生成输出不把单次任务细节写死进可复用标准。

#### C16：裁判韧性与恢复自愈

落地提交：

- `1f2dfd1` `feat(advancement): land wave-2 judge resilience and closure delivery`

内容：

- transient / 结论性失败分流（§6 裁决），分流判据在 AgentResult 层：`reason:"error"`（provider / 基础设施错误折入结果、不走 throw）与取证阶段基础设施错误 → transient，不落盘 review、不前进 `lastReviewedRunIndex`、发 `advancement:review_deferred`，由三个补审触发点收敛（§5.6 挂起行）；`completed` / `max_turns` 而无有效裁判工具提交 → 结论性 fail-closed 终局；`aborted` → 不落盘不终局（run 被中止不产生结论，与用户输入 abort 语义一致）。
- missing-proxy 自愈（§5.6 修正后谓词）：最新 failed review 的 `proxyMessageId` 不在 `proxyMessages` 且未 settled → 从已持久化 review 确定性重建、补写 `proxy_enqueued` 后入队，替换现行静默放过路径。
- §5.6 恢复契约中间态矩阵全行覆盖测试。

审查重点：

- 429 / 网络抖动场景任务不终局（不变量 16）；结论层不可信仍必须终局。
- 重建代理消息的 **content** 与原始纯函数产物 byte 等价（模板 + 变量 + 归因渲染全部确定性，归因取自已持久化 review）；`createdAt` 不在等价范围（原始时钟不可知），但 **id 恒复用 `review.proxyMessageId`**——否则重建后「proxyMessageId 缺失于 proxyMessages」谓词依然为真，下次扫描再次命中造成循环重建。
- 恢复矩阵每一行有对应测试，无隐式中间态。

#### C17：收场交付与契约再生

落地提交：

- `1f2dfd1` `feat(advancement): land wave-2 judge resilience and closure delivery`

内容：

- 收场报告合成（§7 裁决）：completed / exited 时从 owner 权威状态的结构化 review 序列一次合成标准矩阵 + 已试策略 + 卡点与建议（exited）/ 验收证据链（completed），随事件交付；合成失败降级为结构化数据直出。
- 契约再生（§7 裁决）：标准修正类退出后，新推进会话草案从旧契约预填 + 用户修正生成（复用 `rubricDraftVersion` 修订机制），一次确认重启推进。
- 死胡同检测机制化（§7 裁决）：跨轮逐条判定（criterionId 锚定）与证据指纹对比消费 store 结构化序列，机械信号之上 LLM 终判。
- 单会话失控保险丝（§7 裁决）：token 口径可配置宽阈值，触达即系统边界退出 + 收场交付；usage 计量 = review 序列所载两半快照（§4.5 `review.usage.{run,judge}`）沿序列累加，exitReason: `budget-exceeded`（新枚举值，不复用 system-error / capability-gap）。
- 接管终态对齐（§5.4 裁决）：active 接管从现行恒 `cancelled` 改为 `exited`（有推进事实即收场），`cancelled` 只留给无执行事实的关闭。
- 收场事件时序：completed / exited 事件随报告就绪发出（合成为一次 LLM 调用，秒级延迟可接受）；合成失败即降级结构化直出，不无限等待。合成执行体经可替换 strategy 注入 controller（与准入 / 草案生成同构），默认走宿主轻推理通道。
- 契约再生触发：准入 active 阶段动作集细分出「修正标准」类（接管的子类），命中即走旧契约预填再生流。

审查重点：

- 收场报告素材全部来自已持久化事实，合成不引入新真相源。
- 再生语义仍是「退出 + 新不可变快照」，无中途可变契约。
- 死胡同判断不依赖推进侧窗口的自然语言记忆；CLI 收场呈现随 C11 验收。

#### C18：Rubric 近邻沉淀治理交互

内容：

- generated 草案存在达到近邻阈值的候选时，确认面默认提示「更新已有并开始」，并保留「另存新准则」选项。
- 用户选择更新已有时，confirm 请求携带沉淀选择；core 使用草案内容修订候选 Rubric：own 直接更新，linked 通过 own 覆盖层承接用户修订，不改外部 linked 源。
- 用户选择另存时，仍按新 Rubric 入库，不阻断显式另存意愿。

审查重点：

- 选择模块保持领域无关：只使用普通 option / input / confirm 能力，不新增 Rubric 专属协议。
- 近邻治理复用既有 `rankRubrics` 评分，只对达到近邻阈值的候选默认优先修订已有条目，避免库被一次性条目污染。
- 确认后的 Rubric 快照仍不可变；修订影响的是未来复用资产，不改变已确认推进会话的契约快照。
