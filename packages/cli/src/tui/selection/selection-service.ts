import type { ScreenController } from "../../screen/index.js";
import type { SelectionPresenter } from "./presenter.js";
import { InlineSelectionRegion } from "./inline-selection-region.js";
import { LegacySelectionPresenter } from "./legacy-selection-presenter.js";
import type {
  SelectionRequest,
  SelectionResult,
  SelectionRunOptions,
} from "./types.js";
import {
  SelectionBusyError,
  SelectionUnavailableError,
  validateSelectionRequest,
} from "./types.js";

export interface SelectionService {
  choose<TValue extends string>(
    request: SelectionRequest<TValue>,
    options?: SelectionRunOptions,
  ): Promise<SelectionResult<TValue>>;
}

export interface SelectionServiceOptions {
  readonly screen?: ScreenController;
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly beforeShow?: () => void | Promise<void>;
  readonly afterShow?: () => void | Promise<void>;
  readonly isInteractive?: () => boolean;
  readonly statusRows?: number | (() => number);
  readonly minScrollRows?: number;
  readonly columns?: number;
  readonly viewportRows?: number;
}

export function createSelectionService(
  options: SelectionServiceOptions = {},
): SelectionService {
  return new DefaultSelectionService(options);
}

class DefaultSelectionService implements SelectionService {
  private active = false;

  constructor(private readonly options: SelectionServiceOptions) {}

  async choose<TValue extends string>(
    request: SelectionRequest<TValue>,
    runOptions: SelectionRunOptions = {},
  ): Promise<SelectionResult<TValue>> {
    const validated = validateSelectionRequest(request);
    if (this.active) {
      throw new SelectionBusyError();
    }
    if (!this.isInteractive()) {
      throw new SelectionUnavailableError("selection requires interactive input");
    }

    this.active = true;
    try {
      const presenter = this.createPresenter();
      return await presenter.run(validated, runOptions);
    } finally {
      this.active = false;
    }
  }

  private createPresenter(): SelectionPresenter {
    if (this.options.screen) {
      return {
        run: async (request, runOptions = {}) => {
          if (runOptions.signal?.aborted) {
            return { kind: "cancelled", cause: "aborted" };
          }
          const region = new InlineSelectionRegion({
            request,
            screen: this.options.screen!,
            stdin: this.options.stdin,
            stdout: this.options.stdout,
            signal: runOptions.signal,
            statusRows: this.options.statusRows,
            minScrollRows: this.options.minScrollRows,
            columns: this.options.columns,
            viewportRows: this.options.viewportRows,
          });

          if (this.options.beforeShow) {
            await this.options.beforeShow();
          }
          try {
            return await region.run();
          } finally {
            if (this.options.afterShow) {
              await this.options.afterShow();
            }
          }
        },
      };
    }
    return new LegacySelectionPresenter({
      stdin: this.options.stdin,
      stdout: this.options.stdout,
      columns: this.options.columns,
      viewportRows: this.options.viewportRows,
    });
  }

  private isInteractive(): boolean {
    if (this.options.isInteractive) return this.options.isInteractive();
    const stdin = this.options.stdin ?? process.stdin;
    const stdout = this.options.stdout ?? process.stdout;
    return Boolean(stdin.isTTY && stdout.isTTY);
  }
}
