/** JSON.stringify's UTF-8 length for a string, including its quotes. Count
 * before allocating an escaped fragment; lone surrogates use six ASCII bytes. */
export function jsonStringBytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit === 34 || unit === 92 || unit === 8 || unit === 9 || unit === 10 || unit === 12 || unit === 13) bytes += 2;
    else if (unit < 32) bytes += 6;
    else if (unit < 128) bytes++;
    else if (unit < 2048) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index++; }
      else bytes += 6;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) bytes += 6;
    else bytes += 3;
  }
  return bytes;
}

export const SESSION_SEND_WIRE_BYTES = 100 * 1024 * 1024;
export const SESSION_SEND_ENVELOPE_BYTES = 4096;
const STRING_UNITS = 8192;

/** Encoder only for session.send's fixed schema. It never creates a complete
 * params string or buffer; native JSON escaping is applied to finite pieces.
 * The sink finishes its actual finite write before the next piece is made. */
export class SessionSendJsonWriter {
  #bytes = 0;
  readonly #page = Buffer.allocUnsafe(32 * 1024);
  #used = 0;
  constructor(readonly write: (bytes: Buffer) => Promise<void>, readonly signal: AbortSignal,
    readonly maximum = SESSION_SEND_WIRE_BYTES - SESSION_SEND_ENVELOPE_BYTES) {}
  get byteLength(): number { return this.#bytes; }
  async finish(): Promise<void> {
    if (!this.#used) return;
    await this.write(this.#page.subarray(0, this.#used)); this.#used = 0;
  }

  async literal(value: string): Promise<void> {
    this.#charge(Buffer.byteLength(value));
    await this.#write(value);
  }
  async string(value: string): Promise<void> {
    await this.literal('"'); await this.stringContent(value); await this.literal('"');
  }
  async stringContent(value: string): Promise<void> {
    for (let offset = 0; offset < value.length;) {
      const end = stringEnd(value, offset);
      const part = value.slice(offset, end);
      this.#charge(jsonStringBytes(part) - 2);
      const quoted = JSON.stringify(part);
      await this.#write(quoted.slice(1, -1));
      offset = end;
    }
  }
  #charge(bytes: number): void {
    this.signal.throwIfAborted();
    if (this.#bytes + bytes > this.maximum) throw Error('输入准备工作区不足，草稿已保留。');
    this.#bytes += bytes;
  }
  async #write(value: string): Promise<void> {
    for (let offset = 0; offset < value.length;) {
      this.signal.throwIfAborted();
      const end = stringEnd(value, offset);
      // At most 8192 UTF-16 units / 24 KiB UTF-8, below the 32 KiB sink page.
      const bytes = Buffer.from(value.slice(offset, end));
      for (let at = 0; at < bytes.length;) {
        const count = Math.min(this.#page.length - this.#used, bytes.length - at);
        bytes.copy(this.#page, this.#used, at, at + count); this.#used += count; at += count;
        if (this.#used === this.#page.length) await this.finish();
      }
      offset = end;
    }
  }
}

function stringEnd(value: string, start: number): number {
  let end = Math.min(value.length, start + STRING_UNITS);
  if (end < value.length && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff &&
    value.charCodeAt(end) >= 0xdc00 && value.charCodeAt(end) <= 0xdfff) end--;
  return end;
}
