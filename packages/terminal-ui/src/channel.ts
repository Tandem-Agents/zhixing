import { TERMINAL_LIMITS, TERMINAL_PROTOCOL, terminalEnvelope, type TerminalEnvelope, type TerminalMessage, type TerminalTraffic } from './protocol.js';

export interface TerminalSender {
  (packet: TerminalEnvelope, done: (error?: Error | null) => void): void;
}

/** Acknowledgement means the bounded receiving surface retained this message.
 * It never acknowledges a domain command or retries an unknown write. */
export class TerminalChannel {
  readonly #pending = new Map<number, { traffic: TerminalTraffic; timer: ReturnType<typeof setTimeout>; resolve(): void; reject(error: Error): void }>();
  #sequence = 0;
  #received = 0;
  #closed = false;
  #failure?: Error;
  #body = 0;
  #control = 0;
  #receiving = 0;
  readonly #receivedWork = new Set<Promise<void>>();

  constructor(
    readonly instance: string,
    readonly sender: TerminalSender,
    readonly receiveMessage: (message: TerminalMessage, traffic: TerminalTraffic) => void | Promise<void>,
    readonly failure: (reason: string) => void,
  ) {}

  get bodyAvailable(): boolean { return !this.#closed && this.#body < TERMINAL_LIMITS.bodyFrames; }

  /** Retain every accepted ACK write, including arrivals during the drain.
   * The empty check and close share one synchronous handoff: no new receive
   * can slip between a completed drain and the caller releasing transport. */
  async closeAfterReceived(): Promise<void> {
    for (;;) {
      if (this.#failure) throw this.#failure;
      if (!this.#receivedWork.size) { this.close(); return; }
      await Promise.all([...this.#receivedWork]);
    }
  }

  send(payload: TerminalMessage, traffic: TerminalTraffic = 'control'): Promise<void> {
    if (this.#closed) return Promise.reject(Error('terminal-channel-closed'));
    const closing = payload.type === 'close' || payload.type === 'exit';
    if (!closing && (traffic === 'body' ? this.#body >= TERMINAL_LIMITS.bodyFrames : this.#control >= TERMINAL_LIMITS.controlFrames)) {
      const reason = `terminal-${traffic}-capacity`;
      if (traffic === 'control') this.#fail(reason);
      return Promise.reject(Error(reason));
    }
    if (closing && this.#pending.size >= TERMINAL_LIMITS.bodyFrames + TERMINAL_LIMITS.controlFrames + 1) return Promise.reject(Error('terminal-close-already-pending'));
    const sequence = ++this.#sequence;
    const packet: TerminalEnvelope = { protocol: TERMINAL_PROTOCOL, instance: this.instance, sequence, traffic, payload };
    if (Buffer.byteLength(JSON.stringify(packet)) > TERMINAL_LIMITS.frameBytes) {
      if (traffic === 'control') this.#fail('terminal-control-frame-too-large');
      return Promise.reject(Error('terminal-frame-too-large'));
    }
    if (traffic === 'body') this.#body++; else this.#control++;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.#fail('terminal-delivery-timeout'), TERMINAL_LIMITS.deliveryTimeoutMs);
      this.#pending.set(sequence, { traffic, timer, resolve, reject });
      try { this.sender(packet, error => { if (error) this.#fail('terminal-send-failed'); }); }
      catch { this.#fail('terminal-send-failed'); }
    });
  }

  accept(value: unknown): void {
    if (this.#closed) return;
    if (!terminalEnvelope(value, this.instance) || Buffer.byteLength(JSON.stringify(value)) > TERMINAL_LIMITS.frameBytes || value.sequence <= this.#received) {
      this.#fail('terminal-invalid-envelope'); return;
    }
    this.#received = value.sequence;
    const message = value.payload;
    if (message.type === 'ack') {
      const pending = this.#pending.get(message.sequence);
      if (!pending) { this.#fail('terminal-unmatched-ack'); return; }
      clearTimeout(pending.timer);
      this.#pending.delete(message.sequence);
      if (pending.traffic === 'body') this.#body--; else this.#control--;
      pending.resolve(); return;
    }
    if (++this.#receiving > TERMINAL_LIMITS.bodyFrames + TERMINAL_LIMITS.controlFrames + 1) {
      this.#fail('terminal-receive-capacity'); return;
    }
    // A forwarder acknowledges only after its next hop acknowledges, keeping
    // the two-hop body window at eight retained batches, not eight per hop.
    const work = Promise.resolve().then(() => this.receiveMessage(message, value.traffic)).then(() => {
      if (this.#closed) throw Error('terminal-channel-closed');
      const packet: TerminalEnvelope = { protocol: TERMINAL_PROTOCOL, instance: this.instance, sequence: ++this.#sequence, traffic: 'control', payload: { type: 'ack', sequence: value.sequence } };
      return new Promise<void>((resolve, reject) => {
        try { this.sender(packet, error => {
          if (error) { this.#fail('terminal-ack-failed'); reject(error); } else resolve();
        }); }
        catch (error) { this.#fail('terminal-ack-failed'); reject(error); }
      });
    }, error => { this.#fail('terminal-receive-failed'); throw error; })
      .finally(() => { this.#receiving--; this.#receivedWork.delete(work); });
    this.#receivedWork.add(work);
    void work.catch(() => {});
  }

  close(reason = 'terminal-channel-closed'): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(Error(reason)); }
    this.#pending.clear(); this.#body = 0; this.#control = 0;
  }

  #fail(reason: string): void {
    if (this.#closed) return;
    this.#failure = Error(reason);
    this.close(reason);
    this.failure(reason);
  }
}
