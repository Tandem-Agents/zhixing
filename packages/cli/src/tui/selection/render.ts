import { clampLine, padEndDisplay, stringWidth } from "../line-width.js";
import { icon, layout, tone } from "../style.js";
import type { SelectionState } from "./state.js";
import type {
  SelectionDetailsSpec,
  SelectionOption,
  ValidatedSelectionRequest,
} from "./types.js";
import {
  getSelectionDetails,
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
const DETAILS_FIXED_ROWS = 3;
const HEADER_SEPARATOR = "  ·  ";
const OPTION_LABEL_GAP = 2;
const OPTION_HOTKEY_GAP = 3;

interface PanelCopy {
  readonly title: string;
  readonly summary?: string;
  readonly body: readonly string[];
}

interface OptionLayout {
  readonly labelWidth: number;
  readonly hotkeyWidth: number;
  readonly descriptionWidth: number;
}

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
  if (state.layer === "details") {
    const details = getSelectionDetails(request, state.selectedIndex);
    if (details) {
      return renderDetailsPanel(request, state, details, lineBudget, maxPanelRows);
    }
  }

  const panelCopy = buildPanelCopy(request, state);
  const requiredRows = requiredPanelRows(request);
  if (requiredRows > maxPanelRows) {
    return { kind: "unavailable", reason: "terminal is too short" };
  }

  const optionalRows = maxPanelRows - requiredRows;
  const optionLayout = computeOptionLayout(request.options, lineBudget);
  const lines: string[] = [];

  lines.push(makeSeparator(lineBudget));
  lines.push(renderHeader(panelCopy, lineBudget));
  lines.push(...renderOptionalBody(panelCopy.body, optionalRows, lineBudget));
  lines.push(blankLine(lineBudget));

  request.options.forEach((option, index) => {
    lines.push(renderOptionLine(option, index, state, optionLayout, lineBudget));
  });

  lines.push(blankLine(lineBudget));
  lines.push(line(tone.dim(renderHint(request, state)), lineBudget));

  return {
    kind: "rendered",
    lines,
  };
}

function renderDetailsPanel<TValue extends string>(
  request: ValidatedSelectionRequest<TValue>,
  state: SelectionState,
  details: SelectionDetailsSpec,
  lineBudget: number,
  maxPanelRows: number,
): SelectionRenderResult {
  const bodyBudget = computeDetailsBodyRowsFromPanelRows(maxPanelRows);
  if (bodyBudget < 1) {
    return { kind: "unavailable", reason: "terminal is too short" };
  }

  const total = details.body.length;
  const maxOffset = Math.max(0, total - bodyBudget);
  const start = Math.min(state.detailScrollOffset, maxOffset);
  const visible = details.body.slice(start, start + bodyBudget);
  const selectedOption = request.options[state.selectedIndex];
  const baseSummary = details.title ?? selectedOption?.label ?? "详情";
  const summary = total > bodyBudget
    ? `${baseSummary} ${start + 1}-${start + visible.length}/${total}`
    : baseSummary;

  const lines = [
    makeSeparator(lineBudget),
    renderHeader({ title: request.title, summary, body: [] }, lineBudget),
    ...visible.map((bodyLine) => line(tone.dim(bodyLine), lineBudget)),
    line(tone.dim("↑/↓ 滚动 · Esc 返回"), lineBudget),
  ];
  return { kind: "rendered", lines };
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

export function computeDetailsBodyRows(options: SelectionRenderOptions): number {
  return computeDetailsBodyRowsFromPanelRows(computeMaxPanelRows(options));
}

function computeDetailsBodyRowsFromPanelRows(maxPanelRows: number): number {
  return maxPanelRows - DETAILS_FIXED_ROWS;
}

function requiredPanelRows<TValue extends string>(
  request: ValidatedSelectionRequest<TValue>,
): number {
  const separator = 1;
  const header = 1;
  const optionSpacer = 1;
  const options = request.options.length;
  const hintSpacer = 1;
  const hint = 1;
  return separator + header + optionSpacer + options + hintSpacer + hint;
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

function buildPanelCopy<TValue extends string>(
  request: ValidatedSelectionRequest<TValue>,
  state: SelectionState,
): PanelCopy {
  if (state.layer === "confirm") {
    const current = request.options[state.selectedIndex];
    if (current && isConfirmOption(current)) {
      return {
        title: request.title,
        summary: current.confirm.title,
        body: current.confirm.body ?? [],
      };
    }
  }

  const [summary, ...body] = request.body ?? [];
  return {
    title: request.title,
    summary,
    body,
  };
}

function renderHeader(copy: PanelCopy, lineBudget: number): string {
  const title = tone.bold(copy.title);
  if (!copy.summary) {
    return line(title, lineBudget);
  }
  return line(`${title}${tone.dim(HEADER_SEPARATOR)}${tone.dim(copy.summary)}`, lineBudget);
}

function computeOptionLayout<TValue extends string>(
  options: readonly SelectionOption<TValue>[],
  lineBudget: number,
): OptionLayout {
  const reserved = stringWidth(layout.contentPrefix) + stringWidth(`${icon.cursor} `);
  const available = Math.max(8, lineBudget - reserved);
  const hotkeyWidth = Math.max(
    0,
    ...options.map((option) =>
      option.hotkey ? stringWidth(`(${option.hotkey})`) : 0
    ),
  );
  const widestLabel = Math.max(
    1,
    ...options.map((option) => stringWidth(option.label)),
  );
  const hasDescription = options.some((option) => option.description);
  const maxDescriptionWidth = hasDescription
    ? Math.min(32, Math.max(12, Math.floor(available * 0.38)))
    : 0;
  const hotkeyColumns = hotkeyWidth > 0
    ? OPTION_LABEL_GAP + hotkeyWidth
    : 0;
  const descriptionGap = hasDescription ? OPTION_HOTKEY_GAP : 0;
  const fixedColumns = hotkeyColumns + descriptionGap;
  const maxLabelWidth = Math.max(1, available - fixedColumns - maxDescriptionWidth);
  const labelWidth = Math.min(widestLabel, maxLabelWidth);
  const descriptionWidth = hasDescription
    ? Math.max(0, Math.min(maxDescriptionWidth, available - fixedColumns - labelWidth))
    : 0;

  return {
    labelWidth,
    hotkeyWidth,
    descriptionWidth,
  };
}

function renderOptionLine<TValue extends string>(
  option: SelectionOption<TValue>,
  index: number,
  state: SelectionState,
  optionLayout: OptionLayout,
  lineBudget: number,
): string {
  const selected = index === state.selectedIndex;
  const marker = selected ? tone.brand(icon.selectable) : " ";
  const prefix = `${marker} `;

  let content: string;
  if (selected && state.layer === "input" && isInputOption(option)) {
    const value = state.inputBuffer.length > 0
      ? tone.brand(state.inputBuffer)
      : tone.dim(`(${option.input.placeholder})`);
    content = `${styleOptionLabel(option, selected)} ${value}${tone.brand("▎")}`;
  } else {
    const label = padEndDisplay(
      clampLine(styleOptionLabel(option, selected), optionLayout.labelWidth),
      optionLayout.labelWidth,
    );
    const hotkey = option.hotkey
      ? padEndDisplay(tone.dim(`(${option.hotkey})`), optionLayout.hotkeyWidth)
      : " ".repeat(optionLayout.hotkeyWidth);
    const parts = [label];
    if (optionLayout.hotkeyWidth > 0) {
      parts.push(" ".repeat(OPTION_LABEL_GAP), hotkey);
    }
    if (option.description && optionLayout.descriptionWidth > 0) {
      parts.push(
        " ".repeat(OPTION_HOTKEY_GAP),
        clampLine(tone.dim(option.description), optionLayout.descriptionWidth),
      );
    }
    content = parts.join("");
  }

  return line(`${prefix}${content}`, lineBudget);
}

function styleOptionLabel<TValue extends string>(
  option: SelectionOption<TValue>,
  selected: boolean,
): string {
  if (option.disabled) return tone.dim(option.label);
  if (selected && option.tone === "danger") return tone.error.bold(option.label);
  if (selected) return tone.brand.bold(option.label);
  if (option.tone === "primary") return tone.brand.bold(option.label);
  if (option.tone === "danger") return tone.error(option.label);
  if (option.tone === "muted") return tone.dim(option.label);
  return option.label;
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
  const detailsHint = getSelectionDetails(request, state.selectedIndex)
    ? " · → 详情"
    : "";
  return `Enter ${request.submitLabel ?? "选择"} · ↑/↓ 选择${detailsHint} · Esc ${
    request.cancelLabel ?? "取消"
  }`;
}

function makeSeparator(lineBudget: number): string {
  const width = Math.max(1, lineBudget - stringWidth(layout.contentPrefix));
  return line(tone.dim("─".repeat(width)), lineBudget);
}

function line(content: string, lineBudget: number): string {
  return clampLine(`${layout.contentPrefix}${content}`, lineBudget);
}

function blankLine(lineBudget: number): string {
  return line("", lineBudget);
}
