import { Show } from 'solid-js';
import { TextAttributes } from '@opentui/core';
import type { TerminalChoice } from './protocol.js';
import { tone } from './theme.js';
import { informationText, fitInformation } from './information-model.js';
import { SELECTED_MARK, SelectionBand, SelectionText } from './selection-row.js';

/** Shared list geometry. Ordinary rows never receive border setters: OpenTUI
 * enables a border when borderColor/borderStyle is assigned, even with false.
 * 选中态由 selection-row 的公共原语绘制（标记、整行纹理）；危险项保持红底、不叠纹理。 */
export function ChoiceView(props: { choice: TerminalChoice; selected: boolean; width: number; configuration: boolean; measure(text: string): number }) {
  const label = () => informationText(props.choice.hotkey ? `[${props.choice.hotkey}] ${props.choice.label}` : props.choice.label);
  const color = () => props.choice.disabled ? tone.dim : props.choice.danger ? tone.error : props.selected ? tone.brand : tone.text;
  const detail = () => `${props.choice.status === 'ready' ? '✓ ' : props.choice.status === 'pending' ? '⚠ ' : props.choice.status === 'disabled' ? '· ' : ''}${informationText(props.choice.detail ?? '')}`;
  const detailWidth = () => props.configuration && props.choice.detail ? Math.floor(props.width * 0.45) : 0;
  const leftWidth = () => props.width - (detailWidth() ? detailWidth() + 2 : 0);
  const stacked = () => props.measure(label()) + 2 > leftWidth();
  const fitted = () => fitInformation(label(), Math.max(0, leftWidth() - 2), props.measure);
  const band = () => props.selected && !props.choice.danger;
  return <Show when={props.choice.presentation === 'button'} fallback={
    <SelectionBand active={band()} width={props.width} flexDirection={stacked() ? 'column' : 'row'} backgroundColor={props.selected && props.choice.danger ? tone.dangerBackground : undefined}>
      <Show when={stacked()} fallback={<text width={leftWidth()} height={1} wrapMode="none" truncate fg={color()}>
        <Show when={props.selected} fallback={`› ${fitted()}`}><SelectionText active={band()} style={{ bold: true }} text={`${SELECTED_MARK} ${fitted()}`} /></Show></text>}>
        <text width={props.width} wrapMode="char" fg={color()} attributes={props.selected ? TextAttributes.BOLD : 0}>
          <SelectionText active={band()} text={`${props.selected ? SELECTED_MARK : '›'} ${label()}`} /></text>
      </Show>
      <Show when={props.configuration && props.choice.detail}>
        <text marginLeft={2} width={stacked() ? Math.max(1, props.width - 2) : detailWidth()} fg={props.choice.status === 'pending' ? tone.warn : props.choice.status === 'ready' ? tone.success : tone.dim}>
          <SelectionText active={band()} text={detail()} /></text>
      </Show>
    </SelectionBand>
  }>
    <SelectionBand active={band()} width={props.width} height={1}>
      <text width={2} selectable={false} fg={color()}><SelectionText active={band()} text={props.selected ? `${SELECTED_MARK} ` : '  '} /></text>
      <text width={8} height={1} wrapMode="none" truncate fg={props.selected ? color() : props.choice.primary ? tone.text : tone.dim}
        attributes={props.selected ? TextAttributes.BOLD : 0}><SelectionText active={band()} text={label()} /></text>
      <text flexGrow={1} height={1} wrapMode="none" truncate fg={tone.dim}><SelectionText active={band()} text={informationText(props.choice.detail ?? '')} /></text>
      <text marginLeft={2} height={1} wrapMode="none" fg={tone.dim}><SelectionText active={band()} text={props.choice.shortcut ?? ''} /></text>
    </SelectionBand>
  </Show>;
}
