# 选择模块架构 (Selection Module Architecture)

## 一、需求梳理

### 核心定位

选择模块是独立的交互基础设施,不是权限确认模块的附属能力。它提供"让用户在若干选项中作出决策"的通用 TUI 能力,可被任意系统功能或业务模块调用。

设计时不受现有权限确认实现限制:如果现有基础符合最优架构,可以吸收;如果最优设计与现有实现不同,以新的选择模块架构为准。

### 需求

1. **独立模块**:选择能力属于通用交互层,不归属于 security / confirmation / command 的任一业务域。
2. **任意场景可调用**:系统功能可以直接调用选择模块完成交互,例如 `/stop` 在停止知行前让用户选择"停止 / 取消 / 等完成后停止 / 取消当前工作并停止"。
3. **为未来 agent 唤醒保留能力**:长期上,agent 可在需要用户决策时唤醒选择模块;但这是独立业务能力,当前阶段只保留架构能力,不开放 agent 接入。
4. **选项数量克制**:选择模块用于短决策,不是列表浏览器或复杂表单。调用方必须把问题收敛成少数行动选项,最多 5 个,常规场景推荐 2-3 个。
5. **选项行为解耦**:选择模块不内置业务操作。它只返回用户选择的结果;具体操作由调用方执行。
6. **通用操作内聚**:面板级通用操作由选择模块统一负责,例如取消 / 返回 / 退出选择面板、键盘导航、确认提交、快捷键、焦点与资源释放。
7. **业务文案外置**:标题、说明、选项标签、风险提示、二次确认文案均由调用方提供;选择模块只负责一致的呈现与交互。
8. **可组合**:选择模块应支持简单选择、带说明选择、必要时的二次确认与输入补充,但这些能力必须保持通用,不能写死为权限或停止服务专用。

### 非目标

1. 不把现有权限确认面板原样提升为公共模块。
2. 当前不设计 agent 直接调用选择模块的完整业务协议。
3. 不在选择模块内执行 `/stop`、权限授权、配置修改等业务动作。
4. 不把选择模块做成命令系统、权限系统或状态系统的一部分。

## 二、架构设计

### 2.1 核心裁决

选择模块归属 **CLI TUI 交互基础设施**。它不是 core / server 能力,也不是 security / confirmation 能力;它服务的是"当前终端接入面需要向用户发起一次选择"这一产品场景。

核心边界:

- **选择模块只负责交互闭环**:展示标题 / 说明 / 选项,处理键盘导航、提交、取消、二次确认、输入补充,最后返回结构化结果。
- **调用方负责业务语义**:调用方决定为什么选择、有哪些选项、选项代表什么、选择后执行什么。选择模块不认识 `/stop`、权限、配置、agent。
- **选择是短决策,不是浏览器**:如果业务天然有很多候选项,调用方必须先聚合、筛选或改用专用列表 / 管理界面,不能把复杂选择直接塞进选择面板。
- **当前只开放给本机系统功能与现有确认链路**:系统命令可以调用;权限确认通过适配器调用;agent 唤醒选择模块作为未来业务协议保留,本阶段不接入。
- **一个 CLI 进程同一时刻只允许一个选择面板活跃**:选择是 modal 交互,stdin / raw mode / chrome input region 必须独占。是否排队由调用方或上层 broker 决定,选择模块自身不做业务队列。

### 2.2 模块位置与分层

目标目录:

```text
packages/cli/src/tui/selection/
  index.ts
  types.ts
  state.ts
  presenter.ts
  inline-selection-region.ts
  legacy-selection-presenter.ts
  selection-service.ts
  render.ts
```

分层职责:

1. **协议层 `types.ts`**  
   定义 `SelectionRequest`、`SelectionOption`、`SelectionResult`、`SelectionCancelCause`。协议层必须领域无关。

2. **状态层 `state.ts`**  
   纯 reducer,处理上下移动、hotkey、Enter、Esc、输入模式、二次确认模式。零 I/O、零 ANSI、零业务语义。

3. **渲染层 `render.ts` / `inline-selection-region.ts`**  
   把状态渲染为 chrome inline 面板,实现 `InputRegion`;处理终端宽度、可用高度、选中态、说明文本、危险选项视觉、hint 行。渲染层必须在产出 `renderLines()` 前完成宽度裁剪与高度预算,不能把超宽 / 超高内容交给 `ScreenController` 兜底。

4. **呈现端口 `presenter.ts`**  
   定义 `SelectionPresenter` 端口,隔离选择服务与具体终端能力。chrome 可用时使用 inline presenter;无 chrome 能力时使用 legacy presenter。调用方只依赖 `SelectionService`,不感知渲染策略。

5. **协调层 `selection-service.ts`**  
   对调用方暴露 `choose(request, options)`;负责挂载 / 卸载 region、暂停 / 恢复当前输入区、stdin ownership、raw mode、AbortSignal、资源释放。调用方不直接操作 region。

6. **业务适配层**  
   位于各业务模块内:权限确认、`/stop`、未来配置选择等只把业务请求映射成 `SelectionRequest`,再把 `SelectionResult` 翻译回业务动作。

现有实现吸收方式:

- `packages/cli/src/tui/select-types.ts` 与 `packages/cli/src/tui/_internal/select-state.ts` 的通用思想可以吸收进新模块。
- `packages/cli/src/security/select-operation-region.ts` 的 inline region 形态可以迁移 / 重命名为 TUI 选择模块实现。
- `security` 目录只保留权限确认适配器,不再拥有通用选择 UI。

### 2.3 公共 API

选择服务入口:

```ts
interface SelectionService {
  choose<TValue extends string>(
    request: SelectionRequest<TValue>,
    options?: SelectionRunOptions,
  ): Promise<SelectionResult<TValue>>;
}

class SelectionBusyError extends Error {
  readonly name = "SelectionBusyError";
}

class SelectionValidationError extends Error {
  readonly name = "SelectionValidationError";
}

class SelectionUnavailableError extends Error {
  readonly name = "SelectionUnavailableError";
}
```

请求结构:

```ts
interface SelectionRequest<TValue extends string = string> {
  id?: string;
  title: string;
  body?: readonly string[];
  options: readonly SelectionOption<TValue>[];
  initialValue?: TValue;
  submitLabel?: string;
  cancelLabel?: string;
}

type SelectionOption<TValue extends string = string> =
  | SelectionPlainOption<TValue>
  | SelectionInputOption<TValue>
  | SelectionConfirmOption<TValue>;

interface SelectionBaseOption<TValue extends string = string> {
  value: TValue;
  label: string;
  description?: string;
  hotkey?: SelectionHotkey;
  tone?: "normal" | "primary" | "danger" | "muted";
  disabled?: boolean;
}

type SelectionHotkey = string;

interface SelectionPlainOption<TValue extends string = string>
  extends SelectionBaseOption<TValue> {
  input?: undefined;
  confirm?: undefined;
}

interface SelectionInputOption<TValue extends string = string>
  extends SelectionBaseOption<TValue> {
  input: SelectionInputSpec;
  confirm?: undefined;
}

interface SelectionConfirmOption<TValue extends string = string>
  extends SelectionBaseOption<TValue> {
  input?: undefined;
  confirm: SelectionConfirmSpec;
}

interface SelectionInputSpec {
  placeholder: string;
  allowEmpty?: boolean;
}

interface SelectionConfirmSpec {
  title: string;
  body?: readonly string[];
  confirmLabel?: string;
  cancelLabel?: string;
}

type SelectionResult<TValue extends string = string> =
  | SelectionSelectedResult<TValue>
  | { kind: "cancelled"; cause: SelectionCancelCause };

type SelectionSelectedResult<TValue extends string = string> =
  | { kind: "selected"; value: TValue }
  | { kind: "selected"; value: TValue; input: string };

type SelectionCancelCause = "escape" | "ctrl-c" | "ctrl-d" | "aborted";

interface SelectionRunOptions {
  signal?: AbortSignal;
}
```

设计要点:

- `value` 是调用方自定义标识,选择模块只原样返回。
- `tone` 只影响视觉,不改变行为。
- `hotkey` 是单个可打印 ASCII 非空白字符,大小写不敏感;它不是键盘事件描述,不能表达 Enter / Esc / Tab / 方向键 / Ctrl / Alt 组合。
- `disabled` 选项可展示但不可提交,用于解释"为什么不能选"。disabled 选项不响应 hotkey,Enter 不提交。
- `input` 是选项级补充输入,例如"拒绝并说明原因"。
- `confirm` 是选项级二次确认,例如"取消当前工作并停止"。进入二次确认后,Esc 返回上一层选择;确认后才返回 `selected`。
- `input` 与 `confirm` 当前互斥。需要"输入后再二次确认"的复合流程时,由调用方拆成两次选择或在未来扩展协议;本阶段不把复合状态塞进基础模块。
- 选中 input 选项时,`selected` 结果必须带 `input` 字段;允许空字符串。选中非 input 选项时,结果不得带 `input` 字段。
- `cancelled` 不等于业务拒绝。调用方决定 Esc / Ctrl+C / Abort 在业务上代表什么。
- 已有活跃选择时,`choose` 必须 reject `SelectionBusyError`;busy 不是用户取消,调用方自行决定排队、重试或忽略。
- 请求不合法时,`choose` 必须 reject `SelectionValidationError`;这是调用方编程错误,不得用默认选项静默兜底。
- 当前进程没有可交互输入 / 输出能力时,`choose` 必须 reject `SelectionUnavailableError`;不可用不是用户取消,调用方必须给出非交互路径或用户提示。

请求校验:

- `options` 必须为 1-5 个,且不能全部 disabled。超过 5 个是调用方产品设计错误,必须 reject `SelectionValidationError`,不得进入 UI。
- `value` 必须在一次请求内唯一。
- `hotkey` 必须是单个可打印 ASCII 非空白字符,在大小写归一后唯一,且不能绑定 disabled 选项。
- `initialValue` 必须存在且指向非 disabled 选项;未提供时默认选中第一个非 disabled 选项。
- `input.placeholder`、`confirm.title`、`label`、`title` 必须非空。
- disabled 选项可以有说明,但不能声明 `input` 或 `confirm`。
- `input.allowEmpty` 默认 `false`。为 `false` 时,空输入按 Enter 不提交,仍停留在输入层;为 `true` 时,空输入提交并返回 `input: ""`。

### 2.4 交互规范

默认键盘:

- ↑ / ↓:移动选中项。
- Enter:提交当前项;若当前项有 `input`,进入输入模式或提交输入;若当前项有 `confirm`,进入二次确认。
- hotkey:等价于移动到对应项并执行 Enter 激活逻辑;simple 直接提交,input 进入输入层,confirm 进入二次确认层。
- Esc:普通选择层取消;输入层返回选择层;二次确认层返回选择层。
- Ctrl+C / Ctrl+D:中止选择面板,返回对应 cancel cause。
- disabled 选项可见但不可提交。键盘移动跳过 disabled 选项;如果所有可选项都被禁用,请求在进入交互前失败。
- hotkey 只在选择层生效;输入层内所有可打印字符都进入输入缓冲,不触发选项快捷键。

呈现规则:

- 面板以内联方式嵌入当前 chrome 输入区,不切换全屏,不吞掉对话 scrollback。
- 标题、说明、选项、hint 行由统一渲染层生成,业务模块不得手写选择面板。
- 面板固定在底部操作区,采用紧凑决策面板形态:一条顶部分隔线标识边界,不使用弹窗、不使用全屏框、不把快捷键甩到屏幕最右。
- 标题与关键说明优先合并为一行,格式为 `标题  ·  关键说明`;说明过长时再换行。面板应避免为短说明单独占用整段高度。
- 选项默认一行展示,格式为 `指示符 + label + hotkey + description`:label、hotkey、description 分列对齐。只有 description 超出宽度预算时才截断或折叠,不默认拆成两行。
- 选项之间不留空行;选项区与 hint 行之间保留一行。这样 2-5 个选项都能一次扫完,不会浪费底部高度。
- 内容区应充分利用终端横向空间,但不得铺满整屏;渲染层应按当前列数给 description 一个合理最大宽度,超出后裁剪。
- 选中态用 `›` 与 label 加亮表达,不做整行反白。`tone` 只影响 label,不染整行、不染 description;危险选项必须靠文案说明后果,颜色只做辅助。
- hint 行固定弱化显示,例如 `Enter 确认 · ↑/↓ 选择 · Esc 返回`,不和选项争抢视觉权重。
- 选项说明用于解释后果,不是执行逻辑。
- 危险选项只用克制视觉区分,不能靠颜色作为唯一信息;文案必须说明影响。`tone: "danger"` 不自动触发二次确认,需要二次确认时必须由调用方显式提供 `confirm`。
- 所有选项必须一次完整可见。选择面板不提供滚动条、不做分页、不做选项窗口化、不依赖鼠标滚轮。
- 渲染层必须保证标题、说明、选项、hint 在长标签、窄终端、CJK 字符下不破版;说明或选项文案过长时应截断 / 折叠为短提示,让用户仍能一次看完整个决策。

通用布局示例:

```text
──────────────────────────────────────────────────────────────────────────────
  标题  ·  关键说明

  › 主要选项  (a)   选择后的结果说明
    次要选项  (b)   选择后的结果说明
    危险选项  (d)   风险或后果说明

  Enter 确认 · ↑/↓ 选择 · Esc 返回
```

屏幕预算:

- inline presenter 必须基于当前终端列数、视口行数、status 高度和最小对话滚动区保留行数计算 `maxPanelRows`;选择面板不得占满主对话区域。
- 行宽是硬不变量:传给 `InputRegion.renderLines()` 的每一行显示宽度必须小于等于 `columns - 1`,不能依赖终端自动换行或 `ScreenController` 替 input region 兜底。
- 高度优先级固定:标题、所有选项、hint 必须完整显示;body、description、confirm body 可折叠为短提示。任何情况下都不能通过隐藏部分选项来满足高度。
- 如果折叠后仍放不下"标题 + 所有选项 + hint",inline presenter 必须在进入交互前失败,由 `SelectionService` 返回 `SelectionUnavailableError`;不得渲染半截面板。
- 现有权限面板只吸收 inline chrome、stdin ownership、raw mode、纯状态机、beforeShow / afterShow 这些正确模式;不能沿用"body / options 全量渲染且无高度预算"的旧渲染策略。

### 2.5 资源与生命周期

选择面板需要独占 stdin 与当前 chrome input region,因此由 `SelectionService` 统一协调:

1. 调用方发起 `choose`。
2. `SelectionService` 校验请求。请求不合法时 reject `SelectionValidationError`,不进入交互。
3. `SelectionService` 检查当前是否已有活跃选择。若已有,直接 reject `SelectionBusyError`,调用方自行决定重试、排队或忽略。
4. `SelectionService` 检查当前进程是否仍有可交互输入 / 输出能力。若没有,直接 reject `SelectionUnavailableError`,不进入交互。
5. `SelectionService` 选择 presenter:inline chrome 可用且屏幕预算足够时使用 `InlineSelectionPresenter`;chrome 不可用但仍有交互能力时使用 `LegacySelectionPresenter`;屏幕预算不足且无法可靠降级时 reject `SelectionUnavailableError`。
6. `SelectionService` 调用 `beforeShow` 暂停当前输入区。
7. presenter 接管 stdin ownership 与 raw mode。
8. 用户完成选择 / 取消 / 外部 abort。
9. presenter 必须释放 stdin ownership、raw mode、screen input region。
10. `SelectionService` 调用 `afterShow` 恢复原输入区。
11. 返回结构化结果给调用方。

呈现端口:

```ts
interface SelectionPresenter {
  run<TValue extends string>(
    request: ValidatedSelectionRequest<TValue>,
    options: SelectionPresenterOptions,
  ): Promise<SelectionResult<TValue>>;
}

interface SelectionPresenterOptions {
  signal?: AbortSignal;
}
```

`ValidatedSelectionRequest` 只能由 `SelectionService` 生成。presenter 不再重复业务校验,只负责把确定合法的请求跑完一次交互。legacy presenter 必须遵守同一返回协议和资源释放规则,不能形成第二套选择语义。

presenter 能力不分等级: inline 与 legacy 只允许视觉形态不同,不可出现语义能力差异。legacy presenter 必须完整支持 simple / hotkey / Esc / Ctrl+C / Ctrl+D / AbortSignal / input / confirm;终端能力不足只能降低呈现质量,不能让某类选择请求不可用。

资源不变量:

- 任何异常路径都必须释放 stdin / raw mode / screen region。
- `AbortSignal` 到达时不执行默认业务动作,只返回 `cancelled(aborted)`。
- `SelectionBusyError`、`SelectionValidationError`、`SelectionUnavailableError` 均发生在 presenter 启动前,不得产生部分 UI 或资源占用。
- 选择模块不调用任何业务 RPC,不写配置,不改状态。

### 2.6 业务接入方式

#### `/stop`

`/stop` 命令调用 `server.info` 获得状态,根据活跃接入面 / 运行中任务 / 排队消息构造 `SelectionRequest`。

- 低风险:停止 / 取消。
- 有其它接入面:停止 / 取消,说明飞书与其它终端会断开。
- 有运行中工作:等完成后停止 / 取消当前工作并停止 / 返回;其中"取消当前工作并停止"带 `confirm` 二次确认。

选择模块只返回选项值;`/stop` handler 决定是否调用 `server.shutdown`、是否先 abort 当前工作、是否注册"完成后停止"。

#### 权限确认

`TerminalConfirmationRenderer` 改为权限适配器:

1. 把 `ConfirmationRequest` 映射成 `SelectionRequest`。
2. 调用 `SelectionService.choose`。
3. 把 `SelectionResult` 翻译成 `ConfirmationDecision`。

权限确认不再持有通用 region,也不再定义选择状态机。

#### 未来 agent 唤醒

未来若要让 agent 唤醒选择模块,应新增独立的"用户决策请求"业务协议:agent 只能提交受限的选择请求,由宿主 / 接入面校验可见性、权限与超时。本阶段不开放该入口,避免 agent 直接控制 TUI 造成交互和安全边界混乱。

### 2.7 与现有代码的迁移边界

迁移目标不是"移动文件名",而是让依赖方向正确:

- TUI 选择模块不能 import `security`、`confirmation`、`commands`。
- `security` 可以 import TUI 选择模块。
- `/stop` 所在命令模块可以 import TUI 选择服务接口,但具体业务动作仍在命令 handler / RPC facade 内。
- `SelectionService` 的实例应在 REPL 装配处创建,与 `InputController`、`ScreenController` 同生命周期。
- 无 chrome 但仍有可交互 stdin / stdout 时,选择服务需要一个 legacy fallback:用逐行提示 + 单字符输入完成同一套选择协议;不能因为没有 chrome 导致 `/stop`、权限确认或未来系统选择不可操作。完全非交互环境不进入选择面板,由 `SelectionUnavailableError` 交给调用方处理。

### 2.8 验收标准

架构验收:

- 全仓没有业务模块直接 import `security/select-operation-region` 作为通用选择能力。
- `security/select-operation-region` 退场或变成 TUI 模块的薄 re-export 过渡层;最终不得作为公共入口。
- TUI 选择模块无 security / confirmation / command 领域依赖。
- 权限确认与 `/stop` 都通过 `SelectionService` 调起选择。

行为验收:

- 简单选择、hotkey、Esc、Ctrl+C、AbortSignal 均有单测。
- 带输入选项与二次确认选项均有单测。
- input 选项提交时总是返回 `input`,空输入返回 `""`;非 input 选项不得返回 `input`。
- `allowEmpty` 默认 `false`;空输入 Enter 不提交。`allowEmpty: true` 时空输入 Enter 返回 `input: ""`。
- hotkey 非单字符 / 空白字符 / 重复 / 绑定 disabled 选项均被请求校验拒绝。
- options 数量为 0 或超过 5 均被请求校验拒绝;常规业务测试应覆盖 2-3 个选项的主路径。
- 非交互环境下 `choose` reject `SelectionUnavailableError`,且不调用 presenter。
- inline 屏幕预算不足时 `choose` reject `SelectionUnavailableError`,且不产生半截 chrome UI。
- inline presenter 与 legacy presenter 共享同一组协议级行为测试。
- 二次确认 Esc 返回上一层,不直接取消整个面板。
- 选择结束、异常、abort 后输入区恢复,raw mode 与 stdin listener 无泄漏。
- 窄终端、矮终端、长中文选项、长说明、禁用项、危险项显示不破版;不得通过滚动条、分页或隐藏部分选项来通过测试。
- `/stop` 的三类状态都能映射成正确选择请求,选择结果不在选择模块内执行业务动作。

产品验收:

- 用户只感知"选择一个动作",不感知权限模块或底层 region。
- 用户应能一眼看完全部选择并立即决策;如果需要滚动、翻页或比较大量候选项,说明调用方应改用专用界面而不是选择模块。
- `/stop` 使用选择模块后,体验与权限确认同源但语义不同:权限是安全决策,`/stop` 是系统控制决策。
- 未来增加配置选择、候选确认、agent 决策请求时,不需要再造新的 TUI 选择轮子。
