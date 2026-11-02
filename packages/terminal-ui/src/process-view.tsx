import { tone } from './theme.js';
import { For } from 'solid-js';
import type { ProcessViewRow } from './process-model.js';

/** 行由调用方按同一份行数预算算好（root 还要据此判断当前说明是否已完整显示） */
export interface ProcessViewProps { readonly rows: readonly ProcessViewRow[]; readonly indicator?: string }
/** Mounted by the one existing root; no listeners, timers or renderer ownership. */
export function ProcessView(props: ProcessViewProps) {
  return <box flexDirection="column" height={props.rows.length} overflow="hidden" marginX={2}>
    <For each={props.rows}>{row => <text height={1} wrapMode="none" truncate fg={row.failed ? tone.error : tone.dim}>{row.status && row.text && props.indicator ? props.indicator + row.text.slice(1) : row.text}</text>}</For>
  </box>;
}
