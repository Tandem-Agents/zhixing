# 权限信任分级体系 — 架构设计（可执行级）

> **定位**：把权限决策从"信任混入操作分类的静态规则"重构为「**操作影响 × 信任等级**正交 + **信任机制**为主、**AI 安全管家**研判灰色地带」的统一体系。需求与取舍依据见 [../drafts/permission-architecture-evolution.md](../drafts/permission-architecture-evolution.md)；现状见 [security-system.md](./security-system.md)、[tool-permission-execution.md](./tool-permission-execution.md)。
> **写作规约**：只写当前生效设计 + 决策依据 + 对接点（`文件:符号`）；不写版本号 / 修订史。

## 一、范围与分层纪律

- **做**：信任上下文建模、操作影响与信任正交分级、信任机制（沉淀/复用/可撤销）、AI 安全管家研判、对现有 classifier/决策中间件的去耦合重构。
- **保留不动**：`bypassImmune` 禁区（`builtin-rules.ts`）、`PathResolveMiddleware` realpath 链路、`ConfirmationBroker`/`PermissionStore`/`ConfirmationTracker` 基建、**现有 authorize 洋葱的分层结构**（每个中间件单一职责，不合并）。
- **分层纪律（关键）**：`core/security` 的 pipeline 是**纯同步规则评估、不碰 LLM、也不知道"管家"存在**——它只产出既有的确定性语义（`allowed` / `requiresConfirmation` / `operationClass` / `matchedPermissionRule` / `trustLevel`）。**AI 安全管家整个落在 `orchestrator` 的 secure-executor 编排层**：由它组合上述字段判断是否触发管家、调 `ctx.llm.main` 研判。core 不反向依赖 orchestrator/LLM，也无任何 "steward" 命名泄漏。

## 二、依赖关系（一等内容）

### 2.1 依赖图（单向、无环）
```
create-agent-runtime ── 注入 ──┬─► SecurityPipeline(trustContext)        [core/security]
                               └─► secureExecutor(trustContext, ctx.llm)  [orchestrator]

[core/security · 不碰 LLM、不知管家]   authorize 洋葱（保留单一职责分层）
  PathResolve(-5) → PolicyEvaluator(0) → OperationClassifier(10) → TrustClassifier(15) → PermissionMatcher(20)
        │realpath        │bypassImmune底线   │纯影响→requiresConfirmation │算 trustLevel    │查 PermissionStore（用户授权+信任沉淀）
        │                │ external/critical→requiresConfirmation=true                       │命中 allow→requiresConfirmation=false
        ▼
  result：{ allowed, requiresConfirmation, operationClass, matchedPermissionRule, trustLevel }
        │（纯确定性语义，无 steward 概念）

[orchestrator · secure-executor 层，持 ctx.llm + turnContext]
   消费 result：
     requiresConfirmation && external && !matchedPermissionRule && 无 bypassImmune 命中 && ctx.llm?.main  → 触发管家（灰色研判）
     requiresConfirmation && （critical || matchedPermissionRule.confirm || 任一 bypassImmune 命中 || ctx.llm 缺失） → 直接 broker（管家无权 / 不可用）
     !requiresConfirmation                                                          → 直接放行
        ▼
   AISecuritySteward ──► ctx.llm.main（独立 ChatRequest + StewardInput）
        │  userIntent ← turnContext.userIntent(main) / trust.intent(scene) / 顶层用户意图(子 agent)
        │  operation  ← input + result.resolvedPaths（客观事实）；trustLevel ← result.trustLevel
        ├─ safe         → 执行 + ConfirmationTracker.record（喂信任，达阈值沉淀 PermissionStore）
        ├─ needs-confirm→ 复用现有 broker 路径（不重复置 requiresConfirmation）
        └─ escalate     → SecurityBlockError
```

### 2.2 方向与无环
- **core/security 内**：沿用现有洋葱 order，互不回指；`TrustClassifier` 依赖 `resolvedAccess.paths`（PathResolve 已填）、产出 `trustLevel` 供 `PermissionMatcher` 消费。
- **跨包**：`orchestrator`（secure-executor + AISecuritySteward）→ 依赖 core 的 `result` 确定性字段与 `ctx.llm`；**core 不依赖 orchestrator/LLM，无 "steward" 命名**。无管家部署时，`requiresConfirmation` 天然退回直接确认（fail-safe）。
- **复用既有**：`PathGuard.isWithinWorkspace`、`PermissionStore`、`ConfirmationTracker`/`suggestPatterns`、`builtin-rules`、`PathResolveMiddleware`、现有 broker。

## 三、核心模型

```ts
// core/security/types.ts
type TrustContext =
  | { kind: "global" }
  | { kind: "workspace"; dir: string }
  | { kind: "scene"; sceneId: string; intent?: string };  // intent = 用户建场景时写的意图，喂管家做对齐；workdir 不进 trust（scene 信任判断不依赖路径）

type TrustLevel = "global" | "workspace" | "scene";

// SecurityMiddlewareResult 仅新增 trustLevel（core 自身概念，非 orchestrator 泄漏）；
// 灰色研判信号靠现有 requiresConfirmation + operationClass + matchedPermissionRule 组合表达，不新增 needsStewardReview。
interface SecurityMiddlewareResult { /* …现有… */ trustLevel?: TrustLevel; }

// orchestrator/security（管家在编排层，不进 core）
interface StewardInput {
  userIntent?: string;                                  // 可信源：turnContext.userIntent / trust.intent / 顶层用户意图
  operation: { tool: string; resolvedPaths?: string[]; command?: string; hosts?: string[] };  // agent 意图 = 客观事实
  trustLevel: TrustLevel;
}
interface StewardVerdict { decision: "safe" | "needs-confirm" | "escalate"; reason: string; confidence: number; }
```

`SecurityRequest.context` 由 `{ cwd, workspace, sessionType }` 改为 `{ cwd, trust, sessionType }`——裸 `workspace` 字段废弃，目录信息收进 `trust.dir`，消除"位置/信任"耦合。

## 四、OperationClass（回归纯操作影响）

`observe`（只读）/ `internal`（仅本地应用状态 `~/.zhixing`，经 app-state 边界）/ `external`（影响用户文件/外部世界，**文件写、命令、网络一律 external，不看位置**）/ `critical`（不可逆高危）。

**去耦合重构**：`FileSystemClassifier`（classifier.ts:86 读 `context.workspace`）删 workspace 判断，`write/edit → external`；`ShellClassifier` 的 `local-scoped`（npm/cargo/tsc/vitest 等）从 `internal` 改 `external`——它们会跑任意代码/触网，**影响维度上就是 external**。二者从此不读 `context`。

> **正交纪律（不可妥协）**：`npm test` 这类"开发常用但确实是 external"的命令，**绝不**因"工作区内常用"而塞回 internal——那是把信任判断混进影响分类，正是本次要消除的债务。它们的"方便"由**信任维度**解决（§八冷启动）：进入工作场景/workspace 即放宽，常见模式经管家 safe / 用户确认**累计达阈值后沉淀**，之后免管家。未沉淀的模式经管家（管家 safe 自动放、不打扰用户），随使用收敛、非"每次"。

## 五、TrustClassifier（authorize 中间件 order=15，新增）

单一职责：**只算 trustLevel，不决策**。在 `OperationClassifier(10)` 后、`PermissionMatcher(20)` 前。输入 `trust` + `resolvedAccess.paths`（已 realpath），写 `ctx.state.trustLevel` 并透出到 `result.trustLevel`：
- `scene` → `scene`（会话级，不依赖路径）。
- `workspace` → 目标路径全部在 `trust.dir` 内（`PathGuard.isWithinWorkspace`）→ `workspace`，否则 `global`。
- `global` → `global`。
- 多路径取最低；无路径操作（如 bash `npm test`）在 scene 下取 `scene`、否则 `global`——故 main workspace 内的无路径命令是 `global` 级（workspace 是**路径锚**，不锚无路径操作），其便利靠 §八沉淀、而非 per-operation 等级。

## 六、决策分工（沿用现有洋葱，不合并为单一中间件）

决策语义**分散在各单一职责中间件**（保留可独立测试/可插拔），不新建"上帝中间件"：

| 中间件 | order | 职责（本次改动） |
|---|---|---|
| `PolicyEvaluator` | 0 | bypassImmune 禁区 + 用户/内置规则（`deny→block`/`confirm`）。**删规则 `cf-workspace-external-write`**（语义由信任体系吸收）；底线全留 |
| `OperationClassifier` | 10 | 纯影响分类；`external`/`critical → requiresConfirmation=true`（现有逻辑不动） |
| `TrustClassifier` | 15 | 仅算 `trustLevel`（§五） |
| `PermissionMatcher` | 20 | 查 `PermissionStore`（用户授权 + 信任沉淀**同一 store**，按 `origin` 区分、按 `trust` 派生的作用域 key 过滤）。命中 `allow → requiresConfirmation=false` / `deny → block`；**无匹配一律保持 confirm**（移除现状"非交互→block"分支，见下） |
| ~~`Suggestion`~~ | ~~30~~ | **废弃**（职责并入信任机制自动沉淀，§八） |

**决策次序**（由 order + 各层逻辑天然形成，等价"用户 > 机制 > 管家"）：bypassImmune/用户 `deny` 最先拦 → `observe`/`internal` 不置确认即放 → `critical` 置确认且管家无权 → 用户授权/信任沉淀命中即放 → 灰色 `external` 留 `requiresConfirmation` 交管家。**TrustLevel 不直接定结果**，只影响 §八沉淀作用域与 §七研判阈值。

> **会话类型策略移交（关键）**：现状 `PermissionMatcher` 对"无匹配 confirm + 非 interactive"直接 block（permission-matcher.ts:90-105），返回 `allowed=false`。本设计**移除该分支**——否则子 agent（全程 `ci`，loop-runner.ts:276）与非交互场景的灰色 external 会在 core 层 block、**永远到不了编排层管家**（管家在最需要它的自动化路径上形同虚设，正是"声明面 > 生效面"债务重演）。改为：无匹配统一保持 `confirm` 交管家；"非交互无 UI → 拒绝"的语义**下移到 broker**（它本就在非交互 fail-deny）。结果：管家覆盖全路径，非交互安全性不变（critical / 管家降级仍经 broker fail-deny → block），且新增"非交互下管家 safe 放行"的便利。

## 七、AI 安全管家（`orchestrator` · secure-executor 编排层）

- **触发**：管家插在 secure-executor 现有 `requiresConfirmation` 分支（secure-executor.ts:185，走 broker 之前）。条件 = `requiresConfirmation && operationClass==="external" && !matchedPermissionRule && !decision.matchedRules.some(r => r.bypassImmune) && ctx.llm?.main`。**bypassImmune 命中必须排除**——写 `~/.zhixing/` 的 `bi-zhixing-config-write` 是 bypassImmune+confirm，无用户授权规则时 `matchedPermissionRule` 为空，若不排除会被当灰色 external 交管家、**绕过"每次确认"**；`critical` / 用户规则 confirm / `ctx.llm` 缺失同样直接 broker（管家无权或不可用）。因 PermissionMatcher 不再于非交互短路 block（§六），此触发覆盖**全路径**（交互 / 非交互 / 子 agent）。成本只花在灰色地带。
- **球员/裁判隔离**：管家 = 一次**独立 ChatRequest**（`ctx.llm.main`），自带"安全裁判"system prompt，**不带主对话历史/主 agent 中间状态**；只接收结构化 `StewardInput`。独立 ChatRequest 与主 agent LLM 流天然隔离（当前 agent loop 串行；未来若并行工具执行，依赖 provider 支持并发调用，隔离性不变）。
- **输入两源 + 子 agent（守隔离）**：`userIntent` 取 `turnContext.userIntent`（main 当前 turn 用户原话）/ `trust.intent`（scene 建场景时写的意图）/ 顶层用户意图（子 agent，§九）——都是**用户可信源**，非 agent 自述；`operation` 是客观事实（已 realpath 路径/解析命令/网络目标）。
- **判法（不求完美，纠结即上交）**：分析 `userIntent` 与 `operation` 是否对齐 + 有无危险 → `safe`（高置信）放行；纠结/低置信 `needs-confirm` **复用现有 broker 路径**（reason 附给用户，不重复置 `requiresConfirmation`）；`escalate`（识破本质高危）拦或强制确认。
- **强力模型 main 档**：安全研判属高风险判断，用最强模型；成本由 §八闭环降频抵消。
- **TrustLevel 调阈**：scene → safe 门槛低；global → 更易上交。
- **护栏**：① 隔离 + 输入仅可信源与客观事实；② 越不过 PolicyEvaluator 底线——`critical` 与**任何 bypassImmune 命中**（禁区/凭证/`~/.zhixing` 写等，即便 action=confirm、无授权规则）都不归管家、直接 broker（trigger 已排除，见上）；③ 纠结/低置信一律上交；④ LLM 超时/抛错 / **`ctx.llm` 缺失** → 降级为直接确认（只降便利不降安全）；⑤ 裁决入审计、用户控制面可回溯收紧；⑥ 用户确认/规则回喂信任机制（§八）。

## 八、信任机制（扩展 `ConfirmationTracker` + `PermissionStore`）

- **来源（均锚用户意图）**：① 进入场景/指定 workspace（上下文级，由 `trust` 表达）；② 用户确认（`ConfirmationTracker.record`）；③ 管家 `safe`（同一 record，标 `origin:"steward"`）。
- **自动沉淀取代"建议手动"**：现状 `SuggestionMiddleware` + `ConfirmationTracker.shouldSuggest`（达阈值"建议用户去建规则"）的职责被信任机制吸收——`shouldSuggest` 的语义从"是否建议"变为"是否达到自动沉淀阈值"，达阈值直接 `PermissionStore.create` 一条 allow 规则、并提示用户"已记住此类操作（可在 /trust 撤销）"。`SuggestionMiddleware` 废弃，不再有"建议 vs 自动"两套阈值。
- **沉淀调用链**（替代废弃的 SuggestionMiddleware）：secure-executor 在**管家 `safe` 分支**与 **`applyBrokerDecision` 的 `allow-once` 分支**（secure-executor.ts:455-457，该处已持 `pipeline.getPermissionStore()` / `getConfirmationTracker()`）于 `tracker.record` 后立即调 `shouldSuggest` 判阈，达阈值则 `store.create`（标 `origin`）。即把"多次 allow-once / 管家放行"自动升级为持久规则。**`store.create` 前必须排除 `operationClass==="critical"` 与 `result.decision.matchedRules.some(bypassImmune)`**（落实下文底线，与 §七 trigger 排除同源）——否则 bypassImmune confirm（如 `bi-zhixing-config-write`）被多次 allow-once 后会沉淀脏规则；虽 PermissionMatcher(:58-60) 兜底拒绝放行、非安全漏洞，但违反"永不沉淀"且污染规则库。
- **冷启动（解"方便"而不污染影响维度）**：进入工作场景/workspace 即**建立信任上下文**（决定沉淀作用域；scene 整会话放宽、workspace 对其内**路径操作**放宽，bash 等无路径操作按 §五为 `global` 级、靠沉淀）。该上下文内常见的非 critical `external`（如 `npm test`），经管家 safe / 用户确认**累计达阈值**（`ConfirmationTracker`，要求多次验证、防首次误判即固化为永久规则）后沉淀，后续免管家。沉淀前管家 safe 即自动放行（不打扰用户、仅有管家成本）。便利来自**信任维度的沉淀**，`OperationClass` 保持纯净。
- **模式粒度**：`pattern` 由 `suggestPatterns` 给出（bash 取 executable+subcommand、文件取目录模式、网络取 host）；具体粒度策略见待定。
- **作用域绑信任上下文**：pipeline **装配期**从 `trustContext` 派生作用域 key `contextId`（workspace → `workspaceIdFromPath(trust.dir)`、scene → `sceneId`、global → `null`），`PermissionMatcher` 的 `getWorkspaceId` 回调（permission-matcher.ts:35）改为返回它——`trust` 是 per-runtime，无需 per-operation 动态计算。`PermissionStore.match` 的 workspaceId 形参即接收该 key，匹配按当前 `trust` 过滤。
- **来源标记 + 可撤销**：规则标 `origin:"user"|"steward"`，`/trust` 可列/撤销 steward 自动沉淀的。
- **底线**：`critical` 与任何 **bypassImmune 命中**（禁区/凭证/`~/.zhixing` 写）**永不沉淀、永不经管家**（沉淀链与 §七 trigger 同源排除）；粒度不放开到危险变体（防"信任建立攻击"）。

## 九、信任上下文注入与运行期数据流

- **trustContext 注入**（`create-agent-runtime.ts`）：main → `{kind:"workspace",dir:cliWorkspace}` 或 `{kind:"global"}`；工作场景 → `{kind:"scene",sceneId,intent:scene.intent}`（scene 的 `workdir` 仅作 runtime 工具 cwd / `workingDirectory`，**不进 trustContext**——scene 信任判断不依赖路径）。同时注入 `SecurityPipelineOptions.trustContext` 与 secure-executor。
- **userIntent 数据流**：
  - main——`create-agent-runtime` 的 `run()` 已取用 `params.messages` 最后一条**原始用户消息**（现有先例，未经增强），作为 userIntent 随 **per-run 创建的** secure-executor（`turnContext.userIntent`）传给管家。
  - scene——由 `trust.intent` 提供（装配期可得）。
  - 子 agent——沿用**顶层用户意图**：`Task` 工具把 `context.userIntent` 透传给 `runChildAgent`（opts 新增该字段）→ `loop-runner` 的 `createSecureExecuteTool` 补 `turnContext`。子 agent 信任上下文继承父（已共享 pipeline）。**不传**主 LLM 定的子任务文本（那是 agent 意图）。
  - 三源都只取用户可信源，不触主 agent 上下文。

## 十、重构清单（对接点）

| 现有 `文件:符号` | 改动 |
|---|---|
| `core/security/types.ts` `SecurityRequest.context` | `workspace`→`trust:TrustContext`；新增 `TrustLevel`；`SecurityMiddlewareResult` 加 `trustLevel`（**不加 needsStewardReview**） |
| `core/security/classifier.ts` `FileSystemClassifier`(:86)/`ShellClassifier`(local-scoped) | 去 workspace/信任耦合，纯影响（write/edit、local-scoped 均 → external） |
| 新增 `core/security/trust-classifier.ts` | `TrustClassifierMiddleware`(order 15)，只算 trustLevel |
| `core/security/security-pipeline.ts` `OperationClassifierMiddleware`(:119) | 保留；分类去 context 依赖，`external/critical→requiresConfirmation` 不动 |
| `core/security/permission-matcher.ts` `PermissionMatcherMiddleware`(:90-105) + `getWorkspaceId`(:35) | **移除"非交互无匹配→block"分支**（会话策略下移 broker），无匹配统一保持 confirm；`getWorkspaceId` 返回装配期从 `trustContext` 派生的 `contextId`（workspace/scene/null） |
| `core/security/security-pipeline.ts` `SuggestionMiddleware`(:180) + 装配 | **废弃移除**；`SecurityPipelineOptions` 加 `trustContext`；装配插入 TrustClassifier(15)；**不引入 LLM/管家/合并中间件** |
| `core/security/policy-engine.ts` `matchPathOutside`(:204) + `builtin-rules.ts` `cf-workspace-external-write` | 删除（语义并入信任体系）；bypassImmune 全保留 |
| `core/security/confirmation-tracker.ts` / `permission-store.ts` | `shouldSuggest` 语义改为"达自动沉淀阈值"；record 加 `origin`；沉淀规则带上下文标识 |
| `core/security/security-auditor.ts`(:108) | withinWorkspace 改读 `trust`；加管家裁决审计事件 |
| `core/workscene/types.ts` `WorkScene`(:14) + `registry.add`(:37) | 新增 `intent?:string`（建场景时填，进 meta） |
| `core/types/tools.ts` `TurnContext` | 新增 `userIntent?:string`；`create-agent-runtime` `run()` 取 `params.messages` 末条原始用户消息填入（per-run 随 secure-executor 传入） |
| `orchestrator/.../secure-executor.ts`(:185 confirm 分支) | 触发管家（trigger 排除 **bypassImmune 命中** + `ctx.llm?.main` 缺失）→ 三态分流（needs-confirm 复用现有 broker:247）；管家 safe / allow-once(:455) 分支 `record→shouldSuggest→store.create` 自动沉淀 |
| 新增 `orchestrator/.../ai-steward.ts` | `AISecuritySteward` + `StewardInput`/`StewardVerdict` + 裁判 prompt |
| `orchestrator/.../loop-runner.ts`(:272) + `subagent/factory.ts` `RunChildAgentOptions` + `Task` 工具 | 透传顶层 userIntent 到子 agent 的 secure-executor |
| `orchestrator/.../create-agent-runtime.ts` | 注入 `trustContext`（含 scene.intent） |
| `cli/security/commands.ts` `/trust` | 按 origin 展示/撤销 steward 自动沉淀规则 |

## 十一、测试拓扑

- **TrustClassifier（单测）**：global/workspace(内/外/多路径越界)/scene(有/无目录)→等级；symlink workspace 复用 isWithinWorkspace 回归。
- **各中间件保持独立可测**：OperationClassifier 纯影响（不依赖 context）；PermissionMatcher 信任沉淀命中/未命中；废弃 Suggestion 后无悬空。
- **决策组合**：用户 deny>沉淀命中>灰色 external 置 requiresConfirmation；observe/internal 放、critical 置确认；**core 全程不触 LLM、result 无 steward 字段**。
- **AISecuritySteward（secure-executor 层）**：mock ctx.llm 验三态分流；触发条件（external+requiresConfirmation+无规则 才触发，critical 直接 broker）；超时/抛错→降级确认；escalate 越不过底线；隔离（输入仅 userIntent+operation）；userIntent 三源（main/scene/子 agent）取值正确。
- **信任机制闭环**：用户确认/管家 safe 累计**达阈值**→沉淀（标 origin）→之后免管家→可撤销；冷启动 npm test 达阈值前每次经管家（safe 自动放）、达阈值后免；critical / bypassImmune（含多次 allow-once）永不沉淀。
- **端到端**：scene 内 external 首次研判放行、global 同操作上交；read 指向凭证 symlink 仍 block（底线穿透）；**ci / 子 agent 灰色 external 经管家研判**（safe 放、needs-confirm→broker fail-deny），不再被 PermissionMatcher 提前 block。
- **去耦合回归**：classifier 不再依赖 context；废弃 matchPathOutside/cf-workspace-external-write/SuggestionMiddleware 后无悬空。

## 十二、待定（实现阶段定，不阻塞骨架）

- `suggestPatterns` 各操作类型的**模式粒度**策略（最影响"方便 vs 安全"，需产品拍板）。
- 管家研判结果的缓存粒度（同会话同模式免重复研判）。
- `escalate` 危险模式清单与各 TrustLevel 阈值。
- 沉淀规则跨会话持久化与失效策略（scene 退出后是否保留）。
- 裁判 system prompt 的具体内容（产品 + 安全联合拟定）。
