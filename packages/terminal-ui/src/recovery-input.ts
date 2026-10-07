/** Recovery material stays in this one volatile buffer, never in draft/history files. */
export const RECOVERY_INPUT_BYTES = 16 * 1024 * 1024;
export const RECOVERY_INPUT_PART_BYTES = 32 * 1024;

export class RecoveryInputBuffer {
  #buffer = new Uint8Array(RECOVERY_INPUT_BYTES);
  #length = 0;
  #closed = false;
  get length(): number { return this.#length; }
  append(bytes: Uint8Array): void {
    if (this.#closed) throw Error('保密输入已关闭。');
    if (bytes.byteLength > RECOVERY_INPUT_PART_BYTES || this.#length + bytes.byteLength > RECOVERY_INPUT_BYTES) {
      this.close(); throw Error('恢复包超过允许长度。');
    }
    this.#buffer.set(bytes, this.#length); this.#length += bytes.byteLength;
  }
  backspace(): void {
    if (this.#closed || !this.#length) return;
    let start = this.#length - 1;
    while (start > 0 && (this.#buffer[start]! & 0xc0) === 0x80) start--;
    this.#buffer.fill(0, start, this.#length); this.#length = start;
  }
  /** Copy one finite encoded part; the caller clears it after the ACK. */
  part(offset: number): Uint8Array {
    if (this.#closed || !Number.isSafeInteger(offset) || offset < 0 || offset > this.#length) throw Error('保密输入片段无效。');
    return this.#buffer.slice(offset, Math.min(offset + RECOVERY_INPUT_PART_BYTES, this.#length));
  }
  /** Only N's original decode/readback owner receives the complete string. */
  consume(): string {
    if (this.#closed) throw Error('保密输入已关闭。');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(this.#buffer.subarray(0, this.#length)); }
    catch { throw Error('恢复包输入编码无效。'); }
    finally { this.close(); }
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true; this.#buffer.fill(0); this.#buffer = new Uint8Array(0); this.#length = 0;
  }
}

/** N admits one request-bound, consecutive stream after the user's submit intent. */
export class RecoveryInputReceiver {
  readonly #buffer = new RecoveryInputBuffer();
  #next = 0;
  #closed = false;
  constructor(readonly requestId: string) {}
  accept(requestId: string, index: number, encoded: string, final: boolean): string | undefined {
    if (this.#closed) throw Error('保密输入已关闭。');
    let bytes: Uint8Array | undefined;
    try {
      if (requestId !== this.requestId || !Number.isSafeInteger(index) || index !== this.#next || index > RECOVERY_INPUT_BYTES / RECOVERY_INPUT_PART_BYTES ||
          typeof encoded !== 'string' || encoded.length > Math.ceil(RECOVERY_INPUT_PART_BYTES / 3) * 4 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded) ||
          typeof final !== 'boolean' || (!final && !encoded.length)) throw Error('保密输入片段已失效。');
      // The wire representation is fixed base64, so UTF-8 boundaries may cross parts.
      const binary = atob(encoded);
      bytes = Uint8Array.from(binary, value => value.charCodeAt(0));
      this.#buffer.append(bytes); this.#next++;
      if (!final) return;
      this.#closed = true; return this.#buffer.consume();
    } catch (error) { this.close(); throw error; }
    finally { bytes?.fill(0); }
  }
  close(): void { this.#closed = true; this.#buffer.close(); }
}
