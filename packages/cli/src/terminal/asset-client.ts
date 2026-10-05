import type { TerminalChannel } from '@zhixing/terminal-ui/channel';
import type { TerminalMessage } from '@zhixing/terminal-ui/protocol';

export interface TerminalAssetAccount {
  reserve(bucket: 'display' | 'input', bytes: number): Promise<string>;
  settle(token: string, bytes: number): Promise<void>;
  released(bucket: 'display' | 'input', bytes: number): Promise<void>;
}

/** N can reserve its instance account; it cannot name a filesystem path or
 * another instance. S alone interprets these three finite storage operations. */
export class TerminalAssetClient implements TerminalAssetAccount {
  #id = 0;
  readonly #pending = new Map<number, { resolve(token?: string): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(readonly channel: TerminalChannel, readonly signal: AbortSignal) {
    signal.addEventListener('abort', () => {
      for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(Error('terminal-assets-closed')); }
      this.#pending.clear();
    }, { once: true });
  }
  async reserve(bucket: 'display' | 'input', bytes: number): Promise<string> {
    const token = await this.#request({ kind: 'reserve', bucket, bytes });
    if (!token) throw Error('terminal-assets-no-reservation'); return token;
  }
  async settle(token: string, bytes: number): Promise<void> { await this.#request({ kind: 'settle', token, bytes }); }
  async released(bucket: 'display' | 'input', bytes: number): Promise<void> { await this.#request({ kind: 'released', bucket, bytes }); }
  receive(message: Extract<TerminalMessage, { type: 'assets-result' }>): void {
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id); clearTimeout(pending.timer);
    if (message.failed) pending.reject(Error('terminal-assets-unavailable')); else pending.resolve(message.token);
  }
  #request(operation: Extract<TerminalMessage, { type: 'assets' }>['operation']): Promise<string | undefined> {
    this.signal.throwIfAborted();
    if (this.#pending.size >= 4) return Promise.reject(Error('terminal-assets-request-capacity'));
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(Error('terminal-assets-result-unknown')); }, 5000);
      this.#pending.set(id, { resolve, reject, timer });
      void this.channel.send({ type: 'assets', id, operation }).catch(error => {
        this.#pending.delete(id); clearTimeout(timer); reject(error);
      });
    });
  }
}
