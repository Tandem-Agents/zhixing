import path from 'node:path';
import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolveCliEntry } from '../cli-entry.js';
import { createTerminalOwnedProcessFactory } from './host-launch.js';

type Create = ReturnType<typeof createTerminalOwnedProcessFactory>;
type Owner = ReturnType<Create>;
export type ClipboardWriteResult = { state: 'copied' | 'provider' | 'unavailable' | 'unknown' };
const LIMIT = 224 * 1024;
const nodeWriter = `const {createRequire}=require('node:module');
const native=createRequire(process.argv[1])(process.argv[1]);let bytes=0,parts=[];
process.stdin.on('data',part=>{bytes+=part.length;if(bytes>229376)process.exit(65);parts.push(part)});
process.stdin.on('end',()=>{const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(parts));parts=[];
if(process.platform==='win32'){process.stdout.write(native.writeClipboard(text)+'\\n');}
else {const window=native.writeXClipboard(Buffer.from(text));process.stdout.write(JSON.stringify({requestId:process.argv[2],window})+'\\n');
if(window>0)setInterval(()=>{if(!native.pollXClipboard())process.exit(0)},10)}});`;

/** S owns every provider and reader. A setup deadline never becomes the
 * lifetime of an accepted Linux selection owner. No detached process exists. */
export class TerminalClipboardWriter {
  #accepted?: ClipboardProcess;
  #pending?: { abort: AbortController; work: Promise<ClipboardWriteResult> };
  #replacing = false;
  constructor(readonly signal: AbortSignal, readonly create: Create, readonly platform: NodeJS.Platform,
    readonly environment: NodeJS.ProcessEnv = process.env, readonly entry = () => resolveCliEntry()) {}

  async write(text: string): Promise<ClipboardWriteResult> {
    this.signal.throwIfAborted();
    if (typeof text !== 'string' || !text || text.includes('\0') || Buffer.byteLength(text) > LIMIT) throw Error('terminal-clipboard-size');
    if (this.#replacing) throw Error('terminal-clipboard-busy');
    const previous = this.#pending;
    if (previous) {
      this.#replacing = true; previous.abort.abort();
      try { await previous.work.catch(() => {}); } finally { this.#replacing = false; }
    }
    this.signal.throwIfAborted();
    const abort = new AbortController();
    const work = this.#write(text, AbortSignal.any([this.signal, abort.signal]));
    const pending = { abort, work }; this.#pending = pending;
    try { return await work; } finally { if (this.#pending === pending) this.#pending = undefined; }
  }

  async close(): Promise<void> {
    this.#pending?.abort.abort();
    await this.#pending?.work.catch(() => {});
    await this.#accepted?.close(); this.#accepted = undefined;
  }

  async #write(text: string, signal: AbortSignal): Promise<ClipboardWriteResult> {
    const env = { ...this.environment };
    if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return { state: 'unavailable' };
    if (this.platform === 'darwin' && (typeof process.getuid !== 'function' || (await stat('/dev/console').catch(() => undefined))?.uid !== process.getuid())) return { state: 'unavailable' };
    if (this.platform === 'darwin') env.LC_CTYPE = 'UTF-8';
    if (this.platform === 'linux' && !env.WAYLAND_DISPLAY && !env.DISPLAY) return { state: 'unavailable' };
    if (this.platform === 'linux' && !env.WAYLAND_DISPLAY && !/^(:\d+(?:\.\d+)?|unix:\d+(?:\.\d+)?)$/u.test(env.DISPLAY ?? '')) return { state: 'unavailable' };
    for (const key of ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
    const deadline = Date.now() + 1500, expiry = new AbortController();
    const combined = AbortSignal.any([signal, expiry.signal]);
    const timer = setTimeout(() => expiry.abort(Error('terminal-clipboard-timeout')), Math.max(0, deadline - Date.now()));
    let candidate: ClipboardProcess | undefined, submitted = false, retained = false;
    try {
      const native = path.join(path.dirname(this.entry()), 'terminal', `${this.platform}-${process.arch}`, 'foreground.node');
      const nonce = randomUUID(), type = `text/plain;charset=utf-8;x-zhixing-copy=${nonce}`;
      const command: [string, string[]] = this.platform === 'win32' ? [process.execPath, ['-e', nodeWriter, native]] :
        this.platform === 'darwin' ? ['/usr/bin/pbcopy', []] : env.WAYLAND_DISPLAY ?
          ['wl-copy', ['--foreground', '--type', type]] : [process.execPath, ['-e', nodeWriter, native, nonce]];
      candidate = new ClipboardProcess(this.create, command, env, deadline, signal, LIMIT);
      const abort = () => candidate?.stop(); combined.addEventListener('abort', abort, { once: true });
      try {
        await candidate.ready;
        combined.throwIfAborted(); submitted = true; candidate.input(text);
        if (this.platform === 'win32' || this.platform === 'darwin') {
          const result = await candidate.result(); combined.throwIfAborted();
          if (result.code !== 0) return { state: 'unknown' };
          if (this.platform === 'darwin') return { state: 'copied' };
          const status = result.text.trim();
          return { state: status === 'accepted' ? 'copied' : status === 'unavailable' ? 'unavailable' : 'unknown' };
        }
        if (env.WAYLAND_DISPLAY) {
          let backoff = 50;
          for (;;) {
            combined.throwIfAborted();
            if (candidate.ended) return { state: 'unknown' };
            // Strict request-specific MIME proves this write, including when
            // the old clipboard happened to contain exactly the same text.
            const reader = new ClipboardProcess(this.create, ['wl-paste', ['--no-newline', '--type', type]], env, deadline, combined, LIMIT);
            let result: Awaited<ReturnType<ClipboardProcess['result']>>;
            try { await reader.ready; combined.throwIfAborted(); reader.input(''); result = await reader.result(); }
            finally { await reader.close(); }
            if (result.code === 0 && result.text === text) break;
            if (candidate.ended) return { state: 'unknown' };
            await delay(Math.min(backoff, Math.max(0, deadline - Date.now())), combined);
            backoff = Math.min(200, backoff * 2);
          }
        } else {
          const ack = JSON.parse(await candidate.line(combined)) as { requestId?: string; window?: number };
          if (ack.requestId === nonce && ack.window === 0) return { state: 'unavailable' };
          if (ack.requestId !== nonce || !Number.isSafeInteger(ack.window) || ack.window! <= 0) return { state: 'unknown' };
        }
        combined.throwIfAborted();
        if (candidate.ended) return { state: 'unknown' };
        clearTimeout(timer); combined.removeEventListener('abort', abort);
        const old = this.#accepted; this.#accepted = candidate; retained = true;
        await old?.close();
        return { state: 'provider' };
      } finally { combined.removeEventListener('abort', abort); }
    } catch (error) {
      signal.throwIfAborted();
      return { state: submitted ? 'unknown' : 'unavailable' };
    } finally { clearTimeout(timer); if (!retained) await candidate?.close(); }
  }
}

class ClipboardProcess {
  readonly owner: Owner;
  readonly ready: Promise<void>;
  readonly #reading: Promise<void>;
  #bytes = 0; #output: Buffer[] = []; #failure?: unknown; #wake?: () => void;
  ended = false;
  constructor(create: Create, command: [string, string[]], env: NodeJS.ProcessEnv, deadline: number, signal: AbortSignal, readonly limit: number) {
    const owner = create(command[0], command[1], { env, deadline, signal });
    this.owner = owner;
    this.ready = this.owner.ready;
    this.owner.child.stderr.on('data', (chunk: Buffer) => chunk.fill(0));
    this.owner.child.on('error', error => { this.#failure = error; this.#wake?.(); });
    void this.owner.closed.then(() => { this.ended = true; this.#wake?.(); }, error => { this.#failure = error; this.ended = true; this.#wake?.(); });
    this.#reading = (async () => {
      for await (const chunk of owner.child.stdout) {
        this.#bytes += chunk.length;
        if (this.#bytes > limit) { chunk.fill(0); throw Error('terminal-clipboard-output-capacity'); }
        this.#output.push(Buffer.from(chunk)); chunk.fill(0); this.#wake?.();
      }
    })().catch(error => { this.#failure = error; this.stop(); this.#wake?.(); });
  }
  input(text: string): void { this.owner.child.stdin.end(text, 'utf8'); }
  stop(): void { if (!this.ended) this.owner.child.kill('SIGTERM'); }
  text(): string { if (this.#failure) throw this.#failure; return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(this.#output)); }
  async result(): Promise<{ code: number | null; text: string }> { const receipt = await this.owner.closed; await this.#reading; return { code: receipt.code, text: this.text() }; }
  async line(signal: AbortSignal): Promise<string> {
    for (;;) {
      signal.throwIfAborted(); const text = this.text();
      if (text.includes('\n')) return text.slice(0, text.indexOf('\n'));
      if (this.ended) throw Error('terminal-clipboard-provider-exited');
      await new Promise<void>(resolve => { const wake = () => { signal.removeEventListener('abort', wake); this.#wake = undefined; resolve(); }; this.#wake = wake; signal.addEventListener('abort', wake, { once: true }); });
    }
  }
  async close(): Promise<void> { this.stop(); await this.owner.closed; await this.#reading; for (const part of this.#output) part.fill(0); this.#output = []; }
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
