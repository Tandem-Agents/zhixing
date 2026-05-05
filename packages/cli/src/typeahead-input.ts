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
import chalk from "chalk";

import {
  ANSI,
  stringWidth,
  renderSessionLines,
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

  /** prompt 前缀（chalk 色） */
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
  const promptPrefix = options.promptPrefix ?? chalk.green("❯ ");
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
     * 一帧 = prompt 行 + （可选）typeahead 面板行。
     *
     * 不变量（rerender 入口与出口都成立）：
     *   **光标停在 prompt 行的 `(buffer.cursor 对应的显示列)` 位置**。
     *
     * 渲染流程：
     *   1. `\r` 回到 prompt 行 col 0（不 moveUp —— 相信入口不变量）
     *   2. `\x1b[J` (clearBelow) 清 prompt 行光标右侧 + 下方所有面板行。
     *      **关键**：这个 clear 不往上走，所以永远不会擦 prompt 行之上的
     *      欢迎语 / 历史输出。
     *   3. 写 promptPrefix + draft
     *   4. 如果有面板：写 `\r\n` + 每行 + `\r\n`，然后 `moveUp(panelLines+1)`
     *      + `col0` 回到 prompt 行列 0
     *   5. 按 `draft[0:cursor]` 的**显示宽度**（CJK=2）右移到 cursor 列
     *
     * 绝不使用 `PanelRenderer.clear()/render()` —— 那套 API 的光标契约是
     * `(startRow + lastHeight, col 0)`，而我们这里的入口契约是 "prompt 行
     * 的 cursor 位置"，两者不兼容；在 clear 路径上 moveUp 会从 prompt 行
     * 往上走 N 行把欢迎语一并擦掉（曾经的真实 bug）。
     */
    const rerender = (): void => {
      // 整个 frame 包裹同步输出 ANSI——避免 TTY sync write 分段 flush 让 cursor 在
      // step 5 的 `\r` 与 `\x1b[{offset}C` 之间短暂出现在 col 0 闪烁
      stdout.write(ANSI.syncBegin);

      // Step 1-2：回 prompt 行 col 0 并清 prompt 行 + 下方
      stdout.write(ANSI.col0);
      stdout.write(ANSI.clearBelow);

      // Step 3：prompt 行内容
      stdout.write(promptPrefix);
      stdout.write(buffer.draft);

      // Step 3.5：dim 提示渲染——placeholder 与 ghost text 共用此通道但语义互斥。
      //   buffer 空 → placeholder（caller 注入的 0 状态文案，如 "输入消息或 / 查看命令"）
      //   buffer 非空 + cursor 在末尾 + broker 有 ghost suffix → ghost text（命令补全建议）
      // 互斥自然成立：buffer 空时 broker 无 trigger 自然无 ghost；显式 if/else 分支
      // 让阅读者一眼看清两者关系。光标不在末尾时 ghost 不显示（避免 mid-cursor 布局复杂化）。
      const cursorAtEnd =
        buffer.cursor === Array.from(buffer.draft).length;
      if (buffer.isEmpty && options.placeholder) {
        stdout.write(
          `${ANSI.dim}${options.placeholder}${ANSI.reset}`,
        );
      } else if (cursorAtEnd && lastSessionState?.ghostText?.suffix) {
        stdout.write(
          `${ANSI.dim}${lastSessionState.ghostText.suffix}${ANSI.reset}`,
        );
      }

      // Step 4：计算面板行
      const panelLines = lastSessionState
        ? renderSessionLines(lastSessionState, computeRenderOptions())
        : [];

      if (panelLines.length > 0) {
        stdout.write("\r\n");
        for (const line of panelLines) {
          stdout.write(line);
          stdout.write("\r\n");
        }
        // 此刻光标在 (promptRow + 1 + panelLines.length, col 0)
        // 上移 panelLines.length + 1 行回到 prompt 行 col 0
        stdout.write(ANSI.moveUp(panelLines.length + 1));
      }

      // Step 5：无条件 `\r` 回 prompt 行 col 0，再按 cursor 对应的**显示列**
      // 右移。`\x1b[{N}C` 是相对位移（cursor forward），必须从 col 0 起算
      // 否则 no-panel 分支里光标停在 draft 末尾再向右 N 列会多偏 N 列。
      //
      // 前车之鉴：初版 no-panel 分支漏掉这个 `\r`，真实 TTY 里打 `@ss`（`@`
      // 无 provider）光标和 draft 末尾之间出现 5 列空隙。
      stdout.write(ANSI.col0);
      const draftBeforeCursor = Array.from(buffer.draft)
        .slice(0, buffer.cursor)
        .join("");
      const offset =
        visibleLength(promptPrefix) + stringWidth(draftBeforeCursor);
      if (offset > 0) {
        stdout.write(`\x1b[${offset}C`);
      }

      // 整帧渲染完一次性提交给终端 render
      stdout.write(ANSI.syncEnd);
    };

    /**
     * 销毁当前帧并在原 prompt 行留下最终回显（或只留空行）。
     *
     * - `finalEcho=text`：Submit 路径 —— 清整帧 + 重写 `prompt + text` + `\r\n`，
     *   让"刚提交的那一行"进入 scrollback 历史，下一行空出来给后续输出。
     * - `finalEcho=null`：Cancel 路径 —— 同样清整帧 + `\r\n`，不回显。
     */
    const teardownVisuals = (finalEcho: string | null): void => {
      stdout.write(ANSI.col0);
      stdout.write(ANSI.clearBelow);
      if (finalEcho !== null) {
        stdout.write(promptPrefix);
        stdout.write(finalEcho);
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
