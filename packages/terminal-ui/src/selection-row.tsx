import { createSignal, For, Show, type JSX } from 'solid-js';
import { RGBA, TextAttributes, type BoxRenderable } from '@opentui/core';
import { tone } from './theme.js';
import { selectionSegments, selectionTextureLayer } from './selection-model.js';

export { SELECTED_MARK } from './selection-model.js';

/**
 * 选中当前项的呈现原语（规则见 selection-model.ts）。
 *
 * 铺设：选中行的行盒下垫一层与行盒同尺寸的弱化纹理，行内文字照常排版。文字按段处理：两个及以上的
 * 连续空格不设底色（透出纹理），其余字与单空格用默认底色盖住纹理（OpenTUI 文字本身不画空格）。于是
 * 列间间隔、各显示行的尾部、文字内的连续空白都成为纹理，单空格保留；文字内容不变，纹理不可选、
 * 不进复制、不参与布局；只铺在行盒内，外边距、框线、滚动列不受影响。危险项由调用方保持红底、不激活。
 */

type SpanStyle = { readonly fg?: RGBA; readonly bold?: boolean; readonly dim?: boolean };
const cover = RGBA.defaultBackground();

/** 行内的一段文字：所在行被选中时按段盖住或透出纹理，否则原样 */
export function SelectionText(props: { text: string; active: boolean; style?: SpanStyle }): JSX.Element {
  return <Show when={props.active} fallback={<span style={props.style ?? {}}>{props.text}</span>}>
    <For each={selectionSegments(props.text)}>{part => <span style={part.open ? props.style ?? {} : { ...props.style, bg: cover }}>{part.text}</span>}</For>
  </Show>;
}

/** 选中行的行盒：active 时在盒下垫纹理层，尺寸取自原生布局。纹理层始终挂在行盒的第一个子位置、未选中时
 *  内容为空：按条件挂载会让后挂上的层排在文字之后、画在文字上面。 */
export function SelectionBand(props: { active: boolean; width?: number; height?: number; flexDirection?: 'row' | 'column';
  backgroundColor?: RGBA; children: JSX.Element }): JSX.Element {
  const [size, setSize] = createSignal({ width: 0, height: 0 });
  return <box width={props.width} height={props.height} flexDirection={props.flexDirection ?? 'row'} flexShrink={0} backgroundColor={props.backgroundColor}
    onSizeChange={function(this: BoxRenderable) { setSize({ width: this.width, height: this.height }); }}>
    <text position="absolute" left={0} top={0} selectable={false} wrapMode="none" fg={tone.dim} attributes={TextAttributes.DIM}
      content={props.active ? selectionTextureLayer(size().width, size().height) : ''} />
    {props.children}
  </box>;
}
