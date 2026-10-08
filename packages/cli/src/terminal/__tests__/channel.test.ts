import { describe, expect, it, vi } from 'vitest';
import { TerminalChannel, TerminalChannelRetiredError } from '../../../../terminal-ui/src/channel.js';
import { TERMINAL_LIMITS, TERMINAL_PROTOCOL } from '@zhixing/terminal-ui/protocol';

describe('terminal independent control capacity', () => {
  it('retires only business, tolerates its genuine late ACK, and still rejects an unmatched ACK', async () => {
    const packets: any[] = [], failure = vi.fn();
    const channel = new TerminalChannel('synthetic', (packet, done) => { packets.push(packet); done(); }, () => {}, failure);
    const pending = Array.from({ length: 8 }, (_, id) => channel.send({ type: 'reply', id }).catch(error => error));
    channel.beginClose();
    expect((await Promise.all(pending)).every(error => error instanceof TerminalChannelRetiredError)).toBe(true);
    await expect(channel.send({ type: 'reply', id: 9 })).rejects.toBeInstanceOf(TerminalChannelRetiredError);
    const end = channel.send({ type: 'exit', code: 0, reason: 'user-exit' });
    for (const [index, packet] of [packets[0], packets.at(-1)].entries()) {
      channel.accept({ protocol: TERMINAL_PROTOCOL, instance: 'synthetic', sequence: index + 1, traffic: 'control', payload: { type: 'ack', sequence: packet.sequence } });
    }
    await end; expect(failure).not.toHaveBeenCalled();
    channel.accept({ protocol: TERMINAL_PROTOCOL, instance: 'synthetic', sequence: 3, traffic: 'control', payload: { type: 'ack', sequence: packets[0].sequence } });
    expect(failure).toHaveBeenCalledExactlyOnceWith('terminal-unmatched-ack');
  });

  it.each([false, true])('settles a receiving handler on retirement without swallowing a real error=%s', async real => {
    let reject!: (error: Error) => void;
    const sent = vi.fn(), failure = vi.fn();
    const channel = new TerminalChannel('synthetic', sent, () => new Promise<void>((_resolve, no) => { reject = no; }), failure);
    channel.accept({ protocol: TERMINAL_PROTOCOL, instance: 'synthetic', sequence: 1, traffic: 'body', payload: { type: 'reply', id: 1 } });
    await Promise.resolve(); channel.beginClose();
    reject(real ? Error('real receiver failure') : new TerminalChannelRetiredError());
    if (real) { await expect(channel.closeAfterReceived()).rejects.toThrow(); expect(failure).toHaveBeenCalledExactlyOnceWith('terminal-receive-failed'); }
    else { await channel.closeAfterReceived(); expect(failure).not.toHaveBeenCalled(); }
    expect(sent).not.toHaveBeenCalled();
  });

  it('keeps malformed traffic and failed lifecycle writes fatal during retirement', async () => {
    const failure = vi.fn();
    const channel = new TerminalChannel('synthetic', (_packet, done) => done(Error('real write failure')), () => {}, failure);
    channel.beginClose();
    await expect(channel.send({ type: 'exit', code: 0, reason: 'user-exit' })).rejects.toThrow();
    expect(failure).toHaveBeenCalledExactlyOnceWith('terminal-send-failed');
    const invalid = vi.fn(), peer = new TerminalChannel('synthetic', vi.fn(), () => {}, invalid);
    peer.beginClose(); peer.accept({ invalid: true });
    expect(invalid).toHaveBeenCalledExactlyOnceWith('terminal-invalid-envelope');
  });

  it('cancels a late ordinary ACK callback after retirement but preserves prior failures', async () => {
    for (const retireFirst of [false, true]) {
      let done!: (error: Error) => void;
      const failure = vi.fn();
      const channel = new TerminalChannel('synthetic', (_packet, finish) => { done = finish; }, () => {}, failure);
      channel.accept({ protocol: TERMINAL_PROTOCOL, instance: 'synthetic', sequence: 1, traffic: 'body', payload: { type: 'reply', id: 1 } });
      for (let i = 0; i < 6; i++) await Promise.resolve();
      if (retireFirst) channel.beginClose();
      done(Error('peer ended')); channel.beginClose();
      if (retireFirst) { await channel.closeAfterReceived(); expect(failure).not.toHaveBeenCalled(); }
      else { await expect(channel.closeAfterReceived()).rejects.toThrow(); expect(failure).toHaveBeenCalledExactlyOnceWith('terminal-ack-failed'); }
    }
  });

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
