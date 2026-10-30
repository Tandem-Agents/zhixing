import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ endpoint: 'fixture', transport: undefined as any }));
vi.mock('@zhixing/terminal-ui/parent-transport', () => ({
  consumeTerminalParentEndpoint: () => state.endpoint,
  TerminalParentTransport: class { constructor() { return state.transport; } },
}));
import { TerminalChannel } from '../../../../terminal-ui/src/channel.js';
import type { TerminalEnvelope, TerminalMessage } from '../../../../terminal-ui/src/protocol.js';
import { reportApplicationBootstrapFailure } from '../application-bootstrap.js';
afterEach(() => vi.unstubAllEnvs());
describe('failed application bootstrap uses the existing supervisor log owner', () => {
  it.each(['writer-declaration', 'module-load'] as const)('reports a finite %s cause before handing the endpoint to the application', async stage => {
    const instance = '11111111-1111-4111-8111-111111111111'; vi.stubEnv('ZHIXING_TERMINAL_INSTANCE', instance);
    const received: TerminalMessage[] = [];
    const transport = state.transport = Object.assign(new EventEmitter(), {
      close: vi.fn(), socket: { destroy: vi.fn() }, send(packet: TerminalEnvelope, done: () => void) { queueMicrotask(() => { supervisor.accept(packet); done(); }); },
    });
    const supervisor = new TerminalChannel(instance, (packet, done) => { queueMicrotask(() => { transport.emit('message', packet); done(); }); },
      message => { received.push(message); }, () => {});
    try {
      await reportApplicationBootstrapFailure(Object.assign(Error('secret path /private/token never leaves'), {code:'ERR_MODULE_NOT_FOUND'}), stage, 123);
      expect(received).toEqual([{type:'exit',code:71,reason:'terminal-application-bootstrap-failed',
        bootstrapFailure:{stage,durationMs:123,category:'system',code:'ERR_MODULE_NOT_FOUND'}}]);
      expect(JSON.stringify(received)).not.toContain('secret'); expect(transport.close).toHaveBeenCalledOnce();
      expect(transport.socket.destroy).toHaveBeenCalledOnce();
    } finally { supervisor.close(); }
  });

  it('S 在场却不确认时，投递超时后结束上报并彻底释放父通道，进程退出不取决于对端', async () => {
    vi.useFakeTimers();
    try {
      vi.stubEnv('ZHIXING_TERMINAL_INSTANCE', '11111111-1111-4111-8111-111111111111');
      const transport = state.transport = Object.assign(new EventEmitter(), {
        connected: true, close: vi.fn(), socket: { destroy: vi.fn() }, send(_packet: TerminalEnvelope, done: () => void) { queueMicrotask(() => done()); },
      });
      const report = reportApplicationBootstrapFailure(Error('preload release invalid'), 'module-load', 1, transport as never);
      const settled = report.then(() => 'resolved', () => 'rejected');
      await vi.advanceTimersByTimeAsync(4_999);
      expect(transport.socket.destroy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(settled).resolves.toBe('rejected');
      // 通道的失败回调与收尾各关一次（真实 close 幂等）
      expect(transport.close).toHaveBeenCalled();
      expect(transport.socket.destroy).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});
