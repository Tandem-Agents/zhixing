import type {
  SelectionOption,
  SelectionResult,
  ValidatedSelectionRequest,
} from "./types.js";
import {
  getSelectionDetails,
  isConfirmOption,
  isInputOption,
  normalizeHotkey,
} from "./types.js";

export type SelectionLayer = "select" | "input" | "confirm" | "details";

export interface SelectionState {
  readonly selectedIndex: number;
  readonly layer: SelectionLayer;
  readonly inputBuffer: string;
  readonly detailScrollOffset: number;
}

export type SelectionAction =
  | { readonly kind: "up" }
  | { readonly kind: "down" }
  | { readonly kind: "enter" }
  | { readonly kind: "escape" }
  | { readonly kind: "left" }
  | { readonly kind: "backspace" }
  | { readonly kind: "char"; readonly ch: string }
  | { readonly kind: "hotkey"; readonly key: string }
  | { readonly kind: "details" };

export interface SelectionReduceResult<TValue extends string = string> {
  readonly state: SelectionState;
  readonly result?: SelectionResult<TValue>;
}

export interface SelectionReduceOptions {
  readonly detailBodyRows?: number;
}

export function makeInitialSelectionState(
  request: ValidatedSelectionRequest,
): SelectionState {
  return {
    selectedIndex: request.initialIndex,
    layer: "select",
    inputBuffer: "",
    detailScrollOffset: 0,
  };
}

export function reduceSelection<TValue extends string>(
  state: SelectionState,
  action: SelectionAction,
  request: ValidatedSelectionRequest<TValue>,
  options: SelectionReduceOptions = {},
): SelectionReduceResult<TValue> {
  switch (state.layer) {
    case "select":
      return reduceSelectLayer(state, action, request);
    case "input":
      return reduceInputLayer(state, action, request);
    case "confirm":
      return reduceConfirmLayer(state, action, request);
    case "details":
      return reduceDetailsLayer(state, action, request, options);
  }
}

function reduceSelectLayer<TValue extends string>(
  state: SelectionState,
  action: SelectionAction,
  request: ValidatedSelectionRequest<TValue>,
): SelectionReduceResult<TValue> {
  switch (action.kind) {
    case "up":
      return {
        state: {
          ...state,
          selectedIndex: previousEnabledIndex(request.options, state.selectedIndex),
          detailScrollOffset: 0,
        },
      };
    case "down":
      return {
        state: {
          ...state,
          selectedIndex: nextEnabledIndex(request.options, state.selectedIndex),
          detailScrollOffset: 0,
        },
      };
    case "enter":
      return activateCurrentOption(state, request);
    case "escape":
      return { state, result: { kind: "cancelled", cause: "escape" } };
    case "details":
      if (!getSelectionDetails(request, state.selectedIndex)) return { state };
      return {
        state: {
          ...state,
          layer: "details",
          inputBuffer: "",
          detailScrollOffset: 0,
        },
      };
    case "hotkey": {
      const matchIndex = request.options.findIndex(
        (option) =>
          !option.disabled &&
          option.hotkey !== undefined &&
          normalizeHotkey(option.hotkey) === normalizeHotkey(action.key),
      );
      if (matchIndex === -1) return { state };
      return activateCurrentOption(
        { ...state, selectedIndex: matchIndex },
        request,
      );
    }
    case "backspace":
    case "char":
    case "left":
      return { state };
  }
}

function reduceInputLayer<TValue extends string>(
  state: SelectionState,
  action: SelectionAction,
  request: ValidatedSelectionRequest<TValue>,
): SelectionReduceResult<TValue> {
  const current = request.options[state.selectedIndex];
  if (!current || !isInputOption(current)) {
    return { state: { ...state, layer: "select", inputBuffer: "" } };
  }

  switch (action.kind) {
    case "enter":
      if (state.inputBuffer.length === 0 && current.input.allowEmpty !== true) {
        return { state };
      }
      return {
        state,
        result: {
          kind: "selected",
          value: current.value,
          input: state.inputBuffer,
        },
      };
    case "escape":
      return { state: { ...state, layer: "select", inputBuffer: "" } };
    case "backspace": {
      if (state.inputBuffer.length === 0) return { state };
      const chars = Array.from(state.inputBuffer);
      chars.pop();
      return {
        state: {
          ...state,
          inputBuffer: chars.join(""),
        },
      };
    }
    case "char":
      return {
        state: {
          ...state,
          inputBuffer: state.inputBuffer + action.ch,
        },
      };
    case "up":
    case "down":
    case "hotkey":
    case "details":
    case "left":
      return { state };
  }
}

function reduceConfirmLayer<TValue extends string>(
  state: SelectionState,
  action: SelectionAction,
  request: ValidatedSelectionRequest<TValue>,
): SelectionReduceResult<TValue> {
  const current = request.options[state.selectedIndex];
  if (!current || !isConfirmOption(current)) {
    return { state: { ...state, layer: "select", inputBuffer: "" } };
  }

  switch (action.kind) {
    case "enter":
      return {
        state,
        result: { kind: "selected", value: current.value },
      };
    case "escape":
      return {
        state: {
          ...state,
          layer: "select",
          inputBuffer: "",
          detailScrollOffset: 0,
        },
      };
    case "up":
    case "down":
    case "backspace":
    case "char":
    case "hotkey":
    case "details":
    case "left":
      return { state };
  }
}

function reduceDetailsLayer<TValue extends string>(
  state: SelectionState,
  action: SelectionAction,
  request: ValidatedSelectionRequest<TValue>,
  options: SelectionReduceOptions,
): SelectionReduceResult<TValue> {
  const details = getSelectionDetails(request, state.selectedIndex);
  if (!details) {
    return {
      state: {
        ...state,
        layer: "select",
        detailScrollOffset: 0,
      },
    };
  }
  const detailBodyRows = normalizePositiveInteger(options.detailBodyRows ?? 1);
  const maxOffset = Math.max(0, details.body.length - detailBodyRows);
  switch (action.kind) {
    case "up":
      return {
        state: {
          ...state,
          detailScrollOffset: Math.max(0, state.detailScrollOffset - 1),
        },
      };
    case "down":
      return {
        state: {
          ...state,
          detailScrollOffset: Math.min(maxOffset, state.detailScrollOffset + 1),
        },
      };
    case "enter":
    case "escape":
    case "left":
      return {
        state: {
          ...state,
          layer: "select",
          inputBuffer: "",
          detailScrollOffset: 0,
        },
      };
    case "backspace":
    case "char":
    case "hotkey":
    case "details":
      return { state };
  }
}

function normalizePositiveInteger(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

function activateCurrentOption<TValue extends string>(
  state: SelectionState,
  request: ValidatedSelectionRequest<TValue>,
): SelectionReduceResult<TValue> {
  const current = request.options[state.selectedIndex];
  if (!current || current.disabled) return { state };
  if (isInputOption(current)) {
    return {
      state: {
        ...state,
        layer: "input",
        inputBuffer: "",
        detailScrollOffset: 0,
      },
    };
  }
  if (isConfirmOption(current)) {
    return {
      state: {
        ...state,
        layer: "confirm",
        inputBuffer: "",
        detailScrollOffset: 0,
      },
    };
  }
  return {
    state,
    result: { kind: "selected", value: current.value },
  };
}

function previousEnabledIndex(
  options: readonly SelectionOption[],
  selectedIndex: number,
): number {
  for (let i = selectedIndex - 1; i >= 0; i--) {
    if (!options[i]!.disabled) return i;
  }
  return selectedIndex;
}

function nextEnabledIndex(
  options: readonly SelectionOption[],
  selectedIndex: number,
): number {
  for (let i = selectedIndex + 1; i < options.length; i++) {
    if (!options[i]!.disabled) return i;
  }
  return selectedIndex;
}
