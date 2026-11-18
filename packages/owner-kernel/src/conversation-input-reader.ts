import { isTextFileMaterial, type TextFileMaterial } from '@zhixing-ai/core';
import { artifactJsonIndex, type ArtifactStore } from '@zhixing-ai/core/authority';
import type { UserTurnInput } from '@zhixing-ai/core/contracts';
import type { Stored } from './conversation-run-contracts.js';

export interface InputTextPagePiece {
  readonly text: string;
  readonly part: number;
  readonly offset: number;
  readonly final: boolean;
  readonly emittedPart?: number;
  readonly partOffset?: number;
  readonly partFinal?: boolean;
  readonly material?: TextFileMaterial;
}

/** One input page reads only its selected text range or bounded file material fact, never the complete stored input. */
export async function readInputTextPage(
  store: ArtifactStore,
  input: Stored<UserTurnInput>,
  initialPart: number,
  initialOffset: number,
): Promise<InputTextPagePiece | { preparing: true }> {
  let part = initialPart, offset = initialOffset, text = '';
  let emittedPart: number | undefined, partOffset: number | undefined, partFinal: boolean | undefined, material: TextFileMaterial | undefined;
  const json = artifactJsonIndex(store);
  const ref = 'ref' in input ? input.ref : undefined;
  if (ref && !(await json.prepare(ref)).ready) return { preparing: true };
  const parts = ref ? await json.node(ref, ['parts']) : undefined;
  if (ref && parts?.kind !== 'array') throw Error('conversation-input-parts');
  const count = ref ? parts!.units : (input as UserTurnInput).parts.length;
  if (!Number.isSafeInteger(part) || part < 0 || part > count || !Number.isSafeInteger(offset) || offset < 0) throw Error('conversation-input-cursor');
  let scanned = 0;
  for (; part < count && scanned < 64; scanned++) {
    const inline = ref ? undefined : (input as UserTurnInput).parts[part];
    const type = ref ? await json.value(ref, ['parts', part, 'type'], 128) : inline?.type;
    if (type !== 'text') { part++; offset = 0; continue; }
    const rawMaterial = ref ? await json.value(ref, ['parts', part, 'material'], 1024) : inline?.type === 'text' ? inline.material : undefined;
    if (isTextFileMaterial(rawMaterial)) {
      if (offset > 0) throw Error('conversation-input-offset');
      emittedPart = part; partOffset = 0; partFinal = true; material = rawMaterial;
      part++; offset = 0;
      break;
    }
    const node = ref ? await json.node(ref, ['parts', part, 'text']) : undefined;
    if (ref && node?.kind !== 'string') throw Error('conversation-input-text');
    const value = inline?.type === 'text' ? inline.text : '';
    const length = ref ? node!.units : value.length;
    if (offset > length) throw Error('conversation-input-offset');
    if (offset === length) { part++; offset = 0; continue; }
    emittedPart = part; partOffset = offset;
    if (ref) {
      while (text.length < 8192 && offset + text.length < length) {
        const range = await json.textRange(ref, node!, offset + text.length);
        if (!range.text.length) throw Error('conversation-input-range-did-not-advance');
        text += range.text.slice(0, 8192 - text.length);
      }
    } else text = value.slice(offset, offset + 8192);
    if (offset + text.length < length && /[\uD800-\uDBFF]/u.test(text.at(-1)!)) text = text.slice(0, -1);
    offset += text.length;
    partFinal = offset === length;
    if (partFinal) { part++; offset = 0; }
    break;
  }
  while (partFinal && part < count && scanned < 64) {
    scanned++;
    const nextInline = ref ? undefined : (input as UserTurnInput).parts[part];
    const nextType = ref ? await json.value(ref, ['parts', part, 'type'], 128) : nextInline?.type;
    if (nextType !== 'text') { part++; continue; }
    const nextMaterial = ref ? await json.value(ref, ['parts', part, 'material'], 1024) : nextInline?.type === 'text' ? nextInline.material : undefined;
    if (isTextFileMaterial(nextMaterial)) break;
    const nextNode = ref ? await json.node(ref, ['parts', part, 'text']) : undefined;
    if (ref && nextNode?.kind !== 'string') throw Error('conversation-input-text');
    const nextLength = ref ? nextNode!.units : nextInline?.type === 'text' ? nextInline.text.length : 0;
    if (nextLength === 0) { part++; continue; }
    break;
  }
  return {
    text,
    part,
    offset,
    final: part >= count,
    ...(emittedPart !== undefined
      ? { emittedPart, partOffset: partOffset!, partFinal: partFinal!, ...(material ? { material } : {}) }
      : {}),
  };
}
