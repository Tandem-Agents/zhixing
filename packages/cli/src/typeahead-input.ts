/**
 * 输入区控制器 —— 一次 REPL 会话的持久输入区生命周期。
 *
 * 范式：从 per-turn `readInputLine(): Promise` 升级为 session-level `InputController`：
 *   - start() 一次性启动，stop() 真正释放；turn 之间不 cleanup
 *   - submit 触发 onSubmit 回调而非 resolve Promise，buffer commit + clear 后继续接收
 *   - suspend() / resume() 协调 SelectOperationRegion / config-editor 等独占 stdin 的面板
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
  recordKeypressEvent,
  recordStdinSnapshot,
} from "./security/keypress-dump.js";
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
import { InputBuffer, type InputBufferSnapshot } from "./input-buffer.js";
import {
  normalizeLeadingSlashAlias,
  normalizeLeadingSlashAliasInExpanded,
} from "./runtime/leading-slash-alias.js";
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
  | { readonly kind: "cancelled"; readonly cause: "ctrl-c" | "ctrl-d" | "aborted" }
  | {
      readonly kind: "inline-edit-request";
      readonly editKind: "rename" | "new";
      readonly item?: SuggestionItem;
    };

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

  /**
   * 删除选中候选 callback —— Ctrl+D 第二次按下时触发(第一次按下仅标记
   * broker 的 deletePending 准备态)。仅在 typeahead 当前 trigger 的 provider
   * 通过 `inlineActions.delete` 声明支持删除时生效。callback 负责物理删除 +
   * 业务编排(直调底层 repo / registry + active 切换 / 自动新建等);
   * InputController 在 `await callback` 完成后调 `broker.refresh` 触发候选
   * 列表刷新(避免视觉残留 + selectedIndex 指向已不存在候选)。
   */
  readonly onCandidateDelete?: (item: SuggestionItem) => Promise<void>;
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

export type InlineEditHandler = (
  request: Extract<InputLineResult, { kind: "inline-edit-request" }>,
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
  private inlineEditHandler: InlineEditHandler | null = null;
  /** suspend 时快照的输入态 —— resume 用它恢复 buffer + 重新 query（挂起/恢复对称）。 */
  private suspendedSnapshot: InputBufferSnapshot | null = null;

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
    recordStdinSnapshot("typeahead.suspend.entry", this.stdin, {
      stateBefore: this.state,
      hasBatcher: !!this.batcher,
      hasBuffer: !!this.buffer,
    });
    if (this.state !== "active") {
      recordKeypressEvent("typeahead.suspend.skip-not-active", {
        state: this.state,
      });
      return;
    }
    // **只摘 keypress 订阅层**(不释放 rawModeLease / stdinOwnership)——
    // confirm 面板 SelectOperationRegion 会自己 acquire 一层。让 rawModeController
    // refcount 在面板期间走 1→2→1 而不是 1→0→1→0→1,避免 Windows ConPTY 在
    // setRawMode(false)→setRawMode(true) 翻转后 keypress 静默死锁(可观测字段全
    // 正常但 keypress 事件不 emit)。
    // 快照当前输入态 —— resume 时恢复（候选浏览中途被 inline 编辑接管后原样还原）。
    // confirm 场景挂起时 buffer 已是空（命令已提交），快照为空 → resume 恢复空 = 现状。
    this.suspendedSnapshot = this.buffer?.snapshot() ?? null;
    this.detachKeypressOnly();
    // 不调 screen.detachInput()——scrollRegion.detachInput 会清整屏 + reset region
    // 状态（设计用于 cli 退出 chrome 模式），让 region 内的对话历史 + scrollback 全
    // 部丢失。chrome 切换应由 caller 调 screen.attachInput(newRegion) 用替换语义完
    // 成（refreshChrome 路径），自动保留 region content。
    //
    // suspend 期间 screen.input 仍指向本 InputController；computeRender 顶部检测
    // state==="suspended" → renderLines 返回空数组让 chrome 高度自然降到 status 行
    // 高度——chrome 切到「只剩 status bar」的紧凑形态。caller 接管 chrome 时调
    // attachInput(newRegion) 直接替换。
    this.screen.requestInputRepaint();
    this.state = "suspended";
    recordStdinSnapshot("typeahead.suspend.exit", this.stdin, {
      stateAfter: this.state,
      hasBatcher: !!this.batcher,
      hasBuffer: !!this.buffer,
    });
  }

  resume(): void {
    recordStdinSnapshot("typeahead.resume.entry", this.stdin, {
      stateBefore: this.state,
      hasBatcher: !!this.batcher,
      hasBuffer: !!this.buffer,
    });
    if (this.state !== "suspended") {
      recordKeypressEvent("typeahead.resume.skip-not-suspended", {
        state: this.state,
      });
      return;
    }
    // **只装回 keypress 订阅层**(rawModeLease + stdinOwnership 从 start() 起一直
    // 持有,suspend 没释放,这里不重复 acquire,避免 raw mode 翻转)。
    this.attachKeypressOnly();
    // 恢复挂起前的输入态：attachKeypressOnly 已用空 buffer 建了新 session，这里把
    // 快照 draft 写回并重新 query —— 候选浏览中途被 inline 编辑接管的场景，返回后
    // 面板原样恢复且反映最新数据（rename / new 已落盘）。快照空（confirm 场景）则跳过。
    const snapshot = this.suspendedSnapshot;
    this.suspendedSnapshot = null;
    if (snapshot && snapshot.draft) {
      this.buffer!.setDraft(snapshot.draft, snapshot.cursor);
      this.syncBroker();
    }
    // state 赋值顺序必须先于 screen.attachInput —— 后者经 enqueue→flush 同步
    // 触发 input.renderLines() → computeRender，依赖 state 反映"active"语义。
    // 与 start() 的相同顺序保持对偶；历史上 resume() 顺序与 start() 不一致，
    // 在 paintVisualCursor 引入 state 依赖前隐患不可见，现在显式拉齐。
    this.state = "active";
    this.screen.attachInput(this);
    recordStdinSnapshot("typeahead.resume.exit", this.stdin, {
      stateAfter: this.state,
      hasBatcher: !!this.batcher,
      hasBuffer: !!this.buffer,
    });

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
        this.inlineEditHandler = null;
        resolve(result);
      };
      this.submitHandler = (result) => finish(result);
      this.cancelHandler = (cause) => finish({ kind: "cancelled", cause });
      this.inlineEditHandler = (request) => finish(request);
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

  /**
   * 完整 attach —— start() 路径用。三层资源:
   *   1. broker session / buffer(逻辑层)
   *   2. stdinOwnership + rawModeLease(物理 stdin 层)
   *   3. batcher + keypress listener(事件订阅层)
   *
   * suspend / resume 之间**不重做层 2**(见 `attachKeypressOnly` / `detachKeypressOnly`):
   * 跨 confirm 面板让 raw mode 与 stdin ownership 持续持有,避免 setRawMode(false)
   * → setRawMode(true) 翻转触发 Windows ConPTY 的 keypress 静默死锁(postmortem
   * 2026-05-20 confirm-input-freeze-conpty, raw=true/flowing=true/listener 全对
   * 但事件不 emit 类问题)。
   */
  private attachResources(): void {
    this.attachLogicalAndStdin();
    this.attachKeypressOnly();
  }

  /**
   * 只摘 keypress 订阅层 —— suspend() 路径用。保留 stdinOwnership + rawModeLease,
   * 让 SelectOperationRegion 的 stdinOwnership.acquire 走 refcount 增量路径(1→2)
   * 而不是触发 setRawMode 翻转(0→1)。
   */
  private detachKeypressOnly(): void {
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
    this.buffer = null;
    this.lastSessionState = null;
  }

  /**
   * 只装回 keypress 订阅层 —— resume() 路径用。复用 start() 时已建的
   * stdinOwnership + rawModeLease(suspend 没动它们)。
   */
  private attachKeypressOnly(): void {
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

    this.batcher = wrapKeypressHandler({
      onSingle: (str, key) => this.handleKeypress(str, key),
      onPaste: (content) => this.finalizePaste(content),
    });
    this.stdin.on("keypress", this.batcher.handler);
    if (typeof this.stdin.resume === "function") {
      this.stdin.resume();
    }
  }

  /** stdin 物理层 attach —— 仅 start() 调用。 */
  private attachLogicalAndStdin(): void {
    this.stdinOwnership = acquireStdinOwnership(this.stdin);
    this.rawModeLease = rawModeController.acquire(this.stdin);
  }

  private detachResources(): void {
    this.detachKeypressOnly();
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
    // buffer / lastSessionState 已在 detachKeypressOnly 内置 null,此处不重复。
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
    // paintVisualCursor 的不变量谓词 = "input 资源 alive"，即 this.buffer !== null。
    // 选 buffer 存在性而非 this.state === "active" 的理由：
    //   - buffer 是 input 生命周期的真实物理资源 —— attachResources 同步创建、
    //     detachResources 同步置 null。它是"input alive"的事实源（SoT）
    //   - this.state 是字符串影子状态，赋值时机分散在 start() / resume() 中，
    //     并不保证早于 screen.attachInput 的同步 enqueue→flush→paint 链路
    //     （resume() 历史顺序：attachInput 在前、state="active" 在后）
    //   - 用物理资源做谓词等于"无脑正确"：computeRender 顶部已早返
    //     `!this.buffer || state==="stopped"`，到这里 buffer 必非 null →
    //     paintVisualCursor 恒为 true。suspended / detach 阶段 buffer=null 在
    //     早返就被拦住，根本到不了 layoutInputBuffer
    // 视觉效果：硬件光标在 chrome 期间由 ScreenController 永久隐藏，输入光标在
    // 此通过 reverse SGR 画在 cursorRow 上 —— 与 LLM 输出区写入完全解耦
    // （消除"两个光标"现象 + 输入光标节奏不跟随输出 chunk 频率）。
    const layout = layoutInputBuffer(
      this.promptPrefix,
      this.buffer.draft,
      this.buffer.cursor,
      suffix,
      contentBudget,
      PASTE_TOKEN_PATTERN,
      this.buffer !== null,
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

  // inline 编辑请求(Ctrl+R rename / Ctrl+N new)走独立第三路 —— 不混入
  // fireSubmit 的"提交"语义。由 waitOnce 的 inlineEditHandler resolve,REPL
  // 主循环消费后 suspend + 弹 InlineTextPromptRegion。
  private fireInlineEdit(
    request: Extract<InputLineResult, { kind: "inline-edit-request" }>,
  ): void {
    const handler = this.inlineEditHandler;
    void Promise.resolve(handler?.(request));
  }

  private handleKeypress(
    str: string,
    key: readline.Key | undefined,
  ): void {
    recordKeypressEvent("typeahead.handleKeypress.entry", {
      str: str ?? "",
      keyName: key?.name ?? null,
      ctrl: key?.ctrl ?? null,
      state: this.state,
      hasBuffer: !!this.buffer,
    });
    if (!key) return;
    if (this.state !== "active" || !this.buffer) return;

    if (key.ctrl && key.name === "c") {
      this.echoCancelLine();
      this.fireCancel("ctrl-c");
      return;
    }
    if (key.ctrl && key.name === "d") {
      // Ctrl+D 完全释放给"删除选中候选"功能 —— 仅在 typeahead 当前 trigger 的
      // provider 通过 `computeInlineActions` 声明 delete 时生效(目前 /resume 的
      // 对话候选、/work 的场景候选)。其他场景 swallow no-op 不走 EOF /
      // deleteForward(退出依赖 Ctrl+C 双击协议;删字符依赖 Backspace)。
      const state = this.lastSessionState;
      if (
        state &&
        state.inlineActions.delete &&
        state.suggestions.length > 0 &&
        state.selectedIndex >= 0 &&
        this.sessionHandleId
      ) {
        const selected = state.suggestions[state.selectedIndex]!;
        if (state.deletePending === selected.id) {
          void this.executeCandidateDelete(selected);
        } else {
          this.options.broker.markDeletePending(
            this.sessionHandleId,
            selected.id,
          );
        }
      }
      return;
    }
    if (key.ctrl && key.name === "r") {
      // Ctrl+R 重命名选中候选 —— 仅 provider 声明 rename 时生效。fireInlineEdit
      // 让 waitOnce resolve,主循环 suspend + 弹 InlineTextPromptRegion(预填当前名)。
      const state = this.lastSessionState;
      if (
        state &&
        state.inlineActions.rename &&
        state.suggestions.length > 0 &&
        state.selectedIndex >= 0
      ) {
        const selected = state.suggestions[state.selectedIndex]!;
        this.fireInlineEdit({
          kind: "inline-edit-request",
          editKind: "rename",
          item: selected,
        });
      }
      return;
    }
    if (key.ctrl && key.name === "n") {
      // Ctrl+N 新建 —— list 级操作,不依赖选中。fireInlineEdit 让主循环弹
      // 空白 InlineTextPromptRegion 收名字。
      const state = this.lastSessionState;
      if (state && state.inlineActions.create) {
        this.fireInlineEdit({ kind: "inline-edit-request", editKind: "new" });
      }
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
        // 渐进式 Esc：仅当截断到 tokenStart 真能去掉字符时清当前 typeahead token
        // （保留触发前缀，如 `/work ` —— 面板回到"未过滤全量"态）。token 已空
        // （tokenStart 已达 draft 末尾，截断是 no-op）则落到下方清空整个 buffer。
        // 命令面板 tokenStart=0 一步清空、argument 面板空 token 也一步清空，二者
        // 语义自然统一；少了这道判断时，`/work ` 这类空参数态按 Esc 会原地无反应。
        if (chars.length > tokenStart) {
          this.buffer.setDraft(chars.slice(0, tokenStart).join(""), tokenStart);
          this.syncBroker();
          return;
        }
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
    // 首位 `、` 等输入法别名按 `/` 喂 broker:typeahead 命令面板 / ghost text
    // 看到规范化后的 draft,显示层保留原字符不动(echo 走 rawDraft 路径)。
    // 单字符 alias 下 cursor 数值不变;扩展多字符 alias 须重映射 cursor。
    const ctx = this.buffer.toTriggerContext(this.options.getRuntime());
    this.options.broker.updateInput(this.sessionHandleId, {
      ...ctx,
      draft: normalizeLeadingSlashAlias(ctx.draft),
    });
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

  /**
   * 执行候选删除业务编排 —— Ctrl+D 第二次按下时调用。委托 onCandidateDelete
   * callback 做物理删除 + 业务编排(active 切换 / 新建 fallback 等),完成后
   * 调 broker.refresh 触发候选列表刷新(canonical 重置 + 重新 query),避免
   * 视觉残留删的项 / selectedIndex 指向已不存在候选。callback 抛错 swallow
   * 防止 unhandled rejection —— callback 内部应已处理 user-facing 错误展示。
   */
  private async executeCandidateDelete(
    selected: SuggestionItem,
  ): Promise<void> {
    if (!this.options.onCandidateDelete || !this.sessionHandleId) return;
    try {
      await this.options.onCandidateDelete(selected);
    } catch {
      // swallow
    }
    if (this.sessionHandleId) {
      this.options.broker.refresh(this.sessionHandleId);
    }
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

  /**
   * 接受 suggestion 并按 acceptPayload.execute 决定后续动作。
   *
   * ─── 严格执行顺序契约 ───
   *
   *   1. broker.accept(item)         —— **state-纯**，返回 AcceptResult，不动 broker session state
   *   2. buffer.setDraft(...)         —— buffer 先于任何 broker 观测被更新
   *   3a. execute=true → this.submit() —— submit 内 buffer.commit + syncBroker 一次性把 broker 同步到"buffer 已清空"
   *   3b. execute=false → this.syncBroker() —— broker 观测新 buffer 派生新 session（如 /file 后的 argument 补全）→ chrome 重画
   *
   * **不能调换的顺序**：若 broker 观测 buffer 先于 setDraft（如 broker.accept 内
   * 同步副作用触发 listener），chrome 会用旧 buffer 重画一次——经典 TOCTOU。
   * 详见 broker.ts accept 方法的 docstring 关于"历史 drift"的论证。
   *
   * **execute 路径不在此处 syncBroker** 的设计取舍：execute=true 意味着 buffer
   * 马上要被 submit 内的 commit 抹掉；中间多调一次 syncBroker 会让 broker 先观
   * 测 "/clear" 状态 → 多一次 chrome paint 显示 panel（1 match）→ 立刻又被 commit
   * 后的 syncBroker 抹成空。视觉上是 panel "闪一下"——浪费一次 paint。submit 内
   * 单点 syncBroker 直接从"buffer 旧 partial 文本"过渡到"empty"，单帧到位。
   */
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
    // 首位 `、` 等输入法别名按 `/` 喂下游 dispatcher;rawDraft 仍是用户原文
    // 用于 echo 显示,显示/解析在此分叉。基于 rawDraft.trim() 首位(用户原始
    // 输入意图)判断而非 expanded.trim() 首位:rawDraft 在长 paste 折叠时
    // 首位是 token `<`,expanded 首位是 paste 内容首字符 —— 若用 expanded
    // 判断会把"以顿号开头的粘贴文本"误识别为命令。
    const text = normalizeLeadingSlashAliasInExpanded(
      expanded.trim(),
      rawDraft.trim(),
    );

    // 严格顺序：commit → syncBroker → echo → dispatch
    //
    //   1. buffer.commit()       清空 buffer
    //   2. this.syncBroker()     通知 broker 新（空）buffer → broker 派生空 session →
    //                            listener 触发 chrome 重画用空 buffer。**execute 路径
    //                            TOCTOU 修复的关键点**：从 acceptSuggestion 进 submit 的
    //                            链路中，本次 syncBroker 是 chrome 重画的唯一时机；
    //                            缺失则 chrome 卡在 commit 前的 partial 文本（典型
    //                            现象：home 模式输入 `/cle` 回车后 chrome 仍显示
    //                            `/cle`，详见 acceptSuggestion + broker.accept docstring）
    //   3. echoSubmittedDraft    把原始 draft 落 scrollback 作为历史
    //                            （withScrollWrite 只 appendInline + repaintInputCursor，
    //                            不触发 refreshChrome —— chrome 内容此时已由 #2 同步好）
    //   4. dispatch              async 执行命令
    this.buffer.commit();
    this.syncBroker();
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
    // 段前空行幂等保证：处理"上一段不带段后空行"的场景（典型：LLM 输出段
    // mdStream.end 仅 emit 单 \n，不含段间空行）。ScreenController 端按 scroll
    // region 视觉行级 tail state 决定补 0/1/2 个 \n；上一段已带空行时 no-op，
    // 不破坏 welcome→user、handler→user 等已正常的路径。
    this.screen.ensureScrollLeadingBlank();
    this.screen.withScrollWrite((write) => {
      for (const line of echoLines) {
        write(line);
        write("\n");
      }
      // 段后空行——保留既有契约让本段对后续段也提供间距，与 ensureScrollLeadingBlank
      // 形成双向保护（既保自己上方、又给下段留段前空间）
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
