import { createHash, type Hash } from 'node:crypto';
import type { Message } from '@zhixing/core/types';

const STRIDE = Math.floor(32 * 1024 / 3);

/** An observed run needs only prefix identity, never another retained copy of
 * its full output. Hash code units so split surrogate pairs compare exactly as
 * the original JavaScript startsWith contract, independently of event splits. */
export class ObservedTextPrefix {
  #hash: Hash = createHash('sha256');
  #units = 0;
  append(text: string): void {
    for (let at = 0; at < text.length; at += STRIDE) this.#hash.update(Buffer.from(text.slice(at, at + STRIDE), 'utf16le'));
    this.#units += text.length;
  }
  reset(): void { this.#hash = createHash('sha256'); this.#units = 0; }
  /** Validate an already displayed prefix and replay its suffix using bounded
   * source pages. The producer can be reopened without retaining its body. */
  async *remainingStream(source: () => AsyncIterable<string>): AsyncGenerator<string> {
    let remaining = this.#units;
    const hash = createHash('sha256');
    if (remaining) {
      for await (const text of source()) {
        const count = Math.min(remaining, text.length);
        hash.update(Buffer.from(text.slice(0, count), 'utf16le')); remaining -= count;
        if (!remaining) break;
      }
      if (remaining || hash.digest('hex') !== this.#hash.copy().digest('hex')) this.reset();
    }
    let skip = this.#units;
    for await (const text of source()) {
      const count = Math.min(skip, text.length); skip -= count;
      for (let at = count; at < text.length;) {
        let end = Math.min(text.length, at + STRIDE);
        if (end < text.length && isHigh(text.charCodeAt(end - 1)) && isLow(text.charCodeAt(end))) end--;
        yield text.slice(at, end); at = end;
      }
    }
  }
  /** Final recovery can resume after an acknowledged fragment without keeping
   * the decoded history page. A mismatching live prefix starts a new prefix. */
  align(message: Message | undefined): void { if (!this.#matches(message)) this.reset(); }

  *remaining(message: Message | undefined): Generator<string> {
    let skip = this.#matches(message) ? this.#units : 0;
    let batch = '';
    for (const text of parts(message)) {
      const start = Math.min(skip, text.length); skip -= start;
      for (let at = start; at < text.length;) {
        let end = Math.min(text.length, at + STRIDE - batch.length);
        if (end < text.length && end > at && isHigh(text.charCodeAt(end - 1)) && isLow(text.charCodeAt(end))) end--;
        if (end === at) { yield batch; batch = ''; continue; }
        batch += text.slice(at, end); at = end;
        if (batch.length >= STRIDE - 1) { yield batch; batch = ''; }
      }
    }
    if (batch) yield batch;
  }

  #matches(message: Message | undefined): boolean {
    if (!this.#units) return true;
    const hash = createHash('sha256'); let remaining = this.#units;
    for (const text of parts(message)) {
      for (let at = 0; at < text.length && remaining;) {
        const count = Math.min(STRIDE, text.length - at, remaining);
        hash.update(Buffer.from(text.slice(at, at + count), 'utf16le')); at += count; remaining -= count;
      }
      if (!remaining) return hash.digest('hex') === this.#hash.copy().digest('hex');
    }
    return false;
  }
}

function* parts(message: Message | undefined): Generator<string> {
  let first = true;
  for (const block of message?.content ?? []) if (block.type === 'text') {
    if (!first) yield '\n'; first = false; yield block.text;
  }
}
const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;
