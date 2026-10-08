import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { CheckpointDirectoryHandle, type CheckpointFilesystemSession } from '@zhixing/mesh/filesystem';
import type { DeviceCapacityArbiterPort, DeviceCapacityStepPermit } from '@zhixing/core/resources';
import { TERMINAL_LIMITS } from '@zhixing/terminal-ui/protocol';
import { terminalMetadataStep, terminalPhysicalStep } from './physical-step.js';
import { closeTerminalFiles } from './close-budget.js';

export interface TerminalProcessIdentity { readonly pid: number; readonly birth: string; readonly spawnId: string; readonly exited?: true }
export interface TerminalIdentityResolver { read(pid: number): Promise<{ kind: 'present'; birth: string } | { kind: 'absent' | 'unknown' }> }
type Bucket = 'display' | 'input';
interface Reservation { bucket: Bucket; bytes: number }
interface CreationIntent { role: 'application' | 'ui'; spawnId: string; state: 'gate-unreleased' }
interface InstanceWriter { role: 'filesystem'; owner: string; state: 'gate-unreleased' | 'bound'; identity?: TerminalProcessIdentity; wrapped?: true }
interface InstanceRecord {
  version: 2 | 3; id: string; directoryIdentity: string; owner: TerminalProcessIdentity;
  roles: Partial<Record<'application' | 'ui' | 'recovery', TerminalProcessIdentity>>;
  pendingRoles: ('application' | 'ui' | CreationIntent)[];
  previousIdentity?: string;
  writers?: Record<string, InstanceWriter>;
  displayBytes: number; inputBytes: number;
  reservations: Record<string, Reservation>;
  cleanup?: TerminalProcessIdentity;
  cleanupWriters?: TerminalProcessIdentity[];
}
const ID = /^[a-f0-9-]{36}$/u;
// Five bounded process identities, 32 reservation heads, and their envelope.
// Reject foreign fields before carrying a header between physical steps.
const RECORD_BYTES = 16 * 1024;
const META_RESERVE = 16 * 1024 * 1024;
const ROOT_BUSY = Symbol('root-busy');
const ROOT_CHANGED = Symbol('root-changed');
const FILE_BATCH = 32;

/** S owns the shared root account. Only known instance paths leave this owner. */
export class TerminalInstanceAssets {
  readonly root: string;
  #record?: InstanceRecord;
  #serial = Promise.resolve();
  #pending = 0;
  #directory?: Promise<CheckpointDirectoryHandle>;
  #closing?: Promise<void>;
  readonly #filesystem: CheckpointFilesystemSession;
  readonly #cleanupId = randomUUID();
  readonly #recordIdentities = new WeakMap<InstanceRecord, string>();
  readonly #finalizing = new WeakSet<InstanceRecord>();

  constructor(home: string, readonly capacity: DeviceCapacityArbiterPort, readonly identity: TerminalIdentityResolver, filesystem = CheckpointDirectoryHandle.createSession(), readonly filesystemWriter?: () => Promise<TerminalProcessIdentity>) {
    this.root = path.resolve(home, 'temporary', 'terminal');
    this.#filesystem = filesystem;
  }

  get instancePath(): string {
    if (!this.#record) throw Error('terminal-instance-not-admitted');
    return path.join(this.root, `instance-${this.#record.id}`);
  }
  get instanceIdentity(): string {
    if (!this.#record) throw Error('terminal-instance-not-admitted');
    return this.#record.directoryIdentity;
  }

  async admit(id: string, recovery: TerminalProcessIdentity, signal: AbortSignal): Promise<string> {
    if (!ID.test(id) || this.#record) throw Error('terminal-instance-id');
    const owner = await this.identity.read(process.pid);
    if (owner.kind !== 'present') throw Error('terminal-owner-identity');
    await this.#enqueue(async () => {
      const records = await this.#locked(signal, step => this.#records(step));
      for (const record of records) {
        const members = [record.owner, ...Object.values(record.roles), ...Object.values(record.writers ?? {}).flatMap(writer => writer.identity ? [writer.identity] : []), ...(record.cleanupWriters ?? [])];
        // Version 3 intents prove that no execution permit can precede a
        // durable identity bind. An absent S cannot issue a future permit.
        // Old string-only intents contain no such evidence and stay unknown.
        let dead = record.version === 3 && record.pendingRoles.every(intent => typeof intent === 'object' && intent.state === 'gate-unreleased');
        // A Windows Node gate's PID does not prove its target exited after an
        // unobserved owner death. Only the live Job/close receipt can settle it.
        if (Object.values(record.writers ?? {}).some(writer => writer.wrapped && writer.state === 'bound')) dead = false;
        for (const member of members) {
          if (member.exited) continue;
          const observed = await this.identity.read(member.pid);
          // A reused or unreadable PID protects the old assets; no guesswork.
          if (observed.kind !== 'absent') dead = false;
        }
        if (dead) await this.#remove(record, signal).catch(() => {});
      }
      await this.#withInventory(signal, async (remaining, physical, step) => {
        await this.#canReserve(remaining, physical, 'display', TERMINAL_LIMITS.startupReservationBytes, true, step);
        const record: InstanceRecord = {
          version: 3, id, directoryIdentity: '', owner: { pid: process.pid, birth: owner.birth, spawnId: randomUUID() },
          roles: { recovery }, pendingRoles: [], writers: {}, displayBytes: META_RESERVE, inputBytes: 0,
          reservations: { startup: { bucket: 'display', bytes: TERMINAL_LIMITS.startupReservationBytes - META_RESERVE } },
        };
        const root = await this.#root(step);
        if ((await this.#rootEntries(step)).includes(`instance-${id}`)) throw Error('terminal-instance-already-exists');
        step.claim('ioOperations', 6);
        const directory = await root.openDirectory(`instance-${id}`, true);
        record.directoryIdentity = directory.identity;
        if (this.filesystemWriter) {
          const writer = await this.filesystemWriter();
          record.writers![writer.spawnId] = { role: 'filesystem', owner: record.owner.spawnId, state: 'bound', identity: writer };
        }
        try { for (const child of ['display', 'input', 'runtime']) {
          step.claim('ioOperations', 6); await (await directory.openDirectory(child, true)).close();
        } } finally { await directory.close(); }
        await this.#publish(record, step);
        this.#record = record;
      });
    });
    return this.instancePath;
  }

  async intent(role: 'application' | 'ui', signal: AbortSignal, spawnId = randomUUID()): Promise<string> {
    if (!ID.test(spawnId)) throw Error('terminal-role-spawn-identity');
    await this.#update(signal, record => {
      if (record.roles[role] || record.pendingRoles.some(value => (typeof value === 'string' ? value : value.role) === role)) throw Error('terminal-role-already-registered');
      record.pendingRoles.push({ role, spawnId, state: 'gate-unreleased' });
    });
    return spawnId;
  }

  bind(role: 'application' | 'ui', identity: TerminalProcessIdentity, signal: AbortSignal): Promise<void> {
    return this.#update(signal, record => {
      const intent = record.pendingRoles.find(value => typeof value === 'object' && value.role === role);
      if (!intent || typeof intent !== 'object' || intent.spawnId !== identity.spawnId || record.roles[role]) throw Error('terminal-role-bind-order');
      record.roles[role] = identity;
      record.pendingRoles = record.pendingRoles.filter(value => (typeof value === 'string' ? value : value.role) !== role);
    });
  }

  writerIntent(spawnId: string, owner: string, signal: AbortSignal): Promise<void> {
    if (!ID.test(spawnId) || !ID.test(owner)) return Promise.reject(Error('terminal-writer-identity'));
    return this.#update(signal, record => {
      if (!record.writers || record.writers[spawnId] || Object.keys(record.writers).length >= 32) throw Error('terminal-writer-capacity');
      record.writers[spawnId] = { role: 'filesystem', owner, state: 'gate-unreleased' };
    });
  }
  bindWriter(identity: TerminalProcessIdentity, signal: AbortSignal): Promise<void> {
    return this.#update(signal, record => {
      const writer = record.writers?.[identity.spawnId];
      if (!writer || writer.state !== 'gate-unreleased') throw Error('terminal-writer-bind-order');
      writer.state = 'bound'; writer.identity = identity;
    });
  }
  settleWriter(spawnId: string, identity: TerminalProcessIdentity | undefined, signal: AbortSignal): Promise<void> {
    return this.#update(signal, record => {
      const writer = record.writers?.[spawnId];
      if (!writer || (writer.identity && (!identity || writer.identity.pid !== identity.pid || writer.identity.birth !== identity.birth || identity.spawnId !== spawnId))) throw Error('terminal-writer-exit-identity');
      delete record.writers![spawnId];
    });
  }

  settleRole(role: 'application' | 'ui', receipt: { pid?: number; spawnId: string; born?: string; kind: 'not-created' | 'exited' }, signal: AbortSignal): Promise<void> {
    return this.#update(signal, record => {
      const registered = record.roles[role];
      if (registered && receipt.kind === 'exited' && registered.pid === receipt.pid && registered.spawnId === receipt.spawnId) record.roles[role] = { ...registered, exited: true };
      else if (!registered && record.pendingRoles.some(value => typeof value === 'object' && value.role === role && value.spawnId === receipt.spawnId)) {
        if (receipt.kind === 'exited' && receipt.pid) record.roles[role] = { pid: receipt.pid, birth: receipt.born ?? 'exited-before-bind', spawnId: receipt.spawnId, exited: true };
        record.pendingRoles = record.pendingRoles.filter(value => (typeof value === 'string' ? value : value.role) !== role);
      } else if (registered || record.pendingRoles.some(value => (typeof value === 'string' ? value : value.role) === role)) throw Error('terminal-exit-receipt-mismatch');
    });
  }

  reserve(bucket: Bucket, bytes: number, signal: AbortSignal): Promise<string> {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > TERMINAL_LIMITS.storageReservationBytes) return Promise.reject(Error('terminal-storage-step-size'));
    return this.#enqueue(() => this.#withInventory(signal, async (all, physical, step) => {
      const record = this.#ownRecord(all);
      if (Object.keys(record.reservations).length >= 32) throw Error('terminal-storage-reservation-slots');
      await this.#canReserve(all, physical, bucket, bytes, false, step);
      const token = randomUUID(); record.reservations[token] = { bucket, bytes };
      await this.#publish(record, step); this.#record = record; return token;
    }));
  }

  settle(token: string, actualBytes: number, signal: AbortSignal): Promise<void> {
    return this.#update(signal, record => {
      const reservation = record.reservations[token];
      if (!reservation || !Number.isSafeInteger(actualBytes) || actualBytes < 0 || actualBytes > reservation.bytes) throw Error('terminal-storage-settlement');
      if (reservation.bucket === 'display') record.displayBytes += actualBytes; else record.inputBytes += actualBytes;
      delete record.reservations[token];
    });
  }

  released(bucket: Bucket, bytes: number, signal: AbortSignal): Promise<void> {
    return this.#update(signal, record => {
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw Error('terminal-storage-release-size');
      const key = bucket === 'display' ? 'displayBytes' : 'inputBytes';
      if (record[key] - bytes < (bucket === 'display' ? META_RESERVE : 0)) throw Error('terminal-storage-release-underflow');
      record[key] -= bytes;
    });
  }

  async release(signal: AbortSignal): Promise<void> {
    if (!this.#record) return;
    await this.#enqueue(async () => {
      const record = await this.#locked(signal, step => this.#own(step), true);
      if (record.pendingRoles.length || ['application', 'ui'].some(role => record.roles[role as 'application' | 'ui'] && !record.roles[role as 'application' | 'ui']!.exited)) throw Error('terminal-assets-writers-not-exited');
      const collector = await this.filesystemWriter?.();
      if (Object.entries(record.writers ?? {}).some(([id, writer]) => !collector || id !== collector.spawnId || writer.identity?.pid !== collector.pid || writer.identity.birth !== collector.birth)) throw Error('terminal-assets-helper-not-exited');
      await this.#remove(record, signal); this.#record = undefined;
    });
  }

  #update(signal: AbortSignal, change: (record: InstanceRecord) => void): Promise<void> {
    return this.#transaction(signal, async step => {
      const record = await this.#own(step); change(record); await this.#publish(record, step); this.#record = record;
    });
  }

  #transaction<T>(signal: AbortSignal, run: (step: DeviceCapacityStepPermit) => Promise<T>, recovery = false): Promise<T> {
    return this.#enqueue(() => this.#locked(signal, run, recovery));
  }

  #enqueue<T>(run: () => Promise<T>): Promise<T> {
    if (this.#closing || this.#pending >= 32) return Promise.reject(Error('terminal-root-operation-capacity'));
    this.#pending++;
    const task = this.#serial.then(run).finally(() => { this.#pending--; });
    this.#serial = task.then(() => {}, () => {});
    return task;
  }

  async #locked<T>(signal: AbortSignal, run: (step: DeviceCapacityStepPermit) => Promise<T>, recovery = false): Promise<T> {
    const deadline = performance.now() + 1000;
    for (;;) {
      const result = await terminalPhysicalStep(this.capacity, terminalMetadataStep, signal, async step => {
        const root = await this.#root(step);
        // Permanent, empty OS lock; no pathname-based stale lock reclamation.
        // Acquire the whole finite operation before entering the mutex.
        step.claim('ioOperations', 8);
        const unlock = await root.tryLock('owner.lock');
        if (!unlock) return ROOT_BUSY;
        try { return await run(step); } finally { await unlock(); }
      }, recovery);
      if (result !== ROOT_BUSY) return result as T;
      if (performance.now() >= deadline) throw Error('terminal-root-busy');
      // Both the OS mutex and the physical permit have ended before backing off.
      await delay(10, undefined, { signal });
    }
  }

  async #withInventory<T>(signal: AbortSignal, run: (records: InstanceRecord[], physical: ReadonlyMap<string, number>, step: DeviceCapacityStepPermit) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = await this.#locked(signal, step => this.#records(step));
      const physical = new Map<string, number>();
      for (const record of snapshot) physical.set(record.id, await this.#physicalBytes(record, signal));
      const result = await this.#locked(signal, async step => {
        const current = await this.#records(step);
        if (recordsSignature(current) !== recordsSignature(snapshot)) return ROOT_CHANGED;
        return run(current, physical, step);
      });
      if (result !== ROOT_CHANGED) return result as T;
    }
    throw Error('terminal-root-changing');
  }

  async #records(step: DeviceCapacityStepPermit): Promise<InstanceRecord[]> {
    const entries = await this.#rootEntries(step);
    const folders = entries.filter(entry => entry.startsWith('instance-'));
    const markers = entries.filter(entry => /^cleanup-[a-f0-9-]{36}\.json$/u.test(entry));
    const ids = new Set([...folders.map(name => name.slice(9)), ...markers.map(name => name.slice(8, -5))]);
    if (entries.some(entry => entry !== 'owner.lock' && !/^instance-[a-f0-9-]{36}$/u.test(entry) && !markers.includes(entry)) || ids.size > TERMINAL_LIMITS.rootInstances) throw Error('terminal-root-unknown-residue');
    const records: InstanceRecord[] = [];
    for (const marker of markers) {
      step.claim('ioOperations', 12);
      const root = await this.#root(step), info = await root.statFile(marker);
      if (info.bytes > RECORD_BYTES) throw Error('terminal-cleanup-record-size');
      step.claim('readBytes', info.bytes);
      const value: unknown = JSON.parse((await root.readFile(marker, info.bytes, 0, RECORD_BYTES, info.identity)).toString('utf8'));
      if (!validRecord(value) || !value.cleanup || marker !== `cleanup-${value.id}.json`) throw Error('terminal-cleanup-record-unknown');
      const folder = `instance-${value.id}`;
      if (folders.includes(folder)) {
        const directory = await root.openDirectory(folder, false);
        try {
          if (directory.identity !== value.directoryIdentity || (await directory.listEntries(1)).length) throw Error('terminal-cleanup-directory-changed');
        } finally { await directory.close(); }
      }
      this.#recordIdentities.set(value, info.identity); this.#finalizing.add(value); records.push(value);
    }
    for (const folder of folders) {
      if (markers.includes(`cleanup-${folder.slice(9)}.json`)) continue;
      records.push(await this.#readRecord(folder, step));
    }
    return records;
  }

  async #readRecord(folder: string, step: DeviceCapacityStepPermit): Promise<InstanceRecord> {
    step.claim('ioOperations', 14);
    const directory = await (await this.#root(step)).openDirectory(folder, false);
    try {
      await this.#recoverPublication(directory, step, folder.slice('instance-'.length));
      const info = await directory.statFile('owner.json');
      if (info.bytes > RECORD_BYTES) throw Error('terminal-instance-record-size');
      step.claim('readBytes', info.bytes);
      const bytes = await directory.readFile('owner.json', info.bytes, 0, RECORD_BYTES, info.identity);
      const value: unknown = JSON.parse(bytes.toString('utf8'));
      if (!validRecord(value) || folder !== `instance-${value.id}` || value.directoryIdentity !== directory.identity) throw Error('terminal-instance-record-unknown');
      this.#recordIdentities.set(value, info.identity);
      return value;
    } finally { await directory.close(); }
  }

  async #own(step: DeviceCapacityStepPermit): Promise<InstanceRecord> {
    if (!this.#record) throw Error('terminal-instance-not-admitted');
    // Settlement/identity updates cannot increase the admitted root budget.
    // Verify the private durable record under the same root lock, without
    // rescanning unrelated instances. New reservations still inventory all.
    const record = await this.#readRecord(`instance-${this.#record.id}`, step);
    if (record.directoryIdentity !== this.#record.directoryIdentity) throw Error('terminal-instance-directory-changed');
    return this.#ownRecord([record]);
  }

  #ownRecord(records: InstanceRecord[]): InstanceRecord {
    if (!this.#record) throw Error('terminal-instance-not-admitted');
    const record = records.find(value => value.id === this.#record!.id);
    if (!record || record.owner.pid !== process.pid || record.owner.birth !== this.#record.owner.birth) throw Error('terminal-instance-owner-changed');
    if (record.cleanup) throw Error('terminal-instance-reclaiming');
    return record;
  }

  async #canReserve(records: InstanceRecord[], physicalBytes: ReadonlyMap<string, number>, bucket: Bucket, bytes: number, newInstance: boolean, step: DeviceCapacityStepPermit): Promise<void> {
    let total = 0, display = 0, promised = 0;
    for (const record of records) {
      let a = record.displayBytes, p = record.inputBytes;
      for (const reservation of Object.values(record.reservations)) {
        promised += reservation.bytes;
        if (reservation.bucket === 'display') a += reservation.bytes; else p += reservation.bytes;
      }
      // The durable ledger is a reservation account, not proof that the disk
      // contains no additional bytes. Unknown/partial allocation stays charged.
      const physical = physicalBytes.get(record.id);
      if (physical === undefined) throw Error('terminal-root-inventory-incomplete');
      a = Math.max(a, physical - p);
      total += a + p; display += a;
      if (a + (record.id === this.#record?.id && bucket === 'display' ? bytes : 0) > TERMINAL_LIMITS.instanceBytes) throw Error('terminal-instance-display-capacity');
    }
    if (records.length + (newInstance ? 1 : 0) > TERMINAL_LIMITS.rootInstances || total + bytes > TERMINAL_LIMITS.rootBytes || display + (bucket === 'display' ? bytes : 0) > TERMINAL_LIMITS.rootDisplayBytes) throw Error('terminal-root-capacity');
    step.claim('ioOperations', 3);
    const available = await (await this.#root(step)).availableDiskBytes();
    if (available - promised - bytes < TERMINAL_LIMITS.freeDiskBytes) throw Error('terminal-disk-capacity');
  }

  async #rootEntries(step: DeviceCapacityStepPermit): Promise<string[]> {
    step.claim('ioOperations', 3);
    return [...await (await this.#root(step)).listEntries(64)];
  }

  #physicalBytes(record: InstanceRecord, signal: AbortSignal): Promise<number> {
    if (this.#finalizing.has(record)) return Promise.resolve(RECORD_BYTES + 4096);
    return this.#walk(record, signal, false);
  }

  /** Only names and identities survive a batch. Every leaf/directory work
   * handle closes before that batch releases its physical permit. */
  async #folder<T>(record: InstanceRecord, chain: readonly { name: string; identity: string }[], step: DeviceCapacityStepPermit,
    work: (folder: CheckpointDirectoryHandle) => Promise<T>): Promise<T> {
    const handles: CheckpointDirectoryHandle[] = [];
    try {
      step.claim('ioOperations', 6);
      let folder = await (await this.#root(step)).openDirectory(`instance-${record.id}`, false); handles.push(folder);
      if (folder.identity !== record.directoryIdentity) throw Error('terminal-instance-directory-changed');
      for (const child of chain) {
        step.claim('ioOperations', 6); folder = await folder.openDirectory(child.name, false); handles.push(folder);
        if (folder.identity !== child.identity) throw Error('terminal-assets-directory-changed');
      }
      return await work(folder);
    } finally { for (const handle of handles.reverse()) await handle.close(); }
  }

  async #walk(record: InstanceRecord, signal: AbortSignal, cleanup: boolean): Promise<number> {
    let bytes = 0;
    const batch = <T>(chain: readonly { name: string; identity: string }[], work: (folder: CheckpointDirectoryHandle, step: DeviceCapacityStepPermit) => Promise<T>) => {
      const run = async (step: DeviceCapacityStepPermit) => {
        if (cleanup) await this.#assertCleanup(record, step);
        return this.#folder(record, chain, step, folder => work(folder, step));
      };
      return cleanup ? this.#locked(signal, run, true) : terminalPhysicalStep(this.capacity, terminalMetadataStep, signal, run);
    };
    const visit = async (chain: readonly { name: string; identity: string }[]): Promise<void> => {
      if (chain.length > 16) throw Error('terminal-assets-unknown-depth');
      let offset = 0, visited = 0;
      for (;;) {
        const page = await batch(chain, async (folder, step) => {
          // Restarting ordinal enumeration closes its work handle each step.
          // At most 4,096 names are scanned in native 64 KiB buffers; only 32
          // names cross the bridge, and no whole index remains in memory.
          step.claim('ioOperations', 64);
          return folder.listEntryPage(offset, FILE_BATCH);
        });
        visited += page.names.length;
        if (visited > 4096) throw Error('terminal-assets-inventory-size');
        const children: { name: string; identity: string }[] = [];
        await batch(chain, async (folder, step) => {
          for (const name of page.names) {
            if (!chain.length && !['owner.json', 'owner.next', 'display', 'input', 'runtime'].includes(name)) throw Error('terminal-assets-unknown-entry');
            step.claim('ioOperations', cleanup ? 12 : 6);
            const info = await folder.statEntry(name);
            const size = Math.max(info.bytes, info.allocatedBytes);
            if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(bytes + size)) throw Error('terminal-assets-size');
            bytes += size;
            if (info.kind === 'directory') children.push({ name, identity: info.identity });
            else if (cleanup && (chain.length || !['owner.json', 'owner.next'].includes(name))) await folder.unlink(name, false, info.identity);
          }
        });
        for (const child of children) {
          await visit([...chain, child]);
          if (cleanup) await batch(chain, async (folder, step) => {
            step.claim('ioOperations', 8); await folder.unlink(child.name, true, child.identity);
          });
        }
        if (page.end) break;
        // A collector has removed this prefix; ordinary inventory advances.
        if (!cleanup) offset += page.names.length;
      }
    };
    await visit([]); return bytes;
  }

  async #publish(record: InstanceRecord, step: DeviceCapacityStepPermit): Promise<void> {
    step.claim('ioOperations', 32);
    const directory = await (await this.#root(step)).openDirectory(`instance-${record.id}`, false);
    try {
      if (directory.identity !== record.directoryIdentity) throw Error('terminal-instance-directory-changed');
      await this.#recoverPublication(directory, step, record.id);
      const names = await directory.listEntries(8);
      const previous = names.includes('owner.json') ? await directory.statFile('owner.json') : undefined;
      if ((previous?.identity ?? '') !== (this.#recordIdentities.get(record) ?? '')) throw Error('terminal-publication-predecessor-changed');
      record.previousIdentity = previous?.identity ?? '';
      if (record.pendingRoles.some(value => typeof value === 'string')) throw Error('terminal-legacy-creation-unknown');
      record.version = 3;
      const bytes = Buffer.from(JSON.stringify(record));
      if (bytes.length > RECORD_BYTES) throw Error('terminal-instance-record-capacity');
      step.claim('writeBytes', bytes.length);
      await directory.writeFile('owner.next', bytes);
      await directory.renameTo('owner.next', directory, 'owner.json', true);
      await directory.sync();
      this.#recordIdentities.set(record, (await directory.statFile('owner.json')).identity);
    } finally { await directory.close(); }
  }

  /** Finish the original published-intent bytes, never overwrite a leftover
   * candidate or manufacture a replacement from a stale in-memory record. */
  async #recoverPublication(directory: CheckpointDirectoryHandle, step: DeviceCapacityStepPermit, id: string): Promise<void> {
    step.claim('ioOperations', 16);
    const names = await directory.listEntries(8);
    if (!names.includes('owner.next')) return;
    const read = async (name: string) => {
      const info = await directory.statFile(name);
      if (info.bytes > RECORD_BYTES) throw Error('terminal-publication-capacity');
      step.claim('readBytes', info.bytes);
      const bytes = await directory.readFile(name, info.bytes, 0, RECORD_BYTES, info.identity);
      const value: unknown = JSON.parse(bytes.toString('utf8'));
      if (!validRecord(value) || value.id !== id || value.directoryIdentity !== directory.identity) throw Error('terminal-publication-unknown');
      return { info, bytes, value };
    };
    const next = await read('owner.next');
    const previous = names.includes('owner.json') ? await read('owner.json') : undefined;
    const chained = next.value.version === 3 && next.value.previousIdentity === (previous?.info.identity ?? '') &&
      (!previous || (next.value.id === previous.value.id && JSON.stringify(next.value.owner) === JSON.stringify(previous.value.owner)));
    // A legacy identical duplicate adds no new authority. Other legacy next
    // records lack predecessor evidence and must remain unknown.
    const duplicate = previous && next.bytes.equals(previous.bytes);
    if (!chained && !duplicate) throw Error('terminal-publication-predecessor-unknown');
    await directory.renameTo('owner.next', directory, 'owner.json', true);
    await directory.sync();
  }

  async #remove(record: InstanceRecord, signal: AbortSignal): Promise<void> {
    const self = await this.identity.read(process.pid);
    if (self.kind !== 'present') throw Error('terminal-cleanup-owner-unknown');
    if (record.cleanup && !(record.cleanup.pid === process.pid && record.cleanup.birth === self.birth && record.cleanup.spawnId === this.#cleanupId)) {
      if ((await this.identity.read(record.cleanup.pid)).kind !== 'absent') throw Error('terminal-cleanup-busy');
      for (const writer of record.cleanupWriters ?? []) if ((await this.identity.read(writer.pid)).kind !== 'absent') throw Error('terminal-cleanup-writer-busy');
    }
    if (this.#finalizing.has(record)) {
      await this.#locked(signal, async step => {
        const current = (await this.#records(step)).find(value => value.id === record.id);
        if (!current || !this.#finalizing.has(current) || JSON.stringify(current) !== JSON.stringify(record)) throw Error('terminal-cleanup-record-changed');
        await this.#finishRemoval(current, step);
      }, true);
      return;
    }
    await this.#locked(signal, async step => {
      const current = (await this.#records(step)).find(value => value.id === record.id);
      if (!current || JSON.stringify(current) !== JSON.stringify(record)) throw Error('terminal-cleanup-record-changed');
      record.cleanup = { pid: process.pid, birth: self.birth, spawnId: this.#cleanupId };
      record.cleanupWriters = this.filesystemWriter ? [await this.filesystemWriter()] : [];
      await this.#publish(record, step);
    }, true);
    // The durable cleanup claim prevents another live collector from deleting
    // these paths between batches. A crash retains both the record and debt.
    await this.#walk(record, signal, true);
    await this.#locked(signal, async step => {
      await this.#assertCleanup(record, step);
      await this.#folder(record, [], step, async directory => {
        step.claim('ioOperations', 16);
        const names = await directory.listEntries(4);
        if (names.length !== 1 || names[0] !== 'owner.json') throw Error('terminal-cleanup-unknown-entry');
        const root = await this.#root(step), marker = `cleanup-${record.id}.json`;
        // Move the original identity-bearing record outside the empty folder
        // before deleting it. A hard stop at either next operation is resumable.
        await directory.renameTo('owner.json', root, marker, false);
        await directory.sync(); await root.sync();
        this.#recordIdentities.set(record, (await root.statFile(marker)).identity);
        this.#finalizing.add(record);
      });
      await this.#finishRemoval(record, step);
    }, true);
  }

  async #finishRemoval(record: InstanceRecord, step: DeviceCapacityStepPermit): Promise<void> {
    step.claim('ioOperations', 20);
    const root = await this.#root(step), marker = `cleanup-${record.id}.json`, folder = `instance-${record.id}`;
    const identity = this.#recordIdentities.get(record);
    if (!identity || !this.#finalizing.has(record)) throw Error('terminal-cleanup-publication-unknown');
    const info = await root.statFile(marker);
    if (info.identity !== identity) throw Error('terminal-cleanup-record-changed');
    if ((await this.#rootEntries(step)).includes(folder)) await root.unlink(folder, true, record.directoryIdentity);
    await root.sync();
    await root.unlink(marker, false, identity); await root.sync();
  }

  async #assertCleanup(record: InstanceRecord, step: DeviceCapacityStepPermit): Promise<void> {
    const current = (await this.#records(step)).find(value => value.id === record.id);
    if (!current || current.directoryIdentity !== record.directoryIdentity || current.cleanup?.pid !== process.pid || current.cleanup.spawnId !== this.#cleanupId || current.cleanup.birth !== record.cleanup?.birth) throw Error('terminal-cleanup-owner-changed');
  }

  #root(step: DeviceCapacityStepPermit): Promise<CheckpointDirectoryHandle> {
    if (!this.#directory) {
      step.claim('ioOperations', 64);
      this.#directory = this.#filesystem.openPath(this.root, true);
    }
    return this.#directory;
  }
  close(deadline = Date.now() + 1000): Promise<void> {
    return this.#closing ??= closeTerminalFiles(deadline, async () => {
      await this.#serial;
      if (this.#directory) await (await this.#directory).close();
    }, remaining => this.#filesystem.close(remaining));
  }
}

function validRecord(value: unknown): value is InstanceRecord {
  if (!onlyKeys(value, ['version', 'id', 'directoryIdentity', 'owner', 'roles', 'pendingRoles', 'displayBytes', 'inputBytes', 'reservations', 'cleanup', 'cleanupWriters', 'writers', 'previousIdentity'])) return false;
  const record = value as InstanceRecord;
  const processIdentity = (identity: TerminalProcessIdentity) => onlyKeys(identity, ['pid', 'birth', 'spawnId', 'exited']) &&
    Number.isSafeInteger(identity.pid) && identity.pid > 0 && typeof identity.birth === 'string' && identity.birth.length > 0 &&
    identity.birth.length <= 256 && ID.test(identity.spawnId) && (identity.exited === undefined || identity.exited === true);
  return (record.version === 2 || record.version === 3) && ID.test(record.id) && typeof record.directoryIdentity === 'string' && record.directoryIdentity.length <= 64 &&
    (/^[a-f0-9]+:[a-f0-9]{16}$/u.test(record.directoryIdentity) || /^[0-9]+:[0-9]+$/u.test(record.directoryIdentity)) && processIdentity(record.owner) &&
    (record.cleanup === undefined || processIdentity(record.cleanup)) && onlyKeys(record.roles, ['application', 'ui', 'recovery']) &&
    (record.cleanupWriters === undefined || (Array.isArray(record.cleanupWriters) && record.cleanupWriters.length <= 1 && record.cleanupWriters.every(processIdentity))) &&
    (record.version === 2 ? record.writers === undefined : !!record.writers && typeof record.writers === 'object' && !Array.isArray(record.writers) && Object.keys(record.writers).length <= 32 &&
      Object.entries(record.writers).every(([id, writer]) => ID.test(id) && onlyKeys(writer, ['role', 'owner', 'state', 'identity', 'wrapped']) && (writer.wrapped === undefined || writer.wrapped === true) && writer.role === 'filesystem' && ID.test(writer.owner) &&
        (writer.state === 'gate-unreleased' ? writer.identity === undefined : writer.state === 'bound' && !!writer.identity && writer.identity.spawnId === id && processIdentity(writer.identity)))) &&
    Object.values(record.roles).every(processIdentity) && Array.isArray(record.pendingRoles) && record.pendingRoles.length <= 2 &&
    record.pendingRoles.every(intent => typeof intent === 'string' ? record.version === 2 && (intent === 'application' || intent === 'ui') :
      record.version === 3 && onlyKeys(intent, ['role', 'spawnId', 'state']) && ['application', 'ui'].includes(intent.role) && ID.test(intent.spawnId) && intent.state === 'gate-unreleased') &&
    (record.previousIdentity === undefined || (typeof record.previousIdentity === 'string' && record.previousIdentity.length <= 64)) &&
    Number.isSafeInteger(record.displayBytes) && record.displayBytes >= 0 &&
    Number.isSafeInteger(record.inputBytes) && record.inputBytes >= 0 && !!record.reservations && typeof record.reservations === 'object' &&
    !Array.isArray(record.reservations) && Object.keys(record.reservations).length <= 32 &&
    Object.entries(record.reservations).every(([key, reservation]) => (key === 'startup' || ID.test(key)) && onlyKeys(reservation, ['bucket', 'bytes']) &&
      ['display', 'input'].includes(reservation.bucket) && Number.isSafeInteger(reservation.bytes) && reservation.bytes >= 0);
}

function onlyKeys(value: unknown, keys: readonly string[]): value is object {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
}

function recordsSignature(records: readonly InstanceRecord[]): string {
  return JSON.stringify([...records].sort((a, b) => a.id.localeCompare(b.id)));
}
