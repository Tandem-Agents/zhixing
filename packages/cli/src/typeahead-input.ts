/**
 * 输入区控制器 —— 一次 REPL 会话的持久输入区生命周期。
 *
 * 范式：从 per-turn `readInputLine(): Promise` 升级为 session-level `InputController`：
 *   - start() 一次性启动，stop() 真正释放；turn 之间不 cleanup
 *   - submit 触发 onSubmit 回调而非 resolve Promise，buffer commit + clear 后继续接收
 *   - suspend() / resume() 协调 select-with-input / config-editor 等独占 stdin 的面板
 *   - 实现 InputRegion 接口（renderLines + cursorPosition），写入位置交 ScreenController 协调
 *
 * 视觉契约：输入区 chrome 永驻屏幕底部；AI 输出 / 状态条由 ScreenController 统一编排。
 *
 * 兼容性：保留 `readInputLine` 作为单次输入薄包装——内部 new InputController + once 模式，
 * 让一次性使用场景（cli 测试 / 单次问答工具）API 简洁；测试通过该 facade 验证内部状态机
 * 完整路径不需感知持久化语义。
 */

import type * as readline from "node:readline";

import type {
  ITypeaheadBroker,
  RuntimeContext,
  SuggestionItem,
  TypeaheadSessionState,
} from "@zhixing/core";

import {
  ANSI,
  stringWidth,
  stripAnsi,
  tone,
  renderSessionLines,
  renderChrome,
  wrapToWidth,
  defaultTypeaheadTheme,
  type RenderOptions,
} from "./tui/index.js";
import { layoutInputBuffer } from "./input-layout.js";
import { wrapKeypressHandler } from "./paste-detector.js";
import {
  PASTE_TOKEN_PATTERN,
  type PasteRegistry,
} from "./paste-registry.js";
import { expandPastes, extractAliveIds } from "./paste-expand.js";
import {
  removeAllPasteTokens,
  tryAtomicEdit,
  type AtomicEditKind,
} from "./paste-atomic.js";
import {
  rawModeController,
  type RawModeLease,
} from "./tui/_internal/raw-mode.js";
import {
  acquireStdinOwnership,
  type StdinOwnershipHandle,
} from "./tui/_internal/stdin-ownership.js";
import { InputBuffer } from "./input-buffer.js";
import {
  CommandDispatcher,
  type DispatchResult,
} from "./command-dispatcher.js";
import {
  createScreenController,
  type ScreenController,
  type InputRegion,
} from "./screen/index.js";
import { detectTerminalCapability } from "./screen/terminal-capability.js";

const PASTE_FOLD_LINES = 4;
const PASTE_FOLD_BYTES = 200;

function shouldFoldPaste(content: string): boolean {
  if (Buffer.byteLength(content, "utf8") >= PASTE_FOLD_BYTES) return true;
  const trimmed = content.replace(/\n+$/, "");
  if (trimmed.length === 0) return false;
  return trimmed.split("\n").length >= PASTE_FOLD_LINES;
}

// ─── 结果 ───

export type InputLineResult =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "command-dispatched";
      readonly text: string;
      readonly dispatchResult: DispatchResult;
    }
  | { readonly kind: "cancelled"; readonly cause: "ctrl-c" | "ctrl-d" | "aborted" };

// ─── 选项 ───

export interface InputControllerOptions {
  readonly broker: ITypeaheadBroker;
  readonly dispatcher: CommandDispatcher;
  /** 构造 RuntimeContext —— 每次按键调一次，取最新 sessionBusy / cwd 等 */
  readonly getRuntime: () => RuntimeContext;

  readonly stdin?: NodeJS.ReadStream;
  /**
   * 屏幕协调器（推荐）—— 提供后输入区 chrome 由 screen 统一编排，写入永远在屏幕底部，
   * AI 输出 / 状态条向上累积；不提供时退化为直写 stdout（per-turn 兼容模式，仅 readInputLine
   * 单次场景使用）。
   */
  readonly screen?: ScreenController;
  /** stdout 输出流——仅 screen 未提供时使用 */
  readonly stdout?: NodeJS.WriteStream;

  /** prompt 前缀（caller 自带 ANSI 样式）；缺省 brand bold ❯ */
  readonly promptPrefix?: string;

  /** AbortSignal —— 外部提前取消（仅 readInputLine 一次性模式有效） */
  readonly signal?: AbortSignal;

  /** 覆盖终端宽度（测试用） */
  readonly columns?: number;

  /** 最大可见候选数（默认 12） */
  readonly maxVisibleItems?: number;

  /** Buffer 为空时的 dim 提示文字 */
  readonly placeholder?: string;

  /** 粘贴附件 registry（REPL session 级共享） */
  readonly registry?: PasteRegistry;
}

// 兼容性：保留旧名称导出（外部仍按 TypeaheadInputOptions import）
export type TypeaheadInputOptions = InputControllerOptions;

// ─── 回调签名 ───

export type SubmitHandler = (
  result: Extract<InputLineResult, { kind: "text" } | { kind: "command-dispatched" }>,
) => void | Promise<void>;

export type CancelHandler = (
  cause: "ctrl-c" | "ctrl-d" | "aborted",
) => void | Promise<void>;

// ─── InputController ───

type ControllerState = "stopped" | "active" | "suspended";

export class InputController implements InputRegion {
  private readonly options: InputControllerOptions;
  private readonly stdin: NodeJS.ReadStream;
  private readonly screen: ScreenController;
  /** 调用方传 screen 时为 true —— stop 时不 dispose 该 screen */
  private readonly ownsScreen: boolean;
  private readonly stdout: NodeJS.WriteStream;
  private readonly promptPrefix: string;
  private readonly maxVisibleItems: number;

  private state: ControllerState = "stopped";

  // 资源句柄（active 时持有，suspended 时释放，stopped 时为 null）
  private buffer: InputBuffer | null = null;
  private sessionHandleId: string | null = null;
  private lastSessionState: TypeaheadSessionState | null = null;
  private brokerUnsubscribe: (() => void) | null = null;
  private batcher: ReturnType<typeof wrapKeypressHandler> | null = null;
  private stdinOwnership: StdinOwnershipHandle | null = null;
  private rawModeLease: RawModeLease | null = null;
  private abortListenerAttached = false;

  private submitHandler: SubmitHandler | null = null;
  private cancelHandler: CancelHandler | null = null;

  // 渲染缓存（InputRegion 契约要求）
  private cachedLines: readonly string[] = [];
  private cachedCursor: { row: number; col: number } = { row: 0, col: 0 };

  constructor(options: InputControllerOptions) {
    this.options = options;
    this.stdin = options.stdin ?? process.stdin;
    this.stdout = options.stdout ?? process.stdout;
    this.promptPrefix = options.promptPrefix ?? tone.brand.bold("❯ ");
    this.maxVisibleItems = options.maxVisibleItems ?? 12;

    if (options.screen) {
      this.screen = options.screen;
      this.ownsScreen = false;
    } else {
      // 兼容模式：内部建一个 screen 走相同协议（per-turn 风格场景 + 单元测试
      // 用 PassThrough 模拟终端时仍可工作）。
      //
      // 探测失败时退化到合成 capability—— PassThrough mock 等非 TTY 环境下
      // ScreenController 仍能构造，写出的 ANSI 字节由 caller 自行处理（生产
      // caller 应优先注入 screen 显式控制 fallback；测试环境下捕获到 buffer
      // 验证字节流即可）
      const detection = detectTerminalCapability({ stdout: this.stdout });
      const capability = detection.ok
        ? detection.capability
        : {
            viewport: {
              rows:
                (this.stdout as NodeJS.WriteStream).rows ?? 24,
              cols:
                (this.stdout as NodeJS.WriteStream).columns ?? 80,
            },
            platform: process.platform,
            tmux: false,
          };
      this.screen = createScreenController({
        capability,
        stdout: this.stdout,
      });
      this.ownsScreen = true;
    }
  }

  // ─── 公共 API ───

  onSubmit(handler: SubmitHandler): void {
    this.submitHandler = handler;
  }

  onCancel(handler: CancelHandler): void {
    this.cancelHandler = handler;
  }

  start(): void {
    if (this.state !== "stopped") return;
    this.attachResources();
    this.state = "active";
    this.screen.attachInput(this);

    if (this.options.signal?.aborted) {
      this.handleAbort();
      return;
    }
    if (this.options.signal && !this.abortListenerAttached) {
      this.options.signal.addEventListener("abort", this.onAbort, { once: true });
      this.abortListenerAttached = true;
    }
  }

  stop(): void {
    if (this.state === "stopped") return;
    this.detachResources();
    this.screen.detachInput();
    if (this.ownsScreen) {
      this.screen.dispose();
    }
    this.state = "stopped";
  }

  suspend(): void {
    if (this.state !== "active") return;
    this.detachResources();
    this.screen.detachInput();
    this.state = "suspended";
  }

  resume(): void {
    if (this.state !== "suspended") return;
    this.attachResources();
    this.screen.attachInput(this);
    this.state = "active";

    if (this.options.signal?.aborted) {
      this.handleAbort();
    }
  }

  /**
   * 等待下一次 submit / cancel——一次性 promise，handler 自动 unbind。
   *
   * 持久输入区主循环（repl）每 turn 调一次 waitOnce 拿下次用户输入；input 实例本身在
   * turn 之间保持 active（chrome 持续可见），仅 onSubmit / onCancel 回调单次绑定。
   */
  waitOnce(): Promise<InputLineResult> {
    return new Promise<InputLineResult>((resolve) => {
      const finish = (result: InputLineResult): void => {
        this.submitHandler = null;
        this.cancelHandler = null;
        resolve(result);
      };
      this.submitHandler = (result) => finish(result);
      this.cancelHandler = (cause) => finish({ kind: "cancelled", cause });
    });
  }

  // ─── InputRegion 接口 ───

  renderLines(): readonly string[] {
    this.computeRender();
    return this.cachedLines;
  }

  cursorPosition(): { row: number; col: number } {
    return this.cachedCursor;
  }

  // ─── 内部资源管理 ───

  private attachResources(): void {
    this.buffer = new InputBuffer();
    this.lastSessionState = null;

    const sessionHandle = this.options.broker.beginSession(
      this.buffer.toTriggerContext(this.options.getRuntime()),
    );
    this.sessionHandleId = sessionHandle.id;

    this.brokerUnsubscribe = this.options.broker.onSessionChange(
      sessionHandle.id,
      (state) => {
        this.lastSessionState = state;
        this.requestRepaint();
      },
    );

    this.lastSessionState = this.options.broker.getState(sessionHandle.id);

    this.stdinOwnership = acquireStdinOwnership(this.stdin);
    this.rawModeLease = rawModeController.acquire(this.stdin);

    this.batcher = wrapKeypressHandler({
      onSingle: (str, key) => this.handleKeypress(str, key),
      onPaste: (content) => this.finalizePaste(content),
    });
    this.stdin.on("keypress", this.batcher.handler);
    if (typeof this.stdin.resume === "function") {
      this.stdin.resume();
    }
  }

  private detachResources(): void {
    if (this.batcher) {
      this.stdin.off("keypress", this.batcher.handler);
      this.batcher.release();
      this.batcher = null;
    }
    if (this.brokerUnsubscribe) {
      this.brokerUnsubscribe();
      this.brokerUnsubscribe = null;
    }
    if (this.sessionHandleId) {
      this.options.broker.cancelSession(this.sessionHandleId);
      this.sessionHandleId = null;
    }
    if (this.options.signal && this.abortListenerAttached) {
      this.options.signal.removeEventListener("abort", this.onAbort);
      this.abortListenerAttached = false;
    }
    if (this.rawModeLease) {
      this.rawModeLease.release();
      this.rawModeLease = null;
    }
    if (this.stdinOwnership) {
      this.stdinOwnership.release();
      this.stdinOwnership = null;
    }
    this.buffer = null;
    this.lastSessionState = null;
  }

  private requestRepaint(): void {
    if (this.state !== "active") return;
    this.screen.requestInputRepaint();
  }

  private getColumns(): number {
    if (typeof this.options.columns === "number") return this.options.columns;
    return this.stdout.columns ?? 80;
  }

  private computeRenderOptions(): RenderOptions {
    const columns = this.getColumns();
    const frameWidth = Math.max(40, columns);
    const innerWidth = Math.max(10, frameWidth - 2);
    return {
      theme: defaultTypeaheadTheme,
      frameWidth,
      innerWidth,
      maxVisibleItems: this.maxVisibleItems,
    };
  }

  /**
   * 计算输入区一帧的 lines + cursor 位置——纯函数（不写 stdout / 不动 ANSI）。
   *
   * 行结构：
   *   [box top]
   *   [box body line 0]   ← cursorRow 可能落在 body 任一行
   *   [box body line 1]
   *   ...
   *   [box bottom]
   *   [panel line 0]
   *   ...
   */
  private computeRender(): void {
    if (!this.buffer || this.state === "stopped") {
      this.cachedLines = [];
      this.cachedCursor = { row: 0, col: 0 };
      return;
    }

    // suffix 语义互斥：buffer 空 → placeholder；非空且 cursor 在末尾且有 ghost → ghost text
    const cursorAtEnd =
      this.buffer.cursor === Array.from(this.buffer.draft).length;
    let suffix = "";
    if (this.buffer.isEmpty && this.options.placeholder) {
      suffix = `${ANSI.dim}${this.options.placeholder}${ANSI.reset}`;
    } else if (cursorAtEnd && this.lastSessionState?.ghostText?.suffix) {
      suffix = `${ANSI.dim}${this.lastSessionState.ghostText.suffix}${ANSI.reset}`;
    }

    const frameWidth = Math.max(40, this.getColumns());
    const contentBudget = Math.max(1, frameWidth - 4);
    const layout = layoutInputBuffer(
      this.promptPrefix,
      this.buffer.draft,
      this.buffer.cursor,
      suffix,
      contentBudget,
      PASTE_TOKEN_PATTERN,
    );

    const boxLines = renderChrome({
      body: layout.bodyLines,
      width: frameWidth,
      bodyPadding: false,
      indent: 1,
    });

    const panelLines = this.lastSessionState
      ? renderSessionLines(this.lastSessionState, this.computeRenderOptions())
      : [];

    const lines = [...boxLines, ...panelLines];
    // box 顶边占 1 行，cursor body row 在 box body 内 → 屏幕行偏移 = 1 + layout.cursorRow
    const cursorRow = 1 + layout.cursorRow;
    // 屏幕列：左 │ 1 列 + indent 1 列 + cursorCol（含 prompt / hanging 偏移）
    const cursorCol = 2 + layout.cursorCol;

    this.cachedLines = lines;
    this.cachedCursor = { row: cursorRow, col: cursorCol };
  }

  // ─── 事件处理 ───

  private onAbort = (): void => {
    this.handleAbort();
  };

  private handleAbort(): void {
    this.fireCancel("aborted");
  }

  private fireCancel(cause: "ctrl-c" | "ctrl-d" | "aborted"): void {
    const handler = this.cancelHandler;
    void Promise.resolve(handler?.(cause));
  }

  private fireSubmit(
    result: Extract<InputLineResult, { kind: "text" } | { kind: "command-dispatched" }>,
  ): void {
    const handler = this.submitHandler;
    void Promise.resolve(handler?.(result));
  }

  private handleKeypress(
    str: string,
    key: readline.Key | undefined,
  ): void {
    if (!key) return;
    if (this.state !== "active" || !this.buffer) return;

    if (key.ctrl && key.name === "c") {
      this.echoCancelLine();
      this.fireCancel("ctrl-c");
      return;
    }
    if (key.ctrl && key.name === "d") {
      if (this.buffer.isEmpty) {
        this.echoCancelLine();
        this.fireCancel("ctrl-d");
        return;
      }
      if (!this.tryAtomicKeypress("delete")) {
        this.buffer.deleteForward();
      }
      this.syncBroker();
      return;
    }

    const hasActiveSuggestions =
      this.lastSessionState !== null &&
      this.lastSessionState.trigger !== null &&
      this.lastSessionState.suggestions.length > 0;

    if (key.name === "escape") {
      if (
        this.lastSessionState &&
        this.lastSessionState.trigger &&
        this.lastSessionState.suggestions.length > 0
      ) {
        const tokenStart = this.lastSessionState.trigger.tokenStart;
        const chars = Array.from(this.buffer.draft);
        this.buffer.setDraft(chars.slice(0, tokenStart).join(""), tokenStart);
        this.syncBroker();
        return;
      }
      this.buffer.clear();
      this.syncBroker();
      return;
    }

    if (key.name === "up") {
      if (hasActiveSuggestions && this.sessionHandleId) {
        this.options.broker.moveSelection(this.sessionHandleId, -1);
        return;
      }
      this.buffer.historyPrev();
      this.syncBroker();
      return;
    }
    if (key.name === "down") {
      if (hasActiveSuggestions && this.sessionHandleId) {
        this.options.broker.moveSelection(this.sessionHandleId, +1);
        return;
      }
      this.buffer.historyNext();
      this.syncBroker();
      return;
    }

    if (key.name === "tab") {
      if (this.lastSessionState?.ghostText && this.sessionHandleId) {
        const result = this.options.broker.acceptGhostText(this.sessionHandleId);
        if (result) {
          this.buffer.setDraft(result.newDraft, result.newCursor);
          this.syncBroker();
          return;
        }
      }
      if (hasActiveSuggestions && this.lastSessionState) {
        const item =
          this.lastSessionState.suggestions[this.lastSessionState.selectedIndex];
        if (item) this.acceptSuggestion(item);
      }
      return;
    }

    if (key.name === "return") {
      if (hasActiveSuggestions && this.lastSessionState) {
        const item =
          this.lastSessionState.suggestions[this.lastSessionState.selectedIndex];
        if (item) {
          this.acceptSuggestion(item);
          return;
        }
      }
      void this.submit();
      return;
    }

    if (key.name === "backspace") {
      if (!this.tryAtomicKeypress("backspace")) {
        this.buffer.deleteBackward();
      }
      this.syncBroker();
      return;
    }

    if (key.name === "left") {
      if (!this.tryAtomicKeypress("left")) {
        this.buffer.moveCursorLeft();
      }
      this.requestRepaint();
      return;
    }
    if (key.name === "right") {
      if (!this.tryAtomicKeypress("right")) {
        this.buffer.moveCursorRight();
      }
      this.requestRepaint();
      return;
    }
    if (key.name === "home") {
      this.buffer.moveCursorHome();
      this.requestRepaint();
      return;
    }
    if (key.name === "end") {
      this.buffer.moveCursorEnd();
      this.requestRepaint();
      return;
    }

    if (str && !key.ctrl && !key.meta && !str.startsWith("\x1b")) {
      if (str === "\r" || str === "\n") return;
      this.buffer.insertText(str);
      this.syncBroker();
    }
  }

  private syncBroker(): void {
    if (!this.buffer || !this.sessionHandleId) return;
    if (this.options.registry) {
      this.options.registry.cleanup(extractAliveIds(this.buffer.draft));
    }
    this.options.broker.updateInput(
      this.sessionHandleId,
      this.buffer.toTriggerContext(this.options.getRuntime()),
    );
  }

  private finalizePaste(content: string): void {
    if (!this.buffer || this.state !== "active") return;

    let bufferWasClean = true;
    if (this.options.registry) {
      const removed = removeAllPasteTokens(this.buffer.draft, this.buffer.cursor);
      if (removed) {
        this.buffer.setDraft(removed.draft, removed.cursor);
        bufferWasClean = false;
      }
    }

    const shouldFold =
      !!this.options.registry && shouldFoldPaste(content) && bufferWasClean;
    if (shouldFold) {
      const id = this.options.registry!.register(content);
      this.buffer.insertText(this.options.registry!.format(id));
    } else {
      this.buffer.insertText(content);
    }
    this.syncBroker();
  }

  private tryAtomicKeypress(kind: AtomicEditKind): boolean {
    if (!this.buffer || !this.options.registry) return false;
    const result = tryAtomicEdit(this.buffer.draft, this.buffer.cursor, kind);
    if (!result) return false;
    if (kind === "left" || kind === "right") {
      this.buffer.setCursor(result.cursor);
    } else {
      this.buffer.setDraft(result.draft, result.cursor);
    }
    return true;
  }

  private acceptSuggestion(item: SuggestionItem): void {
    if (!this.buffer || !this.sessionHandleId) return;
    const accepted = this.options.broker.accept(this.sessionHandleId, item);
    if (!accepted) return;
    this.buffer.setDraft(accepted.newDraft, accepted.newCursor);
    if (accepted.execute) {
      void this.submit();
      return;
    }
    this.syncBroker();
  }

  /**
   * 提交当前 draft：
   *   - 把"原始 draft"（含占位符）渲染为 historyEcho 写入滚动区
   *   - expandPastes 还原占位符送给 dispatcher / agent 上层
   *   - / 前缀自动走 dispatcher，其它走 text 路径
   *   - submit 完成后 buffer.commit + clear，触发 onSubmit；输入区 chrome 自动重画为空 buffer
   */
  private async submit(): Promise<void> {
    if (!this.buffer) return;

    const rawDraft = this.buffer.draft;
    const expanded = this.options.registry
      ? expandPastes(rawDraft, this.options.registry)
      : rawDraft;
    const text = expanded.trim();

    // 必须先 commit 让 buffer 清空，再走 echo——echoSubmittedDraft 内的 withScrollWrite
    // 会调 input.renderLines() 重画 chrome；若 buffer 未 commit，首帧 chrome 仍含
    // rawDraft，与 historyEcho 视觉重复，紧接 commit 后又 repaint 一次修正。
    // 顺序对调后 chrome 直接显示空 buffer + placeholder，单帧无视觉抖动。
    this.buffer.commit();
    this.echoSubmittedDraft(rawDraft);

    if (!text) {
      this.fireSubmit({ kind: "text", text: "" });
      return;
    }

    if (text.startsWith("/")) {
      let dispatchResult: DispatchResult;
      try {
        dispatchResult = await this.options.dispatcher.dispatch(
          text,
          this.options.getRuntime(),
        );
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        dispatchResult = {
          kind: "error",
          error,
          commandId: "<unknown>",
        };
      }
      this.fireSubmit({ kind: "command-dispatched", text, dispatchResult });
      return;
    }

    this.fireSubmit({ kind: "text", text });
  }

  // ─── echo 写到滚动区（提交 / 取消时把当前内容降级为历史） ───

  private echoSubmittedDraft(rawDraft: string): void {
    const echoLines = this.buildHistoryEchoLines(rawDraft);
    if (echoLines.length === 0) return;
    this.screen.withScrollWrite((write) => {
      for (const line of echoLines) {
        write(line);
        write("\n");
      }
      // 段间空行——用户消息和后续 AI 回复 / 反馈之间留 1 行视觉间距
      write("\n");
    });
  }

  private echoCancelLine(): void {
    // cancel 路径不写 historyEcho（buffer 内容不进 scrollback）；仅写一个空行收束视觉
    this.screen.withScrollWrite((write) => {
      write("");
    });
  }

  private buildHistoryEchoLines(rawDraft: string): readonly string[] {
    if (rawDraft.length === 0) return [];
    const columns = this.getColumns();
    const echoBudget = Math.max(1, columns - 2);
    const chunks = wrapToWidth(rawDraft, echoBudget, PASTE_TOKEN_PATTERN);
    const lines: string[] = [];
    for (const chunk of chunks) {
      const innerText = `  ${chunk}`;
      const visibleWidth = stringWidth(stripAnsi(innerText));
      const padding = " ".repeat(Math.max(0, columns - visibleWidth));
      lines.push(tone.historyEcho(innerText + padding));
    }
    return lines;
  }
}

// ─── 单次输入 facade ───

/**
 * 一次性读取用户输入——内部 new InputController + once 模式。
 *
 * Promise 在用户 Enter / 取消时 resolve。生产代码（REPL 主循环）应直接用
 * InputController 长生命周期 API；本函数仅供单次输入场景（cli 子命令 / 集成测试）使用。
 */
export function readInputLine(
  options: InputControllerOptions,
): Promise<InputLineResult> {
  return new Promise<InputLineResult>((resolve) => {
    const controller = new InputController(options);
    controller.onSubmit((result) => {
      controller.stop();
      resolve(result);
    });
    controller.onCancel((cause) => {
      controller.stop();
      resolve({ kind: "cancelled", cause });
    });
    controller.start();
  });
}
