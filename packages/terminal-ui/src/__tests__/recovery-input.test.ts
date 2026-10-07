import { describe, expect, it } from 'vitest';
import { RECOVERY_INPUT_BYTES, RECOVERY_INPUT_PART_BYTES, RecoveryInputBuffer, RecoveryInputReceiver } from '../recovery-input.js';

describe('dedicated recovery input', () => {
  it('accepts exactly the existing 16 MiB encoded input bound and clears after consumption', () => {
    const input = new RecoveryInputBuffer(), part = new Uint8Array(RECOVERY_INPUT_PART_BYTES).fill(65);
    for (let offset = 0; offset < RECOVERY_INPUT_BYTES; offset += part.length) input.append(part);
    expect(input.length).toBe(RECOVERY_INPUT_BYTES);
    expect(input.consume().length).toBe(RECOVERY_INPUT_BYTES);
    expect(input.length).toBe(0);
    expect(() => input.append(part)).toThrow('已关闭');
  });
  it('rejects overflow and revokes the retained material instead of truncating it', () => {
    const input = new RecoveryInputBuffer(), part = new Uint8Array(RECOVERY_INPUT_PART_BYTES).fill(65);
    for (let offset = 0; offset < RECOVERY_INPUT_BYTES; offset += part.length) input.append(part);
    expect(() => input.append(new Uint8Array([66]))).toThrow('超过');
    expect(input.length).toBe(0);
    expect(() => input.consume()).toThrow('已关闭');
  });
  it('preserves UTF-8 split across wire parts and erases a full last code point', () => {
    const receiver = new RecoveryInputReceiver('request');
    const bytes = new TextEncoder().encode('中文🙂');
    expect(receiver.accept('request', 0, Buffer.from(bytes.subarray(0, 7)).toString('base64'), false)).toBeUndefined();
    expect(receiver.accept('request', 1, Buffer.from(bytes.subarray(7)).toString('base64'), true)).toBe('中文🙂');
    const input = new RecoveryInputBuffer(); input.append(bytes); input.backspace();
    expect(input.consume()).toBe('中文');
  });
  it.each(['stale-request', 'wrong-index', 'after-cancel', 'invalid-base64'])('rejects %s without retaining old material', reason => {
    const receiver = new RecoveryInputReceiver('request');
    receiver.accept('request', 0, 'QQ==', false);
    if (reason === 'after-cancel') receiver.close();
    expect(() => receiver.accept(reason === 'stale-request' ? 'previous' : 'request', reason === 'wrong-index' ? 4 : 1,
      reason === 'invalid-base64' ? '<private-invalid>' : 'Qg==', true)).toThrow();
    expect(() => receiver.accept('request', 1, 'Qg==', true)).toThrow('已关闭');
  });
  it('does not treat the final part as confirmation of the original recovery material', () => {
    const receiver = new RecoveryInputReceiver('request');
    // This is deliberately not a recovery package. The original Mesh decoder decides validity.
    expect(receiver.accept('request', 0, 'bm90LWEtcmVjb3ZlcnktcGFja2FnZQ==', true)).toBe('not-a-recovery-package');
  });
});
