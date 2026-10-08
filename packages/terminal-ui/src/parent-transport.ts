import { connect, Socket, type Server } from 'node:net';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { TERMINAL_LIMITS } from './protocol.js';

export function isTerminalPrivateEndpoint(endpoint: string): boolean {
  return process.platform === 'win32' && /^\\\\\.\\pipe\\zhixing-terminal-[a-f0-9-]{36}$/u.test(endpoint);
}

/** Consume only the fixed inherited bootstrap slot for this role. */
export function consumeTerminalParentEndpoint(pipeEnvironment = 'ZHIXING_TERMINAL_PIPE'): string | 3 | 6 | undefined {
  const fdKey = pipeEnvironment.replace(/_PIPE$/u, '_FD');
  const pipe = process.env[pipeEnvironment], fd = process.env[fdKey];
  delete process.env[pipeEnvironment]; delete process.env[fdKey];
  if (process.platform === 'win32') {
    if (fd !== undefined || (pipe !== undefined && !isTerminalPrivateEndpoint(pipe))) throw Error('terminal-parent-endpoint');
    return pipe;
  }
  const expected = pipeEnvironment === 'ZHIXING_HOST_STARTUP_PIPE' ? 6 : 3;
  if (pipe !== undefined || (fd !== undefined && fd !== String(expected))) throw Error('terminal-parent-bootstrap');
  return fd === undefined ? undefined : expected;
}

/** Hands the descriptor to the runtime. Callers must not close the raw number
 * after attempting adoption, including an ambiguous runtime failure. Such a
 * failure closes the owning lifecycle. Bun's fixed raw-FD API differs. */
export function adoptTerminalSocket(fd: number): Socket {
  if (process.platform === 'win32' || !Number.isSafeInteger(fd) || fd < 3) throw Error('terminal-parent-descriptor');
  if ('Bun' in globalThis) {
    const socket = new Socket();
    let failure: Error | undefined;
    const capture = (error: Error) => { failure = error; };
    socket.on('error', capture);
    try {
      socket.connect({ fd, fdIsRawSocket: true } as unknown as Parameters<Socket['connect']>[0]);
      if (failure) throw failure;
    } catch (error) { socket.destroy(); throw error; }
    // Callers install their lifecycle listeners synchronously on return. Bun
    // may report native admission during connect itself, before that return.
    queueMicrotask(() => socket.off('error', capture));
    return socket;
  }
  return new Socket({ fd, readable: true, writable: true });
}

/** Windows named pipe only. POSIX channels have no filesystem endpoint. */
export class TerminalPrivateEndpoint {
  readonly address: string;
  #server?: Server;
  #closed = false;
  #listening?: Promise<void>;
  #closing?: Promise<void>;
  #bound = false;
  #serverClosed?: Promise<void>;
  constructor() {
    const id = randomUUID();
    this.address = process.platform === 'win32' ? `\\\\.\\pipe\\zhixing-terminal-${id}` : '';
  }
  listen(server: Server): Promise<void> {
    if (process.platform !== 'win32' || this.#closed || this.#listening) return Promise.reject(Error('terminal-endpoint-admission-closed'));
    this.#server = server;
    this.#serverClosed = new Promise(resolve => server.once('close', resolve));
    return this.#listening = (async () => {
      if (this.#closed) throw Error('terminal-endpoint-admission-closed');
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.address, () => { this.#bound = true; server.removeListener('error', reject); resolve(); });
      });
      if (this.#closed) throw Error('terminal-endpoint-admission-closed');
    })();
  }
  close(): Promise<void> {
    this.#closed = true;
    return this.#closing ??= (async () => {
      await this.#listening?.catch(() => {});
      if (this.#server?.listening) this.#server.close();
      if (this.#bound) await this.#serverClosed;
    })();
  }
}

/** One bounded receive workspace per connection. Reuse it across frames instead
 * of copying the whole growing prefix for every socket chunk. Parsed objects
 * own their strings; raw bytes are cleared before dispatch, including secrets. */
export class TerminalJsonFrames {
  #buffer = Buffer.alloc(0);
  #used = 0;
  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw Error('terminal-frame-limit');
  }
  clear(): void { this.#buffer.fill(0); this.#used = 0; }
  accept(data: Buffer, receive: (value: unknown) => void): void {
    try {
      for (let offset = 0; offset < data.length;) {
        const newline = data.indexOf(10, offset), end = newline < 0 ? data.length : newline;
        const length = this.#used + end - offset;
        if (length > this.limit) throw Error('terminal-frame-capacity');
        if (length > this.#buffer.length) {
          const next = Buffer.allocUnsafe(Math.min(this.limit, Math.max(length, 4096, this.#buffer.length * 2)));
          this.#buffer.copy(next, 0, 0, this.#used); this.#buffer.fill(0); this.#buffer = next;
        }
        data.copy(this.#buffer, this.#used, offset, end); this.#used = length;
        if (newline < 0) return;
        const value: unknown = JSON.parse(this.#buffer.toString('utf8', 0, length));
        this.#buffer.fill(0, 0, length); this.#used = 0;
        receive(value); offset = end + 1;
      }
    } catch (error) { this.clear(); throw error; }
  }
}

/** Private same-instance connection to S. Does not read terminal input. */
export class TerminalParentTransport extends EventEmitter {
  readonly socket: Socket;
  readonly #frames: TerminalJsonFrames;
  #closed = false;
  constructor(endpoint: string | 3 | 6, readonly frameBytes = TERMINAL_LIMITS.frameBytes) {
    super();
    this.#frames = new TerminalJsonFrames(frameBytes);
    if (typeof endpoint === 'string' ? !isTerminalPrivateEndpoint(endpoint) : ![3, 6].includes(endpoint)) throw Error('terminal-parent-endpoint');
    this.socket = typeof endpoint === 'string' ? connect(endpoint) : adoptTerminalSocket(endpoint);
    this.socket.on('data', data => this.#data(data));
    this.socket.on('error', () => this.#fail());
    this.socket.once('close', () => { this.#closed = true; this.#frames.clear(); this.emit('disconnect'); });
  }
  get connected(): boolean { return !this.#closed; }
  send(message: unknown, done: (error?: Error | null) => void): void {
    const bytes = Buffer.from(JSON.stringify(message) + '\n');
    if (this.#closed || bytes.length > this.frameBytes + 1 || this.socket.writableLength + bytes.length > this.frameBytes * 2) {
      done(Error('terminal-parent-write-capacity')); return;
    }
    this.socket.write(bytes, done);
  }
  close(): void { if (!this.#closed) { this.#closed = true; this.socket.end(); } }
  #data(data: Buffer): void {
    try { this.#frames.accept(data, value => this.emit('message', value)); }
    catch { this.#fail(); }
  }
  #fail(): void { this.#closed = true; this.#frames.clear(); this.socket.destroy(); }
}
