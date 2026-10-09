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
      close: vi.fn(), send(packet: TerminalEnvelope, done: () => void) { queueMicrotask(() => { supervisor.accept(packet); done(); }); },
    });
    const supervisor = new TerminalChannel(instance, (packet, done) => { queueMicrotask(() => { transport.emit('message', packet); done(); }); },
      message => { received.push(message); }, () => {});
    try {
      await reportApplicationBootstrapFailure(Object.assign(Error('secret path /private/token never leaves'), {code:'ERR_MODULE_NOT_FOUND'}), stage, 123);
      expect(received).toEqual([{type:'exit',code:71,reason:'terminal-application-bootstrap-failed',
        bootstrapFailure:{stage,durationMs:123,category:'system',code:'ERR_MODULE_NOT_FOUND'}}]);
      expect(JSON.stringify(received)).not.toContain('secret'); expect(transport.close).toHaveBeenCalledOnce();
    } finally { supervisor.close(); }
  });
});
