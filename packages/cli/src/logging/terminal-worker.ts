import { EventEmitter } from 'node:events';
import { serialize, deserialize } from 'node:v8';
import type { Readable, Writable } from 'node:stream';
import { createTerminalOwnedProcessFactory } from '../terminal/host-launch.js';
import { LOG_STORE_FRAME_BYTES } from './store-process.js';

/** The logging workers previously used Node's advanced IPC serialization.
 * Preserve its binary values on their existing private stdio, with one finite
 * frame receiver. No terminal, user data, or public endpoint is involved. */
export class LogWorkerChannel extends EventEmitter {
  #closed = false;
  readonly #header = Buffer.alloc(4);
  #headerBytes = 0;
  #body?: Buffer;
  #bodyBytes = 0;
  #queuedBytes = 0;
  constructor(readonly input: Readable, readonly output: Writable, readonly limit = LOG_STORE_FRAME_BYTES) {
    super();
    input.on('data', (chunk: Buffer) => this.#read(chunk));
    input.once('end', () => this.#disconnect());
    input.once('close', () => this.#disconnect());
    input.on('error', error => this.#fail(error));
    output.on('error', error => this.#fail(error));
  }
  get connected(): boolean { return !this.#closed; }
  send(message: unknown, done: (error?: Error | null) => void): void {
    if (this.#closed) { done(Error('log-worker-channel-closed')); return; }
    let bytes: Buffer;
    try { bytes = serialize(message); } catch (error) { done(error as Error); return; }
    if (bytes.length > this.limit || this.#queuedBytes + bytes.length + 4 > 2 * (this.limit + 4)) {
      done(Error('log-worker-frame-capacity')); return;
    }
    const frame = Buffer.allocUnsafe(bytes.length + 4);
    frame.writeUInt32BE(bytes.length); bytes.copy(frame, 4);
    this.#queuedBytes += frame.length;
    let settled = false;
    const finish = (error?: Error | null): void => {
      if (settled) return; settled = true; this.#queuedBytes -= frame.length; done(error);
    };
    try { this.output.write(frame, finish); } catch (error) { finish(error as Error); }
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true; this.#body = undefined;
    this.input.destroy(); this.output.end();
  }
  #disconnect(): void {
    if (this.#closed) return;
    this.#closed = true; this.#body = undefined; this.emit('disconnect');
  }
  #fail(error: Error): void {
    if (this.#closed) return;
    this.emit('error', error); this.#disconnect(); this.input.destroy(); this.output.destroy();
  }
  #read(chunk: Buffer): void {
    try {
      for (let offset = 0; offset < chunk.length && !this.#closed;) {
        if (!this.#body) {
          const size = Math.min(4 - this.#headerBytes, chunk.length - offset);
          chunk.copy(this.#header, this.#headerBytes, offset, offset + size);
          this.#headerBytes += size; offset += size;
          if (this.#headerBytes < 4) continue;
          const length = this.#header.readUInt32BE(0); this.#headerBytes = 0;
          if (!length || length > this.limit) throw Error('log-worker-frame-capacity');
          this.#body = Buffer.allocUnsafe(length); this.#bodyBytes = 0;
        }
        const size = Math.min(this.#body.length - this.#bodyBytes, chunk.length - offset);
        chunk.copy(this.#body, this.#bodyBytes, offset, offset + size);
        this.#bodyBytes += size; offset += size;
        if (this.#bodyBytes === this.#body.length) {
          const frame = this.#body; this.#body = undefined; this.#bodyBytes = 0;
          this.emit('message', deserialize(frame));
        }
      }
    } catch (error) { this.#fail(error as Error); }
  }
}

export function consumeLogWorkerStdio(): LogWorkerChannel | undefined {
  const value = process.env.ZHIXING_LOG_WORKER_STDIO;
  delete process.env.ZHIXING_LOG_WORKER_STDIO;
  if (value === undefined) return undefined;
  if (value !== '1') throw Error('log-worker-channel-mode');
  return new LogWorkerChannel(process.stdin, process.stdout);
}

export function createTerminalLogWorker(role: 'log-store' | 'log-files', args: readonly string[], signal?: AbortSignal) {
  const owner = createTerminalOwnedProcessFactory(role)(process.execPath, args, {
    env: { ...process.env, ZHIXING_LOG_WORKER_STDIO: '1' }, signal, deadline: Date.now() + 5000,
  });
  const channel = new LogWorkerChannel(owner.child.stdout, owner.child.stdin);
  let ready = false, ended = false;
  const worker = Object.assign(new EventEmitter(), {
    connected: false,
    send: (message: unknown, done: (error?: Error | null) => void) => channel.send(message, done),
    kill: () => owner.child.kill('SIGTERM'),
    ref: () => owner.child.ref(), unref: () => owner.child.unref(),
  });
  // connected follows private readiness, not construction of the wrapper.
  Object.defineProperty(worker, 'connected', { get: () => ready && !ended && channel.connected });
  channel.on('message', message => worker.emit('message', message));
  channel.on('error', error => { worker.emit('error', error); owner.child.kill('SIGTERM'); });
  channel.once('disconnect', () => { if (!ended) owner.child.kill('SIGTERM'); });
  owner.child.on('error', error => worker.emit('error', error));
  owner.child.stderr.resume();
  const started = owner.ready.then(() => { ready = true; });
  void started.catch(() => {});
  void owner.closed.then(result => {
    ended = true; channel.close(); worker.emit('close', result.code, result.signal);
  }, error => {
    ended = true; channel.close(); worker.emit('completion-unknown', error);
  });
  return { worker, ready: started };
}

export async function runTerminalLogObserver(command: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
  const deadline = Date.now() + 2500;
  const owner = createTerminalOwnedProcessFactory('writer-observer')(command, args, { env, signal, deadline });
  const chunks: Buffer[] = [];
  let bytes = 0, failed = false;
  const fail = (): void => { failed = true; owner.child.kill('SIGTERM'); };
  owner.child.on('error', fail);
  owner.child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 256 * 1024 || failed) fail(); else chunks.push(chunk);
  });
  owner.child.stderr.resume();
  const timer = setTimeout(fail, Math.max(1, deadline - Date.now()));
  try {
    try { await owner.ready; owner.child.stdin.end(); } catch { fail(); }
    const result = await owner.closed;
    if (failed || signal?.aborted || result.code !== 0) throw Error('log-writer-observer-unavailable');
    return Buffer.concat(chunks).toString('utf8');
  } finally { clearTimeout(timer); }
}
