import { artifactJsonIndex, type ArtifactStore } from '@zhixing/core/authority';
import type { ArtifactRef, TranscriptRunRecord } from '@zhixing/core/contracts';
import type { Message } from '@zhixing/core';
import { byteDigest, canonicalize, validateMessage, validateTranscriptRunRecord } from '@zhixing/core/protocol';

type Keys = readonly (string | number)[];
/** This is explicitly a replay projection, never a transcript/message value.
 * Body strings remain in CAS. Schema and canonical-byte verification still
 * cover every message; identified inputs bind to the actual admitted content. */
export interface ConversationReplayRecord {
  readonly metadata: Omit<TranscriptRunRecord, 'messages'>;
  readonly references: ArtifactRef[];
}
export async function readConversationReplayRecord(artifacts: ArtifactStore, ref: ArtifactRef, runId: string,
  expectedInputs: readonly Message[] | undefined): Promise<ConversationReplayRecord | undefined> {
  const index = artifactJsonIndex(artifacts);
  while (!(await index.prepare(ref)).ready) await new Promise<void>(setImmediate);
  if (!await index.canonical(ref)) throw Error('Transcript run record artifact is not canonical');
  // Product continuations need their result text. Keep that existing full
  // semantic path; ordinary local replay has no consumer of historical body.
  if (await index.node(ref, ['postTurnControl']) || await index.node(ref, ['worksceneContinuation'])) return undefined;
  const value = (keys: Keys, maximum = 32 * 1024) => index.value(ref, keys, maximum);
  const fields = async (keys: Keys, allowed: readonly string[]) => {
    const node = await index.node(ref, keys);
    if (node?.kind !== 'object' || node.units > allowed.length) throw Error('Transcript object schema is invalid');
    const children = await index.children(ref, node, -1, Math.max(1, allowed.length + 1));
    if (children.some(child => !allowed.includes(child.field))) throw Error('Transcript object has unknown fields');
    return children;
  };
  const strings = async (keys: Keys, names: readonly string[]) => {
    const result: Record<string, unknown> = {};
    for (const node of await fields(keys, names)) {
      if (node.kind !== 'string') throw Error('Transcript content must be a string');
      result[node.field] = '';
    }
    return result;
  };
  const metadata: Record<string, unknown> = {};
  for (const node of await fields([], ['advancement', 'messages', 'perspectives', 'postTurnControl', 'worksceneContinuation', 'runId', 'runIndex', 'source', 'timestamp', 'type', 'usage']))
    if (node.field !== 'messages') metadata[node.field] = await value([node.field]);
  // Validate the metadata through its one existing closed schema. The small
  // validation witness is not returned, stored, or published as a user message.
  validateTranscriptRunRecord({ ...metadata, messages: [{ role: 'user', content: [] }] } as TranscriptRunRecord, runId);
  const messages = await index.node(ref, ['messages']);
  if (messages?.kind !== 'array' || !messages.units) throw Error('Transcript run messages are invalid');
  let identified = 0;
  for (let m = 0; m < messages.units; m++) {
    const keys: Keys = ['messages', m];
    await fields(keys, ['content', 'role', 'inputIdentity']);
    const role = await value([...keys, 'role'], 128), identity = await value([...keys, 'inputIdentity']);
    if (m === 0 && role !== 'user') throw Error('Transcript run must begin with the originating user message');
    const base = { role, ...(identity !== undefined ? { inputIdentity: identity } : {}) };
    validateMessage({ ...base, content: [] });
    const content = await index.node(ref, [...keys, 'content']);
    if (content?.kind !== 'array') throw Error('Transcript message content is invalid');
    for (let b = 0; b < content.units; b++) {
      const blockKeys = [...keys, 'content', b], type = await value([...blockKeys, 'type'], 128);
      const allowed = type === 'text' ? ['type', 'text'] : type === 'thinking' ? ['type', 'thinking', 'signature'] :
        type === 'tool_result' ? ['type', 'content', 'toolUseId', 'isError'] : type === 'tool_use' ? ['type', 'id', 'name', 'input'] :
        type === 'image' ? ['type', 'source'] : [];
      const block: Record<string, unknown> = {};
      for (const node of await fields(blockKeys, allowed)) {
        if (['text', 'thinking', 'signature', 'content'].includes(node.field)) {
          if (node.kind !== 'string') throw Error('Transcript content must be a string');
          block[node.field] = '';
        } else if (type === 'tool_use' && node.field === 'input') {
          if (node.kind !== 'object') throw Error('Transcript tool input must be an object');
          block.input = {}; // The canonical index has verified this entire JSON subtree.
        } else if (type === 'image' && node.field === 'source') {
          const sourceKeys = [...blockKeys, 'source'], sourceType = await value([...sourceKeys, 'type'], 128);
          block.source = { ...await strings(sourceKeys, sourceType === 'base64' ? ['type', 'mediaType', 'data'] : ['type', 'url']), type: sourceType };
        } else block[node.field] = await value([...blockKeys, node.field], 4096);
      }
      validateMessage({ ...base, content: [block] });
      if (b % 64 === 0) await new Promise<void>(setImmediate);
    }
    if (identity !== undefined && expectedInputs !== undefined) {
      const expected = expectedInputs[identified++], node = await index.node(ref, keys);
      if (!expected || !node || await index.digestRange(ref, node) !== byteDigest(Buffer.from(canonicalize(expected))))
        throw Error('Run record does not match admitted and consumed message identities/content');
    }
    await new Promise<void>(setImmediate);
  }
  if (expectedInputs !== undefined && identified !== expectedInputs.length) throw Error('Run record is missing an admitted input');
  const references = await index.references(ref); await index.assertCurrent(ref);
  return { metadata: metadata as unknown as Omit<TranscriptRunRecord, 'messages'>, references };
}
