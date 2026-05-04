/**
 * SelectWithInput — 终端中的 Select + 内嵌 Input 组件
 *
 * 核心能力：
 *   1. 上/下箭头 + Enter 导航选项
 *   2. 某些选项是 `type: "input"` ——选中它们后 Enter 进入 input 模式，
 *      用户敲字符进缓冲区；再按 Enter 提交 { value, note }
 *   3. Ctrl+C / Ctrl+D / Esc 返回取消结果
 *   4. 面板原地重绘（spec §6.4 的 cursor 不变量）
 *   5. 终端宽度自适应 + CJK 全角字符正确计算宽度
 *   6. 终端 resize 时自动 rerender
 *   7. AbortSignal 外部取消
 *
 * 零依赖（只用 Node 内建 `readline.emitKeypressEvents` + ANSI 转义码）。
 *
 * 领域无关：返回 `SelectResult`，不耦合 ConfirmationDecision——让同一个组件
 * 也能用于未来的 clarify / sudo / secret 等其它 modal 需求。
 */

import type * as readline from "node:readline";

import { ANSI } from "./ansi.js";
import {
  createPanelRenderer,
  type PanelRenderer,
} from "./_internal/cursor-invariants.js";
import { rawModeController } from "./_internal/raw-mode.js";
import { acquireStdinOwnership } from "./_internal/stdin-ownership.js";
import { clampLine, stringWidth } from "./line-width.js";
import { tone, icon } from "./style.js";

// ─── 类型 ───

/**
 * 选项——判别式联合。
 * - `simple`: 标准选项，Enter 直接产生 decision
 * - `input`: 选中后 Enter 切换到 input 模式；再次 Enter 提交 note
 */
export type SelectOption =
  | {
      type: "simple";
      value: string;
      label: string;
      /** 可选字母快捷键——按下即等于选中+Enter */
      hotkey?: string;
    }
  | {
      type: "input";
      value: string;
      label: string;
      placeholder: string;
      /** 允许空 buffer 按 Enter 提交（默认 false：空时不响应 Enter） */
      allowEmptySubmit?: boolean;
      hotkey?: string;
    };

/**
 * 取消原因——细分以便上层做差异化处理。
 */
export type SelectCancelCause = "ctrl-c" | "ctrl-d" | "escape" | "aborted";

/**
 * 组件的最终结果。
 */
export type SelectResult =
  | { kind: "selected"; value: string; note?: string }
  | { kind: "cancelled"; cause: SelectCancelCause };

// ─── 主题 ───

/**
 * 主题——所有视觉元素的可替换样式。
 */
export interface Theme {
  border: (s: string) => string;
  title: (s: string) => string;
  bodyText: (s: string) => string;
  selectedArrow: string;
  selectedLabel: (s: string) => string;
  unselectedArrow: string;
  unselectedLabel: (s: string) => string;
  placeholder: (s: string) => string;
  inputBuffer: (s: string) => string;
  inputCursor: string;
  hotkey: (s: string) => string;
  keyHintBar: (s: string) => string;
}

/**
 * Default theme 走 design token——视觉决策跟随 `tui/style.ts` 的 tone / icon。
 *
 * 关键 token 映射：
 *   border        → tone.warn   （黄色边框 = "等待用户决定"语义；confirmation/select 专属）
 *   selectedLabel → tone.brand  （选中态 = 品牌色）
 *   inputBuffer   → tone.brand  （正在输入的内容显眼）
 *   selectedArrow → icon.cursor （与其他面板共享 ▸ 选中标记）
 *   inputCursor   保留 ▎       （字符内光标，不是行选中标记，独立语义）
 */
export const defaultTheme: Theme = {
  border: (s) => tone.warn(s),
  title: (s) => tone.bold(s),
  bodyText: (s) => s,
  selectedArrow: `${icon.cursor} `,
  selectedLabel: (s) => tone.brand.bold(s),
  unselectedArrow: "  ",
  unselectedLabel: (s) => s,
  placeholder: (s) => tone.dim(s),
  inputBuffer: (s) => tone.brand(s),
  inputCursor: "▎",
  hotkey: (s) => tone.dim(s),
  keyHintBar: (s) => tone.dim(s),
};

// ─── 选项 ───

export interface SelectWithInputOptions {
  title: string;
  /** 正文——显示在选项列表之前。单字符串或多行数组 */
  body?: string | string[];
  options: SelectOption[];
  /** 主题覆盖（深度浅合并） */
  theme?: Partial<Theme>;

  /** 输入流——默认 process.stdin */
  stdin?: NodeJS.ReadStream;
  /** 输出流——默认 process.stdout */
  stdout?: NodeJS.WriteStream;

  /** 初始选中的 index——默认 0 */
  initialSelected?: number;

  /** 外部取消信号 */
  signal?: AbortSignal;

  /** 覆盖终端宽度探测（测试用） */
  columns?: number;
  /** 面板最小宽度——默认 40 */
  minWidth?: number;
  /** 面板最大宽度——默认 80 */
  maxWidth?: number;

  /** 底部快捷键条；设为空字符串可隐藏 */
  keyHintBar?: string;
}

// ─── Raw mode refcount shims（向后兼容导出） ───
//
// 原实现把 raw mode 引用计数放在本文件的模块级变量里。现在已抽到
// `_internal/raw-mode.ts` 作为通用内核。保留同名导出避免破坏已有测试的
// 断言（`_getRawModeRefcount` / `_resetRawModeRefcountForTests`）。

/** 测试辅助：读取 refcount。生产代码不应依赖。 */
export function _getRawModeRefcount(): number {
  return rawModeController.activeLeases();
}

// ─── 组件状态机 ───

interface ComponentState {
  selected: number;
  inputMode: boolean;
  inputBuffer: string;
}

// ─── 主函数 ───

/**
 * 渲染一个 Select + 内嵌 Input 面板，等待用户做出决定。
 *
 * 返回 Promise：
 *   - 用户选了 simple 项 → `{ kind: "selected", value }`
 *   - 用户选了 input 项并提交 → `{ kind: "selected", value, note }`
 *   - 用户按 Ctrl+C → `{ kind: "cancelled", cause: "ctrl-c" }`
 *   - 用户按 Ctrl+D → `{ kind: "cancelled", cause: "ctrl-d" }`
 *   - 用户按 Esc → `{ kind: "cancelled", cause: "escape" }`
 *   - 外部 abortSignal → `{ kind: "cancelled", cause: "aborted" }`
 *
 * 生产模式下本函数**独占 stdin**；不支持并发调用（上层通过 broker 串行化）。
 */
export function selectWithInput(
  options: SelectWithInputOptions,
): Promise<SelectResult> {
  if (options.options.length === 0) {
    return Promise.reject(new Error("selectWithInput: options is empty"));
  }

  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const theme: Theme = { ...defaultTheme, ...(options.theme ?? {}) };
  const minWidth = options.minWidth ?? 40;
  const maxWidth = options.maxWidth ?? 80;
  // customHintBar：undefined → 运行时根据 inputMode 渲染默认；
  //                ""        → 隐藏；
  //                string    → 固定文案。
  const customHintBar = options.keyHintBar;

  const state: ComponentState = {
    selected: Math.max(
      0,
      Math.min(options.options.length - 1, options.initialSelected ?? 0),
    ),
    inputMode: false,
    inputBuffer: "",
  };

  // 面板渲染器：封装 spec §6.4 的 cursor 不变量
  const panel: PanelRenderer = createPanelRenderer(stdout);

  return new Promise<SelectResult>((resolve) => {
    // ── AbortSignal 早退 ──
    if (options.signal?.aborted) {
      resolve({ kind: "cancelled", cause: "aborted" });
      return;
    }

    // ── 终端宽度探测 ──
    const getColumns = (): number => {
      if (typeof options.columns === "number") return options.columns;
      return stdout.columns ?? 80;
    };

    // ── 渲染 ──
    const render = (): string[] => {
      const columns = getColumns();
      // 外框宽度（包含两侧边框字符）
      const frameWidth = Math.min(
        maxWidth,
        Math.max(minWidth, Math.min(columns - 2, maxWidth)),
      );
      // 内容区宽度（不含左边框 "│ " 2 字节 + 右边框 "" 0 字节）
      // 我们的面板右侧不封口；只左边框 + 上/下边框。这简化了变宽行处理。
      const innerWidth = Math.max(10, frameWidth - 2);

      const lines: string[] = [];

      // ── 顶部边框 ──
      // ╭─ title ─────...───
      const titleSegment = ` ${options.title} `;
      const titleVisibleWidth = stringWidth(titleSegment);
      const dashesNeeded = Math.max(
        0,
        frameWidth - 2 - titleVisibleWidth,
      );
      lines.push(
        theme.border(
          `╭─${theme.title(titleSegment)}${"─".repeat(dashesNeeded)}`,
        ),
      );

      // ── body ──
      if (options.body !== undefined) {
        const bodyLines = Array.isArray(options.body)
          ? options.body
          : [options.body];
        for (const line of bodyLines) {
          lines.push(
            `${theme.border("│")}  ${clampLine(theme.bodyText(line), innerWidth - 2)}`,
          );
        }
        lines.push(theme.border("│"));
      }

      // ── 选项 ──
      options.options.forEach((opt, idx) => {
        const isCurrent = idx === state.selected;
        const arrow = isCurrent
          ? theme.selectedArrow
          : theme.unselectedArrow;

        let lineContent: string;

        if (isCurrent && state.inputMode && opt.type === "input") {
          // Input 模式下的当前行：label + buffer（或 placeholder）+ cursor
          const bufferDisplay = state.inputBuffer
            ? theme.inputBuffer(state.inputBuffer)
            : theme.placeholder(`(${opt.placeholder})`);
          lineContent = `${opt.label} ${bufferDisplay}${theme.inputCursor}`;
        } else {
          const label = isCurrent
            ? theme.selectedLabel(opt.label)
            : theme.unselectedLabel(opt.label);
          let suffix = "";
          if (opt.type === "input") {
            suffix += ` ${theme.placeholder("(Enter 输入)")}`;
          }
          if (opt.hotkey) {
            suffix += ` ${theme.hotkey(`(${opt.hotkey})`)}`;
          }
          lineContent = `${label}${suffix}`;
        }

        const line = `${theme.border("│")} ${arrow}${lineContent}`;
        lines.push(clampLine(line, frameWidth));
      });

      // ── 底部边框 ──
      lines.push(theme.border(`╰${"─".repeat(frameWidth - 1)}`));

      // ── 快捷键提示条 ──
      //
      // 模式感知：input 模式下的键义和 select 模式完全不同（Enter 是提交而
      // 不是进入，Esc 是退出输入而不是拒绝），不切换文案会误导用户。
      const hintBar =
        customHintBar !== undefined
          ? customHintBar
          : state.inputMode
            ? "Enter 提交 · Esc 退出输入 · Ctrl+C 中止"
            : "↑↓ 选择 · Enter 确认 · Esc 拒绝 · Ctrl+C 中止";
      if (hintBar) {
        lines.push(
          `  ${theme.keyHintBar(clampLine(hintBar, frameWidth - 2))}`,
        );
      }

      return lines;
    };

    // ── 原地重绘（委托给 panel renderer，其内部实现 spec §6.4 不变量） ──
    const rerender = (): void => {
      panel.render(render());
    };

    // ── 键盘处理 ──
    const handleKeypress = (str: string, key: readline.Key): void => {
      if (!key) return;

      // ── 全局：Ctrl+C / Ctrl+D 总是取消 ──
      if (key.ctrl && key.name === "c") {
        finish({ kind: "cancelled", cause: "ctrl-c" });
        return;
      }
      if (key.ctrl && key.name === "d") {
        finish({ kind: "cancelled", cause: "ctrl-d" });
        return;
      }

      // ── Input 模式下的键盘处理 ──
      if (state.inputMode) {
        const current = options.options[state.selected];
        if (!current || current.type !== "input") {
          // 安全网：不应发生（input 模式 + 当前不是 input 项）
          state.inputMode = false;
          rerender();
          return;
        }

        if (key.name === "return") {
          // Enter 提交
          if (!state.inputBuffer && !current.allowEmptySubmit) {
            // 空 buffer + 不允许空提交 → 吃掉这次按键，保持 input 模式
            return;
          }
          finish({
            kind: "selected",
            value: current.value,
            note: state.inputBuffer || undefined,
          });
          return;
        }

        if (key.name === "escape") {
          // Esc 退出 input 模式回到 select 模式
          state.inputMode = false;
          state.inputBuffer = "";
          rerender();
          return;
        }

        if (key.name === "backspace") {
          if (state.inputBuffer.length > 0) {
            // 按 code point 删（代理对安全）
            const chars = Array.from(state.inputBuffer);
            chars.pop();
            state.inputBuffer = chars.join("");
            rerender();
          }
          return;
        }

        // 可打印字符——str 字段比 key.name 可靠
        // UTF-8 中文通过 str 传入，key.name 为 undefined
        if (str && !key.ctrl && !key.meta && str !== "\r" && str !== "\n") {
          // 过滤掉控制字符（如果 str 里有 ESC 开头的残留序列）
          if (!str.startsWith("\x1b")) {
            state.inputBuffer += str;
            rerender();
          }
        }
        return;
      }

      // ── Select 模式 ──
      if (key.name === "up") {
        if (state.selected > 0) {
          state.selected--;
          rerender();
        }
        return;
      }
      if (key.name === "down") {
        if (state.selected < options.options.length - 1) {
          state.selected++;
          rerender();
        }
        return;
      }
      if (key.name === "return") {
        const current = options.options[state.selected];
        if (!current) return;
        if (current.type === "input") {
          // 切换到 input 模式
          state.inputMode = true;
          state.inputBuffer = "";
          rerender();
        } else {
          finish({ kind: "selected", value: current.value });
        }
        return;
      }
      if (key.name === "escape") {
        finish({ kind: "cancelled", cause: "escape" });
        return;
      }

      // Hotkey 支持：查找匹配的字母快捷键
      if (str && !key.ctrl && !key.meta) {
        const hotkey = str.toLowerCase();
        const matchIdx = options.options.findIndex(
          (o) => o.hotkey && o.hotkey.toLowerCase() === hotkey,
        );
        if (matchIdx !== -1) {
          state.selected = matchIdx;
          const match = options.options[matchIdx]!;
          if (match.type === "input") {
            state.inputMode = true;
            state.inputBuffer = "";
            rerender();
          } else {
            rerender();
            finish({ kind: "selected", value: match.value });
          }
          return;
        }
      }
    };

    // ── 终端 resize 处理 ──
    const handleResize = (): void => {
      // resize 时直接 rerender。新的 getColumns() 会看到新宽度。
      // 注意：resize 发生时如果 cursor 已经因为 reflow 被终端重排，
      // 我们的 "move up N" 数学可能略微失准一次；实践中很少因此可见。
      rerender();
    };

    // ── 外部 abort 处理 ──
    const onAbort = (): void => {
      finish({ kind: "cancelled", cause: "aborted" });
    };

    // ── 资源句柄（在 init 中 acquire，在 finish 中 release） ──
    //
    // Stdin 独占：摘除调用方预挂的 'keypress' 监听器，防止 readline 的 echo
    // 路径在面板外叠字（spec §6.4 陷阱 3）。acquireStdinOwnership 内部会幂等
    // 调用 readline.emitKeypressEvents 确保 decoder 就位。
    //
    // Raw mode lease：让 stdin 进入 raw 模式拿到字节级按键。rawModeController
    // 是模块级引用计数，多个 modal 并存时末次 release 才真正恢复原状态。
    const stdinOwnership = acquireStdinOwnership(stdin);
    const rawModeLease = rawModeController.acquire(stdin);

    // ── 清理 + resolve ──
    let finished = false;
    const finish = (result: SelectResult): void => {
      if (finished) return;
      finished = true;

      stdin.off("keypress", handleKeypress);
      if (typeof stdout.off === "function") {
        stdout.off("resize", handleResize);
      }
      if (options.signal && typeof options.signal.removeEventListener === "function") {
        options.signal.removeEventListener("abort", onAbort);
      }

      // 顺序很重要：先释放 raw mode（可能 restore stdin.isRaw），
      // 再恢复调用方的 keypress listeners（restore 的是 snapshot 时的状态）。
      rawModeLease.release();
      stdinOwnership.release();

      stdout.write(ANSI.showCursor);
      stdout.write("\n"); // 留一行空白，让后续输出不紧贴面板

      // 如果 stdin 是我们 resume 的，保持不 pause——调用方决定下一步做什么
      resolve(result);
    };

    // ── 初始化 ──
    stdout.write(ANSI.hideCursor);

    stdin.on("keypress", handleKeypress);
    if (typeof stdout.on === "function") {
      stdout.on("resize", handleResize);
    }
    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    // 首次渲染
    rerender();

    // 确保 stdin 处于 flowing 模式以触发 keypress 事件
    if (typeof stdin.resume === "function") {
      stdin.resume();
    }
  });
}

// ─── 测试辅助 ───

/**
 * 仅供测试用：重置 raw mode refcount。
 * 避免测试之间状态泄漏——生产代码**不要**调用。
 *
 * 实际委托给 `_internal/raw-mode` 的内核 reset。
 */
export function _resetRawModeRefcountForTests(): void {
  rawModeController.resetForTests();
}
