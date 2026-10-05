import { describe, expect, it, vi } from 'vitest';
import { TerminalChannel } from '@zhixing/terminal-ui/channel';
import { TERMINAL_LIMITS } from '@zhixing/terminal-ui/protocol';

describe('terminal independent control capacity', () => {
  it('keeps control and the reserved exit reachable when the body window is full', async () => {
    const sent = vi.fn((_packet, done: (error?: Error) => void) => done()), failure = vi.fn();
    const channel = new TerminalChannel('synthetic', sent, () => {}, failure);
    const pending = Array.from({ length: TERMINAL_LIMITS.bodyFrames }, () => channel.send({ type: 'hello', role: 'ui' }, 'body').catch(error => error.message));
    await expect(channel.send({ type: 'hello', role: 'ui' }, 'body')).rejects.toThrow('body-capacity');
    pending.push(channel.send({ type: 'hello', role: 'ui' }).catch(error => error.message));
    pending.push(channel.send({ type: 'exit', code: 0, reason: 'user-exit' }).catch(error => error.message));
    expect(sent).toHaveBeenCalledTimes(TERMINAL_LIMITS.bodyFrames + 2);
    expect(failure).not.toHaveBeenCalled();
    channel.close(); await Promise.all(pending);
  });

  it('reports a full control lane once and settles every outstanding delivery', async () => {
    const failure = vi.fn(), sent = vi.fn((_packet, done: (error?: Error) => void) => done());
    const channel = new TerminalChannel('synthetic', sent, () => {}, failure);
    const pending = Array.from({ length: TERMINAL_LIMITS.controlFrames }, () => channel.send({ type: 'hello', role: 'ui' }).catch(error => error.message));
    await expect(channel.send({ type: 'hello', role: 'ui' })).rejects.toThrow('control-capacity');
    expect(await Promise.all(pending)).toEqual(Array(TERMINAL_LIMITS.controlFrames).fill('terminal-control-capacity'));
    expect(failure).toHaveBeenCalledExactlyOnceWith('terminal-control-capacity');
    await expect(channel.send({ type: 'exit', code: 71, reason: 'failed' })).rejects.toThrow('channel-closed');
    expect(failure).toHaveBeenCalledOnce();
    expect(sent).toHaveBeenCalledTimes(TERMINAL_LIMITS.controlFrames);
  });

  it('treats an unrepresentable control view as unavailable rather than silently losing it', async () => {
    const failure = vi.fn(), sent = vi.fn();
    const channel = new TerminalChannel('synthetic', sent, () => {}, failure);
    await expect(channel.send({ type: 'view', view: { generation: 1, kind: 'confirmation', title: 'synthetic', message: 'x'.repeat(TERMINAL_LIMITS.frameBytes) } })).rejects.toThrow('frame-too-large');
    expect(failure).toHaveBeenCalledExactlyOnceWith('terminal-control-frame-too-large');
    expect(sent).not.toHaveBeenCalled();
  });
});
