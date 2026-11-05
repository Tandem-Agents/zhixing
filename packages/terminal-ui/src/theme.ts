import { RGBA } from '@opentui/core';

/** Same semantic ANSI palette as the original terminal; the host owns its colors. */
export const tone = {
  brand: RGBA.fromIndex(6),
  text: RGBA.defaultForeground(),
  dim: RGBA.fromIndex(8),
  border: RGBA.fromIndex(8),
  success: RGBA.fromIndex(2),
  warn: RGBA.fromIndex(3),
  error: RGBA.fromIndex(1),
  history: RGBA.fromIndex(236),
  selected: RGBA.fromIndex(236),
  selectionFg: RGBA.fromHex('#111111'),
  selectionBg: RGBA.fromHex('#b9d9ee'),
  dangerBackground: RGBA.fromIndex(52),
  codeKeyword: RGBA.fromIndex(5),
  codeString: RGBA.fromIndex(2),
  codeNumber: RGBA.fromIndex(3),
  codeFunction: RGBA.fromIndex(6),
  codeType: RGBA.fromIndex(3),
  // 正文阅读语义：层级与重点以颜色为主通道（终端里中文粗体几乎不改变字重），取 ANSI 语义位，随宿主明暗配色
  heading: RGBA.fromIndex(6),
  // 固定深灰底（history，256 色 236）上的文字取固定浅灰，不随宿主明暗：浅色背景下宿主默认前景是深色，压在深灰底上读不清
  shadeText: RGBA.fromIndex(252),
  strong: RGBA.fromIndex(3),
  tableFrame: RGBA.fromIndex(8),
  tableHeader: RGBA.fromIndex(6),
  listMarker: RGBA.fromIndex(6),
  rule: RGBA.fromIndex(8),
} as const;

export const spacing = { content: 2, marker: 3, userInner: 2, scrollbar: 1, nested: 2, frame: 1, frameInner: 1, welcomeInner: 3 } as const;

/** All frames are measured against the same addressable terminal grid. */
export function surfaceGeometry(columns: number) {
  const margin = columns >= 10 ? spacing.frame : 0;
  const frameWidth = Math.max(1, columns - 2 * margin);
  return { margin, frameWidth, editorWidth: Math.max(1, frameWidth - 2 - 2 * spacing.frameInner - 2) };
}
