/**
 * InlineTextPromptRegion —— chrome inline 的单行文本输入（InputRegion 实现）
 *
 * **产品定位**：在 typeahead 候选列表上就地收集一行文本（重命名场景名 / 新建
 * 场景名），不切独立屏 —— 作为 chrome 底部输入区接管键盘，scrollback 始终可见。
 * 用户感觉是「在原地填一个名字」而非「被弹窗打断」。
 *
 * **架构契合**：与 SelectOperationRegion 同协议、同资源管理模式 —— 实现
 * InputRegion（renderLines + cursorPosition），run() 时 acquire（raw mode /
 * stdin ownership / keypress listener）+ screen.attachInput(self)，finish() 时
 * release + resolve。文本编辑委托 InputBuffer（字符 offset、CJK / emoji 安全）。
 *
 * **协作契约**：InputController（typeahead）先 suspend 让出键盘，本 region run()
 * 接管；run() resolve 后由 caller 调 inputController.resume() 恢复 typeahead ——
 * 与 SelectOperationRegion 的让位/恢复时序完全一致。
 *
 * **生命周期**：
 *   1. constructor —— 初始化 buffer（可选 prefill），不 attach 任何资源
 *   2. run() —— acquire 资源 + screen.attachInput(self)，返回 Promise<string|null>
 *      （Enter 提交文本 / Esc / abort 取消返回 null）
 *   3. handleKeypress —— 字符插入 / backspace / 光标移动 / Enter / Esc
 *   4. finish() —— release 资源、清 cachedLines 让 caller 切换 chrome、resolve
 */

import type * as readline from "node:readline";

import { tone, icon } from "./style.js";
import { renderChrome } from "./chrome.js";
import { ANSI } from "./ansi.js";
import { layoutInputBuffer } from "../input-layout.js";
import { PASTE_TOKEN_PATTERN } from "../paste-registry.js";
import {
  rawModeController,
  type RawModeLease,
} from "./_internal/raw-mode.js";
import {
  acquireStdinOwnership,
  type StdinOwnershipHandle,
} from "./_internal/stdin-ownership.js";
import { wrapKeypressHandler } from "../paste-detector.js";
import { InputBuffer } from "../input-buffer.js";
import type { InputRegion, ScreenController } from "../screen/index.js";

export interface InlineTextPromptOptions {
  /** 提示标题 —— 譬如 "重命名场景" / "新建场景"。本 region 加 ▎ 锚 + bold */
  readonly prompt: string;
  /** 预填文本 —— 重命名传当前名字（可编辑），新建传空 */
  readonly prefill?: string;
  /** 空 buffer 时的 dim 占位提示 */
  readonly placeholder?: string;
  /** 屏幕协调器 —— 通过 attachInput 接入 chrome */
  readonly screen: ScreenController;

  readonly stdin?: NodeJS.ReadStream;
  /** 外部取消信号 —— abort 等价取消（返回 null） */
  readonly signal?: AbortSignal;
  /** 覆盖终端宽度 —— 测试用 */
  readonly columns?: number;
  /** 输入框最小宽度（极窄终端兜底）；缺省 40，与候选面板同款 */
  readonly minWidth?: number;
}

export class InlineTextPromptRegion implements InputRegion {
  private readonly buffer = new InputBuffer();
  private cachedLines: readonly string[] = [];
  private cachedCursor: { row: number; col: number } = { row: 0, col: 0 };
  private finished = false;
  private resolveResult: ((r: string | null) => void) | null = null;

  private rawModeLease: RawModeLease | null = null;
  private stdinOwnership: StdinOwnershipHandle | null = null;
  private batcher: ReturnType<typeof wrapKeypressHandler> | null = null;

  private readonly stdin: NodeJS.ReadStream;
  private readonly screen: ScreenController;
  private readonly opts: InlineTextPromptOptions;

  constructor(opts: InlineTextPromptOptions) {
    this.opts = opts;
    this.screen = opts.screen;
    this.stdin = opts.stdin ?? process.stdin;
    if (opts.prefill) this.buffer.setDraft(opts.prefill);
    this.computeLines();
  }

  /**
   * 启动输入 + 等待用户提交 —— 核心入口。
   *
   * 资源 acquire 顺序与 SelectOperationRegion / InputController 一致：
   * stdinOwnership（摘除现有 listener）→ rawModeLease（进 raw 模式）→ 挂自己的
   * keypress listener → screen.attachInput(self)（chrome 切到本 region）。
   */
  run(): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      this.resolveResult = resolve;

      if (this.opts.signal?.aborted) {
        this.finish(null);
        return;
      }
      if (this.opts.signal) {
        this.opts.signal.addEventListener("abort", this.onAbort, { once: true });
      }

      this.stdinOwnership = acquireStdinOwnership(this.stdin);
      this.rawModeLease = rawModeController.acquire(this.stdin);

      this.batcher = wrapKeypressHandler({
        onSingle: (str, key) => this.handleKeypress(str, key),
        onPaste: (content) => this.handlePaste(content),
      });
      this.stdin.on("keypress", this.batcher.handler);

      if (typeof this.stdin.resume === "function") {
        this.stdin.resume();
      }

      this.screen.attachInput(this);
    });
  }

  // ─── InputRegion 接口 ───

  renderLines(): readonly string[] {
    return this.cachedLines;
  }

  cursorPosition(): { row: number; col: number } {
    return this.cachedCursor;
  }

  // ─── 渲染 ───

  private getColumns(): number {
    if (typeof this.opts.columns === "number") return this.opts.columns;
    return process.stdout.columns ?? 80;
  }

  /**
   * 渲染当前帧 —— 纯函数（不写 stdout）。结构：
   *   ▎ <prompt>              ← 标题行（brand 章节锚 + bold，框外标签缩进 1 格）
   *   ╭──────────────╮        ← 输入框（renderChrome 紧凑模式，与候选面板同宽）
   *   │ <文本>            │    ← 框内输入行
   *   ╰──────────────╯
   *   Enter 提交 · Esc 取消    ← hint 行（dim，框外标签缩进 1 格）
   *
   * 框内输入行复用普通输入框同款 `layoutInputBuffer`：文字默认色、光标走 reverse
   * SGR、placeholder dim —— 与 InputController 视觉完全一致（promptPrefix 传空，
   * 框内不需要 ❯）。边框 / padding / 宽度感知截断委托 renderChrome（CJK 安全）。
   */
  private computeLines(): void {
    const frameWidth = Math.max(this.opts.minWidth ?? 40, this.getColumns());
    const contentBudget = Math.max(1, frameWidth - 4);
    const suffix =
      this.buffer.isEmpty && this.opts.placeholder
        ? `${ANSI.dim}${this.opts.placeholder}${ANSI.reset}`
        : "";
    const layout = layoutInputBuffer(
      "",
      this.buffer.draft,
      this.buffer.cursor,
      suffix,
      contentBudget,
      PASTE_TOKEN_PATTERN,
      true,
    );
    const boxLines = renderChrome({
      body: layout.bodyLines,
      width: frameWidth,
      bodyPadding: false,
      indent: 1,
    });
    this.cachedLines = [
      ` ${tone.brand.bold(icon.section)}${tone.bold(this.opts.prompt)}`,
      ...boxLines,
      ` ${tone.dim("Enter 提交 · Esc 取消")}`,
    ];
    // 标题(1) + box 顶边(1) → cursor 落在第 2 + layout.cursorRow 行；
    // 列 = 左 │(1) + indent(1) + layout.cursorCol。
    this.cachedCursor = {
      row: 2 + layout.cursorRow,
      col: 2 + layout.cursorCol,
    };
  }

  // ─── 键盘处理 ───

  private handleKeypress(
    str: string,
    key: readline.Key | undefined,
  ): void {
    if (this.finished) return;

    // Ctrl+C / Esc 取消（返回 null）；Enter 提交当前 draft。
    if (key?.ctrl && key.name === "c") {
      this.finish(null);
      return;
    }
    if (key?.name === "escape") {
      this.finish(null);
      return;
    }
    if (key?.name === "return") {
      this.finish(this.buffer.draft);
      return;
    }
    if (key?.name === "backspace") {
      this.buffer.deleteBackward();
      this.repaint();
      return;
    }
    if (key?.name === "left") {
      this.buffer.moveCursorLeft();
      this.repaint();
      return;
    }
    if (key?.name === "right") {
      this.buffer.moveCursorRight();
      this.repaint();
      return;
    }

    // 可打印字符 —— str 比 key.name 可靠；过滤控制字符 / ESC 序列残留。
    if (
      str &&
      !key?.ctrl &&
      !key?.meta &&
      str !== "\r" &&
      str !== "\n" &&
      !str.startsWith("\x1b")
    ) {
      this.buffer.insertText(str);
      this.repaint();
    }
  }

  /** Paste 内容插入 —— 单行语义，剥掉换行符（用户可能误粘多行）。 */
  private handlePaste(content: string): void {
    if (this.finished) return;
    const oneLine = content.replace(/[\r\n]+/g, "");
    if (!oneLine) return;
    this.buffer.insertText(oneLine);
    this.repaint();
  }

  private repaint(): void {
    this.computeLines();
    this.screen.requestInputRepaint();
  }

  private onAbort = (): void => {
    this.finish(null);
  };

  /**
   * 终止入口 —— 资源 release（与 acquire 反向）+ 让出 chrome + resolve。
   *
   * 不调 screen.detachInput（后者用于 cli 退出 chrome 会清整屏）；清空
   * cachedLines + requestInputRepaint 让 chrome 先收起本 region，chrome 的恢复
   * 由 caller 调 inputController.resume()（screen.attachInput 替换语义）完成。
   */
  private finish(result: string | null): void {
    if (this.finished) return;
    this.finished = true;

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

    this.cachedLines = [];
    this.screen.requestInputRepaint();

    const resolve = this.resolveResult;
    this.resolveResult = null;
    if (resolve) resolve(result);
  }
}
