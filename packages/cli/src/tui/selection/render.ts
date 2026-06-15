import { clampLine, stringWidth } from "../line-width.js";
import { icon, layout, tone } from "../style.js";
import type { SelectionState } from "./state.js";
import type {
  SelectionOption,
  ValidatedSelectionRequest,
} from "./types.js";
import {
  isConfirmOption,
  isInputOption,
} from "./types.js";

export interface SelectionRenderOptions {
  readonly columns: number;
  readonly viewportRows: number;
  readonly statusRows?: number;
  readonly minScrollRows?: number;
}

export type SelectionRenderResult =
  | { readonly kind: "rendered"; readonly lines: readonly string[] }
  | { readonly kind: "unavailable"; readonly reason: string };

const DEFAULT_MIN_SCROLL_ROWS = 4;
const MIN_COLUMNS = 24;

export function renderSelectionPanel<TValue extends string>(
  request: ValidatedSelectionRequest<TValue>,
  state: SelectionState,
  options: SelectionRenderOptions,
): SelectionRenderResult {
  const columns = Math.floor(options.columns);
  if (!Number.isFinite(columns) || columns < MIN_COLUMNS) {
    return { kind: "unavailable", reason: "terminal is too narrow" };
  }

  const lineBudget = columns - 1;
  const maxPanelRows = computeMaxPanelRows(options);
  const requiredRows = requiredPanelRows(request, state);
  if (requiredRows > maxPanelRows) {
    return { kind: "unavailable", reason: "terminal is too short" };
  }

  const optionalRows = maxPanelRows - requiredRows;
  const lines: string[] = [];

  lines.push(makeSeparator(lineBudget));
  lines.push(line(`${tone.brand(icon.section)} ${tone.bold(request.title)}`, lineBudget));

  if (state.layer === "confirm") {
    const current = request.options[state.selectedIndex];
    if (current && isConfirmOption(current)) {
      lines.push(line(tone.warn(current.confirm.title), lineBudget));
      lines.push(
        ...renderOptionalBody(current.confirm.body ?? [], optionalRows, lineBudget),
      );
    }
  } else {
    lines.push(...renderOptionalBody(request.body ?? [], optionalRows, lineBudget));
  }

  request.options.forEach((option, index) => {
    lines.push(renderOptionLine(option, index, state, lineBudget));
  });

  lines.push(line(tone.dim(renderHint(request, state)), lineBudget));

  return {
    kind: "rendered",
    lines,
  };
}

export function computeMaxPanelRows(options: SelectionRenderOptions): number {
  const rows = Math.floor(options.viewportRows);
  if (!Number.isFinite(rows) || rows <= 0) return 0;
  const statusRows = Math.max(0, Math.floor(options.statusRows ?? 0));
  const minScrollRows = Math.max(
    1,
    Math.floor(options.minScrollRows ?? DEFAULT_MIN_SCROLL_ROWS),
  );
  return Math.max(0, rows - statusRows - minScrollRows);
}

function requiredPanelRows<TValue extends string>(
  request: ValidatedSelectionRequest<TValue>,
  state: SelectionState,
): number {
  const separator = 1;
  const title = 1;
  const confirmTitle = state.layer === "confirm" ? 1 : 0;
  const options = request.options.length;
  const hint = 1;
  return separator + title + confirmTitle + options + hint;
}

function renderOptionalBody(
  body: readonly string[],
  budget: number,
  lineBudget: number,
): string[] {
  if (budget <= 0 || body.length === 0) return [];
  if (body.length <= budget) {
    return body.map((bodyLine) => line(tone.dim(bodyLine), lineBudget));
  }
  if (budget === 1) {
    return [
      line(tone.dim(`说明已折叠 ${body.length} 行`), lineBudget),
    ];
  }
  const visible = body.slice(0, budget - 1).map(
    (bodyLine) => line(tone.dim(bodyLine), lineBudget),
  );
  visible.push(
    line(tone.dim(`说明已折叠 ${body.length - visible.length} 行`), lineBudget),
  );
  return visible;
}

function renderOptionLine<TValue extends string>(
  option: SelectionOption<TValue>,
  index: number,
  state: SelectionState,
  lineBudget: number,
): string {
  const selected = index === state.selectedIndex;
  const marker = selected ? icon.cursor : " ";
  const prefix = `${marker} `;
  const hotkey = option.hotkey ? tone.dim(`(${option.hotkey})`) : "";

  let content: string;
  if (selected && state.layer === "input" && isInputOption(option)) {
    const value = state.inputBuffer.length > 0
      ? tone.brand(state.inputBuffer)
      : tone.dim(`(${option.input.placeholder})`);
    content = `${option.label} ${value}${tone.brand("▎")}`;
  } else {
    content = option.label;
    if (option.description) {
      content += ` ${tone.dim(`- ${option.description}`)}`;
    }
    if (option.disabled) {
      content = tone.dim(content);
    } else if (selected && option.tone === "danger") {
      content = tone.error.bold(content);
    } else if (selected || option.tone === "primary") {
      content = tone.brand.bold(content);
    } else if (option.tone === "danger") {
      content = tone.error(content);
    } else if (option.tone === "muted") {
      content = tone.dim(content);
    }
  }

  const left = `${prefix}${content}`;
  if (!hotkey || selected && state.layer === "input") {
    return line(left, lineBudget);
  }

  const visible = stringWidth(`${layout.contentPrefix}${left}`);
  const hotkeyVisible = stringWidth(hotkey);
  const pad = Math.max(1, lineBudget - visible - hotkeyVisible);
  return line(`${left}${" ".repeat(pad)}${hotkey}`, lineBudget);
}

function renderHint<TValue extends string>(
  request: ValidatedSelectionRequest<TValue>,
  state: SelectionState,
): string {
  if (state.layer === "input") {
    return `Enter ${request.submitLabel ?? "提交"} · Esc 返回`;
  }
  if (state.layer === "confirm") {
    const current = request.options[state.selectedIndex];
    const confirm = current && isConfirmOption(current)
      ? current.confirm
      : undefined;
    return `Enter ${confirm?.confirmLabel ?? "确认"} · Esc ${
      confirm?.cancelLabel ?? "返回"
    }`;
  }
  return `Enter ${request.submitLabel ?? "选择"} · Esc ${
    request.cancelLabel ?? "取消"
  }`;
}

function makeSeparator(lineBudget: number): string {
  return line(tone.dim("─".repeat(Math.max(1, lineBudget))), lineBudget);
}

function line(content: string, lineBudget: number): string {
  return clampLine(`${layout.contentPrefix}${content}`, lineBudget);
}
