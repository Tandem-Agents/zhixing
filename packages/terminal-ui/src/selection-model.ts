/**
 * 选中当前项的呈现规则（纯逻辑，组件见 selection-row.tsx）。普通选项、按钮、候选、技能等凡显示
 * “当前选中项”的行都经由这一对模块：标记、纹理字形与铺设规则只在这里定义，改一处即全部生效。
 */

/** 选中行标记：控制台西文字体（Consolas 等）与中文默认字体里都有的拉丁字符，与未选中的“›”同族 */
export const SELECTED_MARK = '»';

let textureGlyph = '░';
/** 纹理字形按宿主能力定：入口声明 ascii（经典控制台不做字体回退，界面所在备用缓冲区的字体无法事先确认；
 *  或宿主不明），或原生测宽“░”不占 1 列时，退回 ASCII 的“:”（任何字体都有、双排点）；其余用迁移前的“░”。 */
export function configureSelectionTexture(ascii: boolean, measure: (text: string) => number): void {
  textureGlyph = ascii || measure('░') !== 1 ? ':' : '░';
}
export function selectionTextureGlyph(): string {
  return textureGlyph;
}

/** 选中行文字的分段：open 段（两个及以上连续空格）透出下层纹理，其余字与单空格盖住纹理；文字本身不变 */
export function selectionSegments(text: string): { readonly text: string; readonly open: boolean }[] {
  return text.split(/( {2,})/u).filter(Boolean).map(part => ({ text: part, open: / {2,}/u.test(part) }));
}

/** 纹理层内容：只生成行盒的面积（宽 × 高），不扫全屏 */
export function selectionTextureLayer(width: number, height: number): string {
  return width > 0 && height > 0 ? Array.from({ length: height }, () => textureGlyph.repeat(width)).join('\n') : '';
}
