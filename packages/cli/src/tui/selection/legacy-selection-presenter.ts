import type * as readline from "node:readline";

import { wrapKeypressHandler } from "../../paste-detector.js";
import {
  rawModeController,
  type RawModeLease,
} from "../_internal/raw-mode.js";
import {
  acquireStdinOwnership,
  type StdinOwnershipHandle,
} from "../_internal/stdin-ownership.js";
import type { SelectionPresenter } from "./presenter.js";
import type {
  SelectionAction,
  SelectionState,
} from "./state.js";
import {
  makeInitialSelectionState,
  reduceSelection,
} from "./state.js";
import { renderSelectionPanel } from "./render.js";
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
      const renderOptions = {
        columns: this.columns ?? this.stdout.columns ?? 80,
        viewportRows: this.viewportRows ?? this.stdout.rows ?? 24,
        statusRows: 0,
        minScrollRows: 1,
      };

      const cleanup = (): void => {
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
      };

      const finish = (result: SelectionResult<TValue>): void => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve(result);
      };

      const fail = (err: unknown): void => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(err);
      };

      const repaint = (): void => {
        const rendered = renderSelectionPanel(request, state, renderOptions);
        if (rendered.kind === "unavailable") {
          throw new SelectionUnavailableError(rendered.reason);
        }
        this.stdout.write(`${rendered.lines.join("\n")}\n`);
      };

      const applyAction = (action: SelectionAction): void => {
        try {
          const reduced = reduceSelection(state, action, request);
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

      try {
        repaint();
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
              const action = translateKeypress(str, key, state);
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

function translateKeypress(
  str: string,
  key: readline.Key | undefined,
  state: SelectionState,
): SelectionAction | null {
  if (state.layer === "input") {
    if (key?.name === "return") return { kind: "enter" };
    if (key?.name === "escape") return { kind: "escape" };
    if (key?.name === "backspace") return { kind: "backspace" };
    if (str && !key?.ctrl && !key?.meta && str !== "\r" && str !== "\n") {
      return { kind: "char", ch: str };
    }
    return null;
  }
  if (key?.name === "up") return { kind: "up" };
  if (key?.name === "down") return { kind: "down" };
  if (key?.name === "return") return { kind: "enter" };
  if (key?.name === "escape") return { kind: "escape" };
  if (str && !key?.ctrl && !key?.meta && !str.startsWith("\x1b")) {
    return { kind: "hotkey", key: str };
  }
  return null;
}
