import type { Dir } from "node:fs";
import { open, opendir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { ArtifactRef } from "../contracts/index.js";
import {
  durablyRemoveDirectory,
  durablyRemoveDirectoryTree,
  durablyRemoveFile,
  durablyRemoveFiles,
  ensureDurableDirectory,
  syncDirectory,
} from "../persistence/index.js";
import { canonicalize, protocolDigest } from "../protocol/index.js";
import {
  claimDeviceCapacity,
  runStorageMaintenanceStep,
  storageMaintenanceRequest,
  type StorageMaintenanceGovernorPort,
} from "../resources/index.js";
import { assertArtifactRef } from "./artifact-references.js";
import { AuthorityStorageError } from "./errors.js";

const MARKER_FORMAT_VERSION = 1;
const MAX_SCOPE_IDENTITY_BYTES = 8 * 1024;
const MAX_MARKER_BYTES = 16 * 1024;
const DURABILITY_CACHE_LIMIT = 256;

interface TemporaryPresenceMarker {
  readonly formatVersion: 1;
  readonly ref: ArtifactRef;
  readonly scopeIdentity: string;
}

interface TemporaryPresenceMigration {
  readonly formatVersion: 1;
  readonly ref: ArtifactRef;
}

export interface TemporaryPresenceReconciliationEntry {
  readonly ref: ArtifactRef;
  readonly scopeIdentity: string;
}

export interface TemporaryPresenceReconciliationCursor {
  next(limit: number): Promise<{
    readonly entries: readonly TemporaryPresenceReconciliationEntry[];
    readonly done: boolean;
  }>;
  close(): Promise<void>;
}

export interface ArtifactTemporaryPresenceStore {
  mark(ref: ArtifactRef, scopeIdentity: string): Promise<void>;
  has(ref: ArtifactRef): Promise<boolean>;
  visitReferences(
    visitor: (ref: ArtifactRef) => void | Promise<void>,
  ): Promise<void>;
  visitScopes(
    ref: ArtifactRef,
    visitor: (scopeIdentity: string) => void | Promise<void>,
  ): Promise<void>;
  removeScopes(
    ref: ArtifactRef,
    scopeIdentities: readonly string[],
  ): Promise<void>;
  remove(ref: ArtifactRef, scopeIdentity?: string): Promise<void>;
  removeStagingFiles(): Promise<number>;
  openReconciliationCursor(): TemporaryPresenceReconciliationCursor;
  hasLegacyMigration(ref: ArtifactRef): Promise<boolean>;
  beginLegacyMigration(ref: ArtifactRef): Promise<void>;
  finishLegacyMigration(ref: ArtifactRef): Promise<void>;
}

/**
 * 物理 presence 存储的装配选项。
 *
 * 未注入 governor 时全部物理步骤直通,用于不受设备容量治理的场景(测试夹具、
 * 未接入治理的历史装配)。生产组合根必须注入,否则叶级记账会静默落空。
 */
export interface FileArtifactTemporaryPresenceStoreOptions {
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
}

/**
 * Durable physical metadata for temporary uploads.
 *
 * A marker is installed before receiver I/O. It is not an authority fact: it
 * only records which scope may own bytes in the temporary artifact store, so
 * a rebuild can recover exact quota attribution after the derived index is
 * lost.
 */
export class FileArtifactTemporaryPresenceStore
implements ArtifactTemporaryPresenceStore {
  readonly rootDir: string;
  readonly #durableDirectoryEntries = new RecentPathCache(
    DURABILITY_CACHE_LIMIT,
  );
  readonly #durableDirectoryContents = new RecentPathCache(
    DURABILITY_CACHE_LIMIT,
  );

  readonly #storageMaintenance: StorageMaintenanceGovernorPort | undefined;
  #reconciliationCursorSequence = 0;

  constructor(
    rootDir: string,
    options: FileArtifactTemporaryPresenceStoreOptions = {},
  ) {
    this.rootDir = path.resolve(rootDir);
    this.#storageMaintenance = options.storageMaintenance;
  }

  /**
   * 临时区 presence 的物理写删叶步骤统一经此取得设备容量。
   *
   * 叶级记账(`claimDeviceCapacity`)在没有容量语境时是静默空操作,所以"叶里写了
   * 记账"并不等于这次副作用被记进账——语境必须由真正执行副作用的这一步建立。
   * permit 只包住单个 marker 的安装/删除或一个固定扫描批次。复合步骤内部调用
   * 私有的无准入叶，任务边界不会被另一个 workKey 吞并。
   */
  #underMaintenancePermit<T>(
    inputIdentity: unknown,
    operation: () => Promise<T>,
  ): Promise<T> {
    return runStorageMaintenanceStep(
      this.#storageMaintenance,
      storageMaintenanceRequest(
        "lifecycle-reconcile",
        this.rootDir,
        inputIdentity,
        { obligation: "committed" },
      ),
      operation,
    );
  }

  async mark(ref: ArtifactRef, scopeIdentity: string): Promise<void> {
    assertPresenceInput(ref, scopeIdentity);
    await this.#underMaintenancePermit(
      { step: "mark", digest: ref.digest, scopeIdentity },
      () => this.#markStep(ref, scopeIdentity),
    );
  }

  async #markStep(ref: ArtifactRef, scopeIdentity: string): Promise<void> {
    const directory = this.#digestDirectory(ref);
    await this.#ensureDigestDirectory(directory);
    const target = this.#markerPath(ref, scopeIdentity);
    const existing = await this.#readMarker(target).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    });
    if (existing) {
      assertSamePresence(existing, ref, scopeIdentity);
      if (!this.#durableDirectoryContents.has(directory)) {
        await syncDirectory(directory);
        this.#durableDirectoryContents.add(directory);
      }
      return;
    }

    const marker: TemporaryPresenceMarker = {
      formatVersion: MARKER_FORMAT_VERSION,
      ref,
      scopeIdentity,
    };
    const temporary = this.#stagingPath(target);
    await this.#removeStagingStep(directory, temporary);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(Buffer.from(canonicalize(marker), "utf8"));
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await handle.close();
    try {
      this.#durableDirectoryContents.delete(directory);
      await rename(temporary, target);
      await syncDirectory(directory);
      this.#durableDirectoryContents.add(directory);
    } catch (error) {
      await this.#removeStagingStep(directory, temporary).catch(
        () => undefined,
      );
      throw error;
    }
  }

  async has(ref: ArtifactRef): Promise<boolean> {
    assertArtifactRef(ref);
    return this.#underMaintenancePermit(
      { step: "has", digest: ref.digest },
      () => this.#hasStep(ref),
    );
  }

  async #hasStep(ref: ArtifactRef): Promise<boolean> {
    const directory = this.#digestDirectory(ref);
    let entries;
    try {
      entries = await opendir(directory);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
    for await (const entry of entries) {
      if (!entry.isFile() || !isMarkerName(entry.name)) continue;
      const marker = await this.#readMarker(path.join(directory, entry.name));
      assertMarkerLocation(marker, ref, entry.name);
      return true;
    }
    return false;
  }

  async visitReferences(
    visitor: (ref: ArtifactRef) => void | Promise<void>,
  ): Promise<void> {
    let directories;
    try {
      directories = await opendir(this.rootDir);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
    for await (const directory of directories) {
      if (!directory.isDirectory() || !/^[a-f0-9]{64}$/u.test(directory.name)) {
        continue;
      }
      const digestDirectory = path.join(this.rootDir, directory.name);
      const entries = await opendir(digestDirectory);
      for await (const entry of entries) {
        if (!entry.isFile() || !isMarkerName(entry.name)) continue;
        const marker = await this.#readMarker(
          path.join(digestDirectory, entry.name),
        );
        if (digestHex(marker.ref.digest) !== directory.name) {
          throw presenceCorrupt(
            "Temporary presence marker is stored under the wrong digest",
          );
        }
        assertMarkerLocation(marker, marker.ref, entry.name);
        await visitor(marker.ref);
        break;
      }
    }
  }

  async visitScopes(
    ref: ArtifactRef,
    visitor: (scopeIdentity: string) => void | Promise<void>,
  ): Promise<void> {
    assertArtifactRef(ref);
    const directory = this.#digestDirectory(ref);
    let entries;
    try {
      entries = await opendir(directory);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
    for await (const entry of entries) {
      if (!entry.isFile() || !isMarkerName(entry.name)) continue;
      const marker = await this.#readMarker(path.join(directory, entry.name));
      assertMarkerLocation(marker, ref, entry.name);
      await visitor(marker.scopeIdentity);
    }
  }

  async remove(ref: ArtifactRef, scopeIdentity?: string): Promise<void> {
    assertArtifactRef(ref);
    if (scopeIdentity === undefined) {
      const directory = this.#digestDirectory(ref);
      this.#durableDirectoryEntries.delete(directory);
      this.#durableDirectoryContents.delete(directory);
      await this.#underMaintenancePermit(
        { step: "remove-all", digest: ref.digest },
        () => durablyRemoveDirectoryTree(directory),
      );
      return;
    }

    await this.removeScopes(ref, [scopeIdentity]);
  }

  async removeScopes(
    ref: ArtifactRef,
    scopeIdentities: readonly string[],
  ): Promise<void> {
    assertArtifactRef(ref);
    if (scopeIdentities.length === 0) return;
    for (const scopeIdentity of scopeIdentities) {
      assertPresenceInput(ref, scopeIdentity);
    }
    const scopes = [...new Set(scopeIdentities)];
    const targets = scopes.map((scopeIdentity) =>
      this.#markerPath(ref, scopeIdentity)
    );
    const directory = this.#digestDirectory(ref);
    this.#durableDirectoryContents.delete(directory);
    // 身份取逻辑输入(digest + scope 集合),不取派生路径:路径是这些输入的函数,
    // 放进身份只会让同一件工作在不同根目录下算出不同的 workKey。
    await this.#underMaintenancePermit(
      { step: "remove-scopes", digest: ref.digest, scopes },
      async () => {
        await durablyRemoveFiles(
          targets.flatMap((target) => [target, this.#stagingPath(target)]),
        );
        await this.#collectEmptyDigestDirectoryStep(directory);
      },
    );
  }

  async removeStagingFiles(): Promise<number> {
    let directories;
    try {
      directories = await opendir(this.rootDir);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return 0;
      throw error;
    }
    let removed = 0;
    let inspected = 0;
    for await (const directory of directories) {
      inspected += 1;
      if (inspected % 64 === 0) await yieldToEventLoop();
      if (!directory.isDirectory() || !/^[a-f0-9]{64}$/u.test(directory.name)) {
        continue;
      }
      const digestDirectory = path.join(this.rootDir, directory.name);
      let entries;
      try {
        entries = await opendir(digestDirectory);
      } catch (error) {
        if (isNodeError(error, "ENOENT")) continue;
        throw error;
      }
      // staging 数量随该 digest 的 scope 数增长,按固定批次删除以保持单轮内存有界。
      let staging: string[] = [];
      const flushStaging = async (): Promise<void> => {
        if (staging.length === 0) return;
        const batch = staging;
        staging = [];
        this.#durableDirectoryContents.delete(digestDirectory);
        removed += await this.#underMaintenancePermit(
          { step: "remove-staging", batch },
          () => durablyRemoveFiles(batch),
        );
      };
      for await (const entry of entries) {
        inspected += 1;
        if (inspected % 64 === 0) await yieldToEventLoop();
        if (!entry.isFile() || !isStagingName(entry.name)) continue;
        staging.push(path.join(digestDirectory, entry.name));
        if (staging.length === 64) await flushStaging();
      }
      await flushStaging();
      await this.#collectEmptyDigestDirectory(digestDirectory);
    }
    return removed;
  }

  openReconciliationCursor(): TemporaryPresenceReconciliationCursor {
    const cursor = ++this.#reconciliationCursorSequence;
    return new FileTemporaryPresenceReconciliationCursor(
      this.rootDir,
      (file) => this.#readMarker(file),
      (directory, file) => this.#removeStagingStep(directory, file),
      async (directory) => {
        await this.#collectEmptyDigestDirectoryStep(directory);
      },
      (page, operation) =>
        this.#underMaintenancePermit(
          { step: "reconciliation-page", cursor, page },
          operation,
        ),
    );
  }

  async hasLegacyMigration(ref: ArtifactRef): Promise<boolean> {
    assertArtifactRef(ref);
    return this.#underMaintenancePermit(
      { step: "has-legacy-migration", digest: ref.digest },
      () => this.#hasLegacyMigrationStep(ref),
    );
  }

  async #hasLegacyMigrationStep(ref: ArtifactRef): Promise<boolean> {
    const migration = await this.#readMigration(
      this.#migrationPath(ref),
    ).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    });
    if (!migration) return false;
    assertSameReference(migration.ref, ref);
    return true;
  }

  async beginLegacyMigration(ref: ArtifactRef): Promise<void> {
    assertArtifactRef(ref);
    await this.#underMaintenancePermit(
      { step: "begin-legacy-migration", digest: ref.digest },
      () => this.#beginLegacyMigrationStep(ref),
    );
  }

  async #beginLegacyMigrationStep(ref: ArtifactRef): Promise<void> {
    const directory = this.#digestDirectory(ref);
    await this.#ensureDigestDirectory(directory);
    const target = this.#migrationPath(ref);
    const existing = await this.#readMigration(target).catch(
      (error: unknown) => {
        if (isNodeError(error, "ENOENT")) return undefined;
        throw error;
      },
    );
    if (existing) {
      assertSameReference(existing.ref, ref);
      await syncDirectory(directory);
      this.#durableDirectoryContents.add(directory);
      return;
    }
    const temporary = `${target}.tmp`;
    await this.#removeStagingStep(directory, temporary);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(Buffer.from(canonicalize({
        formatVersion: MARKER_FORMAT_VERSION,
        ref,
      }), "utf8"));
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await handle.close();
    try {
      this.#durableDirectoryContents.delete(directory);
      await rename(temporary, target);
      await syncDirectory(directory);
      this.#durableDirectoryContents.add(directory);
    } catch (error) {
      await this.#removeStagingStep(directory, temporary).catch(
        () => undefined,
      );
      throw error;
    }
  }

  async finishLegacyMigration(ref: ArtifactRef): Promise<void> {
    assertArtifactRef(ref);
    const directory = this.#digestDirectory(ref);
    this.#durableDirectoryContents.delete(directory);
    const target = this.#migrationPath(ref);
    await this.#underMaintenancePermit(
      { step: "finish-legacy-migration", digest: ref.digest },
      async () => {
        await durablyRemoveFiles([target, `${target}.tmp`]);
        await this.#collectEmptyDigestDirectoryStep(directory);
      },
    );
  }

  /**
   * digest 目录已空则回收它并同步根目录。
   *
   * 目录仍有 marker 时不登记"内容已耐久":本方法不保证发生过目录同步,而调用它
   * 的路径可能本轮零删除。内容缓存只由真正执行了屏障的删除路径登记。
   */
  async #collectEmptyDigestDirectory(directory: string): Promise<void> {
    const outcome = await this.#underMaintenancePermit(
      { step: "collect-empty-directory", directory },
      () => this.#collectEmptyDigestDirectoryStep(directory),
    );
    if (outcome === "not-empty") return;
  }

  async #collectEmptyDigestDirectoryStep(
    directory: string,
  ): Promise<"removed" | "absent" | "not-empty"> {
    const outcome = await durablyRemoveDirectory(directory);
    if (outcome === "not-empty") return outcome;
    this.#durableDirectoryEntries.delete(directory);
    this.#durableDirectoryContents.delete(directory);
    return outcome;
  }

  async #ensureDigestDirectory(directory: string): Promise<void> {
    if (this.#durableDirectoryEntries.has(directory)) return;
    await ensureDurableDirectory(directory);
    await syncDirectory(this.rootDir);
    this.#durableDirectoryEntries.add(directory);
  }

  async #readMarker(file: string): Promise<TemporaryPresenceMarker> {
    claimDeviceCapacity("ioOperations", 1);
    const handle = await open(file, "r");
    try {
      claimDeviceCapacity("ioOperations", 1);
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_MARKER_BYTES) {
        throw presenceCorrupt("Temporary presence marker size is invalid");
      }
      claimDeviceCapacity("readBytes", metadata.size);
      claimDeviceCapacity("ioOperations", 1);
      const bytes = Buffer.allocUnsafe(metadata.size);
      const read = await handle.read(bytes, 0, bytes.byteLength, 0);
      if (read.bytesRead !== bytes.byteLength) {
        throw presenceCorrupt("Temporary presence marker changed while reading");
      }
      const encoded = bytes.toString("utf8");
      let value: unknown;
      try {
        value = JSON.parse(encoded);
      } catch (error) {
        throw presenceCorrupt("Temporary presence marker is invalid", error);
      }
      if (canonicalize(value) !== encoded) {
        throw presenceCorrupt("Temporary presence marker is not canonical");
      }
      return temporaryPresenceMarker(value);
    } finally {
      await handle.close();
    }
  }

  async #readMigration(file: string): Promise<TemporaryPresenceMigration> {
    claimDeviceCapacity("ioOperations", 1);
    const handle = await open(file, "r");
    try {
      claimDeviceCapacity("ioOperations", 1);
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_MARKER_BYTES) {
        throw presenceCorrupt("Temporary presence migration size is invalid");
      }
      claimDeviceCapacity("readBytes", metadata.size);
      claimDeviceCapacity("ioOperations", 1);
      const bytes = Buffer.allocUnsafe(metadata.size);
      const read = await handle.read(bytes, 0, bytes.byteLength, 0);
      if (read.bytesRead !== bytes.byteLength) {
        throw presenceCorrupt("Temporary presence migration changed while reading");
      }
      const encoded = bytes.toString("utf8");
      let value: unknown;
      try {
        value = JSON.parse(encoded);
      } catch (error) {
        throw presenceCorrupt("Temporary presence migration is invalid", error);
      }
      if (canonicalize(value) !== encoded) {
        throw presenceCorrupt("Temporary presence migration is not canonical");
      }
      const record = plainRecord(value);
      if (record?.formatVersion !== MARKER_FORMAT_VERSION) {
        throw presenceCorrupt("Temporary presence migration shape is invalid");
      }
      assertArtifactRef(record.ref);
      return { formatVersion: MARKER_FORMAT_VERSION, ref: record.ref };
    } finally {
      await handle.close();
    }
  }

  #digestDirectory(ref: ArtifactRef): string {
    return path.join(this.rootDir, digestHex(ref.digest));
  }

  #markerPath(ref: ArtifactRef, scopeIdentity: string): string {
    return path.join(
      this.#digestDirectory(ref),
      `${scopeIdentityKey(scopeIdentity)}.json`,
    );
  }

  #migrationPath(ref: ArtifactRef): string {
    return path.join(this.#digestDirectory(ref), ".legacy-migration.json");
  }

  #stagingPath(target: string): string {
    return path.join(
      path.dirname(target),
      `.${path.basename(target)}.tmp`,
    );
  }

  async #removeStagingStep(
    directory: string,
    staging: string,
  ): Promise<void> {
    this.#durableDirectoryContents.delete(directory);
    await durablyRemoveFile(staging);
    this.#durableDirectoryContents.add(directory);
  }
}

class FileTemporaryPresenceReconciliationCursor
implements TemporaryPresenceReconciliationCursor {
  #directories: Dir | undefined;
  #entries: Dir | undefined;
  #digestDirectory: string | undefined;
  #digestHex: string | undefined;
  #done = false;
  #page = 0;

  constructor(
    private readonly rootDir: string,
    private readonly readMarker: (
      file: string,
    ) => Promise<TemporaryPresenceMarker>,
    private readonly removeStaging: (
      directory: string,
      file: string,
    ) => Promise<void>,
    private readonly collectEmptyDirectory: (
      directory: string,
    ) => Promise<void>,
    private readonly runPage: <T>(
      page: number,
      operation: () => Promise<T>,
    ) => Promise<T>,
  ) {}

  async next(limit: number): Promise<{
    readonly entries: readonly TemporaryPresenceReconciliationEntry[];
    readonly done: boolean;
  }> {
    assertPositiveLimit(limit, "Temporary presence cursor limit");
    if (this.#done) return { entries: [], done: true };
    const page = this.#page;
    this.#page += 1;
    return this.runPage(page, () => this.#next(limit));
  }

  async #next(limit: number): Promise<{
    readonly entries: readonly TemporaryPresenceReconciliationEntry[];
    readonly done: boolean;
  }> {
    const found: TemporaryPresenceReconciliationEntry[] = [];
    let inspected = 0;
    if (!this.#directories) {
      claimDeviceCapacity("ioOperations", 1);
      try {
        this.#directories = await opendir(this.rootDir);
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
        this.#done = true;
        return { entries: found, done: true };
      }
    }
    while (inspected < limit && !this.#done) {
      if (this.#entries && this.#digestDirectory && this.#digestHex) {
        claimDeviceCapacity("ioOperations", 1);
        const entry = await this.#entries.read();
        inspected += 1;
        if (!entry) {
          const completedDirectory = this.#digestDirectory;
          await this.#entries.close();
          this.#entries = undefined;
          this.#digestDirectory = undefined;
          this.#digestHex = undefined;
          await this.collectEmptyDirectory(completedDirectory);
          continue;
        }
        const file = path.join(this.#digestDirectory, entry.name);
        if (entry.isFile() && isStagingName(entry.name)) {
          await this.removeStaging(this.#digestDirectory, file);
          continue;
        }
        if (!entry.isFile() || !isMarkerName(entry.name)) continue;
        const marker = await this.readMarker(file);
        if (digestHex(marker.ref.digest) !== this.#digestHex) {
          throw presenceCorrupt(
            "Temporary presence marker is stored under the wrong digest",
          );
        }
        assertMarkerLocation(marker, marker.ref, entry.name);
        found.push({
          ref: marker.ref,
          scopeIdentity: marker.scopeIdentity,
        });
        continue;
      }
      claimDeviceCapacity("ioOperations", 1);
      const directory = await this.#directories.read();
      inspected += 1;
      if (!directory) {
        await this.#directories.close();
        this.#directories = undefined;
        this.#done = true;
        break;
      }
      if (!directory.isDirectory() || !/^[a-f0-9]{64}$/u.test(directory.name)) {
        continue;
      }
      const digestDirectory = path.join(this.rootDir, directory.name);
      claimDeviceCapacity("ioOperations", 1);
      try {
        this.#entries = await opendir(digestDirectory);
      } catch (error) {
        if (isNodeError(error, "ENOENT")) continue;
        throw error;
      }
      this.#digestDirectory = digestDirectory;
      this.#digestHex = directory.name;
    }
    return { entries: found, done: this.#done };
  }

  async close(): Promise<void> {
    this.#done = true;
    await this.#entries?.close().catch(() => undefined);
    await this.#directories?.close().catch(() => undefined);
    this.#entries = undefined;
    this.#directories = undefined;
    this.#digestDirectory = undefined;
    this.#digestHex = undefined;
  }
}

class RecentPathCache {
  readonly #paths = new Map<string, undefined>();

  constructor(private readonly limit: number) {}

  has(value: string): boolean {
    if (!this.#paths.delete(value)) return false;
    this.#paths.set(value, undefined);
    return true;
  }

  add(value: string): void {
    this.#paths.delete(value);
    this.#paths.set(value, undefined);
    while (this.#paths.size > this.limit) {
      const oldest = this.#paths.keys().next().value;
      if (oldest === undefined) return;
      this.#paths.delete(oldest);
    }
  }

  delete(value: string): void {
    this.#paths.delete(value);
  }
}

function temporaryPresenceMarker(value: unknown): TemporaryPresenceMarker {
  const record = plainRecord(value);
  if (
    record?.formatVersion !== MARKER_FORMAT_VERSION ||
    typeof record.scopeIdentity !== "string"
  ) {
    throw presenceCorrupt("Temporary presence marker shape is invalid");
  }
  assertArtifactRef(record.ref);
  assertScopeIdentity(record.scopeIdentity);
  return {
    formatVersion: MARKER_FORMAT_VERSION,
    ref: record.ref,
    scopeIdentity: record.scopeIdentity,
  };
}

function assertPresenceInput(
  ref: ArtifactRef,
  scopeIdentity: string,
): void {
  assertArtifactRef(ref);
  assertScopeIdentity(scopeIdentity);
}

function assertScopeIdentity(scopeIdentity: string): void {
  if (
    scopeIdentity.length === 0 ||
    Buffer.byteLength(scopeIdentity, "utf8") > MAX_SCOPE_IDENTITY_BYTES
  ) {
    throw new TypeError("Temporary presence scope identity is invalid");
  }
}

function assertPositiveLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function assertSamePresence(
  marker: TemporaryPresenceMarker,
  ref: ArtifactRef,
  scopeIdentity: string,
): void {
  if (
    marker.ref.digest !== ref.digest ||
    marker.ref.bytes !== ref.bytes ||
    marker.scopeIdentity !== scopeIdentity
  ) {
    throw presenceCorrupt("Temporary presence marker conflicts with its key");
  }
}

function assertSameReference(left: ArtifactRef, right: ArtifactRef): void {
  if (left.digest !== right.digest || left.bytes !== right.bytes) {
    throw presenceCorrupt("Temporary presence migration conflicts with its key");
  }
}

function assertMarkerLocation(
  marker: TemporaryPresenceMarker,
  ref: ArtifactRef,
  fileName: string,
): void {
  assertSamePresence(marker, ref, marker.scopeIdentity);
  if (fileName !== `${scopeIdentityKey(marker.scopeIdentity)}.json`) {
    throw presenceCorrupt(
      "Temporary presence marker is stored under the wrong scope",
    );
  }
}

function scopeIdentityKey(scopeIdentity: string): string {
  return protocolDigest("ArtifactTemporaryPresenceScope", 1, {
    scopeIdentity,
  }).slice("sha256:".length);
}

function digestHex(digest: string): string {
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) {
    throw new TypeError("Temporary presence digest is invalid");
  }
  return digest.slice("sha256:".length);
}

function isMarkerName(name: string): boolean {
  return /^[a-f0-9]{64}\.json$/u.test(name);
}

function isStagingName(name: string): boolean {
  return (
    /^\.[a-f0-9]{64}\.json\.tmp$/u.test(name) ||
    name === ".legacy-migration.json.tmp"
  );
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : undefined;
}

function presenceCorrupt(
  message: string,
  cause?: unknown,
): AuthorityStorageError {
  return new AuthorityStorageError(
    "artifact-corrupt",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
