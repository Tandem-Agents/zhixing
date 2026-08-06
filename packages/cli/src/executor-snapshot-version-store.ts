import { open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { TrustRuleSnapshot } from "@zhixing/core/contracts";
import type { PermissionRule } from "@zhixing/core";
import type {
  ExecutorCapabilityDirectoryState,
  ExecutorCapabilityDirectoryStore,
  ProtocolSignatureVerifier,
  ProtocolSigner,
} from "@zhixing/core/protocol";
import {
  canonicalize,
  createSignedTrustRuleSnapshot,
  normalizeTrustRulesForSnapshot,
  validateTrustRuleSnapshot,
} from "@zhixing/core/protocol";
import {
  acquireFileLock,
  ensureDurableDirectory,
  syncDirectory,
} from "@zhixing/core/persistence";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

interface ExecutionSnapshotVersionState {
  readonly v: 2;
  readonly executorId: string;
  readonly deviceDigest: string;
  readonly deviceRevision: number;
  readonly deviceGeneratedAt: string;
  readonly inventoryDigest: string;
  readonly inventoryRevision: number;
  readonly inventoryGeneratedAt: string;
  readonly capabilityDirectoryEstablished: boolean;
}

export interface ExecutionSnapshotVersionResolution {
  readonly deviceRevision: number;
  readonly inventoryRevision: number;
  readonly initialized: boolean;
  readonly deviceGeneratedAt: string;
  readonly inventoryGeneratedAt: string;
  readonly capabilityDirectoryEstablished: boolean;
}

/** Durable monotonic version source for the local aggregate execution snapshot. */
export class FileExecutionSnapshotVersionStore {
  readonly #filePath: string;
  readonly #clock: () => string;

  constructor(filePath: string, clock: () => string = () => new Date().toISOString()) {
    this.#filePath = filePath;
    this.#clock = clock;
  }

  async assertCapabilityDirectoryCoherence(directoryPresent: boolean): Promise<void> {
    const release = await acquireFileLock(`${this.#filePath}.lock`, {
      staleMs: 30_000,
      waitMs: 10_000,
      resourceName: "Execution snapshot version",
    });
    try {
      const current = await this.#read();
      if (directoryPresent && current === undefined) {
        throw new Error("Execution snapshot version state is missing");
      }
      if (!directoryPresent && current?.capabilityDirectoryEstablished) {
        throw new Error("Established executor capability directory state is missing");
      }
    } finally {
      await release();
    }
  }

  async synchronize(
    executorId: string,
    deviceDigest: string,
    inventoryDigest: string,
    options: { readonly allowInitialize?: boolean } = {},
  ): Promise<ExecutionSnapshotVersionResolution> {
    assertIdentifier(executorId, "Executor id");
    assertDigest(deviceDigest, "Execution device digest");
    assertDigest(inventoryDigest, "Execution inventory digest");
    const release = await acquireFileLock(`${this.#filePath}.lock`, {
      staleMs: 30_000,
      waitMs: 10_000,
      resourceName: "Execution snapshot version",
    });
    try {
      const current = await this.#read();
      if (current === undefined && options.allowInitialize === false) {
        throw new Error("Execution snapshot version state is missing");
      }
      if (current?.capabilityDirectoryEstablished && options.allowInitialize === true) {
        throw new Error("Established executor capability directory state is missing");
      }
      if (current && current.executorId !== executorId) {
        throw new Error("Execution snapshot version belongs to another executor");
      }
      if (
        current?.deviceDigest === deviceDigest &&
        current.inventoryDigest === inventoryDigest
      ) {
        return {
          deviceRevision: current.deviceRevision,
          inventoryRevision: current.inventoryRevision,
          initialized: false,
          deviceGeneratedAt: current.deviceGeneratedAt,
          inventoryGeneratedAt: current.inventoryGeneratedAt,
          capabilityDirectoryEstablished: current.capabilityDirectoryEstablished,
        };
      }
      const deviceChanged = current?.deviceDigest !== deviceDigest;
      const deviceRevision = current === undefined
        ? 1
        : current.deviceRevision + (deviceChanged ? 1 : 0);
      const inventoryRevision = (current?.inventoryRevision ?? 0) + 1;
      if (
        !Number.isSafeInteger(deviceRevision) ||
        !Number.isSafeInteger(inventoryRevision)
      ) {
        throw new Error("Execution snapshot revisions are exhausted");
      }
      const now = this.#canonicalNow();
      const deviceGeneratedAt = deviceChanged || current === undefined
        ? now
        : current.deviceGeneratedAt;
      await this.#write({
        v: 2,
        executorId,
        deviceDigest,
        deviceRevision,
        deviceGeneratedAt,
        inventoryDigest,
        inventoryRevision,
        inventoryGeneratedAt: now,
        capabilityDirectoryEstablished:
          current?.capabilityDirectoryEstablished ?? false,
      });
      return {
        deviceRevision,
        inventoryRevision,
        initialized: current === undefined,
        deviceGeneratedAt,
        inventoryGeneratedAt: now,
        capabilityDirectoryEstablished:
          current?.capabilityDirectoryEstablished ?? false,
      };
    } finally {
      await release();
    }
  }

  async markCapabilityDirectoryEstablished(input: {
    readonly executorId: string;
    readonly deviceDigest: string;
    readonly deviceRevision: number;
    readonly inventoryDigest: string;
    readonly inventoryRevision: number;
  }): Promise<void> {
    assertIdentifier(input.executorId, "Executor id");
    assertDigest(input.deviceDigest, "Execution device digest");
    assertDigest(input.inventoryDigest, "Execution inventory digest");
    if (
      !Number.isSafeInteger(input.deviceRevision) ||
      input.deviceRevision <= 0 ||
      !Number.isSafeInteger(input.inventoryRevision) ||
      input.inventoryRevision <= 0
    ) {
      throw new TypeError("Execution snapshot revisions must be positive");
    }
    const release = await acquireFileLock(`${this.#filePath}.lock`, {
      staleMs: 30_000,
      waitMs: 10_000,
      resourceName: "Execution snapshot version",
    });
    try {
      const current = await this.#read();
      if (
        current === undefined ||
        current.executorId !== input.executorId ||
        current.deviceDigest !== input.deviceDigest ||
        current.deviceRevision !== input.deviceRevision ||
        current.inventoryDigest !== input.inventoryDigest ||
        current.inventoryRevision !== input.inventoryRevision
      ) {
        throw new Error("Execution snapshot changed before directory establishment");
      }
      if (current.capabilityDirectoryEstablished) return;
      await this.#write({
        ...current,
        capabilityDirectoryEstablished: true,
      });
    } finally {
      await release();
    }
  }

  async #read(): Promise<ExecutionSnapshotVersionState | undefined> {
    let encoded: string;
    try {
      encoded = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(encoded);
    } catch (error) {
      throw new Error("Execution snapshot version file is invalid JSON", {
        cause: error,
      });
    }
    return validateState(value);
  }

  async #write(state: ExecutionSnapshotVersionState): Promise<void> {
    await writeDurableJson(this.#filePath, state);
  }

  #canonicalNow(): string {
    const value = this.#clock();
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
      throw new TypeError("Execution snapshot version time must be canonical ISO");
    }
    return value;
  }
}

/** Crash-durable compare-and-swap store for the trusted executor directory. */
export class FileExecutorCapabilityDirectoryStore
implements ExecutorCapabilityDirectoryStore {
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  async load(): Promise<ExecutorCapabilityDirectoryState | undefined> {
    return readJsonIfPresent(this.#filePath) as Promise<
      ExecutorCapabilityDirectoryState | undefined
    >;
  }

  async save(
    state: ExecutorCapabilityDirectoryState,
    expectedGeneration: number,
  ): Promise<void> {
    const release = await acquireFileLock(`${this.#filePath}.lock`, {
      staleMs: 30_000,
      waitMs: 10_000,
      resourceName: "Executor capability directory",
    });
    try {
      const current = await readJsonIfPresent(this.#filePath);
      const currentGeneration = current === undefined
        ? 0
        : readGeneration(current);
      if (currentGeneration !== expectedGeneration) {
        throw new Error("Executor capability directory changed concurrently");
      }
      if (state.generation !== expectedGeneration + 1) {
        throw new Error("Executor capability directory generation is not consecutive");
      }
      await writeDurableJson(this.#filePath, state);
    } finally {
      await release();
    }
  }
}

/** Durable, content-addressed catalog retaining every permission snapshot still referenced by work. */
export class FileTrustRuleSnapshotCatalog {
  readonly #directoryPath: string;
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #snapshots: Map<string, TrustRuleSnapshot>;
  readonly #snapshotsByVersion: Map<number, TrustRuleSnapshot>;
  readonly #snapshotsByContent: Map<string, TrustRuleSnapshot>;

  private constructor(
    directoryPath: string,
    verifier: ProtocolSignatureVerifier,
    snapshots: Map<string, TrustRuleSnapshot>,
    snapshotsByVersion: Map<number, TrustRuleSnapshot>,
    snapshotsByContent: Map<string, TrustRuleSnapshot>,
  ) {
    this.#directoryPath = directoryPath;
    this.#verifier = verifier;
    this.#snapshots = snapshots;
    this.#snapshotsByVersion = snapshotsByVersion;
    this.#snapshotsByContent = snapshotsByContent;
  }

  static async open(
    directoryPath: string,
    verifier: ProtocolSignatureVerifier,
  ): Promise<FileTrustRuleSnapshotCatalog> {
    await ensureDurableDirectory(directoryPath);
    const loaded = await loadPermissionSnapshotCatalog(directoryPath, verifier);
    return new FileTrustRuleSnapshotCatalog(
      directoryPath,
      verifier,
      loaded.snapshots,
      loaded.snapshotsByVersion,
      loaded.snapshotsByContent,
    );
  }

  async publish(input: TrustRuleSnapshot): Promise<void> {
    const snapshot = validateTrustRuleSnapshot(input, this.#verifier);
    const release = await acquireFileLock(`${this.#directoryPath}.lock`, {
      staleMs: 30_000,
      waitMs: 10_000,
      resourceName: "Permission snapshot catalog",
    });
    try {
      await this.#reload();
      const contentKey = permissionRuleContentKey(snapshot.rules);
      const sameVersion = this.#snapshotsByVersion.get(snapshot.snapshotVersion);
      const sameContent = this.#snapshotsByContent.get(contentKey);
      if (
        (sameVersion !== undefined && sameVersion.digest !== snapshot.digest) ||
        (sameContent !== undefined && sameContent.digest !== snapshot.digest)
      ) {
        throw new TypeError("Permission snapshot version or content identity was rewritten");
      }
      if (this.#snapshots.has(snapshot.digest)) return;
      const filePath = path.join(
        this.#directoryPath,
        `${snapshot.digest.slice("sha256:".length)}.json`,
      );
      const existing = await readJsonIfPresent(filePath);
      if (existing !== undefined) {
        const stored = validateTrustRuleSnapshot(existing, this.#verifier);
        if (stored.digest !== snapshot.digest) {
          throw new TypeError("Permission snapshot catalog entry was rewritten");
        }
        this.#index(stored);
        return;
      }
      await writeDurableJson(filePath, snapshot);
      this.#index(snapshot);
    } finally {
      await release();
    }
  }

  async publishRules(input: {
    readonly rules: readonly PermissionRule[];
    readonly signer: ProtocolSigner;
    readonly generatedAt: string;
  }): Promise<{ readonly snapshot: TrustRuleSnapshot; readonly highWater: number }> {
    const rules = normalizeTrustRulesForSnapshot(input.rules);
    const contentKey = permissionRuleContentKey(rules);
    const release = await acquireFileLock(`${this.#directoryPath}.lock`, {
      staleMs: 30_000,
      waitMs: 10_000,
      resourceName: "Permission snapshot catalog",
    });
    try {
      await this.#reload();
      const existing = this.#snapshotsByContent.get(contentKey);
      if (existing !== undefined) {
        return {
          snapshot: structuredClone(existing),
          highWater: this.#highWater(),
        };
      }
      const snapshotVersion = this.#highWater() + 1;
      if (!Number.isSafeInteger(snapshotVersion)) {
        throw new Error("Permission snapshot version is exhausted");
      }
      const snapshot = createSignedTrustRuleSnapshot({
        snapshotVersion,
        rules,
        generatedAt: input.generatedAt,
      }, input.signer);
      const filePath = path.join(
        this.#directoryPath,
        `${snapshot.digest.slice("sha256:".length)}.json`,
      );
      await writeDurableJson(filePath, snapshot);
      this.#index(snapshot);
      return { snapshot: structuredClone(snapshot), highWater: snapshotVersion };
    } finally {
      await release();
    }
  }

  snapshotFor(digest: string): TrustRuleSnapshot | undefined {
    const snapshot = this.#snapshots.get(digest);
    return snapshot === undefined ? undefined : structuredClone(snapshot);
  }

  /** Latest accepted anchor-signed snapshot, or undefined before first synchronization. */
  async latest(): Promise<TrustRuleSnapshot | undefined> {
    const release = await acquireFileLock(`${this.#directoryPath}.lock`, {
      staleMs: 30_000,
      waitMs: 10_000,
      resourceName: "Permission snapshot catalog",
    });
    try {
      await this.#reload();
      const latest = this.#snapshotsByVersion.get(this.#highWater());
      return latest === undefined ? undefined : structuredClone(latest);
    } finally {
      await release();
    }
  }

  async highWater(): Promise<number> {
    const release = await acquireFileLock(`${this.#directoryPath}.lock`, {
      staleMs: 30_000,
      waitMs: 10_000,
      resourceName: "Permission snapshot catalog",
    });
    try {
      await this.#reload();
      return this.#highWater();
    } finally {
      await release();
    }
  }

  async #reload(): Promise<void> {
    const loaded = await loadPermissionSnapshotCatalog(
      this.#directoryPath,
      this.#verifier,
    );
    replaceMap(this.#snapshots, loaded.snapshots);
    replaceMap(this.#snapshotsByVersion, loaded.snapshotsByVersion);
    replaceMap(this.#snapshotsByContent, loaded.snapshotsByContent);
  }

  #index(snapshot: TrustRuleSnapshot): void {
    this.#snapshots.set(snapshot.digest, snapshot);
    this.#snapshotsByVersion.set(snapshot.snapshotVersion, snapshot);
    this.#snapshotsByContent.set(permissionRuleContentKey(snapshot.rules), snapshot);
  }

  #highWater(): number {
    let highWater = 0;
    for (const version of this.#snapshotsByVersion.keys()) {
      highWater = Math.max(highWater, version);
    }
    return highWater;
  }
}

async function loadPermissionSnapshotCatalog(
  directoryPath: string,
  verifier: ProtocolSignatureVerifier,
): Promise<{
  readonly snapshots: Map<string, TrustRuleSnapshot>;
  readonly snapshotsByVersion: Map<number, TrustRuleSnapshot>;
  readonly snapshotsByContent: Map<string, TrustRuleSnapshot>;
}> {
  const snapshots = new Map<string, TrustRuleSnapshot>();
  const snapshotsByVersion = new Map<number, TrustRuleSnapshot>();
  const snapshotsByContent = new Map<string, TrustRuleSnapshot>();
  const entries = await readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
    const expectedDigest = `sha256:${entry.name.slice(0, -5)}`;
    const value = await readJsonIfPresent(path.join(directoryPath, entry.name));
    if (value === undefined) {
      throw new Error("Permission snapshot disappeared while loading");
    }
    const snapshot = validateTrustRuleSnapshot(value, verifier);
    const contentKey = permissionRuleContentKey(snapshot.rules);
    if (
      snapshot.digest !== expectedDigest ||
      snapshots.has(snapshot.digest) ||
      snapshotsByVersion.has(snapshot.snapshotVersion) ||
      snapshotsByContent.has(contentKey)
    ) {
      throw new TypeError("Permission snapshot catalog identity is invalid");
    }
    snapshots.set(snapshot.digest, snapshot);
    snapshotsByVersion.set(snapshot.snapshotVersion, snapshot);
    snapshotsByContent.set(contentKey, snapshot);
  }
  return { snapshots, snapshotsByVersion, snapshotsByContent };
}

function permissionRuleContentKey(rules: TrustRuleSnapshot["rules"]): string {
  return canonicalize(normalizeTrustRulesForSnapshot(rules));
}

function replaceMap<Key, Value>(
  target: Map<Key, Value>,
  source: ReadonlyMap<Key, Value>,
): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

async function writeDurableJson(filePath: string, value: unknown): Promise<void> {
  const parent = path.dirname(filePath);
  await ensureDurableDirectory(parent);
  const temporary = `${filePath}.tmp`;
  await rm(temporary, { force: true });
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, filePath);
    await syncDirectory(parent);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readJsonIfPresent(filePath: string): Promise<unknown | undefined> {
  let encoded: string;
  try {
    encoded = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(encoded) as unknown;
  } catch (error) {
    throw new Error("Durable executor metadata is invalid JSON", { cause: error });
  }
}

function readGeneration(value: unknown): number {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Executor capability directory state must be an object");
  }
  const generation = (value as Record<string, unknown>).generation;
  if (!Number.isSafeInteger(generation) || (generation as number) < 0) {
    throw new TypeError("Executor capability directory generation is invalid");
  }
  return generation as number;
}

function validateState(value: unknown): ExecutionSnapshotVersionState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Execution snapshot version state must be an object");
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [
    "capabilityDirectoryEstablished",
    "deviceDigest",
    "deviceGeneratedAt",
    "deviceRevision",
    "executorId",
    "inventoryDigest",
    "inventoryGeneratedAt",
    "inventoryRevision",
    "v",
  ];
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError("Execution snapshot version state fields are invalid");
  }
  if (record.v !== 2) {
    throw new TypeError("Execution snapshot version state version is invalid");
  }
  if (typeof record.capabilityDirectoryEstablished !== "boolean") {
    throw new TypeError("Execution snapshot directory establishment is invalid");
  }
  assertIdentifier(record.executorId, "Executor id");
  assertDigest(record.deviceDigest, "Execution device digest");
  assertDigest(record.inventoryDigest, "Execution inventory digest");
  for (const field of ["deviceGeneratedAt", "inventoryGeneratedAt"] as const) {
    if (typeof record[field] !== "string") {
      throw new TypeError(`Execution snapshot ${field} is invalid`);
    }
    const time = new Date(record[field]);
    if (!Number.isFinite(time.getTime()) || time.toISOString() !== record[field]) {
      throw new TypeError(`Execution snapshot ${field} must be canonical ISO`);
    }
  }
  for (const field of ["deviceRevision", "inventoryRevision"] as const) {
    if (!Number.isSafeInteger(record[field]) || (record[field] as number) <= 0) {
      throw new TypeError(`Execution snapshot ${field} must be positive`);
    }
  }
  return record as unknown as ExecutionSnapshotVersionState;
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
