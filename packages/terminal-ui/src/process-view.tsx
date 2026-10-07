import { createMemo, For } from 'solid-js';
import { processViewRows, type TerminalProcessView } from './process-model.js';

export interface ProcessViewProps { readonly view: TerminalProcessView; readonly width: number; readonly height: number }
/** Mounted by the one existing root; no listeners, timers or renderer ownership. */
export function ProcessView(props: ProcessViewProps) {
  const rows = createMemo(() => processViewRows(props.view, props.width, props.height));
  return <box flexDirection="column" height={Math.max(1, props.height)} overflow="hidden">
    <For each={rows()}>{row => <text height={1} wrapMode="none" truncate fg={row.failed ? '#ef9c9c' : '#9aa8a1'}>{row.text}</text>}</For>
  </box>;
}
