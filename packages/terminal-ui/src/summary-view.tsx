import { For, Show, createMemo, type JSX } from 'solid-js';
import type { TerminalSummary, TerminalSummaryTone } from './protocol.js';
import { SUMMARY_INDENT, summaryPlan, summaryTextWidth, type SummaryBlock, type SummaryPlan } from './summary-layout.js';
import { sectionMarker, tone } from './theme.js';

/**
 * 信息分节组件：页面给语义，这里决定章节标记、颜色与宽窄排版。
 * 每段语义文字是一个原生按词折行的文字节点，复制时同一节点跨软折行取的是源文；
 * 节点之间的分隔由语义决定：标签与值、标题与侧注之间是制表符，其余换行（见 summaryLeafInfo 与 copy-selection）。
 * 章节标记是单独的不可选文字，不进复制。
 */
export interface SummaryLeafInfo { readonly key: object; readonly after?: object; readonly joiner?: string }
const leaves = new WeakMap<object, SummaryLeafInfo>();
/** 复制时取信息分节文字节点的语义关系；不是信息分节的节点返回 undefined */
export const summaryLeafInfo = (leaf: unknown): SummaryLeafInfo | undefined => (leaf && typeof leaf === 'object' ? leaves.get(leaf) : undefined);
const mark = (info: SummaryLeafInfo) => (node: object) => { leaves.set(node, info); };

const toneStyle = (value: TerminalSummaryTone | 'title') => value === 'title' || value === 'accent' ? { fg: tone.brand, bold: true }
  : value === 'dim' ? { fg: tone.dim } : value === 'warn' ? { fg: tone.warn } : { fg: tone.text };

export function SummaryView(props: { readonly summary: TerminalSummary; readonly width: number; readonly graphemeWidth: (grapheme: string) => number;
  readonly display: (text: string) => string }) {
  const plan = createMemo(() => summaryPlan(props.summary, props.width, props.graphemeWidth, sectionMarker));
  const markerWidth = () => summaryTextWidth(sectionMarker, props.graphemeWidth);
  /** 一段语义文字：原生按词折行，宽度固定在所在列 */
  const paragraph = (value: string, style: TerminalSummaryTone, info: SummaryLeafInfo, marginLeft: number, width: number) =>
    <text ref={mark(info)} selectable wrapMode="word" marginLeft={marginLeft} width={Math.max(1, width)} flexShrink={0}>
      <span style={toneStyle(style)}>{props.display(value)}</span></text>;
  const block = (current: SummaryBlock, layout: SummaryPlan): JSX.Element => {
    switch (current.kind) {
      case 'lead':
        return <text ref={mark({ key: {} })} selectable wrapMode="word" width={layout.width} flexShrink={0}>
          <For each={current.spans}>{span => <span style={toneStyle(span.tone ?? 'normal')}>{props.display(span.text)}</span>}</For></text>;
      case 'header': {
        const title = { key: {} }, aside = { key: {}, after: title.key };
        return <box flexDirection="column" flexShrink={0} marginTop={current.gap ? 1 : 0}>
          <box flexDirection="row" flexShrink={0} width={layout.width}>
            <text selectable={false} wrapMode="none" flexShrink={0} fg={tone.brand}>{sectionMarker}</text>
            <text ref={mark(title)} selectable wrapMode="word" flexShrink={current.asideInline ? 0 : 1}
              width={current.asideInline ? undefined : Math.max(1, layout.width - markerWidth())}>
              <span style={toneStyle('title')}>{props.display(current.title)}</span></text>
            <Show when={current.asideInline}>
              <box flexGrow={1} minWidth={2} />
              <text ref={mark(aside)} selectable wrapMode="none" flexShrink={0}><span style={toneStyle('dim')}>{props.display(current.aside ?? '')}</span></text>
            </Show>
          </box>
          <Show when={current.aside && !current.asideInline}>{paragraph(current.aside ?? '', 'dim', aside, SUMMARY_INDENT, layout.width - SUMMARY_INDENT)}</Show>
        </box>;
      }
      case 'items': {
        // 每项一个文字节点，在可换行的横排里整体排布：名称不在中间断开；第二项起自带“· ”，复制时同一串的项之间补一个空格，得到“甲 · 乙 · 丙”
        const infos: SummaryLeafInfo[] = [];
        for (const _ of current.items) infos.push({ key: {}, ...(infos.length ? { after: infos.at(-1)!.key, joiner: ' ' } : {}) });
        const row = Math.max(1, layout.width - SUMMARY_INDENT);
        return <box flexDirection="row" flexWrap="wrap" flexShrink={0} marginLeft={SUMMARY_INDENT} width={row}>
          <For each={current.items}>{(item, index) => <text ref={mark(infos[index()]!)} selectable wrapMode="word" flexShrink={1} maxWidth={row}
            marginRight={index() < current.items.length - 1 ? 1 : 0}><span style={toneStyle('normal')}>{props.display(index() ? `· ${item}` : item)}</span></text>}</For>
        </box>;
      }
      case 'row': {
        const label = { key: {} }, value = { key: {}, after: label.key };
        if (current.stacked) return <box flexDirection="column" flexShrink={0}>
          {paragraph(current.label, 'normal', label, SUMMARY_INDENT, layout.width - SUMMARY_INDENT)}
          {paragraph(current.value, current.tone, value, SUMMARY_INDENT * 2, layout.width - SUMMARY_INDENT * 2)}
          <Show when={current.note}>{paragraph(current.note ?? '', 'dim', { key: {} }, SUMMARY_INDENT * 2, layout.width - SUMMARY_INDENT * 2)}</Show>
        </box>;
        const valueStart = SUMMARY_INDENT + layout.labelColumn + 2;
        return <box flexDirection="column" flexShrink={0}>
          <box flexDirection="row" flexShrink={0} marginLeft={SUMMARY_INDENT}>
            <text ref={mark(label)} selectable wrapMode="none" width={layout.labelColumn} flexShrink={0}><span style={toneStyle('normal')}>{props.display(current.label)}</span></text>
            <box width={2} flexShrink={0} />
            {paragraph(current.value, current.tone, value, 0, layout.width - valueStart)}
          </box>
          <Show when={current.note}>{paragraph(current.note ?? '', 'dim', { key: {} }, valueStart, layout.width - valueStart)}</Show>
        </box>;
      }
      case 'note':
        return paragraph(current.text, 'dim', { key: {} }, SUMMARY_INDENT, layout.width - SUMMARY_INDENT);
    }
  };
  return <box flexDirection="column" flexShrink={0} width={plan().width}>
    <For each={plan().blocks}>{current => block(current, plan())}</For>
  </box>;
}
