/**
 * TypeaheadInputReader — 一次 REPL 行输入的完整生命周期
 *
 * 这是 Step 5 的"神经中枢"：把 InputBuffer / TypeaheadBroker / TypeaheadPanel /
 * CommandDispatcher 四件套接到一次 `readLine()` Promise 里。REPL 主循环每轮
 * 调一次 `readLine()`，拿到 `InputLineResult`，按 result 的 kind 决定下一步：
 *
 *   - `"text"`：普通对话，直接喂给 agent loop
 *   - `"command-dispatched"`：命令已分派，按 dispatchResult 决定
 *   - `"cancelled"`：Ctrl+C/D 或外部 abort
 *
 * 职责边界：
 *   - **本模块不认识 agent loop** —— 它只负责"拿到一行输入 + 跑 dispatcher"。
 *     agent 调用由 REPL 主循环在 `command-dispatched`（kind=agent-message / hybrid）
 *     或 `text` 情况下自己发起。
 *   - **本模块不做任何 rendering beyond typeahead panel + 输入行**。
 *     欢迎语 / renderer / summary 都在 REPL 主循环。
 *   - **prompt 行渲染**：自绘一行 `❯ ${draft}` 到 stdout，光标落在 draft + cursor
 *     位置。每次按键后重绘这一行。Typeahead panel 渲染在 prompt 行**下方**。
 *
 * 光标布局：
 *
 *   (startRow)   ❯ /new
 *   (startRow+1) ╭─ Commands · 6 matches ───
 *   (startRow+2) │  ❯ /new     Start a new session
 *   ...
 *
 * 每次 rerender 路径：先擦 panel → 移到 prompt 行列 0 → 清 prompt 行 → 重写
 * prompt → 输出 \r\n → 渲染 panel。Panel 的光标不变量由 cursor-invariants.ts
 * 保证，prompt 行我们自己管。
 *
 * 安全：raw mode 引用计数 + stdin-ownership snapshot/restore 与 SelectWithInput
 * 同款，相互不冲突。
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

/**
 * 粘贴折叠阈值——超过任一阈值则注册到 registry + 用占位符 token，否则直接 insertText
 * 短粘贴铺开。阈值数值见架构方案"折叠阈值"段说明。
 */
const PASTE_FOLD_LINES = 4;
const PASTE_FOLD_BYTES = 200;

/**
 * 折叠决策：内容达任一阈值即折叠。短内容（< 4 行 < 200 字节）直接铺开符合用户
 * "看到自己粘的小段代码"的视觉直觉；长内容折叠避免输入框被淹没。
 */
function shouldFoldPaste(content: string): boolean {
  if (Buffer.byteLength(content, "utf8") >= PASTE_FOLD_BYTES) return true;
  const trimmed = content.replace(/\n+$/, "");
  if (trimmed.length === 0) return false;
  return trimmed.split("\n").length >= PASTE_FOLD_LINES;
}
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

export interface TypeaheadInputOptions {
  readonly broker: ITypeaheadBroker;
  readonly dispatcher: CommandDispatcher;
  /** 构造 RuntimeContext —— 每次按键会调一次，取最新的 sessionBusy/cwd 等 */
  readonly getRuntime: () => RuntimeContext;

  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;

  /** prompt 前缀（caller 自带 ANSI 样式）；缺省 brand bold ❯ */
  readonly promptPrefix?: string;

  /** AbortSignal —— 外部提前取消 */
  readonly signal?: AbortSignal;

  /** 覆盖终端宽度（测试用） */
  readonly columns?: number;

  /** 最大可见候选数（默认 8） */
  readonly maxVisibleItems?: number;

  /**
   * Buffer 为空时显示的 dim 提示文字（如 "输入消息或 / 查看命令"）。
   * 输入第一个字符消失，删回空状态重新出现。
   * 不参与 buffer.draft，不会被 commit——仅是 prompt 行的 0 状态视觉装饰。
   */
  readonly placeholder?: string;

  /**
   * 粘贴附件 registry（REPL session 级共享，caller 注入）。
   * 注入后启用 paste 折叠：
   *   - 长内容（≥ 4 行 OR ≥ 200 字符）→ 注册到 registry，buffer.draft 里放占位符 token
   *   - 短内容 → 直接 buffer.insertText
   *   - 提交时占位符 expand 还原原文给上层；echo 保留占位符形态
   * 不传时退化为普通输入（paste 走 detector 默认丢弃路径）。
   */
  readonly registry?: PasteRegistry;
}

// ─── 主入口 ───

/**
 * 读取用户的一行输入。Promise 在用户 Enter 或取消时 resolve。
 *
 * **独占 stdin**：调用期间摘除调用方的 keypress listeners，结束时恢复。不支持
 * 并发调用（REPL 主循环串行调用）。
 */
export function readInputLine(
  options: TypeaheadInputOptions,
): Promise<InputLineResult> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const promptPrefix = options.promptPrefix ?? tone.brand.bold("❯ ");
  // 默认 12：刚好装下所有 10 条可见 builtin + 插件余量，普通终端 ≥20 行舒服容纳
  const maxVisibleItems = options.maxVisibleItems ?? 12;

  return new Promise<InputLineResult>((resolve) => {
    if (options.signal?.aborted) {
      resolve({ kind: "cancelled", cause: "aborted" });
      return;
    }

    const buffer = new InputBuffer();
    let lastSessionState: TypeaheadSessionState | null = null;

    // ── Broker 会话 ──
    const sessionHandle = options.broker.beginSession(
      buffer.toTriggerContext(options.getRuntime()),
    );

    const unsubscribe = options.broker.onSessionChange(
      sessionHandle.id,
      (state) => {
        lastSessionState = state;
        rerender();
      },
    );

    // 同步取一次初始 state（beginSession 内部会同步触发 updateInput）
    lastSessionState = options.broker.getState(sessionHandle.id);

    // ── 资源句柄 ──
    const stdinOwnership: StdinOwnershipHandle = acquireStdinOwnership(stdin);
    const rawModeLease: RawModeLease = rawModeController.acquire(stdin);

    // ── 帧状态 ──
    // firstRender: 首次渲染时光标在 prompt 行（不是 box body 行），rerender 入口
    // 跳过 moveUp 一次，让顶边直接覆盖当前空行；后续渲染光标都在 box body 的
    // cursorRow 行，需 moveUp(cursorRow + 1) 回顶边再重绘整帧。
    let firstRender = true;
    // box body 可能跨多行（draft wrap），cursor 在其中第几行——teardown 入口
    // 与 rerender 出口契约共用此值，避免 teardown 再走一遍 layout
    let lastCursorRow = 0;

    // ── 绘图 ──
    const getColumns = (): number => {
      if (typeof options.columns === "number") return options.columns;
      return stdout.columns ?? 80;
    };

    const computeRenderOptions = (): RenderOptions => {
      const columns = getColumns();
      // panel 与终端同宽，与上方输入框 box 完全对齐；minWidth=40 仅极窄终端兜底
      const frameWidth = Math.max(40, columns);
      const innerWidth = Math.max(10, frameWidth - 2);
      return {
        theme: defaultTypeaheadTheme,
        frameWidth,
        innerWidth,
        maxVisibleItems,
      };
    };

    /**
     * 一帧 = box（顶 + body 多行 + 底）+ panel N 行。
     *
     * 入口/出口光标契约：
     *   非首次渲染入口 = 上次出口 = box body 第 lastCursorRow 行 cursor 列
     *   首次渲染入口 = caller 调用前的当前行 col 任意（视作 box 顶边的占位）
     *   每次出口 = box body 第 cursorRow 行 cursor 列
     *
     * 渲染流程（每帧自洽，与上次帧的 box 高度 / panel 行数无关——clearBelow 一次清完）：
     *   1. moveUp(lastCursorRow + 1) 回 box 顶边行（首次跳过——光标本就在该行的位置）
     *   2. col0 + clearBelow 清光标右 + 下方所有内容（含旧 box 中下半 + 旧 panel）
     *   3. layoutInputBuffer 把 draft + suffix 按 contentBudget wrap 成多行
     *   4. 写 box（顶 + body 多行 + 底；每行 + \r\n）—— 光标到底边之下
     *   5. 写 panel N 行（每行 + \r\n）—— 光标到 panel 之下
     *   6. moveUp(bodyLines.length - cursorRow + N + 1) 回 box body 第 cursorRow 行 col 0
     *   7. forward(2 + cursorCol) 移到 cursor 列
     *      （2 = 左 │ 1 列 + indent 1 列；indent=1 是 input box 紧凑形态决策；
     *        cursorCol 已含 prompt/hanging 偏移）
     *
     * 整帧用 syncBegin / syncEnd 包裹，避免 TTY 分段 flush 让光标可见闪烁。
     *
     * clearBelow 的边界：moveUp 后光标在 box 顶边行——clearBelow 只清这一行
     * 光标右侧 + 下方，不会越过 box 顶边往上擦欢迎语 / 历史输出。
     */
    const rerender = (): void => {
      stdout.write(ANSI.syncBegin);

      // Step 1：回 box 顶边行（首次渲染时光标已在该行的占位位置——caller 调用前的换行）
      if (!firstRender) {
        stdout.write(ANSI.moveUp(lastCursorRow + 1));
      }
      firstRender = false;

      // Step 2：col0 + clearBelow 清整个 box + panel 残留
      stdout.write(ANSI.col0);
      stdout.write(ANSI.clearBelow);

      // Step 3：构造 suffix + layout
      // suffix 语义互斥：
      //   buffer 空 → placeholder（caller 注入的 0 状态文案）
      //   buffer 非空 + cursor 在末尾 + broker 有 ghost suffix → ghost text（命令补全建议）
      // buffer 空时 broker 自然无 trigger 也无 ghost，互斥自然成立；显式 if/else
      // 让阅读者一眼看清两者关系。光标不在末尾时 ghost 不显示——避免 mid-cursor 布局复杂化。
      const cursorAtEnd =
        buffer.cursor === Array.from(buffer.draft).length;
      let suffix = "";
      if (buffer.isEmpty && options.placeholder) {
        suffix = `${ANSI.dim}${options.placeholder}${ANSI.reset}`;
      } else if (cursorAtEnd && lastSessionState?.ghostText?.suffix) {
        suffix = `${ANSI.dim}${lastSessionState.ghostText.suffix}${ANSI.reset}`;
      }

      const frameWidth = Math.max(40, getColumns());
      // 紧凑 chrome contentBudget = frameWidth - (左 │ + indent + 右内边距 + 右 │) = frameWidth - 4
      const contentBudget = Math.max(1, frameWidth - 4);
      const layout = layoutInputBuffer(
        promptPrefix,
        buffer.draft,
        buffer.cursor,
        suffix,
        contentBudget,
        // 占位符作 atomic 单元——wrap 时整体不切碎；同时启用 `\n` 硬换行（短粘贴
        // 含 \n 走 buffer.insertText 后由此承接）
        PASTE_TOKEN_PATTERN,
      );
      lastCursorRow = layout.cursorRow;

      // Step 4：渲染 box——复用 renderChrome 原语（紧凑形态：bodyPadding=false + indent=1）
      const boxLines = renderChrome({
        body: layout.bodyLines,
        width: frameWidth,
        bodyPadding: false,
        indent: 1,
      });
      for (const line of boxLines) {
        stdout.write(line);
        stdout.write("\r\n");
      }

      // Step 5：渲染 panel（紧贴 box 底边之下，作为第二个独立 chrome）
      const panelLines = lastSessionState
        ? renderSessionLines(lastSessionState, computeRenderOptions())
        : [];
      for (const line of panelLines) {
        stdout.write(line);
        stdout.write("\r\n");
      }

      // Step 6：回 box body 第 cursorRow 行 col 0
      // 光标在所有内容之下 col 0；从 box body[cursorRow] 起向下数：
      //   (bodyLines.length - cursorRow - 1) 行 box body 之下
      //   + 1 行 bottom 边
      //   + N 行 panel
      //   + 1 行 panel 之下空行（\r\n 后光标停在末行之下）
      // = bodyLines.length - cursorRow + N + 1
      const upwardOffset =
        layout.bodyLines.length - layout.cursorRow + panelLines.length + 1;
      stdout.write(ANSI.moveUp(upwardOffset));

      // Step 7：从 col 0 forward 到 cursor 列
      // visible col = 1（左 │）+ 1（indent=1）+ cursorCol（含 prompt/hanging 偏移）
      const offset = 2 + layout.cursorCol;
      if (offset > 0) {
        stdout.write(`\x1b[${offset}C`);
      }

      stdout.write(ANSI.syncEnd);
    };

    /**
     * 销毁当前 box + panel 帧，把"刚提交的输入"降级为多行 historyEcho 进入
     * scrollback——历史不累积 box 视觉重量（设计语言 P1 安静原则）。
     *
     * - `finalEcho=text`：Submit 路径 —— 清整帧 + 多行 historyEcho（draft wrap 后逐行染色）
     * - `finalEcho=null`：Cancel 路径 —— 同样清整帧 + `\r\n`，不回显
     *
     * 入口光标契约与 rerender 出口一致：在 box body 第 lastCursorRow 行 cursor 位置
     * （首次例外）。moveUp(lastCursorRow + 1) 回顶边行 + clearBelow 清整个 box + panel；
     * 首次渲染前调 teardown 不会发生（teardown 只在 submit / cancel 路径触发，rerender
     * 至少跑过一次）。
     */
    const teardownVisuals = (finalEcho: string | null): void => {
      if (!firstRender) {
        stdout.write(ANSI.moveUp(lastCursorRow + 1));
      }
      stdout.write(ANSI.col0);
      stdout.write(ANSI.clearBelow);
      if (finalEcho !== null) {
        // 历史回显纯 bg 染色：bg 灰底已充分标识"用户消息"——不再带 ❯ prompt 字符
        // 避免与 active box 的"现在输入"语义重复（光标在历史里早不在了，❯ 是错位
        // 信号），也让用户复制历史消息时不带 prompt 前缀。前导 2 空格让文字不贴
        // bg 边缘视觉舒展；padding 到终端宽度让 bg 延伸到行末避免视觉锚断裂。
        //
        // 多行展开：超过终端宽度的 draft 按可见列 wrap，每段单独染色一行；续行不
        // 加 hanging（历史无"输入中"语义，无需 prompt 锚），仍统一前导 2 空格保持
        // 与第一行视觉对齐。
        const columns = getColumns();
        const echoBudget = Math.max(1, columns - 2);
        // 启用 atomic + `\n` 硬换行：echo 的 rawDraft 含占位符 token（不可切碎）
        // 与短粘贴 `\n`（必须按段独立 wrap），否则 bg 染色断裂或 token 中间被切
        const chunks = wrapToWidth(finalEcho, echoBudget, PASTE_TOKEN_PATTERN);
        for (const chunk of chunks) {
          const innerText = `  ${chunk}`;
          const visibleWidth = stringWidth(stripAnsi(innerText));
          const padding = " ".repeat(
            Math.max(0, columns - visibleWidth),
          );
          stdout.write(tone.historyEcho(innerText + padding));
          stdout.write("\r\n");
        }
      } else {
        stdout.write("\r\n");
      }
    };

    // ── 触发一次 broker updateInput ──
    const syncBroker = (): void => {
      // Orphan 回收：buffer.draft 改动后扫描 alive 占位符 id 集合，registry 中
      // 不在集合的 id 视为 orphan 删除。任何让占位符 regex 不再匹配的编辑（删占
      // 位符 / 中间打字破坏字符串）都自动触发回收，无需 InputBuffer 感知 registry
      if (options.registry) {
        options.registry.cleanup(extractAliveIds(buffer.draft));
      }
      options.broker.updateInput(
        sessionHandle.id,
        buffer.toTriggerContext(options.getRuntime()),
      );
    };

    /**
     * Paste detector 完成时调用。
     *
     * 单一不变量：**buffer 与占位符互斥**——buffer 同时只允许至多一个粘贴占位符，
     * 且占位符出现时 buffer 没有其他粘贴衍生的散落字符。规则：
     *
     *   1. 不论长短粘贴，先删除 buffer 中现存占位符（替换语义；用户每次粘贴都重新
     *      决定附件内容，旧附件被覆盖；用户手输的非粘贴文本原样保留）
     *   2. 长粘贴 + buffer 原本干净 → register 新 paste + 占位符 token（首次折叠）
     *   3. 短粘贴 / 长粘贴 + buffer 原本含占位符 → 直接铺开内容
     *
     * 旧 registry entry 在 syncBroker 触发的 cleanup 中自然 GC。
     * syncBroker 之后由 broker emit state change 自动触发 rerender。
     */
    const finalizePaste = (content: string): void => {
      // Step 1：先清理 buffer 中现有占位符（不论新内容长短）
      let bufferWasClean = true;
      if (options.registry) {
        const removed = removeAllPasteTokens(buffer.draft, buffer.cursor);
        if (removed) {
          buffer.setDraft(removed.draft, removed.cursor);
          bufferWasClean = false;
        }
      }

      // Step 2：决定折叠（首次长粘贴）还是铺开
      const shouldFold =
        !!options.registry && shouldFoldPaste(content) && bufferWasClean;
      if (shouldFold) {
        const id = options.registry!.register(content);
        buffer.insertText(options.registry!.format(id));
      } else {
        buffer.insertText(content);
      }
      syncBroker();
    };

    /**
     * 占位符原子编辑——backspace / delete / left / right 命中占位符边界时把整段
     * 当单一原子单元处理。命中走 setDraft；不命中返回 false，caller fallback 走
     * buffer 原方法（普通字符级编辑）。
     */
    const tryAtomicKeypress = (kind: AtomicEditKind): boolean => {
      if (!options.registry) return false;
      const result = tryAtomicEdit(buffer.draft, buffer.cursor, kind);
      if (!result) return false;
      if (kind === "left" || kind === "right") {
        // cursor 移动：draft 不变，只调 cursor
        buffer.setCursor(result.cursor);
      } else {
        buffer.setDraft(result.draft, result.cursor);
      }
      return true;
    };

    // ── 清理 ──
    //
    // 拆成 cleanup（detach listener + release stdin/raw-mode lock）与 finish（resolve
    // promise）两步，让 dispatch slash command 路径可在 dispatch 之前提前释放 stdin——
    // 否则 dispatch handler 想接管 stdin（如 /config 弹编辑器）会与本模块的 onKeypress
    // listener 双重处理按键，导致 stray prompt 渲染、Ctrl+C 误命中 cancel 路径、嵌套
    // dispatch 时旧 lock 残留。
    let cleaned = false;
    let finished = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;

      stdin.off("keypress", batcher.handler);
      batcher.release();
      unsubscribe();
      options.broker.cancelSession(sessionHandle.id);

      if (options.signal && typeof options.signal.removeEventListener === "function") {
        options.signal.removeEventListener("abort", onAbort);
      }

      rawModeLease.release();
      stdinOwnership.release();
    };
    const finish = (result: InputLineResult): void => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(result);
    };

    const onAbort = (): void => {
      teardownVisuals(null);
      finish({ kind: "cancelled", cause: "aborted" });
    };
    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    // ── Accept 逻辑（从 panel 按 Enter 时走这里） ──
    const acceptSuggestion = (item: SuggestionItem): void => {
      const accepted = options.broker.accept(sessionHandle.id, item);
      if (!accepted) return;
      buffer.setDraft(accepted.newDraft, accepted.newCursor);
      if (accepted.execute) {
        // 直接提交
        void submit();
        return;
      }
      // 不 execute：把 broker 同步到新 draft 并 rerender
      syncBroker();
    };

    // ── 提交当前 draft ──
    const submit = async (): Promise<void> => {
      // 捕获"原始 draft"（未 trim、含占位符）用于 teardown echo 保留占位符形态
      // 与折叠 UI 视觉一致；expanded 仅在送给 dispatcher / agent 的 text 路径上还原原文
      const rawDraft = buffer.draft;
      const expanded = options.registry
        ? expandPastes(rawDraft, options.registry)
        : rawDraft;
      const text = expanded.trim();
      teardownVisuals(rawDraft);
      buffer.commit();
      if (!text) {
        // 空行：直接 resolve 让 REPL 主循环 continue
        finish({ kind: "text", text: "" });
        return;
      }

      if (text.startsWith("/")) {
        // dispatch 之前提前释放 stdin/raw-mode——让 handler 可独占 stdin（如 /config
        // 弹编辑器）；本模块的 onKeypress listener 已 detach，不会与 handler 双重处理按键
        cleanup();

        let dispatchResult: DispatchResult;
        try {
          dispatchResult = await options.dispatcher.dispatch(
            text,
            options.getRuntime(),
          );
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          dispatchResult = {
            kind: "error",
            error,
            commandId: "<unknown>",
          };
        }

        if (finished) return;
        finished = true;
        resolve({ kind: "command-dispatched", text, dispatchResult });
        return;
      }

      finish({ kind: "text", text });
    };

    // ── 按键处理 ──
    const onKeypress = (str: string, key: readline.Key | undefined): void => {
      if (!key) return;

      // Ctrl+C / Ctrl+D
      if (key.ctrl && key.name === "c") {
        teardownVisuals(null);
        finish({ kind: "cancelled", cause: "ctrl-c" });
        return;
      }
      if (key.ctrl && key.name === "d") {
        // 仅当 buffer 为空时退出 REPL；否则视作普通 Ctrl+D = deleteForward
        if (buffer.isEmpty) {
          teardownVisuals(null);
          finish({ kind: "cancelled", cause: "ctrl-d" });
          return;
        }
        if (!tryAtomicKeypress("delete")) {
          buffer.deleteForward();
        }
        syncBroker();
        return;
      }

      // Typeahead 活跃时的按键优先级
      const hasActiveSuggestions =
        lastSessionState !== null &&
        lastSessionState.trigger !== null &&
        lastSessionState.suggestions.length > 0;

      if (key.name === "escape") {
        if (
          lastSessionState &&
          lastSessionState.trigger &&
          lastSessionState.suggestions.length > 0
        ) {
          // 只清 trigger token：回到 tokenStart 并截断
          const tokenStart = lastSessionState.trigger.tokenStart;
          const chars = Array.from(buffer.draft);
          buffer.setDraft(chars.slice(0, tokenStart).join(""), tokenStart);
          syncBroker();
          return;
        }
        // 无 active trigger：清整行
        buffer.clear();
        syncBroker();
        return;
      }

      if (key.name === "up") {
        if (hasActiveSuggestions) {
          options.broker.moveSelection(sessionHandle.id, -1);
          return;
        }
        // 历史浏览
        buffer.historyPrev();
        syncBroker();
        return;
      }
      if (key.name === "down") {
        if (hasActiveSuggestions) {
          options.broker.moveSelection(sessionHandle.id, +1);
          return;
        }
        buffer.historyNext();
        syncBroker();
        return;
      }

      if (key.name === "tab") {
        // Ghost text 优先 —— 有 ghost 时 Tab 接受 ghost，不走 dropdown accept
        if (lastSessionState?.ghostText) {
          const result = options.broker.acceptGhostText(sessionHandle.id);
          if (result) {
            buffer.setDraft(result.newDraft, result.newCursor);
            syncBroker();
            return;
          }
        }
        // Fallback：接受 dropdown 选中项
        if (hasActiveSuggestions && lastSessionState) {
          const item =
            lastSessionState.suggestions[lastSessionState.selectedIndex];
          if (item) acceptSuggestion(item);
        }
        return;
      }

      if (key.name === "return") {
        if (hasActiveSuggestions && lastSessionState) {
          const item =
            lastSessionState.suggestions[lastSessionState.selectedIndex];
          if (item) {
            acceptSuggestion(item);
            return;
          }
        }
        void submit();
        return;
      }

      if (key.name === "backspace") {
        if (!tryAtomicKeypress("backspace")) {
          buffer.deleteBackward();
        }
        syncBroker();
        return;
      }

      if (key.name === "left") {
        if (!tryAtomicKeypress("left")) {
          buffer.moveCursorLeft();
        }
        rerender();
        return;
      }
      if (key.name === "right") {
        if (!tryAtomicKeypress("right")) {
          buffer.moveCursorRight();
        }
        rerender();
        return;
      }
      if (key.name === "home") {
        buffer.moveCursorHome();
        rerender();
        return;
      }
      if (key.name === "end") {
        buffer.moveCursorEnd();
        rerender();
        return;
      }

      // 普通可打印字符
      if (str && !key.ctrl && !key.meta && !str.startsWith("\x1b")) {
        // 过滤纯控制符
        if (str === "\r" || str === "\n") return;
        buffer.insertText(str);
        syncBroker();
      }
    };

    // ── 初始化 ──
    // wrapKeypressHandler 自动按 10ms 时间窗 batch keypress：同步多次 emit 的
    // keypress（粘贴）走 onPaste → finalizePaste；单个 keypress（敲键）走原 onKeypress。
    // 不依赖 bracketed paste markers / stdin chunk 大小——跨终端兼容。
    const batcher = wrapKeypressHandler({
      onSingle: onKeypress,
      onPaste: finalizePaste,
    });
    stdin.on("keypress", batcher.handler);
    if (typeof stdin.resume === "function") {
      stdin.resume();
    }
    // 首次渲染
    rerender();
  });
}

