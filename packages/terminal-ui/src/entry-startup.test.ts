import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalChannel } from './channel.js';
import { TERMINAL_LIMITS, type TerminalAction, type TerminalEnvelope, type TerminalMessage } from './protocol.js';

// Execute the production entry and real channels. Only process, transport,
// mode query and native renderer are controlled ports.
const source = readFileSync(new URL('./entry.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('entry.ts', source, ts.ScriptTarget.Latest, true);
const body = parsed.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(parsed)).join('\n')
  .replace("await import('./root.js')", 'await Promise.resolve({ createTerminalRoot: ports.createRoot })');
const code = ts.transpile(body, { target: ts.ScriptTarget.ES2022 });
const cleanups: (() => void)[] = [];
function fixture() {
  const sent: TerminalMessage[] = [], failures: string[] = [];
  const instance = '11111111-1111-4111-8111-111111111111';
  const transport = Object.assign(new EventEmitter(), { connected: true,
    send(packet: TerminalEnvelope, done: (error?: Error) => void) { queueMicrotask(() => { supervisor.accept(packet); done(); }); },
    close() { this.connected = false; },
  });
  const supervisor = new TerminalChannel(instance, (packet, done) => {
    queueMicrotask(() => { transport.emit('message', packet); done(); });
  }, message => {
    sent.push(message);
    if (message.type === 'hello') void supervisor.send({ type: 'hello', role: 'ui' }).catch(() => {});
    if (message.type === 'modes') void supervisor.send({ type: 'grant' }).catch(() => {});
    if (message.type === 'request') void supervisor.send({ type: 'reply', id: message.id, value: { accepted: true } }).catch(() => {});
  }, reason => failures.push(reason));
  let request!: (action: TerminalAction) => Promise<unknown>;
  const dispose = vi.fn(async () => {});
  const ports = { async createRoot(options: { request: typeof request }) {
    request = options.request;
    void request({ kind: 'input-candidates', revision: 1, text: '', cursor: 0 }).catch(() => {});
    return { firstFrameId: 1, dispose, receive() {} };
  } };
  const processPort = Object.assign(new EventEmitter(), { env: { ZHIXING_TERMINAL_INSTANCE: instance },
    exitCode: undefined as number | undefined, stdin: { pause() {}, unref() {} },
  });
  const loaded = new Function('TerminalChannel', 'TerminalInputOwner', 'TERMINAL_LIMITS', 'consumeTerminalParentEndpoint',
    'TerminalParentTransport', 'process', 'ports', code + '\nreturn { close };')(
    TerminalChannel, class { async query() { return 0; } cancel() {} handoff() {} }, TERMINAL_LIMITS,
    () => 'fixture-endpoint', class { constructor() { return transport; } }, processPort, ports,
  ) as { close(reason: string, code: number, notify?: boolean): Promise<void> };
  cleanups.push(() => supervisor.close());
  return { sent, failures, supervisor, transport, dispose, processPort,
    request: (action: TerminalAction) => request(action), close: loaded.close,
    flush: () => vi.advanceTimersByTimeAsync(0) };
}
describe('UI waits for application readiness outside the delivery window', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { cleanups.splice(0).forEach(close => close()); vi.clearAllTimers(); vi.useRealTimers(); });
  it('keeps the first frame live and sends queued requests only once after a slow preparation', async () => {
    const f = fixture(); await f.flush();
    expect(f.sent.some(message => message.type === 'ready')).toBe(true);
    await vi.advanceTimersByTimeAsync(7000);
    expect(f.sent.filter(message => message.type === 'request')).toEqual([]);
    expect(f.sent.filter(message => message.type === 'exit')).toEqual([]);
    const admit = f.supervisor.send({ type: 'application-ready' }); await f.flush(); await admit;
    expect(f.sent.filter(message => message.type === 'request').map(message => message.action.kind)).toEqual(['input-candidates', 'startup']);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(f.failures).toEqual([]); expect(f.processPort.exitCode).toBeUndefined();
    const close = f.close('user-exit', 0); await f.flush(); await close;
    expect(f.processPort.exitCode).toBe(0);
  });
  it('cancels locally while the application is still preparing, without sending a delayed interrupt', async () => {
    const f = fixture(); await f.flush(); await vi.advanceTimersByTimeAsync(7000);
    await f.request({ kind: 'interrupt' }); await f.flush(); await f.close('user-exit', 0);
    expect(f.sent.filter(message => message.type === 'request')).toEqual([]);
    expect(f.sent.filter(message => message.type === 'exit')).toEqual([{ type: 'exit', code: 0, reason: 'user-exit' }]);
    expect(f.dispose).toHaveBeenCalledOnce(); expect(f.processPort.exitCode).toBe(0);
    expect(f.transport.connected).toBe(false); expect(f.failures).toEqual([]);
  });
  it('reserves startup within the existing budget when preparation requests fill every ordinary slot', async () => {
    const f = fixture(); await f.flush();
    const queued = Array.from({ length: TERMINAL_LIMITS.pendingRequests - 2 }, (_, index) =>
      f.request({ kind: 'input-candidates', revision: index + 2, text: '', cursor: 0 }));
    await expect(f.request({ kind: 'input-candidates', revision: 99, text: '', cursor: 0 })).rejects.toThrow('terminal-request-capacity');
    await vi.advanceTimersByTimeAsync(7000);
    expect(f.sent.filter(message => message.type === 'request')).toEqual([]);
    const admit = f.supervisor.send({ type: 'application-ready' }); await f.flush(); await admit; await Promise.all(queued);
    const requests = f.sent.filter(message => message.type === 'request');
    expect(requests).toHaveLength(TERMINAL_LIMITS.pendingRequests);
    expect(requests.filter(message => message.action.kind === 'startup')).toHaveLength(1);
    expect(f.sent.filter(message => message.type === 'exit')).toEqual([]);
    expect(f.failures).toEqual([]); expect(f.dispose).not.toHaveBeenCalled();
    const close = f.close('user-exit', 0); await f.flush(); await close;
  });
  it('does not replay repeated preparation-time Esc aborts after startup', async () => {
    const f = fixture(); await f.flush();
    await Promise.all(Array.from({ length: 20 }, () => f.request({ kind: 'abort' })));
    await vi.advanceTimersByTimeAsync(7000);
    const admit = f.supervisor.send({ type: 'application-ready' }); await f.flush(); await admit;
    expect(f.sent.filter(message => message.type === 'request').map(message => message.action.kind)).toEqual(['input-candidates', 'startup']);
    expect(f.sent.filter(message => message.type === 'exit')).toEqual([]);
    expect(f.dispose).not.toHaveBeenCalled(); expect(f.failures).toEqual([]);
    const close = f.close('user-exit', 0); await f.flush(); await close;
  });
  it('discards queued intents when the supervisor closes before readiness', async () => {
    const f = fixture(); await f.flush();
    const close = f.supervisor.send({ type: 'close', deadline: Date.now() + 2000 }); await f.flush(); await close;
    await f.close('supervisor-close', 0, false);
    expect(f.sent.filter(message => message.type === 'request')).toEqual([]);
    expect(f.dispose).toHaveBeenCalledOnce(); expect(f.transport.connected).toBe(false);
  });
});
