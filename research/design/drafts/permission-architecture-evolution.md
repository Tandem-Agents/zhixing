# 权限分级与信任区 — 需求与架构

> **性质**：需求确认（第一部分）+ 架构方案（第二部分）。骨架与细化决策均已落地。现状架构见 [security-system.md](../specifications/security-system.md) / [tool-permission-execution.md](../specifications/tool-permission-execution.md)。

## 第一部分 · 已明确的需求

**动机**：现有的"安全区"= 单个 workspace 目录的写信任，是 main 单模式时代的产物（那时 workspace 就是 main 的唯一信任区）。现在已有工作模式、用户可拥有任意多个工作场景——"只认一个目录、只放文件写"已不匹配：工作场景本身承载用户信任意图却无法表达；尤其**无目录的工作场景现状反而最严**。

1. **main 与工作场景在权限层平等**：都是"上下文"，各自有自己的信任范围与规则文件，互不污染。
2. **工作场景信任**：用户**主动进入**一个工作场景即代表信任意图 → 该场景权限**放宽**。场景可有/无工作目录；**无目录的场景同样放宽**。
3. **确立一套多等级安全 / 信任体系（核心）**：workspace 与工作场景的放宽都源于这一套体系，各等级划分清晰、按上下文应用。
4. **放宽 ≠ 无限制**：每级都有安全底线；最敏感的禁区（凭证/密钥/.git）**穿透所有等级、永不放宽**。
5. **信任根源 = 用户意图**：等级提升依据用户主动动作，而非凭空累积的信任分数。
6. **不做静态妥协**：不接受"放得宽就不安全 / 要安全就多打扰"的此消彼长，要**同时做到用户方便与更高安全**。

---

## 第二部分 · 架构方案

> **核心主张**：以**信任机制**为主角——它累积"什么操作在什么上下文可信"，让绝大多数操作直接放行；**AI 安全助理**（用户面术语；内部代码 `steward` / `AISecuritySteward` 字段名维持不变，是有意的内外可分离）是信任机制的"灰色地带研判器 + 信任来源之一"，独立于主 agent、只处理机制尚未覆盖的中间层；二者**闭环**：研判/确认的结果回喂信任，机制越跑越熟、助理越来越清闲。叠加确定性两端（默认放行 / 禁区底线），从而"宽松"与"安全"同时成立。这是知行"判断交模型 + 护栏 + 机制沉淀"哲学在权限层的落地。

### 1. 演进起点：要解决的债务
- `FileSystemClassifier` 把"写在不在 workspace"编码进 internal/external——**信任与影响耦合**，多级信任沿用必恶化。
- 原决策是**静态规则**（external 一律 confirm / 某些 allow）——这正是"宽松 vs 安全"对立之源：清单预设、抓不住语义、漏判或误扰。

### 2. 两个正交维度
- **OperationClass（操作影响，与上下文无关）**：操作本身有多大影响。
- **TrustLevel（信任等级，与操作无关）**：当前上下文用户授予多少信任。
- 二者共同喂给三层决策（§6），不直接定结果。

### 3. OperationClass（回归纯粹）
- `observe`：只读/查询，无副作用。
- `internal`：只改本地应用状态（`~/.zhixing` 下 memory/schedule/skill，经 app-state 边界）。
- `external`：影响用户文件/外部世界（文件写、命令、网络）。**文件写一律 external，不再看位置**。
- `critical`：不可逆/高危（`rm -rf`、写系统目录等）。

### 4. TrustLevel（作用 = 调研判宽严，而非直接放行）
- `global`(L0)：无信任上下文，最保守。**作用域：无**。
- `workspace`(L1)：操作目标路径在信任目录内。**作用域：路径**（realpath，复用 `PathGuard.isWithinWorkspace`）。main workspace 与场景 workdir 都提供 L1 锚。
- `scene`(L2)：当前活跃在工作场景，整会话生效、不依赖路径。**作用域：会话**。"无目录场景也放宽"的落点。
- **有效级 = max(路径信任, 会话信任)**。
- 运行时上下文标识（`PermissionContextId` discriminated union）作为信任层 → 权限层的承载详见 §8。

### 5. 信任机制（主角）
- **是什么**：累积"某操作模式 在 某信任上下文 可信"的系统；命中即第一层直接放行（不走助理、不打扰）。
- **信任来源（三条，全部锚定用户意图）**：
  ① 用户进入工作场景 / 指定 workspace（**上下文级**授权）；
  ② 用户在 confirm 中放行（**逐操作**增信）；
  ③ 安全助理研判 `safe`（在①已授权的上下文内的**自动细化**）。
- **闭环（助理越跑越闲的根本）**：操作来 → 查信任机制；未命中 → 走助理研判 or 交用户确认 → **结果回喂信任**（达阈值沉淀）→ 下次同模式直接命中、免走助理。机制运转越久，经过助理的越少。
- **与需求 5 一致**：三条来源都**框定在用户授权之内**——②是用户主动动作，③只在①授权的上下文内自动细化且**可见可撤销**。所以不是"凭空累积信任分"，信任根源始终是用户意图。
- **来源时间线（contributors）**：每次"信任贡献"都被完整保留——`PermissionRule.contributors: Array<{origin: "user"|"steward", timestamp}>`。沉淀那一刻直接拷贝 `ConfirmationTracker` 累积的数组（深拷贝，调用方可放心持有）；用户在 confirm 显式选 allow-context / allow-global 直接建规则时为单条 `[{user, now}]`。/trust 面板按时间顺序展示 `[你 你 助理]` token 序列让用户回溯。
- **自动沉淀仅产本上下文规则**：`scope: "context"` + 当前 contextId 绑定；**永不产 `scope: "global"`**——跨上下文 global 规则只在用户在 confirm 弹窗显式选「始终允许（全局）」时才建立。这从根本上消除"主模式不知不觉积出全局规则"的安全风险。
- **复用现有设施**：`ConfirmationTracker`（累计→阈值）+ `PermissionStore`（放行规则）；助理与用户都作为"信任来源"喂同一机制，沉淀规则的 contributors 时间线区分来源，用户控制面可回溯收紧。
- **底线**：`critical` / 禁区**永不沉淀**；模式粒度复用 `suggestPatterns`（不放开一切），防"先装好人攒信任后变坏"。

### 6. 三层决策与次序
- **第一层 · 默认信任、直接放行（不走助理）**：`observe` / `internal` + 信任机制命中的 `external`。
- **第二层 · 灰色研判（唯一经助理）**：信任机制未命中的 `external` → AI 安全助理（§7）。
- **第三层 · 禁区、确定性拦（不归助理）**：`critical` / `bypassImmune` → 确定性拦截或强制确认，**AI 无权放行**（fail-safe 基石）。
- **决策次序**：① 用户显式权限规则（`deny`→拦 / `allow`→放，**最高优先**）→ ② 确定性两端（observe/internal 放、critical/禁区拦）→ ③ 信任机制命中（放，免助理）→ ④ 助理研判（仅剩的灰色 external）。**用户 > 机制 > 助理**，用户始终最高。

#### Confirm 弹窗选项（上下文平等三选 + 拒绝）

用户进入 confirm 路径时，main 与工作场景在权限层平等都是"上下文"，弹窗选项以"作用范围"二维划分：

- **主模式上下文**：
  1. 允许这一次（默认焦点）
  2. 始终允许（仅主模式生效） —— `allow-context`
  3. 始终允许（全局，所有场景生效） —— `allow-global`
  4. 拒绝并说明原因 —— `deny-with-reason`，理由回流模型

- **工作场景上下文内**：
  1. 允许这一次
  2. 始终允许（本工作场景生效） —— `allow-context`，label 按 `contextId.kind` 动态
  3. 始终允许（全局，所有场景生效） —— `allow-global`
  4. 拒绝并说明原因

- **bypassImmune 守卫**：bypassImmune 命中的操作（凭证 / .git / .ssh / .zhixing 等禁区）**只给 allow-once + deny-with-reason** —— 禁区永不沉淀、跨所有上下文都不能放宽。从 UI 层断绝"用户多次允许把禁区操作攒成持久规则"的可能性。

`allow-session` 类型系统保留（broker / 远程渠道仍支持透传），CLI 不暴露——个人助手用户感知不到"会话"概念，且与对话 session 不挂钩易制造假 bug。

### 7. AI 安全助理（灰色地带研判器 · 独立裁判）
- **球员/裁判隔离**：助理是**独立 agent、独立上下文**，与执行任务的主 agent 隔离——执行权与判断权分离。
- **输入**：① 用户意图（可信源：原始任务/场景描述）；② **agent 意图**（agent 此刻要做什么）+ 操作客观事实（realpath 路径/解析命令/网络目标）；③ TrustLevel。其中 agent 意图与操作内容是**待审数据、不盲信**。
- **判法（不求完美，纠结即上交）**：分析**用户意图与 agent 意图是否对齐** + 操作有无危险 → 对齐且无疑 `safe`（放，喂信任）；**一旦纠结**（不对齐/不确定/有疑）→ 交用户确认（信息不足是上交、不是误放）；`escalate`（识破本质高危）→ 拦或强制确认。
- **强力模型 main 档**：安全研判属高风险判断（识别隐蔽外泄/巧妙注入），用最强模型；成本由 §5 闭环降频抵消。
- **TrustLevel 调阈**：scene → safe 门槛低（更易放）；global → 更易上交。
- **三态对用户的可见性**：
  - `safe` → 输出区低调一行「🛡 安全助理放行 {tool} {op}（理由：{reason}）」，让用户感知 AI 在背后做了判断。
  - `needs-confirm` → 进 confirm 面板，body 顶部 yellow 加前置标识「⚠ 安全助理察觉风险：{reason} / 请你决定是否继续 ↓」，引导用户判断。
  - `escalate` → 抛 `SecurityBlockError`，红色错误界面，message「操作被安全助理拦截：{reason}」。
- **用户面术语统一**：所有用户可见 UI 文案均用「安全助理」（confirm 前置标识 / SecurityBlockError message / /trust 面板 contributors 列与详情区 / 沉淀提示），代码内部 `steward` / `AISecuritySteward` / `ai-steward.ts` / 字段名 `stewardReason` 维持不变——内外可分离是有意设计。
- **护栏**：① 隔离 + agent 意图仅作待审数据；② 越不过第三层禁区底线；③ 纠结/低置信一律上交用户；④ 助理超时/失效 → 降级静态 `external→confirm`（只降便利不降安全）；⑤ 全程审计、用户可回溯收紧；⑥ 用户确认/规则回喂信任机制（§5 闭环）。

### 8. 信任上下文的注入与整合（非补丁）
- **装配期**：每个 runtime 带 `TrustContext`——main → `{kind:"global"}`；workspace 信任 → `{kind:"workspace", dir}`；工作场景 → `{kind:"scene", sceneId, intent?}`；承载于 `SecurityRequest.context`。
- **运行期**：authorize 新增 `TrustClassifier`（算有效 TrustLevel）；灰色层交独立 `AISecuritySteward`（独立 agent + main 档）。
- **重构**：`FileSystemClassifier` / `ShellClassifier` 去信任耦合、回归纯影响（**bash 由此首次纳入统一信任体系**）；`OperationClassifierMiddleware` 改驱动三层决策；`bypassImmune` 与 PathResolve 链路保留不动。
- **PermissionContextId 一等公民**：内存模型是 discriminated union，`{kind:"main"} | {kind:"workspace",hash} | {kind:"scene",sceneId}`，与 `TrustContext` 同构（三个 kind 一一对应）。`SecurityPipeline.getContextId()` 返回 union 而非 string，由 type system 强制 caller 显式表态 —— 杜绝"所有上下文共享一个 string namespace"导致的隐式碰撞（典型场景：用户起名 "main" 的工作场景与主模式撞 contextId）。
- **持久化边界**：`toStorageKey(id) -> string` / `parseStorageKey(stored) -> id | null` 单源真相，把 union 转紧凑 string（`"main"` / `"workspace-<hash>"` / `"scene-<sceneId>"`），三个 prefix 互斥。规则按 contextId 分文件存：`~/.zhixing/permissions/main.json` / `workspace-<hash>.json` / `scene-<sceneId>.json` / `global.json`。读盘 `sanitizeRules` 显式恢复 `contributors / contextId / contextPath` 字段（写盘自然走 `JSON.stringify`、读盘必须显式恢复才不会丢）。
- **`contextId` vs `contextPath` 字段分离**：`PermissionRule.contextId` 用于定位（决定挂哪个上下文文件、参与匹配判等），`contextPath` 仅 UI 友好显示（绝对路径，不参与匹配）。`scope === "global"` / `scope === "session"` 两个字段都为 `undefined`（作用域由 scope 自身承载，无需上下文锚）；`scope === "context"` + 主模式 → `contextPath` 为 `undefined`（主模式无工作区路径概念）；`scope === "context"` + 工作场景 → `contextPath` 填该场景的 workdir。

### 9. 用户控制面与审计可见性

- **`/trust` 面板**：以 typeahead args provider 范式注册（与 `/work` / `/resume` 一致）。用户从命令面板 accept `/trust` 后 typeahead 自动进入 args 输入态、立即弹规则候选 dropdown，无独立 handler。候选行 description 紧凑塞「生效范围 · contributors token · 匹配次数」；`builtin` 系统防护规则不归用户管，归 `/security` 查看，不进 `/trust`。
- **`/trust` 面板模式（PanelMode 一等公民）**：`mode: "management"` 声明无 accept 业务语义。typeahead 框架的 `PanelMode` discriminated union（`picker` / `management`）由 provider 必填，broker 在 trigger 命中那一刻通过 `computePanelMode` hook 同 `computeInlineActions` 一起算入 state（loading 中间态与 query 完成态字段值一致，单源真相）。management 模式下 footer 不显 Enter、Enter 按下完全 no-op、状态机由 inline 操作主导：Ctrl+D 双击协议撤销规则（第一次标 deletePending 红底、第二次确认）、Esc / Ctrl+C 退出。`/work` `/resume` 等 picker 模式行为完全保持原状。
- **审计事件 → 渲染**：`SecurityAuditor` 暴露 `auditEvaluation` / `auditStewardReview` / `auditRuleSedimented` 三个发射器，对应 `security:evaluation` / `security:steward_review` / `security:rule_sedimented` 事件。CLI per-run eventBus 订阅后两者，调 `renderAuditEvent` 写到主输出区：
  - `steward_review` safe 分支 → 一行 dim「🛡 安全助理放行 {tool} {op}（理由：{reason}）」
  - `rule_sedimented` → 一行 dim「🛡 已在 **主模式** / **当前工作场景** 记住 N 次同类操作，自动建立放行规则：{pattern}（进 /trust 可查看/撤销）」，作用范围按 `contextId.kind` 动态拼接
  - `steward_review` 的 needs-confirm / escalate 不在输出区渲染（分别由 confirm 面板前置标识 / `SecurityBlockError` 错误界面承担，避免重复输出）
- **三投影点术语统一**：`stewardReason` 在本地 TTY（`buildInlinePanelBody` 提到 body 顶部 + yellow + 「⚠ 安全助理察觉风险」）/ 远程文本（`text-renderer.ts` 同款措辞）/ RPC bridge（数据透传不渲染）三处用户面术语一致 —— 任何一处投影漏改都会让同一字段在不同渠道呈现新旧术语，重蹈"声明面 > 生效面"。

### 10. 落地影响 / 风险

改动集中在 core/security（`TrustContext` / `TrustClassifier` / 信任机制扩展 / `AISecuritySteward` + 重构分类器与决策中间件 + `PermissionContextId` discriminated union + audit 事件链）+ runtime 注入 + cli 渲染 / 命令面板。**风险点是 AI 研判可靠性**——由"纠结即上交用户"（不误放）+ 第三层确定性底线（危害压在 external 内）+ fail-safe 降级 + 信任机制闭环（降频）共同控制。属为"颠覆静态妥协"的必要架构投入。

> **待定**：`escalate` 危险模式清单（哪些场景属于识破即拦），助理研判缓存粒度（命中复用窗口）。
