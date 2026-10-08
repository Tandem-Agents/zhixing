import { TERMINAL_LIMITS, TERMINAL_PROTOCOL, terminalEnvelope, type TerminalEnvelope, type TerminalMessage, type TerminalTraffic } from './protocol.js';

export interface TerminalSender {
  (packet: TerminalEnvelope, done: (error?: Error | null) => void): void;
}

interface Delivery {
  readonly payload: TerminalMessage;
  readonly traffic: TerminalTraffic;
  readonly closing: boolean;
  readonly timer: ReturnType<typeof setTimeout>;
  retired?: boolean;
  resolve(): void;
  reject(error: Error): void;
}

/** The surface stopped consuming business traffic. This is not a domain
 * cancellation, transport failure, or proof that any process has exited. */
export class TerminalChannelRetiredError extends Error {
  constructor() { super('terminal-surface-retired'); }
}

/** Acknowledgement means the bounded receiving surface retained this message.
 * It never acknowledges a domain command or retries an unknown write. */
export class TerminalChannel {
  readonly #pending = new Map<number, Delivery>();
  readonly #controlQueue: Delivery[] = [];
  #sequence = 0;
  #received = 0;
  #closed = false;
  #retiring = false;
  #failure?: Error;
  #body = 0;
  #control = 0;
  #closing = false;
  #receiving = 0;
  readonly #receivedWork = new Set<Promise<void>>();

  constructor(
    readonly instance: string,
    readonly sender: TerminalSender,
    readonly receiveMessage: (message: TerminalMessage, traffic: TerminalTraffic) => void | Promise<void>,
    readonly failure: (reason: string) => void,
  ) {}

  get bodyAvailable(): boolean { return !this.#closed && !this.#retiring && this.#body < TERMINAL_LIMITS.bodyFrames; }

  /** Seal ordinary delivery while retaining close/exit and their receipts.
   * Keep the bounded sent identities until ACK/close: a late genuine ACK must
   * remain distinguishable from an unsolicited or duplicated ACK. */
  beginClose(): void {
    if (this.#closed || this.#retiring) return;
    this.#retiring = true;
    const error = new TerminalChannelRetiredError();
    for (const delivery of this.#pending.values()) if (!delivery.closing) {
      delivery.retired = true; clearTimeout(delivery.timer); delivery.reject(error);
    }
    for (const delivery of this.#controlQueue.splice(0)) {
      clearTimeout(delivery.timer); delivery.reject(error);
    }
  }

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
    if (this.#retiring && !closing) return Promise.reject(new TerminalChannelRetiredError());
    // Producers share the same transport window. Waiting for a free slot is
    // normal backpressure, not a failed delivery. Retention remains bounded by
    // the existing request budget, and each retained frame has a byte limit.
    if (!closing && (traffic === 'body' ? this.#body >= TERMINAL_LIMITS.bodyFrames : this.#controlQueue.length >= TERMINAL_LIMITS.pendingRequests)) {
      const reason = `terminal-${traffic}-capacity`;
      if (traffic === 'control') this.#fail(reason);
      return Promise.reject(Error(reason));
    }
    if (closing && this.#closing) return Promise.reject(Error('terminal-close-already-pending'));
    // Snapshot before waiting: callers cannot mutate a retained message beyond
    // its admitted byte budget. Sequence numbers are assigned only on send,
    // so ACKs and reserved close messages can pass queued control messages.
    const encoded = JSON.stringify({ protocol: TERMINAL_PROTOCOL, instance: this.instance, sequence: Number.MAX_SAFE_INTEGER, traffic, payload });
    if (Buffer.byteLength(encoded) > TERMINAL_LIMITS.frameBytes) {
      if (traffic === 'control') this.#fail('terminal-control-frame-too-large');
      return Promise.reject(Error('terminal-frame-too-large'));
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.#fail('terminal-delivery-timeout'), TERMINAL_LIMITS.deliveryTimeoutMs);
      const delivery: Delivery = { payload: (JSON.parse(encoded) as TerminalEnvelope).payload, traffic, closing, timer, resolve, reject };
      if (!closing && traffic === 'control' && (this.#control >= TERMINAL_LIMITS.controlFrames || this.#controlQueue.length)) this.#controlQueue.push(delivery);
      else this.#send(delivery);
    });
  }

  #send(delivery: Delivery): void {
    const sequence = ++this.#sequence;
    if (delivery.closing) this.#closing = true;
    else if (delivery.traffic === 'body') this.#body++;
    else this.#control++;
    this.#pending.set(sequence, delivery);
    const packet: TerminalEnvelope = { protocol: TERMINAL_PROTOCOL, instance: this.instance, sequence, traffic: delivery.traffic, payload: delivery.payload };
    try { this.sender(packet, error => { if (error && !delivery.retired) this.#fail('terminal-send-failed'); }); }
    catch { this.#fail('terminal-send-failed'); }
  }

  #flushControl(): void {
    while (!this.#closed && !this.#retiring && this.#control < TERMINAL_LIMITS.controlFrames && this.#controlQueue.length) this.#send(this.#controlQueue.shift()!);
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
      if (pending.closing) this.#closing = false;
      else if (pending.traffic === 'body') this.#body--;
      else this.#control--;
      this.#flushControl();
      pending.resolve(); return;
    }
    const closing = message.type === 'close' || message.type === 'exit';
    if (this.#retiring && !closing) return;
    if (++this.#receiving > TERMINAL_LIMITS.bodyFrames + TERMINAL_LIMITS.controlFrames + 1) {
      this.#fail('terminal-receive-capacity'); return;
    }
    // A forwarder acknowledges only after its next hop acknowledges, keeping
    // the two-hop body window at eight retained batches, not eight per hop.
    const retired = () => this.#retiring && !closing;
    const work = Promise.resolve().then(() => {
      if (!retired()) return this.receiveMessage(message, value.traffic);
    }).catch(error => {
      if (retired() && error instanceof TerminalChannelRetiredError) return;
      this.#fail('terminal-receive-failed'); throw error;
    }).then(() => {
      if (retired()) return;
      if (this.#closed) throw Error('terminal-channel-closed');
      const packet: TerminalEnvelope = { protocol: TERMINAL_PROTOCOL, instance: this.instance, sequence: ++this.#sequence, traffic: 'control', payload: { type: 'ack', sequence: value.sequence } };
      return new Promise<void>((resolve, reject) => {
        try { this.sender(packet, error => {
          if (error && !retired()) { this.#fail('terminal-ack-failed'); reject(error); } else resolve();
        }); }
        catch (error) { this.#fail('terminal-ack-failed'); reject(error); }
      });
    })
      .finally(() => { this.#receiving--; this.#receivedWork.delete(work); });
    this.#receivedWork.add(work);
    void work.catch(() => {});
  }

  close(reason = 'terminal-channel-closed'): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(Error(reason)); }
    for (const waiting of this.#controlQueue) { clearTimeout(waiting.timer); waiting.reject(Error(reason)); }
    this.#pending.clear(); this.#controlQueue.length = 0; this.#body = 0; this.#control = 0; this.#closing = false;
  }

  #fail(reason: string): void {
    if (this.#closed) return;
    this.#failure = Error(reason);
    this.close(reason);
    this.failure(reason);
  }
}
