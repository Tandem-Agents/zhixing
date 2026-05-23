/**
 * Typeahead 面板渲染 —— 纯函数：把 `TypeaheadSessionState` 翻译成可写入终端的行。
 *
 * 角色：
 *   - `renderSessionLines(state, opts)` —— 一个 session state → 面板行数组
 *     （chrome 框 + 候选区 + meta 提示行）。inactive（无 trigger）返回空数组，
 *     调用方据此擦除。无副作用，不碰 stdin / raw mode / 光标。
 *   - `computeWindow(total, selectedIndex, maxVisible)` —— 候选超出可视高度时
 *     "选中项居中、贴顶贴底"的窗口计算，可独立测试。
 *
 * 调用方：生产输入区 `InputController`（typeahead-input.ts）订阅
 * `broker.onSessionChange`、持有 buffer 与 keypress，把最新 state 交本模块渲染、
 * 拼进自己的 chrome。本模块只读 state，不主动改 selectedIndex —— 上下键由
 * InputController 经 `broker.moveSelection(±1)` 驱动、新 state 回灌触发重绘
 * （零键执行依赖 broker 在 query 完成时已把 selectedIndex 固定到 0）。
 *
 * 视觉契约：与输入框 box / config-editor 共用 `renderChrome` 原语（紧凑形态）；
 * 全 visible state（loading / empty / active 任意 count）面板总行数恒等，配合
 * broker emit 策略保证 typing 期间零高度跳变（详见 renderActiveChrome docstring）。
 */

import type { SuggestionItem, TypeaheadSessionState } from "@zhixing/core";

import chalk from "chalk";
import { stripAnsi } from "./ansi.js";
import { renderChrome, type BodyLine } from "./chrome.js";
import { clampLine, stringWidth } from "./line-width.js";
import { tone, icon } from "./style.js";

// ─── 主题 ───

export interface TypeaheadTheme {
  readonly border: (s: string) => string;
  readonly title: (s: string) => string;
  readonly selectedArrow: string;
  readonly unselectedArrow: string;
  readonly selectedName: (s: string) => string;
  readonly unselectedName: (s: string) => string;
  readonly description: (s: string) => string;
  readonly selectedDescription: (s: string) => string;
  readonly hint: (s: string) => string;
  readonly loading: (s: string) => string;
  readonly error: (s: string) => string;
  readonly emptyHint: (s: string) => string;
  /**
   * 删除准备态行的整行红色背景填充(选中行 + `deletePending === item.id`
   * 命中时使用)。caller 应已把待包装的文本 strip ANSI + 补齐到 contentBudget,
   * 函数仅负责套背景色 + 前景色。
   */
  readonly dangerPending: (s: string) => string;
}

/**
 * Default theme 走 design token——视觉决策跟随 `tui/style.ts` 的 tone / icon。
 * Caller 仍可通过 `theme` 选项部分覆盖。
 *
 * 选中态语义：cursor 是 focus 锚点（保留品牌色），name / description 不上 brand
 * 色——选中信号由 chrome 的点阵纹理唯一承担，文字色双重叠加会让 description 比
 * label 抢眼，破坏视觉层级。与 config-editor entry row 的选中态规则一致。
 *
 * 关键 token 映射：
 *   border               → tone.dim
 *   selectedArrow        → tone.brand.bold(icon.cursor)  （focus 锚点保留品牌色）
 *   selectedName         → tone.bold                       （加粗、不变色）
 *   selectedDescription  → tone.dim                        （与未选中同色）
 *   loading              → tone.warn
 *   error                → tone.error
 */
export const defaultTypeaheadTheme: TypeaheadTheme = {
  border: (s) => tone.dim(s),
  title: (s) => tone.bold(s),
  selectedArrow: `${tone.brand.bold(icon.cursor)} `,
  unselectedArrow: "  ",
  selectedName: (s) => tone.bold(s),
  unselectedName: (s) => s,
  description: (s) => tone.dim(s),
  selectedDescription: (s) => tone.dim(s),
  hint: (s) => tone.dim(s),
  loading: (s) => tone.warn(s),
  error: (s) => tone.error(s),
  emptyHint: (s) => tone.dim(s),
  dangerPending: (s) => chalk.bgHex("#D85050").white(s),
};

// ─── 纯函数：窗口计算（可独立测试） ───

export interface VisibleWindow {
  readonly start: number;
  readonly end: number; // exclusive
  readonly showTopScroll: boolean;
  readonly showBottomScroll: boolean;
  /**
   * 列表长度超过 maxVisible —— 此时 renderer 应**总是预留两个指示行 slot**
   * （top + bottom），slot 为 false 时渲染为留白。
   *
   * 这是为了修 §7.x 的视觉抖动 bug：选中项从顶部→中部→底部时，
   * showTopScroll/showBottomScroll 会在 {F,T} / {T,T} / {T,F} 之间切换，
   * 若 renderer 按"有就渲染、没就省略"的朴素策略工作，面板总高会在
   * 13↔14 行之间跳变，用户视觉上看到整个面板"抖动"。
   *
   * 正确 UX：total > maxVisible 时 slot 恒定 = 2，内容按 flag 决定是
   * "↑ more…" / "↓ more…" 还是空白行；切换时仅行内容变化，总高不变。
   */
  readonly isScrollable: boolean;
}

/**
 * 根据总数 + 选中索引 + 可见条目数，计算窗口。
 *
 * 策略："选中项尽量居中 —— 但开头/末尾时贴边"。这个策略和 VSCode / Claude
 * Code 的 typeahead 行为一致，用户滚到列表两端时不会有"居中留白"的怪感。
 *
 * 不变量：
 *   - `end - start <= maxVisible`
 *   - `start <= selectedIndex < end`（前提是 total > 0 且 selectedIndex 合法）
 *   - `start >= 0 && end <= total`
 *   - `isScrollable === (total > maxVisible)`
 */
export function computeWindow(
  total: number,
  selectedIndex: number,
  maxVisible: number,
): VisibleWindow {
  if (total <= 0 || maxVisible <= 0) {
    return {
      start: 0,
      end: 0,
      showTopScroll: false,
      showBottomScroll: false,
      isScrollable: false,
    };
  }
  if (total <= maxVisible) {
    return {
      start: 0,
      end: total,
      showTopScroll: false,
      showBottomScroll: false,
      isScrollable: false,
    };
  }
  const clampedSel = Math.max(0, Math.min(selectedIndex, total - 1));
  // 居中：选中前后各预留 floor((max-1)/2) 个
  const before = Math.floor((maxVisible - 1) / 2);
  let start = clampedSel - before;
  if (start < 0) start = 0;
  let end = start + maxVisible;
  if (end > total) {
    end = total;
    start = end - maxVisible;
  }
  return {
    start,
    end,
    showTopScroll: start > 0,
    showBottomScroll: end < total,
    isScrollable: true,
  };
}

// ─── 纯函数：render lines from state（可独立测试） ───

export interface RenderOptions {
  readonly theme: TypeaheadTheme;
  readonly frameWidth: number;
  readonly innerWidth: number;
  readonly maxVisibleItems: number;
}

/**
 * 把一个 session state 翻译成要写入 stdout 的行数组。
 *
 * 纯函数 —— 无副作用，可直接断言输出。传入的 state 要遵守零键执行不变量
 * （suggestions 非空 → selectedIndex ∈ [0, len)）。
 *
 * 视觉结构 = 完整 chrome（与输入框 box / config-editor 共用同一 renderChrome 原语）+
 * chrome 之后的 meta 行（argumentHint / 快捷键提示）。chrome 紧凑形态
 * （bodyPadding=false, indent=1）与输入框 box 同款气质，显得是输入区的"延续姊妹"。
 *
 *   ╭ Commands · 6 matches ─────────────────────────╮
 *   │  ↑ 上方还有 N 条                               │
 *   │  ▸ /new                Start a new session    │  ← 选中行整行点阵纹理
 *   │    /reset              Alias of /new          │
 *   │  ↓ 下方还有 N 条                               │
 *   ╰────────────────────────────────────────────────╯
 *     ↑↓ · Enter · Esc      （有 ghostText 时插入 · Tab ·）
 *
 * inactive 时返回空数组 —— 调用方直接 `panel.render([])` 擦除之前的渲染。
 */
export function renderSessionLines(
  state: TypeaheadSessionState,
  opts: RenderOptions,
): string[] {
  const { theme, frameWidth, maxVisibleItems } = opts;

  if (!state.trigger || !state.activeProvider) return [];

  const providerLabel = titleOfProvider(state.activeProvider.id);
  const count = state.suggestions.length;
  const title = buildTitle(providerLabel, count, state, theme);

  // 紧凑 chrome 内容可见宽度 = frameWidth - 4
  // (左 │ + indent 1 + 右内边距 1 + 右 │)
  const contentBudget = Math.max(1, frameWidth - 4);

  if (count === 0) {
    return renderEmptyChrome(
      state,
      title,
      frameWidth,
      contentBudget,
      maxVisibleItems,
      theme,
    );
  }

  return renderActiveChrome(
    state,
    title,
    frameWidth,
    contentBudget,
    maxVisibleItems,
    theme,
  );
}

/** 标题段 —— `Commands · 6 matches` / `Commands · no matches` / `Commands · loading…`。 */
function buildTitle(
  providerLabel: string,
  count: number,
  state: TypeaheadSessionState,
  theme: TypeaheadTheme,
): string {
  if (state.loading) {
    return `${providerLabel} · ${theme.loading("loading…")}`;
  }
  if (count === 0) {
    return `${providerLabel} · no matches`;
  }
  const noun = count === 1 ? "match" : "matches";
  return `${providerLabel} · ${count} ${noun}`;
}

/**
 * 空态 chrome —— body 首行（argumentHint / loading / "未找到匹配项"）+ padding
 * 到与 active chrome body 同恒定行数 + 永远 1 行 Esc 提示。
 *
 * 高度恒定不变量（与 renderActiveChrome 对齐）：
 *   - chrome body 行数严格 = `maxVisibleItems + 2`（首行实质内容 + 后续空行
 *     padding），与 active 对齐
 *   - meta 永远 1 行（"Esc 清空"），与 active 路径 meta 行数对齐
 *   → 全 visible empty state 总行数（chrome + meta）严格相等于 active 状态
 *     的对应行数（在 argumentHint 缺席场景下完全相等；含 argumentHint 场景
 *     active 路径 meta 多 1 行 argHint，见方法 docstring "已知差异" 段）
 *
 * 这一不变量在 broker 异步路径下尤为关键：trigger 首次出现 emit loading 态、
 * resolve 后 emit canonical 态，两次 emit 之间 panel 总行数不变 →
 * `setChromeHeight` 走 transition=same 路径，不触发 DECSTBM 重排 → 视觉零跳变。
 *
 * 首行内容：argumentHint > loading > "未找到匹配项" 的优先级。
 *
 * ─── 已知差异（ArgumentProvider 场景，待后续重构）───
 *
 * 当 `state.argumentHint` 存在时，empty 路径把 hint 放在 body（"应该输入什么"
 * 的引导提示），active 路径把 hint 放在 meta（参数上下文标签）—— 位置不同，
 * 但行数不同：empty meta=1（Esc），active meta=2（argHint + shortcut）。
 * 在 ArgumentProvider session 内当候选数从 N>0 跌到 0 时 panel 缩 1 行。
 *
 * 此差异**不影响 FileProvider / CommandProvider 等 argHint=null 场景**（实际
 * 用户报告抖动的 bug case）。argHint 统一放置策略（放进 chrome title / 全
 * 移到 meta / 全移到 body）涉及 UI 信息架构决策，留作独立重构。
 */
function renderEmptyChrome(
  state: TypeaheadSessionState,
  title: string,
  frameWidth: number,
  contentBudget: number,
  maxVisibleItems: number,
  theme: TypeaheadTheme,
): string[] {
  const body: BodyLine[] = [];

  if (state.loading) {
    body.push(theme.loading(clampLine("正在加载候选…", contentBudget)));
  } else if (state.argumentHint?.emptyHint) {
    // provider 声明了空态引导（如"暂无工作场景，Ctrl+N 新建一个"）—— 优先于
    // 技术占位（参数 hint / "未找到匹配项"），让空候选对用户有引导意义。
    body.push(
      theme.emptyHint(clampLine(state.argumentHint.emptyHint, contentBudget)),
    );
  } else if (state.argumentHint) {
    body.push(
      theme.hint(clampLine(state.argumentHint.renderedHint, contentBudget)),
    );
  } else {
    body.push(theme.emptyHint(clampLine("未找到匹配项", contentBudget)));
  }

  // padding 空行到 maxVisibleItems + 2 行，与 active chrome body 严格对齐
  while (body.length < maxVisibleItems + 2) {
    body.push("");
  }

  // 1 行 meta。空候选下唯一有意义的 inline 操作是 create（new ctrl+n，list 级、
  // 不依赖选中）—— delete / rename 需选中候选，空列表无候选可操作，故 empty 态只
  // 提示 new。仍单行拼接，与 active 路径 shortcut meta（1 行）对齐，不引入高度跳变。
  const meta: string[] = [
    state.inlineActions.create
      ? `  ${theme.hint(clampLine("new ctrl+n · Esc 清空", frameWidth - 2))}`
      : `  ${theme.hint(clampLine("Esc 清空", frameWidth - 2))}`,
  ];

  return [
    ...renderChrome({
      title,
      body,
      width: frameWidth,
      bodyPadding: false,
      indent: 1,
    }),
    ...meta,
  ];
}

/**
 * 活跃 chrome —— 顶 slot + 候选行（选中行点阵高亮）+ 底 slot；meta 行在 chrome 外。
 *
 * ─── 全 visible state 总行数恒等不变量 ───
 *
 * panel 总行数（chrome + meta）在所有 visible state（loading / empty no-match /
 * argHint empty / active 任意 count）下严格相等（FileProvider / CommandProvider
 * 等 argHint=null 场景；argHint=set 的 ArgumentProvider 场景见 renderEmptyChrome
 * docstring "已知差异" 段）。
 *
 * 构成：
 *
 *   chrome body 行数 = `maxVisibleItems + 2`（1 行顶 slot + maxVisibleItems 行
 *     候选区 + 1 行底 slot），与 count / selectedIndex / isScrollable **无关**。
 *   chrome 自带顶 / 底框线 2 行 → chrome 总 = maxVisibleItems + 4。
 *
 *   meta 行数 = 1（active 路径的 nav shortcut "↑↓ · Enter · Esc"，有 ghostText
 *     时插入 Tab；empty 路径对齐为 "Esc 清空"）+ 可选 inlineActions / argumentHint 1 行。
 *
 * 这一不变量与 broker emit 策略（详见 broker.runQuery docstring "emit 策略"）
 * 共同保证：每次 emit 触发的 paint chromeHeight 严格相等 → `setChromeHeight`
 * transition=same 不触发 DECSTBM 重排，视觉零跳变。两者缺一会导致 panel 在
 * typing 期间 ±1 行震荡。
 *
 * Slot 占位策略：
 *   - scrollable：顶/底 slot 渲染滚动指示（`↑ 上方还有 N 条` / `↓ 下方还有 N 条`
 *     或边界标记 `──── 顶部 ────` / `──── 到底啦 ────`）
 *   - 不 scrollable：顶/底 slot 渲染空字符串（chrome 协议按空 BodyLine 渲染为
 *     纯左右边框 + 内部空白，行数占用与有内容时完全一致）
 *
 * 候选区 padding 策略：实际渲染候选数 < maxVisibleItems 时，末尾用空 BodyLine
 * 填充到 maxVisibleItems 行。
 */
function renderActiveChrome(
  state: TypeaheadSessionState,
  title: string,
  frameWidth: number,
  contentBudget: number,
  maxVisibleItems: number,
  theme: TypeaheadTheme,
): string[] {
  const count = state.suggestions.length;
  const win = computeWindow(count, state.selectedIndex, maxVisibleItems);
  const body: BodyLine[] = [];

  // ─── 顶 slot（恒占 1 行） ───
  if (win.isScrollable) {
    const aboveCount = win.start;
    const topContent =
      aboveCount > 0
        ? `↑ 上方还有 ${aboveCount} 条`
        : buildEdgeMarker("顶部", contentBudget);
    body.push(theme.hint(clampLine(topContent, contentBudget)));
  } else {
    body.push(""); // 空 slot 占位，让 body 总行数与 scrollable 路径恒等
  }

  // ─── 候选区（恒占 maxVisibleItems 行） ───
  for (let i = win.start; i < win.end; i++) {
    const item = state.suggestions[i]!;
    const isSelected = i === state.selectedIndex;
    const isDeletePending = isSelected && state.deletePending === item.id;
    const payload = buildCandidatePayload(
      item,
      isSelected,
      state.deletePending,
      contentBudget,
      theme,
    );
    // 准备删除态:红背景填充自身已足够 focus,不再叠 dotted-row 高亮
    // 否则两层视觉信号叠加反而损坏可读性
    body.push(
      isDeletePending
        ? payload
        : isSelected
          ? { content: payload, highlight: "dotted-row" }
          : payload,
    );
  }
  const filledCount = win.end - win.start;
  for (let i = filledCount; i < maxVisibleItems; i++) {
    body.push(""); // 候选不足时空行 padding，维持 maxVisibleItems 行恒定
  }

  // ─── 底 slot（恒占 1 行） ───
  if (win.isScrollable) {
    const belowCount = count - win.end;
    const bottomContent =
      belowCount > 0
        ? `↓ 下方还有 ${belowCount} 条`
        : buildEdgeMarker("到底啦", contentBudget);
    body.push(theme.hint(clampLine(bottomContent, contentBudget)));
  } else {
    body.push(""); // 空 slot 占位（同顶 slot）
  }

  // chrome 之后的 meta 行：有 inline 操作时显快捷键提示(delete 准备态切确认
  // 文案);无 inline 操作走原 argumentHint 渲染 —— 不破坏其他命令 ArgSchema 的
  // hint。快捷键提示行恒在末尾。两路径都是 hint(1) + shortcut(1) = 2 行
  // (inline-actions 命令必有 argumentHint),保持 panel 总高度恒等不变量。
  const meta: string[] = [];
  const ia = state.inlineActions;
  const hasInlineActions = Boolean(ia.delete || ia.rename || ia.create);
  if (hasInlineActions) {
    if (state.deletePending) {
      // 删除准备态优先 —— 覆盖其他操作提示,聚焦二次确认（整行 dim）
      meta.push(
        `  ${theme.hint(clampLine("再按一次 ctrl+d 确认删除", frameWidth - 2))}`,
      );
    } else {
      // 每个操作 = 动作词（默认前景，亮）+ 按键（dim），让"做什么"与"按哪个键"
      // 分两层视觉；pair 之间用空格而非 · 分隔。整行已分段上色，不再整体套 hint。
      const pairs: string[] = [];
      if (ia.delete) pairs.push(`delete ${tone.dim("ctrl+d")}`);
      if (ia.rename) pairs.push(`rename ${tone.dim("ctrl+r")}`);
      if (ia.create) pairs.push(`new ${tone.dim("ctrl+n")}`);
      meta.push(`  ${clampLine(pairs.join("   "), frameWidth - 2)}`);
    }
  } else if (state.argumentHint) {
    meta.push(
      `  ${theme.hint(clampLine(state.argumentHint.renderedHint, frameWidth - 2))}`,
    );
  }
  // 第二行导航 hint —— 纯按键、点分隔、无说明文本。Tab 仅在当前有 ghostText
  // （灰字补全）时插入：那时 Tab 接受补全、与 Enter 接受候选语义不同才值得提示；
  // 无 ghost 时 Tab == Enter，省去避免噪音（场景 / 参数面板无 ghost，故永不显示）。
  const navKeys = ["↑↓", "Enter"];
  if (state.ghostText) navKeys.push("Tab");
  navKeys.push("Esc");
  meta.push(`  ${theme.hint(clampLine(navKeys.join(" · "), frameWidth - 2))}`);

  return [
    ...renderChrome({
      title,
      body,
      width: frameWidth,
      bodyPadding: false,
      indent: 1,
    }),
    ...meta,
  ];
}

/**
 * 候选行 payload —— `{arrow}{name}{pad}{desc?}`,pad 让 desc 起始于 col 24
 * (按可见宽度对齐)。
 *
 * 删除准备态(`isSelected && deletePending === item.id`)走专属红背景渲染:
 * strip 常态 ANSI 后按 contentBudget 补齐空格,再整行套 theme.dangerPending —
 * 避免 ANSI 序列嵌套导致背景色被 dim/bold 序列打断;红背景已足够 focus,
 * caller 也不再套 dotted-row highlight。
 */
function buildCandidatePayload(
  item: SuggestionItem,
  isSelected: boolean,
  deletePending: string | null,
  contentBudget: number,
  theme: TypeaheadTheme,
): string {
  const arrow = isSelected ? theme.selectedArrow : theme.unselectedArrow;
  const namePart = isSelected
    ? theme.selectedName(item.displayText)
    : theme.unselectedName(item.displayText);

  let payload: string;
  if (!item.description) {
    payload = `${arrow}${namePart}`;
  } else {
    const nameVisible = stringWidth(item.displayText);
    const padCount = Math.max(1, 24 - nameVisible);
    const pad = " ".repeat(padCount);
    const desc = isSelected
      ? theme.selectedDescription(item.description)
      : theme.description(item.description);
    payload = `${arrow}${namePart}${pad}${desc}`;
  }

  if (!isSelected || deletePending !== item.id) return payload;

  const stripped = stripAnsi(payload);
  const visibleWidth = stringWidth(stripped);
  const padding = " ".repeat(Math.max(0, contentBudget - visibleWidth));
  return theme.dangerPending(stripped + padding);
}

/**
 * 构造边界标记，如 `──── 顶部 ────`。左右破折号根据可用宽度尽量对称铺开。
 * 中文标签（`顶部` / `到底啦`）按 stringWidth 算显示宽度。
 *
 * 参数 targetWidth 是目标可见宽度（不含边框字符，典型值 innerWidth - 4）。
 * 宽度太小时至少保证两侧各有 2 个破折号。
 */
function buildEdgeMarker(label: string, targetWidth: number): string {
  const labelSegment = ` ${label} `;
  const labelWidth = stringWidth(labelSegment);
  const dashBudget = Math.max(4, targetWidth - labelWidth);
  const leftDashes = Math.floor(dashBudget / 2);
  const rightDashes = dashBudget - leftDashes;
  return `${"─".repeat(leftDashes)}${labelSegment}${"─".repeat(rightDashes)}`;
}

/** 根据 provider id 给标题一个友好名字 */
function titleOfProvider(id: string): string {
  switch (id) {
    case "command":
      return "Commands";
    case "argument":
      return "Arguments";
    case "file":
      return "Files";
    case "memory":
      return "Memory";
    case "tool":
      return "Tools";
    default:
      return id;
  }
}
