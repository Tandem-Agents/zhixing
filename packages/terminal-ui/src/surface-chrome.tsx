import { For, Show } from 'solid-js';
import type { TerminalView } from './protocol.js';
import { tone, spacing, surfaceGeometry } from './theme.js';
import { cleanProcessText, processCellWidth, processLine } from './process-model.js';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const cells = (text: string) => { let width = 0; for (const { segment } of graphemes.segment(text)) width += processCellWidth(segment); return width; };

/** Shared identity, frame and environment geometry. Pages supply only content. */
/** bottomGap=false：正文页自己管理欢迎框下的那一行（间隔或“对话从这里开始”），这里不再加下边距。 */
export function SurfaceChrome(props: { view: TerminalView; width: number; height: number; bottomGap?: boolean }) {
  const main = () => ['conversation', 'history', 'unavailable'].includes(props.view.kind);
  const branded = () => main() || props.view.configurationHome;
  // Page identity and real window size select this variant, never query results.
  const compact = () => props.height < 20 || props.width < 24;
  const line = (value: string) => cleanProcessText(value).replace(/[\r\n]/gu, ' ');
  const status = () => props.view.connectionState === 'starting' ? '正在启动…'
    : props.view.connected === false ? '暂未连接 · 已有内容保留'
    : main() && props.view.title !== '知行' ? `当前对话 ${line(props.view.title)}` : props.view.title === '知行' ? '' : line(props.view.title);
  const geometry = () => surfaceGeometry(props.width);
  // 无框层级标题：标题按可用列截短，横线正好补满余下的列。不能靠截断收尾——截断会把省略号放进横线中间
  const titleRule = () => {
    const columns = Math.max(1, geometry().frameWidth - 1);
    const title = processLine(line(props.view.title), columns);
    return { title, rule: '─'.repeat(Math.max(0, columns - cells(title) - 1)) };
  };
  return <box width={geometry().frameWidth} marginLeft={geometry().margin} flexDirection="column" flexShrink={0} marginBottom={props.bottomGap === false ? 0 : 1}>
    <Show when={!compact()} fallback={<text height={1} wrapMode="none" truncate fg={tone.brand}>{branded() ? '知行 ' : ''}{status()}</text>}>
      {/* 子页页头按页面身份二选一：有说明（进入时需要、页面别处看不到的信息）就画框装说明；
          标题足以辨识的页面用无框层级标题——品牌色加粗的标题后接一条弱化横线，不画只有两根边线的空框 */}
      <Show when={branded()} fallback={<Show when={props.view.chromeDescription} fallback={
        <text height={1} wrapMode="none" marginLeft={1}><span style={{ fg: tone.brand, bold: true }}>{titleRule().title}</span>
          <span style={{ fg: tone.border }}>{titleRule().rule ? ` ${titleRule().rule}` : ''}</span></text>}>
        <box border borderStyle="rounded" borderColor={tone.border} title={` ${line(props.view.title)} `} paddingX={spacing.welcomeInner} paddingY={1} height="auto">
          <text fg={tone.text}>{props.view.chromeDescription}</text>
        </box>
      </Show>}>
      <text height={1} wrapMode="none" fg={tone.border}>╭──── <span style={{fg: tone.brand}}>╲</span> {'─'.repeat(Math.max(0, geometry().frameWidth - 9))}╮</text>
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
