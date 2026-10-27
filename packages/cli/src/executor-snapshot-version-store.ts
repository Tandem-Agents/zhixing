import { createHash } from "node:crypto";
import { open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { AuthorityCacheIntegrity } from "@zhixing/core/authority";
import type { TrustRuleSnapshot } from "@zhixing/core/contracts";
import type { PermissionRule } from "@zhixing/core/security";
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

const PERMISSION_SNAPSHOT_CACHE_LIMIT = 32;

/**
 * 目录当前的最高版本与它的 digest；空目录 highWater 为 0、没有 digest。只增不减。
 * position 是与权限版本号分开的发布位置：head 每前进一次加一、稠密不跳号，对应一条位置指针；
 * 版本可以合法跳号（远端按版本安装），位置不会，所以“下一个位置不存在”有界地证明 head 没有落后。
 */
interface PermissionCatalogHead {
  readonly v: 1;
  readonly highWater: number;
  readonly digest?: string;
  readonly position?: number;
}

/** 一次写入的意图：先于快照文件与指针落盘，崩溃后由下一个加锁操作前滚或丢弃。 */
interface PermissionCatalogIntent {
  readonly v: 1;
  readonly digest: string;
  readonly version: number;
  readonly content: string;
}

/**
 * 按键持久的权限快照目录：每个快照一个内容寻址文件，另有 head、按版本、按规则内容三类小指针。
 * 锁内只读所需指针与目标快照，读取与保留快照数无关；执行端按 digest 精确取当前及在途租约引用的旧快照，
 * 不常驻全集。digest、版本、规则内容三者各自唯一，highWater 单调。
 */
export class FileTrustRuleSnapshotCatalog {
  readonly #directoryPath: string;
  readonly #verifier: ProtocolSignatureVerifier;
  /** home 完整性密钥：head 与指针是决定当前权限版本的输入，带它的 MAC 才可信；只读访问者没有时只做一致性检查。 */
  readonly #integrity: AuthorityCacheIntegrity | undefined;
  /** 目录格式：3 起 head 必须带发布位置。 */
  #format = CATALOG_FORMAT;
  // 只存已验签的快照；快照按 digest 内容寻址、不可变，跨进程无需失效。对外一律返回副本
  readonly #cache = new Map<string, TrustRuleSnapshot>();

  private constructor(directoryPath: string, verifier: ProtocolSignatureVerifier, integrity: AuthorityCacheIntegrity | undefined) {
    this.#directoryPath = directoryPath;
    this.#verifier = verifier;
    this.#integrity = integrity;
  }

  static async open(
    directoryPath: string,
    verifier: ProtocolSignatureVerifier,
    options: { readonly integrity?: AuthorityCacheIntegrity } = {},
  ): Promise<FileTrustRuleSnapshotCatalog> {
    await ensureDurableDirectory(directoryPath);
    const catalog = new FileTrustRuleSnapshotCatalog(directoryPath, verifier, options.integrity);
    const format = await readJsonIfPresent(catalog.#formatPath());
    // 没有 format 的旧布局、以及指针尚未带 MAC 的 v1 布局：由持有完整性密钥的写者一次性重建（未发布，不保留旧格式）
    if (format === undefined || (options.integrity && validateCatalogFormat(format) < CATALOG_FORMAT)) {
      await catalog.#locked(() => catalog.#establishLayout());
    } else catalog.#format = validateCatalogFormat(format);
    return catalog;
  }

  async publish(input: TrustRuleSnapshot): Promise<void> {
    const snapshot = validateTrustRuleSnapshot(input, this.#verifier);
    await this.#locked(async () => {
      await this.#install(snapshot, await this.#prepare());
    });
  }

  async publishRules(input: {
    readonly rules: readonly PermissionRule[];
    readonly signer: ProtocolSigner;
    readonly generatedAt: string;
  }): Promise<{ readonly snapshot: TrustRuleSnapshot; readonly highWater: number }> {
    const rules = normalizeTrustRulesForSnapshot(input.rules);
    const content = permissionRuleContentHash(rules);
    return this.#locked(async () => {
      const head = await this.#prepare();
      const existingDigest = await this.#pointer(this.#contentPath(content));
      if (existingDigest !== undefined) {
        const existing = await this.#required(existingDigest);
        if (permissionRuleContentHash(existing.rules) !== content) {
          throw new TypeError("Permission snapshot version or content identity was rewritten");
        }
        return { snapshot: structuredClone(existing), highWater: head.highWater };
      }
      const snapshotVersion = head.highWater + 1;
      if (!Number.isSafeInteger(snapshotVersion)) {
        throw new Error("Permission snapshot version is exhausted");
      }
      const snapshot = createSignedTrustRuleSnapshot({
        snapshotVersion,
        rules,
        generatedAt: input.generatedAt,
      }, input.signer);
      const next = await this.#install(snapshot, head);
      return { snapshot: structuredClone(snapshot), highWater: next.highWater };
    });
  }

  /** 按 digest 精确读一个快照并按原合同验签；digest 不合法或快照不存在时返回 undefined。 */
  async snapshot(digest: string): Promise<TrustRuleSnapshot | undefined> {
    if (typeof digest !== "string" || !DIGEST_PATTERN.test(digest)) return undefined;
    const snapshot = await this.#load(digest);
    return snapshot === undefined ? undefined : structuredClone(snapshot);
  }

  /** Latest accepted anchor-signed snapshot, or undefined before first synchronization. */
  async latest(): Promise<TrustRuleSnapshot | undefined> {
    return this.#locked(async () => {
      const head = await this.#prepare();
      if (head.digest === undefined) return undefined;
      const latest = await this.#required(head.digest);
      if (latest.snapshotVersion !== head.highWater) {
        throw new TypeError("Permission snapshot catalog head is invalid");
      }
      return structuredClone(latest);
    });
  }

  async highWater(): Promise<number> {
    return this.#locked(async () => (await this.#prepare()).highWater);
  }

  async #locked<T>(work: () => Promise<T>): Promise<T> {
    const release = await acquireFileLock(`${this.#directoryPath}.lock`, {
      staleMs: 30_000,
      waitMs: 10_000,
      resourceName: "Permission snapshot catalog",
    });
    try {
      return await work();
    } finally {
      await release();
    }
  }

  /** 锁内：读 head 并先处理遗留的写意图。已建立布局的目录缺 head 视为损坏，不回退成整目录扫描或置零。 */
  async #prepare(): Promise<PermissionCatalogHead> {
    const stored = await readJsonIfPresent(this.#headPath());
    if (stored === undefined) {
      throw new Error("Permission snapshot catalog head is missing");
    }
    let head = validateCatalogHead(this.#unseal("head", "head", stored), this.#format >= 3);
    const pending = await readJsonIfPresent(this.#intentPath());
    if (pending !== undefined) {
      const intent = validateCatalogIntent(pending);
      const snapshot = await this.#load(intent.digest);
      // 快照文件不在：意图之前没有任何东西对外，直接丢弃
      if (snapshot !== undefined) {
        if (
          snapshot.snapshotVersion !== intent.version ||
          permissionRuleContentHash(snapshot.rules) !== intent.content
        ) {
          throw new TypeError("Permission snapshot catalog intent does not match its snapshot");
        }
        head = await this.#link(snapshot, head);
      }
      await this.#clearIntent();
    }
    // 有界一致性：head 必须是最高版本，且与它的版本指针一致；单独改写或回放 head、删版本指针都在这里失败关闭
    if (head.highWater > 0 && await this.#pointer(this.#versionPath(head.highWater)) !== head.digest) {
      throw new Error("Permission snapshot catalog head does not match its version pointer");
    }
    if (await readJsonIfPresent(this.#versionPath(head.highWater + 1)) !== undefined) {
      throw new Error("Permission snapshot catalog head is behind its published versions");
    }
    // 发布位置稠密：head 所在位置的指针必须指向它，下一个位置不得存在（版本跳号时回放旧 head 也在这里查出）
    if (head.position !== undefined) {
      if (head.position > 0 && canonicalize(await this.#positionPointer(head.position) ?? null) !==
          canonicalize({ version: head.highWater, digest: head.digest })) {
        throw new Error("Permission snapshot catalog head does not match its position pointer");
      }
      if (await readJsonIfPresent(this.#positionPath(head.position + 1)) !== undefined) {
        throw new Error("Permission snapshot catalog head is behind its published versions");
      }
    }
    return head;
  }

  /** 锁内：落盘一个已验签快照及其指针。指针已指向别的 digest 即失败关闭。 */
  async #install(
    snapshot: TrustRuleSnapshot,
    head: PermissionCatalogHead,
  ): Promise<PermissionCatalogHead> {
    const content = permissionRuleContentHash(snapshot.rules);
    const byVersion = await this.#pointer(this.#versionPath(snapshot.snapshotVersion));
    const byContent = await this.#pointer(this.#contentPath(content));
    if (
      (byVersion !== undefined && byVersion !== snapshot.digest) ||
      (byContent !== undefined && byContent !== snapshot.digest)
    ) {
      throw new TypeError("Permission snapshot version or content identity was rewritten");
    }
    const stored = await this.#load(snapshot.digest);
    if (
      stored !== undefined &&
      byVersion !== undefined &&
      byContent !== undefined &&
      head.highWater >= snapshot.snapshotVersion
    ) {
      return head;
    }
    await writeDurableJson(this.#intentPath(), {
      v: 1,
      digest: snapshot.digest,
      version: snapshot.snapshotVersion,
      content,
    } satisfies PermissionCatalogIntent);
    if (stored === undefined) {
      await writeDurableJson(this.#snapshotPath(snapshot.digest), snapshot);
      this.#remember(snapshot);
    }
    const next = await this.#link(snapshot, head);
    await this.#clearIntent();
    return next;
  }

  /** 补齐一个已落盘快照的版本与内容指针，版本更高时抬高 head。 */
  async #link(
    snapshot: TrustRuleSnapshot,
    head: PermissionCatalogHead,
  ): Promise<PermissionCatalogHead> {
    for (const pointerPath of [
      this.#versionPath(snapshot.snapshotVersion),
      this.#contentPath(permissionRuleContentHash(snapshot.rules)),
    ]) {
      const current = await this.#pointer(pointerPath);
      if (current === undefined) {
        await writeDurableJson(pointerPath, this.#seal("pointer", path.relative(this.#directoryPath, pointerPath), { v: 1, digest: snapshot.digest }));
      } else if (current !== snapshot.digest) {
        throw new TypeError("Permission snapshot version or content identity was rewritten");
      }
    }
    if (snapshot.snapshotVersion <= head.highWater) return head;
    const position = (head.position ?? 0) + 1;
    const target = { version: snapshot.snapshotVersion, digest: snapshot.digest };
    // 位置指针先于 head 写：崩溃在两者之间时由写意图前滚补上 head；已有的位置指针必须正是这次发布
    const existing = await this.#positionPointer(position);
    if (existing === undefined) {
      await writeDurableJson(this.#positionPath(position), this.#seal("position", `positions/${position}.json`, { v: 1, ...target }));
    } else if (canonicalize(existing) !== canonicalize(target)) {
      throw new TypeError("Permission snapshot catalog position was rewritten");
    }
    const next: PermissionCatalogHead = { v: 1, highWater: snapshot.snapshotVersion, digest: snapshot.digest, position };
    await writeDurableJson(this.#headPath(), this.#seal("head", "head", next));
    return next;
  }

  /** 某个发布位置指向的版本与 digest；没有返回 undefined。 */
  async #positionPointer(position: number): Promise<{ readonly version: number; readonly digest: string } | undefined> {
    const value = await readJsonIfPresent(this.#positionPath(position));
    if (value === undefined) return undefined;
    const body = this.#unseal("position", `positions/${position}.json`, value);
    if (!isPlainObject(body) || body.v !== 1 || !Number.isSafeInteger(body.version) || typeof body.digest !== "string" ||
        !DIGEST_PATTERN.test(body.digest) || Object.keys(body).length !== 3) {
      throw new TypeError("Permission snapshot catalog position pointer is invalid");
    }
    return { version: body.version as number, digest: body.digest };
  }

  /**
   * 锁内建立指针布局。只有旧布局（没有 format.json）的开发资料会在这里一次性转换：按原加载规则枚举验签、
   * 核三者唯一并写齐指针，format.json 最后写，中途崩溃可重入。普通启动不经过这里。
   */
  async #establishLayout(): Promise<void> {
    const format = await readJsonIfPresent(this.#formatPath());
    if (format !== undefined) {
      validateCatalogFormat(format);
      return;
    }
    // 一次性重建：按原加载规则枚举并验签全部快照，丢弃旧的 head 与指针，重写带 MAC 的指针与 head
    await rm(path.join(this.#directoryPath, "versions"), { recursive: true, force: true });
    await rm(path.join(this.#directoryPath, "contents"), { recursive: true, force: true });
    await rm(path.join(this.#directoryPath, "positions"), { recursive: true, force: true });
    let head: PermissionCatalogHead = { v: 1, highWater: 0, position: 0 };
    const legacy = await loadLegacyPermissionSnapshots(this.#directoryPath, this.#verifier);
    for (const snapshot of legacy) head = await this.#link(snapshot, head);
    await writeDurableJson(this.#headPath(), this.#seal("head", "head", head));
    this.#format = this.#integrity ? CATALOG_FORMAT : 1;
    await writeDurableJson(this.#formatPath(), { v: this.#format });
  }

  async #load(digest: string): Promise<TrustRuleSnapshot | undefined> {
    const cached = this.#cache.get(digest);
    if (cached !== undefined) {
      this.#remember(cached);
      return cached;
    }
    const value = await readJsonIfPresent(this.#snapshotPath(digest));
    if (value === undefined) return undefined;
    const snapshot = validateTrustRuleSnapshot(value, this.#verifier);
    if (snapshot.digest !== digest) {
      throw new TypeError("Permission snapshot catalog entry was rewritten");
    }
    this.#remember(snapshot);
    return snapshot;
  }

  async #required(digest: string): Promise<TrustRuleSnapshot> {
    const snapshot = await this.#load(digest);
    if (snapshot === undefined) {
      throw new Error("Permission snapshot catalog pointer has no snapshot");
    }
    return snapshot;
  }

  #remember(snapshot: TrustRuleSnapshot): void {
    this.#cache.delete(snapshot.digest);
    this.#cache.set(snapshot.digest, snapshot);
    if (this.#cache.size > PERMISSION_SNAPSHOT_CACHE_LIMIT) {
      this.#cache.delete(this.#cache.keys().next().value!);
    }
  }

  async #pointer(pointerPath: string): Promise<string | undefined> {
    const value = await readJsonIfPresent(pointerPath);
    return value === undefined
      ? undefined
      : validateCatalogPointer(this.#unseal("pointer", path.relative(this.#directoryPath, pointerPath), value));
  }

  /** 写入前附上 MAC（绑定种类、相对路径与内容）；没有完整性密钥时原样写。 */
  #seal<T extends object>(kind: string, name: string, body: T): T & { readonly mac?: string } {
    if (!this.#integrity) return body;
    return { ...body, mac: this.#mac(kind, name, body) };
  }

  /** 读出后核 MAC：持有完整性密钥时缺失或不符即失败关闭；返回去掉 MAC 的内容。 */
  #unseal(kind: string, name: string, value: unknown): unknown {
    if (!isPlainObject(value)) return value;
    const { mac, ...body } = value;
    if (!this.#integrity) return body;
    if (typeof mac !== "string" || mac !== this.#mac(kind, name, body)) {
      throw new Error("Permission snapshot catalog metadata failed its integrity check");
    }
    return body;
  }

  #mac(kind: string, name: string, body: unknown): string {
    const encode = (value: string) => Buffer.from(value, "utf8");
    return this.#integrity!.sign("permission-snapshot-catalog", [encode(kind), encode(name.split(path.sep).join("/")), encode(canonicalize(body))])
      .toString("base64url");
  }

  async #clearIntent(): Promise<void> {
    await rm(this.#intentPath(), { force: true });
    await syncDirectory(this.#directoryPath);
  }

  #snapshotPath(digest: string): string {
    return path.join(this.#directoryPath, `${digest.slice("sha256:".length)}.json`);
  }

  #versionPath(version: number): string {
    return path.join(this.#directoryPath, "versions", `${version}.json`);
  }

  #contentPath(content: string): string {
    return path.join(this.#directoryPath, "contents", `${content}.json`);
  }

  #headPath(): string {
    return path.join(this.#directoryPath, "head.json");
  }

  #positionPath(position: number): string {
    return path.join(this.#directoryPath, "positions", `${position}.json`);
  }

  #intentPath(): string {
    return path.join(this.#directoryPath, "intent.json");
  }

  #formatPath(): string {
    return path.join(this.#directoryPath, "format.json");
  }
}

/** 目录格式：2 表示 head 与指针带 MAC；3 起 head 另带稠密发布位置与位置指针。 */
const CATALOG_FORMAT = 3;

function validateCatalogFormat(value: unknown): number {
  if (!isPlainObject(value) || Object.keys(value).length !== 1 || (value.v !== 1 && value.v !== 2 && value.v !== CATALOG_FORMAT)) {
    throw new TypeError("Permission snapshot catalog format is unsupported");
  }
  return value.v as number;
}

function validateCatalogHead(value: unknown, requirePosition: boolean): PermissionCatalogHead {
  if (!isPlainObject(value) || value.v !== 1) {
    throw new TypeError("Permission snapshot catalog head is invalid");
  }
  const { highWater, digest, position } = value;
  const positioned = position !== undefined;
  if (
    !Number.isSafeInteger(highWater) || (highWater as number) < 0 ||
    (requirePosition && !positioned) ||
    (positioned && (!Number.isSafeInteger(position) || (position as number) < 0 || (highWater === 0) !== (position === 0))) ||
    (highWater === 0
      ? digest !== undefined || Object.keys(value).length !== 2 + Number(positioned)
      : typeof digest !== "string" || !DIGEST_PATTERN.test(digest) || Object.keys(value).length !== 3 + Number(positioned))
  ) {
    throw new TypeError("Permission snapshot catalog head is invalid");
  }
  return {
    v: 1,
    highWater: highWater as number,
    ...(digest === undefined ? {} : { digest: digest as string }),
    ...(positioned ? { position: position as number } : {}),
  };
}

function validateCatalogIntent(value: unknown): PermissionCatalogIntent {
  if (
    !isPlainObject(value) || value.v !== 1 || Object.keys(value).length !== 4 ||
    typeof value.digest !== "string" || !DIGEST_PATTERN.test(value.digest) ||
    !Number.isSafeInteger(value.version) || (value.version as number) < 1 ||
    typeof value.content !== "string" || !/^[a-f0-9]{64}$/u.test(value.content)
  ) {
    throw new TypeError("Permission snapshot catalog intent is invalid");
  }
  return value as unknown as PermissionCatalogIntent;
}

function validateCatalogPointer(value: unknown): string {
  if (
    !isPlainObject(value) || value.v !== 1 || Object.keys(value).length !== 2 ||
    typeof value.digest !== "string" || !DIGEST_PATTERN.test(value.digest)
  ) {
    throw new TypeError("Permission snapshot catalog pointer is invalid");
  }
  return value.digest;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 旧布局的一次性转换来源：按原规则整读验签，按版本升序返回。 */
async function loadLegacyPermissionSnapshots(
  directoryPath: string,
  verifier: ProtocolSignatureVerifier,
): Promise<readonly TrustRuleSnapshot[]> {
  const digests = new Set<string>();
  const snapshotsByVersion = new Map<number, TrustRuleSnapshot>();
  const contents = new Set<string>();
  const entries = await readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
    const expectedDigest = `sha256:${entry.name.slice(0, -5)}`;
    const value = await readJsonIfPresent(path.join(directoryPath, entry.name));
    if (value === undefined) {
      throw new Error("Permission snapshot disappeared while loading");
    }
    const snapshot = validateTrustRuleSnapshot(value, verifier);
    const content = permissionRuleContentHash(snapshot.rules);
    if (
      snapshot.digest !== expectedDigest ||
      digests.has(snapshot.digest) ||
      snapshotsByVersion.has(snapshot.snapshotVersion) ||
      contents.has(content)
    ) {
      throw new TypeError("Permission snapshot catalog identity is invalid");
    }
    digests.add(snapshot.digest);
    snapshotsByVersion.set(snapshot.snapshotVersion, snapshot);
    contents.add(content);
  }
  return [...snapshotsByVersion.values()].sort((left, right) => left.snapshotVersion - right.snapshotVersion);
}

/** 规则内容的身份：规范化后的规则集的 SHA-256，用作按内容指针的文件名。 */
function permissionRuleContentHash(rules: TrustRuleSnapshot["rules"]): string {
  return createHash("sha256").update(canonicalize(normalizeTrustRulesForSnapshot(rules))).digest("hex");
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
