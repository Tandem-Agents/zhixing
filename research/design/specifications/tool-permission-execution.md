# Tool 权限与基础设施补齐 · 执行规格

> 知行已设计但未完整 wire 起来的工具安全/权限基础设施补齐。当前 8 个 builtin 工具（read / write / edit / glob / grep / bash / schedule / memory）通过 `FileSystemClassifier` / `ShellClassifier` / `Internal` context classifier 获得正确分类——系统当下并未"破"。本规格的目的是**为未来工具（web_fetch / web_search / MCP 接入工具 / 第三方工具等无 context classifier 的新工具）补齐基础设施**：让"声明 boundary → 自动分类 → 权限规则匹配 → 用户决策沉淀 → 内部 LLM 调用"全链路真正可用，避免每个新工具都要在自己内部重新发明权限分级。

**状态**：v1 待 9 轮架构审查
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

类似的"接口已设计、运行时未连"的断层共有 5 处（详见 §一）。本模块**不动现有工具的行为**——只补这些断层，让"任意未来新工具：声明 boundary → 自动分类 → 权限规则匹配 → 用户决策沉淀 → 内部 LLM 调用"全链路真正可用。

**一句话**：Agent 现在能用 8 个工具是因为**特例侥幸**，不是因为系统通用——本模块把侥幸变成系统。

### 〇.0.2 这个模块的修改是否会影响 CLI / server 的使用？原来的工具是不是都得测试一下？

**对现有 8 个 builtin 工具**：行为不变。
- 它们仍走 context classifier 路径（M1 政策：**不为它们补 boundaries 字段**，避免死代码）
- M3 给 `needsPermission=true` 的工具（write / edit / bash）补 `permissionArgumentKey` 是**显式化既有行为**——bash 的 `command` 提取在 permission-store 内置 extractArgument 中已经硬编码，新声明只是把隐式约定显式化。功能等价。
- M4 加的 builtin scope 与现有 user 规则**两阶段独立匹配**：用户池任一命中 → 完全决定结果，builtin 不参与；用户池空才退回 builtin。已有 user 规则的解析行为完全不变。
- M6 在 `ToolExecutionContext` 加 `llm.cheap` 字段——现有工具不读这个字段，不受影响

**对 CLI / server 启动路径**：影响仅限入口代码（`run-agent.ts` + serve session 各 1 处）：
- 创建 `SecurityPipeline` 时多注入两个 option（`toolBoundaryRegistry` + `extractArgument`）
- 启动后调一次 `store.registerBuiltinRules([])`（MVP 默认空数组）
- 创建 cheap Provider 实例并注入 `ToolExecutionContext`

这些都是**可选 / 缺省安全**的：所有新增字段全部 optional 或带 fallback；老 `config.json` 缺 `llm` 字段直接走默认 cheap model；`ToolExecutionContext.llm` 缺省时不影响"不调 LLM 的工具"。

**测试影响**：
- 现有 152 测试文件应**全绿**（除了 `ToolExecutionContext` mock 创建点要补 `llm` 字段，约 4 处）
- §五.7 端到端验收会新增一个测试覆盖完整链路，验证现有 wiring 真正工作（confirm → tracker 计数 → suggestion → 用户选 always → store 持久化 → 下次自动 allow）
- 老 user 规则反序列化兼容是 M4 验收必加项（验证已存在的 `~/.zhixing/permissions/global.json` 在 PermissionScope 加 "builtin" 后仍能正确加载）

**不需要全量重测原工具**——只在改了 `ToolExecutionContext` / classifier / permission-store 相关测试的地方关注。

### 〇.0.3 这个模块只是补基础设施，不是功能增强对吧？

**是的，本模块对终端用户几乎无可见变化**：
- 8 个现有工具用法不变 / UX 不变
- 没有新工具上线（WebFetch 在 Step 21B，不在本 spec）
- 没有新命令、新必填配置项
- 唯一一处"用户可见"的改动：用户在 confirm 弹窗选"始终允许（本工作区）"后规则会被持久化到 `~/.zhixing/permissions/<workspace>.json`，下次同操作自动允许——但这是 confirm-ux 设计文档**老早就该工作的语义**，本模块只是补完 wiring 让它真正生效（实际上 §4.4 现状盘点显示这条 wiring 大部分已在代码里，§五.7 验收阶段就是验证它整体工作）

**收益面向未来新工具**：
- WebFetch 接入时只要声明 `boundaries: [{network, egress}]` + `permissionArgumentKey: "url"`，自动获得正确分类 / preapproved 域名规则 / cheap LLM distill 能力
- 子 agent / BackgroundAgent / 第二通道 / MCP HTTP / OpenAI 兼容端点等 follow-up 工作都复用同一套基础设施，不重复造轮子

**一句话**：用户无感知、未来工具大受益。本模块是**技术债务清理 + 基础设施加固**，不是产品功能。

---

## 〇、触发与驱动

本规格的**直接驱动**是 [Step 21B WebFetch 工具](../drafts/web-fetch-tool.md)。WebFetch 是首个无 context classifier 的新工具（network/egress 边界），暴露了 zhixing 安全管线"接口已定义但运行时未连"的全部 5 处真实缺口（详见 §一）。

**成本/收益判断**：
- 若 WebFetch / 后续无 context classifier 的新工具（web_search / MCP HTTP / 第三方工具）**确认要做** → 本规格是必经之路（每个新工具自己重做权限分级 = 碎片化债务，单方案补齐 = 一次到位）
- 若所有新工具都恰好能落进既有 context classifier 路径（FS / Shell / Internal）→ 本规格是 YAGNI

**当前判断**：WebFetch 在 implementation-roadmap 中明确排期为 P1（21B），且未来还有 web_search / MCP HTTP / 钉钉企微 webhook / OpenAI 兼容端点等多个网络出口型新工具排队 → 本规格的投入是**有方向、有 consumer 的基础设施补齐**，不是 YAGNI。

---

## 一、问题陈述

zhixing 安全管线（SecurityPipeline / OperationClassifier / PermissionStore / ConfirmationBroker / ConfirmationTracker）已设计完整。**当前 8 个 builtin 工具均有 context classifier 接管，分类正确**。但**面向未来工具的基础设施有 6 处"接口已定义、运行时未连"的关键断层**——必须先补齐才能引入下一批新工具，否则每个新工具都会在自己内部重做权限分级，最终碎片化。

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

### 缺口 6：`ToolExecutionContext` 无 LLM 访问

- 当前字段：`workingDirectory / abortSignal / turnId / emissionTarget / commitToUser / turnOrigin` —— 无 LLM
- ZhixingConfig（`packages/providers/src/types.ts`）无 cheap model 概念
- 任何需要工具内部调便宜模型做摘要/分类的功能（未来 WebFetch distill / search 后处理 / 长文件 summarize）当前**无路径**

---

## 二、设计原则

1. **完成度优先，不留死代码 / 半成品**：每条新接口必须端到端 wire 通；每条已有但未连的接口要么连上要么删除
2. **boundaries 与 context classifier 二选一**：每个工具走其中一条路径，不在工具上叠加冗余声明（修订 ADR-TPE-006）
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
│  ToolExecutionContext                           │
│    + llm: { cheap: LLMProvider }                ← M6
└──────────────────────────────────────────────────┘

┌─ packages/core/src/security/ ────────────────────┐
│  types.ts                                        │
│    PermissionScope                              │
│      + "builtin"                                ← M4
│  permission-store.ts                             │
│    PermissionStoreOptions                       │
│      + extractArgument?: ExtractFn              ← M3 (DI)
│    + registerBuiltinRules(rules: PermissionRule[]) ← M4
│    match(): 改为两阶段（user pool 先 / builtin 后）← M4
│  classifier.ts                                  │
│    （无变更）                                    │
│  + boundary-registry.ts (新文件)                 │
│    + createBoundaryRegistry(tools)              ← M2
│  + tool-aware-extractor.ts (新文件)              │
│    + createToolAwareExtractor(tools)            ← M3
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
│  M6 新增：注入 ToolExecutionContext.llm.cheap    ← M6
└──────────────────────────────────────────────────┘

┌─ packages/cli/src/run-agent.ts (CLI 入口) ────────┐
│  + 创建 boundary registry from tools 并注入       │
│    SecurityPipelineOptions.toolBoundaryRegistry  ← M2
│  + 创建 tool-aware extractor from tools 注入      │
│    PermissionStoreOptions.extractArgument        ← M3
│  + 启动时 store.registerBuiltinRules([])        ← M4
│  + 创建 cheap Provider 实例                     ← M6
│  （ConfirmationTracker 已由 pipeline 内部默认创建， │
│   无需显式注入；可选项）                          │
└──────────────────────────────────────────────────┘

┌─ packages/server/src/runtime/ (serve 入口) ──────┐
│  同上 wiring                                    ← M2/M3/M4/M6
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

┌─ packages/providers/src/types.ts (ZhixingConfig) ─┐
│  + llm: { defaultModel?, cheapModel?,            │
│           cheapProviderId? }（top-level）        ← M6
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

**registry 工厂**（新建 `packages/core/src/security/boundary-registry.ts`）：

```typescript
import type { BoundaryCrossing, ToolBoundaryRegistry } from "./types.js";
import type { ToolDefinition } from "../types/tools.js";

export function createBoundaryRegistry(
  tools: readonly ToolDefinition[],
): ToolBoundaryRegistry {
  const map = new Map<string, BoundaryCrossing[]>();
  for (const tool of tools) {
    if (tool.boundaries && tool.boundaries.length > 0) {
      map.set(tool.name.toLowerCase(), tool.boundaries);
    }
  }
  return { getBoundaries: (name) => map.get(name.toLowerCase()) };
}
```

**入口注入**：CLI `run-agent.ts` 与 serve session 创建处构建 registry 实例。注意 `createDefaultClassifier` 实际选项参数名是 **`registry`**（`classifier.ts:379-390`），不是 toolBoundaryRegistry：

```typescript
const boundaryRegistry = createBoundaryRegistry(builtinTools);
const securityPipeline = new SecurityPipeline({
  // ... 现有 options
  toolBoundaryRegistry: boundaryRegistry,  // SecurityPipeline 选项名
});
// pipeline 内部转给 createDefaultClassifier({ registry: options.toolBoundaryRegistry })
```

MVP 阶段 registry 实际是空的（现有 8 工具不声明），但**链路已通**——下一批新工具加进 builtinTools 后立即生效。

**当前状态**：`run-agent.ts:277` 中 `createDefaultClassifier({ registry: options.toolBoundaryRegistry })` **已写好** —— 真实缺失的只是 `run-agent.ts:238-243` 创建 SecurityPipeline 时**没有传 toolBoundaryRegistry option**，导致 fallback 到 EMPTY。M2 主要工作就是补这条链路。

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

**工厂**（新建 `packages/core/src/security/tool-aware-extractor.ts`）：

```typescript
import type { ToolDefinition } from "../types/tools.js";
import type { SecurityRequest } from "./types.js";

export function createToolAwareExtractor(
  tools: readonly ToolDefinition[],
): (request: SecurityRequest) => string {
  const keyByTool = new Map<string, string>();
  for (const tool of tools) {
    if (tool.permissionArgumentKey) {
      keyByTool.set(tool.name.toLowerCase(), tool.permissionArgumentKey);
    }
  }
  return (request) => {
    const tool = request.tool.toLowerCase();
    // 1. 工具显式声明的 key
    const explicitKey = keyByTool.get(tool);
    if (explicitKey) {
      const val = request.arguments[explicitKey];
      if (typeof val === "string") return val;
    }
    // 2. 回退到内置启发式（保持向后兼容；store 内置 fallback 完成）
    return defaultExtractArgument(request);
  };
}
```

**store 端**：当前 `extractArgument` 私有方法（`permission-store.ts:381-399`）改为通过 options 获取，未注入时使用现有 fallback。

**各工具声明前置条件**：**仅** `needsPermission: true` 的工具才需要补 permissionArgumentKey 声明。`needsPermission: false` 的工具（glob / grep 等）不进权限匹配链路，声明会成死代码。

| 工具 | needsPermission | permissionArgumentKey | 说明 |
|------|----------------|----------------------|------|
| bash | true | `"command"` | 与现有 extractArgument 内置 bash 分支一致；显式化让"哪个字段进规则匹配"在工具自身可见 |
| write / edit | true | 待验证 | 实施时按工具实际 schema 字段名（`file_path` 或 `path`）声明；M3 实施前 grep 各工具 inputSchema 确认 |
| read | （需确认） | 待验证 | read 当前 `needsPermission` 设置需 M3 启动前 grep 验证；若是 false，跳过 |
| schedule / memory | （需确认） | （视权限语义） | 这两个工具当前是否需要权限匹配本身待确认；M3 实施前确认后决定是否声明 |
| glob / grep | **false** | — | **不声明**（needsPermission=false，不进入权限匹配链路） |
| 未来 web_fetch | true | `"url"` | |
| 未来 web_search | true | `"query"` | |
| 未来 http_request | true | `"url"` | |

> **注**：表格中 "待验证 / 需确认" 的工具，M3 启动第一步是 grep 各工具实现的 `needsPermission` 字段与 inputSchema，得出权威清单后再批量补声明。spec 不预断未验证的属性。
>
> **shell 工具**：permission-store 内置 extractArgument 中的 `tool === "shell"` 是预留 fallback（无对应实际工具），不属于 builtin tools 集合。M3 不为 shell 声明 permissionArgumentKey。

### 4.3 PermissionScope "builtin" + 用户池兜底分支（M4）

```typescript
// security/types.ts
export type PermissionScope = "session" | "workspace" | "global" | "builtin";

// security/permission-store.ts
export interface IPermissionStore {
  // ... 现有
  /**
   * 注册 builtin 默认规则（in-memory，不持久化）。启动时调用一次。
   * 每次调用会**替换**现有 builtin 规则集（不累加），便于测试 + 重启清理。
   * 规则的 scope 字段由 store 强制改写为 "builtin"（防止误声明）。
   */
  registerBuiltinRules(rules: PermissionRule[]): void;
}
```

**关键认知**：现有 `match` 实现（`permission-store.ts:158-200`）已经是"收集 session + workspace + global 所有 candidates → resolveConflict"的形态；M4 **不重构** match 主体，**只在用户池空时增加 builtin 池兜底分支**。改动局部化。

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

### 4.5 ToolExecutionContext.llm + ZhixingConfig.llm（M6）

```typescript
// types/tools.ts
interface ToolExecutionContext {
  // ... 现有
  /**
   * 工具内部 LLM 访问能力。
   * `cheap` 是配置的便宜模型 Provider 实例（默认 claude-haiku-4-5），
   * 用于工具内部摘要/分类等场景。
   *
   * 由调用方（CLI run-agent / serve session）创建并注入。
   */
  llm: {
    cheap: LLMProvider;
  };
}
```

**ZhixingConfig 扩展**（`packages/providers/src/types.ts`）：

```typescript
interface ZhixingConfig {
  // ... 现有 providers / activeProviderId / log / 等
  llm?: {
    /**
     * 主对话模型 ID。当前已通过 ProviderConfig.defaultModel 间接配置；
     * 此字段为标准化命名层（向后兼容：未声明时取 activeProvider.defaultModel）。
     */
    defaultModel?: string;
    /**
     * 工具内部使用的便宜模型 ID。默认 "claude-haiku-4-5-20251001"。
     */
    cheapModel?: string;
    /**
     * cheap model 使用的 provider ID。默认与 activeProviderId 相同（共用 apiKey/baseUrl，
     * 仅模型不同）。可独立配置以便用不同的 provider 跑 cheap model（如本地小模型）。
     */
    cheapProviderId?: string;
  };
}
```

**createProvider 必须扩展第 4 参数**（M6 关键工作之一）：

`createProvider` 当前签名（`packages/providers/src/create-provider.ts:47-54`）只接 3 参数（config / providerId? / env?），**不支持运行时选择 model**。`ProviderConfig.modelOverrides` 是**预算覆盖**（上下文窗口 / 最大输出 token），与"动态选模"无关。M6 必须扩展：

```typescript
// packages/providers/src/create-provider.ts (M6 改动)
export interface CreateProviderOptions {
  /**
   * 覆盖 ResolvedProvider.defaultModel 的运行时模型 ID。
   * 用于在同一 provider（共享 apiKey/baseUrl）上创建不同 model 绑定的实例
   * （主对话用 sonnet / 工具内部 distill 用 haiku 等场景）。
   * 不影响 ProviderConfig.modelOverrides（那是模型预算配置）。
   */
  model?: string;
}

export function createProvider(
  config: ZhixingConfig,
  providerId?: string,
  env?: Record<string, string | undefined>,
  options?: CreateProviderOptions,
): LLMProvider {
  const resolved = resolveFromConfig(config, providerId, env);
  // 用 spread 派生新 ResolvedProvider（保持原对象不可变）；ResolvedProvider 的 model 字段是 defaultModel
  const effective = options?.model
    ? { ...resolved, defaultModel: options.model }
    : resolved;
  return createFromResolved(effective);
}
```

**实例创建**（CLI run-agent + serve session 各一处）：

```typescript
const cheapProviderId = config.llm?.cheapProviderId ?? config.defaultProvider;
const cheapModel = config.llm?.cheapModel ?? "claude-haiku-4-5-20251001";
const cheapProvider = createProvider(config, cheapProviderId, env, { model: cheapModel });
// 注入到 ToolExecutionContext.llm.cheap
```

**命名澄清**：
- 第 4 参数字段名是 `model`（不是 `modelOverride`），避免与 `ProviderConfig.modelOverrides`（预算覆盖）混淆
- `ResolvedProvider.defaultModel`（`providers/types.ts:185-200`）是真实字段名，**不是** `modelId`
- ZhixingConfig 的活动 provider 字段名是 **`defaultProvider`**（`providers/types.ts:167-180`），不是 `activeProviderId`
- 用 spread 派生新对象不 mutate `resolved`，保持解析结果的可缓存/可复用语义

**`ctx.llm.cheap.chat()` 错误契约**：

工具调用 cheap Provider 时可能遇到：网络失败 / quota 耗尽 / 超时 / Provider 配置错误 / 模型不可用。约定如下：

| 错误类型 | Provider 行为 | 工具应对 |
|---------|--------------|---------|
| 网络/超时/5xx | `provider.chat()` 抛 异常 | 工具 catch 后**降级**：返回 raw 内容（无 distill） + ToolResult 标注"cheap LLM 不可用，已返回原始内容" |
| 4xx（quota / auth / model 不存在） | `provider.chat()` 抛异常 | 同上降级；额外 logger.warn 让用户看到配置问题 |
| AbortSignal 触发 | `provider.chat()` 抛 AbortError | 工具透传 abort，结束执行 |

**强制约定**：工具的 `ctx.llm.cheap.chat()` 调用**必须包 try/catch**，**不允许让 cheap Provider 错误穿透到 tool handler 抛出**——这会被 LLM 误解为"工具不可用"。`isError: false + content 含 fallback` 是正确的工具语义。

**不做的事**：cheap LLM 调用的内置重试/缓存/速率限制不在 ToolExecutionContext.llm 层面提供。如需重试可在工具内部实现（参考 agent-loop 的 withRetry 包装），不强制。

**ToolExecutionContext 创建点**（M6 必须 wire 的所有位置）：

| 位置 | 改动 |
|------|------|
| `core/loop/tool-executor.ts:88-91` | context 字面量加 `llm`，从调用方接收 |
| `cli/secure-executor.ts:162-170` | augmentedContext 同步加 `llm`（透传上层 ctx） |
| `core/loop/__tests__/agent-loop.test.ts` mock context | 加 `llm: { cheap: mockProvider }` 或允许测试用 stub provider |
| `core/memory/__tests__/...` mock context | 同上 |

向后兼容：所有创建点同时改，不允许 `llm` 缺省（必填字段）。测试 mock 提供 stub。

### 4.6 builtin 规则注册接口（M4 实现细节）

CLI / serve 入口启动时调用：

```typescript
const builtinRules: PermissionRule[] = [
  // MVP 默认为空数组；未来 web_fetch 加入时通过此处注入：
  // ...WEB_FETCH_DEFAULT_RULES,
];
permissionStore.registerBuiltinRules(builtinRules);
```

builtin 规则在内存中保存，进程重启重新注入，不写磁盘，用户磁盘文件 (`~/.zhixing/permissions/global.json`) 仅含用户自定。

---

## 五、Milestone 拆分（5 个实施 + 1 个验收）

实施工作集中在 M1–M4 + M6（共 5 个），每个独立可交付。M5 由于"Confirmation → PermissionRule 链路"在代码中已大部分实现（见 §4.4 现状盘点），不构成实施性 milestone，作为本规格的**端到端验收阶段**单列于 §五.7（位于实施 milestone 之后）。

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
- `permission-store.ts` 加 builtinRules 字段 + registerBuiltinRules 方法（替换式，强制改写 scope 字段为 builtin）
- match 流程**仅扩展**：现有用户池逻辑保持，仅在用户池空时增加 builtin 池兜底分支（见 §4.3 改动前/改动后对比）
- `run-agent.ts` + serve 入口启动时调 `store.registerBuiltinRules([])`（MVP 默认空）

**关于 PermissionRulePattern 类型抽出**：M5 已确认不再使用 rememberAs 字段（直接复用 ConfirmationDecision 现有 pattern 字段），因此 PermissionRulePattern 抽出**不再是 M4 必需**。store.create 调用方传 `decision.pattern.pattern` 即等于 PermissionRule.pattern 形态（结构等价）。如未来其他模块需要命名类型再抽。

**验收**：
- 单测："用户池任一命中 → builtin 不参与"：注册 builtin allow + 用户 deny 通配 → 结果为 deny
- 单测："用户池为空 → builtin 接管"：注册 builtin allow + 无用户规则 → 结果为 allow
- 单测：`registerBuiltinRules` 替换式（连续两次调用，第二次覆盖第一次）
- 单测：scope=`"builtin"` 不写磁盘（mock 文件系统验证）
- 现有 permission-store.test.ts 全绿（用户池逻辑无变化）

**估工**：2.5h

### M6：ToolExecutionContext.llm + ZhixingConfig.llm + cheap Provider 注入

**前置 spike**（≤30 分钟，M6 第一步）：grep `: ToolExecutionContext = {` + `: ToolExecutionContext =` 全 packages 列权威清单 + grep `createProvider(` 全 packages 列调用点权威清单。spec 已知 4 处 context 创建点（含 2 处 mock），但产品代码中是否有更多 createProvider 调用点（server/remote-runner/集成测试等）需 spike 确认。

**范围**：
- `packages/providers/src/create-provider.ts`：扩展第 4 参数 `options?: { model?: string }`，在 resolveFromConfig 后按 options.model 覆写 effective model（见 §4.5 详细代码片段）
- `packages/providers/src/types.ts` ZhixingConfig 加顶层 `llm` 字段（可选，含兼容缺省）
- `core/types/tools.ts` ToolExecutionContext 加 `llm: { cheap: LLMProvider }`（必填）
- 已知 4 处 ToolExecutionContext 创建点更新（spike 后清单可能扩展）：
  - `core/loop/tool-executor.ts:88-91`（生产）
  - `cli/secure-executor.ts:162-170`（生产 wrapper）
  - `cli/__tests__/secure-executor.test.ts` mock context
  - `tools-builtin/__tests__/memory.test.ts` mock context
- `run-agent.ts` + serve 入口：按 `config.llm?.cheapProviderId ?? config.defaultProvider` 选 provider，按 `config.llm?.cheapModel ?? "claude-haiku-4-5-20251001"` 选 model，调 `createProvider(config, cheapProviderId, env, { model: cheapModel })`，注入 context
- 配置兼容：`llm` 字段缺省时整体走 fallback，老 config.json 启动不报错

**验收**：
- 单测：mock cheap Provider 可通过 `ctx.llm.cheap.chat(...)` 调用
- 单测：`createProvider(config, undefined, undefined, { model: "haiku" })` 返回的 provider 实例 effective model 为 haiku（不是 ProviderConfig.defaultModel）
- 集成测：老用户（config.json 无 llm 字段）启动正常，cheap Provider 用 fallback 创建
- 现有工具测试 mock context 不破坏（增加 llm 字段即可）

**估工**：7.5h（含 spike 0.5h + createProvider 扩展 1.5h + ZhixingConfig schema 扩展 0.5h + 4+ 处 context 创建点 wiring 2.5h + 配置兼容 + 测试 2.5h）

**实施顺序约束**（5 个实施 milestone）：
- M1 → M2（M2 用 M1 字段，但 MVP M1 不让现有工具声明，所以 M2 测的是 forward-looking 行为）
- M3 独立
- M4 独立（registerBuiltinRules 在 CLI 入口启动时调，不依赖其他 M）
- M6 独立

→ **可并行**：M1+M2 一组、M3 一组、M4 一组、M6 一组；§五.7 端到端验收在 M2+M3+M4 完成后进行

**实施总工**：~14.5h（M1 0.5h + M2 1.5h + M3 2.5h + M4 2.5h + M6 7.5h）；端到端验收阶段额外 1h。

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

**进入条件**：M2 + M3 + M4 全部完成（M3 让 allow-workspace 落库的 PermissionRule 能在下次匹配时命中正确字段；M4 让 builtin 规则与 user 规则交互逻辑正确）。M1 / M6 不阻塞。

---

## 六、决策记录（ADR）

### ADR-TPE-001：boundaries 在 ToolDefinition 上而非外部配置

**决策**：boundaries 字段直接放 ToolDefinition；外部 registry 由工厂从 tool list 自动构建。
**理由**：cohesion——工具的安全特征属于工具自身定义；外部配置易腐化（工具改动时漏改）。
**反对**：略增 ToolDefinition 复杂度；可选字段 + 政策（context classifier 工具不应声明）缓解。

### ADR-TPE-002：builtin scope 不持久化

**决策**：PermissionScope 加 "builtin"，规则仅 in-memory，启动时由代码注入。
**理由**：系统预置规则是代码不是数据；用户磁盘只存用户决定；删除/升级时无需迁移文件。
**反对**：略增 match 复杂度（两阶段匹配）。
**未来扩展约束**：当前 `registerBuiltinRules` 是**替换式单源**调用，假设单一启动入口（CLI/serve）一次注入完整集合。**未来若有多源 builtin 规则注入需求**（例如插件 / MCP server / 第三方扩展也想注入 preapproved 规则），需将 API 升级为追加式 + 命名空间（`registerBuiltinRulesNamespace(ns, rules)`），并明示冲突解决策略。当前不预先做。

### ADR-TPE-003：permissionArgumentKey 显式 vs 隐式优先列表

**决策**：每工具显式声明 `permissionArgumentKey`，未声明者降级到现有启发式。
**理由**：隐式列表本就脆弱（依赖字段顺序/命名约定），扩展只是扩大脆弱面；显式声明使每工具的权限语义自描述、明确、易审计。

### ADR-TPE-004：confirmation→rule 协调归 secure-executor（追认现状）

**性质**：本条**追认现有代码的架构选择**，不是新决策——`secure-executor.applyBrokerDecision`（行 566-622）已经在生产代码中协调 store.create + tracker.record。spec 把它列为 ADR 是为了给后续维护者一份"为什么是这种结构"的说明，而非要求 M5 实施重新设计。
**决策**：suggestion 由 SecurityPipeline.SuggestionMiddleware 注入；用户选择翻译由 Renderer 完成；最终 store.create + tracker.record 调用归 secure-executor。
**理由**：broker 是纯交互协议层；renderer 只渲染；secure-executor 是中间层协调点（持有 pipeline 引用 + 工具调用编排），是落库与计数累计的天然位置。

### ADR-TPE-005：ToolExecutionContext.llm 字段而非抽象 LLMService

**决策**：ToolExecutionContext 直接持 LLMProvider 实例（命名空间化在 `llm.cheap`）；不抽 LLMService 中间层。
**理由**：当前唯一 consumer 是未来 WebFetch；Provider 已是统一抽象；多一层包装无收益（YAGNI）。`llm: {cheap}` 的对象 shape 留有未来加 `main / custom` 字段空间。
**使用约束**：`ctx.llm.cheap` **仅供工具内部 distill / classify / summarize 等明确的"LLM 辅助处理"场景**使用——不是通用"调任意模型"的便捷入口。工具的核心职责仍应是单一明确的事（read 就读文件 / bash 就执行命令）；当核心动作产出超大上下文需要压缩时才触发 cheap LLM。代码 review 把关：避免每个工具都开始"顺便调一下 LLM 做点什么"导致工具职责泛滥。

### ADR-TPE-006：boundaries 与 context classifier 二选一（不叠加）

**决策**：现有 8 个 builtin 工具均通过 context classifier 接管分类，**不**为它们补 boundaries 声明。boundaries 是 forward-looking 字段，专为未来无 context classifier 的工具准备。
**理由**：CompositeClassifier 优先 contextClassifiers，boundaries 对它们是死代码；保留死代码会让未来读者误信 boundaries 有效力，污染心智模型。
**反对**：缺少"统一所有工具都声明 boundary"的整齐感——但形式整齐 < 语义清晰。

### ADR-TPE-007：extractArgument 通过依赖注入而非穿透 tools

**决策**：PermissionStore 通过 PermissionStoreOptions 接受 `extractArgument` 函数；不在 store 持有 tools 列表。
**备选**：让 store 持有 tools 列表 / 加 ToolPermissionRegistry 类型与 ToolBoundaryRegistry 对偶。
**理由**：cohesion——store 的职责是规则存储与匹配，不是参数提取；extractArgument 是策略而非数据，DI 是表达策略的标准方式；caller（持 tools）天然是策略提供者；无需新增 registry 类型，更少抽象。

### ADR-TPE-008：用户 vs builtin 优先级 = 两阶段匹配（user 严格优先）

**决策**：match 流程为两阶段：用户池（session+workspace+global）任一命中 → 仅按用户池 resolve；用户池空 → builtin 池接管。
**备选**：把 builtin 池与 global 池合并，按 specificity + deny-wins 统一 resolve。
**理由**：合并方案下，用户的通配 deny（如 `pattern: "*"`）会被 builtin 高特异性 allow 击败，与"用户拥有最终决定权"的产品语义矛盾；两阶段保证用户在自己写过任何相关规则时不被 builtin 干扰。
**反对**：实现略复杂；但语义清晰是 worth。

---

## 七、测试策略

每个 M 包含三类测试：单元、集成、回归。

| M | 单元测试 | 集成测试 | 回归保护 |
|---|---------|---------|---------|
| M1 | ToolDefinition 字段类型 | — | classifier.test.ts 不变 |
| M2 | createBoundaryRegistry 各分支 | CLI 启动后 SecurityPipeline 持有 non-empty registry（mock tool） | classifier.test.ts EMPTY_BOUNDARY_REGISTRY 路径不变 |
| M3 | createToolAwareExtractor 命中/不命中/fallback | 端到端 CLI → secure-executor → store.match 用真实 extractor 路径 | permission-store.test.ts 默认 fallback 路径全绿 |
| M4 | 两阶段匹配各 case（user only / builtin only / 冲突）/ registerBuiltinRules 替换式 | 启动注入空 builtin 数组后 store 行为不变 | 现有 permission-store.test.ts（无 builtin 用例）全绿 |
| M5 | tracker.record / shouldSuggest 单元测 / Renderer 渲染 suggestion / store.create 调用条件 | 端到端 4 次 confirm 触发规则创建场景 | 现有 confirmation 测试（无 suggestion 字段消费）全绿 |
| M6 | mock cheap Provider 调用 / 配置兼容（缺省字段） | 老 config.json 启动 / cheap Provider 实际可调 | 现有工具测试 mock context 增加 llm 字段后全绿 |

**新增集成测试入口**：`packages/cli/src/__tests__/tool-permission-e2e.test.ts`（新建），覆盖 boundary registry → classifier → permission-matcher → confirmation → store.create 完整链路。

**测试基建变更**：所有 ToolExecutionContext mock helper（如有 testing-utils 共享）增加 `llm: { cheap: stubProvider }` 字段，避免每个测试单独 mock。

**M4 builtin 规则的测试隔离**：`registerBuiltinRules` 是替换式调用——但单元测试套件中可能多个 test case 顺序运行同一个 PermissionStore 实例，前一个 test 注入的 builtin 规则会被后一个看到，导致测试间污染。**约定**：
- 每个涉及 builtin 规则的测试在 `beforeEach` 显式调 `store.registerBuiltinRules([])` 重置（替换式语义自然支持）
- 集成测中 PermissionStore 一律 per-test 实例化，不复用
- M4 在新增 registerBuiltinRules 单测时必须包含"重置后旧规则不再命中"用例

**老 user 规则的兼容性**：M4 给 PermissionScope 加 "builtin" 值后，反序列化 `~/.zhixing/permissions/global.json` 的旧 PermissionRule（scope ∈ session/workspace/global）必须保持完整兼容。loadGlobalRules / sanitizeRules 不能因 union 多了 "builtin" 值而拒绝旧文件。M4 验收单测必须包含"老 schema 反序列化"场景。

---

## 八、风险与回滚

| 风险 | 影响 | 缓解 |
|------|------|------|
| M2 注入 toolBoundaryRegistry 后，若误为某些已有 context classifier 的工具补 boundaries，则形成死代码污染 | 低 | M1 政策文档明示"现有 8 工具不补 boundaries"；review 把关 |
| 老 config.json 缺 llm 字段启动失败 | 高 | 字段全部可选，缺省都有 fallback（cheapModel → "claude-haiku-4-5-20251001"，cheapProviderId → defaultProvider）；启动时不强校验 |
| ToolExecutionContext 加必填 llm 字段，遗漏某个测试 mock 创建点 | 中 | M6 启动前 spike grep 全 packages 列权威清单（已纳入 M6 范围）|
| createProvider 调用点不只 run-agent.ts（server / remote-runner / 集成测试可能有更多）| 中 | M6 启动前 spike grep `createProvider(` 全 packages 列调用点权威清单（已纳入 M6 范围）|
| M3 各工具 needsPermission 与 schema 字段名 spec 未预断 | 低 | M3 启动前 spike grep 各工具实现（已纳入 M3 范围）|
| M5 端到端测试覆盖不足（confirm 链路是已实现但未端到端测过的代码） | 中 | M5 工作就是补这条端到端集成测，不写产品代码；保护现有单测全绿 |
| createProvider 第 4 参数扩展可能影响现有 Provider 类型签名一致性 | 中 | options 字段全部可选；扩展遵循"只加，不改" |
| deny 路径不计入 tracker.record——未来若需"用户连续拒绝建议加 deny 规则"会再补 | 低 | 当前 spec 明示该 UX 为未来增量，不在范围；deny 不沉淀符合"被拒不累计"产品语义 |
| PermissionStore.create 并发安全（多个 confirm 几乎同时 resolve 时） | 中 | 当前 PermissionStore 实现是同步 in-memory 写 + 异步落盘；JS 单线程下两次 create 不会真并发，但 await 落盘期间 in-memory 已可见——多次调用结果是 N 条规则共存，不会丢；幂等性由 globSpecificity 在 match 阶段裁决。M4 验收单测包含"快速连续 create 同 pattern" 场景 |
| 老 config.json 含 PermissionRule.scope 旧 union 值反序列化失败 | 中 | M4 sanitizeRules 必须在加 "builtin" 值后保持旧 3 态向后兼容；测试覆盖（见 §七 测试策略）|
| `ctx.llm.cheap.chat()` 错误未被工具 catch 直接抛出 | 中 | §4.5 错误契约明示"工具必须 try/catch + 降级"；review 把关；可考虑 lint rule 强制 |

**每个 M 独立可回滚**：所有新增字段 optional 或带 fallback；新方法/新模块独立；删除即恢复旧行为。

---

## 九、与下游的关系

| 下游工作 | 关系 |
|---------|------|
| Step 21B WebFetch | **强依赖**：boundaries 声明（network/egress） / preapproved hosts builtin 规则 / cheapLLM distill / permissionArgumentKey="url" 全部依赖本规格 |
| Step 21 子 agent | 间接受益：子 agent 创建时 sessionType="ci" → SecurityPipeline 自动按 non-interactive 处理 → builtin 规则仍生效，killer use case 通 |
| Step 22 BackgroundAgent | 间接受益：cheap LLM 注入 + 工具权限分级在 background 路径同样需要 |
| 第二通道 / MCP HTTP（未来） | 间接受益：tool 系统更健全，新工具加入更容易 |

实施完成后，**zhixing 工具/权限系统首次进入设计意图的完整工作状态**：
- 任意新工具声明 boundaries → 自动获得正确分类
- 多 string 字段工具的权限规则匹配命中正确字段
- 系统预置规则与用户自定规则清晰分层、用户拥有最终决定权
- 用户能平滑沉淀"始终允许"决策为持久规则
- 工具有访问内部便宜模型的能力

---

## 十、未来工作（不在本规格）

- **WebFetch 工具实现** + `core/network/` + `text-sanitizer`（[`drafts/web-fetch-tool.md`](../drafts/web-fetch-tool.md) 后续）
- **`zhixing permissions list` CLI 命令**展示当前生效规则——展示策略需明确：user 规则与 builtin 规则**应分组展示**（避免用户混淆"为什么我没创建过的规则在这"）；默认列出 user 规则，加 `--include-builtin` flag 列出全部
- **BoundaryClassifier 的 dynamic 分支**与 ShellClassifier 协同（已有 ShellClassifier 实现，未来与 BoundaryImpactClassifier 协同）
- **ToolPermissionRegistry 抽象**（如果未来出现"权限相关元数据"远不止 permissionArgumentKey 一个字段时再抽）
- **deny 计数 UX**：用户连续拒绝同操作 N 次后建议加 deny 规则——需独立给 deny 路径补 tracker.record 调用，并扩 SuggestionMiddleware 阈值规则（区分 allow 累计与 deny 累计）
- **远程通道"始终允许"语义**：扩 InboundRouter 词集匹配，识别"加规则 / 始终允许 / 不再问我"等关键词转 allow-workspace decision；属于 remote-confirmation 后续增量
- **多源 builtin 规则注入**：`registerBuiltinRules` 升级为追加式 + 命名空间，支持插件 / MCP / 第三方扩展（详见 ADR-TPE-002 反对/约束段）
- **可观测性 / telemetry**：permission 决策路径上结构化事件输出（"工具 X 命中规则 Y / 命中 builtin / 触发 confirm / 用户选 Z"），便于调试"为什么 X 工具被自动允许 / 为什么这次又问我"
- **cheap LLM 内置重试 / 缓存 / quota 控制**：当前 `ctx.llm.cheap.chat()` 是裸 Provider，未做内置重试或速率限制。若多个工具频繁调用 cheap 模型（quota 触顶或网络抖动），可能需在 ToolExecutionContext.llm 层加包装层（届时再考虑是否升级为 LLMService 抽象，见 ADR-TPE-005）
