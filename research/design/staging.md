# Staging — 架构设计与审核平台

> 介于 [`active-problem.md`](active-problem.md) 工作台与 [`specifications/`](specifications/) 设计权威之间的中转平台。承载**需求已明确、架构待设计与审核**的内容 —— 设计审核通过后进入实施。一次只承载一个 staging topic;实施完成后"当前 staging"区整段清空,等下次启用换 topic。

## 原则

本文档的维护规则。**原则稳定**;下方"当前 staging"区随 topic 生灭整段重写。

- **定位**:本文件承载"需求已明确、架构待设计与审核"的内容。与 [`active-problem.md`](active-problem.md) 区别 —— active-problem 是"产品方向对齐工作台"(要跟用户**对齐需求**,讨论"做什么、不做什么"),staging 是"架构设计与审核平台"(需求已明确,**设计与审核架构**,讨论"怎么做")。需求未明确不放本文件,回 active-problem 对齐
- **工作流是设计 → 审核 → 实施**:架构设计需要至少一轮顶级架构师视角审查通过后才进入实施。审查中发现的真问题在本文件迭代修复,**不是上来就执行**
- **单 topic 承载**:一次只一个 staging topic,与 active-problem 的"一次只一个问题"纪律同构。多个 staging 并存 → 拆到 `drafts/` 或独立 spec,不堆本文
- **顶部原则段**:本文档自身维护规则,永久稳定
- **内容区结构**:每个 staging topic 必须按"明确需求 → 架构设计"两段式组织
  - **明确需求**:**严格保留用户原话精确表达的产品决策**,不擅自扩展、不引入未确认的次要事实、不写"哪些不在范围"等推断内容。任何对此段的修改都必须经过产品方向重新对齐(走 active-problem 流程,而非直接改本段)
  - **架构设计**:实施层面的具体方案(目标 / 层次 / trade-offs / 清单 / 验收)。**本段是审查与迭代的主战场**,所有 grep 验证、调用链梳理、边界判断、范围确认都在本段做,审查发现的真问题在此段精确修复,直到审查通过才动手实施
- **重启规则**:上一个 staging 沉淀完毕,下一个启用前**整段重写**"当前 staging"——不要在旧内容上叠加
- **绝不留模糊问题**:已明确才放本文件,有疑问回 active-problem 重新对齐
- **绝不长期残留**:实施完成立即清理(整段清空回模板态),staging 不是"已完成内容博物馆",归档去 problems / specifications

---

## 当前 staging:`/resume` 对话删除功能

### 明确需求

1. **`/resume` 候选列表的 argument hint 行替换为"delete ctrl+d"功能区**:现状该行渲染当前参数的 ArgSchema(`/resume` 的 `conversation` 参数 kind=`async-enum`,显示 `[conversation: …]`),但 dropdown 已显示候选列表,hint placeholder 零信息量。改为显示 "delete ctrl+d",承载"删除选中对话"功能入口
2. **二次按键确认删除**:用户在候选列表选中某条对话后,第一次按 `Ctrl+D` → **当前选中的对话行整行变红色背景填充 + 浅色文字**(对齐 Claude Code 删除二次确认的危险动作警告样式,视觉焦点直接落在"要被删的那条对话"上 —— 用户一眼看到自己要删哪条),同时底部 argument hint 行**仅文案切换**为 "再按一次 ctrl+d 确认删除"(不动背景);第二次按 `Ctrl+D` → **干净彻底删除当前选中的对话**(物理删除,非软删除 —— transcript / meta / 整个 conversation 目录全删)
3. **准备态取消**:第一次按 `Ctrl+D` 后,**任何其他按键**(↑↓ 切换候选 / 改 query / Esc / Enter / 普通字符等)都取消准备态,选中行恢复默认选中态渲染(红色背景填充移除,❯ + 高亮文字),底部 argument hint 行文案恢复 "delete ctrl+d"
4. **删除当前正在使用的对话**(列表标 "← 当前" 那条):删除后**自动新建空对话无缝衔接**(用户当前 active conversation 切到新对话)
5. **删完最后一个对话(列表空)**:**自动新建空对话**(与启动 auto-resume `findLatest` 无 latest 时降级 create default 的语义一致)
6. **范围**:main 模式 + work 模式都生效(各自 scope 下的 conversation 列表),即在 work 模式下 `/resume` 列出的是当前 work scene 的 conversations,删除也只动该 scene 域
7. **Ctrl+D 原语义完全释放**:删除 Ctrl+D 在 `typeahead-input.ts:590-601` 的两个原语义 —— ① buffer 空时 `fireCancel("ctrl-d")` REPL EOF 退出;② buffer 非空时 `deleteForward()`(删 cursor 后字符)。Ctrl+D 仅在 typeahead `conversation` 候选激活时生效作"删对话",其他场景 no-op。理由:退出语义被 Ctrl+C 完全覆盖(双击 Ctrl+C 退出协议)、deleteForward 是冷门 readline 默认(99% 用户用 Backspace 从尾删),释放 Ctrl+D 避免三层条件判断与误删风险(用户在 `/resume xxx` 输 query 时 typeahead 已激活,若 Ctrl+D 仍保留 deleteForward 会触发"想删 query 字符却删了对话"的误操作)

### 架构设计

**总览**:删除能力作为 typeahead 通用基础设施的**可插拔扩展**,而非"对话删除"专属硬编码。`ArgChoiceProvider` 接口加可选 `delete?` 方法,任何 async-enum 类型(目前只 conversation,未来 /people 等同款)opt-in 即可获得"delete ctrl+d"功能,Panel / InputController / Broker 零额外感知具体业务。改动跨 4 层 / 5 个模块,职责严格分离。

**关键事实**:
- `ConversationRepository.delete()` (repository.ts:158-172) 是**软删除 rename 到 `~/.zhixing/trash/<id>-<ts>/`**,注释说"7 天后由外部清理",但**全仓 grep 无 restore 入口、无 trash 清理脚本** —— 是"永久残留"死代码软删
- WorkSceneRegistry 在前 staging 已**废弃 trash 语义**(`registry.test.ts:162` 测试断言"不会创建 trash 目录"),conversation 这条是漏跟进的架构债
- `delete()` 有 `isDefault` 守卫(L160-162),与需求"删当前对话(可能是 default)无缝衔接"冲突
- `conversationArgProvider`(repl.ts:1704)用闭包捕获 `state`(convRepo + store),加 `delete()` 方法天然就近
- typeahead 状态机权威在 `TypeaheadBroker`(`@zhixing/core/typeahead`),Panel 纯订阅 `TypeaheadSessionState` 渲染;InputController 持 keypress 但不持 typeahead 状态

#### 模块边界与职责

| 层 | 职责 | 不做 |
|---|---|---|
| `ArgChoiceProvider` 接口 | 加可选 `delete?(value, signal): Promise<void>` —— 仅物理删除该候选 | 不管业务编排(切对话 / 自动新建) |
| `TypeaheadSessionState` / `TypeaheadBroker` | 加 `deletable: boolean`(当前激活 trigger 是否支持 delete)+ `deletePending: string \| null`(当前准备删的 `SuggestionItem.id`);`SuggestionProvider` 接口加新 hook `computeDeletable?(match): boolean`(与 `computeGhostText` / `computeArgumentHint` 同款 opt-in 扩展点 —— broker 是通用 provider 抽象层,**不能跨层访问** `ArgumentProviderData` / `ArgChoiceProvider` 等下层数据结构;让 provider 自决);broker 在 `setLoadingFinished` 调 hook 写入 `state.deletable`;加 `markDeletePending(sessionId, suggestionId \| null)` 作为该字段**唯一**变更入口;**`deletePending` 字段单源不变量**:`setSessionState` 入参类型 `Omit<TypeaheadSessionState, "deletePending">`,内部强制设 `null`,任何走 `setSessionState` 的 mutate 路径(含 broker.ts:338 用 `...session.state` spread 续 typing 路径)自动 reset → 实现需求 3"任何其他按键取消" 由 broker 自身保证,InputController 零额外职责;`markDeletePending` 单独走专属内部 setter(改字段 + 调 emit helper),不复用 setSessionState;加 `refresh(sessionId): void` API —— 语义"强制重新 query 当前 trigger,canonical(`suggestions` / `selectedIndex` / `ghostText` / `argumentHint`)重置 + `loading=true`",`onCandidateDelete` 完成后由 InputController 调用触发候选列表刷新 | 不管 UI / 不直接调 provider.delete |
| `TypeaheadPanel`(tui/typeahead-panel.ts) | 纯订阅渲染:① 选中行渲染时 `state.deletePending === item.id`(对比 SuggestionItem.id,typeahead 现有唯一标识)→ 整行红色背景填充 + 浅色文字(不走原 `dotted-row` highlight 路径,红背景已足够 focus);② argument hint 行分流(deletable + pending → "再按一次 ctrl+d 确认删除" / deletable + 非 pending → "delete ctrl+d" / 非 deletable → 原 `renderedHint`) | 不持交互状态 / 不知道具体业务 |
| `InputController`(typeahead-input.ts) | Ctrl+D 完全重写:仅在 `state.deletable && state.suggestions.length > 0 && state.selectedIndex >= 0` 时生效;第一次按 → `broker.markDeletePending(sessionId, selected.id)`;第二次按 → `await onCandidateDelete(selected)` callback(接收完整 SuggestionItem)→ **callback 完成后调 `broker.refresh(sessionId)` 触发候选列表刷新**(否则 state.suggestions 残留删前列表导致视觉残留 + selectedIndex 指向已不存在候选);**其他场景 no-op**(原 EOF + deleteForward 两语义彻底删) | 不管业务 / 不管 typeahead 状态机内部 |
| `onCandidateDelete` callback(repl.ts 注入) | 签名 `(item: SuggestionItem) => Promise<void>`,接收完整 SuggestionItem,业务编排:从 `item.acceptPayload.metadata.argValue`(ArgumentProvider 构造候选时注入的约定字段)提取业务 value(conversation id)→ `await provider.delete(value)` → 若 `value === state.conv.conversationId` 则创建新空对话 + 切 active + reset 视图层 + `onConversationChanged()` 通知 | 不直接操作 typeahead state |

#### 关键设计决策

**决策 1:`ConversationRepository.delete()` 改真物理删除 + 释放 `isDefault` 守卫**
- 改 `fs.rm(srcDir, { recursive: true, force: true })` 替代 rename to trash
- 删除 trash 路径计算 + import + 注释 + `repository.test.ts:253` "删除移入 trash 目录" 测试改为 "删除物理删除目录"
- 释放 `if (conversation.isDefault) throw` 守卫:**事实校正** —— grep 全仓 `ensureDefault` 生产路径**零调用**(repl.ts 启动走 `findLatest` + `convRepo.create({...})`,非 `ensureDefault`),`isDefault` 字段在生产对话上一直 `false`(repository.ts:130 `create` 时硬编码 `false`),`isDefault` 守卫(delete L160-162、archive L150-151)从未在生产触发过 —— 是永不触发的死分支。释放守卫即清理死分支(代码层面允许删任何对话,生产对话因 `isDefault` 一直 false 行为等价不变;若未来恢复 `ensureDefault` 调用,被删后下次调 `ensureDefault` 自动重建固定 id,与"语义清楚化"目标兼容)
- 对齐 WorkSceneRegistry 已确立的"废弃 trash"纪律,消除架构债
- **范围控制**:`ensureDefault` / `DEFAULT_CONVERSATION_ID` / `isDefault` 字段整体是更大的死代码债(仅测试在用,生产路径零调用),**本 staging 不做整体清理**(独立 task,避免范围 creep)

**决策 2:`deletable` 由 broker 调 provider 新 hook 自决(不跨层访问 provider 内部)**
- `SuggestionProvider` 接口加 opt-in hook `computeDeletable?(match): boolean`,与 `computeGhostText` / `computeArgumentHint` 同款扩展点
- `ArgumentProvider` 实现:`return data.currentSchema?.kind === "async-enum" && !!data.currentSchema.provider.delete`;`CommandProvider` / `FileProvider` 等不实现(默认 false)
- broker 在 `setLoadingFinished` 调 hook 写入 `state.deletable`,**不直接读** `ArgumentProviderData` / `ArgChoiceProvider` 等下层结构(broker 是通用 provider 抽象层,跨层访问破坏抽象边界 —— hook 让 provider 自决是干净分层)
- typeahead-input / Panel 不需感知具体 schema/provider 类型,仅读 session state
- 可插拔性:未来其他 async-enum 加 `provider.delete` 即自动启用 UI,broker / typeahead-input / Panel 零额外感知

**决策 3:`deletePending` 放 broker session state 而非 InputController local + 严格单源不变量**
- Panel 是纯订阅渲染(单源真相 = broker state),InputController local 状态需 Panel 主动 query 破坏单源
- broker state 让 Panel 自动 reactive 渲染,与既有 ↑↓ 选中状态同款数据流
- **deletePending 字段单源不变量**(关键):`setSessionState` 入参类型 `Omit<TypeaheadSessionState, "deletePending">`(类型层面禁止 caller 通过 setSessionState 设置 deletePending),内部强制 `null`;所有走 setSessionState 的 mutate 路径(含 broker.ts:338 `...session.state` spread 续 typing 路径,该路径若按 `...session.state` spread 会 carry 旧 deletePending 导致 stale,本不变量根治)自动 reset deletePending → 需求 3 "任何其他按键取消" 由 broker 单源不变量保证,InputController 无需在每个 keypress 路径显式取消(零职责漂移)
- `markDeletePending` 是 deletePending 字段**唯一**变更入口,走专属内部 setter(改字段 + 调既有 emit listeners helper),与 setSessionState 路径正交

**决策 4:`provider.delete` 仅物理删除,业务编排在 cli 层 onCandidateDelete**
- provider 是 typeahead 通用基础设施(@zhixing/core),不知道 conversation 业务(active id / scope / runtime / view layer)
- onCandidateDelete callback 在 cli repl.ts 闭包定义,捕获完整业务上下文
- main scope + work scope 都生效:`state.conv.convRepo` 是 RoutingConversationRepository(前 staging 已落地),自动跟随 active mode,callback 零额外分支

**决策 5:argument hint 行分流策略**
- deletable + pending → "再按一次 ctrl+d 确认删除"
- deletable + 非 pending → "delete ctrl+d"
- 非 deletable → 原 `renderedHint`(向后兼容,不破坏其他命令 ArgSchema 的 hint 渲染)
- 单一位置(typeahead-panel meta 段)分流,Panel 知道 deletable + deletePending 即可决定文案

**决策 6:`deletePending` 存 `SuggestionItem.id`,`onCandidateDelete` 接收完整 SuggestionItem**
- `deletePending: string | null` 存的是 `SuggestionItem.id`(typeahead 现有唯一标识,格式如 `arg:resume:conversation:<conv_id>`),不存"业务 value":SuggestionItem.id 是 typeahead state 内一阶标识,Panel 对比 `item.id === state.deletePending` 渲染红背景,与 selectedIndex 对比同款数据流;若改存业务 value(如 conversation id),Panel 要再解析 id 后缀对比破坏抽象
- `onCandidateDelete` callback 签名 `(item: SuggestionItem) => Promise<void>`:接收完整 SuggestionItem,callback 内部从 `item.acceptPayload.metadata.argValue`(`ArgumentProvider` 在构造候选时已注入,见 `argument-provider.ts:184`,是**既有约定字段**而非本 staging 新增)提取业务 value,而非从 id 后缀解析 — id 后缀格式是 typeahead 内部约定,callback 不应耦合
- 既有 `metadata.argValue` 约定直接复用,**零新增字段**,callback 取 `metadata.argValue as string` 即得业务值

#### Trade-off

- 不在 InputController 内推导 deletable:推导需要看 ArgSchema + provider.delete 是否存在;ArgSchema 由 ArgumentProvider 持有,InputController 反向访问破坏分层 —— broker 持完整 schema 信息(query 时拿到),计算 deletable 后写入 state 是最干净的
- 不让 provider.delete 自带 post-delete 编排:provider 应保持通用 typeahead 基础设施职责,业务上下文(active conversation / runtime / scope)归 cli 层
- 不保留 trash 软删除作"安全网":trash 无 restore + 无清理 = 永久残留,既不是"安全"也不是"网",纯架构债;用户原话明确"干净彻底"
- 不删 default 概念整体(仅释放守卫):本 staging 不做无关清理范围 creep;default 仍是启动 fallback 的预创建 id,删后重建无副作用,后续 staging 可独立评估是否废弃
- 准备态文案区分 deletable/非 deletable:其他 ArgSchema(非 conversation,如未来 enum 类型 `/permission` 的 level 参数)仍走 `renderedHint` —— 不破坏既有命令的 hint 渲染
- **Ctrl+D 释放后 EOF 退出语义断层**:用户在 buffer 空 + typeahead 未激活(如刚启动 cli)按 Ctrl+D 完全 no-op,Mac/Linux 用户 Ctrl+D 退 shell 习惯被破坏。接受静默 no-op trade-off(Ctrl+C 双击退出协议仍能覆盖退出场景;`/help` 已是命令清单权威,不专门为 Ctrl+D 加说明 —— 避免每个被释放的旧绑定都要文档解释,反而污染 /help)

#### 实施步骤(渐进可验证)

按依赖关系 + 风险递增:

**Step 1**:`core/conversation/repository.ts` `delete()` 改物理删除 + 释放 default 守卫 + 删 trash 相关 import / 注释;更新 `repository.test.ts`(改"移入 trash"为"物理删除"测试 + 改"default 不可删"为"default 可删")。验:`pnpm --filter @zhixing/core test`

**Step 2**:`core/typeahead/types.ts` `ArgChoiceProvider` 加 `delete?(value, signal): Promise<void>`;`SuggestionProvider` 加 opt-in hook `computeDeletable?(match): boolean`;`TypeaheadSessionState` 加 `deletable: boolean` + `deletePending: string | null`;`ArgumentProvider` 实现 `computeDeletable`(返回 `data.currentSchema?.kind === "async-enum" && !!data.currentSchema.provider.delete`)—— `metadata.argValue` 既有(`argument-provider.ts:184`)直接复用无需新增;`broker.ts` 改造 `setSessionState` 入参类型为 `Omit<TypeaheadSessionState, "deletePending">` 内部强制 `null` + 抽 `emitSessionChange(session)` 私有 helper 复用 listener 通知 + 加 `markDeletePending(sessionId, suggestionId | null)` 走专属内部 setter(改字段 + 调 emit helper)+ 各 6 处 setSessionState 调用 build 的对象不带 deletePending field(broker.ts:338 spread 路径仍 spread `session.state` 是 OK 的 —— `setSessionState` 类型层面禁止 deletePending 字段,内部强制 null,spread 后被覆盖)+ `setLoadingFinished` 调 `provider.computeDeletable?.(match) ?? false` 写入 `state.deletable` + 加 `refresh(sessionId)` API(实现:从 session.lastContext / activeProvider 重新构建 TriggerContext + match,调 runQuery 强制走 `isNewTrigger=true` 分支让 canonical 重置为 empty + loading=true,resolve 后看到新候选)。补 broker 单测覆盖:① 各 mutate 入口自动 reset deletePending ② markDeletePending 设置 → 后续 mutate 自动清 ③ computeDeletable hook 命中/未命中两态 ④ refresh 后 state canonical 重置 + 重新 query

**Step 3**:`cli/tui/typeahead-panel.ts` `buildCandidatePayload` 加 deletePending 比对参数(红背景填充);meta 段 argument hint 分流(deletable + pending / deletable / 非 deletable 三态)。补 panel 单测三态

**Step 4**:`cli/typeahead-input.ts` Ctrl+D 完全重写(删原 EOF + deleteForward 两语义 + 相关 `tryAtomicKeypress("delete")` 路径同步删,新逻辑见模块表);加 `onCandidateDelete?: (item: SuggestionItem) => Promise<void>` 到 InputControllerOptions;第二次按 Ctrl+D 路径:`await onCandidateDelete(selected)` 完成后**调 `broker.refresh(sessionHandleId)`** 触发候选刷新(避免删后视觉残留 + selectedIndex 指向已不存在候选);更新既有 typeahead-input 测试(删原 Ctrl+D 行为期望)

**Step 5**:`cli/repl.ts` `conversationArgProvider` 加 `async delete(value, signal)`(`await state.conv.convRepo.delete(value)`);定义 `onCandidateDelete = async (item: SuggestionItem) => { ... }` 闭包(从 `item.acceptPayload.metadata?.argValue` 提取 value 后做物理删除 + 当前对话判断 + 自动新建空对话切换 + onConversationChanged);传入 InputController(同 R2 clearScreenToInitial 注入模式)。verify main + work 两 scope 行为一致(state.conv.convRepo 自动跟随 RoutingConversationRepository)

**Step 6**:跨包 typecheck + test;chrome 终端人工验:① /resume 选第二条 Ctrl+D → 选中行红背景 + hint "再按一次..."  ② 任意键 → 准备态消失 ③ 第二次 Ctrl+D → 真删 + 列表刷新 ④ 删当前 → 立即切到新建空对话 ⑤ work 模式下同款行为 ⑥ 删 default 对话(原守卫释放后)→ 正常物理删除

#### 验收

- `pnpm -r typecheck` 严格 tsc 全包 exit 0
- `pnpm -r test` 全包零回归(基线 5193 + 新增 broker/panel/repository 单测)
- `core/repository.ts` trash 相关代码 grep 零残留(`grep -rn "trash" packages/core/src/conversation/`)
- chrome 终端 /resume 按 Ctrl+D 视觉对齐 Claude Code 截图样式
- main + work 模式各自 /resume + Ctrl+D 行为一致
- 删除当前对话 → 立即切到新建空对话(turnCounter=0 / messages=[])
- 删完最后一个 → 同款无缝衔接
- 删除非当前对话 → active 不变,列表减一

---

> 最近一次沉淀:
>
> - **REPL 输入与命令体验三项小改**(2026-05-21 完成):需求三条 R1 首位 `、`→`/` 别名规范化(中文输入法误打 `、` 直接当 `/` 解析;显示层保留 `、` / 解析层走 `/`)/ R2 `/clear` UI 重置回刚进入交互模式初始态(advisories + welcome chrome + 一行 cleared notice,warnings 经 extraLines 注入避免清屏丢失可观测性)/ R3 `/workscene` → `/work` 改名(16 处字面同步,实施时发现 staging 统计漏了 work-mode.md:64 一处并补改)。新增 [`packages/cli/src/runtime/leading-slash-alias.ts`](../../packages/cli/src/runtime/leading-slash-alias.ts) `SLASH_ALIASES` 单源数组 + 两公开 API:单字符串 `normalizeLeadingSlashAlias(input)` 给 syncBroker(直接 override `ctx.draft`)、双字符串 `normalizeLeadingSlashAliasInExpanded(target, guard)` 给 submit(基于 `rawDraft.trim()` 首位判断、在 `expanded.trim()` 上替换,避免 paste 长内容折叠为 token 后首位恰为 `、` 时被误识别为命令);typeahead-input.ts syncBroker 用 spread + override draft、submit 用 InExpanded 双参数;repl.ts 顶层 startRepl 闭包 `clearScreenToInitial(extraLines?: readonly string[])` 复用 `rebuildAfterResize` + `initialRegionLines` 单源原语,buildSlashCommands 加注入参数,/clear handler 收集 warnings push 到本地数组(去前后 `\n`)、末尾按是否 chrome 分流(chrome 整屏重建 [advisories,"",welcome,"",warnings...,clearedNotice] 单一来源 / legacy 逐行 cliWriter)。Ctrl+D 原 deleteForward + EOF 语义不动(本 topic 不涉及)。沉淀去向:[`leading-slash-alias.ts`](../../packages/cli/src/runtime/leading-slash-alias.ts) 顶部 docstring 为首位权威(单源数组 + 两 API 语义分叉 + 单字符约束 + paste 边界推演);9 包 5193 tests 零回归(基线 +14 单测含 paste 边界 6 case),严格 tsc 全包 exit 0
> - **work 模式对话能力对齐 main**(2026-05-21 完成):需求三条 R1 `/resume` 解禁 / R2 `/new` 解禁 / R3 进入 scene 按触发源分流(用户 `/enter` 走 auto-resume / LLM `workmode_enter` 工具始终新建)。实施:删 `/resume` 和 `/new` 的 work-mode handler guard 共 8 行(scope 天然分隔由 `state.conv.convRepo` 自动跟随 → handler 零改动复用);新增 [`packages/cli/src/runtime/workscene-conversation.ts`](../../packages/cli/src/runtime/workscene-conversation.ts) 纯函数 helper 模块(三路径 A/B/C 正交:A latest 不存在直 create / B latest 存在 load+get 成功 recovery / C latest 存在加载失败降级 create + warning;`warning` 由 caller 在 try 成功后输出避免双消息困惑);`applyModeSwitch` enter 按 source 分支(LLM 直 create / command 调 helper),`undo` 分支 `loaded === null` 才 push delete(recovery 路径保留用户历史),`wStore.init` 仅 create 路径调用(recovery 不覆盖 transcript),`startMessages` 按"触发源 × 路径"三态组装(LLM `[triggerMsg]` / recovery `loaded.messages` / create `[]`)。顺手清理 baseline:`repl.ts` 死变量 `cwd` 删 + `serve/command.ts` `zhixingHome` 未定义补齐(后者是 `zhixing serve` + `config.messaging` 路径必崩的 production bug)。沉淀去向:helper 顶部 docstring 为首位权威(设计原则 / 三路径 / 触发源分流 / warning 输出协议均在);[work-mode.md](specifications/work-mode.md) 后续按需补"对话获取策略"节(独立 task,不阻塞);全包 5179 测试零回归,严格 tsc 全包 exit 0
> - **`/switch` → `/resume` 改名 + 删序号匹配**(2026-05-21 完成):REPL 切换对话命令名从 `/switch` 改为 `/resume`(对齐 Claude Code 用户预期),无 legacy alias 直接换;handler 内删除"按序号选择"匹配段 + 列表渲染去序号编号,保留 ID 精确 + 名称模糊两档解析(有 name fallback id,序号是冗余信号源);全仓代码 + 测试 + 15 个 spec/README/staging 沉淀的 `/switch` 字面同步,grep `/switch` 零命中。架构升级:`argsByName` 字典 key 同步 `switch → resume`(避免 cmd.name 改而 typeahead conversation 选择器查不到的隐性 bug);列表 label fallback 从 `(未命名)` 改为 `chalk.dim(c.id)`,与 typeahead `c.name || c.id` 一致
> - **transcript schema 历史一致性清理**(2026-05-21 完成):4 项审查识别的债务(`conversation-model.md §7.1` 旧架构描述残留 + `TranscriptHeader.projectPath` 死字段 + `writeHeader/readHeader` 生产零调用 + `session-persistence.md` 半完成归并)彻底处置。代码层:删 `projectPath` 字段 + TranscriptStore 构造签名变更 `(convDir, cwd, options?) → (convDir, options?)`(8 处 caller 同步)、删 `writeHeader/readHeader` 函数 + index re-export + 测试两类用途分别处理(测函数本身的 describe 整段删 / fixture 用法改 fs API)、清理 `normalize.test.ts` dead import。文档层:`conversation-model.md §7.1` 重写对齐 standalone cli 现实(RuntimeSession 替代 ConversationManager/SessionRuntime/CliChannel 旧描述)+ §7.3 表格修正 + §9.2 整段重写承接 session-persistence §2.3 JSONL 行格式细节 + §9.5 整合 §5.1 单向数据流意图;同款散落到 work-mode.md 目录树 + ConversationScope variant + TranscriptStore 签名描述、conversation-scope-flattening.md "后续评估项"标记为"已清理";引用方 context-architecture / usage-display 切到 conversation-model;session-persistence.md 删 §一-§八 正文留 18 行 stub(按维度索引指向当前权威)。沉淀去向:[conversation-model.md §九](specifications/conversation-model.md) 单一事实源;9 包 5174 tests 零回归
> - **新对话自动命名**(2026-05-21 完成):新对话第一轮 turn 完成后用 light LLM 生成短主题名,落 `conversation.meta.name`。[core/conversation/auto-name.ts](../../packages/core/src/conversation/auto-name.ts) 提供 `InferConversationName` 函数依赖注入 + `maybeAutoNameFirstTurn` 协议(主路径同步 short-circuit / 异步分支二次门控 / 全 catch swallow);cli 装配 inferer 闭包(动态访问 `session.runtime.callText` 跟随 work mode active runtime 切换),commitTurn 成功 + `turnCounter++` 之后 fire-and-forget 触发钩子;Phase 0 顺带修复 work 模式 `worksceneRepo.create({ name: scene.name })` → `create({})` 的"N 次进同 scene 产生 N 个同名对话"bug。沉淀去向:[core/conversation/auto-name.ts](../../packages/core/src/conversation/auto-name.ts) 顶部 docstring 为首位权威(设计原则 / 跨层职责 / 触发协议 / sanitize 规则均在);[conversation-model.md](specifications/conversation-model.md) 后续按需补"自动命名"节(独立 task,不阻塞本 staging)
> - **CLI 启动参数清理**(2026-05-21 完成):彻底删除 `-c, --continue` / `-r, --resume [id]` / `-n, --name <name>` 三个启动参数 + 字段 + 透传 + `interactiveConversationPicker` 函数 + `Conversation` 死 import。架构升级:启动参数纯粹只承载"运行模式 / 环境配置"维度,对话选择维度统一收敛到 REPL 内 `/resume` / `/new` / `/name` + auto-resume。文档:session-persistence.md / phase2-complete-agent.md / ADR-005 决策 6 三处补 DEPRECATED/SUPERSEDED 标注
> - **`/conversations` 与 `/sessions` 冗余命令清理**(2026-05-21 完成):删除 `/conversations` handler + typeahead 注册 + `["sessions"]` 别名;架构升级:`/help` 改读 REPL_COMMAND_META 单源(过滤 hidden 与 typeahead dropdown 一致),消除命令可见性双轨。`/resume` 作为查看+切换对话唯一入口
> - **摘要质量升级**(2026-05-20 完成):主对话压缩(LLMSummarize)模型档位从 light 升级到 main;`compaction-llm.ts` 拆为 `createSummarizeCallLLM` + `createMemoryFlushCallLLM` 两个独立 helper;`MAIN_SESSION_PROMPT` 重写为吸取 opencode 精华的新 7 段(约束与偏好 / 关键决策 / 进度三态)。沉淀去向:
>   - [secondary-llm-capability.md ADR-SLLM-009](specifications/secondary-llm-capability.md) — 角色分流决策权威
>   - [llm-summarization.md](specifications/llm-summarization.md) — 7 段结构 / prompt / 校验同步更新到代码现状
>   - [thinking-control.md](specifications/thinking-control.md) / [work-mode.md](specifications/work-mode.md) / [subagent-execution.md](specifications/subagent-execution.md) — 引用同步
