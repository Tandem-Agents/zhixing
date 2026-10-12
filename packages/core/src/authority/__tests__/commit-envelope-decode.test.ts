import { describe, expect, it } from 'vitest';
import { canonicalize, protocolDigest } from '../../protocol/canonical.js';
import { decodeCommitEnvelope } from '../commit-log.js';

const encode = (body: unknown, lsn = 1) => {
  const unsigned = { v: 1, at: '2026-10-12T00:00:00.000Z', lsn, entries: [{ stream: 'run:fixture', body }] };
  const envelope = { ...unsigned, envelopeDigest: protocolDigest('CommitEnvelope', 1, unsigned) };
  return { envelope, text: canonicalize(envelope) };
};
describe('canonical commit envelope decoding', () => {
  it('agrees with the protocol encoder across nested values and byte offsets', () => {
    for (let i = 1; i <= 96; i++) {
      const body = { z: [null, true, false, i / 10, -i, '中文🙂\n\t"\\', { '10': i, '2': -i, '𐐀': 'é' }], a: { ['field'+i]: 'x'.repeat(i) } };
      const { envelope, text } = encode(body, i);
      const allocation = Buffer.from('ignored'+text+'ignored');
      expect(decodeCommitEnvelope(allocation.subarray(7, allocation.length-7))).toEqual(envelope);
    }
  });
  it('rejects alternate encodings, duplicate keys and changes retaining the old digest', () => {
    const { text } = encode({ a: 1, unicode: '中文🙂', z: -0 });
    for (const changed of [' '+text, text+'\n', text.replace('"a":1','"a":1,"a":1'), text.replace('"a":1','"a":2'), text.replace('"z":0','"z":-0'), text.replace('中文','\\u4e2d\\u6587'), text.replace('"a":1,"unicode"','"a":1.0,"unicode"')]) {
      expect(() => decodeCommitEnvelope(Buffer.from(changed))).toThrow();
    }
    const parsed = JSON.parse(text); parsed.envelopeDigest = 'sha256:'+'0'.repeat(64);
    expect(() => decodeCommitEnvelope(Buffer.from(canonicalize(parsed)))).toThrow('digest');
  });
  it('enforces the independent body byte bound even with a correct digest', () => {
    const { text } = encode({ body: 'x'.repeat(1024 * 1024 + 1) });
    expect(() => decodeCommitEnvelope(Buffer.from(text))).toThrow('inline limit');
  });
  it('rejects lone UTF-16 units and accessors without invoking them', () => {
    for (const value of ['\ud800', '\udfff', 'a\ud800x', '\udc00\ud800']) {
      expect(() => canonicalize(value)).toThrow('Unicode');
      expect(() => canonicalize({ [value]: 1 })).toThrow('Unicode');
    }
    expect(canonicalize('🙂𐐀')).toBe('"🙂𐐀"');
    let called = false;
    const value = Object.defineProperty({}, 'value', { enumerable: true, get() { called = true; return 1; } });
    expect(() => canonicalize(value)).toThrow('accessor'); expect(called).toBe(false);
  });
});
