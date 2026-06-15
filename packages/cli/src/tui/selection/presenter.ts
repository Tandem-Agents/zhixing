import type {
  SelectionResult,
  SelectionRunOptions,
  ValidatedSelectionRequest,
} from "./types.js";

export interface SelectionPresenter {
  run<TValue extends string>(
    request: ValidatedSelectionRequest<TValue>,
    options?: SelectionRunOptions,
  ): Promise<SelectionResult<TValue>>;
}
