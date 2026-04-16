/**
 * TypeaheadPanel — 常驻式 typeahead 下拉面板（CLI/TTY 渲染器）
 *
 * 角色（spec §7.2）：
 *   - 订阅 `broker.onSessionChange(sessionId)`，把 `TypeaheadSessionState`
 *     翻译成可视面板。
 *   - active（trigger 命中、有 suggestions 或处于 loading 态）时在 stdout 下方
 *     原地重绘 dropdown；inactive 态**完全不占行**（0 字节输出）。
 *   - 提供 keyboard handler：↑↓ 导航、Tab/Enter 接受、Esc 清 trigger。
 *     Panel 本身不持有 draft —— 它只通过 onAccept / onCancel 回调通知上层。
 *   - 和 `SelectWithInput` 不同：panel 是**非阻塞**的，没有 Promise；
 *     它绑定到 broker session 直到 detach。
 *
 * 复用 spec §6.4 的内核（Phase 1 Step 1 抽取）：
 *   - `createPanelRenderer` —— 原地重绘 + 擦除的光标不变量
 *   - `rawModeController` —— 多 modal 安全的 raw mode 引用计数
 *   - `acquireStdinOwnership` —— 摘除 readline 预挂的 echo 监听器
 *   - `clampLine` / `stringWidth` —— CJK 安全的行截断
 *
 * 零键执行（spec §6.5）的前置条件：broker 已经在 query 完成时把
 * `selectedIndex` 固定到 0。Panel 只读不写 —— 它**不**主动改 selectedIndex，
 * 上下箭头通过 `broker.moveSelection(±1)` 让 broker 更新状态再回灌回来。
 *
 * 窗口滚动：suggestions 多于 maxVisibleItems 时采用"选中项居中"策略，
 * 末尾/开头时固定到一侧。纯函数 `computeWindow` 可独立测试。
 *
 * 生命周期：
 *   attach() ──▶ 订阅 broker + 挂 keypress listener + 首次空渲染
 *     │
 *     │ broker 发 session state 变更
 *     ▼
 *   applySessionState() ──▶ 计算 lines → panel.render()
 *     │
 *     │ 用户按键（↑↓/Tab/Enter/Esc）
 *     ▼
 *   handleKeypress() ──▶ broker.moveSelection / onAccept / onCancel
 *     │
 *     ▼
 *   detach() ──▶ 解绑所有 listener + panel.clear()
 */

import type * as readline from "node:readline";

import type {
  ITypeaheadBroker,
  SuggestionItem,
  TypeaheadSessionState,
} from "@zhixing/core";

import { ANSI } from "./ansi.js";
import {
  createPanelRenderer,
  type PanelRenderer,
} from "./_internal/cursor-invariants.js";
import { rawModeController, type RawModeLease } from "./_internal/raw-mode.js";
import {
  acquireStdinOwnership,
  type StdinOwnershipHandle,
} from "./_internal/stdin-ownership.js";
import { clampLine, stringWidth } from "./line-width.js";

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
}

export const defaultTypeaheadTheme: TypeaheadTheme = {
  border: (s) => `${ANSI.gray}${s}${ANSI.reset}`,
  title: (s) => `${ANSI.bold}${s}${ANSI.reset}`,
  selectedArrow: "❯ ",
  unselectedArrow: "  ",
  selectedName: (s) => `${ANSI.bold}${ANSI.cyan}${s}${ANSI.reset}`,
  unselectedName: (s) => s,
  description: (s) => `${ANSI.dim}${s}${ANSI.reset}`,
  selectedDescription: (s) => `${ANSI.cyan}${s}${ANSI.reset}`,
  hint: (s) => `${ANSI.dim}${s}${ANSI.reset}`,
  loading: (s) => `${ANSI.yellow}${s}${ANSI.reset}`,
  error: (s) => `${ANSI.red}${s}${ANSI.reset}`,
  emptyHint: (s) => `${ANSI.dim}${s}${ANSI.reset}`,
};

// ─── Panel 选项 ───

export interface TypeaheadPanelOptions {
  readonly broker: ITypeaheadBroker;
  readonly sessionId: string;

  /** 接受某条 suggestion 后的回调 —— 上层负责 broker.accept + draft 更新 */
  readonly onAccept: (item: SuggestionItem) => void;
  /** Esc 清除 trigger 后的回调 —— 上层可选择清 draft token 或整行 */
  readonly onCancel?: () => void;

  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly theme?: Partial<TypeaheadTheme>;

  /** 面板最多可见条目数；多余走窗口滚动。默认 8 */
  readonly maxVisibleItems?: number;
  /** 面板最小宽度；默认 40 */
  readonly minWidth?: number;
  /** 面板最大宽度；默认 80 */
  readonly maxWidth?: number;
  /** 强制面板宽度探测（测试用） */
  readonly columns?: number;
}

// ─── 公开 API ───

export interface TypeaheadPanelHandle {
  /** 启动订阅 + keypress 监听 + 首次渲染。幂等。 */
  attach(): void;
  /** 解除订阅、释放 raw mode / stdin ownership、擦除面板。幂等。 */
  detach(): void;
  /**
   * 手动触发重绘 —— 主要用于终端 resize 后让外层调。
   * Panel 本身不订阅 stdout.resize（跨 session 的 renderer 更合适做这件事）。
   */
  rerender(): void;
  /** 当前渲染了多少行；测试和诊断用 */
  readonly lastRenderHeight: number;
}

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
 * 结构（active 时）：
 *   ╭─ Commands · 6 matches ──────
 *   │  ↑ more...                     ← 有 topScroll 时
 *   │  ❯ /new     Start a new session
 *   │    /reset   Alias of /new
 *   │  ...
 *   │  ↓ more...                     ← 有 bottomScroll 时
 *   ╰─
 *
 * inactive 时返回空数组 —— 调用方直接 `panel.render([])` 擦除之前的渲染。
 */
export function renderSessionLines(
  state: TypeaheadSessionState,
  opts: RenderOptions,
): string[] {
  const { theme, frameWidth, innerWidth, maxVisibleItems } = opts;

  // ── Inactive 态：无 trigger 且无 loading → 不占行 ──
  if (!state.trigger || !state.activeProvider) return [];

  const providerLabel = titleOfProvider(state.activeProvider.id);
  const count = state.suggestions.length;

  // 标题段
  let titleSegment: string;
  if (state.loading) {
    titleSegment = ` ${providerLabel} · ${theme.loading("loading…")} `;
  } else if (count === 0) {
    titleSegment = ` ${providerLabel} · no matches `;
  } else {
    titleSegment = ` ${providerLabel} · ${count} ${count === 1 ? "match" : "matches"} `;
  }

  const lines: string[] = [];

  // ── 顶部边框 ──
  const titleVisible = stringWidth(titleSegment);
  const dashes = Math.max(0, frameWidth - 2 - titleVisible);
  lines.push(
    theme.border(`╭─${theme.title(titleSegment)}${"─".repeat(dashes)}`),
  );

  // ── 空结果 / loading 占位 ──
  if (count === 0) {
    const emptyText = state.loading ? "正在加载候选…" : "未找到匹配项";
    lines.push(
      `${theme.border("│")}  ${clampLine(theme.emptyHint(emptyText), innerWidth - 2)}`,
    );
    lines.push(theme.border(`╰${"─".repeat(frameWidth - 1)}`));
    lines.push(
      `  ${theme.hint(clampLine("Esc 清空", frameWidth - 2))}`,
    );
    return lines;
  }

  // ── 窗口计算 ──
  const win = computeWindow(count, state.selectedIndex, maxVisibleItems);

  // 滚动指示行：scrollable 时**恒定预留 2 个 slot**（顶+底），内容随窗口位置
  // 变化但行数不变，消除面板高度抖动。文案策略：
  //
  //   - 可滚动：`↑ 上方还有 N 条` / `↓ 下方还有 N 条`（量化剩余数量）
  //   - 到边了：`──── 顶部 ────` / `──── 到底啦 ────`（明确的中文边界提示）
  //
  // 非 scrollable（total ≤ maxVisible）时完全不预留 slot —— 不浪费行。
  if (win.isScrollable) {
    const aboveCount = win.start;
    const topContent =
      aboveCount > 0
        ? `↑ 上方还有 ${aboveCount} 条`
        : buildEdgeMarker("顶部", innerWidth - 4);
    lines.push(
      `${theme.border("│")}  ${theme.hint(clampLine(topContent, innerWidth - 2))}`,
    );
  }

  // ── 候选项 ──
  for (let i = win.start; i < win.end; i++) {
    const item = state.suggestions[i]!;
    const isSelected = i === state.selectedIndex;
    const arrow = isSelected ? theme.selectedArrow : theme.unselectedArrow;

    // 名字列：用 displayText（provider 决定是否带 `/` 前缀）
    const namePart = isSelected
      ? theme.selectedName(item.displayText)
      : theme.unselectedName(item.displayText);

    // 描述列：可选
    let linePayload: string;
    if (item.description) {
      // 两列布局：name 左对齐至 24 列，description 填剩余
      const nameVisible = stringWidth(item.displayText);
      const padCount = Math.max(1, 24 - nameVisible);
      const pad = " ".repeat(padCount);
      const desc = isSelected
        ? theme.selectedDescription(item.description)
        : theme.description(item.description);
      linePayload = `${namePart}${pad}${desc}`;
    } else {
      linePayload = namePart;
    }

    const line = `${theme.border("│")} ${arrow}${linePayload}`;
    lines.push(clampLine(line, frameWidth));
  }

  if (win.isScrollable) {
    const belowCount = count - win.end;
    const bottomContent =
      belowCount > 0
        ? `↓ 下方还有 ${belowCount} 条`
        : buildEdgeMarker("到底啦", innerWidth - 4);
    lines.push(
      `${theme.border("│")}  ${theme.hint(clampLine(bottomContent, innerWidth - 2))}`,
    );
  }

  // ── 底部边框 ──
  lines.push(theme.border(`╰${"─".repeat(frameWidth - 1)}`));

  // ── 快捷键提示 ──
  const hint = "↑↓ 选择 · Enter 接受 · Tab 接受 · Esc 清空";
  lines.push(`  ${theme.hint(clampLine(hint, frameWidth - 2))}`);

  return lines;
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

// ─── 主组件 ───

/**
 * 创建一个 TypeaheadPanel。**必须调用 attach() 才会订阅 broker**。
 *
 * 注意：本组件接管 stdin 的 keypress 事件处理。任何其它需要拿按键的组件必须
 * 通过 broker 里 panel 的 onAccept 回调走，**不要**在 panel attached 时自己
 * 在 stdin 上挂 keypress listener —— stdin-ownership snapshot/restore 会漏掉
 * 后续新增的 listener。
 */
export function createTypeaheadPanel(
  options: TypeaheadPanelOptions,
): TypeaheadPanelHandle {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const theme: TypeaheadTheme = {
    ...defaultTypeaheadTheme,
    ...(options.theme ?? {}),
  };
  const maxVisibleItems = options.maxVisibleItems ?? 12;
  const minWidth = options.minWidth ?? 40;
  const maxWidth = options.maxWidth ?? 80;

  const panel: PanelRenderer = createPanelRenderer(stdout);

  let attached = false;
  let unsubscribe: (() => void) | null = null;
  let rawModeLease: RawModeLease | null = null;
  let stdinOwnership: StdinOwnershipHandle | null = null;
  let lastState: TypeaheadSessionState | null = null;

  const getColumns = (): number => {
    if (typeof options.columns === "number") return options.columns;
    return stdout.columns ?? 80;
  };

  const computeRenderOptions = (): RenderOptions => {
    const columns = getColumns();
    const frameWidth = Math.min(
      maxWidth,
      Math.max(minWidth, Math.min(columns - 2, maxWidth)),
    );
    const innerWidth = Math.max(10, frameWidth - 2);
    return { theme, frameWidth, innerWidth, maxVisibleItems };
  };

  const doRender = (state: TypeaheadSessionState | null): void => {
    if (!state) {
      // 无 state：擦除（clear 内部对 lastHeight=0 是 no-op）
      panel.clear();
      return;
    }
    const lines = renderSessionLines(state, computeRenderOptions());
    if (lines.length === 0) {
      // active provider 为 null（trigger 清掉了）→ 擦除
      panel.clear();
      return;
    }
    panel.render(lines);
  };

  // ── 按键处理 ──
  const handleKeypress = (_str: string, key: readline.Key | undefined): void => {
    if (!key) return;
    const state = lastState;
    // 只在有 active trigger 时消费按键；否则让宿主继续看（不过我们已经摘了
    // 宿主 listeners —— 宿主按键驱动由上层通过 broker.updateInput 来带）。
    if (!state || !state.trigger) return;

    // Esc 清 trigger —— 调 onCancel，由上层决定清 token 还是整 draft
    if (key.name === "escape") {
      options.onCancel?.();
      return;
    }

    // Ctrl+C 也关闭面板（和 Esc 同效，但不 swallow —— 上层可能要退 REPL）
    if (key.ctrl && key.name === "c") {
      options.onCancel?.();
      return;
    }

    // ↑↓ 导航：不要求 suggestions 非空（broker.moveSelection 内部短路）
    if (key.name === "up") {
      options.broker.moveSelection(options.sessionId, -1);
      return;
    }
    if (key.name === "down") {
      options.broker.moveSelection(options.sessionId, +1);
      return;
    }

    // Enter / Tab 接受选中项。零键执行（spec §6.5）的核心：
    // 用户刚打完 query，不用按 ↓ 选择，Enter 直接命中 index 0。
    if (key.name === "return" || key.name === "tab") {
      if (state.suggestions.length === 0) return;
      if (state.selectedIndex < 0) return;
      const item = state.suggestions[state.selectedIndex];
      if (!item) return;
      options.onAccept(item);
      return;
    }
  };

  // ── Session state 订阅回调 ──
  const onSessionChange = (state: TypeaheadSessionState): void => {
    lastState = state;
    doRender(state);
  };

  return {
    attach(): void {
      if (attached) return;
      attached = true;

      // 资源句柄：raw mode + stdin ownership（和 select-with-input 一样的模式）
      stdinOwnership = acquireStdinOwnership(stdin);
      rawModeLease = rawModeController.acquire(stdin);

      // 挂 keypress listener（在 stdin-ownership snapshot 之后 —— 这样 release
      // 时我们自己的 listener 已经由本文件的 detach() 主动摘除，不会和恢复的
      // saved listeners 并存）
      stdin.on("keypress", handleKeypress);

      // 订阅 broker session state 变更
      unsubscribe = options.broker.onSessionChange(
        options.sessionId,
        onSessionChange,
      );

      // 首次立即拉取一次 state（可能 broker 已经有 suggestions）
      const initial = options.broker.getState(options.sessionId);
      if (initial) {
        lastState = initial;
        doRender(initial);
      }

      // 确保 stdin flowing 以触发 keypress
      if (typeof stdin.resume === "function") {
        stdin.resume();
      }
    },

    detach(): void {
      if (!attached) return;
      attached = false;

      // 先解订阅（避免 detach 过程中再被回调打扰）
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }

      // 摘自己挂的 listener —— 必须在 stdinOwnership.release 之前
      stdin.off("keypress", handleKeypress);

      // 擦除面板（防止残留行）
      panel.clear();

      // 释放 raw mode 在前（可能 restore isRaw），再恢复 saved listeners
      if (rawModeLease) {
        rawModeLease.release();
        rawModeLease = null;
      }
      if (stdinOwnership) {
        stdinOwnership.release();
        stdinOwnership = null;
      }

      lastState = null;
    },

    rerender(): void {
      if (!attached) return;
      doRender(lastState);
    },

    get lastRenderHeight(): number {
      return panel.lastRenderHeight;
    },
  };
}
