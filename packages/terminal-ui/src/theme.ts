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
  dangerBackground: RGBA.fromIndex(52),
  codeKeyword: RGBA.fromIndex(5),
  codeString: RGBA.fromIndex(2),
  codeNumber: RGBA.fromIndex(3),
  codeFunction: RGBA.fromIndex(6),
  codeType: RGBA.fromIndex(3),
} as const;

export const spacing = { content: 2, marker: 4, nested: 2, frame: 0, frameInner: 1, welcomeInner: 3 } as const;
