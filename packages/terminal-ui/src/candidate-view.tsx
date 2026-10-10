import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import type { CliRenderer, ScrollBoxRenderable } from '@opentui/core';
import type { TerminalCandidates } from './protocol.js';
import { ChoiceView } from './choice-view.js';
import { spacing, tone } from './theme.js';

export interface CandidateViewHandle { page(direction: -1 | 1): void }

/** A stable physical viewport, including its empty/loading/error states. */
export function CandidateView(props: { value?: TerminalCandidates; loading: boolean; error?: string; selected: number;
  danger: boolean; width: number; height: number; renderer: CliRenderer; measure(text: string): number;
  onReady(value: CandidateViewHandle | undefined): void }) {
  let box: ScrollBoxRenderable | undefined;
  const [above, setAbove] = createSignal(false), [below, setBelow] = createSignal(false);
  let bringIntoView = true;
  createEffect(() => { props.selected; props.value; bringIntoView = true; props.renderer.requestRender(); });
  const postFrame = () => {
    if (!box) return;
    if (bringIntoView) { bringIntoView = false; box.scrollChildIntoView(`candidate-${props.selected}`); }
    setAbove(box.scrollTop > 0); setBelow(box.scrollTop + box.viewport.height < box.scrollHeight);
  };
  props.renderer.addPostProcessFn(postFrame);
  props.onReady({ page: direction => box?.scrollBy(direction * Math.max(1, box.viewport.height - 1)) });
  onCleanup(() => { props.renderer.removePostProcessFn(postFrame); props.onReady(undefined); });
  return <box border borderStyle="rounded" borderColor={tone.border} marginX={spacing.frame} height={props.height} flexShrink={0} flexDirection="column">
    <text height={1} fg={tone.dim} selectable={false}>{above() ? '  ↑ 更多候选' : ''}</text>
    <scrollbox ref={value => { box = value; }} height={Math.max(1, props.height - 4)} scrollY scrollX={false}
      verticalScrollbarOptions={{ width: 1, showArrows: false }}>
      <Show when={!props.loading && props.value?.items.length} fallback={<text fg={props.error || props.value?.error ? tone.warn : tone.dim}>{props.loading ? '  正在读取…' : props.error ?? props.value?.error ?? props.value?.argumentHint ?? '  没有匹配项'}</text>}>
        <For each={props.value?.items}>{(item, index) => <box id={`candidate-${index()}`} flexShrink={0}>
          <ChoiceView choice={{ ...item, danger: props.danger && props.selected === index() }} selected={props.selected === index()}
            width={Math.max(1, props.width - 3)} configuration measure={props.measure} />
        </box>}</For>
      </Show>
    </scrollbox>
    <text height={1} fg={tone.dim} selectable={false}>{below() ? '  ↓ 更多候选 · PgUp/PgDn 翻阅' : ''}</text>
  </box>;
}
