import { EventEmitter } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { closeSync } from 'node:fs';
import { TERMINAL_LIMITS } from '@zhixing/terminal-ui/protocol';
import { adoptTerminalSocket, TerminalPrivateEndpoint, TerminalJsonFrames } from '@zhixing/terminal-ui/parent-transport';

interface NativeState {
  ready: boolean; created: boolean; resumed: boolean; cancelled: boolean;
  creationExited: boolean; exited: boolean; pid: number; error: number;
  birth?: string; exitCode?: number;
  branchActive?: number;
}
interface NativeEdge {
  create(executable: string, command: string, environment: string, directory: string, console: boolean, scope: number): number;
  createPosix(gate: string, executable: string, args: readonly string[], environment: readonly string[], directory: string, console: boolean, scope: number, stdioEndpoint: string): number;
  resume(id: number): number | void; stop(id: number, signal?: number): void; snapshot(id: number): NativeState;
  takeOwnerControl(id: number): number;
  verifyTarget(id: number, pid: number, birth: string): { pid: number; birth: string };
  sendChannels(id: number, owner: number, ticket: string): void;
  observe(id: number): NativeState;
  seal(): void; release(id: number): void;
  detach(id: number): void;
  executionState(): { active: number; creating: number; ownedActive?: number; ownedCreating?: number };
  terminateExecution(): void;
}
export interface TerminalProcessOptions {
  readonly scope?: 'recovery' | 'execution' | 'host' | 'probe';
  readonly pipeEnvironment?: string | false;
  readonly frameBytes?: number;
  readonly creationOwner?: boolean;
  readonly channels?: 'private' | 'host';
  /** The existing child slot is reserved while its writer intent is durable. */
  readonly creationPermit?: Promise<void>;
}

/** S alone uses the lifecycle exports. Node owners load only the fixed rights
 * receiver; the supervisor registers children before permitting execution. */
export class TerminalForegroundProcesses {
  readonly native: NativeEdge;
  readonly children = new Set<TerminalForegroundChild>();
  readonly gate: string;
  #sealed = false;
  #timer?: ReturnType<typeof setTimeout>;
  #finished = false;
  #observing = false;
  constructor(readonly artifact: string) {
    this.native = createRequire(import.meta.url)(artifact) as NativeEdge;
    this.gate = path.join(path.dirname(artifact), process.platform === 'win32' ? 'exec-gate.exe' : 'exec-gate');
    this.#observe();
  }
  get sealed(): boolean { return this.#sealed; }
  create(executable: string, args: readonly string[], env: NodeJS.ProcessEnv, console: boolean, raw: boolean, options: TerminalProcessOptions = {}): TerminalForegroundChild {
    if (this.#sealed || this.children.size >= 32) throw Error('terminal-process-admission-closed');
    const child = new TerminalForegroundChild(this, raw, { ...options, scope: options.scope ?? (raw ? 'recovery' : 'execution') });
    this.children.add(child);
    // The caller receives and registers responsibility before any asynchronous
    // creation or observation can finish.
    queueMicrotask(() => void child.start(executable, args, env, console));
    this.requestObservation();
    return child;
  }
  seal(): void { this.#sealed = true; this.native.seal(); this.requestObservation(); }
  executionState(): ReturnType<NativeEdge['executionState']> { return this.native.executionState(); }
  terminateExecution(): void { this.native.terminateExecution(); }
  requestObservation(): void {
    if (this.#finished || this.#observing) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#observe(), 0);
  }
  #observe(): void {
    if (this.#finished) return;
    this.#observing = true;
    for (const child of this.children) child.poll();
    // Detached independent hosts retain a non-intervening native reaper until
    // S exits. They are never included in execution cancellation.
    if (process.platform !== 'win32') this.native.executionState();
    // Creation/closing needs prompt receipts. A stable process already has
    // its pipe's immediate disconnect notification. Poll only as a fallback
    // for helpers without a control pipe; lifecycle edges wake it immediately.
    const urgent = this.#sealed || [...this.children].some(child => child.observationUrgent);
    this.#observing = false;
    this.#timer = setTimeout(() => this.#observe(), urgent ? 5 : 500);
  }
  finish(): void {
    this.#finished = true; this.seal(); clearTimeout(this.#timer);
    for (const child of this.children) { if (child.options.scope === 'host') child.releaseHost(); child.disposeTransport(); }
  }
}

export class TerminalForegroundChild extends EventEmitter {
  pid?: number;
  birth?: string;
  readonly stdout = null;
  readonly stderr = null;
  readonly stdio: readonly [null, null, null, PassThrough, PassThrough];
  readonly created: Promise<void>;
  readonly transportReady: Promise<void>;
  #resolveTransport!: () => void;
  #rejectTransport!: (error: Error) => void;
  #resolveCreated!: () => void;
  #rejectCreated!: (error: Error) => void;
  #nativeId?: number;
  #announced = false;
  #exited = false;
  #cancelled = false;
  #closed = false;
  #detaching = false;
  #disconnected = false;
  #endpointClosed = false;
  #closingEndpoint?: Promise<void>;
  #socket?: Socket;
  #ownerSocket?: Socket;
  #server: Server;
  readonly #frames: TerminalJsonFrames;
  readonly #endpoint = new TerminalPrivateEndpoint();
  constructor(readonly owner: TerminalForegroundProcesses, readonly raw: boolean, readonly options: TerminalProcessOptions) {
    super();
    this.#frames = new TerminalJsonFrames(this.#frameBytes);
    this.stdio = [null, null, null, new PassThrough(), new PassThrough()];
    this.created = new Promise((resolve, reject) => { this.#resolveCreated = resolve; this.#rejectCreated = reject; });
    void this.created.catch(() => {});
    this.transportReady = new Promise((resolve, reject) => { this.#resolveTransport = resolve; this.#rejectTransport = reject; });
    void this.transportReady.catch(() => {});
    this.#server = createServer(socket => {
      if (this.#socket || this.#cancelled || this.#exited) { socket.destroy(); return; }
      this.#server.close(); this.#attachSocket(socket);
    });
  }
  get connected(): boolean { return !!this.#socket && !this.#socket.destroyed; }
  get exited(): boolean { return this.#exited; }
  get cancelled(): boolean { return this.#cancelled; }
  get observationUrgent(): boolean { return !this.#announced || this.#cancelled || this.#exited || this.#detaching || this.#disconnected; }
  ref(): this { return this; }
  unref(): this { return this; }
  get #frameBytes(): number { return this.options.frameBytes ?? TERMINAL_LIMITS.frameBytes; }
  releaseHost(): void {
    this.#detaching = true;
    if (this.#nativeId && !this.owner.native.snapshot(this.#nativeId).resumed) this.kill();
    this.poll();
    this.owner.requestObservation();
  }
  async start(executable: string, args: readonly string[], env: NodeJS.ProcessEnv, console: boolean): Promise<void> {
    try {
      if (this.options.creationPermit) await this.options.creationPermit;
      if (this.owner.sealed || this.#cancelled) throw Error('terminal-process-create-cancelled');
      if (process.platform === 'win32' && this.options.pipeEnvironment !== false) await this.#endpoint.listen(this.#server);
      this.#server.on('error', error => this.emit('error', error));
      if (this.owner.sealed || this.#cancelled) throw Error('terminal-process-create-cancelled');
      const pipeKey = this.options.pipeEnvironment || 'ZHIXING_TERMINAL_PIPE';
      const childEnv = { ...env };
      delete childEnv[pipeKey]; delete childEnv[pipeKey.replace(/_PIPE$/u, '_FD')];
      if (this.options.pipeEnvironment !== false) childEnv[process.platform === 'win32' ? pipeKey : pipeKey.replace(/_PIPE$/u, '_FD')] = process.platform === 'win32' ? this.#endpoint.address : '3';
      const environment = Object.entries(childEnv)
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .sort(([a], [b]) => a.toUpperCase().localeCompare(b.toUpperCase()))
        .map(([key, value]) => { if (key.includes('=') || key.includes('\0') || value.includes('\0')) throw Error('terminal-child-environment'); return `${key}=${value}`; });
      const scope = this.options.scope === 'recovery' ? 0 : this.options.scope === 'host' ? 2 : this.options.scope === 'probe' && process.platform !== 'win32' ? 3 : 1;
      this.#nativeId = process.platform === 'win32'
        ? this.owner.native.create(executable, [executable, ...args].map(quoteWindowsArgument).join(' '), environment.join('\0') + '\0\0', process.cwd(), console, scope)
        : this.owner.native.createPosix(this.owner.gate, executable, args, environment, process.cwd(), console, scope,
          this.options.channels === 'private' ? (this.options.creationOwner ? 'private-owner' : 'private') : this.options.channels === 'host' ? 'host' :
          this.options.creationOwner ? 'owner' : this.options.pipeEnvironment === 'ZHIXING_CHECKPOINT_PIPE' ? 'stdio' : this.options.pipeEnvironment === false ? 'none' : 'control');
    } catch (error) { this.#failed(error instanceof Error ? error : Error('terminal-process-create-failed')); }
  }
  resume(): void {
    if (!this.#nativeId || this.#cancelled || this.owner.sealed) throw Error('terminal-process-resume-closed');
    const fd = this.owner.native.resume(this.#nativeId);
    if (process.platform !== 'win32') {
      if (typeof fd !== 'number') throw Error('terminal-native-channel-missing');
      if (this.options.pipeEnvironment === false) { closeSync(fd); this.#disconnect(); }
      else {
        let socket: Socket;
        try { socket = adoptTerminalSocket(fd); } catch (error) { this.kill(); throw error; }
        this.#attachSocket(socket);
      }
    }
  }
  handoffChannels(owner: TerminalForegroundChild, ticket: string): number {
    if (!this.#nativeId || !owner.#nativeId || this.#cancelled || owner.exited) throw Error('terminal-channel-owner-closed');
    this.owner.native.sendChannels(this.#nativeId, owner.#nativeId, ticket);
    return this.#nativeId;
  }
  verifyTarget(pid: number, birth: string): { pid: number; birth: string } {
    if (process.platform !== 'win32' || !this.#nativeId || this.#cancelled || this.#exited || this.owner.sealed) throw Error('terminal-target-verification-closed');
    return this.owner.native.verifyTarget(this.#nativeId, pid, birth);
  }
  #attachSocket(socket: Socket): void {
    this.#socket = socket; this.#resolveTransport();
    socket.on('error', error => this.emit('error', error));
    socket.once('close', () => { this.#disconnect(); this.#closeIfDone(); });
    if (this.raw) { socket.pipe(this.stdio[3]); this.stdio[4].pipe(socket); }
    else socket.on('data', data => this.#data(data));
  }
  kill(signal: NodeJS.Signals = 'SIGKILL'): boolean {
    const numbers: Partial<Record<NodeJS.Signals, number>> = { SIGKILL: 9, SIGTERM: 15, SIGINT: 2, SIGHUP: 1, SIGQUIT: 3 };
    if (!numbers[signal]) throw Error('terminal-process-signal');
    this.#cancelled = true;
    if (this.#nativeId) {
      if (process.platform === 'win32') this.owner.native.stop(this.#nativeId);
      else this.owner.native.stop(this.#nativeId, numbers[signal]);
    }
    this.owner.requestObservation();
    return true;
  }
  send(packet: unknown, done: (error?: Error | null) => void): void {
    const bytes = Buffer.from(JSON.stringify(packet) + '\n');
    if (!this.connected || bytes.length > this.#frameBytes + 1 || this.#socket!.writableLength + bytes.length > this.#frameBytes * 2) {
      done(Error('terminal-process-pipe-unavailable')); return;
    }
    this.#socket!.write(bytes, done);
  }
  poll(): void {
    if (!this.#nativeId) return;
    const state = this.owner.native.observe(this.#nativeId);
    if (state.exited && state.branchActive === undefined) throw Error('terminal-exited-branch-unobserved');
    if (state.ready && !this.#announced) {
      this.#announced = true;
      if (!state.created) this.#failed(Error(`terminal-process-create-${state.error}`));
      else {
        this.pid = state.pid; this.birth = state.birth;
        if (process.platform !== 'win32' && this.options.creationOwner && !state.cancelled) {
          try { this.#ownerSocket = adoptTerminalSocket(this.owner.native.takeOwnerControl(this.#nativeId)); }
          catch (error) {
            this.kill(); const cause = error instanceof Error ? error : Error('terminal-owner-channel');
            this.#rejectCreated(cause); this.emit('error', cause); return;
          }
          this.#ownerSocket.once('close', () => { this.#ownerSocket = undefined; this.#closeIfDone(); });
          this.emit('owner-channel', this.#ownerSocket);
        }
        this.#resolveCreated(); this.emit('spawn');
      }
    }
    if (state.exited && !this.#exited) {
      this.#exited = true; this.#closeServer(); this.#ownerSocket?.destroy();
      if (state.branchActive) this.owner.native.stop(this.#nativeId);
      this.emit('exit', state.exitCode ?? 71);
      if (!this.#socket) { this.#disconnect(); this.#closeIfDone(); }
    }
    if (state.creationExited && !state.branchActive && (state.exited || (state.ready && !state.created))) {
      this.owner.native.release(this.#nativeId); this.#nativeId = undefined;
      this.#closeIfDone();
    } else if (this.#detaching && state.creationExited && state.resumed && this.options.scope === 'host') {
      this.owner.native.detach(this.#nativeId); this.#nativeId = undefined;
      this.owner.children.delete(this); this.disposeTransport(); this.emit('released');
    }
  }
  disposeTransport(): void {
    this.#closeServer(); this.#socket?.destroy(); this.#ownerSocket?.destroy(); this.stdio[3].destroy(); this.stdio[4].destroy();
  }
  #failed(error: Error): void {
    this.#exited = true; this.#rejectCreated(error); this.#rejectTransport(error);
    this.#closeServer(); this.emit('error', error);
    this.#disconnect(); this.#closeIfDone();
  }
  #disconnect(): void {
    if (this.#disconnected) return;
    this.#frames.clear();
    this.#disconnected = true; this.#rejectTransport(Error('terminal-process-disconnected')); this.emit('disconnect');
    this.owner.requestObservation();
  }
  #closeServer(): void {
    this.#closingEndpoint ??= this.#endpoint.close().then(() => {
      this.#endpointClosed = true; this.#closeIfDone();
    }, error => { if (this.listenerCount('error')) this.emit('error', error); });
  }
  #closeIfDone(): void {
    if (this.#closed || !this.#exited || !this.#disconnected || this.#nativeId || this.#ownerSocket || !this.#endpointClosed) return;
    this.#closed = true; this.owner.children.delete(this); this.emit('close');
  }
  #data(data: Buffer): void {
    try { this.#frames.accept(data, value => this.emit('message', value)); }
    catch { this.#socket?.destroy(); }
  }
}

function quoteWindowsArgument(value: string): string {
  if (value.includes('\0')) throw Error('terminal-child-argument');
  return value && !/[\s"]/u.test(value) ? value : '"' + value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1') + '"';
}
