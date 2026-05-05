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
  defaultTypeaheadTheme,
  type RenderOptions,
} from "./tui/index.js";
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
    // 跳过 moveUp(1) 一次，让顶边直接覆盖当前空行；后续渲染光标都在 body 行，需
    // moveUp(1) 回顶边再重绘整帧
    let firstRender = true;

    // ── 绘图 ──
    const getColumns = (): number => {
      if (typeof options.columns === "number") return options.columns;
      return stdout.columns ?? 80;
    };

    const computeRenderOptions = (): RenderOptions => {
      const columns = getColumns();
      const frameWidth = Math.min(80, Math.max(40, Math.min(columns - 2, 80)));
      const innerWidth = Math.max(10, frameWidth - 2);
      return {
        theme: defaultTypeaheadTheme,
        frameWidth,
        innerWidth,
        maxVisibleItems,
      };
    };

    /**
     * 一帧 = box（顶 + body + 底，3 行）+ panel N 行。
     *
     * 入口/出口光标契约：
     *   非首次渲染入口 = 上次出口 = box body 行 cursor 列
     *   首次渲染入口 = caller 调用前的当前行 col 任意（视作 box 顶边的占位）
     *   每次出口 = box body 行 cursor 列
     *
     * 渲染流程（每帧自洽，与上次帧的 panel 行数无关——clearBelow 一次性清掉）：
     *   1. moveUp(1) 回 box 顶边行（首次跳过——光标本就在该行的位置）
     *   2. col0 + clearBelow 清光标右 + 下方所有内容（含旧 box 中下半 + 旧 panel）
     *   3. 写 box 三行（每行 + \r\n）—— 光标到底边之下
     *   4. 写 panel N 行（每行 + \r\n）—— 光标到 panel 之下
     *   5. moveUp(panelLines.length + 2) 回 box body 行 col 0
     *      （panel 行数 + 底边 1 行 + body 之下到 panel 顶 1 行 = N + 2，无 panel 时 = 2）
     *   6. forward(2 + promptPrefix宽 + draftBeforeCursor宽) 移到 cursor 列
     *      （2 = 左 │ 1 列 + indent 1 列；indent=1 是 input box 紧凑型决策）
     *
     * 整帧用 syncBegin / syncEnd 包裹，避免 TTY 分段 flush 让光标可见闪烁。
     *
     * clearBelow 的边界：moveUp(1) 后光标在 box 顶边行——clearBelow 只清这一行
     * 光标右侧 + 下方，不会越过 box 顶边往上擦欢迎语 / 历史输出。
     */
    const rerender = (): void => {
      stdout.write(ANSI.syncBegin);

      // Step 1：回 box 顶边行（首次渲染时光标已在该行的占位位置——caller 调用前的换行）
      if (!firstRender) {
        stdout.write(ANSI.moveUp(1));
      }
      firstRender = false;

      // Step 2：col0 + clearBelow 清整个 box + panel 残留
      stdout.write(ANSI.col0);
      stdout.write(ANSI.clearBelow);

      // 计算 body 内容（promptPrefix + draft + dim 提示）
      // dim 提示分两类，语义互斥：
      //   buffer 空 → placeholder（caller 注入的 0 状态文案）
      //   buffer 非空 + cursor 在末尾 + broker 有 ghost suffix → ghost text（命令补全建议）
      // buffer 空时 broker 自然无 trigger 也无 ghost，互斥自然成立；显式 if/else
      // 让阅读者一眼看清两者关系。光标不在末尾时 ghost 不显示——避免 mid-cursor 布局复杂化。
      const cursorAtEnd =
        buffer.cursor === Array.from(buffer.draft).length;
      let bodyContent = `${promptPrefix}${buffer.draft}`;
      if (buffer.isEmpty && options.placeholder) {
        bodyContent += `${ANSI.dim}${options.placeholder}${ANSI.reset}`;
      } else if (cursorAtEnd && lastSessionState?.ghostText?.suffix) {
        bodyContent += `${ANSI.dim}${lastSessionState.ghostText.suffix}${ANSI.reset}`;
      }

      // Step 3：渲染 box——复用 renderChrome 原语（紧凑形态：bodyPadding=false + indent=1）
      const boxLines = renderChrome({
        body: [bodyContent],
        width: getColumns(),
        bodyPadding: false,
        indent: 1,
      });
      for (const line of boxLines) {
        stdout.write(line);
        stdout.write("\r\n");
      }

      // Step 4：渲染 panel（紧贴 box 底边之下，作为第二个独立 chrome）
      const panelLines = lastSessionState
        ? renderSessionLines(lastSessionState, computeRenderOptions())
        : [];
      for (const line of panelLines) {
        stdout.write(line);
        stdout.write("\r\n");
      }

      // Step 5：回 box body 行 col 0
      // 此刻光标在所有内容之下 col 0；body 行是从底向上数的第 (panelLines.length + 2) 行
      // （panel N 行 + 底边 1 行 + body 之下空格 1 行 = N + 2；无 panel 时 = 2）
      stdout.write(ANSI.moveUp(panelLines.length + 2));

      // Step 6：从 col 0 forward 到 cursor 列
      // offset = 1（左 │）+ 1（indent=1）+ promptPrefix 可见宽 + draft 光标前部宽
      const draftBeforeCursor = Array.from(buffer.draft)
        .slice(0, buffer.cursor)
        .join("");
      const offset =
        2 + visibleLength(promptPrefix) + stringWidth(draftBeforeCursor);
      if (offset > 0) {
        stdout.write(`\x1b[${offset}C`);
      }

      stdout.write(ANSI.syncEnd);
    };

    /**
     * 销毁当前 box + panel 帧，把"刚提交的输入"降级为单行 `❯ <text>` 回显进入
     * scrollback——历史不累积 box 视觉重量（设计语言 P1 安静原则）。
     *
     * - `finalEcho=text`：Submit 路径 —— 清整帧 + 重写 `prompt + text` + `\r\n`
     * - `finalEcho=null`：Cancel 路径 —— 同样清整帧 + `\r\n`，不回显
     *
     * 入口光标契约与 rerender 出口一致：在 box body 行 cursor 位置（首次例外）。
     * moveUp(1) 回顶边行 + clearBelow 清整个 box + panel；首次渲染前调 teardown
     * 不会发生（teardown 只在 submit / cancel 路径触发，rerender 至少跑过一次）。
     */
    const teardownVisuals = (finalEcho: string | null): void => {
      if (!firstRender) {
        stdout.write(ANSI.moveUp(1));
      }
      stdout.write(ANSI.col0);
      stdout.write(ANSI.clearBelow);
      if (finalEcho !== null) {
        // 历史回显纯 bg 染色：bg 灰底已充分标识"用户消息"——不再带 ❯ prompt 字符
        // 避免与 active box 的"现在输入"语义重复（光标在历史里早不在了，❯ 是错位
        // 信号），也让用户复制历史消息时不带 prompt 前缀。前导 2 空格让文字不贴
        // bg 边缘视觉舒展；padding 到终端宽度让 bg 延伸到行末避免视觉锚断裂。
        const innerText = `  ${finalEcho}`;
        const visibleWidth = stringWidth(stripAnsi(innerText));
        const padding = " ".repeat(
          Math.max(0, getColumns() - visibleWidth),
        );
        stdout.write(tone.historyEcho(innerText + padding));
      }
      stdout.write("\r\n");
    };

    // ── 触发一次 broker updateInput ──
    const syncBroker = (): void => {
      options.broker.updateInput(
        sessionHandle.id,
        buffer.toTriggerContext(options.getRuntime()),
      );
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

      stdin.off("keypress", onKeypress);
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
      // 捕获"原始 draft"（未 trim）用于 teardown 时的回显 —— 视觉上让用户
      // 看到他真正按下 Enter 那一刻的 prompt 行内容。
      const rawDraft = buffer.draft;
      const text = rawDraft.trim();
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
        buffer.deleteForward();
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
        buffer.deleteBackward();
        syncBroker();
        return;
      }

      if (key.name === "left") {
        buffer.moveCursorLeft();
        rerender();
        return;
      }
      if (key.name === "right") {
        buffer.moveCursorRight();
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
    stdin.on("keypress", onKeypress);
    if (typeof stdin.resume === "function") {
      stdin.resume();
    }
    // 首次渲染
    rerender();
  });
}

/**
 * 估算字符串的可见长度（去掉 ANSI，不考虑 CJK 双宽）。
 * prompt prefix 里一般只有 "❯ " 和 ANSI 颜色码，这个粗算够用。
 */
function visibleLength(s: string): number {
  // 去掉 ANSI CSI 序列
  const stripped = s.replace(/\x1b\[[0-9;?=<>]*[A-Za-z]/g, "");
  return Array.from(stripped).length;
}
