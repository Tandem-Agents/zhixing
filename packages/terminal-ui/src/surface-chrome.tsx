import { For, Show } from 'solid-js';
import type { TerminalView } from './protocol.js';
import { tone, spacing } from './theme.js';
import { cleanProcessText } from './process-model.js';

/** Shared identity, frame and environment geometry. Pages supply only content. */
export function SurfaceChrome(props: { view: TerminalView; width: number; height: number }) {
  const main = () => ['conversation', 'history', 'unavailable'].includes(props.view.kind);
  const branded = () => main() || props.view.configurationHome;
  // Page identity and real window size select this variant, never query results.
  const compact = () => props.height < 20 || props.width < 24;
  const line = (value: string) => cleanProcessText(value).replace(/[\r\n]/gu, ' ');
  const status = () => props.view.connectionState === 'starting' ? '正在启动…'
    : props.view.connected === false ? '暂未连接 · 已有内容保留'
    : main() && props.view.title !== '知行' ? `当前对话 ${line(props.view.title)}` : props.view.title === '知行' ? '' : line(props.view.title);
  return <box flexDirection="column" flexShrink={0} marginBottom={1}>
    <Show when={!compact()} fallback={<text height={1} wrapMode="none" truncate fg={tone.brand}>{branded() ? '知行 ' : ''}{status()}</text>}>
      <Show when={branded()} fallback={<box border borderStyle="rounded" borderColor={tone.border} title={` ${line(props.view.title)} `} paddingX={spacing.welcomeInner} paddingY={props.view.chromeDescription ? 1 : 0} height={props.view.chromeDescription ? 'auto' : 2}>
        <Show when={props.view.chromeDescription}><text fg={tone.text}>{props.view.chromeDescription}</text></Show>
      </box>}>
      <text height={1} wrapMode="none" fg={tone.border}>╭──── <span style={{fg: tone.brand}}>╲</span> {'─'.repeat(Math.max(0, props.width - 9))}╮</text>
      <box border={['left', 'right', 'bottom']} borderStyle="rounded" borderColor={tone.border}
        paddingLeft={spacing.welcomeInner} paddingRight={1} paddingBottom={1} flexDirection="column">
        <text height={1} fg={tone.brand}>{' ▄▄▄'}<Show when={props.view.configurationHome}><span style={{bold: true}}>{'    知行'}</span></Show></text>
        <text height={1} fg={tone.brand}>{'▌●●▐    '}<Show when={props.view.configurationHome} fallback={<span style={{bold: true}}>知行</span>}><span style={{fg: tone.dim}}>{line(props.view.title)}</span></Show></text>
        <text height={1} wrapMode="none" truncate fg={tone.brand}>{' ▀▀     '}<span style={{fg: tone.dim}}>{props.view.configurationHome ? '配置你的知行' : status()}</span></text>
        <Show when={props.view.environment}>
          <text height={1}> </text>
          <text height={1} wrapMode="none" truncate fg={tone.dim}>{`工作目录    ${line(props.view.environment?.workspace ?? '未绑定工作目录')}`}</text>
          <text height={1} wrapMode="none" truncate fg={tone.dim}>{`模型        ${line([props.view.environment?.provider, props.view.environment?.model].filter(Boolean).join(' · ') || '未配置')}`}</text>
        </Show>
        <Show when={props.view.chromeDetails?.length}>
          <text height={1}> </text>
          <For each={props.view.chromeDetails}>{detail => <text height={1} wrapMode="none" truncate fg={tone.dim}>{line(detail)}</text>}</For>
        </Show>
      </box>
      </Show>
    </Show>
  </box>;
}
