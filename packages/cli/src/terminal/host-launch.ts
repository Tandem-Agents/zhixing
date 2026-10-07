import { EventEmitter } from 'node:events';
import { createServer, connect, type Socket, type Server } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { closeSync } from 'node:fs';
import type { TerminalChannel } from '@zhixing/terminal-ui/channel';
import type { TerminalMessage } from '@zhixing/terminal-ui/protocol';
import { adoptTerminalSocket, TerminalPrivateEndpoint, isTerminalPrivateEndpoint } from '@zhixing/terminal-ui/parent-transport';
import { PassThrough } from 'node:stream';
import type { DaemonChild } from '../serve/daemon.js';

/** The existing N daemon owner receives only its original launch-plan channel.
 * S receives fixed creation metadata, never this channel's business payload. */
export class TerminalHostLauncher {
  readonly #children = new Map<string, AutomaticChild>();
  constructor(readonly channel: Pick<TerminalChannel, 'send'>) {}
  readonly start = async (handoff: string, deadline: number, signal?: AbortSignal): Promise<DaemonChild> => {
    signal?.throwIfAborted();
    if (this.#children.size >= 4 || Date.now() >= deadline) throw Error('terminal-host-start-capacity');
    const id = randomUUID();
    const child = new AutomaticChild(() => {
      this.#children.delete(id); void this.channel.send({ type: 'host-release', id }).catch(() => {});
    });
    this.#children.set(id, child);
    try {
      if (process.platform === 'win32') {
        await child.listen();
        await this.channel.send({ type: 'host-start', id, endpoint: child.endpoint, handoff, deadline });
      } else {
        child.inherit(id);
        await this.channel.send({ type: 'host-start', id, channel: 'posix', handoff, deadline });
      }
      await child.created(deadline, signal);
      return child;
    } catch (error) { child.disconnect(); throw error; }
  };
  accept(message: Extract<TerminalMessage, { type: 'host-state' }>): void { this.#children.get(message.id)?.state(message); }
  close(): void { for (const child of [...this.#children.values()]) child.disconnect(); }
}

class AutomaticChild extends EventEmitter {
  pid?: number;
  connected = true;
  readonly #endpoint = new TerminalPrivateEndpoint();
  get endpoint(): string { return this.#endpoint.address; }
  readonly #server: Server;
  #socket?: Socket;
  #buffer = '';
  #plan?: { type: 'host-launch-plan'; mode: 'managed' | 'on-demand' | 'none' };
  #exited?: number;
  #failure = false;
  constructor(readonly release: () => void) {
    super();
    this.#server = createServer(socket => {
      if (!this.connected || this.#socket) { socket.destroy(); return; }
      this.#server.close(); this.#attach(socket);
    });
  }
  #attach(socket: Socket): void {
      this.#socket = socket;
      socket.on('error', () => {});
      socket.on('data', data => {
        if (this.#plan || Buffer.byteLength(this.#buffer) + data.length > 1024) { socket.destroy(); return; }
        this.#buffer += data.toString('utf8');
        const end = this.#buffer.indexOf('\n'); if (end < 0) return;
        try {
          const value = JSON.parse(this.#buffer.slice(0, end)); this.#buffer = '';
          if (Object.keys(value).length !== 2 || value.type !== 'host-launch-plan' || !['managed', 'on-demand', 'none'].includes(value.mode)) throw Error('plan');
          this.#plan = value; this.emit('message', value);
        } catch { socket.destroy(); }
      });
  }
  inherit(ticket: string): void {
    posixOwner().register(ticket, 1, sockets => {
      if (!this.connected) { for (const socket of sockets) socket.destroy(); return; }
      this.#attach(sockets[0]!);
    }, value => {
      if (value.event !== 'channels-closed') throw Error('terminal-host-channel-protocol');
      posixOwner().remove(ticket);
    }, () => { this.#failure = true; this.emit('failed'); this.disconnect(); });
  }
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    if (event === 'message' && this.#plan) queueMicrotask(() => { if (this.rawListeners(event).includes(listener)) listener(this.#plan); });
    if (event === 'exit' && this.#exited !== undefined) queueMicrotask(() => { if (this.rawListeners(event).includes(listener)) listener(this.#exited, null); });
    if (event === 'error' && this.#failure) queueMicrotask(() => { if (this.rawListeners(event).includes(listener)) listener(Error('terminal-host-create-failed')); });
    return this;
  }
  async listen(): Promise<void> {
    await this.#endpoint.listen(this.#server);
    this.#server.on('error', () => this.disconnect());
  }
  state(value: Extract<TerminalMessage, { type: 'host-state' }>): void {
    if (value.state === 'created' && value.pid) { this.pid = value.pid; this.emit('created'); }
    else if (value.state === 'failed') { this.#failure = true; this.emit('failed'); if (this.listenerCount('error')) this.emit('error', Error('terminal-host-create-failed')); }
    else if (value.state === 'exited') { this.#exited = value.code ?? 1; this.emit('exit', this.#exited, null); }
  }
  created(deadline: number, signal?: AbortSignal): Promise<void> {
    if (this.#failure || !this.connected) return Promise.reject(Error('terminal-host-create-failed'));
    if (this.pid) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.off('created', done); this.off('failed', fail); signal?.removeEventListener('abort', fail); };
      const done = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(Error('terminal-host-create-unconfirmed')); };
      const timer = setTimeout(fail, Math.max(0, deadline - Date.now()));
      this.once('created', done); this.once('failed', fail); signal?.addEventListener('abort', fail, { once: true });
      if (signal?.aborted) fail();
    });
  }
  unref(): this { this.#server.unref(); this.#socket?.unref(); return this; }
  disconnect(): void {
    if (!this.connected) return;
    this.connected = false; this.emit('failed');
    this.#socket?.destroy();
    void this.#endpoint.close().catch(() => { /* Preserve unknown endpoint occupants. */ });
    this.release();
  }
}

interface CreationEvent { event: string; pid?: number; code?: number; signal?: NodeJS.Signals | null; deadline?: number }
interface ReceivedChannels { ticket: string; generation: number; fds: number[] }
interface ChannelReceiver { receiveChannels(): ReceivedChannels | undefined }
let inheritedOwner: PosixCreationOwner | undefined;
function posixOwner(): PosixCreationOwner { return inheritedOwner ??= new PosixCreationOwner(); }

/** One fixed owner connection, bounded by the same 32 live creation slots.
 * recvmsg owns fd 5 exclusively; JSON is never read from that datagram lane. */
class PosixCreationOwner {
  readonly #socket: Socket;
  readonly #native: ChannelReceiver;
  readonly #token: string;
  readonly #pending = new Map<string, { count: number; generation?: number; channels(sockets: Socket[]): void; event(value: CreationEvent): void; fail(error: Error): void }>();
  #timer?: ReturnType<typeof setTimeout>;
  #closed = false;
  #buffer = Buffer.alloc(0);
  constructor() {
    const env = process.env, token = env.ZHIXING_TERMINAL_CREATE_TOKEN, artifact = env.ZHIXING_TERMINAL_FOREGROUND;
    if (process.platform === 'win32' || env.ZHIXING_TERMINAL_CREATE_FD !== '4' || env.ZHIXING_TERMINAL_RIGHTS_FD !== '5' || !token || !/^[a-f0-9-]{36}$/u.test(token) || !artifact) throw Error('terminal-helper-owner-unavailable');
    this.#token = token;
    this.#native = createRequire(import.meta.url)(artifact) as ChannelReceiver;
    this.#socket = adoptTerminalSocket(4);
    for (const key of ['ZHIXING_TERMINAL_CREATE_FD', 'ZHIXING_TERMINAL_RIGHTS_FD', 'ZHIXING_TERMINAL_CREATE_TOKEN', 'ZHIXING_TERMINAL_FOREGROUND']) delete env[key];
    this.#socket.on('error', error => this.#fail(error));
    this.#socket.once('close', () => this.#fail(Error('terminal-helper-supervisor-disconnected')));
    this.#socket.on('data', data => {
      for (let offset = 0; offset < data.length;) {
        const newline = data.indexOf(10, offset), end = newline < 0 ? data.length : newline;
        if (this.#buffer.length + end - offset > 4096) { this.#fail(Error('terminal-helper-control-capacity')); return; }
        this.#buffer = Buffer.concat([this.#buffer, data.subarray(offset, end)]);
        if (newline < 0) return;
        const frame = this.#buffer; this.#buffer = Buffer.alloc(0); offset = end + 1;
        try {
          const value = JSON.parse(frame.toString('utf8')) as CreationEvent & { id: string };
          const request = this.#pending.get(value.id);
          if (!request) throw Error('terminal-helper-control-identity');
          if (value.event !== 'channels') request.event(value);
        } catch (error) { this.#fail(error instanceof Error ? error : Error('terminal-helper-control-protocol')); return; }
      }
    });
    this.#socket.unref(); this.#receive();
  }
  register(id: string, count: 1 | 4, channels: (sockets: Socket[]) => void, event: (value: CreationEvent) => void, fail: (error: Error) => void): void {
    if (this.#closed || this.#pending.size >= 32 || this.#pending.has(id) || (count === 1 && [...this.#pending.values()].filter(value => value.count === 1).length >= 4)) throw Error('terminal-helper-owner-capacity');
    this.#pending.set(id, { count, channels, event, fail }); this.#socket.ref();
  }
  remove(id: string): void { this.#pending.delete(id); if (!this.#pending.size) this.#socket.unref(); }
  send(id: string, value: Record<string, unknown>): void {
    const bytes = Buffer.from(JSON.stringify({ ...value, id, owner: this.#token, v: 1 }) + '\n');
    if (this.#closed || !this.#pending.has(id) || bytes.length > 2048 || this.#socket.writableLength + bytes.length > 4096) throw Error('terminal-helper-control-capacity');
    this.#socket.write(bytes);
  }
  #receive(): void {
    if (this.#closed) return;
    try {
      for (let i = 0; i < 32; i++) {
        const bundle = this.#native.receiveChannels(); if (!bundle) break;
        const request = this.#pending.get(bundle.ticket);
        const sockets: Socket[] = []; let taken = 0;
        try {
          if (!request || request.generation !== undefined || bundle.fds.length !== request.count || !Number.isSafeInteger(bundle.generation) || bundle.generation <= 0) throw Error('terminal-helper-channel-identity');
          request.generation = bundle.generation;
          for (const fd of bundle.fds) { taken++; sockets.push(adoptTerminalSocket(fd)); }
          request.channels(sockets);
          this.send(bundle.ticket, { type: 'channels-ready', generation: bundle.generation });
        } catch (error) {
          for (const socket of sockets) socket.destroy();
          for (let index = taken; index < bundle.fds.length; index++) closeSync(bundle.fds[index]!);
          throw error;
        }
      }
    } catch (error) { this.#fail(error instanceof Error ? error : Error('terminal-helper-channels')); return; }
    this.#timer = setTimeout(() => this.#receive(), this.#pending.size ? 5 : 100); this.#timer.unref();
  }
  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true; clearTimeout(this.#timer); this.#socket.destroy();
    // No wrapper ever owns fd 5; this closes queued ancillary references too.
    closeSync(5);
    for (const request of this.#pending.values()) request.fail(error);
    this.#pending.clear();
  }
}

/** Finite lifecycle roles only; domain owners keep their plans and data. */
export type TerminalHelperRole = 'filesystem' | 'log-store' | 'log-files' | 'writer-observer' | 'credential' | 'credential-command' | 'clipboard' | 'mcp-probe' | 'managed-service';
export interface TerminalOwnedProcessOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly deadline: number;
}
export interface TerminalOwnedProcessReceipt { readonly code: number | null; readonly signal: NodeJS.Signals | null }
let terminalPrivateChildren = 0;

export function createTerminalOwnedProcessFactory(role: TerminalHelperRole) {
  return (executable: string, args: readonly string[], options: TerminalOwnedProcessOptions) => {
    if (terminalPrivateChildren >= 32) throw Error('terminal-helper-creation-capacity');
    const child = new TerminalPrivateChild(role, executable, args, options);
    return { child, ready: child.ready, closed: child.closed };
  };
}

class TerminalPrivateChild extends EventEmitter {
  pid?: number;
  readonly stdin = new PassThrough({ highWaterMark: 64 * 1024 });
  readonly stdout = new PassThrough({ highWaterMark: 64 * 1024 });
  readonly stderr = new PassThrough({ highWaterMark: 64 * 1024 });
  readonly ready: Promise<void>;
  readonly closed: Promise<TerminalOwnedProcessReceipt>;
  readonly #endpoint = new TerminalPrivateEndpoint();
  readonly #token = randomUUID();
  readonly #id = randomUUID();
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  readonly #streams = new Set<string>();
  #control?: Socket;
  #posix = false;
  #planSocket?: Socket;
  #inputSocket?: Socket;
  #plan?: Buffer;
  #cancelled = false;
  #created = false;
  #gateReady = false;
  #finished = false;
  #finishing = false;
  #broken = false;
  #sent = false;
  #deadline?: ReturnType<typeof setTimeout>;
  #resolveReady!: () => void;
  #rejectReady!: (error: Error) => void;
  #resolveClosed!: (receipt: TerminalOwnedProcessReceipt) => void;
  #rejectClosed!: (error: Error) => void;
  readonly #channelsReady: Promise<void>;
  #resolveChannels!: () => void;
  #planDelivered = false;
  readonly #signal?: AbortSignal;
  readonly #creationDeadline: number;
  constructor(readonly role: TerminalHelperRole, executable: string, args: readonly string[], options: TerminalOwnedProcessOptions) {
    super();
    terminalPrivateChildren++;
    this.#signal = options.signal; this.#creationDeadline = options.deadline;
    this.ready = new Promise((resolve, reject) => { this.#resolveReady = resolve; this.#rejectReady = reject; });
    this.closed = new Promise((resolve, reject) => { this.#resolveClosed = resolve; this.#rejectClosed = reject; });
    this.#channelsReady = new Promise(resolve => { this.#resolveChannels = resolve; });
    void this.ready.catch(() => {}); void this.closed.catch(() => {});
    this.#server = createServer(socket => this.#accept(socket));
    this.stdin.on('error', () => {}); this.stdout.on('error', () => {}); this.stderr.on('error', () => {});
    options.signal?.addEventListener('abort', this.#abort, { once: true });
    queueMicrotask(() => {
      void this.#start(executable, args, options.env ?? process.env, options.cwd ?? process.cwd()).catch(error => this.#failed(error));
    });
  }
  readonly #abort = (): void => { this.kill('SIGKILL'); };
  async #start(executable: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
    if (process.platform !== 'win32') { this.#startPosix(executable, args, env, cwd); return; }
    const pipe = process.env.ZHIXING_TERMINAL_CREATE_PIPE, owner = process.env.ZHIXING_TERMINAL_CREATE_TOKEN;
    if (!pipe || !isTerminalPrivateEndpoint(pipe) || !owner || !/^[a-f0-9-]{36}$/u.test(owner) || !Number.isSafeInteger(this.#creationDeadline) || this.#creationDeadline <= Date.now()) throw Error('terminal-helper-owner-unavailable');
    this.#signal?.throwIfAborted();
    if (this.#cancelled) throw Error('terminal-helper-cancelled');
    this.#plan = encodePrivatePlan(executable, args, env, cwd);
    const deadline = Math.min(this.#creationDeadline, Date.now() + 5000);
    this.#deadline = setTimeout(() => { this.kill('SIGKILL'); this.#rejectReady(Error('terminal-helper-creation-timeout')); }, Math.max(0, deadline - Date.now()));
    await this.#endpoint.listen(this.#server);
    if (this.#cancelled || Date.now() >= deadline) throw Error('terminal-helper-cancelled');
    const control = this.#control = connect(pipe);
    control.on('error', error => this.#failed(error));
    control.once('close', () => { if (!this.#finished && !this.#finishing) this.#failed(Error('terminal-helper-supervisor-disconnected')); });
    let buffer = '';
    control.on('data', data => {
      if (Buffer.byteLength(buffer) + data.length > 4096) { this.#failed(Error('terminal-helper-control-capacity')); return; }
      buffer += data.toString('utf8');
      for (;;) {
        const end = buffer.indexOf('\n'); if (end < 0) return;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line) as { event: string; pid?: number; birth?: string; code?: number; signal?: NodeJS.Signals | null; deadline?: number };
          if (message.event === 'gate-ready' && this.role === 'filesystem' && !this.#gateReady && !this.#created) {
            this.#gateReady = true; continue;
          }
          if (message.event === 'created' && !this.#created && Number.isSafeInteger(message.pid) && message.pid! > 0) {
            if (this.#gateReady && (typeof message.birth !== 'string' || !/^[1-9][0-9]*$/u.test(message.birth))) throw Error('terminal-helper-target-identity');
            this.pid = message.pid; this.#created = true; this.emit('spawn'); this.#checkReady();
          } else if (message.event === 'exit' && Number.isSafeInteger(message.code)) this.emit('exit', message.code, message.signal ?? null);
          else if (message.event === 'closed' && Number.isSafeInteger(message.code)) void this.#finish({ code: message.code!, signal: message.signal ?? null }, message.deadline);
          else throw Error('terminal-helper-control-protocol');
        } catch (error) { this.#failed(error); return; }
      }
    });
    await new Promise<void>((resolve, reject) => { control.once('connect', resolve); control.once('error', reject); });
    if (this.#cancelled || Date.now() >= deadline) throw Error('terminal-helper-cancelled');
    this.#sent = true;
    control.write(JSON.stringify({ v: 1, owner, id: this.#id, role: this.role, endpoint: this.#endpoint.address, token: this.#token, deadline }) + '\n');
  }
  #startPosix(executable: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string): void {
    this.#signal?.throwIfAborted();
    if (this.#cancelled || !Number.isSafeInteger(this.#creationDeadline) || this.#creationDeadline <= Date.now()) throw Error('terminal-helper-cancelled');
    this.#plan = encodePrivatePlan(executable, args, env, cwd);
    const owner = posixOwner(), deadline = Math.min(this.#creationDeadline, Date.now() + 5000);
    owner.register(this.#id, 4, sockets => {
      if (this.#cancelled || this.#broken) {
        for (const socket of sockets) socket.destroy();
        this.#resolveChannels(); return;
      }
      const kinds = ['plan', 'input', 'output', 'error'];
      for (let i = 0; i < sockets.length; i++) {
        const socket = sockets[i]!, kind = kinds[i]!;
        this.#sockets.add(socket); this.#streams.add(kind);
        socket.on('error', error => this.#failed(error)); socket.once('close', () => this.#sockets.delete(socket));
        if (kind === 'plan') this.#planSocket = socket;
        else if (kind === 'input') this.#inputSocket = socket;
        // No stdin or plan payload may flow until S confirms it gave up all
        // payload descriptors and released the same registered gate.
        else socket.pipe(kind === 'output' ? this.stdout : this.stderr);
      }
      this.#checkReady();
    }, message => {
      if (message.event === 'created' && !this.#created && Number.isSafeInteger(message.pid) && message.pid! > 0) {
        this.pid = message.pid; this.#created = true; this.emit('spawn');
      } else if (message.event === 'permitted') {
        if (this.#cancelled || !this.#plan || !this.#planSocket || this.#streams.size !== 4) throw Error('terminal-helper-permit-state');
        const plan = this.#plan; this.#plan = undefined; this.#planDelivered = true;
        this.#planSocket.end(plan, () => plan.fill(0));
        if (!this.#inputSocket) throw Error('terminal-helper-input-state');
        this.stdin.pipe(this.#inputSocket); this.#checkReady();
      } else if (message.event === 'exit' && Number.isSafeInteger(message.code)) this.emit('exit', message.code, message.signal ?? null);
      else if (message.event === 'closed' && Number.isSafeInteger(message.code)) void this.#finish({ code: message.code!, signal: message.signal ?? null }, message.deadline);
      else throw Error('terminal-helper-control-protocol');
    }, error => this.#failed(error));
    this.#posix = true;
    this.#deadline = setTimeout(() => { this.#rejectReady(Error('terminal-helper-creation-timeout')); this.kill('SIGKILL'); }, Math.max(0, deadline - Date.now()));
    owner.send(this.#id, { type: 'create', role: this.role, deadline }); this.#sent = true;
  }
  #accept(socket: Socket): void {
    if (this.#finished || this.#broken || this.#sockets.size >= 4) { socket.destroy(); return; }
    this.#sockets.add(socket); socket.on('error', error => this.#failed(error));
    socket.once('close', () => this.#sockets.delete(socket));
    let header = Buffer.alloc(0);
    const handshake = (chunk: Buffer) => {
      const newline = chunk.indexOf(10), end = newline < 0 ? chunk.length : newline;
      if (header.length + end > 64) { this.#failed(Error('terminal-helper-stream-handshake')); return; }
      header = Buffer.concat([header, chunk.subarray(0, end)]);
      if (newline < 0) return;
      const [token, kind, extra] = header.toString('utf8').split(' ');
      if (token !== this.#token || extra || !kind || !['plan', 'input', 'output', 'error'].includes(kind) || this.#streams.has(kind)) { this.#failed(Error('terminal-helper-stream-identity')); return; }
      this.#streams.add(kind); socket.removeListener('data', handshake);
      const remainder = chunk.subarray(newline + 1);
      if (kind === 'plan') {
        if (!this.#plan || this.#cancelled || remainder.length) { socket.destroy(); return; }
        this.#planDelivered = true;
        const plan = this.#plan; this.#plan = undefined;
        socket.end(plan, () => plan.fill(0));
      } else if (kind === 'input') {
        if (remainder.length) { this.#failed(Error('terminal-helper-input-state')); return; }
        if (this.#cancelled) socket.end(); else this.stdin.pipe(socket);
      } else {
        // Put bytes after the header back before attaching the bounded stream.
        socket.pause(); if (remainder.length) socket.unshift(remainder);
        socket.pipe(kind === 'output' ? this.stdout : this.stderr); socket.resume();
      }
      this.#checkReady();
      if (this.#streams.size === 4 && this.#server.listening) this.#server.close();
    };
    socket.on('data', handshake);
  }
  #checkReady(): void {
    if (this.#streams.size === 4) this.#resolveChannels();
    if (this.#created && this.#streams.size === 4 && this.#planDelivered && !this.#cancelled) { clearTimeout(this.#deadline); this.#resolveReady(); }
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (!['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGQUIT'].includes(signal)) throw Error('terminal-helper-signal');
    if (this.#finished || this.#finishing) return false;
    this.#cancelled = true; this.#rejectReady(Error('terminal-helper-cancelled'));
    if (this.#sent && this.#posix) {
      try { posixOwner().send(this.#id, { type: 'signal', signal }); } catch { /* Unknown exit remains retained. */ }
    } else if (this.#sent && this.#control && !this.#control.destroyed) {
      if (this.#control.writableLength > 2048) this.#control.destroy(Error('terminal-helper-control-capacity'));
      else this.#control.write(JSON.stringify({ type: 'signal', signal }) + '\n');
    }
    else if (!this.#sent) void this.#finish({ code: 125, signal: null });
    return true;
  }
  ref(): this { this.#control?.ref(); this.#server.ref(); for (const socket of this.#sockets) socket.ref(); return this; }
  unref(): this { this.#control?.unref(); this.#server.unref(); for (const socket of this.#sockets) socket.unref(); return this; }
  #failed(cause: unknown): void {
    if (this.#finished || this.#broken) return;
    this.#broken = true;
    const error = cause instanceof Error ? cause : Error('terminal-helper-failed');
    this.#rejectReady(error); this.kill('SIGKILL');
    if (this.listenerCount('error')) this.emit('error', error);
    if (this.#sent) {
      // Broken control cannot prove OS exit. S still owns and kills the child;
      // data streams close locally but the owner receives an unknown outcome.
      this.#rejectClosed(error); void this.#dispose().catch(() => {});
    }
  }
  async #dispose(graceful = false): Promise<void> {
    clearTimeout(this.#deadline); this.#signal?.removeEventListener('abort', this.#abort);
    this.#plan?.fill(0); this.#plan = undefined;
    this.stdin.destroy();
    if (!graceful) { this.stdout.destroy(); this.stderr.destroy(); }
    else { if (!this.stdout.writableEnded) this.stdout.end(); if (!this.stderr.writableEnded) this.stderr.end(); }
    for (const socket of this.#sockets) socket.destroy();
    if (this.#posix) posixOwner().remove(this.#id);
    this.#control?.destroy(); await this.#endpoint.close();
  }
  async #finish(receipt: TerminalOwnedProcessReceipt, deadline = Date.now() + 1000): Promise<void> {
    if (this.#finished || this.#finishing) return; this.#finishing = true;
    this.#rejectReady(Error('terminal-helper-exited-before-ready'));
    try {
      if (this.#sent && this.#planDelivered) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        // The S receipt and private sockets are independent lanes. A fast
        // process may be reaped before this loop accepts its queued sockets.
        const drain = this.#channelsReady.then(() => Promise.all([this.stdout, this.stderr].map(stream => stream.writableFinished ? Promise.resolve() : new Promise<void>(resolve => stream.once('finish', resolve)))));
        try { await Promise.race([drain, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('terminal-helper-output-drain-unconfirmed')), Math.max(0, Math.min(1000, deadline - Date.now()))); })]); }
        finally { clearTimeout(timer); }
      }
      if (this.#broken) throw Error('terminal-helper-private-drain-failed');
      this.#finished = true;
      await this.#dispose(true); terminalPrivateChildren--; this.#resolveClosed(receipt); this.emit('close', receipt.code, receipt.signal);
    } catch (error) {
      this.#finished = true;
      let disposed = false;
      try { await this.#dispose(); disposed = true; } catch { /* Keep unknown endpoint ownership accounted. */ }
      // No request was published, so S cannot own a process for this attempt.
      // A rejected local plan must not permanently consume a creation slot.
      if (!this.#sent && disposed) terminalPrivateChildren--;
      this.#rejectClosed(error instanceof Error ? error : Error('terminal-helper-close-failed'));
    }
  }
}

function encodePrivatePlan(executable: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Buffer {
  const environment = Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined).map(([key, value]) => {
    if (!key || key.includes('=') || key.includes('\0')) throw Error('terminal-helper-environment');
    return `${key}=${value}`;
  });
  if (!executable || !cwd || args.length > 1024 || environment.length > 1024) throw Error('terminal-helper-plan-capacity');
  const strings = [executable, cwd, ...args, ...environment]; let length = 12;
  for (const value of strings) { const bytes = Buffer.byteLength(value); if (value.includes('\0') || bytes > 32768) throw Error('terminal-helper-plan-text'); length += 4 + bytes; }
  if (length > 2 * 1024 * 1024) throw Error('terminal-helper-plan-capacity');
  const result = Buffer.allocUnsafe(length + 4); result.writeUInt32BE(length, 0); result.writeUInt32BE(1, 4); result.writeUInt32BE(args.length, 8); result.writeUInt32BE(environment.length, 12);
  let at = 16;
  for (const value of strings) { const size = Buffer.byteLength(value); result.writeUInt32BE(size, at); at += 4; result.write(value, at, size, 'utf8'); at += size; }
  return result;
}

/** One Windows filesystem target, still suspended until its real identity is
 * durable. This ticket never substitutes the gate PID for a writer identity. */
export class TerminalWindowsWriterAdmission {
  readonly done: Promise<void>;
  #state: 'target' | 'binding' | 'permitted' | 'resumed' | 'closed' = 'target';
  #identity?: { pid: number; birth: string };
  #binding: Promise<void> = Promise.resolve();
  #resolve!: () => void;
  #reject!: (error: Error) => void;
  constructor(readonly id: string, readonly deadline: number, readonly ports: {
    live(): boolean;
    verify(pid: number, birth: string): { pid: number; birth: string };
    bind(identity: { pid: number; birth: string }): Promise<void>;
    permit(identity: { pid: number; birth: string }): Promise<void>;
    ready(identity: { pid: number; birth: string }): void;
    stop(): void;
  }) {
    const receipt = new Promise<void>((resolve, reject) => { this.#resolve = resolve; this.#reject = reject; });
    // A close can race owner.next publication. Settlement waits the actual
    // publication attempt, even if the caller has already received failure.
    this.done = receipt.finally(() => this.#binding);
    void this.done.catch(() => {});
  }
  #live(): void {
    if (this.#state === 'closed' || !this.ports.live() || Date.now() >= this.deadline) throw Error('terminal-writer-permit-expired');
  }
  accept(value: unknown): void {
    try {
      this.#live();
      if (!value || typeof value !== 'object') throw Error('terminal-writer-target-frame');
      const message = value as Record<string, unknown>;
      if (Object.keys(message).length !== 4 || message.id !== this.id || !Number.isSafeInteger(message.pid) || Number(message.pid) <= 0 ||
          typeof message.birth !== 'string' || !/^[1-9][0-9]*$/u.test(message.birth)) throw Error('terminal-writer-target-frame');
      if (message.type === 'target' && this.#state === 'target') {
        this.#state = 'binding';
        const identity = this.ports.verify(Number(message.pid), message.birth);
        if (identity.pid !== message.pid || identity.birth !== message.birth) throw Error('terminal-writer-target-identity');
        this.#identity = identity;
        this.#binding = (async () => {
          await this.ports.bind(identity);
          this.#live();
          this.#state = 'permitted';
          await this.ports.permit(identity);
        })();
        void this.#binding.catch(error => this.close(error));
      } else if (message.type === 'resumed' && this.#state === 'permitted') {
        const identity = this.#identity;
        if (!identity || identity.pid !== message.pid || identity.birth !== message.birth) throw Error('terminal-writer-target-order');
        this.#state = 'resumed'; this.ports.ready(identity); this.#resolve();
      } else throw Error('terminal-writer-target-order');
    } catch (error) { this.close(error); }
  }
  close(cause: unknown = Error('terminal-writer-target-closed')): void {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    try { this.ports.stop(); }
    catch (error) { this.#reject(error instanceof Error ? error : Error('terminal-writer-stop-unconfirmed')); }
    this.#reject(cause instanceof Error ? cause : Error('terminal-writer-target-failed'));
  }
}

// Windows uses its existing Job to include this fixed Node gate and its child.
// A filesystem target receives the three private pipe handles directly. Only
// its held identity and resume receipt cross the separate S control channel.
export const TERMINAL_WINDOWS_PRIVATE_GATE = String.raw`
const net=require('node:net'),{spawn}=require('node:child_process');
const [endpoint,token,deadlineText,ticket,artifact]=process.argv.slice(1),deadline=Number(deadlineText);
if(!Number.isSafeInteger(deadline)||deadline<=Date.now()||deadline>Date.now()+5000)process.exit(64);
let stop=()=>process.exit(125);
const timer=setTimeout(()=>stop(),Math.max(0,deadline-Date.now()));
const connect=kind=>new Promise((resolve,reject)=>{const socket=net.connect(endpoint,()=>{socket.write(token+' '+kind+'\n');resolve(socket);});socket.on('error',reject);});
(async()=>{
 const plan=await connect('plan');let blocks=[],length=0;
 for await(const chunk of plan){length+=chunk.length;if(length>2*1024*1024+4)throw Error('capacity');blocks.push(chunk);}
 const data=Buffer.concat(blocks,length);blocks=[];
 if(data.length<16||data.readUInt32BE(0)!==data.length-4||data.readUInt32BE(4)!==1)throw Error('plan');
 const argc=data.readUInt32BE(8),envc=data.readUInt32BE(12);if(argc>1024||envc>1024)throw Error('capacity');let at=16;
 const text=()=>{if(at+4>data.length)throw Error('text');const n=data.readUInt32BE(at);at+=4;if(n>32768||at+n>data.length)throw Error('text');const s=data.toString('utf8',at,at+n);at+=n;if(s.includes('\0'))throw Error('nul');return s;};
 const executable=text(),cwd=text(),args=Array.from({length:argc},text),env={};
 for(let i=0;i<envc;i++){const entry=text(),split=entry.indexOf('=');if(split<1)throw Error('env');env[entry.slice(0,split)]=entry.slice(split+1);}
 if(at!==data.length||!executable||!cwd)throw Error('plan');data.fill(0);
 if(ticket)for(const key of Object.keys(env))if(key.startsWith('ZHIXING_TERMINAL_'))delete env[key];
 env.ZHIXING_TERMINAL_CREATE_PIPE=process.env.ZHIXING_TERMINAL_CREATE_PIPE;env.ZHIXING_TERMINAL_CREATE_TOKEN=process.env.ZHIXING_TERMINAL_CREATE_TOKEN;
 if(ticket){
  if(!/^[a-f0-9-]{36}$/.test(ticket)||!artifact||!process.env.ZHIXING_TERMINAL_WRITER_PIPE)throw Error('ticket');
  const native=require(artifact);let target,identity,announced=false,resumed=false,stopped=false,finished=false,poll;
  const control=net.connect(process.env.ZHIXING_TERMINAL_WRITER_PIPE);let buffered='';
  stop=()=>{if(finished)return;stopped=true;control.destroy();if(target!==undefined){try{native.stop(target);}catch{}}else process.exit(71);};
  const live=()=>!stopped&&!control.destroyed&&Date.now()<deadline;
  const send=type=>{if(!live()||control.writableLength>1024)throw Error('permit-expired');control.write(JSON.stringify({type,id:ticket,...identity})+'\n',error=>{if(error)stop();});};
  control.on('error',stop);control.once('close',stop);
  control.on('data',chunk=>{
   if(Buffer.byteLength(buffered)+chunk.length>1024){stop();return;}buffered+=chunk.toString('utf8');
   for(;;){const end=buffered.indexOf('\n');if(end<0)return;const line=buffered.slice(0,end);buffered=buffered.slice(end+1);
    try{const value=JSON.parse(line);if(!live()||!announced||resumed||Object.keys(value).length!==4||value.type!=='permit'||value.id!==ticket||value.pid!==identity.pid||value.birth!==identity.birth)throw Error('permit');
     native.resume(target);resumed=true;send('resumed');clearTimeout(timer);
    }catch{stop();return;}
   }
  });
  await new Promise((resolve,reject)=>{control.once('connect',resolve);control.once('error',reject);});
  if(!live())throw Error('late');
  const quote=value=>value&&!/[\s"]/.test(value)?value:'"'+value.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/g,'$1$1')+'"';
  const environment=Object.entries(env).filter(([,value])=>value!==undefined).sort(([a],[b])=>a.toUpperCase().localeCompare(b.toUpperCase())).map(([key,value])=>key+'='+value).join('\0')+'\0\0';
  target=native.createPrivate(executable,[executable,...args].map(quote).join(' '),environment,cwd,endpoint,token,deadline);
  poll=setInterval(()=>{
   try{const state=native.snapshot(target);
    if(state.ready&&state.created&&!announced){
     if(!live()){stop();}else{if(!Number.isSafeInteger(state.pid)||state.pid<=0||typeof state.birth!=='string'||! /^[1-9][0-9]*$/.test(state.birth))throw Error('identity');identity={pid:state.pid,birth:state.birth};announced=true;send('target');}
    }
    if(state.ready&&!state.created)stop();
    if(state.creationExited&&(state.exited||(state.ready&&!state.created))&&!state.branchActive){
     native.release(target);finished=true;clearInterval(poll);clearTimeout(timer);control.end();process.exitCode=state.exited?state.exitCode??71:71;
    }
   }catch{stop();}
  },5);
  return;
 }
 const [input,output,error]=await Promise.all(['input','output','error'].map(connect));
 if(Date.now()>=deadline)throw Error('late');
 const child=spawn(executable,args,{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 child.once('spawn',()=>clearTimeout(timer));child.once('error',()=>process.exit(126));
 input.pipe(child.stdin);child.stdout.pipe(output);child.stderr.pipe(error);child.stdin.on('error',()=>{});
 child.once('close',(code,signal)=>{input.destroy();output.end();error.end();process.exitCode=code===null?71:code;});
})().catch(()=>stop());
`;
