import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import type { CliRenderer, ScrollBoxRenderable } from '@opentui/core';
import type { TerminalCandidates } from './protocol.js';
import { ChoiceView } from './choice-view.js';
import { spacing, tone } from './theme.js';
import { candidateFooter } from './information-model.js';

/** A stable physical viewport, including its empty/loading/error states. 翻页移动的是选中项，视图随选中项跟随。 */
export function CandidateView(props: { value?: TerminalCandidates; loading: boolean; error?: string; selected: number;
  danger: boolean; keys: readonly string[]; width: number; height: number; renderer: CliRenderer; measure(text: string): number }) {
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
  onCleanup(() => { props.renderer.removePostProcessFn(postFrame); });
  // 框内与输入框同样留 1 列内距；状态文字（读取中、没有匹配、参数提示、错误）与条目标签对齐：
  // 左移量是选中标记“› ”的宽度，用外边距而不是前导空格，折行后的续行也对齐。错误保持警示色
  const statusInset = 2;
  return <box border borderStyle="rounded" borderColor={tone.border} marginX={spacing.frame} paddingX={spacing.frameInner} height={props.height} flexShrink={0} flexDirection="column">
    <text height={1} marginLeft={statusInset} fg={tone.dim} selectable={false}>{above() ? '↑ 更多候选' : ''}</text>
    <scrollbox ref={value => { box = value; }} height={Math.max(1, props.height - 4)} scrollY scrollX={false}
      verticalScrollbarOptions={{ width: 1, showArrows: false }}>
      <Show when={!props.loading && props.value?.items.length} fallback={<text marginLeft={statusInset} fg={props.error || props.value?.error ? tone.warn : tone.dim}>{props.loading ? '正在读取…' : props.error ?? props.value?.error ?? props.value?.argumentHint ?? '没有匹配项'}</text>}>
        <For each={props.value?.items}>{(item, index) => <box id={`candidate-${index()}`} flexShrink={0}>
          {/* 内容宽 = 终端宽 − 左右外边距 − 两侧边框 − 两侧内距 − 滚动条；多算会让描述按更宽折行，行尾字被裁掉 */}
          <ChoiceView choice={{ ...item, danger: props.danger && props.selected === index() }} selected={props.selected === index()}
            width={Math.max(1, props.width - 2 * spacing.frame - 2 - 2 * spacing.frameInner - spacing.scrollbar)} configuration measure={props.measure} />
        </box>}</For>
      </Show>
    </scrollbox>
    {/* 底行：“↓ 更多候选”与信息行放不下的键位共用，按整项取舍（candidateFooter） */}
    <text height={1} marginLeft={statusInset} wrapMode="none" fg={tone.dim} selectable={false}>{candidateFooter(below(), props.keys,
      props.width - 2 * spacing.frame - 2 - 2 * spacing.frameInner - statusInset, props.measure)}</text>
  </box>;
}
