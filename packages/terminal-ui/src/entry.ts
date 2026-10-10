import { TerminalChannel } from './channel.js';
import { TerminalInputOwner } from './input-owner.js';
import { TERMINAL_LIMITS, type TerminalAction, type TerminalMessage } from './protocol.js';
import { consumeTerminalParentEndpoint, TerminalParentTransport } from './parent-transport.js';

const instance = process.env.ZHIXING_TERMINAL_INSTANCE;
const endpoint = consumeTerminalParentEndpoint();
if (!instance || !/^[a-f0-9-]{36}$/.test(instance) || endpoint === undefined) throw Error('The terminal UI requires its foreground supervisor.');
const transport = new TerminalParentTransport(endpoint);
const abort = new AbortController();
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> }>();
let admitRequests!: () => void, rejectAdmission!: (error: Error) => void;
const admission = new Promise<void>((resolve, reject) => { admitRequests = resolve; rejectAdmission = reject; });
void admission.catch(() => {});
let sequence = 0, phase: 'waiting' | 'querying' | 'ready' | 'active' | 'closing' = 'waiting';
let root: Awaited<ReturnType<typeof import('./root.js').createTerminalRoot>> | undefined;
let initializing: Promise<void> | undefined;
let closing: Promise<void> | undefined;
let applicationReady = false;
let startupRequested = false;
const input = new TerminalInputOwner(reason => void close(reason, 71));
const channel = new TerminalChannel(instance, (packet, done) => transport.send(packet, done), receive, reason => void close(reason, 71));

function request(action: TerminalAction): Promise<unknown> {
  if (abort.signal.aborted) return Promise.reject(Error('terminal-closed'));
  if (!applicationReady && (action.kind === 'interrupt' || action.kind === 'exit')) {
    void close('user-exit', 0); return Promise.resolve({ accepted: true });
  }
  // No application operation exists to abort during preparation. In particular,
  // repeated Esc must not queue cancellations that later act on a new run.
  if (!applicationReady && action.kind === 'abort') return Promise.resolve({ accepted: true });
  // First-frame input must not consume the slot required to start the app.
  // Keep the same total budget, including across the readiness microtasks.
  const capacity = TERMINAL_LIMITS.pendingRequests - (!startupRequested && action.kind !== 'startup' ? 1 : 0);
  if (pending.size >= capacity) return Promise.reject(Error('terminal-request-capacity'));
  if (action.kind === 'startup') startupRequested = true;
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // Preparation is bounded by S. A queued local intent has not yet been
    // delivered, so neither transport nor operation timeouts start here.
    void admission.then(() => {
      abort.signal.throwIfAborted();
      const operation = pending.get(id);
      if (!operation) return;
      operation.timer = setTimeout(() => { pending.delete(id); reject(Error('操作结果尚未确认；不会自动重发。')); }, 30_000);
      return channel.send({ type: 'request', id, action }, action.kind === 'input-part' || action.kind === 'recovery-part' ? 'body' : 'control');
    }).catch(error => {
      clearTimeout(pending.get(id)?.timer); pending.delete(id); reject(error);
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
      initializing = input.query(abort.signal).then(async baseline => {
        abort.signal.throwIfAborted(); phase = 'ready';
        await channel.send({ type: 'modes', ...baseline });
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
          usableFrame: frameId => { void channel.send({ type: 'usable-frame', frameId }).catch(() => { if (!abort.signal.aborted) void close('terminal-ready-observation-undelivered', 71); }); },
          exit: () => close('user-exit', 0) });
        if (abort.signal.aborted) { await root.dispose(); return; }
        phase = 'active';
        await channel.send({ type: 'ready', frameId: root.firstFrameId });
        await admission;
        await request({ kind: 'startup' });
      })();
      void initializing.catch(() => { if (!abort.signal.aborted) void close('terminal-initialization-failed', 71); }); return;
    }
    case 'application-ready': {
      if (phase !== 'active' || applicationReady) throw Error('terminal-application-ready-order');
      applicationReady = true; admitRequests(); return;
    }
    case 'reply': {
      const operation = pending.get(message.id);
      if (!operation) return;
      pending.delete(message.id); clearTimeout(operation.timer);
      if (message.error) operation.reject(Error(message.error)); else operation.resolve(message.value);
      return;
    }
    case 'view': case 'chunk': case 'invalidate': case 'display-page': case 'display-patch': case 'submission': case 'task-status': case 'process-status': case 'recovery-page': root?.receive(message); return;
    default: throw Error('terminal-unexpected-message');
  }
}

function close(reason: string, code: number, notify = true): Promise<void> {
  if (closing) return closing;
  let resolveClosing!: () => void;
  closing = new Promise(resolve => { resolveClosing = resolve; });
  channel.beginClose();
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
