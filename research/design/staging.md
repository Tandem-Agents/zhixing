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

## 当前 staging:`/work` 工作场景二级选择面板

### 明确需求

1. **`/work` 回车直接进入工作场景二级选择面板 + 输入区可继续 fuzzy 缩小范围**:现状 `/work` 无参数执行默认打印 `list` 纯文本,子命令全靠手敲字符串。改为 `/work` 回车 → 进入交互式二级面板(**样式复用 `/resume` 候选列表面板**:chrome 渲染 + ↑↓ 选择),候选项是工作场景列表;**输入行空出空格,用户可继续输入字符 fuzzy 缩小候选范围**(复用 `/resume` 的 arg-provider query 过滤 name/id 机制,行为一致)
2. **↑↓ 选择 + Enter 直接进入场景**:面板内 ↑↓ 移动选中,Enter 直接进入选中场景(等价现在的 `/enter`)。替代"先看列表 → 复制 id → /enter id"多步流程
3. **Ctrl+D 删除场景**:**复用 `/resume` 刚实现的删除交互** —— 第一次 Ctrl+D 选中行整行红背景 + hint 切 "再按一次 ctrl+d 确认删除",第二次确认删除,任意其他键取消准备态。物理删除(带 active guard:active 场景不可删,friendly error;用户 workdir 不动)
4. **Ctrl+R 重命名当前选中场景**:进入 inline 重命名输入态,**预填当前 name(可编辑字符修改)**,Enter 提交 / Esc 取消
5. **Ctrl+N 新建场景**:进入 inline 新建输入态(空输入),输 name + Enter 提交 / Esc 取消。新建场景的 workdir 暂不绑定(`workdir=undefined`,过渡期无 workdir,留待后续 topic 的"延迟绑定")
6. **hint 行按交互态切换**:默认态显示快捷键提示(进入 / delete ctrl+d / rename ctrl+r / new ctrl+n);重命名 / 新建 inline 态显示"Enter 提交 · Esc 取消"
7. **命令形式收敛 —— 面板成为唯一入口,手敲 id/参数的命令形式删除**(用户决策:让用户输 id 进场景是反人类的,面板做完后作为主要使用方式):
   - **删除** `/work` 全部 sub-command 字符串解析(list / add / remove / rename / archive / unarchive),`/work` 改为纯面板入口
   - **删除** `/enter <id|name>` 命令(handler + REPL_COMMAND_META 注册);面板 Enter 是进场景唯一入口
   - **删除** `/work add <name> --workdir <path>` 命令行(含 `--workdir`);workdir 设置完全交给 ② 延迟绑定,过渡期无法设 workdir
   - **砍掉 archive / unarchive 功能**(软隐藏整体移除;连带评估 `registry.setArchived` / `WorkScene.archived` 字段 / `list({includeArchived})` 参数 / LLM 工具是否有 archive action 的死代码清理 —— 架构设计阶段梳理范围)
   - **保留(底层 API / 函数,面板交互依赖,本就不是"命令")**:`registry.list/add/rename/get`、`session.removeWorkScene`(active guard)、`applyModeSwitch({kind:"enter"})`、`state.activeTurnPromise` await 纪律。这些是方法不是命令,面板直接调,无需"hidden 暴露"

**本 topic 范围拆分**(用户决策:拆分,大块独立):
- **本 topic 只做** `/work` 二级面板 UI(复用既有 typeahead 候选面板 + `/resume` 删除基础设施 + 新增 inline 文本输入态)+ Enter 进入场景 + Ctrl+D 删 + Ctrl+R 改名 + Ctrl+N 新建(name only)+ 命令形式收敛(需求 7)
- **拆出到独立 topic**(待架构,已记 [drafts/work-scene-workdir-binding.md](drafts/work-scene-workdir-binding.md)):② workdir 延迟绑定(进场景首次 file op 无 workdir 时问一次)+ ③ 拖拽/粘贴路径 normalize。两者涉及 agent file op 执行流中断交互,是更重的架构设计,不阻塞本 topic

### 架构设计

**总览**:三个核心架构动作 —— ① `/work` 与 `/resume` 完全同构(async-enum 候选 + accept 进入,`/enter` 逻辑并入 `/work`);② 把"候选列表的 inline 操作"统一建模为**可插拔的 inline-actions 能力模型**(重构上个 topic 的 `deletable`,delete/rename/create 一致处理);③ inline 文本输入态复用 `SelectOperationRegion` 的成熟 InputRegion + suspend/resume 协议(新建通用 `InlineTextPromptRegion`)。命令收敛删 sub-command + `/enter` + `add --workdir` + 砍 archive。

**关键事实**:
- `/resume` 范式:`resumeArgSchema`(async-enum)+ `conversationArgProvider` 闭包 + ArgumentProvider 接管候选 + accept 填充 submit → handler。`/work` 套同款即可
- `SelectOperationRegion`(security/select-operation-region.ts)是"chrome 内 inline 接管输入"的成熟范例:实现 `InputRegion`(renderLines + cursorPosition),`run()` acquire raw mode + stdin + keypress + `screen.attachInput(self)` → Promise,`finish()` release + `detachInput()` → resolve;**非弹窗、原地接管、与 InputController 同协议可互换**。docstring 明言"未来其他 inline modal 可直接复用"
- 上个 topic 的删除基础设施:`SuggestionProvider.computeDeletable?` hook + `TypeaheadSessionState.deletable` + `markDeletePending` / `refresh` + Panel 红背景 + `onCandidateDelete` 注入
- `/enter` handler(repl.ts:988)逻辑:解析 id 精确 / name 唯一匹配 → await activeTurnPromise → `applyModeSwitch({kind:"enter",sceneId},"command")`。与 `/resume` 解析同款纪律
- **archive 范围**:`registry.setArchived` / `WorkScene.archived` / `list({includeArchived})` 不只 `/work archive` 命令用 —— **LLM 工具 `workscene_change_approve` 也有 archive action**(system-prompt.ts:464、workmode-tools.test.ts)。用户确认**彻底移除整个 archive 概念**(范围 B,见决策 5)
- `InputController.suspend()/resume()`(typeahead-input.ts:266/302)已是 SelectOperationRegion 让位 typeahead 的现成协议

#### 决策 1:`/work` 与 `/resume` 同构,`/enter` 逻辑并入

- `/work` 注册 `workSceneArgSchema`(async-enum,`provider = workSceneArgProvider` 闭包捕获 `session.workSceneRegistry`),挂到 `argsByName.work`
- typeahead 选 `/work` → `execute=false`(有 required arg)→ buffer 变 `/work ` → ArgumentProvider 接管显示场景候选;**输入区继续输字符 fuzzy 缩小**(workSceneArgProvider.list 内 query 过滤 name/id,同 conversationArgProvider)
- Enter 接受候选 → `/work <sceneId>` submit → dispatch → `/work` handler → `applyModeSwitch({kind:"enter"})`
- **`/work` handler 重写**:从 6 sub-command 字符串解析,改为"`<idOrName>` → 解析(id 精确 / name 唯一匹配)→ await activeTurnPromise → applyModeSwitch enter" —— 即 **`/enter` handler 逻辑迁移过来**
  - **`args=""` 边界**(用户手敲 `/work` 直接 Enter 没走 typeahead 候选,或空场景列表面板内 Enter):不进场景、不报错,给 friendly 提示(`用 ↑↓ 选场景 Enter 进入,Ctrl+N 新建`)。**不打印纯文本 list**(本 topic 砍掉,与 `/resume` handler `args=""` 打印对话列表的旧行为分道)
  - **保留 `activeMode.kind !== "main"` guard**(/enter handler repl.ts:991 既有):已在 work 模式时 `/work` 提示"已在工作场景中,请先 /exit",与 `/enter` 当前行为一致。work 模式内直接切场景属后续需求,本 topic 不引入
- `/enter` 的 REPL_COMMAND_META 注册 + handler **删除**(逻辑并入 `/work`,底层 `applyModeSwitch` 函数不动)

#### 决策 2:inline-actions 能力模型(重构 `deletable`)

把"候选列表支持哪些 inline 操作"统一建模,**替代** 上个 topic 的单一 `deletable` 标志:

- `core/typeahead/types.ts`:
  - 新 `InlineActionSupport = { delete?: boolean; rename?: boolean; create?: boolean }`(`delete`/`rename` 是 item 级依赖选中,`create` 是 list 级不依赖选中)
  - `SuggestionProvider.computeInlineActions?(match): InlineActionSupport`(**替代** `computeDeletable`)
  - `TypeaheadSessionState.inlineActions: InlineActionSupport`(**替代** `deletable: boolean`)
  - `ArgChoiceProvider` 用**静态声明字段** `inlineActions?: InlineActionSupport` 表达能力,**替代**现有 `delete?(value, signal)` 方法(现有方法删除 —— 见下"声明 vs 执行")
- `broker.ts`:`setLoadingFinished` 调 `computeInlineActions` hook 写入 `state.inlineActions`(替代 `deletable` 字段 broker.ts:425-444);`makeEmptyState` 默认 `inlineActions: {}`(必填字段);`markDeletePending` / `deletePending` / `refresh` 不变(deletePending 单源不变量保留)
- `ArgumentProvider.computeInlineActions`:用 `match` 定位 `currentSchema.provider`,返回 `provider.inlineActions ?? {}`(仅 async-enum;`match` 参数用于选 provider,非 per-item 动态 —— 能力是 provider 级常量,active 场景"不可删"是执行层 guard 而非声明层)
- `TypeaheadPanel`(tui/typeahead-panel.ts:493):读 `state.inlineActions` 渲染 hint —— 支持的操作**拼成单行**(`delete ctrl+d · rename ctrl+r · new ctrl+n`,`·` 分隔),**严守 meta 恒 2 行**(hint 1 + shortcut 1)的 panel 高度恒等不变量(typeahead-panel.ts:490-491,inline-actions 命令必有 argumentHint,故 hint 行不空);`deletePending` 态时该行切到"再按一次 ctrl+d 确认删除"(覆盖其他操作 hint),删除准备态红背景渲染不变(读 `deletePending`)
- `InputController`:读 `state.inlineActions` 决定 Ctrl+D / Ctrl+R / Ctrl+N 是否生效（delete/rename 需 `selectedIndex >= 0`，create 不需要）

**为什么重构而非加平行 hook**:rename/create 若各加 `computeRenamable`/`computeCreatable` + `state.renamable`/`state.creatable`,会形成"3 个平行 hook + 3 个平行 state 字段"的重复模式 —— 这本身是架构债。统一 `inlineActions` 是可扩展最优:未来 `/people` `/skills` 等 async-enum 声明自己支持的 inline 操作集,UI 零成本自动适配。重构范围:`computeDeletable → computeInlineActions`、`state.deletable → state.inlineActions.delete`、broker / Panel / InputController / 既有 broker 单测同步(上个 topic 的 deletable 单测改为 inlineActions.delete 断言)

**为什么静态声明字段而非 `delete?()` 方法**:能力声明(驱动 UI)与操作执行(有副作用 + 业务编排)是两个关注点,必须分离。删除/重命名的执行需要 active 切换、fallback 新建等 cli 业务编排 —— **只能在 cli 层**(core provider 不该知道"删当前对话要新建");而物理操作(`convRepo.delete` / `removeWorkScene` / `registry.rename/add`)cli callback 直接可调(`session` / `state.conv` 全程在作用域)。若用 `delete?()` 方法承载能力探针,只有两条路且都劣:**(a)** callback 不调它 → 死方法体(现有 `ArgChoiceProvider.delete?` types.ts:174 + `conversationArgProvider.delete` repl.ts:1725 即如此,从不被调,broker 仅读 `typeof === "function"` 探针);**(b)** callback 调它 → provider 须提升出 `if (useTypeahead)` 块(`conversationArgProvider` 现为块内 const repl.ts:1695,`onCandidateDelete` 在块外 repl.ts:1808,作用域不通)且只夹一层无封装价值的转发。静态字段把"声明"留 provider(纯数据)、"执行"留 callback(直调底层),无死代码、无作用域重构、关注点清晰

#### 决策 3:inline 文本输入态 —— 复用 InputRegion + suspend/resume

新建通用 `InlineTextPromptRegion`(`packages/cli/src/tui/inline-text-prompt.ts` 或同级),**同 SelectOperationRegion 架构**:

- 实现 `InputRegion`(renderLines:prompt 行 + 输入行;cursorPosition)
- `run(): Promise<string | null>` —— acquire raw mode + stdin + keypress + `screen.attachInput(self)`;handleKeypress:普通字符 → 内部 buffer.insertText,Enter → resolve(text),Esc → resolve(null),backspace/cursor → 文本编辑;`finish()` release + `detachInput()` → resolve
- 选项:`{ prompt: string; prefill?: string; placeholder?: string; screen }`(rename 传 prefill = 当前 name,new 传空)
- **触发机制 —— 主循环驱动,非 callback fire-and-forget**:inline edit 必须 `suspend` inputController 让 InlineTextPromptRegion 接管 keypress,这与 `onCandidateDelete`(**不** suspend,typeahead 仍 active,只删数据 + refresh)本质不同。suspend/resume 的唯一自然协调点是 **REPL 主循环**(它知道何时不该 await 普通输入);若在 `handleKeypress` 事件回调里 fire-and-forget 自己 suspend 自己,主循环正 `await waitOnce()` 对 suspend 全程不知情,callback 抛错未 resume 即 inputController 永久 suspend + 主循环永久 await = 死锁。故走 waitOnce result:
  - `InputLineResult` 加第 4 个 variant `{ kind: "inline-edit-request"; editKind: "rename" | "new"; item?: SuggestionItem }`(现有 3 个:text / command-dispatched / cancelled)
  - **触发不能复用 `fireSubmit`**:其类型签名是 `Extract<InputLineResult, text | command-dispatched>`(typeahead-input.ts:151 `SubmitHandler` / 574 `fireSubmit`),不接受 inline-edit-request,且"请求编辑"不该混入"提交"语义。故新增**独立第三路**(对称于现有 submit / cancel 两路):`InlineEditHandler` 类型 + `inlineEditHandler` 槽,`waitOnce` 的 `finish` 同时清三个 handler 并设 `this.inlineEditHandler = (req) => finish(req)`;新增 `fireInlineEdit(req)` 方法
  - `InputController.handleKeypress`:Ctrl+R(`inlineActions.rename && selectedIndex >= 0`,`selected` 同 Ctrl+D 取法)→ `fireInlineEdit({ kind: "inline-edit-request", editKind: "rename", item: selected })`;Ctrl+N(`inlineActions.create`)→ `fireInlineEdit({ kind: "inline-edit-request", editKind: "new" })`(令 waitOnce resolve)
  - **REPL 主循环消费**:`result.kind === "inline-edit-request"` → `inputController.suspend()` → `new InlineTextPromptRegion({ prompt, prefill }).run()` → 拿 text → `session.workSceneRegistry.rename(sceneId, text)` / `add({ name: text })`(决策 4;主循环作用域内 `session` 直接可调,不引用 provider;try/catch 染红错误)→ `finally { inputController.resume(); inputController.refreshCandidates(); }` → `continue` 回 waitOnce。主循环明确知道"此刻在 inline edit、不在等待普通输入",suspend/resume 由它驱动,无死锁窗口
    - `inputController.refreshCandidates()`:**新增 public 方法**,内部 `if (sessionHandleId) broker.refresh(sessionHandleId)`。主循环不持有 `sessionHandleId`(InputController 私有字段,typeahead-input.ts:176),故封装而非裸调 `broker.refresh` —— 与删除路径"InputController 在 onCandidateDelete 返回后自 refresh"(typeahead-input.ts:791)对称,不向主循环泄露内部 id

**为什么 InputRegion + suspend/resume 而非 InputController 内嵌子模式**:① 复用 SelectOperationRegion 成熟协议(团队已熟悉,raw mode / stdin / keypress 资源管理同款,零新模式);② typeahead 状态零污染(suspend 期间冻结,命令 buffer 不动,resume 原样恢复);③ inline 视觉(chrome 内接管,非弹窗,符合产品形态);④ 可复用(`InlineTextPromptRegion` 是通用单行文本收集,未来 ② workdir 延迟绑定的路径输入、其他场景直接复用)

**债务标注(非本 topic 引入,延续已有模式)**:`InlineTextPromptRegion` + `SelectOperationRegion` + `InputController` 三个 InputRegion 实现各自重复"acquire raw mode + stdin + keypress + attachInput / release"资源管理样板。这是**已有债务**(InputController + SelectOperationRegion 已重复一次)。抽公共"InputRegion 资源管理 helper"是影响三方的更大重构,**超本 topic 范围,标注为独立 task**;本 topic InlineTextPromptRegion 延续既有样板模式(与 SelectOperationRegion 一致),不抽公共

#### 决策 4:删除/重命名/新建分流(provider 声明能力 + callback 执行)

能力声明在 provider(决策 2 的 `inlineActions` 静态字段),执行在 cli callback 直调底层 —— 作用域天然通:`session` 是 runRepl 参数全程可见,`state.conv.convRepo` 正是 `onCandidateDelete`(repl.ts:1808)现状所调。

- **provider 只声明 `inlineActions`,不实现执行方法**:
  - `conversationArgProvider`:`inlineActions: { delete: true }`(删除现有死代码 `delete?` 方法 repl.ts:1724)
  - `workSceneArgProvider`(repl.ts `if (useTypeahead)` 块内 const,捕获 `session`):`inlineActions: { delete: true, rename: true, create: true }` + `list`(query 过滤 name/id)
  - `conversationArgProvider` 不声明 rename/create → `inlineActions.rename/create` 为 undefined,`/resume` 面板不显示 Ctrl+R/Ctrl+N
- **cli callback 直调底层执行 + 业务编排 + UI 反馈**:
  - `onCandidateDelete`(repl.ts:1808 块外,加 work 分流):按 `item.acceptPayload.metadata.commandId` 分流 —— `resume:repl` → `state.conv.convRepo.delete(value)`(现状),删当前对话则 `switchToNewConversation`;`work:repl` → `session.removeWorkScene(value)`(含 active guard,error 染红;删场景无 fallback 新建,与删对话不同)
  - inline-edit(主循环消费,决策 3):`session.workSceneRegistry.rename(sceneId, text)` / `add({ name: text })`,try/catch 染红
  - 两处均直调 `session.*` / `state.conv.*`,**不引用 provider** —— 故无需把 provider 提升出 `if (useTypeahead)` 块(repl.ts:1695),作用域无重构
- 刷新:删除由 InputController 在 callback 返回后自 refresh(typeahead-input.ts:791 既有);inline-edit 由主循环 resume 后调 `inputController.refreshCandidates()`(决策 3)

#### 决策 5:命令收敛 + archive 边界(待确认)

- 删 `/work` 6 sub-command 字符串解析(handler 重写为决策 1 的"<idOrName> → enter")
- 删 `/enter` META + handler
- 删 `/work add --workdir`(随 sub-command 一起删,workdir 交 ② 延迟绑定)
- **archive 彻底移除(范围 B,用户确认)** —— archive 概念整体删除,触及 5 个删除点 + 范围隔离:
  - `core/workscene`:删 `registry.setArchived` 方法 + `WorkScene.archived` 字段 + `IWorkSceneRegistry.list` 的 `includeArchived` 参数(list 不再过滤,全返回)+ registry 测试(`list 默认过滤 archived` / `setArchived 持久化` 等用例删除或改写)
  - **LLM 工具 `workscene_change_approve`**:enum `["add","remove","rename","archive","unarchive"]` 删 `archive` **和** `unarchive` 两个 → `["add","remove","rename"]`;call() 内合并分支 `case "archive": case "unarchive":`(调 setArchived,L204-214)整段删;sceneId description `"remove/rename/archive/unarchive 的目标场景 id"` → `"remove/rename 的目标场景 id"`;工具 description `"（add/remove/rename/archive/unarchive）"` 改;remove 分支注释"软隐藏语义请走 archive"清理;测试同步
  - **LLM 工具 `workscene_memory_query`**:call() 内 `registry.list({ includeArchived: true })` → `registry.list()`(`includeArchived` 参数已删;archive 移除后所有场景皆返回,语义等价于原"含归档");docstring "归档场景仍可检索(archived 只影响 list 默认过滤)" 清理
  - **system-prompt**:`workscene_change_approve` 描述从 "create / rename / archive / remove" 改为 "create / rename / remove"(system-prompt.ts:464 + system-prompt 测试快照同步)
  - `cli/repl.ts`:`/work archive|unarchive` 命令分支随 sub-command 删除;`/work list` 的 `--archived` flag + `s.archived` 渲染删除
  - **范围隔离**:skill 域的 archive(`skills-store.archive` / `listArchived`)是**独立概念,不动**;仅清 workscene 域。grep `setArchived` / `includeArchived` / `archived`(**含 docstring/注释**)在 `core/workscene` + `workmode-tools` 零残留

#### 实施步骤(渐进可验证)

按依赖 + 风险递增:

**Step 1** core/typeahead:`deletable` 重构为 `inlineActions`(types `InlineActionSupport` + `computeInlineActions` hook 替代 `computeDeletable` + `state.inlineActions` 替代 `state.deletable`;`ArgChoiceProvider` 用 `inlineActions?: InlineActionSupport` 静态字段**替代** `delete?` 方法;broker `setLoadingFinished` 写 inlineActions;ArgumentProvider `computeInlineActions` 读 `provider.inlineActions ?? {}`)。改既有 broker 单测 deletable→inlineActions.delete。验:core test

**Step 2** cli/tui:新建 `InlineTextPromptRegion`(InputRegion + run/finish,复用 rawMode/stdin/keypress 资源模式);`typeahead-panel` hint 段读 `inlineActions` 拼**单行**快捷键提示(守 meta 恒 2 行高度不变量)。补 InlineTextPromptRegion + panel 单测(含多操作 hint 单行 + 高度恒等断言)

**Step 3** cli/typeahead-input:Ctrl+D 读 `inlineActions.delete`(替代 `deletable`);加 Ctrl+R(`inlineActions.rename && selectedIndex>=0`)/ Ctrl+N(`inlineActions.create`)→ `fireInlineEdit(...)`;`InputLineResult` 加 `inline-edit-request` variant + 新增 `InlineEditHandler`/`inlineEditHandler` 槽(`waitOnce.finish` 清三 handler)+ `fireInlineEdit` 方法;暴露 `refreshCandidates()` public 方法(内部用私有 `sessionHandleId` 调 `broker.refresh`)。更新既有 Ctrl+D 测试

**Step 4** cli/repl.ts:`workSceneArgProvider` 闭包(`list` + `inlineActions: {delete,rename,create}` 声明,无执行方法);`conversationArgProvider` 删死代码 `delete?` 方法、改 `inlineActions: {delete:true}`;`workSceneArgSchema` 注册 `argsByName.work`;`/work` handler 重写(迁移 `/enter` 解析 → applyModeSwitch enter;保留 `activeMode.kind !== "main"` guard;`args=""` 走 friendly 提示);删 `/enter` META+handler;`onCandidateDelete` 加 work 分流(按 metadata.commandId,`resume:repl`→`convRepo.delete`、`work:repl`→`session.removeWorkScene`,直调底层不引用 provider);**REPL 主循环加 `inline-edit-request` result 消费**(suspend → InlineTextPromptRegion → `session.workSceneRegistry.rename/add` → resume + `inputController.refreshCandidates()`);删 `/work` sub-command 解析

**Step 5** archive 彻底移除(范围 B):`core/workscene` 删 `setArchived` / `archived` 字段 / `includeArchived` 参数 + registry 测试改;`workmode-tools` 的 `workscene_change_approve` 去 `archive` + `unarchive` 两 action(enum + 合并分支 + description + 注释)、`workscene_memory_query` 的 `list({includeArchived:true})` → `list()` + docstring 清理、两工具测试同步;`system-prompt.ts:464` 描述改 "create/rename/remove" + 快照测试;`cli` 删 `--archived` flag + `s.archived` 渲染。skill 域 archive 不动。grep workscene 域 + workmode-tools 的 archive(含注释)零残留

**Step 6** 跨包 typecheck + test;chrome 终端人工验:`/work` 进面板 + fuzzy + ↑↓ + Enter 进场景 + Ctrl+D 删(active guard)+ Ctrl+R 改名(预填)+ Ctrl+N 新建 + hint 行按操作集渲染;`/resume` 删除回归不破(inlineActions 重构后)

#### 验收

- `pnpm -r typecheck` 严格 tsc 全包 exit 0
- `pnpm -r test` 全包零回归(`/resume` 删除功能在 deletable→inlineActions 重构后行为不变)
- `/enter` 命令 grep 零残留(handler + META)
- `/work` sub-command(list/add/remove/rename)解析路径删除,`/work <id>` 进场景
- chrome 终端:`/work` 面板 ↑↓ + Enter 进场景 / Ctrl+D 删(active 场景 friendly error)/ Ctrl+R 预填改名 / Ctrl+N 新建 / hint 按 inlineActions 渲染
- inline 输入态:Enter 提交 / Esc 取消 / suspend-resume 后 typeahead 候选刷新;主循环驱动(`inline-edit-request` result),无 callback 死锁窗口
- 声明/执行分层:provider 只有 `list` + `inlineActions` 声明字段(grep `ArgChoiceProvider` 及 conversation/workScene provider 无 `delete?`/`rename?`/`create?` 执行方法);删除/inline-edit 执行在 cli callback 直调 `state.conv.convRepo` / `session.*`,不引用 provider
- `/work` handler `args=""`(空场景 / 手敲 `/work` Enter)→ friendly 提示不报错,不打印纯文本 list
- archive 彻底移除:grep `setArchived` / `includeArchived` / `archived`(含 docstring/注释)在 `core/workscene` + `workmode-tools` 零残留;LLM `workscene_change_approve` enum 仅 `add` / `remove` / `rename` 三 action(删 archive + unarchive);`workscene_memory_query` 改 `list()` 后行为等价(返回全部场景);skill 域 archive 不受影响

---

> 最近一次沉淀:
>
> - **`/resume` 对话删除功能 + switchToNewConversation helper**(2026-05-22 完成):argument hint 行(`[conversation: …]`)替换为 "delete ctrl+d" 功能区,二次按 Ctrl+D 确认删除(第一次选中行整行红背景填充 + hint 切 "再按一次 ctrl+d 确认删除",第二次物理删除,任意其他键取消准备态);删当前对话自动新建空对话无缝衔接;main + work 双 scope。**架构 —— 删除能力作为 typeahead 通用基础设施的可插拔扩展**:`ArgChoiceProvider.delete?(value, signal)` opt-in 方法(仅物理删除)+ `SuggestionProvider.computeDeletable?(match)` hook(broker 不跨层访问 provider 内部,provider 自决,与 computeGhostText/computeArgumentHint 同款扩展点)+ `TypeaheadSessionState` 加 `deletable` / `deletePending`(**deletePending 单源不变量**:`setSessionState` 入参 `Omit<…,"deletePending">` + 内部强制 null + `markDeletePending` 专属 setter,所有 mutate 路径自动 reset → "任何其他按键取消" 由 broker 自身保证)+ broker `refresh(sessionId)` API(删后强制重 query 刷新候选)+ Panel 红背景渲染(`dangerPending` theme + strip ANSI 补齐填充)+ InputController Ctrl+D 完全重写(**释放原 EOF + deleteForward 两语义**,仅 deletable 候选激活时生效)+ repl `onCandidateDelete` 业务编排。`ConversationRepository.delete` 改真物理删除(`fs.rm recursive force`,对齐 WorkSceneRegistry 已确立的"废弃 trash"纪律,清理死代码软删 + 释放永不触发的 `isDefault` 守卫)。审查阶段抽 [`switch-to-new-conversation.ts`](../../packages/cli/src/runtime/switch-to-new-conversation.ts) helper 消除 `/new` + `onCandidateDelete` 两处"新建对话切换" 31 行重复(最小接口注入,顺带补全 `/new` 缺失的视图层 reset)。沉淀去向:[`leading-slash-alias.ts`](../../packages/cli/src/runtime/leading-slash-alias.ts) 同款各模块 docstring 为首位权威;9 包 5212 tests 零回归(broker 13 + switch helper 6 + paste 边界 6 新单测),严格 tsc 全包 exit 0
> - **REPL 输入与命令体验三项小改**(2026-05-21 完成):需求三条 R1 首位 `、`→`/` 别名规范化(中文输入法误打 `、` 直接当 `/` 解析;显示层保留 `、` / 解析层走 `/`)/ R2 `/clear` UI 重置回刚进入交互模式初始态(advisories + welcome chrome + 一行 cleared notice,warnings 经 extraLines 注入避免清屏丢失可观测性)/ R3 `/workscene` → `/work` 改名(16 处字面同步,实施时发现 staging 统计漏了 work-mode.md:64 一处并补改)。新增 [`packages/cli/src/runtime/leading-slash-alias.ts`](../../packages/cli/src/runtime/leading-slash-alias.ts) `SLASH_ALIASES` 单源数组 + 两公开 API:单字符串 `normalizeLeadingSlashAlias(input)` 给 syncBroker(直接 override `ctx.draft`)、双字符串 `normalizeLeadingSlashAliasInExpanded(target, guard)` 给 submit(基于 `rawDraft.trim()` 首位判断、在 `expanded.trim()` 上替换,避免 paste 长内容折叠为 token 后首位恰为 `、` 时被误识别为命令);typeahead-input.ts syncBroker 用 spread + override draft、submit 用 InExpanded 双参数;repl.ts 顶层 startRepl 闭包 `clearScreenToInitial(extraLines?: readonly string[])` 复用 `rebuildAfterResize` + `initialRegionLines` 单源原语,buildSlashCommands 加注入参数,/clear handler 收集 warnings push 到本地数组(去前后 `\n`)、末尾按是否 chrome 分流(chrome 整屏重建 [advisories,"",welcome,"",warnings...,clearedNotice] 单一来源 / legacy 逐行 cliWriter)。沉淀去向:[`leading-slash-alias.ts`](../../packages/cli/src/runtime/leading-slash-alias.ts) 顶部 docstring 为首位权威(单源数组 + 两 API 语义分叉 + 单字符约束 + paste 边界推演);9 包 5193 tests 零回归(基线 +14 单测含 paste 边界 6 case),严格 tsc 全包 exit 0
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
