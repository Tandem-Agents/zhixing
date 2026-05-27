# 权限架构演进

> **性质**：演进与债务追踪（活文档）。记录权限 / 安全模块（代码主体 `packages/core/src/security/`）在向后续模块扩展（MCP 已接入、skill 待接入）过程中暴露的真实债务与修复方案。架构现状见 [security-system.md](../specifications/security-system.md)、[tool-permission-execution.md](../specifications/tool-permission-execution.md)。
> **依据**：对 security 模块（classifier / pipeline / policy-engine / command-analyzer / permission-store / path-guard / env-sanitize / boundary-registry / tool-aware-extractor / builtin-rules）、`mcp/mapping`、runtime 装配、CLI session 重载、确认链路的**逐文件核读 + 调用链 grep**（非文档推断）。
> **总判断**：地基架构等级匹配且超前，**不需要从底层重构**；债务均为局部、可增量消除。

---

# 第一部分 · 债务盘点

> **严重度**：**S1（安全级）最高**；D1·D4·D5 次之（认知误导 / 局部缺口 / 虚假防护）；D2·D3 与低优先项为卫生级。
> **贯穿性根因**：S1·D2·D4·D5 同源——安全能力被「建出来、写进类型 / state / result / static 方法」，但**末端消费没接通**。**安全模块的「声明面」领先于「生效面」**——对安全模块尤其危险（给人虚假防护感）。修法不是重构，而是逐项「接通已建能力 + 删未接的死声明 + 把硬编码改声明式」。

## 真实债务

### S1 ·【安全级 · 最高优先】symlink 可绕过 bypassImmune 路径保护
authorize 阶段所有 path 匹配（`policy-engine.ts` matchPath:176 / matchPathOutside:221）只 `path.resolve` 不 `realpath`，symlink 不解析。全仓做 realpath 的安全判断只有 `FileSystemClassifier`（`classifier.ts:92`，**仅覆盖 write 工具**——read 直接判 observe、不查路径）及 `PathGuard`（guard 阶段、**决策之后、不回头重评**）。
**后果**：workspace / 接入目录内一个 `link → ~/.zhixing/credentials.json`，read 它时 matchPath 看未解析路径、匹配不上 `bi-zhixing-credentials-block`，read 又被判 observe 放行 → **凭证被读出、凭证零接触不变量被绕过**；`bi-ssh-keys` 同理。门槛在「接入外部 skill 目录 / clone 恶意 repo」场景下很低。

### D1 · `internal` 操作类不可声明，只能硬编码
`ToolDefinition` 无 `operationClass` 字段，工具无法自声明"我是 internal（写本地状态、无外部副作用、自动放行）"。该档按工具名写死（`classifier.ts:412-414` 的 `schedule`/`memory`）；自声明 `boundaries` 只能映射到 observe/external/critical，无语义正确的 internal 入口。
**后果**：每个"写本地状态"类新工具都得改 `classifier.ts`。skill 的 `load_skill` 不踩此坑（走 `{filesystem,read}`→observe）；真正受害者是 memory/schedule 这类工具。

### D2 · 动态卸载 / 接入 API 是投机预留，注释误导
三处 `unregister` **全仓零调用方**：`BoundaryRegistry.unregister`、`ToolArgumentExtractor.unregister`、`PermissionStore.unregisterBuiltinRules`（注释均举 `/mcp connect/disconnect`）。`register` 侧也只有静态 `fromTools` + 装配期补注册（Task `create-agent-runtime.ts:625`、web_fetch `:548`），无运行时动态 caller。真实 MCP 接入走 **reload 整体重建**（`session.ts:700`→重建→`fromTools` 重新 snapshot）。

### D3 · MCP 工具未声明 `permissionArgumentKey`，权限规则按启发式提参
`mapping.ts` 不产 `permissionArgumentKey`，MCP 工具权限匹配走默认启发式提取（priority list + 第一个 string 字段，`permission-store.ts:171-184` 注释自称"脆弱的隐式约定"）。
**后果**：多 string 字段 MCP 工具的「始终允许/拒绝」规则可能匹配到非预期参数，规则精度下降（偏严 fail-safe，损可预期性）。

### D4 · path-guard 有一套与 builtin-rules 重复、无调用方的敏感路径死代码
`PathGuard.isSystemProtected`/`hasTraversalSequence`/`SYSTEM_PROTECTED_PATHS`（`path-guard.ts:28-33,116,137`）零生产调用方。真正生效的拦截在 `builtin-rules.ts` 的 bypassImmune 规则（经 PolicyEngine）。两套清单还不一致（死代码版漏 `.zhixing/credentials`）。
**后果**：安全相关死代码最危险——维护者易误判 path-guard 在保护、改它以为生效。

### D5 · EnvSanitize 的环境净化产出无人消费（空转 + 审计谎报）
`EnvSanitize` 中间件算 `sanitizedEnv` 写 state、`SecurityAuditor` 据此发 `security:env_sanitized`「已净化」事件（`security-auditor.ts:101`），但 secure-executor 不应用、`buildCleanEnv` 零调用方、`bash.ts` 的 `exec()` 不传 env → 子进程仍继承危险 env、审计却报「已净化」。
**后果**：虚假安全感（比纯死代码更危险）。

## 低优先卫生项

- `always-ask` 决策按 allow-once 假装兜底（`secure-executor.ts:511-514`），CLI 不可达、语义未实现
- `mutableFileSnapshots`（防 TOCTOU）字段无赋值点，安全预留未接（`confirmation/types.ts:78`）
- `CancelCause:"renderer-detached"` 有定义+label 消费但无产生点
- 确认链路若干导出无外部调用方（导出面过宽，如 `getBuiltinNonInteractiveResolver`）
- 子 agent `auto-deny` 与 `inherit-or-deny` 当前等价（`child-broker.ts:40-43` 都映射 fail-to-deny + 共享父 permissionStore），`auto-deny` 语义无落点

## 经复审确认「非债务、不动」

- **DisplayBody 的 `network`/`messaging`/`calendar` kind**：`buildDisplayBody` 暂不产出，但 renderer 已支持、不谎报、不会被错误触发——是判别联合明示的「业务领域预留」（`confirmation/types.ts:36`），知行有 channels 模块、发消息/日程大概率近期落地。**保留**。其 4 处 switch 是判别联合固有 + TS exhaustive 保护，非债务。
- **edit-then-allow / show-full**：诚实标注的 Step 8 分期占位（入口关闭、明确 deny+"尚未实现"，不谎报），非债务，保留待 Step 8。

---

# 第二部分 · 修复方案

> 自审定稿（多轮收敛）。按贯穿根因分三类系统处理、非逐条补丁；确立单一事实源，保持既有可插拔性（分类器 / renderer / 中间件 / 规则 namespace 已是良好插件点，不新增抽象）。**未提交。**
> **附带架构收益**：删掉 EnvSanitize + PathGuard 两个 guard 中间件后，管线序列收敛为清晰三段——**解析**（CommandAnalyzer→PathResolve 填 `resolvedAccess`）→ **决策**（policy→classify→perm→suggest）→ **执行约束**（guard 仅剩 ExecutionGuard）。路径成为 `resolvedAccess.paths` 单一事实源。

## 一、接通生效（安全级）

### 修 S1（并掉 D4）
1. **统一前置解析**：新增 authorize 早期中间件 `PathResolveMiddleware`（order `-5`，CommandAnalyzer 后、PolicyEvaluator 前）。从标准 key（`path`/`file_path`/`target`/`destination`）+ 已有 `resolvedAccess.paths`（CommandAnalyzer 提取的）统一 `realpath`，回写 `request.resolvedAccess.paths`。下游统一读它：`PolicyEngine.extractPaths`（已优先读）、`FileSystemClassifier`（改读、不再自行 realpath）。→ 三处重复路径提取收敛为一处；`resolvedAccess.paths` 成路径**单一事实源**（realpath 后），symlink 对决策生效。
2. **修 `PathGuard.resolve` 不存在路径**：当前直接 `normalize`、不解析任何 symlink（`path-guard.ts:83-84`）→ 写新建文件到软链目录绕过残留。改为 realpath 失败时**逐级回退到最近存在祖先目录 realpath、拼接剩余段**（新增 helper），最终兜底仍 normalize（只会更严）。
3. **并掉 D4**：`PathGuard` 解析职责并入新中间件；删 `PathGuard` 的 `SecurityMiddleware` 实现；保留 `resolve`/`isWithinWorkspace` 两 static；**删死代码** `isSystemProtected`/`SYSTEM_PROTECTED_PATHS`/`hasTraversalSequence`（敏感路径单一事实源收敛到 `builtin-rules.ts`）。

影响：新增 `core/src/security/path-resolve.ts`；改 `security-pipeline.ts` / `classifier.ts` / `path-guard.ts` / `security-auditor.ts` / `security/types.ts`（清 state 冗余字段）。

### 修 D5（整删 EnvSanitize）
**复审（避免错上加错）**：原想"接通 buildCleanEnv 到 bash spawn"，但它无条件删 CONDITIONAL（`PYTHONPATH`/`RUBYLIB`/`CLASSPATH`）+ `NODE_OPTIONS`——有大量合法 CLI 用途，接通会破坏用户已确认命令的工作流；且 bash 命令是用户显式确认的、本就该继承自身环境，"净化继承 env"防护价值极低。真正有价值的防护（拦截命令里 `LD_PRELOAD=... cmd`）由 `bi-env-injection`（bypassImmune block，policy 层）负责，与 EnvSanitize 无关。
**修法**：**整删 EnvSanitize**（中间件 + `env-sanitize.ts` 库）+ 删 `security:env_sanitized` 事件 + `SecurityEventMap` 对应项 + state/result 的 `sanitizedEnv`/`removedEnvVars`。bash 不动；`bi-env-injection` 保留。无空转、无谎报、无待用死库，真防护不丢。

### mutableFileSnapshots
删字段（`confirmation/types.ts:78`）。TOCTOU 真要做时正经设计（确认时算 sha256 + 执行前校验）。

## 二、收敛删除（YAGNI）

- **D2**：删三处 `unregister`；接口去 `unregister`（留 `register`+`list`）；注释改述真实路径（reload 重建）。
- **always-ask**：删该 kind（ConfirmationOption/Decision + `translate`/`applyBrokerDecision`/`buildSelectOptions`/capabilities）。需要"每次必问"时正经实现（tracker suppress）。
- **renderer-detached**：删该 cause（reload 前置契约保证 swap 时 broker 空、terminal-renderer 自身 detach 走 aborted，无真实产生场景）。
- **auto-deny**：收敛为单值 `"inherit-or-deny"` + 注释未来扩展（`subagent/budget.ts`、`child-broker.ts`）。
- **导出面**：仅移除全仓（含测试）零引用的导出；被引用的保留——不为这条重写测试。

## 三、补声明式入口（消除硬编码，可扩展）

- **D1**：引入 `BoundaryType "app-state"`（知行应用本地状态：`~/.zhixing` 下 memory/schedule/skill 数据），`BOUNDARY_WRITE_IMPACT["app-state"]="internal"`、read→observe。`memory`/`schedule` 声明 `boundaries:[{boundaryType:"app-state",access:"write"}]`（`fromTools` 自动注册），删 classifier 硬编码 → 落 boundaryClassifier 判 internal。internal 变声明式，**为 skill 数据写预留正确边界类别**；安全立场不变（boundaries 由知行代码定、非运行时自报）。
- **D3**：`mapping.ts` 从 MCP `inputSchema.required` 取第一个 `type:"string"` 字段作 `permissionArgumentKey`；无则不设。

## 落地顺序（分组提交便于审阅/回滚，一次性完成）

1. **S1 + D4**（路径解析归位 + 祖先解析 + path-guard 瘦身）— 安全级，最高优先，独立可验证
2. **D5**（整删 EnvSanitize）
3. **D1**（app-state 声明式）
4. **第二类收敛**（D2 / always-ask / renderer-detached / auto-deny / 导出面 / mutableFileSnapshots）
5. **D3**（MCP 提参）

## 验证

- **单测**：各包 `vitest`（security/confirmation 大量用例需同步更新）；新增 S1 symlink 绕过回归（含经 symlink 目录的新建文件）、D1 memory/schedule 仍 internal、删 EnvSanitize 后 `bi-env-injection` 仍拦 `LD_PRELOAD=... cmd`。
- **类型**：全仓 `pnpm typecheck`——删 kind/字段/cause 在各 exhaustive switch 处暴露未更新点，编译器兜底。
- **端到端**：CLI 验证 read 指向 credentials 的 symlink 被拒、bash 确认+执行、`/trust`+`/security`、memory/schedule 自动放行、MCP 确认链路 + 子 agent + 远程确认不受影响。

## 风险与取舍

- 跨 6 包、动核心安全路径：靠 TS exhaustive + 现有测试 + 新增回归兜底；分 5 组提交便于定位。S1 的 realpath 失败一律走更严 fallback。
- 删 EnvSanitize：放弃"净化 bash 继承 env"（低价值且接通会破坏工作流）；命令设置危险 env 的真防护由 `bi-env-injection` 保留。
- 删 always-ask/auto-deny/renderer-detached：均不可达/等价声明，删除不改现有可观察行为。
