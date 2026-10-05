import { randomUUID } from 'node:crypto';
import type { DeviceCapacityArbiterPort, DeviceCapacityBudget } from '@zhixing/core/resources';
import type { RpcEncodedJsonSource } from '@zhixing/server/client';
import type { TerminalAssetAccount } from './asset-client.js';
import type { TerminalManagedFiles } from './managed-files.js';
import { terminalPhysicalStep } from './physical-step.js';

const PAGE_BYTES = 32 * 1024;
const allocated = (bytes: number) => Math.ceil(bytes / 4096) * 4096;
const bound: DeviceCapacityBudget = {
  occupancy: { memoryReservationBytes: 3 * 1024 * 1024, temporaryBytes: PAGE_BYTES, slots: 1 },
  quantum: { readBytes: PAGE_BYTES, writeBytes: PAGE_BYTES, ioOperations: 128 },
};
export interface PendingSessionSend extends RpcEncodedJsonSource { dispose(): Promise<void> }
interface Snapshot {
  readonly path: string;
  bytes: number; identity?: string; published: boolean; sealed: boolean; unknown: boolean;
  borrowers: number; drained?: () => void; closed?: Promise<void>;
}

/** Exactly one pending session.send owner, registered before its first write.
 * It is independent of draft/history collection. Unknown physical/account
 * outcomes remain charged and block reuse until the instance owner cleans up. */
export class TerminalPendingSendStore {
  #pending?: Snapshot;
  constructor(readonly files: TerminalManagedFiles, readonly capacity: DeviceCapacityArbiterPort,
    readonly account: TerminalAssetAccount, readonly signal: AbortSignal) {}

  async prepare(produce: (write: (bytes: Buffer) => Promise<void>) => Promise<number | undefined>, signal = this.signal): Promise<PendingSessionSend | undefined> {
    this.signal.throwIfAborted();
    if (this.#pending) throw Error('上一条发送参数仍在清理，草稿已保留。');
    const snapshot: Snapshot = { path: `input/send-${randomUUID()}`, bytes: 0, published: false, sealed: false, unknown: false, borrowers: 0 };
    this.#pending = snapshot;
    try {
      const expected = await produce(bytes => this.#write(snapshot, bytes, signal));
      signal.throwIfAborted();
      this.signal.throwIfAborted();
      if (expected === undefined) { await this.#dispose(snapshot); return undefined; }
      if (expected !== snapshot.bytes || !snapshot.identity || snapshot.unknown) throw Error('terminal-send-snapshot-incomplete');
      snapshot.published = true;
      return {
        byteLength: snapshot.bytes,
        open: () => this.#open(snapshot),
        dispose: () => this.#dispose(snapshot),
      };
    } catch (error) {
      await this.#dispose(snapshot).catch(() => {});
      throw error;
    }
  }

  async #write(snapshot: Snapshot, bytes: Buffer, signal: AbortSignal): Promise<void> {
    if (snapshot.sealed || snapshot.published || !bytes.length || bytes.length > PAGE_BYTES) throw Error('terminal-send-snapshot-write');
    await this.files.runOperation(async () => {
      signal.throwIfAborted(); this.signal.throwIfAborted();
      const next = snapshot.bytes + bytes.length;
      const charge = allocated(next) - allocated(snapshot.bytes);
      // Unknown reservation, write or settlement is never released by guess.
      snapshot.unknown = true;
      const token = await this.account.reserve('input', Math.max(1, charge));
      await terminalPhysicalStep(this.capacity, bound, signal, async step => {
        snapshot.identity = (await this.files.write(snapshot.path, bytes, snapshot.bytes, next, step, snapshot.identity)).identity;
      });
      await this.account.settle(token, charge);
      snapshot.bytes = next; snapshot.unknown = false;
    });
  }

  #open(snapshot: Snapshot) {
    if (!snapshot.published || snapshot.sealed || snapshot.unknown) throw Error('terminal-send-snapshot-unavailable');
    snapshot.borrowers++;
    let released = false, reading = false;
    return {
      read: async (offset: number, maximum: number, signal: AbortSignal): Promise<Buffer> => {
        if (released || reading || !Number.isSafeInteger(offset) || offset < 0 || offset >= snapshot.bytes ||
          !Number.isSafeInteger(maximum) || maximum < 1 || maximum > PAGE_BYTES) throw Error('terminal-send-snapshot-read');
        reading = true;
        try {
          signal.throwIfAborted();
          return await this.files.runOperation(() => terminalPhysicalStep(this.capacity, bound, signal, step =>
            this.files.read(snapshot.path, snapshot.bytes, offset, Math.min(maximum, snapshot.bytes - offset), snapshot.identity!, step)));
        } catch (error) { snapshot.unknown = true; throw error; }
        finally { reading = false; }
      },
      release: () => {
        if (released) return;
        if (reading) throw Error('terminal-send-snapshot-read-not-drained');
        released = true;
        if (--snapshot.borrowers === 0) snapshot.drained?.();
      },
    };
  }

  #dispose(snapshot: Snapshot): Promise<void> {
    snapshot.sealed = true;
    return snapshot.closed ??= (async () => {
      if (snapshot.borrowers) await new Promise<void>(resolve => { snapshot.drained = resolve; });
      if (snapshot.unknown) throw Error('terminal-send-snapshot-cleanup-unknown');
      if (snapshot.identity) await this.files.runOperation(async () => {
        snapshot.unknown = true;
        await terminalPhysicalStep(this.capacity, bound, this.signal, step => this.files.unlink(snapshot.path, snapshot.identity!, step));
        await this.account.released('input', allocated(snapshot.bytes));
        snapshot.unknown = false;
      });
      if (this.#pending === snapshot) this.#pending = undefined;
    })();
  }
}
