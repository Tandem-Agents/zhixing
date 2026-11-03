import { Show } from 'solid-js';
import { TextAttributes } from '@opentui/core';
import type { TerminalChoice } from './protocol.js';
import { tone } from './theme.js';
import { informationText, fitInformation } from './information-model.js';

/** 选中行标记：控制台西文字体（Consolas 等）里也有的拉丁字符，与未选中的“›”同族；
 *  原来的“▸”在整行都是 ASCII 时会按西文字体渲染成缺字方框 */
export const SELECTED_MARK = '»';

/** Shared list geometry. Ordinary rows never receive border setters: OpenTUI
 * enables a border when borderColor/borderStyle is assigned, even with false. */
export function ChoiceView(props: { choice: TerminalChoice; selected: boolean; width: number; configuration: boolean; measure(text: string): number }) {
  const label = () => informationText(props.choice.hotkey ? `[${props.choice.hotkey}] ${props.choice.label}` : props.choice.label);
  const color = () => props.choice.disabled ? tone.dim : props.choice.danger ? tone.error : props.selected ? tone.brand : tone.text;
  const detail = () => `${props.choice.status === 'ready' ? '✓ ' : props.choice.status === 'pending' ? '⚠ ' : props.choice.status === 'disabled' ? '· ' : ''}${informationText(props.choice.detail ?? '')}`;
  const detailWidth = () => props.configuration && props.choice.detail ? Math.floor(props.width * 0.45) : 0;
  const leftWidth = () => props.width - (detailWidth() ? detailWidth() + 2 : 0);
  const stacked = () => props.measure(label()) + 2 > leftWidth();
  const fitted = () => fitInformation(label(), Math.max(0, leftWidth() - 2), props.measure);
  // 选中行的点状引导线：用 ASCII 点，控制台西文字体在纯 ASCII 行里也能显示（原“░”会渲染成缺字方框）
  const texture = () => props.selected && !props.choice.danger ? '.'.repeat(Math.max(0, leftWidth() - 2 - props.measure(fitted()) - 1)) : '';
  return <Show when={props.choice.presentation === 'button'} fallback={
    <box flexDirection={stacked() ? 'column' : 'row'} flexShrink={0} backgroundColor={props.selected && props.choice.danger ? tone.dangerBackground : undefined}>
      <Show when={stacked()} fallback={<text width={leftWidth()} height={1} wrapMode="none" truncate fg={color()}><Show when={props.selected} fallback={`› ${fitted()}`}><span style={{bold: true}}>{`${SELECTED_MARK} ${fitted()}`}</span></Show><span style={{fg: tone.dim, dim: true}}>{texture() ? ` ${texture()}` : ''}</span></text>}>
        <text width={props.width} wrapMode="char" fg={color()} attributes={props.selected ? TextAttributes.BOLD : 0}>{`${props.selected ? SELECTED_MARK : '›'} ${label()}`}</text>
      </Show>
      <Show when={props.configuration && props.choice.detail}>
        <text marginLeft={2} width={stacked() ? Math.max(1, props.width - 2) : detailWidth()} fg={props.choice.status === 'pending' ? tone.warn : props.choice.status === 'ready' ? tone.success : tone.dim}>{detail()}</text>
      </Show>
    </box>
  }>
    <box flexDirection="row" height={1} flexShrink={0}>
      <text width={2} selectable={false} fg={color()}>{props.selected ? `${SELECTED_MARK} ` : '  '}</text>
      <text width={8} height={1} wrapMode="none" truncate fg={props.selected ? color() : props.choice.primary ? tone.text : tone.dim}
        attributes={props.selected ? TextAttributes.BOLD : 0}>{label()}</text>
      <text flexGrow={1} height={1} wrapMode="none" truncate fg={tone.dim}>{informationText(props.choice.detail ?? '')}</text>
      <text marginLeft={2} height={1} wrapMode="none" fg={tone.dim}>{props.choice.shortcut ?? ''}</text>
    </box>
  </Show>;
}
