import { createMemo, For } from 'solid-js';
import { processViewRows, type TerminalProcessView } from './process-model.js';

export interface ProcessViewProps { readonly view: TerminalProcessView; readonly width: number; readonly height: number; readonly indicator?: string }
/** Mounted by the one existing root; no listeners, timers or renderer ownership. */
export function ProcessView(props: ProcessViewProps) {
  const rows = createMemo(() => processViewRows(props.view, Math.max(1, props.width - 4), props.height));
  return <box flexDirection="column" height={rows().length} overflow="hidden" marginX={2}>
    <For each={rows()}>{(row, index) => <text height={1} wrapMode="none" truncate fg={row.failed ? '#ef9c9c' : '#9aa8a1'}>{index() === 0 && props.indicator ? props.indicator + row.text.slice(1) : row.text}</text>}</For>
  </box>;
}
