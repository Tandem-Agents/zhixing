import { describe, expect, it, vi } from 'vitest';
import { TerminalHostLauncher, TerminalWindowsWriterAdmission, createTerminalOwnedProcessFactory } from '../host-launch.js';
import { TerminalParentTransport, TerminalPrivateEndpoint } from '../../../../terminal-ui/src/parent-transport.js';
import { createServer, connect, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { TerminalMessage } from '../../../../terminal-ui/src/protocol.js';

describe.skipIf(process.platform !== 'win32')('terminal fixed Host creation channel', () => {
  it.each(['managed', 'on-demand', 'none'] as const)('retains early %s plan and actual exit for the daemon owner', async mode => {
    let peer: TerminalParentTransport | undefined;
    let launcher: TerminalHostLauncher;
    const sent: TerminalMessage[] = [];
    launcher = new TerminalHostLauncher({ send: async message => {
      sent.push(message);
      if (message.type !== 'host-start') return;
      peer = new TerminalParentTransport(message.endpoint!, 1024);
      await new Promise<void>((resolve, reject) => peer!.send({ type: 'host-launch-plan', mode }, error => error ? reject(error) : resolve()));
      // Deliver both before start() returns and the existing owner subscribes.
      await new Promise(resolve => setTimeout(resolve, 10));
      launcher.accept({ type: 'host-state', id: message.id, state: 'created', pid: 45678 });
      launcher.accept({ type: 'host-state', id: message.id, state: 'exited', code: 0 });
    } });
    try {
      const child = await launcher.start(crypto.randomUUID(), Date.now() + 60000);
      const plan = new Promise(resolve => child.once('message', resolve));
      const exit = new Promise(resolve => child.once('exit', resolve));
      expect(await plan).toEqual({ type: 'host-launch-plan', mode });
      expect(await exit).toBe(0); expect(child.pid).toBe(45678);
      child.disconnect(); child.disconnect();
      expect(sent.filter(message => message.type === 'host-release')).toHaveLength(1);
    } finally { launcher.close(); peer?.close(); }
  });

  it('releases an aborted pending creation once and discards its late receipt', async () => {
    const sent: TerminalMessage[] = [];
    const launcher = new TerminalHostLauncher({ send: async message => { sent.push(message); } });
    const abort = new AbortController();
    const pending = launcher.start(crypto.randomUUID(), Date.now() + 60000, abort.signal);
    const failure = expect(pending).rejects.toThrow('unconfirmed');
    await vi.waitFor(() => expect(sent.some(message => message.type === 'host-start')).toBe(true));
    abort.abort(); await failure;
    const start = sent.find(message => message.type === 'host-start')!;
    launcher.accept({ type: 'host-state', id: start.id, state: 'created', pid: 45678 });
    launcher.close();
    expect(sent.filter(message => message.type === 'host-release')).toHaveLength(1);
  });
});

describe.skipIf(process.platform !== 'win32')('terminal helper private transport', () => {
  it('reclaims unpublished failed creations without consuming the finite process capacity', async () => {
    vi.stubEnv('ZHIXING_TERMINAL_CREATE_PIPE', '');
    try {
      const create = createTerminalOwnedProcessFactory('clipboard');
      for (let index = 0; index < 40; index++) {
        const owner = create('/unused', [], { deadline: Date.now() + 5000 });
        await expect(owner.ready).rejects.toThrow('owner-unavailable');
        await expect(owner.closed).rejects.toThrow();
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it.each([[false, false], [true, false], [false, true]] as const)('keeps the plan private and drains output with early close=%s, writer=%s', async (earlyReceipt, writer) => {
    const endpoint = new TerminalPrivateEndpoint();
    const sockets = new Set<Socket>();
    let request!: Record<string, unknown>, supervisor!: Socket;
    let accepted!: () => void;
    const requested = new Promise<void>(resolve => { accepted = resolve; });
    const server = createServer(socket => {
      supervisor = socket; sockets.add(socket);
      let buffer = '';
      socket.on('data', data => {
        buffer += data.toString(); const end = buffer.indexOf('\n'); if (end < 0 || request) return;
        request = JSON.parse(buffer.slice(0, end)); accepted();
      });
    });
    await endpoint.listen(server);
    vi.stubEnv('ZHIXING_TERMINAL_CREATE_PIPE', endpoint.address);
    vi.stubEnv('ZHIXING_TERMINAL_CREATE_TOKEN', randomUUID());
    const connectStream = (kind: string) => new Promise<Socket>((resolve, reject) => {
      const socket = connect(request.endpoint as string, () => { socket.write(`${request.token} ${kind}\n`); resolve(socket); });
      sockets.add(socket); socket.on('error', reject);
    });
    try {
      const owner = createTerminalOwnedProcessFactory(writer ? 'filesystem' : 'credential-command')('/fixture/private-command', ['private-argument'], {
        env: { FIXTURE_PRIVATE_VALUE: 'not-for-supervisor' }, cwd: process.cwd(), deadline: Date.now() + 5000,
      });
      let output = ''; owner.child.stdout.on('data', data => { output += data.toString(); }); owner.child.stderr.resume();
      await requested;
      expect(JSON.stringify(request)).not.toContain('private-command'); expect(JSON.stringify(request)).not.toContain('not-for-supervisor');
      let ready = false, spawned = false;
      void owner.ready.then(() => { ready = true; }, () => {});
      owner.child.once('spawn', () => { spawned = true; });
      supervisor.write(JSON.stringify({ event: writer ? 'gate-ready' : 'created', pid: 45678 }) + '\n');
      const plan = await connectStream('plan'); const chunks: Buffer[] = [];
      for await (const chunk of plan) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks); expect(bytes.readUInt32BE(0)).toBe(bytes.length - 4);
      expect(bytes.toString()).toContain('not-for-supervisor');
      let closed = false; void owner.closed.then(() => { closed = true; });
      const sendClosed = () => {
        supervisor.write(JSON.stringify({ event: 'exit', code: 0 }) + '\n');
        supervisor.write(JSON.stringify({ event: 'closed', code: 0, deadline: Date.now() + 1000 }) + '\n');
      };
      if (earlyReceipt) { sendClosed(); await new Promise(resolve => setTimeout(resolve, 10)); }
      const [input, stdout, stderr] = await Promise.all(['input', 'output', 'error'].map(connectStream));
      input.resume();
      if (writer) {
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(ready).toBe(false); expect(spawned).toBe(false); expect(owner.child.pid).toBeUndefined();
        supervisor.write(JSON.stringify({ event: 'created', pid: 45679, birth: '123456' }) + '\n');
      }
      if (!earlyReceipt) { await owner.ready; sendClosed(); }
      await Promise.resolve(); expect(closed).toBe(false);
      stdout.end('last-private-bytes'); stderr.end(); input.destroy();
      await expect(owner.closed).resolves.toEqual({ code: 0, signal: null });
      expect(output).toBe('last-private-bytes');
    } finally {
      for (const socket of sockets) socket.destroy();
      await endpoint.close(); vi.unstubAllEnvs();
    }
  });
});

describe('Windows filesystem writer admission', () => {
  const identity = { pid: 56789, birth: '123456789' };
  function fixture(bind: () => Promise<void> = async () => {}) {
    const id = randomUUID();
    const ports = { live: () => true, verify: vi.fn(() => identity), bind: vi.fn(bind), permit: vi.fn(async () => {}), ready: vi.fn(), stop: vi.fn() };
    const admission = new TerminalWindowsWriterAdmission(id, Date.now() + 5000, ports);
    const frame = (type: string) => ({ type, id, ...identity });
    return { admission, ports, frame };
  }
  it('persists the actual suspended target before permitting and waits successful resume before ready', async () => {
    let bound!: () => void;
    const f = fixture(() => new Promise(resolve => { bound = resolve; }));
    f.admission.accept(f.frame('target'));
    expect(f.ports.verify).toHaveBeenCalledWith(identity.pid, identity.birth);
    expect(f.ports.permit).not.toHaveBeenCalled(); expect(f.ports.ready).not.toHaveBeenCalled();
    bound(); await Promise.resolve();
    expect(f.ports.permit).toHaveBeenCalledExactlyOnceWith(identity); expect(f.ports.ready).not.toHaveBeenCalled();
    f.admission.accept(f.frame('resumed')); await f.admission.done;
    expect(f.ports.ready).toHaveBeenCalledExactlyOnceWith(identity);
    expect(f.ports.stop).not.toHaveBeenCalled();
  });
  it('seals a cancelled ticket and keeps settlement waiting for an in-flight durable bind', async () => {
    let bound!: () => void;
    const f = fixture(() => new Promise(resolve => { bound = resolve; }));
    f.admission.accept(f.frame('target'));
    let returned = false; const failure = f.admission.done.catch(() => { returned = true; });
    f.admission.close(Error('cancelled'));
    await Promise.resolve(); expect(returned).toBe(false);
    bound(); await failure;
    expect(f.ports.permit).not.toHaveBeenCalled(); expect(f.ports.ready).not.toHaveBeenCalled();
    expect(f.ports.stop).toHaveBeenCalledTimes(1);
  });
  it.each(['duplicate-target', 'different-resume', 'late-resume'] as const)('refuses %s without a second target or ready receipt', async mode => {
    const f = fixture();
    f.admission.accept(f.frame('target')); await Promise.resolve();
    if (mode === 'late-resume') f.ports.live = () => false;
    f.admission.accept(mode === 'duplicate-target' ? f.frame('target') : { ...f.frame('resumed'), ...(mode === 'different-resume' ? { pid: identity.pid + 1 } : {}) });
    await expect(f.admission.done).rejects.toThrow();
    expect(f.ports.verify).toHaveBeenCalledTimes(1); expect(f.ports.bind).toHaveBeenCalledTimes(1);
    expect(f.ports.permit).toHaveBeenCalledTimes(1); expect(f.ports.ready).not.toHaveBeenCalled();
    expect(f.ports.stop).toHaveBeenCalledTimes(1);
  });
});
