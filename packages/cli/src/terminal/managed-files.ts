import { checkpointFilesystemCompletion, CheckpointDirectoryHandle, type CheckpointEntry, type CheckpointFilesystemSession } from '@zhixing/mesh/filesystem';
import type { DeviceCapacityStepPermit } from '@zhixing/core/resources';
import { closeTerminalFiles } from './close-budget.js';
import { AsyncLocalStorage } from 'node:async_hooks';

/** N owns exactly the input/display directories of its admitted instance. All
 * operations stay relative to pinned handles through read, write and cleanup. */
export class TerminalManagedFiles {
  readonly #session: CheckpointFilesystemSession;
  readonly #directories = new Map<string, Promise<CheckpointDirectoryHandle>>();
  #root?: Promise<CheckpointDirectoryHandle>;
  #closing?: Promise<void>;
  #serial = Promise.resolve();
  #pending = 0;
  #unconfirmed = false;
  readonly #operation = new AsyncLocalStorage<{ active: boolean }>();
  constructor(readonly directory: string, readonly expectedIdentity?: string, session = CheckpointDirectoryHandle.createSession(), readonly onUnconfirmed?: (error: unknown) => void) {
    this.#session = session;
  }
  /** Enqueue the entire owning action, including quota/account settlement.
   * File methods inside it must not enqueue again or acquire another queue. */
  runOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closing || this.#unconfirmed || this.#pending >= 16 || this.#operation.getStore()) return Promise.reject(Error('terminal-files-operation-admission'));
    this.#pending++;
    const work = this.#serial.then(() => {
      if (this.#unconfirmed) throw Error('terminal-files-unconfirmed');
      const scope = { active: true };
      try { return Promise.resolve(this.#operation.run(scope, operation)).finally(() => { scope.active = false; }); }
      catch (error) { scope.active = false; throw error; }
    }).finally(() => { this.#pending--; });
    this.#serial = work.then(() => {}, () => {});
    return work;
  }
  async #io<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (checkpointFilesystemCompletion(error) && !this.#unconfirmed) {
        this.#unconfirmed = true;
        if (this.onUnconfirmed) queueMicrotask(() => this.onUnconfirmed!(error));
      }
      throw error;
    }
  }
  async #parent(relative: string, step: DeviceCapacityStepPermit): Promise<{ parent: CheckpointDirectoryHandle; name: string }> {
    const parts = relative.split('/');
    if (parts.length !== 2 || !['input', 'display'].includes(parts[0]!) || !/^[a-zA-Z0-9-]{1,160}$/u.test(parts[1]!)) throw Error('terminal-relative-file-required');
    if (this.#unconfirmed || (this.#closing && !this.#operation.getStore()?.active)) throw Error('terminal-files-closed');
    const [folder, name] = parts as [string, string];
    if (!this.#root) {
      step.claim('ioOperations', 64);
      this.#root = this.#session.openPath(this.directory, false).then(async root => {
        if (this.expectedIdentity && root.identity !== this.expectedIdentity) {
          await root.close(); throw Error('terminal-instance-directory-changed');
        }
        return root;
      });
    }
    let parent = this.#directories.get(folder);
    if (!parent) {
      step.claim('ioOperations', 4);
      parent = this.#root.then(root => root.openDirectory(folder, false));
      this.#directories.set(folder, parent);
    }
    return { parent: await parent, name };
  }
  async write(relative: string, bytes: Buffer, position: number, maximum: number, step: DeviceCapacityStepPermit, identity?: string): Promise<CheckpointEntry> {
    return this.#io(async () => {
      const { parent, name } = await this.#parent(relative, step);
      step.claim('ioOperations', 24); step.claim('writeBytes', bytes.length);
      return parent.writeAt(name, maximum, position, bytes, identity);
    });
  }
  async read(relative: string, declared: number, position: number, length: number, identity: string, step: DeviceCapacityStepPermit, prefix = false): Promise<Buffer> {
    return this.#io(async () => {
      const { parent, name } = await this.#parent(relative, step);
      step.claim('ioOperations', 16); step.claim('readBytes', length);
      // A confirmed append-only prefix can remain readable after an unpublished
      // tail grew. The pinned object's identity and declared prefix bound still
      // apply; unknown physical completion continues to seal #parent above.
      return parent.readFile(name, declared, position, length, identity, prefix);
    });
  }
  async copyInput(source: string, sourceIdentity: string, sourceBytes: number, sourceOffset: number, target: string, targetIdentity: string | undefined, targetOffset: number, length: number, step: DeviceCapacityStepPermit): Promise<CheckpointEntry> {
    return this.#io(async () => {
      const { parent, name } = await this.#parent(`input/${target}`, step);
      if (!/^[a-f0-9-]{36}$/u.test(source)) throw Error('terminal-input-copy-source');
      step.claim('ioOperations', 48); step.claim('readBytes', length); step.claim('writeBytes', length);
      return parent.copyRange(source, sourceIdentity, sourceBytes, sourceOffset, name, targetIdentity, targetOffset, length);
    });
  }
  async unlink(relative: string, identity: string, step: DeviceCapacityStepPermit): Promise<void> {
    return this.#io(async () => {
      const { parent, name } = await this.#parent(relative, step);
      step.claim('ioOperations', 10);
      await parent.unlink(name, false, identity);
    });
  }
  close(deadline = Date.now() + 1000): Promise<void> {
    return this.#closing ??= closeTerminalFiles(deadline, async () => {
        await this.#serial;
        for (const directory of this.#directories.values()) await (await directory).close();
        if (this.#root) await (await this.#root).close();
    }, remaining => this.#session.close(remaining));
  }
}
