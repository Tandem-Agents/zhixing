import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// 以生产源码中的预拉起/接管方法运行，进程、端点与连接都用内存端口替代，逐步驱动 Host 的
// 创建、启动计划到达与 N 的拉起请求之间的各种先后次序。
const source = ts.createSourceFile('supervisor.ts', readFileSync(new URL('../supervisor.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const owner = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'TerminalSupervisor');
const methods = ['#prelaunchHost', '#acceptPrelaunchPlan', '#adoptPrelaunchedHost', '#closePrelaunch', '#releaseHost'].map(name => {
  const method = owner?.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === name);
  if (!method) throw Error(`Missing production method ${name}`);
  return method.getText(source);
}).join('\n');
const emitted = ts.transpileModule(`class Fixture {
  #processes; #hosts = new Map(); #prelaunch; #hostRequested = false; #sealed = false;
  constructor(options, ports) { this.options = options; this.ports = ports; this.#processes = ports.processes; }
  #live() { if (this.#sealed) throw Error('terminal-retired'); }
  #observe(event, data) { this.ports.observed.push({ event, ...data }); }
  prelaunch() { this.#prelaunchHost(); }
  markRequested() { this.#hostRequested = true; }
  request(message, application) { this.#hostRequested = true; return this.#adoptPrelaunchedHost(message, application); }
  release(id) { this.#releaseHost(id); }
  close() { this.#sealed = true; this.#closePrelaunch(); }
  get hosts() { return this.#hosts; }
  ${methods}
} exports.Fixture = Fixture;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

interface FixturePort {
  prelaunch(): void; markRequested(): void; close(): void; release(id: string): void;
  request(message: Record<string, unknown>, application: unknown): boolean;
  readonly hosts: Map<string, unknown>;
}

class FakeSocket extends EventEmitter {
  readonly written: Buffer[] = [];
  destroyed = false; ended = false;
  write(data: Buffer) { this.written.push(Buffer.from(data)); return true; }
  end() { this.ended = true; }
  destroy() { this.destroyed = true; }
}
class FakeChild extends EventEmitter {
  pid = 4242; cancelled = false; exited = false;
  resume = vi.fn(); kill = vi.fn(); releaseHost = vi.fn();
}

function fixture(input: { args?: string[]; alive?: boolean; listen?: Promise<void> } = {}) {
  const endpoints: { address: string; closed: boolean }[] = [];
  const servers: (EventEmitter & { handler: (socket: FakeSocket) => void; close: ReturnType<typeof vi.fn> })[] = [];
  const relays: { endpoint: string; socket: FakeSocket }[] = [];
  const created: { command: string; args: string[]; env: Record<string, string>; options: Record<string, unknown> }[] = [];
  const children: FakeChild[] = [];
  class TerminalPrivateEndpoint {
    address = `\\\\.\\pipe\\zhixing-terminal-${randomUUID()}`;
    closed = false;
    constructor() { endpoints.push(this); }
    async listen() { await input.listen; }
    async close() { this.closed = true; }
  }
  const createServer = (handler: (socket: FakeSocket) => void) => {
    const server = Object.assign(new EventEmitter(), { handler, close: vi.fn() }); servers.push(server); return server;
  };
  const connect = (endpoint: string) => { const socket = new FakeSocket(); relays.push({ endpoint, socket }); return socket; };
  const resolveSelfExec = (args: string[], options: { argv: string[]; env: Record<string, string> }) => ({ command: options.argv[0], args: [options.argv[1], ...args], env: { ...options.env } });
  const recordedHostAlive = vi.fn(async () => input.alive ?? false);
  const processPort = { platform: 'win32', execPath: 'node', env: { PATH: 'fixture', ZHIXING_TERMINAL_ROLE: 'supervisor', ZHIXING_LOG_STORE_PIPE: 'pipe' } };
  const loaded: { Fixture?: new (options: unknown, ports: unknown) => FixturePort } = {};
  new Function('exports', 'process', 'randomUUID', 'TerminalPrivateEndpoint', 'createServer', 'connect', 'resolveSelfExec', 'recordedHostAlive', 'Buffer', emitted)(
    loaded, processPort, randomUUID, TerminalPrivateEndpoint, createServer, connect, resolveSelfExec, recordedHostAlive, Buffer);
  const observed: Record<string, unknown>[] = [];
  const processes = {
    create: vi.fn((command: string, args: string[], env: Record<string, string>, _console: boolean, _raw: boolean, options: Record<string, unknown>) => {
      created.push({ command, args, env, options }); const child = new FakeChild(); children.push(child); return child;
    }),
  };
  const target = new loaded.Fixture!({ home: 'fixture-home', entry: 'fixture-entry.js', args: input.args ?? [] }, { processes, observed });
  const sent: Record<string, unknown>[] = [];
  const application = { channel: { send: vi.fn(async (message: Record<string, unknown>) => { sent.push(message); }) } };
  const request = (id = randomUUID()) => ({ type: 'host-start', id, endpoint: `\\\\.\\pipe\\zhixing-terminal-${randomUUID()}`, handoff: randomUUID(), deadline: Date.now() + 5000 });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return { target, created, children, endpoints, servers, relays, observed, sent, application, request, flush, recordedHostAlive };
}
const plan = (mode = 'on-demand') => Buffer.from(JSON.stringify({ type: 'host-launch-plan', mode }) + '\n');

describe('terminal host prelaunch', () => {
  it('starts one automatic Host early and hands that same Host to the first request', async () => {
    const f = fixture(); f.target.prelaunch(); await f.flush();
    expect(f.created).toHaveLength(1);
    const [creation] = f.created;
    expect(creation!.args).toEqual(['fixture-entry.js', 'serve', '--auto-start']);
    expect(creation!.options).toEqual({ scope: 'host', pipeEnvironment: false });
    expect(creation!.env.ZHIXING_HOME).toBe('fixture-home');
    expect(creation!.env.ZHIXING_HOST_STARTUP_PIPE).toBe(f.endpoints[0]!.address);
    expect(creation!.env.ZHIXING_LOG_HANDOFF).toMatch(/^[a-f0-9-]{36}$/u);
    expect(creation!.env.ZHIXING_TERMINAL_ROLE).toBeUndefined();
    expect(creation!.env.ZHIXING_LOG_STORE_PIPE).toBeUndefined();
    const child = f.children[0]!; child.emit('spawn');
    expect(child.resume).toHaveBeenCalledOnce();
    expect(f.observed).toContainEqual(expect.objectContaining({ event: 'host-prelaunched', role: 'host', pid: 4242 }));
    // Host 先交来启动计划，N 的请求随后到达。
    const startup = new FakeSocket(); f.servers[0]!.handler(startup); startup.emit('data', plan());
    const message = f.request();
    expect(f.target.request(message, f.application)).toBe(true);
    expect(f.created).toHaveLength(1);
    expect(f.target.hosts.get(message.id as string)).toBe(child);
    expect(f.relays).toHaveLength(1);
    expect(f.relays[0]!.endpoint).toBe(message.endpoint);
    expect(Buffer.concat(f.relays[0]!.socket.written).toString()).toBe(plan().toString());
    expect(f.sent).toEqual([{ type: 'host-state', id: message.id, state: 'created', pid: 4242 }]);
    expect(f.observed).toContainEqual(expect.objectContaining({ event: 'host-adopted', pid: 4242, spawnId: message.handoff }));
    // 只接管一次：再来的请求走正常拉起。
    expect(f.target.request(f.request(), f.application)).toBe(false);
  });

  it('relays a plan that arrives after the request exactly once and reports a later exit to that request', async () => {
    const f = fixture(); f.target.prelaunch(); await f.flush();
    const child = f.children[0]!; child.emit('spawn');
    const message = f.request(); expect(f.target.request(message, f.application)).toBe(true);
    expect(f.relays[0]!.socket.written).toHaveLength(0);
    const startup = new FakeSocket(); f.servers[0]!.handler(startup);
    const bytes = plan('managed'); startup.emit('data', bytes.subarray(0, 10)); startup.emit('data', bytes.subarray(10));
    expect(Buffer.concat(f.relays[0]!.socket.written).toString()).toBe(plan('managed').toString());
    startup.emit('data', plan());
    expect(startup.destroyed).toBe(true);
    expect(f.relays[0]!.socket.written).toHaveLength(1);
    child.emit('exit', 0);
    expect(f.sent.at(-1)).toEqual({ type: 'host-state', id: message.id, state: 'exited', pid: 4242, code: 0 });
    child.emit('close');
    expect(f.target.hosts.has(message.id as string)).toBe(false);
    expect(f.endpoints[0]!.closed).toBe(true);
  });

  it('accepts only one well-formed startup connection and plan', async () => {
    const f = fixture(); f.target.prelaunch(); await f.flush(); f.children[0]!.emit('spawn');
    const startup = new FakeSocket(), intruder = new FakeSocket();
    f.servers[0]!.handler(startup); f.servers[0]!.handler(intruder);
    expect(intruder.destroyed).toBe(true); expect(f.servers[0]!.close).toHaveBeenCalledOnce();
    startup.emit('data', Buffer.from(JSON.stringify({ type: 'host-launch-plan', mode: 'on-demand', extra: true }) + '\n'));
    expect(startup.destroyed).toBe(true);
    const message = f.request(); expect(f.target.request(message, f.application)).toBe(true);
    expect(f.relays[0]!.socket.written).toHaveLength(0);
    const unknown = fixture(); unknown.target.prelaunch(); await unknown.flush();
    const strange = new FakeSocket(); unknown.servers[0]!.handler(strange); strange.emit('data', plan('elsewhere'));
    expect(strange.destroyed).toBe(true);
    const oversized = fixture(); oversized.target.prelaunch(); await oversized.flush();
    const big = new FakeSocket(); oversized.servers[0]!.handler(big); big.emit('data', Buffer.alloc(1025, 0x20));
    expect(big.destroyed).toBe(true);
  });

  it('does not prelaunch for commands, a recorded live Host, or once N has requested', async () => {
    const command = fixture({ args: ['status'] }); command.target.prelaunch(); await command.flush();
    expect(command.created).toHaveLength(0); expect(command.recordedHostAlive).not.toHaveBeenCalled();
    const live = fixture({ alive: true }); live.target.prelaunch(); await live.flush();
    expect(live.created).toHaveLength(0); expect(live.endpoints).toHaveLength(0);
    const requested = fixture(); requested.target.markRequested(); requested.target.prelaunch(); await requested.flush();
    expect(requested.created).toHaveLength(0);
    // 请求在端点监听期间到达：监听完成后不再创建，并归还端点。
    let listened!: () => void;
    const raced = fixture({ listen: new Promise<void>(resolve => { listened = resolve; }) });
    raced.target.prelaunch(); await raced.flush();
    expect(raced.endpoints).toHaveLength(1);
    raced.target.markRequested(); listened(); await raced.flush();
    expect(raced.created).toHaveLength(0);
    expect(raced.endpoints[0]!.closed).toBe(true);
  });

  it('leaves the request to the normal path when the prelaunched Host is not running', async () => {
    const pending = fixture(); pending.target.prelaunch(); await pending.flush();
    expect(pending.target.request(pending.request(), pending.application)).toBe(false);
    const exited = fixture(); exited.target.prelaunch(); await exited.flush();
    exited.children[0]!.emit('spawn'); exited.children[0]!.emit('exit', 2);
    expect(exited.target.request(exited.request(), exited.application)).toBe(false);
    expect(exited.sent).toHaveLength(0);
    const cancelled = fixture(); cancelled.target.prelaunch(); await cancelled.flush();
    cancelled.children[0]!.emit('spawn'); cancelled.children[0]!.cancelled = true;
    expect(cancelled.target.request(cancelled.request(), cancelled.application)).toBe(false);
  });

  it('releases only the observer of an adopted Host and closes its own endpoint on close', async () => {
    const f = fixture(); f.target.prelaunch(); await f.flush();
    const child = f.children[0]!; child.emit('spawn');
    const startup = new FakeSocket(); f.servers[0]!.handler(startup);
    const message = f.request(); f.target.request(message, f.application);
    f.target.release(message.id as string);
    expect(child.releaseHost).toHaveBeenCalledOnce(); expect(child.kill).not.toHaveBeenCalled();
    f.target.close();
    expect(startup.destroyed).toBe(true); expect(f.relays[0]!.socket.ended).toBe(true); expect(f.endpoints[0]!.closed).toBe(true);
  });
});
