import { randomUUID, createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { checkpointFilesystemCompletion, CheckpointDirectoryHandle, type CheckpointFilesystemProcess } from '@zhixing/mesh/filesystem';
import type { LogRecordPort } from '@zhixing/core/logging';
import { TerminalChannel } from '@zhixing/terminal-ui/channel';
import { TERMINAL_PROTOCOL, type TerminalMessage, type TerminalTraffic } from '@zhixing/terminal-ui/protocol';
import { isTerminalPrivateEndpoint, TerminalPrivateEndpoint } from '@zhixing/terminal-ui/parent-transport';
import { createServer, type Server, type Socket } from 'node:net';
import { TERMINAL_WINDOWS_PRIVATE_GATE, TerminalWindowsWriterAdmission, type TerminalHelperRole } from './host-launch.js';
import { createDeviceCapacityRuntime } from '../serve/device-capacity-runtime.js';
import { TerminalInstanceAssets, type TerminalIdentityResolver, type TerminalProcessIdentity } from './instance-assets.js';
import { TerminalForegroundProcesses, type TerminalForegroundChild } from './foreground-process.js';
import { LOG_STORE_FRAME_BYTES, type LogStoreWorkerFactory } from '../logging/store-process.js';
import { resolveSelfExec } from '../serve/self-exec.js';
import { terminalWriterDeadline } from './close-budget.js';

type Role = 'recovery' | 'application' | 'ui';
interface OwnedProcess {
  readonly role: Role; readonly child: TerminalForegroundChild; readonly spawnId: string;
  readonly exit: Promise<void>; readonly drained: Promise<void>;
  readonly listening: Promise<void>; announceListening(): void; announced: boolean;
  created: boolean; exited: boolean; code: number | null; birth?: string;
  exitRequested?: boolean;
  channel?: TerminalChannel;
}
interface NativeEvent {
  v: number; instance: string; seq: number; pid: number; born: string; event: string;
  registered?: boolean; enabled?: boolean;
  baseline?: { platform?: string; terminal?: boolean; foreground?: boolean; modeErrors?: number[]; cursorError?: number; inputCP?: number; outputCP?: number };
  targetPID?: number; targetBorn?: string; absent?: boolean; error?: number; exited?: boolean; errors?: number;
}
interface NativeWaiter { readonly matches: (event: NativeEvent) => boolean; resolve(event: NativeEvent): void; reject(error: Error): void; readonly timer: ReturnType<typeof setTimeout> }

export interface TerminalSupervisorOptions {
  readonly home: string;
  readonly entry: string;
  readonly args: readonly string[];
  readonly distribution: string;
  readonly records?: LogRecordPort;
  readonly admitted?: (createStore: LogStoreWorkerFactory, capacity: ReturnType<typeof createDeviceCapacityRuntime>) => Promise<void>;
  readonly drain?: (deadline: number, code: number) => Promise<void>;
  readonly commandOutput?: (stream: 'stdout' | 'stderr', text: string) => void;
}

/** Foreground lifetime owner. It forwards typed surface traffic but has no
 * domain client, secret store, stdin reader, or active-screen renderer. */
export async function runTerminalSupervisor(options: TerminalSupervisorOptions): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY) throw Error('新版交互终端需要 TTY。');
  const supervisor = new TerminalSupervisor(options);
  return supervisor.run();
}

class TerminalSupervisor {
  readonly instance = randomUUID();
  readonly #owned: OwnedProcess[] = [];
  readonly #roleIntents: Partial<Record<'application' | 'ui', string>> = {};
  readonly #waiters = new Set<NativeWaiter>();
  readonly #abort = new AbortController();
  readonly #completion: Promise<number>;
  #resolve!: (code: number) => void;
  #closing?: Promise<void>;
  #sealed = false;
  #result = 0;
  #deadline = 0;
  #deadlineTimer?: ReturnType<typeof setTimeout>;
  #loggingDrain?: Promise<void>;
  #nativeReady = false;
  #nativeBirth?: string;
  #nativeSequence = 0;
  #nativeResult?: NativeEvent;
  #nativeBuffer = Buffer.alloc(0);
  #native?: OwnedProcess;
  #application?: OwnedProcess;
  #applicationAdmitted?: Promise<void>;
  #ui?: OwnedProcess;
  #assets?: TerminalInstanceAssets;
  #capacity?: ReturnType<typeof createDeviceCapacityRuntime>;
  #startupTimer?: ReturnType<typeof setTimeout>;
  #modeAdmission = false;
  #uiReady = false;
  #interrupts = 0;
  #lastAssetRequest = 0;
  #processes?: TerminalForegroundProcesses;
  readonly #helpers: { child: TerminalForegroundChild; drained: Promise<void> }[] = [];
  #assetFileWorker?: { child: TerminalForegroundChild; spawnId: string };
  readonly #writerSettlements = new Set<Promise<void>>();
  readonly #hosts = new Map<string, TerminalForegroundChild>();
  readonly #creationEndpoint = new TerminalPrivateEndpoint();
  #creationServer?: Server;
  readonly #creationConnections = new Set<Socket>();
  readonly #creationOwners = new Map<string, { role: string; child?: TerminalForegroundChild; socket?: Socket }>();
  readonly #privateHelpers = new Map<string, { owner: string; child: TerminalForegroundChild }>();
  readonly #channelHandoffs = new Map<string, { owner: string; generation: number; permit(): void; cancel(ownerClosed?: boolean): void }>();
  readonly #signals: readonly NodeJS.Signals[] = process.platform === 'win32' ? ['SIGINT', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

  constructor(readonly options: TerminalSupervisorOptions) {
    this.#completion = new Promise(resolve => { this.#resolve = resolve; });
  }

  async run(): Promise<number> {
    for (const signal of this.#signals) process.on(signal, this.#interrupt);
    process.on('uncaughtException', this.#uncaught);
    process.on('unhandledRejection', this.#uncaught);
    try {
      const distribution = path.join(this.options.distribution, `${process.platform}-${process.arch}`);
      const manifest = JSON.parse(await readFile(path.join(distribution, 'manifest.json'), 'utf8')) as { protocol?: string; artifacts?: { name: string; bytes: number; sha256: string }[] };
      if (manifest.protocol !== TERMINAL_PROTOCOL || !Array.isArray(manifest.artifacts)) throw Error('terminal-package-version');
      // A fixed closure is required. Missing/corrupt packages never download or
      // silently enter an old renderer. Hash costs belong to complete startup.
      const executableSuffix = process.platform === 'win32' ? '.exe' : '';
      const renderLibrary = process.platform === 'win32' ? 'opentui.dll' : process.platform === 'darwin' ? 'libopentui.dylib' : 'libopentui.so';
      for (const name of [`recovery${executableSuffix}`, `ui${executableSuffix}`, renderLibrary, 'foreground.node', ...(process.platform === 'win32' ? [] : ['exec-gate'])]) {
        const item = manifest.artifacts.find(value => value.name === name);
        if (!item || !/^[a-f0-9]{64}$/u.test(item.sha256)) throw Error('terminal-package-manifest');
        const file = path.join(distribution, name);
        const digest = createHash('sha256');
        if ((await stat(file)).size !== item.bytes) throw Error('terminal-package-integrity');
        for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) { this.#live(); digest.update(chunk); }
        if (digest.digest('hex') !== item.sha256) throw Error('terminal-package-integrity');
      }
      this.#live();
      this.#processes = new TerminalForegroundProcesses(path.join(distribution, 'foreground.node'));
      if (process.platform === 'win32') {
        this.#creationServer = createServer(socket => this.#acceptCreation(socket));
        this.#creationServer.on('error', () => void this.#close(71, 'terminal-creation-channel-failed'));
        await this.#creationEndpoint.listen(this.#creationServer); this.#live();
      }
      this.#observe('starting');
      const ready = this.#waitNative(event => event.event === 'ready', 1500);
      this.#native = this.#spawn('recovery', path.join(distribution, `recovery${executableSuffix}`), ['resident', this.instance], [0, 1, 2, 'pipe', 'pipe'], this.#uiEnvironment(distribution));
      await ready; this.#live();
      await this.#nativeCommand('admit', event => event.event === 'admitted', 800);
      this.#live();
      this.#capacity = createDeviceCapacityRuntime(path.join(this.options.home, 'temporary', 'terminal'), { createDirectory: false, activityDriven: true });
      await this.options.admitted?.(() => this.#createLogStore(), this.#capacity); this.#live();
      const identity: TerminalIdentityResolver = { read: pid => this.#identity(pid) };
      const filesystem = CheckpointDirectoryHandle.createSession(5000, (executable, args) => this.#createFilesystem(executable, args));
      this.#assets = new TerminalInstanceAssets(this.options.home, this.#capacity.arbiter, identity, filesystem, async () => {
        if (!this.#assetFileWorker) throw Error('terminal-assets-worker-unregistered');
        return this.#helperIdentity(this.#assetFileWorker.child, this.#assetFileWorker.spawnId);
      });
      const instancePath = await this.#assets.admit(this.instance, { pid: this.#native.child.pid!, birth: this.#nativeBirth!, spawnId: this.#native.spawnId }, this.#abort.signal);
      this.#live();
      const applicationSpawn = this.#roleIntents.application = randomUUID();
      await this.#assets.intent('application', this.#abort.signal, applicationSpawn);
      this.#live();
      const applicationDeadline = Date.now() + 5000;
      this.#application = this.#spawn('application', process.execPath, [this.options.entry, ...this.options.args], ['ignore', 'pipe', 'pipe', 'ipc'], {
        ...process.env, ZHIXING_TERMINAL_ROLE: 'application', ZHIXING_TERMINAL_INSTANCE: this.instance,
        ZHIXING_TERMINAL_DIRECTORY: instancePath, ZHIXING_TERMINAL_DIRECTORY_ID: this.#assets.instanceIdentity, ZHIXING_TERMINAL_HOME: this.options.home,
      }, applicationSpawn);
      const applicationIdentity = await this.#processIdentity(this.#application);
      await this.#assets.bind('application', applicationIdentity, this.#abort.signal);
      this.#live(); this.#application.child.resume();
      // Loading business modules cannot hold the first visible UI hostage.
      // Only forwarding business requests waits for N's acknowledged admission.
      const application = this.#application;
      this.#applicationAdmitted = (async () => {
        if (!await this.#bounded(application.listening, Math.max(0, applicationDeadline - Date.now()), this.#abort.signal)) throw Error('terminal-application-listener-timeout');
        this.#live();
        await application.channel!.send({ type: 'hello', role: 'application' });
      })();
      void this.#applicationAdmitted.catch(() => this.#close(71, 'terminal-application-admission-failed'));
      const uiSpawn = this.#roleIntents.ui = randomUUID();
      await this.#assets.intent('ui', this.#abort.signal, uiSpawn);
      this.#live();
      // Install the whole UI creation deadline before invoking spawn, including
      // synchronous creation time; a late returned child is owned and closed.
      const startupDeadline = Date.now() + 5000;
      this.#startupTimer = setTimeout(() => void this.#close(78, 'terminal-startup-timeout'), 5000);
      this.#ui = this.#spawn('ui', path.join(distribution, `ui${executableSuffix}`), [], [0, 1, 2, 'ipc'], this.#uiEnvironment(distribution, instancePath), uiSpawn);
      if (Date.now() >= startupDeadline) throw Error('terminal-creation-deadline');
      const uiIdentity = await this.#processIdentity(this.#ui);
      await this.#assets.bind('ui', uiIdentity, this.#abort.signal);
      this.#live(); this.#ui.child.resume();
      if (!await this.#bounded(this.#ui.listening, Math.max(0, startupDeadline - Date.now()), this.#abort.signal)) throw Error('terminal-ui-listener-timeout');
      this.#live();
      await this.#ui.channel!.send({ type: 'hello', role: 'ui' });
    } catch { void this.#close(71, 'terminal-startup-failed'); }
    return this.#completion;
  }

  #live(): void { if (this.#sealed || this.#abort.signal.aborted) throw Error('terminal-admission-closed'); }

  #createLogStore(): ReturnType<LogStoreWorkerFactory> {
    this.#live();
    const owner = this.#newCreationOwner('log-store');
    let child: TerminalForegroundChild;
    try { child = this.#processes!.create(process.execPath,
      [path.join(path.dirname(this.options.entry), 'logging-store-worker.js'), this.options.home, String(process.pid)],
      { ...process.env, ...owner.env }, false, false, { scope: 'execution', pipeEnvironment: 'ZHIXING_LOG_STORE_PIPE', frameBytes: LOG_STORE_FRAME_BYTES, creationOwner: true });
    } catch (error) { this.#creationOwners.delete(owner.token); throw error; }
    this.#bindCreationOwner(owner.token, child);
    this.#trackHelper(child);
    child.once('spawn', () => { try { this.#live(); child.resume(); } catch { child.kill(); } });
    // The logging owner handles worker failures. S retains actual exit duty.
    child.on('error', () => {});
    return { worker: child, ready: child.transportReady };
  }

  #createFilesystem(executable: string, args: readonly string[] = []): CheckpointFilesystemProcess {
    this.#live();
    const child = this.#processes!.create(executable, args, process.env, false, true, { scope: 'execution', pipeEnvironment: 'ZHIXING_CHECKPOINT_PIPE' });
    this.#assetFileWorker = { child, spawnId: randomUUID() };
    this.#trackHelper(child);
    const stderr = new PassThrough();
    const worker = Object.assign(new EventEmitter(), {
      stdin: child.stdio[4], stdout: child.stdio[3], stderr,
      ref: () => child.ref(), unref: () => child.unref(), kill: (signal?: NodeJS.Signals) => child.kill(signal),
    });
    const deadline = setTimeout(() => child.kill(), 5000);
    child.once('spawn', () => {
      clearTimeout(deadline);
      try { this.#live(); child.resume(); } catch { child.kill(); }
    });
    child.once('error', error => worker.emit('error', error));
    child.once('close', () => { clearTimeout(deadline); stderr.end(); worker.emit('close', child.exited ? 0 : 71, null); });
    return worker;
  }

  #newCreationOwner(role: string): { token: string; env: NodeJS.ProcessEnv } {
    if (this.#creationOwners.size >= 32) throw Error('terminal-creation-owner-capacity');
    const token = randomUUID(); this.#creationOwners.set(token, { role });
    return { token, env: { ZHIXING_TERMINAL_CREATE_TOKEN: token, ...(process.platform === 'win32'
      ? { ZHIXING_TERMINAL_CREATE_PIPE: this.#creationEndpoint.address }
      : { ZHIXING_TERMINAL_CREATE_FD: '4', ZHIXING_TERMINAL_RIGHTS_FD: '5', ZHIXING_TERMINAL_FOREGROUND: this.#processes!.artifact }) } };
  }
  #trackHelper(child: TerminalForegroundChild): void {
    const entry = { child, drained: new Promise<void>(resolve => child.once('close', resolve)) };
    this.#helpers.push(entry);
    child.once('close', () => { const index = this.#helpers.indexOf(entry); if (index >= 0) this.#helpers.splice(index, 1); });
  }
  async #helperIdentity(child: TerminalForegroundChild, spawnId: string): Promise<TerminalProcessIdentity> {
    await child.created;
    if (!child.pid || child.exited) throw Error('terminal-helper-identity-unavailable');
    const birth = child.birth && /^[1-9][0-9]*$/u.test(child.birth) ? child.birth : (await this.#identity(child.pid));
    if (typeof birth === 'string') return { pid: child.pid, birth, spawnId };
    if (birth.kind !== 'present' || child.exited) throw Error('terminal-helper-identity-unavailable');
    return { pid: child.pid, birth: birth.birth, spawnId };
  }
  #settleWriter(child: TerminalForegroundChild, id: string, intent: Promise<void>, admission: Promise<void>, bound: () => TerminalProcessIdentity | undefined): void {
    child.once('close', () => {
      const settlement = (async () => {
        // A bind may be publishing when native exit arrives. Finish that same
        // publication before applying its actual-exit receipt.
        await admission.catch(() => {}); await intent;
        const remaining = this.#remaining(1000);
        if (remaining <= 0) throw Error('terminal-writer-settlement-deadline');
        await this.#assets!.settleWriter(id, bound(), AbortSignal.timeout(remaining));
      })();
      this.#writerSettlements.add(settlement);
      void settlement.catch(() => this.#close(74, 'terminal-writer-settlement-failed')).finally(() => this.#writerSettlements.delete(settlement));
    });
  }
  #bindCreationOwner(token: string, child: TerminalForegroundChild): void {
    this.#creationOwners.get(token)!.child = child;
    if (process.platform !== 'win32') child.once('owner-channel', (socket: Socket) => this.#acceptOwnerChannel(token, child, socket));
    child.once('exit', () => {
      this.#creationOwners.delete(token);
      for (const helper of this.#privateHelpers.values()) if (helper.owner === token) helper.child.kill('SIGKILL');
    });
    child.once('close', () => {
      this.#creationOwners.delete(token);
      for (const [id, handoff] of this.#channelHandoffs) if (handoff.owner === token) { this.#channelHandoffs.delete(id); handoff.cancel(true); }
    });
  }
  #acceptOwnerChannel(owner: string, ownerChild: TerminalForegroundChild, socket: Socket): void {
    if (this.#sealed || this.#creationConnections.size >= 32) { socket.destroy(); ownerChild.kill(); return; }
    this.#creationConnections.add(socket);
    const ownerEntry = this.#creationOwners.get(owner);
    if (!ownerEntry) { socket.destroy(); ownerChild.kill(); return; }
    ownerEntry.socket = socket;
    let buffer = Buffer.alloc(0);
    const fail = () => { socket.destroy(); ownerChild.kill(); };
    socket.on('error', fail);
    socket.once('close', () => {
      this.#creationConnections.delete(socket);
      for (const handoff of this.#channelHandoffs.values()) if (handoff.owner === owner) handoff.cancel();
      for (const helper of this.#privateHelpers.values()) if (helper.owner === owner) helper.child.kill();
      if (!ownerChild.exited) ownerChild.kill();
    });
    const send = (id: string, event: string, child: TerminalForegroundChild, code?: number) => {
      if (socket.destroyed || socket.writableLength > 4096) { fail(); return; }
      socket.write(JSON.stringify({ id, event, pid: child.pid, code, signal: null, deadline: this.#deadline || Date.now() + 1000 }) + '\n');
    };
    socket.on('data', data => {
      for (let offset = 0; offset < data.length;) {
        const newline = data.indexOf(10, offset), end = newline < 0 ? data.length : newline;
        if (buffer.length + end - offset > 2048) { fail(); return; }
        buffer = Buffer.concat([buffer, data.subarray(offset, end)]);
        if (newline < 0) return;
        const frame = buffer; buffer = Buffer.alloc(0); offset = end + 1;
        try {
          const message = JSON.parse(frame.toString('utf8')) as Record<string, unknown>;
          const id = message.id;
          if (message.v !== 1 || message.owner !== owner || typeof id !== 'string' || !/^[a-f0-9-]{36}$/u.test(id)) throw Error('terminal-helper-owner-identity');
          if (message.type === 'channels-ready') {
            const handoff = this.#channelHandoffs.get(id);
            if (!handoff || handoff.owner !== owner || message.generation !== handoff.generation) throw Error('terminal-helper-handoff-identity');
            this.#channelHandoffs.delete(id); handoff.permit(); continue;
          }
          if (message.type === 'signal') {
            const helper = this.#privateHelpers.get(id);
            if (!['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGQUIT'].includes(String(message.signal)) || (helper && helper.owner !== owner)) throw Error('terminal-helper-signal');
            // A signal may cross the actual close receipt in flight. No live
            // matching object means no effect, not another process to kill.
            if (!helper) continue;
            helper.child.kill(message.signal as NodeJS.Signals); continue;
          }
          this.#live();
          const { role, deadline } = message;
          const authorization = this.#creationOwners.get(owner);
          const allowed: Readonly<Record<string, readonly TerminalHelperRole[]>> = {
            application: ['filesystem', 'log-store', 'credential', 'clipboard', 'mcp-probe', 'writer-observer', 'managed-service'],
            'log-store': ['log-files', 'writer-observer'], 'log-files': ['filesystem', 'writer-observer'],
            credential: ['credential-command'], 'writer-observer': ['writer-observer'],
          };
          if (message.type !== 'create' || !authorization || ownerChild.exited || typeof role !== 'string' || !allowed[authorization.role]?.includes(role as TerminalHelperRole) ||
              this.#privateHelpers.has(id) || this.#hosts.has(id) || typeof deadline !== 'number' || !Number.isSafeInteger(deadline) || deadline <= Date.now() || deadline > Date.now() + 5000) throw Error('terminal-helper-admission');
          if (this.#processes!.children.size >= 32 || (allowed[role] && this.#creationOwners.size >= 32)) {
            if (socket.writableLength > 4096) { fail(); return; }
            socket.write(JSON.stringify({ id, event: 'closed', code: 75, signal: null, deadline }) + '\n');
            continue;
          }
          const nextOwner = allowed[role] ? this.#newCreationOwner(role) : undefined;
          const intent = role === 'filesystem' && authorization.role === 'application'
            ? this.#assets!.writerIntent(id, owner, this.#abort.signal) : undefined;
          void intent?.catch(() => {});
          let writerIdentity: TerminalProcessIdentity | undefined;
          let child: TerminalForegroundChild;
          try {
            child = this.#processes!.create(this.#processes!.gate, ['private', nextOwner?.token ?? '', this.#processes!.artifact, String(deadline)],
              { ...process.env, ...nextOwner?.env }, false, true,
              { scope: role === 'mcp-probe' ? 'probe' : 'execution', pipeEnvironment: false, channels: 'private', creationOwner: !!nextOwner });
          } catch (error) { if (nextOwner) this.#creationOwners.delete(nextOwner.token); throw error; }
          this.#privateHelpers.set(id, { owner, child });
          if (nextOwner) this.#bindCreationOwner(nextOwner.token, child);
          this.#trackHelper(child);
          let handed = false, acknowledged = false, closed = false, code = 71;
          const finish = () => {
            if (!closed || (handed && !acknowledged)) return;
            clearTimeout(timer); this.#channelHandoffs.delete(id); this.#privateHelpers.delete(id); send(id, 'closed', child, code);
          };
          const timer = setTimeout(() => {
            child.kill();
            // A lost ACK leaves rights in the receiver or datagram queue. The
            // owner lane must actually close; deleting a ticket is not drain.
            if (handed && !acknowledged) fail();
          }, Math.max(0, deadline - Date.now()));
          const admission = child.created.then(async () => {
            try {
              if (intent) {
                await intent; this.#live();
                writerIdentity = await this.#helperIdentity(child, id);
                await this.#assets!.bindWriter(writerIdentity, this.#abort.signal);
              }
              this.#live(); if (socket.destroyed || ownerChild.exited || Date.now() >= deadline) throw Error('terminal-helper-create-expired');
              const generation = child.handoffChannels(ownerChild, id);
              handed = true;
              this.#channelHandoffs.set(id, { owner, generation, cancel: ownerClosed => {
                if (ownerClosed) { acknowledged = true; finish(); }
                child.kill();
              }, permit: () => {
                acknowledged = true;
                if (closed) { finish(); return; }
                this.#live(); if (Date.now() >= deadline || ownerChild.exited || socket.destroyed || child.exited || child.cancelled) { child.kill(); return; }
                child.resume(); clearTimeout(timer); send(id, 'permitted', child);
              } });
              send(id, 'created', child); send(id, 'channels', child);
            } catch (error) { child.kill(); throw error; }
          });
          void admission.catch(() => {});
          if (intent) this.#settleWriter(child, id, intent, admission, () => writerIdentity);
          child.on('error', () => child.kill());
          child.once('exit', value => { code = typeof value === 'number' ? value : 71; send(id, 'exit', child, code); });
          child.once('close', () => { closed = true; finish(); });
        } catch { fail(); return; }
      }
    });
  }
  #acceptCreation(socket: Socket): void {
    if (this.#sealed || this.#creationConnections.size >= 32) { socket.destroy(); return; }
    this.#creationConnections.add(socket);
    let helper: TerminalForegroundChild | undefined, buffer = '', requestId: string | undefined, issuingOwner: string | undefined;
    const fail = () => { helper?.kill('SIGKILL'); socket.destroy(); };
    const timeout = setTimeout(fail, 5000);
    socket.on('error', fail);
    socket.once('close', () => { clearTimeout(timeout); this.#creationConnections.delete(socket); if (helper && !helper.exited) helper.kill('SIGKILL'); });
    socket.on('data', data => {
      if (Buffer.byteLength(buffer) + data.length > 2048) { fail(); return; }
      buffer += data.toString('utf8');
      for (;;) {
        const end = buffer.indexOf('\n'); if (end < 0) return;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          if (helper) {
            if (message.type !== 'signal' || !['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGQUIT'].includes(String(message.signal))) throw Error('terminal-helper-control');
            helper.kill(message.signal as NodeJS.Signals); continue;
          }
          this.#live();
          const { owner, id, role, endpoint, token, deadline } = message;
          const authorization = typeof owner === 'string' ? this.#creationOwners.get(owner) : undefined;
          const allowed: Readonly<Record<string, readonly TerminalHelperRole[]>> = {
            application: ['filesystem', 'log-store', 'credential', 'clipboard', 'mcp-probe', 'writer-observer', 'managed-service'],
            'log-store': ['log-files', 'writer-observer'], 'log-files': ['filesystem', 'writer-observer'],
            credential: ['credential-command'], 'writer-observer': ['writer-observer'],
          };
          if (message.v !== 1 || !authorization?.child || authorization.child.exited || typeof role !== 'string' || !allowed[authorization.role]?.includes(role as TerminalHelperRole) ||
              typeof id !== 'string' || !/^[a-f0-9-]{36}$/u.test(id) || this.#privateHelpers.has(id) ||
              typeof token !== 'string' || !/^[a-f0-9-]{36}$/u.test(token) || typeof endpoint !== 'string' || !isTerminalPrivateEndpoint(endpoint) ||
              typeof deadline !== 'number' || !Number.isSafeInteger(deadline) || deadline <= Date.now() || deadline > Date.now() + 5000) throw Error('terminal-helper-admission');
          if (this.#processes!.children.size >= 32 || this.#creationOwners.size >= 32) {
            clearTimeout(timeout);
            socket.end(JSON.stringify({ event: 'closed', code: 75, signal: null, deadline }) + '\n'); return;
          }
          const nextOwner = this.#newCreationOwner(role);
          const intent = role === 'filesystem' && authorization.role === 'application'
            ? this.#assets!.writerIntent(id, owner as string, this.#abort.signal) : undefined;
          void intent?.catch(() => {});
          let writerIdentity: TerminalProcessIdentity | undefined;
          issuingOwner = nextOwner.token;
          const executable = process.execPath;
          const args = ['--input-type=commonjs', '--eval', TERMINAL_WINDOWS_PRIVATE_GATE, endpoint, token, String(deadline),
            intent ? id : '', intent ? this.#processes!.artifact : ''];
          const child = helper = this.#processes!.create(executable, args, { ...process.env, ...nextOwner.env }, false, !intent,
            { scope: role === 'mcp-probe' ? 'probe' : 'execution', pipeEnvironment: intent ? 'ZHIXING_TERMINAL_WRITER_PIPE' : false,
              ...(intent ? { creationPermit: intent, frameBytes: 1024 } : {}) });
          requestId = id; this.#privateHelpers.set(id, { owner: owner as string, child });
          this.#bindCreationOwner(nextOwner.token, child);
          issuingOwner = undefined;
          this.#trackHelper(child);
          clearTimeout(timeout);
          let writerAdmission: TerminalWindowsWriterAdmission | undefined;
          const cancel = () => { writerAdmission?.close(); child.kill('SIGKILL'); };
          const creationTimer = setTimeout(cancel, Math.max(0, deadline - Date.now()));
          const send = (event: string, code?: number, target?: { pid: number; birth: string }) => {
            if (socket.destroyed || socket.writableLength > 4096) { fail(); return; }
            socket.write(JSON.stringify({ event, pid: target?.pid ?? child.pid, ...(target ? { birth: target.birth } : {}), code, signal: null, deadline: this.#deadline || Date.now() + 1000 }) + '\n');
          };
          if (intent) {
            writerAdmission = new TerminalWindowsWriterAdmission(id, deadline, {
              live: () => !this.#sealed && !this.#abort.signal.aborted && !socket.destroyed && !authorization.child!.exited && !child.exited && !child.cancelled,
              verify: (pid, birth) => child.verifyTarget(pid, birth),
              bind: async identity => {
                writerIdentity = { ...identity, spawnId: id };
                await this.#assets!.bindWriter(writerIdentity, this.#abort.signal);
              },
              permit: identity => new Promise<void>((resolve, reject) => child.send({ type: 'permit', id, ...identity }, error => error ? reject(error) : resolve())),
              ready: identity => {
                clearTimeout(creationTimer);
                // Creation is now complete. N still needs this writer while
                // draining its physical work and closing directory handles.
                // Its control lane, owner exit and the shared close deadline
                // retain termination duty after creation cancellation ends.
                this.#abort.signal.removeEventListener('abort', cancel);
                send('created', undefined, identity);
              },
              stop: () => child.kill('SIGKILL'),
            });
            child.on('message', value => writerAdmission!.accept(value));
            child.once('disconnect', cancel);
            this.#abort.signal.addEventListener('abort', cancel, { once: true });
          }
          const gateAdmission = child.created.then(async () => {
            try {
              if (intent) await intent;
              this.#live(); if (socket.destroyed || Date.now() >= deadline || authorization.child!.exited) throw Error('terminal-helper-create-expired');
              send(intent ? 'gate-ready' : 'created'); this.#live(); child.resume();
              if (!intent) clearTimeout(creationTimer);
            } catch (error) { writerAdmission?.close(error); child.kill('SIGKILL'); throw error; }
          });
          const admission = gateAdmission.then(() => writerAdmission?.done);
          void admission.catch(() => {});
          if (intent) this.#settleWriter(child, id, intent, admission, () => writerIdentity);
          let exitCode = 71;
          child.once('exit', code => { exitCode = typeof code === 'number' ? code : 71; send('exit', exitCode); });
          child.on('error', () => { child.kill('SIGKILL'); });
          child.once('close', () => {
            writerAdmission?.close(); this.#abort.signal.removeEventListener('abort', cancel);
            clearTimeout(creationTimer); this.#privateHelpers.delete(requestId!);
            send('closed', exitCode); socket.end();
          });
        } catch { if (issuingOwner) this.#creationOwners.delete(issuingOwner); fail(); return; }
      }
    });
  }

  #startHost(message: Extract<TerminalMessage, { type: 'host-start' }>, application: OwnedProcess): void {
    this.#live();
    if (!/^[a-f0-9-]{36}$/u.test(message.id) || !/^[a-f0-9-]{36}$/u.test(message.handoff) ||
        (process.platform === 'win32' ? typeof message.endpoint !== 'string' || !isTerminalPrivateEndpoint(message.endpoint) || message.channel !== undefined : message.channel !== 'posix' || message.endpoint !== undefined) ||
        !Number.isSafeInteger(message.deadline) || message.deadline <= 0 ||
        this.#hosts.size >= 4 || this.#hosts.has(message.id)) throw Error('terminal-host-create-request');
    const creationDeadline = Math.min(message.deadline, Date.now() + 5000);
    if (creationDeadline <= Date.now()) { void application.channel!.send({ type: 'host-state', id: message.id, state: 'failed' }).catch(() => {}); return; }
    const resolved = resolveSelfExec(['serve', '--auto-start'], { argv: [process.execPath, this.options.entry],
      env: { ...process.env, ZHIXING_HOME: this.options.home, ZHIXING_LOG_HANDOFF: message.handoff,
        ...(process.platform === 'win32' ? { ZHIXING_HOST_STARTUP_PIPE: message.endpoint } : { ZHIXING_HOST_STARTUP_FD: '6' }) } });
    for (const key of Object.keys(resolved.env)) if (key.startsWith('ZHIXING_TERMINAL_') || key === 'ZHIXING_LOG_STORE_PIPE') delete resolved.env[key];
    const child = this.#processes!.create(resolved.command, resolved.args, resolved.env, false, false, { scope: 'host', pipeEnvironment: false, ...(process.platform === 'win32' ? {} : { channels: 'host' as const }) });
    this.#hosts.set(message.id, child);
    const posixOwner = process.platform === 'win32' ? undefined : [...this.#creationOwners].find(([, value]) => value.child === application.child);
    let handed = false, acknowledged = false, closed = false, permitted = false;
    const finishChannels = () => {
      if (process.platform === 'win32' || (!closed && !permitted) || (handed && !acknowledged)) return;
      const socket = posixOwner?.[1].socket;
      if (!socket || socket.destroyed || socket.writableLength > 4096) { application.child.kill(); return; }
      socket.write(JSON.stringify({ id: message.id, event: 'channels-closed' }) + '\n');
    };
    const send = (state: 'created' | 'failed' | 'exited', code?: number) => application.channel!.send({ type: 'host-state', id: message.id, state, pid: child.pid, code });
    const timeout = setTimeout(() => {
      if (!permitted) child.kill();
      if (handed && !acknowledged) posixOwner?.[1].socket?.destroy();
      void send('failed').catch(() => {});
    }, Math.max(0, creationDeadline - Date.now()));
    child.once('spawn', () => {
      void (async () => {
        this.#live();
        if (!this.#hosts.has(message.id) || Date.now() >= creationDeadline) throw Error('terminal-host-create-expired');
        const permit = () => {
          acknowledged = true;
          if (closed) { clearTimeout(timeout); finishChannels(); return; }
          this.#live(); if (!this.#hosts.has(message.id) || Date.now() >= creationDeadline || child.cancelled) { child.kill(); return; }
          child.resume(); permitted = true; clearTimeout(timeout); finishChannels(); void send('created').catch(() => this.#releaseHost(message.id));
        };
        if (process.platform === 'win32') permit();
        else {
          const owner = posixOwner?.[0];
          if (!owner) throw Error('terminal-host-owner-unavailable');
          const generation = child.handoffChannels(application.child, message.id);
          handed = true;
          this.#channelHandoffs.set(message.id, { owner, generation, permit, cancel: ownerClosed => {
            if (ownerClosed) { acknowledged = true; if (closed) { clearTimeout(timeout); finishChannels(); } }
            child.kill();
          } });
        }
      })().catch(() => { child.kill(); void send('failed').catch(() => {}); });
    });
    child.once('error', () => { void send('failed').catch(() => {}); });
    child.once('exit', code => { void send('exited', code).catch(() => {}); });
    child.once('close', () => {
      closed = true; this.#hosts.delete(message.id);
      if (!handed || acknowledged) { clearTimeout(timeout); this.#channelHandoffs.delete(message.id); if (!permitted) finishChannels(); }
    });
    child.once('released', () => clearTimeout(timeout));
  }

  #releaseHost(id: string): void {
    const child = this.#hosts.get(id); if (!child) return;
    this.#hosts.delete(id);
    // A release before S has admitted execution cancels that creation. An
    // already independent Host only loses this observer, never its lifetime.
    child.releaseHost();
  }

  #observe(event: string, data: Record<string, string | number | boolean> = {}): void {
    try { this.options.records?.record({ event: 'terminalLifecycle', data: { phase: event, instance: this.instance, ...data } }); }
    catch {
      this.#sealed = true;
      if (!this.#result) this.#result = 74;
      queueMicrotask(() => void this.#close(74, 'terminal-observation-failed'));
      throw Error('terminal-observation-failed');
    }
  }

  #spawn(role: Role, executable: string, args: readonly string[], _stdio: readonly unknown[], env: NodeJS.ProcessEnv, spawnId = randomUUID()): OwnedProcess {
    this.#live();
    const started = performance.now();
    const creationOwner = role === 'application' ? this.#newCreationOwner(role) : undefined;
    let child: TerminalForegroundChild;
    try { child = this.#processes!.create(executable, args, { ...env, ...creationOwner?.env }, role !== 'application', role === 'recovery', { creationOwner: !!creationOwner }); }
    catch (error) { if (creationOwner) this.#creationOwners.delete(creationOwner.token); throw error; }
    if (creationOwner) this.#bindCreationOwner(creationOwner.token, child);
    let resolveExit!: () => void, resolveDrain!: () => void, resolveListening!: () => void;
    const item: OwnedProcess = { role, child, spawnId, created: false, exited: false, code: null,
      listening: new Promise(resolve => { resolveListening = resolve; }), announceListening: () => resolveListening(), announced: false,
      exit: new Promise(resolve => { resolveExit = resolve; }), drained: new Promise(resolve => { resolveDrain = resolve; }) };
    // Responsibility exists before any observer or asynchronous identity query.
    this.#owned.push(item);
    // A failure in an observer must still find the exact newly created handle.
    if (role === 'recovery') this.#native = item;
    else if (role === 'application') this.#application = item;
    else this.#ui = item;
    child.once('spawn', () => {
      item.created = true; item.birth = child.birth;
      if (this.#sealed) { child.kill(); return; }
      try {
        this.#observe('created', { role, pid: child.pid!, spawnId: item.spawnId, createMs: performance.now() - started });
        this.#live(); if (role === 'recovery') child.resume();
      } catch { child.kill(); void this.#close(74, 'terminal-child-admission-failed'); }
    });
    child.once('error', () => {
      if (!item.created) { item.exited = true; item.code = 71; resolveExit(); }
      void this.#close(71, `${role}-error`);
    });
    child.once('exit', code => {
      item.exited = true; item.code = code; resolveExit();
      if (!this.#closing) void this.#close(code === 0 && role !== 'recovery' && this.#uiReady ? 0 : code || 71, `${role}-exit`);
    });
    child.once('close', resolveDrain);
    child.on('disconnect', () => { if (!this.#closing) void this.#close(70, `${role}-disconnected`); });
    if (role === 'recovery') this.#attachNative(item); else this.#attachRole(item);
    return item;
  }

  #attachRole(item: OwnedProcess): void {
    item.channel = new TerminalChannel(this.instance, (packet, done) => item.child.send(packet, done),
      (message, traffic) => this.#roleMessage(item, message, traffic), reason => void this.#close(70, reason));
    item.child.on('message', message => item.channel!.accept(message));
  }

  async #roleMessage(item: OwnedProcess, message: TerminalMessage, traffic: TerminalTraffic): Promise<void> {
    if (message.type === 'exit') {
      // This owner has already begun closing. Acknowledge its exit request on
      // the existing channel; do not send a second close across its shutdown.
      // The request is not an actual-exit receipt or permission to release it.
      item.exitRequested = true;
      const code = item.role === 'ui' && this.options.args.length && message.code === 0 ? 130 : message.code;
      void this.#close(code, message.reason); return;
    }
    if (this.#sealed) return;
    if (message.type === 'hello') {
      if (message.role !== item.role || item.announced) throw Error('terminal-listener-handshake');
      item.announced = true; item.announceListening(); return;
    }
    if (item.role === 'application' && message.type === 'assets') {
      if (!this.#assets || !Number.isSafeInteger(message.id) || message.id <= this.#lastAssetRequest) throw Error('terminal-assets-request');
      this.#lastAssetRequest = message.id;
      const operation = message.operation;
      if (!operation || !Number.isSafeInteger(operation.bytes) || operation.bytes < 0 || operation.bytes > 1024 * 1024) throw Error('terminal-assets-operation');
      if (operation.kind === 'settle' ? !/^[a-f0-9-]{36}$/u.test(operation.token) : !['display', 'input'].includes(operation.bucket)) throw Error('terminal-assets-operation');
      try {
        let token: string | undefined;
        if (operation.kind === 'reserve') token = await this.#assets.reserve(operation.bucket, operation.bytes, this.#abort.signal);
        else if (operation.kind === 'settle') await this.#assets.settle(operation.token, operation.bytes, this.#abort.signal);
        else if (operation.kind === 'released') await this.#assets.released(operation.bucket, operation.bytes, this.#abort.signal);
        else throw Error('terminal-assets-operation');
        this.#live(); await item.channel!.send({ type: 'assets-result', id: message.id, token });
      } catch (error) {
        if (checkpointFilesystemCompletion(error)) void this.#close(74, 'terminal-filesystem-unconfirmed');
        if (!this.#sealed) await item.channel!.send({ type: 'assets-result', id: message.id, failed: true });
      }
      return;
    }
    if (item.role === 'application' && message.type === 'host-start') { this.#startHost(message, item); return; }
    if (item.role === 'application' && message.type === 'host-release') { this.#releaseHost(message.id); return; }
    if (item.role === 'ui' && message.type === 'modes') {
      if (this.#modeAdmission || !Number.isInteger(message.originalMask) || message.originalMask < 0 || message.originalMask > 511) throw Error('terminal-mode-registration');
      this.#modeAdmission = true;
      const end = Date.now() + 800;
      await this.#nativeCommand(`modes-${message.originalMask}`, event => event.event === 'modes-admitted', Math.max(0, end - Date.now()));
      this.#live();
      await this.#nativeCommand('activate', event => event.event === 'entered', Math.max(0, end - Date.now()));
      this.#live();
      await this.#nativeCommand('permit-modes', event => event.event === 'modes-permitted', Math.max(0, end - Date.now()));
      this.#live();
      if (Date.now() >= end) throw Error('terminal-mode-admission-deadline');
      await item.channel!.send({ type: 'grant' }); return;
    }
    if (item.role === 'ui' && message.type === 'ready') {
      if (!this.#modeAdmission || this.#uiReady || !Number.isSafeInteger(message.frameId)) throw Error('terminal-first-frame-order');
      this.#uiReady = true; clearTimeout(this.#startupTimer);
      this.#observe('first-frame', { frameId: message.frameId }); return;
    }
    if (item.role === 'ui' && message.type === 'request' && this.#uiReady) {
      await this.#applicationAdmitted;
      // Admission can finish after a concurrent exit sealed this surface.
      // No domain request has been sent yet; end this forwarding receipt
      // without turning ordinary close cancellation into a channel failure.
      if (this.#sealed) return;
      this.#live();
      await this.#application!.channel!.send(message, traffic); return;
    }
    if (item.role === 'application' && message.type === 'command-output') {
      if ((message.stream !== 'stdout' && message.stream !== 'stderr') || typeof message.text !== 'string' || Buffer.byteLength(message.text) > 32 * 1024 || !this.options.commandOutput) throw Error('terminal-command-output-invalid');
      this.options.commandOutput(message.stream, message.text); return;
    }
    if (item.role === 'application' && ['reply', 'view', 'chunk', 'invalidate', 'display-page', 'submission', 'task-status', 'process-status', 'recovery-page'].includes(message.type)) {
      if (!this.#ui) throw Error('terminal-ui-unavailable');
      await this.#ui.channel!.send(message, traffic); return;
    }
    throw Error('terminal-role-message');
  }

  #attachNative(item: OwnedProcess): void {
    (item.child.stdio[3] as Readable).on('data', (chunk: Buffer) => {
      if (chunk.length + this.#nativeBuffer.length > 16 * 1024) { void this.#close(75, 'native-frame-capacity'); return; }
      this.#nativeBuffer = Buffer.concat([this.#nativeBuffer, chunk]);
      for (;;) {
        const index = this.#nativeBuffer.indexOf(10);
        if (index < 0) break;
        const line = this.#nativeBuffer.subarray(0, index); this.#nativeBuffer = this.#nativeBuffer.subarray(index + 1);
        let event: NativeEvent;
        try { event = JSON.parse(line.toString('utf8')) as NativeEvent; } catch { void this.#close(75, 'native-invalid-json'); return; }
        if (event.v !== 1 || event.instance !== this.instance || event.pid !== item.child.pid || event.seq <= this.#nativeSequence || !/^[1-9][0-9]*$/u.test(event.born) || (this.#nativeBirth && this.#nativeBirth !== event.born)) {
          void this.#close(75, 'native-identity'); return;
        }
        this.#nativeSequence = event.seq; this.#nativeBirth = event.born; item.birth = event.born;
        if (event.event === 'ready') {
          const baseline = event.baseline;
          const captured = process.platform === 'win32'
            ? baseline && Array.isArray(baseline.modeErrors) && baseline.modeErrors.length === 3 && !baseline.modeErrors.some(Boolean) && !baseline.cursorError && !!baseline.inputCP && !!baseline.outputCP
            : baseline?.platform === process.platform && baseline.terminal === true && baseline.foreground === true && Array.isArray(baseline.modeErrors) && baseline.modeErrors.length === 3 && !baseline.modeErrors.some(Boolean);
          if (this.#nativeReady || !event.registered || !event.enabled || !captured) { void this.#close(75, 'native-baseline'); return; }
          this.#nativeReady = true;
        }
        if (event.event === 'result') this.#nativeResult = event;
        if (event.event === 'control') this.#interrupt();
        if (['activation-failed', 'activation-denied', 'protocol-error'].includes(event.event)) void this.#close(75, 'native-protocol');
        for (const waiter of this.#waiters) if (waiter.matches(event)) {
          this.#waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(event);
        }
      }
    });
    (item.child.stdio[3] as Readable).on('end', () => { if (this.#nativeBuffer.length) void this.#close(75, 'native-truncated'); });
    for (const index of [3, 4]) item.child.stdio[index]?.on('error', () => void this.#close(75, 'native-pipe-failed'));
  }

  #waitNative(matches: (event: NativeEvent) => boolean, milliseconds: number): Promise<NativeEvent> {
    if (this.#waiters.size >= 16 || milliseconds <= 0) return Promise.reject(Error('native-control-unavailable'));
    return new Promise((resolve, reject) => {
      const waiter: NativeWaiter = { matches, resolve, reject, timer: setTimeout(() => { this.#waiters.delete(waiter); reject(Error('native-control-timeout')); }, milliseconds) };
      this.#waiters.add(waiter);
    });
  }

  #nativeCommand(action: string, matches: (event: NativeEvent) => boolean, milliseconds: number): Promise<NativeEvent> {
    const pending = this.#waitNative(matches, milliseconds);
    this.#writeNative(action); return pending;
  }

  #writeNative(action: string): void {
    if (!this.#native || this.#native.exited || !/^[a-z0-9-]+$/u.test(action) || action.length > 47) throw Error('native-control-closed');
    (this.#native.child.stdio[4] as Writable).write(`1 ${this.instance} ${action}\n`, error => { if (error) void this.#close(75, 'native-command-failed'); });
  }

  async #identity(pid: number): ReturnType<TerminalIdentityResolver['read']> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: 'unknown' };
    const event = await this.#nativeCommand(`identify-${pid}`, value => value.event === 'identity' && value.targetPID === pid, this.#remaining(500));
    if (event.absent && event.error === (process.platform === 'win32' ? 87 : 3)) return { kind: 'absent' };
    if (event.exited) return { kind: 'absent' };
    if (event.targetBorn && /^[1-9][0-9]*$/u.test(event.targetBorn)) return { kind: 'present', birth: event.targetBorn };
    return { kind: 'unknown' };
  }

  async #processIdentity(item: OwnedProcess): Promise<TerminalProcessIdentity> {
    if (!await this.#bounded(item.child.created, 5000, this.#abort.signal)) throw Error('terminal-child-creation-timeout');
    if (!item.child.pid || item.exited) throw Error('terminal-child-not-live');
    const identity = await this.#identity(item.child.pid);
    if (identity.kind !== 'present') throw Error('terminal-child-identity-unavailable');
    item.birth = identity.birth;
    return { pid: item.child.pid, birth: identity.birth, spawnId: item.spawnId };
  }

  #uiEnvironment(distribution: string, instancePath?: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['SystemRoot', 'WINDIR', 'TERM', 'COLORTERM', 'TERM_PROGRAM', 'WT_SESSION', 'LANG', 'LC_ALL']) if (process.env[key]) env[key] = process.env[key];
    const library = process.platform === 'win32' ? 'opentui.dll' : process.platform === 'darwin' ? 'libopentui.dylib' : 'libopentui.so';
    // Packaged parser workers are read-only distribution inputs. Bun otherwise
    // writes a runtime transpiler cache when it loads the external worker.
    Object.assign(env, { ZHIXING_TERMINAL_INSTANCE: this.instance, ZHIXING_TERMINAL_RENDER_LIB: path.join(distribution, library), OTUI_ASSET_ROOT: path.join(distribution, 'assets'), BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' });
    if (instancePath) {
      const runtime = path.join(instancePath, 'runtime');
      Object.assign(env, { TEMP: runtime, TMP: runtime, USERPROFILE: runtime, HOME: runtime, LOCALAPPDATA: runtime, APPDATA: runtime });
    }
    return env;
  }

  #remaining(maximum: number): number { return this.#deadline ? Math.max(0, Math.min(maximum, this.#deadline - Date.now())) : maximum; }
  async #bounded(promise: Promise<unknown>, milliseconds: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try { return await Promise.race([promise.then(() => true, () => false), new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), milliseconds);
      if (signal) { abort = () => resolve(false); signal.addEventListener('abort', abort, { once: true }); }
    })]); }
    finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
  }

  readonly #interrupt = (): void => {
    if (++this.#interrupts > 1 && this.#closing) for (const item of this.#owned) if (item.role !== 'recovery' && !item.exited) item.child.kill('SIGKILL');
    void this.#close(130, 'console-interrupt');
  };
  readonly #uncaught = (): void => { void this.#close(73, 'supervisor-error'); };

  async #finishExecution(): Promise<boolean> {
    // Leave one finite restoration window after logging's own bounded drain.
    this.#loggingDrain ??= this.options.drain?.(terminalWriterDeadline(this.#deadline), this.#result) ?? Promise.resolve();
    const files = this.#assets?.close(this.#deadline) ?? Promise.resolve();
    // A failed cleanup is not a successful persistence receipt, but its actual
    // settlement still ends that owner's ability to start more runtime work.
    // Wait for both owners even if one rejects before the other has finished.
    const owners = Promise.allSettled([this.#loggingDrain, files]).then(results => {
      if (results.some(result => result.status === 'rejected') && !this.#result) this.#result = 74;
    });
    const drained = await this.#bounded(owners, this.#remaining(Math.max(0, this.#deadline - Date.now() - 400)));
    if (!drained && !this.#result) this.#result = 74;
    if (!this.#processes) return drained;
    this.#processes.terminateExecution();
    const until = Math.min(this.#deadline - 100, Date.now() + this.#remaining(300));
    let empty = false;
    do {
      const state = this.#processes.executionState();
      if (!state.active && !state.creating) { empty = true; break; }
      if (Date.now() >= until) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    } while (true);
    // Terminating the existing helpers can settle a previously waiting owner.
    // Recheck that actual fence within the same deadline; the earlier timeout
    // remains a failure result, not a permanent veto after all work has ended.
    const helpers = await this.#bounded(Promise.all([owners, ...this.#helpers.map(item => item.drained)]),
      this.#remaining(Math.max(0, this.#deadline - Date.now() - 100)));
    const final = this.#processes.executionState();
    if (empty && helpers && !final.active && !final.creating) return true;
    if (!this.#result) this.#result = 74;
    if (process.platform === 'win32') return false;
    // External probe groups never inherited a TTY or an output route through
    // S. Once N and every self helper have actually closed, an unknown probe
    // group remains a failed cleanup, not a competing terminal writer. Keep
    // the failure exit code while allowing the original R to restore.
    if (final.creating !== 0 || final.ownedActive !== 0 || final.ownedCreating !== 0) return false;
    return this.#bounded(Promise.all([owners, ...this.#helpers.filter(item => item.child.options.scope !== 'probe').map(item => item.drained)]), this.#remaining(25));
  }

  #close(code: number, reason: string): Promise<void> {
    if (!this.#result && code) this.#result = code;
    if (this.#closing) return this.#closing;
    // Publish the single close promise before transport/abort callbacks can
    // synchronously re-enter this method on an already broken connection.
    let resolveClosing!: () => void;
    this.#closing = new Promise(resolve => { resolveClosing = resolve; });
    this.#sealed = true; this.#processes?.seal(); this.#abort.abort(); clearTimeout(this.#startupTimer);
    // Preserve the first finite lifecycle cause before logging is drained.
    // Observation failure must not re-enter or delay this closing path.
    try { this.options.records?.record({ event: 'terminalLifecycle', data: { instance: this.instance, phase: 'closing', reason, exitCode: this.#result } }); } catch { /* Close remains authoritative. */ }
    this.#deadline = Date.now() + (this.#result === 0 ? 2000 : 8000);
    // The deadline also covers unknown native creation or in-process cleanup.
    // Failure cannot authorize R while an old writer remains unproved.
    this.#deadlineTimer = setTimeout(() => process.exit(this.#result || 75), Math.max(0, this.#deadline - Date.now()));
    void (async () => {
      for (const item of [this.#application, this.#ui]) if (item && !item.exited && !item.exitRequested) void item.channel?.send({ type: 'close', deadline: this.#deadline }).catch(() => {});
      this.#loggingDrain = this.options.drain?.(terminalWriterDeadline(this.#deadline), this.#result) ?? Promise.resolve();
      void this.#loggingDrain.catch(() => {});
      const writers = this.#owned.filter(item => item.role !== 'recovery');
      if (!await this.#bounded(Promise.all(writers.map(item => item.exit)), Math.max(0, terminalWriterDeadline(this.#deadline) - Date.now()))) {
        if (!this.#result) this.#result = 74;
        for (const item of writers) if (!item.exited) item.child.kill('SIGKILL');
      }
      let ended = await this.#bounded(Promise.all(writers.map(item => item.exit)), this.#remaining(1000));
      if (!this.#result && writers.some(item => item.exited && item.code !== 0)) this.#result = 74;
      let drained = await this.#bounded(Promise.all(writers.map(item => item.drained)), this.#remaining(500));
      // N's death revokes its creation capability and terminates each directly
      // held helper. Its files cannot be collected merely because N exited.
      const privateDrained = await this.#bounded(Promise.all([...this.#privateHelpers.values()].filter(({ child }) =>
        process.platform === 'win32' || child.options.scope !== 'probe').map(({ child }) =>
        new Promise<void>(resolve => child.once('close', resolve)))), this.#remaining(500));
      if (!privateDrained && !this.#result) this.#result = 74;
      const writersSettled = await this.#bounded(Promise.all([...this.#writerSettlements]), this.#remaining(1000));
      if (!writersSettled && !this.#result) this.#result = 74;
      if (ended && drained && privateDrained && writersSettled && this.#assets) {
        const signal = AbortSignal.timeout(Math.max(1, this.#remaining(1500)));
        for (const role of ['application', 'ui'] as const) {
          const item = this.#owned.find(value => value.role === role);
          await this.#assets.settleRole(role, item?.created
            ? { kind: 'exited', pid: item.child.pid, spawnId: item.spawnId, born: item.birth }
            : { kind: 'not-created', spawnId: item?.spawnId ?? this.#roleIntents[role] ?? randomUUID() }, signal).catch(() => { if (!this.#result) this.#result = 74; });
        }
        await this.#assets.release(signal).catch(() => { if (!this.#result) this.#result = 74; });
      }
      const executionFinished = await this.#finishExecution();
      this.#capacity?.close();
      ended = writers.every(item => item.exited);
      drained = drained && await this.#bounded(Promise.all(writers.map(item => item.drained)), this.#remaining(100));
      const native = this.#native;
      let restoreSent = false;
      if (native && !native.exited) {
        if (this.#nativeReady && ended && drained && executionFinished && this.#remaining(8000) > 0) { this.#writeNative(`restore-${this.#deadline}`); restoreSent = true; }
        else if (!this.#nativeReady) this.#writeNative('abort');
        if (!await this.#bounded(native.exit, this.#remaining(8000))) {
          native.child.kill('SIGKILL'); await this.#bounded(native.exit, 100); if (!this.#result) this.#result = 75;
        }
        await this.#bounded(native.drained, this.#remaining(100));
      }
      if (this.#nativeReady && (!restoreSent || !native?.exited || native.code !== 0 || this.#nativeResult?.errors !== 0) && !this.#result) this.#result = 75;
    })().catch(async () => {
      if (!this.#result) this.#result = 79;
      const writers = this.#owned.filter(item => item.role !== 'recovery');
      for (const item of writers) if (!item.exited) item.child.kill('SIGKILL');
      const ended = await this.#bounded(Promise.all(writers.map(item => item.exit)), this.#remaining(1000));
      const drained = await this.#bounded(Promise.all(writers.map(item => item.drained)), this.#remaining(500));
      const executionFinished = await this.#finishExecution().catch(() => false);
      if (ended && drained && executionFinished && this.#nativeReady && this.#native && !this.#native.exited && this.#remaining(8000)) {
        try { this.#writeNative(`restore-${this.#deadline}`); await this.#bounded(this.#native.exit, this.#remaining(8000)); } catch { /* Preserve failure and bounded termination below. */ }
      }
      if (this.#native && !this.#native.exited) { this.#native.child.kill('SIGKILL'); await this.#bounded(this.#native.exit, 100); }
    }).finally(async () => {
      clearTimeout(this.#deadlineTimer);
      this.#capacity?.close();
      for (const waiter of this.#waiters) { clearTimeout(waiter.timer); waiter.reject(Error('terminal-closed')); }
      this.#waiters.clear();
      for (const item of this.#owned) item.channel?.close();
      this.#processes?.finish();
      for (const socket of this.#creationConnections) socket.destroy();
      if (!await this.#bounded(this.#creationEndpoint.close(), this.#remaining(100)).catch(() => false) && !this.#result) this.#result = 75;
      for (const signal of this.#signals) process.off(signal, this.#interrupt);
      process.off('uncaughtException', this.#uncaught); process.off('unhandledRejection', this.#uncaught);
      resolveClosing();
      this.#resolve(this.#result);
    });
    return this.#closing;
  }
}
