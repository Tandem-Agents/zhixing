import { spawn } from 'node:child_process';
import type { CheckpointFilesystemProcess, CheckpointFilesystemProcessFactory } from './checkpoint-child-bridge.js';
import { retainCheckpointFilesystemCompletion } from './checkpoint-filesystem-completion.js';
export { checkpointFilesystemCompletion } from './checkpoint-filesystem-completion.js';

// Private to the existing filesystem bridge. One operation is sent at a time;
// these bounds include requests waiting for artifact verification or IO.
export const POSIX_FILESYSTEM_LIMITS = Object.freeze({
  requests: 16,
  queuedBytes: 2 * 1024 * 1024,
  frameBytes: 2 * 1024 * 1024,
  fileBytes: 1024 * 1024,
  handles: 256,
  closeMs: 1000,
});

type Waiter = {
  id: number;
  frame: string;
  bytes: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

/** A synchronous addon must never execute on S/N's event loop. The private Node
 * child owns all fds; its actual close event is the successful shutdown proof.
 * The containing execution domain owns process creation/kill when injected. */
export function ownedPosixFilesystem(
  timeoutMs: number,
  verify: () => Promise<string>,
  createProcess?: CheckpointFilesystemProcessFactory,
): { request<T>(op: string, input: Record<string, unknown>): Promise<T>; prepare(): Promise<void>; failed(): boolean; stop(remainingMs?: number): Promise<void> } {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new TypeError('Invalid filesystem operation timeout');
  let child: CheckpointFilesystemProcess | undefined;
  let preparing: Promise<string> | undefined;
  let starting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let exitResolve: (() => void) | undefined;
  let exited: Promise<void> | undefined;
  let closed = false, didExit = false, nextId = 0, heldBytes = 0, stderrBytes = 0;
  let failure: Error | undefined;
  let active: Waiter | undefined;
  const pending = new Map<number, Waiter>();
  const queue: Waiter[] = [];
  let response = Buffer.alloc(0);
  let responseBytes = 0;
  let closeDeadline = Infinity;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let closeReject: ((cause: Error) => void) | undefined;

  const error = (code: string, message: string): Error => Object.assign(Error(message), { code });
  const references = (enabled: boolean): void => {
    if (!child) return;
    enabled ? child.ref() : child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      const resource = stream as typeof stream & { ref?(): void; unref?(): void };
      enabled ? resource.ref?.() : resource.unref?.();
    }
  };
  const settle = (completion?: Promise<void>): void => {
    const cause = failure ?? error('ERR_CHECKPOINT_OWNER_CLOSED', 'Filesystem owner closed; pending effects are unconfirmed');
    if (completion) retainCheckpointFilesystemCompletion(cause, completion);
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.frame = '';
      waiter.reject(cause);
    }
    pending.clear(); queue.length = 0; active = undefined; heldBytes = 0; response = Buffer.alloc(0); responseBytes = 0;
  };
  const armCloseDeadline = (): void => {
    if (!closeReject) return;
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => closeReject!(error('ERR_CHECKPOINT_OWNER_EXIT_UNCONFIRMED', 'Filesystem owner exit was not confirmed before the close deadline')), Math.max(0, closeDeadline - performance.now()));
  };
  const stop = (remainingMs = POSIX_FILESYSTEM_LIMITS.closeMs): Promise<void> => {
    if (!Number.isFinite(remainingMs) || remainingMs < 0) return Promise.reject(new TypeError('Invalid filesystem close budget'));
    closed = true;
    // Repeated calls can shorten a containing shutdown's remaining budget, but
    // can never extend the first absolute deadline.
    const deadline = performance.now() + Math.min(remainingMs, POSIX_FILESYSTEM_LIMITS.closeMs);
    if (deadline < closeDeadline) { closeDeadline = deadline; armCloseDeadline(); }
    return stopping ??= (async () => {
      const actualCompletion = (async () => {
        try { await starting; } catch { /* Creation did not produce a process. */ }
        if (!child) try { await preparing; } catch { /* Verification retained no process. */ }
        if (child && !didExit) await exited;
      })();
      try {
        const completion = (async () => {
          // Artifact verification owns file resources too. A stalled verify is
          // a bounded close failure, never a false successful cleanup. Its
          // closed check prevents late process creation after this deadline.
          try { await starting; } catch { /* No successful startup to retain. */ }
          if (!child) try { await preparing; } catch { /* Verification retained no process. */ }
          if (!child || didExit) return;
          references(true);
          // SIGKILL interrupts a helper blocked inside the addon; a successful
          // signal alone is never the actual-exit proof.
          child.kill('SIGKILL');
          await exited;
        })();
        await new Promise<void>((resolve, reject) => {
          closeReject = reject; armCloseDeadline();
          void completion.then(resolve, reject);
        });
      } catch (cause) {
        failure ??= cause instanceof Error ? cause : Error('Filesystem owner termination failed');
        retainCheckpointFilesystemCompletion(cause, actualCompletion);
        throw cause;
      } finally {
        clearTimeout(closeTimer); closeReject = undefined;
        // Requests may fail within the close budget, but their callers retain
        // physical permits until verification and the real child have ended.
        settle(actualCompletion);
      }
    })();
  };
  const fail = (cause: unknown): void => {
    failure ??= cause instanceof Error ? cause : error('ERR_CHILD_PROCESS_PROTOCOL', 'Filesystem protocol failed');
    void stop().catch(() => { /* close() retains the actual-exit failure. */ });
  };

  const receive = (chunk: Buffer): void => {
    if (closed) return;
    // One outstanding operation means one frame. A second or unknown response
    // cannot be silently skipped, and a missing newline cannot grow forever.
    if (!Buffer.isBuffer(chunk) || responseBytes + chunk.length > POSIX_FILESYSTEM_LIMITS.frameBytes) { fail(error('ERR_CHILD_PROCESS_PROTOCOL', 'Filesystem response exceeds its bound')); return; }
    if (response.length < responseBytes + chunk.length) {
      const grown = Buffer.allocUnsafe(Math.min(POSIX_FILESYSTEM_LIMITS.frameBytes, Math.max(4096, responseBytes + chunk.length, response.length * 2)));
      response.copy(grown, 0, 0, responseBytes); response = grown;
    }
    const startOffset = responseBytes;
    chunk.copy(response, responseBytes); responseBytes += chunk.length;
    const chunkNewline = chunk.indexOf(10), newline = chunkNewline < 0 ? -1 : startOffset + chunkNewline;
    if (newline < 0) return;
    if (newline !== responseBytes - 1) { fail(error('ERR_CHILD_PROCESS_PROTOCOL', 'Unexpected filesystem response frames')); return; }
    try {
      const result = JSON.parse(response.toString('utf8', 0, newline)) as { id: number; ok: boolean; value?: unknown; error?: string; code?: string };
      if (!active || result.id !== active.id || typeof result.ok !== 'boolean') throw error('ERR_CHILD_PROCESS_PROTOCOL', 'Filesystem response identity mismatch');
      const waiter = active;
      pending.delete(waiter.id); heldBytes -= waiter.bytes; clearTimeout(waiter.timer);
      waiter.frame = '';
      active = undefined; response = Buffer.alloc(0); responseBytes = 0;
      if (result.ok) waiter.resolve(result.value);
      else waiter.reject(error(typeof result.code === 'string' ? result.code.slice(0, 64) : 'ERR_CHECKPOINT_OPERATION', typeof result.error === 'string' ? result.error.slice(0, 1024) : 'Filesystem operation failed'));
      if (!pending.size) references(false);
      pump();
    } catch (cause) { fail(cause); }
  };
  const prepare = (): Promise<string> => {
    if (closed) return Promise.reject(error('ERR_CHECKPOINT_OWNER_CLOSED', 'Filesystem owner closed'));
    return preparing ??= verify();
  };
  const start = (): Promise<void> => starting ??= (async () => {
    const artifact = await prepare();
    if (closed) throw error('ERR_CHECKPOINT_OWNER_CLOSED', 'Filesystem owner closed');
    const args = ['--input-type=commonjs', '--eval', POSIX_FILESYSTEM_CHILD, artifact];
    const current = createProcess ? createProcess(process.execPath, args) : spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child = current;
    exited = new Promise<void>(resolve => { exitResolve = resolve; });
    current.once('close', (exitCode, signal) => {
      didExit = true;
      if (!closed) failure ??= Object.assign(error('ERR_CHILD_PROCESS_EXITED', 'Filesystem owner exited'), { exitCode, signal });
      closed = true;
      settle(); exitResolve!();
    });
    current.on('error', fail); current.stdin.on('error', fail); current.stdout.on('error', fail); current.stderr.on('error', fail);
    current.stdout.on('data', receive);
    current.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 64 * 1024) fail(error('ERR_CHILD_PROCESS_PROTOCOL', 'Filesystem diagnostic output exceeds its bound'));
    });
    references(pending.size > 0);
  })();
  const pump = (): void => {
    if (closed || active || !queue.length) return;
    active = queue.shift()!;
    const waiter = active;
    void start().then(() => {
      if (closed || !child || active !== waiter) return;
      references(true);
      child.stdin.write(waiter.frame, 'utf8', cause => { if (cause) fail(cause); });
    }, fail);
  };
  const request = <T>(op: string, input: Record<string, unknown>): Promise<T> => {
    if (closed) return Promise.reject(failure ?? error('ERR_CHECKPOINT_OWNER_CLOSED', 'Filesystem owner closed'));
    // Reject before serialization/copying the only potentially large fields.
    if ((typeof input.data === 'string' && input.data.length > Math.ceil(POSIX_FILESYSTEM_LIMITS.fileBytes / 3) * 4) ||
        (typeof input.path === 'string' && (input.path.length > 32768 || Buffer.byteLength(input.path) > 32768)) ||
        (typeof input.limit === 'number' && input.limit > POSIX_FILESYSTEM_LIMITS.fileBytes) ||
        (Array.isArray(input.names) && input.names.length > 4096) ||
        (typeof input.maximumEntries === 'number' && input.maximumEntries > 4096))
      return Promise.reject(error('ERR_CHECKPOINT_CAPACITY', 'Filesystem operation exceeds its bound'));
    const id = ++nextId;
    const frame = `${JSON.stringify({ id, op, ...input })}\n`, bytes = Buffer.byteLength(frame);
    if (pending.size >= POSIX_FILESYSTEM_LIMITS.requests || bytes > POSIX_FILESYSTEM_LIMITS.frameBytes || heldBytes + bytes > POSIX_FILESYSTEM_LIMITS.queuedBytes)
      return Promise.reject(error('ERR_CHECKPOINT_CAPACITY', 'Filesystem request capacity exhausted'));
    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter = {
        id, frame, bytes, resolve: value => resolve(value as T), reject,
        timer: setTimeout(() => fail(error('ETIMEDOUT', 'Filesystem operation timed out; effects are unconfirmed')), timeoutMs),
      };
      pending.set(id, waiter); queue.push(waiter); heldBytes += bytes;
      pump();
    });
  };
  return { request, prepare: () => prepare().then(() => {}), failed: () => closed || failure !== undefined, stop };
}

// A fixed, package-owned finite protocol, not a general file/spawn service. The
// child inherits only private pipes and receives the already verified addon.
// A literal keeps deployment within the bridge's existing bundled entry point.
export const POSIX_FILESYSTEM_CHILD = String.raw`
'use strict';
const fs = require('node:fs');
if (process.platform === 'linux') {
  const version = process.report.getReport().header.glibcVersionRuntime ?? '';
  const [major, minor] = version.split('.').map(Number);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || major < 2 || (major === 2 && minor < 35)) throw Error('POSIX filesystem requires glibc 2.35 or later');
}
const native = require(process.argv[1]);
const handles = new Map();
let nextHandle = 0;
const maxFrame = 2 * 1024 * 1024;
const maxFile = 1024 * 1024;
const pause = new Int32Array(new SharedArrayBuffer(4));
function integer(value, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw Error('Invalid filesystem integer');
  return value;
}
function name(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,160}$/.test(value) || value === '.' || value === '..') throw Error('Invalid filesystem child');
  return value;
}
function get(id, write = false) {
  const entry = handles.get(integer(id));
  if (!entry || (write && entry.readOnly)) throw Error('Filesystem handle unavailable or read-only');
  return entry.fd;
}
function own(fd, readOnly = false) {
  if (fd === 0n) return 0;
  if (handles.size >= 256) { native.close(fd); throw Error('Filesystem handle capacity exhausted'); }
  const id = ++nextHandle;
  handles.set(id, { fd, readOnly });
  return id;
}
function requireHandleSlot() {
  if (handles.size >= 256) throw Error('Filesystem handle capacity exhausted');
}
function bytes(value, maximum = maxFile) {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4) throw Error('Filesystem bytes exceed bound');
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length > maximum || buffer.toString('base64') !== value) throw Error('Invalid filesystem bytes');
  return buffer;
}
function dispatch(r) {
  const n = () => name(r.name), h = write => get(r.parent, write);
  switch (r.op) {
    case 'openPath': {
      if (typeof r.path !== 'string' || Buffer.byteLength(r.path) > 32768 || typeof r.create !== 'boolean' || typeof r.readOnly !== 'boolean' || (r.create && r.readOnly)) throw Error('Invalid filesystem root');
      requireHandleSlot();
      return own(native.openPath(r.path, r.create, r.readOnly), r.readOnly);
    }
    case 'openDirectory': {
      requireHandleSlot();
      return own(native.openDirectory(h(r.create), n(), r.create), handles.get(r.parent).readOnly);
    }
    case 'identity': return native.identity(get(r.handle));
    case 'availableDiskBytes': return native.availableDiskBytes(get(r.handle));
    case 'statEntry': return native.statEntry(h(), n());
    case 'statFile': return native.statFile(h(), n());
    case 'statFiles': {
      if (!Array.isArray(r.names) || r.names.length > 4096) throw Error('File inventory exceeds bound');
      const fd = h(); return r.names.map(value => native.statFile(fd, name(value)));
    }
    case 'writeFile': return native.writeFile(h(true), n(), bytes(r.data));
    case 'writeAt': return native.writeAt(h(true), n(), integer(r.maximumBytes), integer(r.offset), bytes(r.data, 256 * 1024), r.identity ?? '');
    case 'writeRange': return native.writeRange(h(true), n(), integer(r.maximumBytes), integer(r.offset), bytes(r.data), r.identity ?? '');
    case 'copyRange': return native.copyRange(h(true), name(r.source), r.sourceIdentity, integer(r.sourceBytes), integer(r.sourceOffset), name(r.target), r.targetIdentity ?? '', integer(r.targetOffset), integer(r.length, maxFile));
    case 'readFile': {
      if (!Number.isSafeInteger(r.declaredBytes) || r.declaredBytes < -1) throw Error('Invalid declared file size');
      return native.readFile(h(), n(), r.declaredBytes, integer(r.offset), integer(r.limit, maxFile), r.identity ?? '', r.prefix === true).toString('base64');
    }
    case 'truncateFile': return native.truncateFile(h(true), n(), r.identity, integer(r.bytes));
    case 'listEntries': return native.listEntries(h(), integer(r.maximumEntries, 4096));
    case 'listEntryPage': return native.listEntryPage(h(), integer(r.offset, 4096), integer(r.limit, 32));
    case 'tryLock': {
      requireHandleSlot();
      return own(native.tryLock(h(true), n()));
    }
    case 'waitLock': {
      requireHandleSlot();
      const fd = h(!r.shared), child = n(), waitMs = integer(r.waitMs, 2000);
      const deadline = performance.now() + waitMs;
      do {
        const lock = r.shared ? native.tryReadLock(fd, child) : native.tryLock(fd, child);
        if (lock !== 0n) return own(lock);
        Atomics.wait(pause, 0, 0, Math.min(10, Math.max(1, deadline - performance.now())));
      } while (performance.now() < deadline);
      return 0;
    }
    case 'renameEntry': return native.renameEntry(get(r.sourceParent, true), name(r.sourceName), get(r.targetParent, true), name(r.targetName), r.replace === true);
    case 'unlinkEntry': {
      // N serializes the complete operation; S only collects after writers
      // have exited. Native namespace exclusion covers identity check + unlink.
      return native.unlinkEntry(h(true), n(), r.directory === true, r.retiredIdentity ?? '', r.expectedIdentity ?? '');
    }
    case 'sync': return native.sync(get(r.handle));
    case 'close': { const fd = get(r.handle); handles.delete(r.handle); return native.close(fd); }
    case 'readLocalProcessDeclaration': return native.readLocalProcessDeclaration(r.endpoint, integer(r.pid));
    default: throw Error('Unsupported POSIX filesystem operation');
  }
}
function reply(value) {
  const frame = Buffer.from(JSON.stringify(value) + '\n');
  if (frame.length > maxFrame) throw Error('Filesystem response exceeds bound');
  for (let offset = 0; offset < frame.length;) {
    const written = fs.writeSync(1, frame, offset, frame.length - offset);
    if (!written) throw Error('Filesystem reply made no progress');
    offset += written;
  }
}
let input = Buffer.alloc(0);
const chunk = Buffer.alloc(64 * 1024);
try {
  while (true) {
    const count = fs.readSync(0, chunk, 0, chunk.length, null);
    if (!count) break;
    if (input.length + count > maxFrame) throw Error('Filesystem request exceeds bound');
    input = Buffer.concat([input, chunk.subarray(0, count)]);
    const end = input.indexOf(10);
    if (end < 0) continue;
    if (end !== input.length - 1) throw Error('Concurrent filesystem request frames');
    const r = JSON.parse(input.toString('utf8', 0, end)); input = Buffer.alloc(0);
    integer(r.id);
    try { reply({ id: r.id, ok: true, value: dispatch(r) }); }
    catch (error) { reply({ id: r.id, ok: false, error: String(error.message).slice(0, 1024), code: typeof error.code === 'string' ? error.code.slice(0, 64) : undefined }); }
  }
} finally {
  for (const entry of handles.values()) { try { native.close(entry.fd); } catch {} }
}
`;
