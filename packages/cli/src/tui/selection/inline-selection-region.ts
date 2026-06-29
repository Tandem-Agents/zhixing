import type * as readline from "node:readline";

import type {
  InputRegion,
  ScreenController,
} from "../../screen/index.js";
import { wrapKeypressHandler } from "../../paste-detector.js";
import {
  rawModeController,
  type RawModeLease,
} from "../_internal/raw-mode.js";
import {
  acquireStdinOwnership,
  type StdinOwnershipHandle,
} from "../_internal/stdin-ownership.js";
import type {
  SelectionAction,
  SelectionState,
} from "./state.js";
import {
  makeInitialSelectionState,
  reduceSelection,
} from "./state.js";
import {
  computeDetailsBodyRows,
  computeMaxPanelRows,
  renderSelectionPanel,
  type SelectionRenderOptions,
} from "./render.js";
import { translateSelectionKeypress } from "./keymap.js";
import type {
  SelectionResult,
  ValidatedSelectionRequest,
} from "./types.js";
import { SelectionUnavailableError } from "./types.js";

export interface InlineSelectionRegionOptions<TValue extends string = string> {
  readonly request: ValidatedSelectionRequest<TValue>;
  readonly screen: ScreenController;
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly signal?: AbortSignal;
  readonly statusRows?: number | (() => number);
  readonly minScrollRows?: number;
  readonly columns?: number;
  readonly viewportRows?: number;
}

export class InlineSelectionRegion<TValue extends string = string>
  implements InputRegion
{
  private state: SelectionState;
  private cachedLines: readonly string[] = [];
  private finished = false;
  private resolveResult: ((result: SelectionResult<TValue>) => void) | null = null;
  private rawModeLease: RawModeLease | null = null;
  private stdinOwnership: StdinOwnershipHandle | null = null;
  private batcher: ReturnType<typeof wrapKeypressHandler> | null = null;

  private readonly request: ValidatedSelectionRequest<TValue>;
  private readonly screen: ScreenController;
  private readonly stdin: NodeJS.ReadStream;
  private readonly stdout: NodeJS.WriteStream;
  private readonly options: InlineSelectionRegionOptions<TValue>;
  private readonly renderOptionsSnapshot: SelectionRenderOptions;

  constructor(options: InlineSelectionRegionOptions<TValue>) {
    this.options = options;
    this.request = options.request;
    this.screen = options.screen;
    this.stdin = options.stdin ?? process.stdin;
    this.stdout = options.stdout ?? process.stdout;
    this.renderOptionsSnapshot = {
      columns: options.columns ?? this.stdout.columns ?? 80,
      viewportRows: options.viewportRows ?? this.stdout.rows ?? 24,
      statusRows: resolveRows(options.statusRows),
      minScrollRows: options.minScrollRows,
    };
    this.state = makeInitialSelectionState(options.request);
    this.computeLines();
  }

  run(): Promise<SelectionResult<TValue>> {
    return new Promise<SelectionResult<TValue>>((resolve) => {
      this.resolveResult = resolve;
      if (this.options.signal?.aborted) {
        this.finish({ kind: "cancelled", cause: "aborted" });
        return;
      }
      this.options.signal?.addEventListener("abort", this.onAbort, { once: true });

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

  renderLines(): readonly string[] {
    return this.cachedLines;
  }

  cursorPosition(): { row: number; col: number } {
    return { row: 0, col: 0 };
  }

  private handleKeypress(str: string, key: readline.Key | undefined): void {
    if (this.finished) return;
    if (key?.ctrl && key.name === "c") {
      this.finish({ kind: "cancelled", cause: "ctrl-c" });
      return;
    }
    if (key?.ctrl && key.name === "d") {
      this.finish({ kind: "cancelled", cause: "ctrl-d" });
      return;
    }

    const action = translateSelectionKeypress(str, key, this.state);
    if (!action) return;
    this.applyAction(action);
  }

  private handlePaste(content: string): void {
    if (this.finished || this.state.layer !== "input") return;
    for (const ch of content) {
      if (ch === "\r" || ch === "\n") continue;
      this.applyAction({ kind: "char", ch });
      if (this.finished || this.state.layer !== "input") return;
    }
  }

  private applyAction(action: SelectionAction): void {
    const { state, result } = reduceSelection(
      this.state,
      action,
      this.request,
      { detailBodyRows: computeDetailsBodyRows(this.renderOptions()) },
    );
    if (result) {
      this.finish(result);
      return;
    }
    if (state !== this.state) {
      this.state = state;
      this.computeLines();
      this.screen.requestInputRepaint();
    }
  }

  private computeLines(): void {
    const result = renderSelectionPanel(
      this.request,
      this.state,
      this.renderOptions(),
    );
    if (result.kind === "unavailable") {
      throw new SelectionUnavailableError(result.reason);
    }
    this.cachedLines = result.lines;
  }

  private renderOptions(): SelectionRenderOptions {
    return this.renderOptionsSnapshot;
  }

  private onAbort = (): void => {
    this.finish({ kind: "cancelled", cause: "aborted" });
  };

  private finish(result: SelectionResult<TValue>): void {
    if (this.finished) return;
    this.finished = true;

    if (this.batcher) {
      this.stdin.off("keypress", this.batcher.handler);
      this.batcher.release();
      this.batcher = null;
    }
    this.options.signal?.removeEventListener("abort", this.onAbort);
    this.rawModeLease?.release();
    this.rawModeLease = null;
    this.stdinOwnership?.release();
    this.stdinOwnership = null;
    this.cachedLines = [];
    this.screen.requestInputRepaint();

    const resolve = this.resolveResult;
    this.resolveResult = null;
    resolve?.(result);
  }
}

export function assertInlineSelectionAvailable(
  options: SelectionRenderOptions,
): void {
  if (computeMaxPanelRows(options) <= 0) {
    throw new SelectionUnavailableError("terminal is too short");
  }
}

function resolveRows(rows: number | (() => number) | undefined): number {
  if (typeof rows === "function") return rows();
  return rows ?? 0;
}
