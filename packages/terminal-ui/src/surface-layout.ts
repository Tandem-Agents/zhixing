import type { TerminalView } from './protocol.js';
import { fitInformation } from './information-model.js';

/** Refresh generations are not interaction identities. */
export function interactionKey(view: TerminalView): string {
  return JSON.stringify([view.kind, view.conversationId, view.editId, view.requestId,
    view.field?.id, view.skills?.sessionId, view.recovery?.requestId, view.kind === 'configuration' ? view.title : undefined]);
}

export function inputRows(lines: number, terminalHeight: number): number {
  return Math.max(1, Math.min(Math.max(1, lines), 8, Math.floor(terminalHeight / 3)));
}

/** Physical rows are reserved for the whole candidate interaction, independent
 * of response count, loading, errors or process updates. */
export function candidateLayout(height: number) {
  const editor = height >= 32 ? 4 : height >= 20 ? 2 : 1;
  const process = height >= 24 ? 3 : height >= 20 ? 2 : 1;
  const rows = Math.max(0, Math.min(16, height - 2 - process - (editor + 2) - (height >= 20 ? 4 : 1)));
  return { editor, process, rows: rows >= 5 ? rows : 0 };
}

/** Texture marks a selected row, never an input, an unselected row or danger. */
export function selectedLabel(text: string, selected: boolean, danger: boolean, width: number, measure: (text: string) => number): string {
  const label = fitInformation(text, width, measure);
  if (!selected || danger) return label;
  return label + '░'.repeat(Math.max(0, width - measure(label)));
}

/** Preserve a still-enabled selection, otherwise honor the requested default. */
export function initialChoiceIndex(view: TerminalView, previousId?: string): number {
  const choices = view.choices ?? [];
  for (const id of [previousId, view.initialItemId]) {
    const index = id === undefined ? -1 : choices.findIndex(choice => choice.id === id && !choice.disabled);
    if (index >= 0) return index;
  }
  return choices.findIndex(choice => !choice.disabled);
}

export function nextChoiceIndex(view: TerminalView, current: number, direction: -1 | 1): number {
  const choices = view.choices ?? [];
  for (let index = current + direction; index >= 0 && index < choices.length; index += direction) {
    if (!choices[index]!.disabled) return index;
  }
  return current;
}
