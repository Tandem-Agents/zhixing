# Tool 权限与基础设施补齐 · 执行规格

> 知行已设计但未完整 wire 起来的工具安全/权限基础设施补齐。当前 8 个 builtin 工具（read / write / edit / glob / grep / bash / schedule / memory）通过 `FileSystemClassifier` / `ShellClassifier` / `Internal` context classifier 获得正确分类——系统当下并未"破"。本规格的目的是**为未来工具（web_fetch / web_search / MCP 接入工具 / 第三方工具等无 context classifier 的新工具）补齐基础设施**：让"声明 boundary → 自动分类 → 权限规则匹配 → 用户决策沉淀"全链路真正可用，避免每个新工具都要在自己内部重新发明权限分级。

**状态**：已落地（M1+M2+M3+M4+§五.7 已实施）
**前置依赖**：S3.6 ✅ + Step 17/20 ✅ + Phase 5 ✅
**位次**：实施路线图作为 Step 21A，先于 Step 21B (WebFetch) 与 Step 21 (子 agent)

---

## 〇.0 概念与背景

> 这一节回答读到这份 spec 时最先冒出来的几个基础问题。不塞进后续技术章节，以免稀释聚焦度。

### 〇.0.1 之前没感觉工具模块有问题，agent 也能正常用工具，这个模块的意义是什么？做了什么？

agent 当前确实"能用"工具——`bash / read / write / edit / glob / grep / schedule / memory` 这 8 个 builtin 工具都正常工作：不报错、不卡死、不会乱授权。这是因为它们**恰好都被现有 context classifier**（`FileSystemClassifier` / `ShellClassifier` / `Internal`）专项接管了，每个 classifier 写死了自己负责的工具的分类逻辑。

问题在于：**这是个特例覆盖，不是通用机制**。当下一个工具加入时（比如 WebFetch / WebSearch / MCP HTTP 工具 / 第三方插件工具）：
- 它没有专属 context classifier
- 它会落到 `BoundaryImpactClassifier` 兜底分类器
- 但这个分类器读的 `ToolBoundaryRegistry` 当前是**空的**（CLI 入口忘了注入）
- 结果新工具被一律标记为 `critical` → 每次调用都触发 confirm，UX 极差

类似的"接口已设计、运行时未连"的断层共有 5 处（详见 §一）。本模块**不动现有工具的行为**——只补这些断层，让"任意未来新工具：声明 boundary → 自动分类 → 权限规则匹配 → 用户决策沉淀"全链路真正可用。

**一句话**：Agent 现在能用 8 个工具是因为**特例侥幸**，不是因为系统通用——本模块把侥幸变成系统。

### 〇.0.2 这个模块的修改是否会影响 CLI / server 的使用？原来的工具是不是都得测试一下？

**对现有 8 个 builtin 工具**：行为不变。
- 它们仍走 context classifier 路径（M1 政策：**不为它们补 boundaries 字段**，避免死代码）
- M3 给 `needsPermission=true` 的工具（write / edit / bash）补 `permissionArgumentKey` 是**显式化既有行为**——bash 的 `command` 提取在 permission-store 内置 extractArgument 中已经硬编码，新声明只是把隐式约定显式化。功能等价。
- M4 加的 builtin scope 与现有 user 规则**两阶段独立匹配**：用户池任一命中 → 完全决定结果，builtin 不参与；用户池空才退回 builtin。已有 user 规则的解析行为完全不变。

**对 CLI / server 启动路径**：影响仅限入口代码（`run-agent.ts`）：
- 创建 `SecurityPipeline` 时多注入两个 option（`toolBoundaryRegistry` + `extractArgument`）
- cli 默认不调用 `registerBuiltinRules`（cli 自身无 builtin 规则）；未来 21B WebFetch /
  子 agent / MCP 等模块各自调 `store.registerBuiltinRules("namespace", rules)`

这些都是**可选 / 缺省安全**的：所有新增字段全部 optional 或带 fallback；ToolDefinition 的 `boundaries` / `permissionArgumentKey` 字段未声明时降级到现有启发式行为。

**测试影响**：
- 现有测试文件应**全绿**——M1+M2+M3+M4 都不改变 ToolExecutionContext 形状，无 mock 改动
- §五.7 端到端验收会新增一个测试覆盖完整链路，验证现有 wiring 真正工作（confirm → tracker 计数 → suggestion → 用户选 always → store 持久化 → 下次自动 allow）
- 老 user 规则反序列化兼容是 M4 验收必加项（验证已存在的 `~/.zhixing/permissions/global.json` 在 PermissionScope 加 "builtin" 后仍能正确加载）

**不需要全量重测原工具**——只在改了 classifier / permission-store 相关测试的地方关注。

### 〇.0.3 这个模块只是补基础设施，不是功能增强对吧？

**是的，本模块对终端用户几乎无可见变化**：
- 8 个现有工具用法不变 / UX 不变
- 没有新工具上线（WebFetch 在 Step 21B，不在本 spec）
- 没有新命令、新必填配置项
- 唯一一处"用户可见"的改动：用户在 confirm 弹窗选"始终允许（本工作区）"后规则会被持久化到 `~/.zhixing/permissions/<workspace>.json`，下次同操作自动允许——但这是 confirm-ux 设计文档**老早就该工作的语义**，本模块只是补完 wiring 让它真正生效（实际上 §4.4 现状盘点显示这条 wiring 大部分已在代码里，§五.7 验收阶段就是验证它整体工作）

**收益面向未来新工具**：
- WebFetch 接入时只要声明 `boundaries: [{network, egress}]` + `permissionArgumentKey: "url"`，自动获得正确分类 / preapproved 域名规则
- 子 agent / BackgroundAgent / 第二通道 / MCP HTTP / OpenAI 兼容端点等 follow-up 工作都复用同一套基础设施，不重复造轮子

**一句话**：用户无感知、未来工具大受益。本模块是**技术债务清理 + 基础设施加固**，不是产品功能。

> **关于 ToolExecutionContext.llm 字段**：本规格不引入 LLM capability injection——`ToolExecutionContext` 的 LLM 角色注入由独立 spec [`secondary-llm-capability.md`](secondary-llm-capability.md) 提供（Step 21B M0 实施）。本规格 scope 严格收敛在权限 / 边界 / 确认基础设施。

---

## 〇、触发与驱动

本规格的**直接驱动**是 Step 21B WebFetch 工具（见 [tools-builtin.md](tools-builtin.md)）。WebFetch 是首个无 context classifier 的新工具（network/egress 边界），暴露了 zhixing 安全管线"接口已定义但运行时未连"的全部 5 处真实缺口（详见 §一）。

**成本/收益判断**：
- 若 WebFetch / 后续无 context classifier 的新工具（web_search / MCP HTTP / 第三方工具）**确认要做** → 本规格是必经之路（每个新工具自己重做权限分级 = 碎片化债务，单方案补齐 = 一次到位）
- 若所有新工具都恰好能落进既有 context classifier 路径（FS / Shell / Internal）→ 本规格是 YAGNI

**当前判断**：WebFetch 在 implementation-roadmap 中明确排期为 P1（21B），且未来还有 web_search / MCP HTTP / 钉钉企微 webhook / OpenAI 兼容端点等多个网络出口型新工具排队 → 本规格的投入是**有方向、有 consumer 的基础设施补齐**，不是 YAGNI。

---

## 一、问题陈述

zhixing 安全管线（SecurityPipeline / OperationClassifier / PermissionStore / ConfirmationBroker / ConfirmationTracker）已设计完整。**当前 8 个 builtin 工具均有 context classifier 接管，分类正确**。但**面向未来工具的基础设施有 5 处"接口已定义、运行时未连"的关键断层**——必须先补齐才能引入下一批新工具，否则每个新工具都会在自己内部重做权限分级，最终碎片化。

### 缺口 1：`ToolBoundaryRegistry` 已声明但未注入

- 接口存在：`security/types.ts:92-94`；消费者 `BoundaryImpactClassifier` 已写好（`classifier.ts:302-323`）
- CLI 入口（`run-agent.ts:238-243`）调 `createDefaultClassifier({})` 不传 `toolBoundaryRegistry`，fallback 到 `EMPTY_BOUNDARY_REGISTRY`（`classifier.ts:373`）
- 现有 8 工具不受影响（context classifier 优先），但**任何无 context classifier 的新工具会被分类为 `critical`**（`classifier.ts:308-309` fail-closed）
- 结果：新工具触发频繁 confirm，SecurityPipeline 无法按"操作影响"分流

### 缺口 2：`ToolDefinition.boundaries` 字段不存在

- ToolDefinition（`types/tools.ts:204-230`）只有 `isReadOnly / isParallelSafe / needsPermission / maxResultChars` 4 个安全相关属性，**无 boundaries 声明位**
- 即便 wire 上 registry，工具也无处申明边界
- BoundaryCrossing 类型（`security/types.ts:69-84`）独立存在，缺一个连接点

### 缺口 3：`PermissionStore.extractArgument` 隐式优先列表脆弱

- `extractArgument`（`permission-store.ts:381-399`）priority list = `["path", "file_path", "target", "destination"]`，fallback `Object.values(args)` 第一个 string
- 多 string 字段工具（如未来 `web_fetch { url, prompt? }`、`web_search { query, allowed_domains? }`、`http_request { method, url }`）若 LLM 传参顺序与字母序不一致 → 命中错误字段
- 缺**工具级别的"权限匹配字段"显式声明**

### 缺口 4：`PermissionStore` 缺 builtin defaults 机制

- `PermissionScope = "session" | "workspace" | "global"`（`security/types.ts:120`）三态都对应**用户授权语义**
- `create(workspaceId, rule)` 是唯一入口，`scope: "global"` 直接落盘 `~/.zhixing/permissions/global.json`
- 系统预置规则（如未来 web_fetch preapproved 域名 allow）若走此路径：每次启动重复落盘 / 用户无法删除 / 无系统 vs 用户区分
- 缺**"代码定义、不持久化、低优先级"的规则层**

### 缺口 5：`ConfirmationTracker` → `PermissionRule` 创建链路（**大部分已实现**）

代码实测后发现现有 wiring 比之前评估的成熟：
- `SuggestionMiddleware`（`security-pipeline.ts:182-209`）已注册 authorize phase order=30，**已正确**调 `tracker.shouldSuggest(ctx.request, current.riskLevel)` 填 `ctx.state.suggestion`，并在 result 组装时（行 424）透传到 SecurityMiddlewareResult.suggestion
- `request-builder.ts:301` 已透传 `result.suggestion` 到 `ConfirmationRequest.suggestion`（不需要改）
- `TerminalRenderer.translate()`（`terminal-renderer.ts:237-305`）已完整把用户选中的 ConfirmationOption 翻译为 ConfirmationDecision，覆盖 allow-session/workspace/global/always-ask/allow-once/deny/deny-with-reason 全部分支
- `secure-executor.ts:566-622` 的 `applyBrokerDecision` 已正确派生 scope，调 `store.create(workspaceId, { pattern: decision.pattern.pattern, decision: "allow", scope, ... })`
- `secure-executor.ts:610` 在 **allow-\* 系列 kind 完成时**调 `tracker.record(request, riskLevel)` 累计（含 allow-once）；**deny 路径直接抛 SecurityBlockError 不进 applyBrokerDecision，不调 tracker.record**——合理设计（被拒操作不沉淀进"建议加规则"的累计语义）
- `SecurityPipelineOptions.confirmationTracker?: IConfirmationTracker` 已存在（`security-pipeline.ts:213-245`）；pipeline 内部默认实例化（行 282）
- `pipeline.getPermissionStore()` + `pipeline.getConfirmationTracker()` getter 已存在，secure-executor 通过它们取实例

**真实剩余工作**：
- 远程确认（gateway 通道）的"始终允许"语义：当前 InboundRouter 仅识别 yes/no 类词集；如要让用户在飞书等通道也能选"始终允许"，需扩 InboundRouter 词集匹配（识别"加规则 / 始终允许"等关键词→ 转 allow-workspace 等 kind）。**这是独立工作**，不在本 spec 范围内（remote-confirmation 后续增量）。
- run-agent.ts / serve 入口可选地显式传入 `confirmationTracker` 实例（当前是 pipeline 内部默认，per-session 实例已是合理生命周期，可不改）。

---

## 二、设计原则

1. **完成度优先，不留死代码 / 半成品**：每条新接口必须端到端 wire 通；每条已有但未连的接口要么连上要么删除
2. **boundaries 与 context classifier 二选一**：每个工具走其中一条路径，不在工具上叠加冗余声明（见 ADR-TPE-006）
3. **工具自带声明 ≥ 外部配置**：boundaries / permissionArgumentKey 放 ToolDefinition（cohesion）
4. **builtin defaults 不写用户磁盘**：系统预置规则是代码不是数据；用户磁盘只存用户决定
5. **匹配优先级两阶段**：用户池任一命中 → 仅按用户池 resolve；用户池空 → builtin 池 resolve（user 严格优先）
6. **依赖注入而非穿透**：PermissionStore 不持有 tools 列表；通过注入 `extractArgument` 函数让 caller（持有 tools）自由组装

---

## 三、架构变更总览

```
┌─ packages/core/src/types/tools.ts ───────────────┐
│  ToolDefinition                                  │
│    + boundaries?: BoundaryCrossing[]            ← M1
│    + permissionArgumentKey?: string             ← M3
└──────────────────────────────────────────────────┘

┌─ packages/core/src/security/ ────────────────────┐
│  types.ts                                        │
│    PermissionScope                              │
│      + "builtin"                                ← M4
│    IPermissionStore                             │
│      （无新增方法——registerBuiltinRules 是      │
│        PermissionStore 类自有能力，不污染契约）  │
│    + MutableToolBoundaryRegistry                ← R5
│      extends ToolBoundaryRegistry，加 register/  │
│      unregister/list；caller 持有此接口         │
│    + IToolArgumentExtractor                     ← R5
│      接口定义 extract/register/unregister/list  │
│  permission-store.ts                             │
│    PermissionStoreOptions                       │
│      + extractArgument?: (req) => string        ← M3 (DI)
│    PermissionStore（类自有 API）                 │
│      + registerBuiltinRules(ns, rules)          ← M4 (拒空数组 throw)
│      + unregisterBuiltinRules(ns)               ← M4 (幂等，显式卸载)
│      + listBuiltinNamespaces() / getBuiltinRules(ns) ← 调试 API
│    match(): 改为两阶段（user pool 先 / builtin 后）← M4
│    resetAll(): 不清 builtin（boot-time 系统配置） ← M4
│    sanitizeRules(): 拒绝磁盘上的 builtin scope   ← M4
│  classifier.ts                                  │
│    （无变更）                                    │
│  + boundary-registry.ts (新文件)                 │
│    + class BoundaryRegistry                     ← M2
│      implements MutableToolBoundaryRegistry     │
│      static fromTools(tools): BoundaryRegistry  │
│      register/unregister/list/getBoundaries     │
│      （所有数据 in/out 单元素深拷贝防 mutate 污染）│
│  + tool-aware-extractor.ts (新文件)              │
│    + class ToolArgumentExtractor                ← M3
│      implements IToolArgumentExtractor          │
│      static fromTools(tools): ToolArgumentExtractor│
│      register/unregister/list/extract            │
│  confirmation-tracker.ts                        │
│    （无类型变更，被新流程读取）                   │
└──────────────────────────────────────────────────┘

┌─ packages/core/src/confirmation/types.ts ────────┐
│  （**无变更**——现有 ConfirmationDecision /        │
│   ConfirmationOption 的 discriminated union     │
│   已完整表达 allow-session/workspace/global +    │
│   pattern：M5 不新增 rememberAs 字段）           │
└──────────────────────────────────────────────────┘

┌─ packages/core/src/security/security-pipeline.ts ┐
│  （**已实现** SuggestionMiddleware 行 182-209；   │
│   ctx.state.suggestion → result.suggestion 透传  │
│   行 424；SecurityPipelineOptions.confirmationTracker │
│   已就绪行 213-245；getPermissionStore/getConfirmationTracker │
│   getter 已暴露）                                │
│  M5 真实改动：无（除非可选地显式注入 tracker）    │
└──────────────────────────────────────────────────┘

┌─ packages/cli/src/secure-executor.ts ────────────┐
│  （**已实现** applyBrokerDecision 行 566-622：    │
│   派生 scope + store.create；tracker.record       │
│   行 610）                                       │
│  本规格**无新增**                                │
└──────────────────────────────────────────────────┘

┌─ packages/cli/src/run-agent.ts (CLI 入口) ────────┐
│  + boundaryRegistry: MutableToolBoundaryRegistry │
│    = BoundaryRegistry.fromTools(tools)          ← M2 + R5
│    注入 SecurityPipelineOptions.toolBoundaryRegistry│
│  + toolArgumentExtractor: IToolArgumentExtractor │
│    = ToolArgumentExtractor.fromTools(tools)     ← M3 + R5
│    用 (req) => extractor.extract(req) 函数桥接    │
│    注入 PermissionStoreOptions.extractArgument    │
│  cli 默认不调 registerBuiltinRules——space 留给     │
│  21B WebFetch / 子 agent / MCP 等独立模块各自注入 │
│  （ConfirmationTracker 已由 pipeline 内部默认创建， │
│   无需显式注入；可选项）                          │
│  caller 持有**接口类型**（R5），未来 swap 实现     │
│  （immutable / observable / 远程同步）零成本      │
└──────────────────────────────────────────────────┘

┌─ packages/server/src/runtime/ (serve 入口) ──────┐
│  serve 走 CLI runtime，无独立 SecurityPipeline   │
│  创建点 —— wiring 自动透传                       │
└──────────────────────────────────────────────────┘

┌─ packages/cli/src/security/request-builder.ts ──┐
│  （**无变更**——已透传 result.suggestion 到       │
│   ConfirmationRequest.suggestion 行 301）        │
└──────────────────────────────────────────────────┘

┌─ packages/cli/src/security/terminal-renderer.ts ─┐
│  （**无变更**——translate() 行 237-305 已完整覆盖 │
│   allow-session/workspace/global/always-ask/    │
│   allow-once/deny/deny-with-reason 全分支）       │
└──────────────────────────────────────────────────┘

┌─ packages/server/src/confirmation/text-renderer.ts ┐
│  （**无变更**——TextRenderer 走"send 文本+InboundRouter │
│   词集匹配"路径，不需要 option→decision translate；  │
│   "始终允许"远程语义属于 remote-confirmation 后续 │
│   增量，不在本 spec）                            │
└──────────────────────────────────────────────────┘

┌─ packages/tools-builtin/src/ ────────────────────┐
│  各工具补 permissionArgumentKey（仅 needsPermission=true 的工具）  ← M3
│  现有 8 工具均不补 boundaries（context classifier 已接管）        ← M1
└──────────────────────────────────────────────────┘
```

---

## 四、核心设计

### 4.1 ToolDefinition.boundaries 与 boundary registry（M1 + M2）

```typescript
// types/tools.ts
interface ToolDefinition {
  // ... 现有字段
  /**
   * 此工具跨越的安全边界。
   *
   * **何时声明**：仅当本工具**没有专属 context classifier**（FS / Shell / Internal）时才需要。
   * 现有 8 个 builtin 工具均有 context classifier，**不应**声明 boundaries（声明也会被
   * CompositeClassifier 优先级跳过，是死代码）。
   *
   * **何时必须声明**：未来引入的、CompositeClassifier.contextClassifiers 中未注册的工具
   * （如 web_fetch / web_search / MCP HTTP 工具 / 第三方工具）必须声明，否则会被
   * BoundaryImpactClassifier 分类为 critical（fail-closed）。
   */
  boundaries?: BoundaryCrossing[];
}
```

**BoundaryRegistry 类**（新建 `packages/core/src/security/boundary-registry.ts`）：

设计为**可演进的 mutable class**——既支持当前的"启动时 snapshot"模式（`fromTools`），又预留"runtime register / unregister"API 给未来 MCP / 插件 / 子 agent 等动态接入路径，避免 dynamic 工具加载时 breaking。implements `ToolBoundaryRegistry` (read-only) 接口让消费方（`BoundaryImpactClassifier`）契约不变（LSP 安全）。

```typescript
export class BoundaryRegistry implements ToolBoundaryRegistry {
  private readonly map = new Map<string, BoundaryCrossing[]>();

  /** 启动时 snapshot：从工具列表批量构造 */
  static fromTools(tools: readonly ToolDefinition[]): BoundaryRegistry {
    const reg = new BoundaryRegistry();
    for (const tool of tools) {
      if (tool.boundaries?.length) reg.register(tool.name, tool.boundaries);
    }
    return reg;
  }

  /** 注册（或覆盖）单工具的边界声明。空数组 = unregister */
  register(toolName: string, boundaries: readonly BoundaryCrossing[]): void { ... }
  unregister(toolName: string): void { ... }
  getBoundaries(toolName: string): BoundaryCrossing[] | undefined { ... }
  list(): string[] { ... }  // 调试
}
```

**入口注入**（CLI `run-agent.ts`）：

```typescript
const boundaryRegistry = BoundaryRegistry.fromTools(tools);
const securityPipeline = new SecurityPipeline({
  // ... 现有 options
  toolBoundaryRegistry: boundaryRegistry,
});
// 未来 MCP 接入：boundaryRegistry.register("mcp_tool", [...])
// pipeline 内部转给 createDefaultClassifier({ registry: options.toolBoundaryRegistry })
```

MVP 阶段 registry 实际是空的（现有 8 工具不声明），但**链路已通**——下一批新工具加进 tools 列表或通过 register 动态注入后立即生效。

### 4.2 permissionArgumentKey 与 tool-aware extractor（M3）

**问题**：PermissionStore 当前 extractArgument 隐式启发式（priority list + first string）对多 string 字段工具不可靠。**架构断层**：PermissionStore 不持有 tools 列表，无路径直接读 ToolDefinition。

**方案**：依赖注入。PermissionStore 接受可选的 `extractArgument` 函数，由调用方（持有 tools 列表）提供 tool-aware 版本。

```typescript
// types/tools.ts
interface ToolDefinition {
  // ...
  /**
   * 权限规则匹配时使用哪个输入字段作为 "argument"。
   * 若未声明，PermissionStore 降级到内置启发式（priority list + first string fallback）。
   * 推荐每个 needsPermission=true 的工具显式声明，避免依赖隐式约定。
   */
  permissionArgumentKey?: string;
}

// security/permission-store.ts
export interface PermissionStoreOptions {
  rootDir?: string | null;
  now?: () => number;
  /**
   * 自定义参数提取器。
   * - 默认（未注入）：使用内置启发式 priority list（path / file_path / target / destination → first string）
   * - 生产环境（CLI / serve 入口）应注入 `createToolAwareExtractor(tools)` 以读取每工具的 permissionArgumentKey
   */
  extractArgument?: (request: SecurityRequest) => string;
}
```

**ToolArgumentExtractor 类**（新建 `packages/core/src/security/tool-aware-extractor.ts`）：

设计为**可演进的 mutable class**（与 `BoundaryRegistry` 对偶）。函数式 `(req) => string` 契约保留在 `PermissionStoreOptions.extractArgument` 入口；class 仅是内部实现，由 caller 用 `(req) => extractor.extract(req)` 桥接：

```typescript
export class ToolArgumentExtractor {
  private readonly keys = new Map<string, string>();

  /** 启动时 snapshot：从工具列表批量构造 */
  static fromTools(tools: readonly ToolDefinition[]): ToolArgumentExtractor {
    const ext = new ToolArgumentExtractor();
    for (const tool of tools) {
      if (tool.permissionArgumentKey) ext.register(tool.name, tool.permissionArgumentKey);
    }
    return ext;
  }

  register(toolName: string, key: string): void { ... }   // 拒绝空 key
  unregister(toolName: string): void { ... }
  list(): string[] { ... }   // 调试

  extract(request: SecurityRequest): string {
    const explicitKey = this.keys.get(request.tool.toLowerCase());
    if (explicitKey) {
      const val = request.arguments[explicitKey];
      if (typeof val === "string") return val;
    }
    return defaultExtractArgument(request);  // 内部 fallback，不对外导出
  }
}
```

**store 端**：原私有 `extractArgument` 方法已删除，改用 `PermissionStoreOptions.extractArgument` 注入；未注入时降级到 `defaultExtractArgument`（仅同包内部可见，不从 `core/security/index.ts` 导出，避免外部 caller 误用绕过 tool-aware 路径）。

**`defaultExtractArgument` 行为**（M3+D3 后无 bash 特例）：priority list `path / file_path / target / destination` → 第一个 string 字段 fallback。bash 走 fallback 时第一字段就是 `command`（schema 决定），行为兼容；M3 后 bash 显式声明 `permissionArgumentKey: "command"` 走 explicit key 路径，根本不到 fallback——避免了"两条路径输出不同"的双源 truth 风险。

**各工具声明前置条件**：**仅** `needsPermission: true` 的工具才需要补 permissionArgumentKey 声明。`needsPermission: false` 的工具（glob / grep 等）不进权限匹配链路，声明会成死代码。

**实施落地**（spike 后权威清单 + 后续工具规划）：

| 工具 | needsPermission | permissionArgumentKey | 说明 |
|------|----------------|----------------------|------|
| bash | true | `"command"` | 已显式声明（M3）—— 解决了 fallback 中 bash 特例的双源 truth 问题，特例已删 |
| edit | true | `"path"` | 已显式声明（M3） |
| write | true | `"path"` | 已显式声明（M3） |
| read / glob / grep / schedule / memory | **false** | — | 不声明（needsPermission=false，不进入权限匹配链路）|
| 未来 web_fetch | true | `"url"` | 21B 接入时声明 |
| 未来 web_search | true | `"query"` | |
| 未来 http_request | true | `"url"` | |

### 4.3 PermissionScope "builtin" + 用户池兜底分支（M4）

```typescript
// security/types.ts
export type PermissionScope = "session" | "workspace" | "global" | "builtin";

// IPermissionStore 接口**不**含 registerBuiltinRules——
// builtin 规则池是 PermissionStore 类的具体能力，不属于通用"权限存储"契约。
// caller (cli run-agent) 持有 `new PermissionStore(...)` 具体类实例直接调用。

// security/permission-store.ts (PermissionStore 类自有 API)
class PermissionStore {
  /**
   * 注册某个 namespace 的 builtin 规则（in-memory，不持久化）。
   *
   * - 多源支持：每个独立模块（cli/web_fetch/subagent/MCP）使用唯一 namespace
   * - 同 namespace 重复调用：替换该 namespace 的规则集（不影响其他 ns）
   * - 不同 namespace：独立累加
   * - 空数组：删除该 namespace
   * - 严格契约：rules 中 scope 必须为 "builtin"，否则 throw（fail-fast 不静默修正）
   * - 生命周期：不被 resetAll 清除（boot-time 系统配置）
   */
  registerBuiltinRules(namespace: string, rules: PermissionRule[]): void;

  /** 调试 / 可观测性 */
  listBuiltinNamespaces(): string[];
  getBuiltinRules(namespace: string): PermissionRule[];
}
```

**关键认知**：现有 `match` 实现已经是"收集 session + workspace + global 所有 candidates → resolveConflict"的形态；M4 **不重构** match 主体，**只在用户池空时增加 builtin 池兜底分支**（遍历所有 namespace 收集）。改动局部化。

```typescript
// 改动前（现有）：
match(workspaceId, request): PermissionRule | null {
  const candidates: PermissionRule[] = [];
  // 收集 session / workspace / global
  if (candidates.length === 0) return null;
  return this.resolveConflict(candidates);
}

// 改动后（M4）：
match(workspaceId, request): PermissionRule | null {
  // 用户池：session / workspace / global（现有逻辑不变，仅变量重命名）
  const userCandidates: PermissionRule[] = [];
  // 收集 session / workspace / global → userCandidates
  if (userCandidates.length > 0) {
    return this.resolveConflict(userCandidates);  // 现有 deny-wins + globSpecificity
  }
  // 新增：builtin 池兜底（仅在用户池空时进入）
  const builtinCandidates = this.collectBuiltinMatches(request);
  if (builtinCandidates.length > 0) {
    return this.resolveConflict(builtinCandidates);
  }
  return null;
}
```

**语义保证**：用户池任一命中 → 完全按用户池 resolveConflict（builtin 不参与）；用户池空 → builtin 池接管。这避免了 user 通配 deny 被 builtin 高特异性 allow 绕过的反直觉场景。

`resolveConflict` / `globSpecificity` 不变，仅调用范围变化。

**ADR-TPE-008** 详述此选择见 §六。

### 4.4 Confirmation → PermissionRule UX 链路（**已大部分实现**）

**重大发现**：本 spec 设计的整条 wiring 链路**已经在代码里完整实现**。M5 实际剩余工作量极少。

**已实现部分**（代码逐行核实）：

| 组件 | 现状 | 文件位置 |
|------|------|----------|
| ConfirmationOption / ConfirmationDecision discriminated union | 完整。allow-session/workspace/global/always-ask 携带 `pattern: SuggestedPattern`；allow-once/deny/edit-then-allow/expired/cancelled 不携带 | `confirmation/types.ts` |
| `SuggestionMiddleware` | **已实现**：authorize phase / order=30，仅在 `ctx.state.decision.action === "confirm"` 且无 bypassImmune 规则时调 `tracker.shouldSuggest(ctx.request, current.riskLevel)`，把返回值（且 status.suggest=true 时）赋 `ctx.state.suggestion` | `security-pipeline.ts:182-209` |
| ctx.state.suggestion → result.suggestion 透传 | **已实现** | `security-pipeline.ts:424` |
| request.suggestion 透传到 ConfirmationRequest | **已实现** | `request-builder.ts:301` |
| TerminalRenderer.translate() | **已完整覆盖** ConfirmationOption.kind 全部分支（allow-session/workspace/global/always-ask/allow-once/deny/deny-with-reason），正确翻译为 ConfirmationDecision（如 deny-with-reason → `{ kind: "deny", reason }`，allow-session → `{ kind: "allow-session", pattern }`） | `terminal-renderer.ts:237-305` |
| `applyBrokerDecision` 派生 scope + 调 store.create | **已实现**：处理 allow-session/workspace/global/always-ask 4 个 kind，调 `pipeline.getPermissionStore().create(workspaceId, PermissionStore.createRule({ pattern: decision.pattern.pattern, decision: "allow", scope }))`。注：`scope` 已隐含规则来源（builtin scope = 系统预置，其他 = 用户授权），**不需要额外的 `source` 字段**——PermissionRule 接口本就没有 source | `secure-executor.ts:566-622` |
| tracker.record() | **已实现**：在 applyBrokerDecision 路径调 `pipeline.getConfirmationTracker().record(request, riskLevel)`；riskLevel 从 `result.decision?.riskLevel ?? "medium"` 取（**SecurityDecision.riskLevel**，pipeline 输出，**非** ConfirmationDecision）。**仅 allow-\* 系列 kind（含 allow-once）调用**——deny 路径直接抛 SecurityBlockError，不进 record（语义合理：被拒不沉淀） | `secure-executor.ts:610` |
| SecurityPipeline 持有 + 暴露 tracker / store | **已实现**：`SecurityPipelineOptions.confirmationTracker?: IConfirmationTracker` 存在（行 213-245）；pipeline 内部默认实例化（行 282）；`getPermissionStore()` / `getConfirmationTracker()` getter 已暴露 | `security-pipeline.ts:213-282` |

**真实剩余工作**（M5 最小化范围）：

| # | 工作 | 必要性 |
|---|------|--------|
| 1 | run-agent.ts / serve 入口可选地显式传 `confirmationTracker` 实例到 SecurityPipeline 构造器 | 可选——pipeline 已默认实例化，per-session 生命周期合理 |
| 2 | 端到端集成测：连续 N 次 confirm 同操作 → tracker 计数 → 第 N+1 次 ConfirmationRequest.suggestion.suggest === true → 用户选 allow-workspace → store 中出现新规则 → 同操作再来直接 allow | **必需**——验证现有链路完整工作 |

**远程确认（飞书等通道）的"始终允许"语义**：当前 `text-renderer.ts` 仅发送纯文本消息，用户回复由 `InboundRouter` 词集匹配解析（识别 yes / no / 1 / 2 / 可以 / 拒绝 等）。**TextRenderer 不做 option→decision 翻译**——这与本地 TerminalRenderer 的 select-options 路径机制完全不同。

如要让远程通道用户也能选"始终允许"，应做 **InboundRouter 词集扩展**（识别"加规则 / 始终允许 / 不再问我"等关键词 → 构造 `ConfirmationDecision { kind: "allow-workspace", pattern: ... }`）。**这是独立工作，不在本 spec 范围**——属于 remote-confirmation 后续增量。本 spec M5 只负责本地（TerminalRenderer）路径。

**未来增量（不在本 spec）**：deny 计数 UX——若产品需要"用户连续拒绝同操作 N 次后建议建一条 deny 规则"，需独立给 deny 路径补 tracker.record 调用并扩 SuggestionMiddleware 的 should-suggest 阈值规则。当前不做。

<!-- ToolExecutionContext.llm 的注入由 secondary-llm-capability.md 提供，不在本 spec scope -->

### 4.6 builtin 规则注册接口（M4 实现细节）

每个独立模块在自己模块的入口（或 cli 入口的统一汇总点）调用 `registerBuiltinRules`，使用唯一 namespace 标识：

```typescript
// cli/run-agent.ts —— cli 默认无 builtin 规则，不调用任何 register

// 21B WebFetch 接入：由 web-fetch 模块导出 WEB_FETCH_DEFAULT_RULES 常量
// cli 入口拼接调用（仅在工具实际启用时）：
permissionStore.registerBuiltinRules("web_fetch", WEB_FETCH_DEFAULT_RULES);

// 子 agent / MCP 接入同模式：
permissionStore.registerBuiltinRules("subagent", SUBAGENT_DEFAULT_RULES);
permissionStore.registerBuiltinRules("mcp:linear", LINEAR_MCP_DEFAULT_RULES);

// 显式卸载某 namespace（如 /mcp disconnect linear 时）
permissionStore.unregisterBuiltinRules("mcp:linear");
```

**严格契约**（fail-fast，与 BoundaryRegistry / ToolArgumentExtractor register API 对偶）：
- 每条规则的 `scope` 必须为 `"builtin"`（用 `PermissionStore.createRule({ ..., scope: "builtin" })` 构造）；非 builtin scope throw
- `register` 拒绝空数组 throw——清除应显式调 `unregisterBuiltinRules(ns)`
- `unregisterBuiltinRules` 幂等：未注册的 ns 调用 noop

**生命周期**：
- builtin 规则在内存中保存，**不**写磁盘；用户磁盘文件仅含用户自定
- `resetAll()` **不**清 builtin（boot-time 系统配置不该被 runtime 操作牵连）
- `sanitizeRules` 显式拒绝磁盘上 scope==="builtin" 的规则（防御幽灵规则）

**调试**：
- `store.listBuiltinNamespaces()` 列出已注册的 namespace
- `store.getBuiltinRules(ns)` 列出指定 namespace 的规则（深拷贝，外部 mutate 不影响内部）
- `/security` 命令未来扩展 `--include-builtin` flag 时依赖这两个 API（详见 §十）

---

## 五、Milestone 拆分（4 个实施 + 1 个验收）

实施工作集中在 M1–M4（共 4 个），每个独立可交付。M5 由于"Confirmation → PermissionRule 链路"在代码中已大部分实现（见 §4.4 现状盘点），不构成实施性 milestone，作为本规格的**端到端验收阶段**单列于 §五.7（位于实施 milestone 之后）。

本 spec scope 严格收敛在权限 / 边界 / 确认基础设施。会话级 LLM capability 注入参见 [`secondary-llm-capability.md`](secondary-llm-capability.md)。

### M1：ToolDefinition.boundaries 字段（仅扩展 + 文档）

**范围**：
- `types/tools.ts` 加 `boundaries?: BoundaryCrossing[]` 字段（可选）
- 在 ToolDefinition JSDoc 中明示"何时必须声明 / 何时不应声明"
- **现有 8 个 builtin 工具不修改**（context classifier 已接管，声明会成死代码）

**测试**：
- ToolDefinition 接口测试增加 `boundaries` 字段类型校验
- 不影响 classifier.test.ts（现有工具不声明）

**估工**：0.5h

### M2：BoundaryRegistry 工厂 + 入口注入

**关键现状**：`SecurityPipelineOptions.toolBoundaryRegistry` 字段**已存在**（`security-pipeline.ts:213-245`），pipeline 内部已正确转给 `createDefaultClassifier({ registry: options.toolBoundaryRegistry })`（行 277）。M2 真实剩余只是 1 行 wiring + 工厂 + 测试。

**范围**：
- 新建 `core/security/boundary-registry.ts`：`createBoundaryRegistry(tools)`（~30 行）
- `run-agent.ts:238` 创建 SecurityPipeline 时调 `createBoundaryRegistry(builtinTools)` 并注入 `toolBoundaryRegistry` option
- serve session 创建处同步处理

**验收**：
- 单测：`createBoundaryRegistry([toolWithBoundaries, toolWithout])` 正确返回 registry，`getBoundaries` 命中 / 不命中
- 集成测：CLI 启动后检查 SecurityPipeline 持有的 classifier 能正确响应 `getBoundaries`（用 mock tool 验证 forward-looking 行为）
- 现有 classifier.test.ts 不变（仍用 EMPTY_BOUNDARY_REGISTRY 做单元测试）

**估工**：1.5h（pipeline 选项已就绪，仅缺工厂 + 1 行入口注入 + 测试）

### M3：permissionArgumentKey + tool-aware extractor 注入

**前置 spike**（≤30 分钟，M3 第一步）：grep 各 builtin 工具实现的 `needsPermission` 字段 + inputSchema，得出权威清单"哪些工具需要补 permissionArgumentKey + 字段名是什么"。

**范围**：
- `types/tools.ts` 加 `permissionArgumentKey?: string`
- `permission-store.ts` PermissionStoreOptions 加 `extractArgument?: (request) => string`
- 私有 extractArgument 改为：注入 → 优先用注入；未注入 → 现有启发式
- 新建 `core/security/tool-aware-extractor.ts`：`createToolAwareExtractor(tools)`
- `run-agent.ts` + serve 入口：构建 extractor 注入 PermissionStore
- 仅给 spike 清单中**确实 needsPermission=true** 的工具补 permissionArgumentKey 声明（按 §4.2 表格形态）

**验收**：
- 单测：`createToolAwareExtractor([{name:"web_fetch", permissionArgumentKey:"url"}])` 对 `{tool: "web_fetch", arguments: {prompt:"x", url:"https://y.com"}}` 返回 `"https://y.com"`（不依赖字段顺序）
- 单测：未声明 permissionArgumentKey 的工具走 fallback 路径（现有行为保持）
- 集成测：完整链路 CLI → secure-executor → store.match 用真实 extractor

**估工**：2.5h（含 spike 30 分钟）

### M4：PermissionScope "builtin" + 用户池兜底分支 + registerBuiltinRules

**范围**：
- `security/types.ts` PermissionScope 加 `"builtin"`
- `permission-store.ts` 加 `builtinRulesByNamespace: Map<string, PermissionRule[]>` 字段 +
  `registerBuiltinRules(ns, rules)` / `unregisterBuiltinRules(ns)` 方法（namespace 多源 +
  fail-fast：拒空数组 throw / 严格 scope=builtin 校验 / 拒非空 namespace）
- match 流程**仅扩展**：现有用户池逻辑保持，仅在用户池空时增加 builtin 池兜底分支
  （遍历所有 namespace 收集 candidates；详见 §4.3）
- cli/serve 入口默认不调 register（cli 自身无规则）；21B WebFetch / 子 agent / MCP 各自调

**关于 PermissionRulePattern 类型抽出**：M5 已确认不再使用 rememberAs 字段（直接复用 ConfirmationDecision 现有 pattern 字段），因此 PermissionRulePattern 抽出**不再是 M4 必需**。store.create 调用方传 `decision.pattern.pattern` 即等于 PermissionRule.pattern 形态（结构等价）。如未来其他模块需要命名类型再抽。

**验收**：
- 单测："用户池任一命中 → builtin 不参与"：注册 builtin allow + 用户 deny 通配 → 结果为 deny
- 单测："用户池为空 → builtin 接管"：注册 builtin allow + 无用户规则 → 结果为 allow
- 单测：跨 namespace deny-wins / globSpecificity（多源平级合并参与 resolveConflict）
- 单测：`registerBuiltinRules` 同 namespace 替换 / 不同 namespace 累加 / 拒空数组 throw / 拒非 builtin scope throw
- 单测：`unregisterBuiltinRules` 显式删除 + 幂等（未注册 ns noop）
- 单测：`resetAll` 不清 builtin（boot-time 系统配置）
- 单测：`sanitizeRules` 拒绝磁盘上 scope==="builtin"（防御幽灵规则）
- 单测：scope=`"builtin"` 不写磁盘（mock 文件系统验证）
- 现有 permission-store.test.ts 全绿（用户池逻辑无变化）

**估工**：2.5h

### 五.7 端到端验收阶段（Confirmation → PermissionRule 链路）

**这不是实施 milestone**——`SuggestionMiddleware` / `applyBrokerDecision` / `tracker.record` / `TerminalRenderer.translate` / `store.create` 全套 wiring **已在代码中实现**（见 §4.4 现状盘点表 + §一缺口 5）。本阶段只做**端到端集成验证**，确保 M2/M3/M4 落地后链路在新基础设施下整体可工作。

**范围**：
- **不修改任何已就绪组件**
- 新增端到端集成测：interactive 场景下连续 N 次 confirm 同操作 → tracker 累积 → 触达阈值后 ConfirmationRequest.suggestion.suggest === true → 用户选 allow-workspace → store 中出现新 PermissionRule → 同操作再次执行直接 allow（不触发 confirm）
- （可选）run-agent.ts / serve 入口显式构造 ConfirmationTracker 实例通过 `confirmationTracker` option 注入 SecurityPipeline——pipeline 默认实例化已可工作，显式注入仅为测试隔离/可观测性

**显式不做**（属于其他 spec / 未来增量）：
- 远程通道（飞书等）"始终允许"语义：当前 TextRenderer 走"send 文本 + InboundRouter 词集匹配"路径，与 TerminalRenderer 的 select-options 路径不同。要支持远程"始终允许"，应是 InboundRouter 词集扩展（识别"加规则 / 始终允许 / 不再问我"等关键词），属于 remote-confirmation 后续工作

**验收**：
- 端到端集成测覆盖 §4.4 现状盘点描述的完整链路
- 现有 secure-executor / SuggestionMiddleware / TerminalRenderer / applyBrokerDecision 单测保持全绿（不破坏现状）

**进入条件**：M2 + M3 + M4 全部完成（M3 让 allow-workspace 落库的 PermissionRule 能在下次匹配时命中正确字段；M4 让 builtin 规则与 user 规则交互逻辑正确）。M1 不阻塞。

---

## 六、决策记录（ADR）

### ADR-TPE-001：boundaries 在 ToolDefinition 上而非外部配置

**决策**：boundaries 字段直接放 ToolDefinition；外部 registry 由工厂从 tool list 自动构建。
**理由**：cohesion——工具的安全特征属于工具自身定义；外部配置易腐化（工具改动时漏改）。
**反对**：略增 ToolDefinition 复杂度；可选字段 + 政策（context classifier 工具不应声明）缓解。

### ADR-TPE-002：builtin scope 不持久化 + namespace 多源注入

**决策**：
1. PermissionScope 加 "builtin"，规则仅 in-memory，启动时由代码注入
2. `registerBuiltinRules(namespace, rules)` + `unregisterBuiltinRules(namespace)` 按 namespace 多源 API：
   - 同 namespace 重复 register = 替换该 namespace 内规则
   - 不同 namespace 独立累加
   - **register 拒空数组 throw**（fail-fast，与 `BoundaryRegistry.register` /
     `ToolArgumentExtractor.register` 拒空对偶）；清除某 namespace 应显式调
     `unregisterBuiltinRules(ns)`，**不混入"注册"语义**
   - `unregisterBuiltinRules` 幂等（未注册的 ns 调用 noop）
   - 严格 scope 校验（非 "builtin" 直接 throw，不静默改写）
3. `resetAll()` 不清 builtin（boot-time 系统配置不被 runtime 操作牵连）
4. `sanitizeRules` 显式拒绝磁盘上 scope==="builtin" 规则（防御幽灵规则）

**理由**：
- 系统预置规则是代码不是数据；用户磁盘只存用户决定；删除/升级时无需迁移文件
- namespace 让多 caller（cli / web_fetch / subagent / MCP）独立注入互不干扰——21B WebFetch 接入即是首个外部 caller
- 严格 scope + 不被 resetAll 牵连区分了"用户 runtime 操作"与"系统 boot-time 配置"两个生命周期范畴
- register 拒空 + 显式 unregister 让"注册"与"注销"两个意图互不相覆盖，三套 register API（builtin rules / boundary / argument key）契约对偶统一

**反对**：略增 match 复杂度（两阶段匹配 + 遍历 namespace）；增加 Map<string, PermissionRule[]> 一层数据结构。

**为什么不在 IPermissionStore 接口上**：builtin 规则池是 PermissionStore 类的具体职责，不属于"权限存储"通用契约。其他实现 / mock 不必负担——caller (cli) 持有具体类直接调用即可（参见 ADR-TPE-009）。

### ADR-TPE-003：permissionArgumentKey 显式 vs 隐式优先列表

**决策**：每工具显式声明 `permissionArgumentKey`，未声明者降级到现有启发式。
**理由**：隐式列表本就脆弱（依赖字段顺序/命名约定），扩展只是扩大脆弱面；显式声明使每工具的权限语义自描述、明确、易审计。

### ADR-TPE-004：confirmation→rule 协调归 secure-executor（追认现状）

**性质**：本条**追认现有代码的架构选择**，不是新决策——`secure-executor.applyBrokerDecision`（行 566-622）已经在生产代码中协调 store.create + tracker.record。spec 把它列为 ADR 是为了给后续维护者一份"为什么是这种结构"的说明，而非要求 M5 实施重新设计。
**决策**：suggestion 由 SecurityPipeline.SuggestionMiddleware 注入；用户选择翻译由 Renderer 完成；最终 store.create + tracker.record 调用归 secure-executor。
**理由**：broker 是纯交互协议层；renderer 只渲染；secure-executor 是中间层协调点（持有 pipeline 引用 + 工具调用编排），是落库与计数累计的天然位置。

### ADR-TPE-006：boundaries 与 context classifier 二选一（不叠加）

**决策**：现有 8 个 builtin 工具均通过 context classifier 接管分类，**不**为它们补 boundaries 声明。boundaries 是 forward-looking 字段，专为未来无 context classifier 的工具准备。
**理由**：CompositeClassifier 优先 contextClassifiers，boundaries 对它们是死代码；保留死代码会让未来读者误信 boundaries 有效力，污染心智模型。
**反对**：缺少"统一所有工具都声明 boundary"的整齐感——但形式整齐 < 语义清晰。

### ADR-TPE-007：extractArgument 通过依赖注入而非穿透 tools

**决策**：PermissionStore 通过 PermissionStoreOptions 接受 `extractArgument` 函数；不在 store 持有 tools 列表。
**备选**：让 store 持有 tools 列表 / 加 ToolPermissionRegistry 类型与 ToolBoundaryRegistry 对偶。
**理由**：cohesion——store 的职责是规则存储与匹配，不是参数提取；extractArgument 是策略而非数据，DI 是表达策略的标准方式；caller（持 tools）天然是策略提供者；无需新增 registry 类型，更少抽象。

### ADR-TPE-008：用户 vs builtin 优先级 = 两阶段匹配（user 严格优先）

**决策**：match 流程为两阶段：用户池（session+workspace+global）任一命中 → 仅按用户池 resolve；用户池空 → builtin 池接管。builtin 池内部遍历所有 namespace 收集 candidates，namespace 间平级（不分优先级），仍走 deny-wins + globSpecificity。
**备选**：把 builtin 池与 global 池合并，按 specificity + deny-wins 统一 resolve。
**理由**：合并方案下，用户的通配 deny（如 `pattern: "*"`）会被 builtin 高特异性 allow 击败，与"用户拥有最终决定权"的产品语义矛盾；两阶段保证用户在自己写过任何相关规则时不被 builtin 干扰。

### ADR-TPE-009：dynamic 工具加载基础设施（接口抽象 + 深拷贝防御 + e2e 守卫）

**决策**：从 tools 列表派生 security 基础设施的两套机制（boundary 注册表 / argument extractor）按以下契约设计：

1. **接口分层**（R5）：
   - `ToolBoundaryRegistry`（read-only）：消费方契约，`BoundaryImpactClassifier` 只看 `getBoundaries`
   - `MutableToolBoundaryRegistry extends ToolBoundaryRegistry`：caller 契约，加 `register / unregister / list`
   - `IToolArgumentExtractor`：caller 契约，含 `extract / register / unregister / list`
   - 具体类 `BoundaryRegistry` / `ToolArgumentExtractor` 实现对应接口；caller (`run-agent.ts`) 类型注解持有**接口而非具体类**——未来 swap 实现（immutable / observable / 远程同步）零成本

2. **静态 + 动态双模式**：
   - **静态启动（当前主用法）**：`BoundaryRegistry.fromTools(tools)` 一次性 snapshot
   - **动态扩展（未来 MCP / 插件 / 子 agent）**：runtime 调 `registry.register(toolName, ...)` 注册新工具——不需要 reconfigure 整个 SecurityPipeline

3. **深拷贝双向防御**（R2）：`BoundaryRegistry` 在 `register` 入站和 `getBoundaries` 出站都对每个 `BoundaryCrossing` 做单元素深拷贝（`{ ...c }`），防止 caller 通过 `boundaries[0].access = "MUTATED"` 等单字段修改污染 registry 内部状态

4. **e2e 测试守卫**（R3）：`boundary-registry.test.ts` 含一组测试从 `SecurityPipeline.evaluate` 顶层观察 `register` / `unregister` 即时反映——守卫"不缓存"承诺。未来若 `BoundaryImpactClassifier` 加缓存优化破坏 dynamic 路径，立即被发现

5. **Fail-fast 严格性 + 注册/注销分离**（Q15 + Q16）：三套 register API 契约对偶：
   - `BoundaryRegistry.register(toolName, [])` → throw；显式 `unregister(toolName)` 幂等
   - `ToolArgumentExtractor.register(toolName, "")` → throw；显式 `unregister(toolName)` 幂等
   - `PermissionStore.registerBuiltinRules(ns, [])` → throw；显式 `unregisterBuiltinRules(ns)` 幂等
   - 让"注册"语义保持纯粹——不混入"注销"等其他操作的 silent transformation
   - "注销"语义对偶幂等（未注册调用 noop），匹配卸载操作的容错预期

**理由**：
- 当前 cli 单一 snapshot 是 MVP，未来 `/mcp connect xyz` / 插件 / 子 agent 注入子工具几乎必然
- 纯函数式 snapshot 工厂在动态化时是 breaking change（消费方契约或注入逻辑必须重写）
- mutable class + 接口抽象在当前不引入复杂度（fromTools 仍是主调用），但保留 register/unregister + 接口替换让未来无缝扩展
- 两套基础设施对偶设计（register/unregister/list 同 vocabulary）统一心智模型

**备选 / 反对**：
- 纯函数式 + 未来需要时再重构：违反"可演进性优先"原则，破坏现有 caller
- callback-based（让 SecurityPipeline 持有 `() => readonly Tool[]` 而非 snapshot）：每次 evaluate 都遍历 tools 计算 → 性能下降；且 caller 反向依赖 pipeline，耦合更紧
- 不暴露接口（caller 直接持类）：未来 swap 实现强制 caller 改导入，违反 OCP

**未来约束**：
- 若需要"读 boundaries 时实时反映 ToolDefinition 变化"（不是注册新工具，而是工具自身 boundaries 字段变了），当前 register/unregister 模型仍需 caller 主动调用——不自动跟踪 ToolDefinition 引用。trade-off：保持 registry 内部状态可控（不被外部 mutate 污染），代价是 caller 责任
- 性能：builtin 池 match 时遍历所有 namespace（O(N\*M)）；当前 N < 5，M < 10，每 tool call 一次开销可忽略。若未来 namespace 极多需要索引化（按 tool name 二级索引）

---

## 七、测试策略

每个 M 包含三类测试：单元、集成、回归。

| M | 单元测试 | 集成测试 | 回归保护 |
|---|---------|---------|---------|
| M1 | ToolDefinition 字段类型 | — | classifier.test.ts 不变 |
| M2 | BoundaryRegistry.fromTools 各分支 + 动态 register/unregister + 单 BoundaryCrossing in/out 深拷贝防 mutate | SecurityPipeline 顶层守卫 register 即时生效（ADR-TPE-009 e2e）| classifier.test.ts EMPTY_BOUNDARY_REGISTRY 路径不变 |
| M3 | ToolArgumentExtractor.fromTools 命中/不命中/fallback + 动态 register/unregister | 端到端 CLI → secure-executor → store.match 用真实 extractor 路径 | permission-store.test.ts 默认 fallback 路径全绿 |
| M4 | 两阶段匹配各 case；registerBuiltinRules namespace 多源 / 严格 scope throw / 空数组删 ns / resetAll 不清 builtin / sanitizeRules 拒绝磁盘 builtin / **跨 namespace deny-wins + globSpecificity** | 启动注入空 builtin 后 store 行为不变 | 现有 permission-store.test.ts（无 builtin 用例）全绿 |
| §五.7 | — | tool-permission-e2e.test.ts 覆盖 confirm→tracker→suggestion→store→自动 allow 完整链路 | 现有 confirmation 测试（无 suggestion 字段消费）全绿 |

**新增集成测试入口**：`packages/cli/src/__tests__/tool-permission-e2e.test.ts`（新建），覆盖 boundary registry → classifier → permission-matcher → confirmation → store.create 完整链路。

**测试基建**：M1–M4 不改变 ToolExecutionContext 形状，无 mock helper 变更。

**测试隔离推荐**：所有 builtin 规则相关单元测试 **per-test 实例化 PermissionStore**，不复用全局实例。`resetAll()` 不清 builtin（ADR-TPE-002），不能用作"完全重置"——每 test 创建新 store 是唯一可靠隔离方式。

**老 user 规则的兼容性**：M4 给 PermissionScope 加 "builtin" 值后，反序列化 `~/.zhixing/permissions/global.json` 的旧 PermissionRule（scope ∈ session/workspace/global）必须保持完整兼容。`sanitizeRules` 白名单仅保留旧 3 态，`builtin` scope 在磁盘上**显式拒绝**（防御幽灵规则，不报错只 skip）。M4 验收单测包含"老 schema 反序列化"+"磁盘上 builtin scope 被拒绝"两个场景。

---

## 八、风险与回滚

| 风险 | 影响 | 缓解 |
|------|------|------|
| M2 注入 toolBoundaryRegistry 后，若误为某些已有 context classifier 的工具补 boundaries，则形成死代码污染 | 低 | M1 政策文档明示"现有 8 工具不补 boundaries"；review 把关 |
| M3 各工具 needsPermission 与 schema 字段名 spec 未预断 | 低 | M3 启动前 spike grep 各工具实现（已纳入 M3 范围）|
| §五.7 端到端测试覆盖不足（confirm 链路是已实现但未端到端测过的代码） | 中 | §五.7 工作就是补这条端到端集成测，不写产品代码；保护现有单测全绿 |
| deny 路径不计入 tracker.record——未来若需"用户连续拒绝建议加 deny 规则"会再补 | 低 | 当前 spec 明示该 UX 为未来增量，不在范围；deny 不沉淀符合"被拒不累计"产品语义 |
| PermissionStore.create 并发安全（多个 confirm 几乎同时 resolve 时） | 中 | 当前 PermissionStore 实现是同步 in-memory 写 + 异步落盘；JS 单线程下两次 create 不会真并发，但 await 落盘期间 in-memory 已可见——多次调用结果是 N 条规则共存，不会丢；幂等性由 globSpecificity 在 match 阶段裁决。M4 验收单测包含"快速连续 create 同 pattern" 场景 |
| 老 config.json 含 PermissionRule.scope 旧 union 值反序列化失败 | 中 | M4 sanitizeRules 必须在加 "builtin" 值后保持旧 3 态向后兼容；测试覆盖（见 §七 测试策略）|

**每个 M 独立可回滚**：所有新增字段 optional 或带 fallback；新方法/新模块独立；删除即恢复旧行为。

---

## 九、与下游的关系

| 下游工作 | 关系 |
|---------|------|
| Step 21B WebFetch | **强依赖**：boundaries 声明（network/egress） / preapproved hosts builtin 规则（namespace="web_fetch"，scope="builtin"） / permissionArgumentKey="url" 依赖本规格。distill 模式由独立的 [二级 LLM 能力](secondary-llm-capability.md) 提供（21B M0），通过 `ctx.llm.secondary` 暴露；graceful degrade 到 raw markdown |
| Step 21 子 agent | 间接受益：子 agent 创建时 sessionType="ci" → SecurityPipeline 自动按 non-interactive 处理 → builtin 规则仍生效，killer use case 通 |
| Step 22 BackgroundAgent | 间接受益：工具权限分级在 background 路径同样需要 |
| 第二通道 / MCP HTTP（未来） | 间接受益：tool 系统更健全，新工具加入更容易 |

实施完成后，**zhixing 工具/权限系统首次进入设计意图的完整工作状态**：
- 任意新工具声明 boundaries → 自动获得正确分类
- 多 string 字段工具的权限规则匹配命中正确字段
- 系统预置规则与用户自定规则清晰分层、用户拥有最终决定权
- 用户能平滑沉淀"始终允许"决策为持久规则

---

## 十、未来工作（不在本规格）

- **`/security` 或 `zhixing permissions list` CLI 命令**展示当前生效规则——user 规则与 builtin 规则**应分组展示**（避免用户混淆"为什么我没创建过的规则在这"）；默认列出 user 规则，加 `--include-builtin` flag 列出全部，调用 `store.listBuiltinNamespaces()` + `store.getBuiltinRules(ns)` 实现
- **MCP 动态工具加载入口**：`/mcp connect` 命令调用 `boundaryRegistry.register(toolName, boundaries)` + `extractor.register(toolName, key)` 把 MCP 暴露的工具接入分类器与权限链路；`/mcp disconnect` 反向调 unregister
- **BoundaryClassifier 的 dynamic 分支**与 ShellClassifier 协同（已有 ShellClassifier 实现，未来与 BoundaryImpactClassifier 协同处理"动态边界"如 bash 命令的 network 调用判断）
- **ToolPermissionRegistry 抽象**（如果未来出现"权限相关元数据"远不止 permissionArgumentKey 一个字段时再抽）
- **deny 计数 UX**：用户连续拒绝同操作 N 次后建议加 deny 规则——需独立给 deny 路径补 tracker.record 调用，并扩 SuggestionMiddleware 阈值规则（区分 allow 累计与 deny 累计）
- **远程通道"始终允许"语义**：扩 InboundRouter 词集匹配，识别"加规则 / 始终允许 / 不再问我"等关键词转 allow-workspace decision；属于 remote-confirmation 后续增量
- **可观测性 / telemetry**：permission 决策路径上结构化事件输出（"工具 X 命中规则 Y / 命中 builtin namespace=Z / 触发 confirm / 用户选 W"），便于调试"为什么 X 工具被自动允许 / 为什么这次又问我"
- **二级 LLM 能力**：见 [`secondary-llm-capability.md`](secondary-llm-capability.md)（Step 21B M0 实施），与本规格的权限基础设施正交。
