import { describe, expect, it, vi } from 'vitest';
import { TerminalChannel } from '@zhixing/terminal-ui/channel';
import { TERMINAL_LIMITS, TERMINAL_PROTOCOL } from '@zhixing/terminal-ui/protocol';

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

  it('reports an exhausted bounded backlog once and settles every retained delivery', async () => {
    const failure = vi.fn(), sent = vi.fn((_packet, done: (error?: Error) => void) => done());
    const channel = new TerminalChannel('synthetic', sent, () => {}, failure);
    const capacity = TERMINAL_LIMITS.controlFrames + TERMINAL_LIMITS.pendingRequests;
    const pending = Array.from({ length: capacity }, () => channel.send({ type: 'hello', role: 'ui' }).catch(error => error.message));
    await expect(channel.send({ type: 'hello', role: 'ui' })).rejects.toThrow('control-capacity');
    expect(await Promise.all(pending)).toEqual(Array(capacity).fill('terminal-control-capacity'));
    expect(failure).toHaveBeenCalledExactlyOnceWith('terminal-control-capacity');
    await expect(channel.send({ type: 'exit', code: 71, reason: 'failed' })).rejects.toThrow('channel-closed');
    expect(failure).toHaveBeenCalledOnce();
    expect(sent).toHaveBeenCalledTimes(TERMINAL_LIMITS.controlFrames);
  });

  it('drains concurrent producers in FIFO order on ACK without widening the wire window', async () => {
    const packets: any[] = [], failure = vi.fn();
    const channel = new TerminalChannel('synthetic', (packet, done) => { packets.push(packet); done(); }, () => {}, failure);
    const pending = Array.from({ length: 10 }, (_, id) => channel.send({ type: 'reply', id }));
    expect(packets).toHaveLength(TERMINAL_LIMITS.controlFrames);
    for (let index = 0; index < 10; index++) {
      expect(packets[index].payload).toEqual({ type: 'reply', id: index });
      channel.accept({ protocol: TERMINAL_PROTOCOL, instance: 'synthetic', sequence: index + 1, traffic: 'control', payload: { type: 'ack', sequence: packets[index].sequence } });
      expect(packets.length - index - 1).toBeLessThanOrEqual(TERMINAL_LIMITS.controlFrames);
    }
    await Promise.all(pending);
    expect(failure).not.toHaveBeenCalled(); channel.close();
  });

  it('keeps the reserved close and ACK path available while controls wait', async () => {
    const packets: any[] = [], failure = vi.fn();
    const channel = new TerminalChannel('synthetic', (packet, done) => { packets.push(packet); done(); }, () => {}, failure);
    const pending = Array.from({ length: 8 }, (_, id) => channel.send({ type: 'reply', id }).catch(error => error.message));
    const closing = channel.send({ type: 'exit', code: 0, reason: 'user-exit' }).catch(error => error.message);
    expect(packets.at(-1).payload.type).toBe('exit');
    await expect(channel.send({ type: 'close', deadline: 0 })).rejects.toThrow('close-already-pending');
    channel.accept({ protocol: TERMINAL_PROTOCOL, instance: 'synthetic', sequence: 1, traffic: 'control', payload: { type: 'hello', role: 'ui' } });
    for (let index = 0; index < 4; index++) await Promise.resolve();
    expect(packets.at(-1).payload).toEqual({ type: 'ack', sequence: 1 });
    channel.accept({ protocol: TERMINAL_PROTOCOL, instance: 'synthetic', sequence: 2, traffic: 'control', payload: { type: 'ack', sequence: packets[0].sequence } });
    expect(packets.at(-1).sequence).toBeGreaterThan(packets.at(-2).sequence);
    expect(packets.at(-1).payload).toEqual({ type: 'reply', id: 4 });
    channel.close(); await Promise.all([...pending, closing]); expect(failure).not.toHaveBeenCalled();
  });

  it('retains an immutable queued message and bounds its entire waiting lifetime', async () => {
    vi.useFakeTimers();
    try {
      const packets: any[] = [], failure = vi.fn();
      const channel = new TerminalChannel('synthetic', (packet, done) => { packets.push(packet); done(); }, () => {}, failure);
      const pending = Array.from({ length: 4 }, (_, id) => channel.send({ type: 'reply', id }).catch(error => error.message));
      const payload = { type: 'reply' as const, id: 4, value: 'retained' };
      pending.push(channel.send(payload).catch(error => error.message)); payload.value = 'changed';
      channel.accept({ protocol: TERMINAL_PROTOCOL, instance: 'synthetic', sequence: 1, traffic: 'control', payload: { type: 'ack', sequence: packets[0].sequence } });
      expect(packets.at(-1).payload.value).toBe('retained');
      pending.push(channel.send({ type: 'reply', id: 5 }).catch(error => error.message));
      await vi.advanceTimersByTimeAsync(TERMINAL_LIMITS.deliveryTimeoutMs);
      expect(failure).toHaveBeenCalledExactlyOnceWith('terminal-delivery-timeout');
      await Promise.all(pending);
      await expect(channel.send({ type: 'reply', id: 6 })).rejects.toThrow('channel-closed');
    } finally { vi.useRealTimers(); }
  });

  it('treats an unrepresentable control view as unavailable rather than silently losing it', async () => {
    const failure = vi.fn(), sent = vi.fn();
    const channel = new TerminalChannel('synthetic', sent, () => {}, failure);
    await expect(channel.send({ type: 'view', view: { generation: 1, kind: 'confirmation', title: 'synthetic', message: 'x'.repeat(TERMINAL_LIMITS.frameBytes) } })).rejects.toThrow('frame-too-large');
    expect(failure).toHaveBeenCalledExactlyOnceWith('terminal-control-frame-too-large');
    expect(sent).not.toHaveBeenCalled();
  });

  it('closes receive admission in the same handoff as the last completed ACK', async () => {
    let finishAck!: () => void;
    const receive = vi.fn(), failure = vi.fn();
    const channel = new TerminalChannel('synthetic', (_packet, done) => { finishAck = () => done(); }, receive, failure);
    const packet = { protocol: TERMINAL_PROTOCOL, instance: 'synthetic', sequence: 1, traffic: 'control' as const, payload: { type: 'hello' as const, role: 'ui' as const } };
    channel.accept(packet);
    const closing = channel.closeAfterReceived();
    for (let index = 0; index < 4; index++) await Promise.resolve();
    finishAck();
    await closing;
    channel.accept({ ...packet, sequence: 2 });
    await Promise.resolve();
    expect(receive).toHaveBeenCalledOnce(); expect(failure).not.toHaveBeenCalled();
    await expect(channel.send({ type: 'exit', code: 0, reason: 'user-exit' })).rejects.toThrow('channel-closed');
  });
});
