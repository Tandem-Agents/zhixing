/**
 * SelectOperationRegion —— chrome inline 的 select 面板（InputRegion 实现）
 *
 * **产品定位**：权限请求面板不切独立屏——作为 chrome 底部的"操作区"，与 status bar
 * 共存，scrollback 始终可见。用户感觉是「对话流的继续」而非「被弹窗打断」。
 *
 * **架构契合**：
 *   - 实现 InputRegion（renderLines + cursorPosition），通过 ScreenController.attachInput
 *     接入 chrome——与 InputController（typeahead input）同协议、可互换
 *   - 资源管理（raw mode / stdin ownership / keypress listener）参照 InputController
 *     模式：构造时初始化，run() 时 acquire，finish() 时 release，零资源泄漏
 *   - 状态机走 `tui/_internal/select-state.ts` 纯 reducer——pure function 易测
 *     + 状态机/渲染解耦，让本组件的渲染层（chrome inline 形态）能独立演进
 *
 * **视觉契约（对话流嵌入式 + ▎ 章节锚）**：
 *
 *     ▎ 需要授权 · Bash 命令                          ← brand cyan ▎ + bold title
 *       $ git -C D:\ZhixingWorkspace remote -v       ← 4 列 indent body
 *       外部 · 中风险 · 无匹配规则                    ← dim 元信息
 *                                                    ← 空行
 *     ▸ 允许这一次                              y      ← brand bold + 主轴对齐
 *       始终允许 "git *"  ⚠ 持久授权            a      ← 持久授权 ⚠ 警示
 *       拒绝并说明原因                           n
 *                                                    ← 空行
 *       Enter 确认 · Esc 取消                          ← dim hint
 *
 * **生命周期**：
 *   1. constructor —— 初始化 state，不 attach 任何资源
 *   2. run() —— acquire raw mode + stdin + keypress listener；screen.attachInput(self)；
 *      返回 Promise<SelectResult>
 *   3. 用户按键 → handleKeypress → 翻译 SelectAction → reducer 推进 → result 出现时
 *      finish()
 *   4. finish() —— release 资源，screen.detachInput()，resolve Promise
 *
 * **不感知 confirmation 领域**：title / body / options 由 caller (terminal-renderer)
 * 构造好传入。本模块仅做"select 面板的通用 inline 呈现"，未来若有其他场景需要
 * inline modal（譬如 clarify / sudo）可直接复用。
 */

import type * as readline from "node:readline";

import { tone, icon, layout } from "../tui/style.js";
import { stringWidth } from "../tui/line-width.js";
import {
  rawModeController,
  type RawModeLease,
} from "../tui/_internal/raw-mode.js";
import {
  acquireStdinOwnership,
  type StdinOwnershipHandle,
} from "../tui/_internal/stdin-ownership.js";
import {
  makeInitialSelectState,
  reduceSelect,
  type SelectAction,
  type SelectState,
} from "../tui/_internal/select-state.js";
import type {
  SelectOption,
  SelectResult,
} from "../tui/select-types.js";
import { wrapKeypressHandler } from "../paste-detector.js";
import type {
  InputRegion,
  ScreenController,
} from "../screen/index.js";
import {
  isKeypressDumpEnabled,
  recordKeypressEvent,
} from "./keypress-dump.js";

export interface SelectOperationRegionOptions {
  /** 面板标题——caller 自带格式（譬如 "需要授权 · Bash 命令"），SelectOperationRegion 仅加 ▎ 锚 + bold */
  readonly title: string;
  /**
   * 正文——caller 已拼好 ANSI 的多行内容（命令、元信息、原因等）。
   * 每行起首会被加 4 列 indent（PREFIX + INDENT_UNIT）让其与 title 形成「附属下挂」视觉。
   */
  readonly body: readonly string[];
  /** 选项列表——SelectOption 联合（simple / input）。状态机 + 渲染共享类型 */
  readonly options: readonly SelectOption[];
  /** 屏幕协调器——通过 attachInput/detachInput 接入 chrome */
  readonly screen: ScreenController;

  readonly stdin?: NodeJS.ReadStream;
  /** 外部取消信号——abort 等价取消整个面板 */
  readonly signal?: AbortSignal;
  /** 覆盖终端宽度——测试用 */
  readonly columns?: number;
  /** 初始选中——默认 0 */
  readonly initialSelected?: number;
}

/** Body 行起首 indent —— 4 列（layout.contentPrefix 2 + 2 让 body 视觉附属于 title） */
const BODY_INDENT = layout.contentPrefix + "  ";
/** Hint 行起首 indent —— 与 options / title 主轴对齐 */
const HINT_INDENT = layout.contentPrefix;

/**
 * Panel 顶部视觉分隔线 —— 与 status bar 同宽延伸到 viewport 右边缘，
 * 作为「操作单元上边界」让 panel 与 status bar 视觉拉开。
 *
 * 宽度算法：columns - 1 - PREFIX.length —— 与 buildChromeBytes 的
 * lineBudget（columns - 1）扣除起手 PREFIX 缩进后一致，让横线与
 * status bar 同基线同尾边。
 *
 * 设计契合 P1 安静（仅 dim ─，无其他装饰）+ P5 单 brand cyan（不引入
 * 新色调）+ 视觉单元清晰（横线作上边界 / hint 行作下边界）。
 */
function makeSeparator(columns: number): string {
  const width = Math.max(
    10,
    columns - 1 - layout.contentPrefix.length,
  );
  return `${layout.contentPrefix}${tone.dim("─".repeat(width))}`;
}

export class SelectOperationRegion implements InputRegion {
  private state: SelectState;
  private cachedLines: readonly string[] = [];
  private finished = false;
  private resolveResult: ((r: SelectResult) => void) | null = null;

  private rawModeLease: RawModeLease | null = null;
  private stdinOwnership: StdinOwnershipHandle | null = null;
  private batcher: ReturnType<typeof wrapKeypressHandler> | null = null;
  /** Debug：原始 keypress listener（在 batcher 之前 observe，仅 ZHIXING_KEYPRESS_DUMP=1 时挂载） */
  private debugRawListener:
    | ((str: string, key: readline.Key | undefined) => void)
    | null = null;

  private readonly stdin: NodeJS.ReadStream;
  private readonly screen: ScreenController;
  private readonly opts: SelectOperationRegionOptions;

  constructor(opts: SelectOperationRegionOptions) {
    if (opts.options.length === 0) {
      throw new Error("SelectOperationRegion: options is empty");
    }
    this.opts = opts;
    this.screen = opts.screen;
    this.stdin = opts.stdin ?? process.stdin;
    this.state = makeInitialSelectState(opts.options, opts.initialSelected);
    this.computeLines();
  }

  /**
   * 启动面板 + 等待用户决策——核心入口。
   *
   * 资源 acquire 顺序：
   *   1. stdinOwnership —— 摘除现有 keypress 监听器（典型是 readline 的）
   *   2. rawModeLease —— 让 stdin 进 raw 模式拿字节级按键
   *   3. attach 自己的 keypress listener（via wrapKeypressHandler）
   *   4. screen.attachInput(self) —— chrome 切换到本 region（refreshChrome 重画）
   *
   * 该顺序与 InputController 一致——keypress listener 必须在 stdinOwnership 之后
   * 注册（先清空、再挂自己），否则与他人 listener 共存导致双重接收。
   */
  run(): Promise<SelectResult> {
    return new Promise<SelectResult>((resolve) => {
      this.resolveResult = resolve;

      if (this.opts.signal?.aborted) {
        this.finish({ kind: "cancelled", cause: "aborted" });
        return;
      }
      if (this.opts.signal) {
        this.opts.signal.addEventListener("abort", this.onAbort, { once: true });
      }

      this.stdinOwnership = acquireStdinOwnership(this.stdin);
      this.rawModeLease = rawModeController.acquire(this.stdin);

      // Debug raw listener：在 batcher 之前 observe 每个 stdin keypress 原始
      // event，让我们看到 batcher 入口数据。仅 ZHIXING_KEYPRESS_DUMP=1 时挂载。
      if (isKeypressDumpEnabled()) {
        this.debugRawListener = (str, key) => {
          recordKeypressEvent("stdin.keypress-raw", {
            str: str ?? "",
            key: key ?? null,
            inputMode: this.state.inputMode,
            selected: this.state.selected,
          });
        };
        this.stdin.on("keypress", this.debugRawListener);
      }

      this.batcher = wrapKeypressHandler({
        onSingle: (str, key) => {
          recordKeypressEvent("batcher.onSingle", {
            str: str ?? "",
            key: key ?? null,
          });
          this.handleKeypress(str, key);
        },
        onPaste: (content) => {
          recordKeypressEvent("batcher.onPaste", {
            content,
            length: content.length,
            finished: this.finished,
            inputMode: this.state.inputMode,
          });
          if (this.finished || !this.state.inputMode) return;
          this.handlePasteInInput(content);
        },
      });
      this.stdin.on("keypress", this.batcher.handler);

      if (typeof this.stdin.resume === "function") {
        this.stdin.resume();
      }

      this.screen.attachInput(this);
      recordKeypressEvent("region.run-complete", {
        title: this.opts.title,
        optionsCount: this.opts.options.length,
      });
    });
  }

  // ─── InputRegion 接口 ───

  renderLines(): readonly string[] {
    return this.cachedLines;
  }

  cursorPosition(): { row: number; col: number } {
    // chrome 模式硬件光标永久隐藏——cursorPosition 仅 logical 占位（screen reader
    // / accessibility 追踪用）。返回 (0, 0) 让光标落 region 第一行第 1 列，安全无视觉副作用。
    return { row: 0, col: 0 };
  }

  // ─── 渲染 ───

  private getColumns(): number {
    if (typeof this.opts.columns === "number") return this.opts.columns;
    // 仅 stdout 有 columns；本 region 不持 stdout——通过 stdin 上游 stdout 不可达
    // 用 process.stdout.columns 兜底；测试可注入 opts.columns 覆盖
    return process.stdout.columns ?? 80;
  }

  /**
   * 渲染当前帧为 chrome lines —— 纯函数（不写 stdout / 不动 ANSI），由 ScreenController
   * 在 refreshChrome 时调 renderLines() 拿到此结果统一画 chrome 字节。
   *
   * 行结构（典型）：
   *   ▎ <title>               ← header
   *     <body line 1>          ← body × N
   *     <body line 2>
   *   (空行)
   *   ▸ <option 0>     hotkey  ← options（含 ▸ 选中标记 + hotkey 右对齐）
   *     <option 1>     hotkey
   *   (空行)
   *   <hint>                  ← hint
   *
   * input 模式下 options 当前选项行变 `▸ <label> <buffer>▎`（buffer 末尾的 ▎ 是视觉光标）
   */
  private computeLines(): void {
    const columns = this.getColumns();
    const lines: string[] = [];

    // 0. panel 顶部分隔线 —— 与 status bar 同宽（延伸到 viewport 右边缘），
    //    形成 chrome 内 panel 上边界，让 panel 与 status bar 视觉拉开
    lines.push(makeSeparator(columns));

    // 1. header —— ▎ brand cyan + title bold
    lines.push(
      `${layout.contentPrefix}${tone.brand(icon.section)} ${tone.bold(
        this.opts.title,
      )}`,
    );

    // 2. body —— 4 列起首附属下挂
    for (const bodyLine of this.opts.body) {
      lines.push(`${BODY_INDENT}${bodyLine}`);
    }

    // 3. 空行分隔
    lines.push("");

    // 4. options
    // hotkey 列右对齐到 `Math.min(columns - 4, 60)`——typical 80 col 终端 hotkey 落 76 列;
    // 极宽终端 hotkey 不超 60 列避免视觉过宽
    const hotkeyColumn = Math.min(60, columns - 4);
    this.opts.options.forEach((opt, idx) => {
      lines.push(this.renderOption(opt, idx, hotkeyColumn));
    });

    // 5. 空行分隔
    lines.push("");

    // 6. hint —— input 模式 / select 模式文案不同
    const hint = this.state.inputMode
      ? "Enter 提交 · Esc 退出输入"
      : "Enter 确认 · Esc 取消";
    lines.push(`${HINT_INDENT}${tone.dim(hint)}`);

    this.cachedLines = lines;
  }

  /**
   * 渲染单个 option 行 —— ▸ 选中 + label + (input 模式 buffer) + 右对齐 hotkey。
   */
  private renderOption(
    opt: SelectOption,
    idx: number,
    hotkeyColumn: number,
  ): string {
    const isCurrent = idx === this.state.selected;
    const cursor = isCurrent ? `${icon.cursor} ` : "  ";

    let labelContent: string;
    if (isCurrent && this.state.inputMode && opt.type === "input") {
      // input 模式下当前行：label + buffer（或 placeholder）+ 视觉光标 ▎
      const bufferDisplay = this.state.inputBuffer
        ? tone.brand(this.state.inputBuffer)
        : tone.dim(`(${opt.placeholder})`);
      labelContent = `${opt.label} ${bufferDisplay}▎`;
    } else {
      labelContent = isCurrent ? tone.brand.bold(opt.label) : opt.label;
    }

    // hotkey 右对齐 —— input 模式当前行不参与列对齐（buffer 长度不定 + 用户专注输入）
    if (
      isCurrent && this.state.inputMode &&
      opt.type === "input"
    ) {
      return `${layout.contentPrefix}${cursor}${labelContent}`;
    }

    if (!opt.hotkey) {
      return `${layout.contentPrefix}${cursor}${labelContent}`;
    }

    const hotkeyText = tone.dim(`(${opt.hotkey})`);
    // 计算 padding：行起首 = PREFIX(2) + cursor(2) = 4 列已用；之后 label 可见宽度
    // 已用宽度 = 4 + labelVisibleWidth；hotkey 视觉宽 = stringWidth("(x)") = 3
    // padding = hotkeyColumn - 已用宽度 - hotkeyVisible，至少 1 空格分隔
    const labelVisible = stringWidth(stripAnsiSimple(labelContent));
    const hotkeyVisible = stringWidth(`(${opt.hotkey})`);
    const occupied = 4 + labelVisible;
    const pad = Math.max(1, hotkeyColumn - occupied - hotkeyVisible);
    return `${layout.contentPrefix}${cursor}${labelContent}${" ".repeat(pad)}${hotkeyText}`;
  }

  // ─── 键盘处理 ───

  private handleKeypress(
    str: string,
    key: readline.Key | undefined,
  ): void {
    if (this.finished) {
      recordKeypressEvent("handleKeypress.early-return", { reason: "finished" });
      return;
    }

    if (key?.ctrl && key.name === "c") {
      recordKeypressEvent("handleKeypress.ctrl-c", {});
      this.finish({ kind: "cancelled", cause: "ctrl-c" });
      return;
    }
    if (key?.ctrl && key.name === "d") {
      recordKeypressEvent("handleKeypress.ctrl-d", {});
      this.finish({ kind: "cancelled", cause: "ctrl-d" });
      return;
    }

    const action = this.translateKey(str, key);
    recordKeypressEvent("translateKey.result", {
      str: str ?? "",
      keyName: key?.name ?? null,
      inputMode: this.state.inputMode,
      action: action ?? null,
    });
    if (!action) return;

    const bufferBefore = this.state.inputBuffer;
    const selectedBefore = this.state.selected;
    const { state: newState, result } = reduceSelect(
      this.state,
      action,
      this.opts.options,
    );
    recordKeypressEvent("reduceSelect.result", {
      bufferBefore,
      bufferAfter: newState.inputBuffer,
      selectedBefore,
      selectedAfter: newState.selected,
      inputModeAfter: newState.inputMode,
      stateChanged: newState !== this.state,
      result: result ?? null,
    });

    if (result) {
      this.finish(result);
      return;
    }

    if (newState !== this.state) {
      this.state = newState;
      this.computeLines();
      this.screen.requestInputRepaint();
      recordKeypressEvent("repaint.triggered", {
        cachedLinesCount: this.cachedLines.length,
        inputMode: this.state.inputMode,
        inputBuffer: this.state.inputBuffer,
      });
    }
  }

  /**
   * 把 readline 按键翻译为 SelectAction —— 模式感知（input vs select）。
   *
   * **key 可为 undefined**：readline 对某些字符路径（IME 中文输入 / 特殊解码）
   * emit `key=undefined + str=<字符>`。所有 key 属性访问用可选链 `key?.` 兼容
   * undefined；str 是字符内容更可靠的事实源（key.name 是按键 label，str 是字面）。
   */
  private translateKey(
    str: string,
    key: readline.Key | undefined,
  ): SelectAction | null {
    if (this.state.inputMode) {
      if (key?.name === "return") return { kind: "enter" };
      if (key?.name === "escape") return { kind: "escape" };
      if (key?.name === "backspace") return { kind: "backspace" };
      // 可打印字符——str 字段比 key.name 可靠；过滤控制字符 / ESC 序列残留
      if (
        str &&
        !key?.ctrl &&
        !key?.meta &&
        str !== "\r" &&
        str !== "\n" &&
        !str.startsWith("\x1b")
      ) {
        return { kind: "char", ch: str };
      }
      return null;
    }
    // select 模式
    if (key?.name === "up") return { kind: "up" };
    if (key?.name === "down") return { kind: "down" };
    if (key?.name === "return") return { kind: "enter" };
    if (key?.name === "escape") return { kind: "escape" };
    if (str && !key?.ctrl && !key?.meta) {
      return { kind: "hotkey", key: str.toLowerCase() };
    }
    return null;
  }

  /**
   * Paste 内容作为字符流添加到 input buffer —— 仅 input mode 调用。
   *
   * 复用 reduceSelect 的 char action（与单字符 keypress 相同语义），逐字符喂
   * reducer 推进 state。跳过换行符（用户可能误粘多行；reason 字段语义上单行）。
   *
   * 渲染只在最终一次调用（避免逐字符 N 次 refreshChrome 闪屏）。
   */
  private handlePasteInInput(content: string): void {
    let newState = this.state;
    for (const ch of content) {
      if (ch === "\r" || ch === "\n") continue;
      const result = reduceSelect(
        newState,
        { kind: "char", ch },
        this.opts.options,
      );
      newState = result.state;
    }
    if (newState !== this.state) {
      this.state = newState;
      this.computeLines();
      this.screen.requestInputRepaint();
    }
  }

  private onAbort = (): void => {
    this.finish({ kind: "cancelled", cause: "aborted" });
  };

  /**
   * 终止入口 —— 资源 release + 让出 chrome + resolve Promise。
   *
   * Release 顺序（与 acquire 反向）：
   *   1. off keypress listener + batcher.release
   *   2. signal.removeEventListener
   *   3. release raw mode lease
   *   4. release stdin ownership（恢复保存的 keypress listeners）
   *   5. 清空 cachedLines + requestInputRepaint —— chrome 立即重画到「只剩 status bar」
   *      紧凑形态（不调 screen.detachInput：后者用于 cli 退出 chrome 模式会清整屏 +
   *      reset region 状态，破坏对话历史 + scrollback。chrome 切换应由 caller
   *      (afterShow → inputController.resume) 调 screen.attachInput(newRegion) 替换
   *      语义自动完成）
   *   6. resolve Promise —— 必须最后，让 caller 在拿到 result 时所有资源已释放
   */
  private finish(result: SelectResult): void {
    if (this.finished) return;
    this.finished = true;
    recordKeypressEvent("finish", { result });

    if (this.debugRawListener) {
      this.stdin.off("keypress", this.debugRawListener);
      this.debugRawListener = null;
    }

    if (this.batcher) {
      this.stdin.off("keypress", this.batcher.handler);
      this.batcher.release();
      this.batcher = null;
    }

    if (this.opts.signal) {
      this.opts.signal.removeEventListener("abort", this.onAbort);
    }

    this.rawModeLease?.release();
    this.rawModeLease = null;
    this.stdinOwnership?.release();
    this.stdinOwnership = null;

    // 清空 cachedLines 让 chrome 在 caller 切换前先重画为「只剩 status bar」紧凑形态
    this.cachedLines = [];
    this.screen.requestInputRepaint();

    const resolve = this.resolveResult;
    this.resolveResult = null;
    if (resolve) resolve(result);
  }
}

/**
 * 简单 ANSI strip —— 用于计算 label 可见宽度。
 *
 * 不复用 tui/ansi.ts 的 stripAnsi（避免本模块对 ansi 模块的循环依赖风险）；
 * 仅识别 SGR 序列（`\x1b[...m`）—— 本 region 渲染的 ANSI 仅 chalk SGR，
 * 不会出现 OSC / 其他控制序列。
 */
function stripAnsiSimple(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
