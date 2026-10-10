import { Show } from 'solid-js';
import { TextAttributes } from '@opentui/core';
import type { TerminalChoice } from './protocol.js';
import { tone } from './theme.js';
import { informationText, fitInformation } from './information-model.js';

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
  const texture = () => props.selected && !props.choice.danger ? '░'.repeat(Math.max(0, leftWidth() - 2 - props.measure(fitted()) - 1)) : '';
  return <Show when={props.choice.presentation === 'button'} fallback={
    <box flexDirection={stacked() ? 'column' : 'row'} flexShrink={0} backgroundColor={props.selected && props.choice.danger ? tone.dangerBackground : undefined}>
      <Show when={stacked()} fallback={<text width={leftWidth()} height={1} wrapMode="none" truncate fg={color()}><Show when={props.selected} fallback={`› ${fitted()}`}><span style={{bold: true}}>{`▸ ${fitted()}`}</span></Show><span style={{fg: tone.dim, dim: true}}>{texture() ? ` ${texture()}` : ''}</span></text>}>
        <text width={props.width} wrapMode="char" fg={color()} attributes={props.selected ? TextAttributes.BOLD : 0}>{`${props.selected ? '▸' : '›'} ${label()}`}</text>
      </Show>
      <Show when={props.configuration && props.choice.detail}>
        <text marginLeft={2} width={stacked() ? Math.max(1, props.width - 2) : detailWidth()} fg={props.choice.status === 'pending' ? tone.warn : props.choice.status === 'ready' ? tone.success : tone.dim}>{detail()}</text>
      </Show>
    </box>
  }>
    <box flexDirection="row" flexShrink={0} alignItems="center">
      <text width={2} fg={tone.brand}>{props.selected ? '▸ ' : '  '}</text>
      <box border borderStyle="single" borderColor={props.choice.primary ? tone.success : props.selected ? tone.text : tone.dim} paddingX={2} flexShrink={0}>
        <text fg={props.choice.primary ? tone.success : props.selected ? tone.text : tone.dim}>{label()}</text>
      </box>
      <text marginLeft={3} flexShrink={1} fg={tone.dim}>{[props.choice.detail ? `(${informationText(props.choice.detail)})` : '', props.choice.shortcut].filter(Boolean).join('   ')}</text>
    </box>
  </Show>;
}
