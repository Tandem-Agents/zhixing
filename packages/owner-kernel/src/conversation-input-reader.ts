import { artifactJsonIndex, type ArtifactStore } from '@zhixing/core/authority';
import type { UserTurnInput } from '@zhixing/core/contracts';
import type { Stored } from './conversation-run-contracts.js';

/** One input page reads only its selected text range, never the complete stored input. */
export async function readInputTextPage(store: ArtifactStore, input: Stored<UserTurnInput>, initialPart: number, initialOffset: number): Promise<{ text: string; part: number; offset: number; final: boolean } | { preparing: true }> {
  let part = initialPart, offset = initialOffset, text = '';
  const json = artifactJsonIndex(store);
  const ref = 'ref' in input ? input.ref : undefined;
  if (ref && !(await json.prepare(ref)).ready) return { preparing: true };
  const parts = ref ? await json.node(ref, ['parts']) : undefined;
  if (ref && parts?.kind !== 'array') throw Error('conversation-input-parts');
  const count = ref ? parts!.units : (input as UserTurnInput).parts.length;
  if (!Number.isSafeInteger(part) || part < 0 || part > count || !Number.isSafeInteger(offset) || offset < 0) throw Error('conversation-input-cursor');
  for (let scanned = 0; part < count && scanned < 64; scanned++) {
    const inline = ref ? undefined : (input as UserTurnInput).parts[part];
    const type = ref ? await json.value(ref, ['parts', part, 'type'], 128) : inline?.type;
    if (type !== 'text') { part++; offset = 0; continue; }
    const node = ref ? await json.node(ref, ['parts', part, 'text']) : undefined;
    if (ref && node?.kind !== 'string') throw Error('conversation-input-text');
    const value = inline?.type === 'text' ? inline.text : '';
    const length = ref ? node!.units : value.length;
    if (offset > length) throw Error('conversation-input-offset');
    if (offset === length) { part++; offset = 0; continue; }
    if (ref) {
      while (text.length < 8192 && offset + text.length < length) {
        const range = await json.textRange(ref, node!, offset + text.length);
        if (!range.text.length) throw Error('conversation-input-range-did-not-advance');
        text += range.text.slice(0, 8192 - text.length);
      }
    } else text = value.slice(offset, offset + 8192);
    if (offset + text.length < length && /[\uD800-\uDBFF]/u.test(text.at(-1)!)) text = text.slice(0, -1);
    offset += text.length;
    if (offset === length) { part++; offset = 0; }
    break;
  }
  return { text, part, offset, final: part >= count };
}
