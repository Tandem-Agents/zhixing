import { wrapKeypressHandler } from "../../paste-detector.js";
import { ANSI } from "../ansi.js";
import { clampLine } from "../line-width.js";
import {
  rawModeController,
  type RawModeLease,
} from "../_internal/raw-mode.js";
import {
  acquireStdinOwnership,
  type StdinOwnershipHandle,
} from "../_internal/stdin-ownership.js";
import type { SelectionPresenter } from "./presenter.js";
import type { SelectionAction } from "./state.js";
import {
  makeInitialSelectionState,
  reduceSelection,
} from "./state.js";
import {
  computeDetailsBodyRows,
  renderSelectionPanel,
  type SelectionRenderOptions,
} from "./render.js";
import { translateSelectionKeypress } from "./keymap.js";
import type {
  SelectionResult,
  SelectionRunOptions,
  ValidatedSelectionRequest,
} from "./types.js";
import { SelectionUnavailableError } from "./types.js";

export interface LegacySelectionPresenterOptions {
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly columns?: number;
  readonly viewportRows?: number;
}

export class LegacySelectionPresenter implements SelectionPresenter {
  private readonly stdin: NodeJS.ReadStream;
  private readonly stdout: NodeJS.WriteStream;
  private readonly columns?: number;
  private readonly viewportRows?: number;

  constructor(options: LegacySelectionPresenterOptions = {}) {
    this.stdin = options.stdin ?? process.stdin;
    this.stdout = options.stdout ?? process.stdout;
    this.columns = options.columns;
    this.viewportRows = options.viewportRows;
  }

  run<TValue extends string>(
    request: ValidatedSelectionRequest<TValue>,
    options: SelectionRunOptions = {},
  ): Promise<SelectionResult<TValue>> {
    if (options.signal?.aborted) {
      return Promise.resolve({ kind: "cancelled", cause: "aborted" });
    }

    return new Promise<SelectionResult<TValue>>((resolve, reject) => {
      let state = makeInitialSelectionState(request);
      let finished = false;
      let rawModeLease: RawModeLease | null = null;
      let stdinOwnership: StdinOwnershipHandle | null = null;
      let batcher: ReturnType<typeof wrapKeypressHandler> | null = null;
      let cursorRowsToEnd = 0;
      let presented = false;
      const renderOptions = (): SelectionRenderOptions => ({
        columns: this.columns ?? this.stdout.columns ?? 80,
        viewportRows: this.viewportRows ?? this.stdout.rows ?? 24,
        statusRows: 0,
        minScrollRows: 1,
      });

      const cleanup = (): unknown => {
        this.stdout.off("resize", onResize);
        let restoreError: unknown;
        if (cursorRowsToEnd > 0) {
          try {
            this.stdout.write(`${ANSI.moveDown(cursorRowsToEnd)}\r`);
          } catch (err) {
            restoreError = err;
          }
          cursorRowsToEnd = 0;
        }
        options.signal?.removeEventListener("abort", onAbort);
        if (batcher) {
          this.stdin.off("keypress", batcher.handler);
          batcher.release();
          batcher = null;
        }
        rawModeLease?.release();
        rawModeLease = null;
        stdinOwnership?.release();
        stdinOwnership = null;
        return restoreError;
      };

      const finish = (result: SelectionResult<TValue>): void => {
        if (finished) return;
        finished = true;
        const cleanupError = cleanup();
        if (cleanupError !== undefined) reject(cleanupError);
        else resolve(result);
      };

      const fail = (err: unknown): void => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(err);
      };

      const repaint = (): void => {
        const rendered = renderSelectionPanel(request, state, renderOptions());
        if (rendered.kind === "unavailable") {
          if (!presented) throw new SelectionUnavailableError(rendered.reason);
          const hint = clampLine("窗口过小，请放大后继续；Esc 取消", renderOptions().columns - 1);
          this.stdout.write(`${ANSI.moveDown(cursorRowsToEnd)}\r${hint}\r\n`);
          cursorRowsToEnd = 0;
          return;
        }
        presented = true;
        // 上一帧可能把光标留在编辑行；先回到面板之后再输出，结束亦恢复此位置。
        let bytes = `${ANSI.moveDown(cursorRowsToEnd)}\r${rendered.lines.join("\r\n")}\r\n`;
        cursorRowsToEnd = 0;
        if (rendered.cursor) {
          cursorRowsToEnd = rendered.lines.length - rendered.cursor.row;
          bytes += `${ANSI.moveUp(cursorRowsToEnd)}\x1b[${rendered.cursor.col + 1}G`;
        }
        this.stdout.write(bytes);
      };

      const applyAction = (action: SelectionAction): void => {
        try {
          const currentOptions = renderOptions();
          if (renderSelectionPanel(request, state, currentOptions).kind === "unavailable") {
            if (action.kind === "escape") finish({ kind: "cancelled", cause: "escape" });
            return;
          }
          const reduced = reduceSelection(state, action, request, {
            detailBodyRows: computeDetailsBodyRows(currentOptions),
          });
          if (reduced.result) {
            finish(reduced.result);
            return;
          }
          if (reduced.state !== state) {
            state = reduced.state;
            repaint();
          }
        } catch (err) {
          fail(err);
        }
      };

      const onAbort = (): void => {
        finish({ kind: "cancelled", cause: "aborted" });
      };
      const onResize = (): void => {
        if (finished) return;
        try { repaint(); } catch (err) { fail(err); }
      };

      try {
        repaint();
        this.stdout.on("resize", onResize);
        options.signal?.addEventListener("abort", onAbort, { once: true });
        stdinOwnership = acquireStdinOwnership(this.stdin);
        rawModeLease = rawModeController.acquire(this.stdin);
        batcher = wrapKeypressHandler({
          onSingle: (str, key) => {
            try {
              if (key?.ctrl && key.name === "c") {
                finish({ kind: "cancelled", cause: "ctrl-c" });
                return;
              }
              if (key?.ctrl && key.name === "d") {
                finish({ kind: "cancelled", cause: "ctrl-d" });
                return;
              }
              const action = translateSelectionKeypress(str, key, state);
              if (action) applyAction(action);
            } catch (err) {
              fail(err);
            }
          },
          onPaste: (content) => {
            try {
              if (state.layer !== "input") return;
              for (const ch of content) {
                if (ch === "\r" || ch === "\n") continue;
                applyAction({ kind: "char", ch });
                if (finished || state.layer !== "input") return;
              }
            } catch (err) {
              fail(err);
            }
          },
        });
        this.stdin.on("keypress", batcher.handler);
        if (typeof this.stdin.resume === "function") {
          this.stdin.resume();
        }
      } catch (err) {
        fail(err);
      }
    });
  }
}
