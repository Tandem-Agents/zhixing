export const MAX_SELECTION_OPTIONS = 5;

export type SelectionCancelCause = "escape" | "ctrl-c" | "ctrl-d" | "aborted";

export type SelectionHotkey = string;

export interface SelectionRequest<TValue extends string = string> {
  readonly id?: string;
  readonly title: string;
  readonly body?: readonly string[];
  readonly details?: SelectionDetailsSpec;
  readonly options: readonly SelectionOption<TValue>[];
  readonly initialValue?: TValue;
  readonly submitLabel?: string;
  readonly cancelLabel?: string;
}

export type SelectionOption<TValue extends string = string> =
  | SelectionPlainOption<TValue>
  | SelectionInputOption<TValue>
  | SelectionConfirmOption<TValue>;

export interface SelectionBaseOption<TValue extends string = string> {
  readonly value: TValue;
  readonly label: string;
  readonly description?: string;
  readonly details?: SelectionDetailsSpec;
  readonly hotkey?: SelectionHotkey;
  readonly tone?: "normal" | "primary" | "danger" | "muted";
  readonly disabled?: boolean;
}

export interface SelectionPlainOption<TValue extends string = string>
  extends SelectionBaseOption<TValue> {
  readonly input?: undefined;
  readonly confirm?: undefined;
}

export interface SelectionInputOption<TValue extends string = string>
  extends SelectionBaseOption<TValue> {
  readonly input: SelectionInputSpec;
  readonly confirm?: undefined;
}

export interface SelectionConfirmOption<TValue extends string = string>
  extends SelectionBaseOption<TValue> {
  readonly input?: undefined;
  readonly confirm: SelectionConfirmSpec;
}

export interface SelectionInputSpec {
  readonly placeholder: string;
  readonly allowEmpty?: boolean;
}

export interface SelectionConfirmSpec {
  readonly title: string;
  readonly body?: readonly string[];
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
}

export interface SelectionDetailsSpec {
  readonly title?: string;
  readonly body: readonly string[];
}

export type SelectionResult<TValue extends string = string> =
  | SelectionSelectedResult<TValue>
  | { readonly kind: "cancelled"; readonly cause: SelectionCancelCause };

export type SelectionSelectedResult<TValue extends string = string> =
  | { readonly kind: "selected"; readonly value: TValue }
  | { readonly kind: "selected"; readonly value: TValue; readonly input: string };

export interface SelectionRunOptions {
  readonly signal?: AbortSignal;
}

export interface ValidatedSelectionRequest<TValue extends string = string>
  extends SelectionRequest<TValue> {
  readonly options: readonly SelectionOption<TValue>[];
  readonly initialIndex: number;
}

export class SelectionBusyError extends Error {
  override readonly name = "SelectionBusyError";

  constructor(message = "selection is already active") {
    super(message);
  }
}

export class SelectionValidationError extends Error {
  override readonly name = "SelectionValidationError";

  constructor(message: string) {
    super(message);
  }
}

export class SelectionUnavailableError extends Error {
  override readonly name = "SelectionUnavailableError";

  constructor(message: string) {
    super(message);
  }
}

export function normalizeHotkey(hotkey: string): string {
  return hotkey.toLowerCase();
}

export function isInputOption<TValue extends string>(
  option: SelectionOption<TValue>,
): option is SelectionInputOption<TValue> {
  return "input" in option && option.input !== undefined;
}

export function isConfirmOption<TValue extends string>(
  option: SelectionOption<TValue>,
): option is SelectionConfirmOption<TValue> {
  return "confirm" in option && option.confirm !== undefined;
}

export function getSelectionDetails<TValue extends string>(
  request: ValidatedSelectionRequest<TValue>,
  selectedIndex: number,
): SelectionDetailsSpec | undefined {
  const optionDetails = request.options[selectedIndex]?.details;
  return optionDetails ?? request.details;
}

export function validateSelectionRequest<TValue extends string>(
  request: SelectionRequest<TValue>,
): ValidatedSelectionRequest<TValue> {
  const title = request.title.trim();
  if (title.length === 0) {
    throw new SelectionValidationError("selection title is empty");
  }

  if (request.options.length === 0) {
    throw new SelectionValidationError("selection options are empty");
  }
  if (request.options.length > MAX_SELECTION_OPTIONS) {
    throw new SelectionValidationError(
      `selection options exceed ${MAX_SELECTION_OPTIONS}`,
    );
  }

  const values = new Set<string>();
  const hotkeys = new Set<string>();
  let firstEnabled = -1;

  validateDetails(request.details, "selection details");

  request.options.forEach((option, index) => {
    if (option.label.trim().length === 0) {
      throw new SelectionValidationError(`selection option ${index} label is empty`);
    }
    if (values.has(option.value)) {
      throw new SelectionValidationError(
        `selection option value is duplicated: ${option.value}`,
      );
    }
    values.add(option.value);

    if (!option.disabled && firstEnabled === -1) {
      firstEnabled = index;
    }
    validateDetails(option.details, `selection option details: ${option.value}`);

    if (option.disabled && (isInputOption(option) || isConfirmOption(option))) {
      throw new SelectionValidationError(
        `disabled option cannot declare input or confirm: ${option.value}`,
      );
    }

    if (isInputOption(option) && option.input.placeholder.trim().length === 0) {
      throw new SelectionValidationError(
        `selection option input placeholder is empty: ${option.value}`,
      );
    }

    if (isConfirmOption(option) && option.confirm.title.trim().length === 0) {
      throw new SelectionValidationError(
        `selection option confirm title is empty: ${option.value}`,
      );
    }

    if (option.hotkey !== undefined) {
      if (option.disabled) {
        throw new SelectionValidationError(
          `disabled option cannot declare hotkey: ${option.value}`,
        );
      }
      if (!isValidHotkey(option.hotkey)) {
        throw new SelectionValidationError(
          `selection option hotkey must be one printable non-whitespace ASCII character: ${option.value}`,
        );
      }
      const normalized = normalizeHotkey(option.hotkey);
      if (hotkeys.has(normalized)) {
        throw new SelectionValidationError(
          `selection option hotkey is duplicated: ${option.hotkey}`,
        );
      }
      hotkeys.add(normalized);
    }
  });

  if (firstEnabled === -1) {
    throw new SelectionValidationError("selection options are all disabled");
  }

  let initialIndex = firstEnabled;
  if (request.initialValue !== undefined) {
    const found = request.options.findIndex(
      (option) => option.value === request.initialValue,
    );
    if (found === -1) {
      throw new SelectionValidationError(
        `selection initialValue does not exist: ${request.initialValue}`,
      );
    }
    if (request.options[found]!.disabled) {
      throw new SelectionValidationError(
        `selection initialValue points to disabled option: ${request.initialValue}`,
      );
    }
    initialIndex = found;
  }

  return {
    ...request,
    title,
    initialIndex,
  };
}

function validateDetails(
  details: SelectionDetailsSpec | undefined,
  label: string,
): void {
  if (!details) return;
  if (details.title !== undefined && details.title.trim().length === 0) {
    throw new SelectionValidationError(`${label} title is empty`);
  }
  if (details.body.length === 0) {
    throw new SelectionValidationError(`${label} body is empty`);
  }
}

function isValidHotkey(hotkey: string): boolean {
  if (hotkey.length !== 1) return false;
  const code = hotkey.charCodeAt(0);
  return code >= 0x21 && code <= 0x7e;
}
