import { TerminalChannel } from './channel.js';
import { TerminalInputOwner } from './input-owner.js';
import { TERMINAL_LIMITS, type TerminalAction, type TerminalMessage } from './protocol.js';
import { consumeTerminalParentEndpoint, TerminalParentTransport } from './parent-transport.js';

const instance = process.env.ZHIXING_TERMINAL_INSTANCE;
const endpoint = consumeTerminalParentEndpoint();
if (!instance || !/^[a-f0-9-]{36}$/.test(instance) || endpoint === undefined) throw Error('The terminal UI requires its foreground supervisor.');
const transport = new TerminalParentTransport(endpoint);
const abort = new AbortController();
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
let admitRequests!: () => void, rejectAdmission!: (error: Error) => void;
const admission = new Promise<void>((resolve, reject) => { admitRequests = resolve; rejectAdmission = reject; });
void admission.catch(() => {});
let sequence = 0, phase: 'waiting' | 'querying' | 'ready' | 'active' | 'closing' = 'waiting';
let root: Awaited<ReturnType<typeof import('./root.js').createTerminalRoot>> | undefined;
let initializing: Promise<void> | undefined;
let closing: Promise<void> | undefined;
const input = new TerminalInputOwner(reason => void close(reason, 71));
const channel = new TerminalChannel(instance, (packet, done) => transport.send(packet, done), receive, reason => void close(reason, 71));

function request(action: TerminalAction): Promise<unknown> {
  if (abort.signal.aborted) return Promise.reject(Error('terminal-closed'));
  if (pending.size >= TERMINAL_LIMITS.pendingRequests) return Promise.reject(Error('terminal-request-capacity'));
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error('操作结果尚未确认；不会自动重发。')); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    // The initial render can request candidates before its first-frame ACK.
    // Keep those requests in the same bounded map until S admits business IPC.
    void admission.then(() => {
      abort.signal.throwIfAborted();
      if (!pending.has(id)) return;
      return channel.send({ type: 'request', id, action }, action.kind === 'input-part' ? 'body' : 'control');
    }).catch(error => {
      clearTimeout(timer); pending.delete(id); reject(error);
    });
  });
}

function receive(message: TerminalMessage): void {
  if (message.type === 'close') { void close('supervisor-close', 0, false); return; }
  if (abort.signal.aborted) return;
  switch (message.type) {
    case 'hello': {
      if (phase !== 'waiting' || message.role !== 'ui') throw Error('terminal-handshake-order');
      phase = 'querying';
      initializing = input.query(abort.signal).then(async originalMask => {
        abort.signal.throwIfAborted(); phase = 'ready';
        await channel.send({ type: 'modes', originalMask });
      });
      void initializing.catch(() => close('terminal-mode-query-failed', 71)); return;
    }
    case 'grant': {
      if (phase !== 'ready') throw Error('terminal-grant-order');
      initializing = (async () => {
        const { createTerminalRoot } = await import('./root.js');
        abort.signal.throwIfAborted();
        root = await createTerminalRoot({ signal: abort.signal, request,
          // The pinned lifecycle patch defers this private hook until the one
          // query reader relinquishes stdin. Keep that dependency at this edge.
          inputReady: renderer => input.handoff(renderer as unknown as { setupInput(): void }),
          exit: () => close('user-exit', 0) });
        if (abort.signal.aborted) { await root.dispose(); return; }
        phase = 'active';
        await channel.send({ type: 'ready', frameId: root.firstFrameId });
        admitRequests();
        await request({ kind: 'startup' });
      })();
      void initializing.catch(() => { if (!abort.signal.aborted) void close('terminal-initialization-failed', 71); }); return;
    }
    case 'reply': {
      const operation = pending.get(message.id);
      if (!operation) return;
      pending.delete(message.id); clearTimeout(operation.timer);
      if (message.error) operation.reject(Error(message.error)); else operation.resolve(message.value);
      return;
    }
    case 'view': case 'chunk': case 'invalidate': case 'display-page': case 'submission': case 'task-status': case 'process-status': root?.receive(message); return;
    default: throw Error('terminal-unexpected-message');
  }
}

function close(reason: string, code: number, notify = true): Promise<void> {
  if (closing) return closing;
  let resolveClosing!: () => void;
  closing = new Promise(resolve => { resolveClosing = resolve; });
  phase = 'closing'; abort.abort(); input.cancel();
  rejectAdmission(Error('terminal-closed'));
  for (const operation of pending.values()) { clearTimeout(operation.timer); operation.reject(Error('terminal-closed')); }
  pending.clear();
  void (async () => {
    const notified = notify && transport.connected ? channel.send({ type: 'exit', code, reason }) : undefined;
    void notified?.catch(() => {});
    await initializing?.catch(() => {});
    await root?.dispose(); root = undefined;
    process.stdin.pause(); process.stdin.unref?.();
    // S must retain our exit, and our accepted close must finish its ACK write,
    // before the UI releases the same transport. S's deadline still bounds U.
    await notified;
    await channel.closeAfterReceived();
    transport.close();
    process.exitCode = code;
  })().catch(() => { process.exitCode = 71; channel.close(); transport.close(); }).finally(resolveClosing);
  return closing;
}

transport.on('message', value => channel.accept(value));
transport.once('disconnect', () => void close('supervisor-disconnected', 70, false));
process.on('uncaughtException', () => void close('terminal-uncaught', 71));
process.on('unhandledRejection', () => void close('terminal-rejection', 71));
void channel.send({ type: 'hello', role: 'ui' }).catch(() => close('terminal-listener-undelivered', 71));
