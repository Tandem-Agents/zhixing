import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, readdir, rm, unlink } from "node:fs/promises";
import path from "node:path";
import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { mergeIdMap } from "./internal/io.js";
import { getCredentialsPath } from "./paths.js";
import type { ZhixingCredentials } from "./types.js";

export { getCredentialsPath };

const CREDENTIAL_NAMESPACE = "credentials/v1/";
const GENERATION_NAMESPACE = `${CREDENTIAL_NAMESPACE}generations/`;
const GENERATION_MARKER_NAMESPACE = `${CREDENTIAL_NAMESPACE}generation-markers/`;
const MANIFEST_REF: SecretRef = {
  kind: "provider",
  bindingId: `${CREDENTIAL_NAMESPACE}manifest`,
};
const CREDENTIAL_KINDS = ["provider", "channel", "mcp"] as const;
const PROVIDER_FIELDS = new Set([
  "apiKey",
  "baseUrl",
  "protocol",
  "quirks",
  "modelOverrides",
  "modelInputCapabilities",
  "models",
]);
const QUIRK_FIELDS = new Set([
  "maxTokensField",
  "supportsStreamUsage",
  "supportsThinking",
  "supportsTools",
  "usageDialect",
  "thinkingDialect",
]);
type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

interface CredentialGeneration {
  readonly generation: string;
  readonly entries: readonly { kind: CredentialKind; id: string }[];
}

interface CredentialManifest extends CredentialGeneration {
  readonly v: 1;
  readonly credentialSchemaVersion?: number;
  readonly retired?: readonly CredentialGeneration[];
}

interface LegacySourceSnapshot {
  readonly raw: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly digest: string;
}

interface CredentialGenerationMarker extends CredentialGeneration {
  readonly v: 1;
  readonly pid: number;
  readonly createdAt: string;
  readonly state: "staging" | "committed" | "aborted";
}

export class CredentialsSchemaError extends Error {
  constructor(
    message: string,
    public readonly filePath: string,
  ) {
    super(message);
    this.name = "CredentialsSchemaError";
  }
}

export class CredentialRetirementError extends Error {
  constructor(cause: unknown) {
    super("SecretStore 已激活新凭据，但旧凭据清退未完成；下次读取将继续重试。", {
      cause,
    });
    this.name = "CredentialRetirementError";
  }
}

export class CredentialPostCommitError extends Error {
  constructor(causes: readonly unknown[]) {
    super("SecretStore 已激活新凭据，但提交后收尾尚未完成；下次读取将继续收敛。", {
      cause: new AggregateError([...causes], "Credential post-commit recovery is pending"),
    });
    this.name = "CredentialPostCommitError";
  }
}

export class CredentialCommitStateUnknownError extends Error {
  constructor(causes: readonly unknown[]) {
    super(
      "SecretStore 凭据切换的激活状态未知；禁止逆向覆盖，下次读取将按 manifest 前滚收敛。",
      {
        cause: new AggregateError([...causes], "Credential commit state could not be observed"),
      },
    );
    this.name = "CredentialCommitStateUnknownError";
  }
}

interface CredentialStoreOptions {
  readonly store: SecretStorePort;
}

export interface CredentialStoreCoordinator {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

export type CredentialMutationOptions = CredentialStoreOptions &
  (
    | {
        readonly store: SecretStorePort & CredentialStoreCoordinator;
        readonly coordinator?: never;
      }
    | { readonly coordinator: CredentialStoreCoordinator }
  );

export type LegacyCredentialMigrationOptions = CredentialMutationOptions & {
  readonly homeDir?: string;
};

export type LegacyCredentialExportOptions = LegacyCredentialMigrationOptions & {
  readonly acknowledgePlaintextRisk: true;
};

export async function legacyCredentialsPresent(homeDir?: string): Promise<boolean> {
  const filePath = getCredentialsPath(homeDir);
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  try {
    const entries = await readdir(path.dirname(filePath));
    return entries.some((entry) => isLegacyCredentialTemp(filePath, entry));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

export async function loadCredentials(
  options: CredentialMutationOptions,
): Promise<ZhixingCredentials> {
  return mutationCoordinator(options).runExclusive(() => loadCredentialsUnlocked(options));
}

async function loadCredentialsUnlocked(
  options: CredentialStoreOptions,
): Promise<ZhixingCredentials> {
  const credentials: ZhixingCredentials = {};
  const encodedManifest = await options.store.get(MANIFEST_REF);
  if (encodedManifest === null) {
    try {
      await cleanupGenerationMarkers(options.store);
    } catch (error) {
      throw new CredentialRetirementError(error);
    }
    return credentials;
  }
  const manifest = parseManifest(encodedManifest);
  if (manifest.credentialSchemaVersion !== undefined) {
    credentials.version = manifest.credentialSchemaVersion;
  }
  for (const { kind, id } of manifest.entries) {
    const ref = credentialSecretRef(kind, manifest.generation, id);
    const encoded = await options.store.get(ref);
    if (encoded === null) throw new Error("SecretStore active credential generation is incomplete");
    const entry = parseStoredEntry(encoded, kind, id);
    assignCredential(credentials, kind, id, entry);
  }
  try {
    await cleanupGenerationMarkers(options.store);
    await cleanupCredentialGenerations(options.store, manifest.retired ?? []);
  } catch (error) {
    throw new CredentialRetirementError(error);
  }
  return credentials;
}

export async function writeCredentials(
  credentials: ZhixingCredentials,
  options: CredentialMutationOptions,
): Promise<void> {
  await mutationCoordinator(options).runExclusive(async () => {
    const current = await loadCredentialsUnlocked(options);
    const merged = applyCredentialsPatch(current, credentials, "replace");
    validateCredentials(merged, "SecretStore input");
    await replaceCredentialSet(
      options.store,
      credentialEntries(merged),
      merged.version,
    );
  });
}

export async function migrateLegacyCredentials(
  options: LegacyCredentialMigrationOptions,
): Promise<{ migrated: boolean; entries: number }> {
  return mutationCoordinator(options).runExclusive(() => migrateLegacyCredentialsUnlocked(options));
}

export async function loadCredentialsWithLegacyMigration(
  options: LegacyCredentialMigrationOptions,
): Promise<{
  readonly credentials: ZhixingCredentials;
  readonly generation: string | null;
  readonly migration: { readonly migrated: boolean; readonly entries: number };
}> {
  return mutationCoordinator(options).runExclusive(async () => {
    const migration = await migrateLegacyCredentialsUnlocked(options);
    const credentials = await loadCredentialsUnlocked(options);
    const generation = await readActiveGeneration(options.store);
    if (await legacyCredentialsPresent(options.homeDir)) {
      throw new CredentialsSchemaError(
        "旧明文凭据仍然存在，设备不能进入 ready。",
        getCredentialsPath(options.homeDir),
      );
    }
    return { credentials, generation, migration };
  });
}

async function migrateLegacyCredentialsUnlocked(
  options: LegacyCredentialMigrationOptions,
): Promise<{ migrated: boolean; entries: number }> {
  const filePath = getCredentialsPath(options.homeDir);
  try {
    await cleanupLegacyCredentialTemps(filePath);
  } catch (error) {
    throw new CredentialsSchemaError(
      `旧凭据临时文件无法安全清退：${safeErrorMessage(error)}`,
      filePath,
    );
  }
  let source: LegacySourceSnapshot;
  try {
    source = await readLegacySource(filePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { migrated: false, entries: 0 };
    if (error instanceof CredentialsSchemaError) throw error;
    throw new CredentialsSchemaError("读取旧凭据文件失败，未执行迁移。", filePath);
  }

  let credentials: ZhixingCredentials;
  try {
    credentials = JSON.parse(source.raw) as ZhixingCredentials;
    validateCredentials(credentials, filePath);
  } catch (error) {
    if (error instanceof CredentialsSchemaError) throw error;
    throw new CredentialsSchemaError("旧凭据文件格式无效，未执行迁移。", filePath);
  }

  const entries = credentialEntries(credentials);
  const activeManifest = await options.store.get(MANIFEST_REF);
  if (activeManifest !== null) {
    const active = await loadCredentialsUnlocked(options);
    if (!sameValue(canonicalJson(active), canonicalJson(credentials))) {
      throw new CredentialsSchemaError(
        "SecretStore 已有不同凭据，拒绝用旧明文文件覆盖；请通过显式恢复流程裁决。",
        filePath,
      );
    }
    try {
      await retireLegacySource(filePath, source);
      await syncDirectory(path.dirname(filePath));
    } catch (error) {
      throw new CredentialsSchemaError(
        `安全存储与旧文件一致，但旧明文文件无法清退：${safeErrorMessage(error)}`,
        filePath,
      );
    }
    return { migrated: true, entries: entries.size };
  }
  try {
    await replaceCredentialSet(
      options.store,
      entries,
      credentials.version,
      () => retireLegacySource(filePath, source),
    );
  } catch (error) {
    if (error instanceof CredentialCommitStateUnknownError) {
      throw new CredentialsSchemaError(
        `凭据激活状态未知，旧明文文件已保留；下次启动将重新读取并收敛：${safeErrorMessage(error)}`,
        filePath,
      );
    }
    if (error instanceof CredentialPostCommitError || error instanceof CredentialRetirementError) {
      throw new CredentialsSchemaError(
        `凭据已安全激活，但迁移收尾尚未完成：${safeErrorMessage(error)}`,
        filePath,
      );
    }
    throw new CredentialsSchemaError(
      `旧凭据迁移失败，明文源文件保持不变：${safeErrorMessage(error)}`,
      filePath,
    );
  }

  try {
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    throw new CredentialsSchemaError(
      `凭据已安全写入但旧明文文件无法清退：${safeErrorMessage(error)}`,
      filePath,
    );
  }
  return { migrated: true, entries: entries.size };
}

async function readLegacySource(filePath: string): Promise<LegacySourceSnapshot> {
  const pathStats = await lstat(filePath);
  if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.nlink !== 1) {
    throw new CredentialsSchemaError("旧凭据迁移源必须是单一普通文件。", filePath);
  }
  const handle = await open(filePath, "r");
  try {
    const openedStats = await handle.stat();
    if (
      !openedStats.isFile() ||
      openedStats.dev !== pathStats.dev ||
      openedStats.ino !== pathStats.ino ||
      openedStats.nlink !== 1
    ) {
      throw new CredentialsSchemaError("旧凭据迁移源在读取前已发生替换。", filePath);
    }
    const raw = await handle.readFile("utf8");
    return {
      raw,
      dev: openedStats.dev,
      ino: openedStats.ino,
      size: openedStats.size,
      mtimeMs: openedStats.mtimeMs,
      digest: createHash("sha256").update(raw, "utf8").digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

async function retireLegacySource(
  filePath: string,
  expected: LegacySourceSnapshot,
): Promise<void> {
  const current = await lstat(filePath);
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.nlink !== 1 ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.size !== expected.size ||
    current.mtimeMs !== expected.mtimeMs
  ) {
    throw new Error("旧凭据迁移源在清退前已发生替换");
  }
  const currentRaw = await readFile(filePath, "utf8");
  const currentDigest = createHash("sha256").update(currentRaw, "utf8").digest("hex");
  if (!sameValue(currentDigest, expected.digest)) {
    throw new Error("旧凭据迁移源在清退前已发生变更");
  }
  await unlink(filePath);
}

export async function exportCredentialsToLegacyFile(
  options: LegacyCredentialExportOptions,
): Promise<string> {
  if (options.acknowledgePlaintextRisk !== true) {
    throw new TypeError("Legacy credential export requires explicit plaintext-risk acknowledgement");
  }
  return mutationCoordinator(options).runExclusive(async () => {
    const credentials = await loadCredentialsUnlocked(options);
    const filePath = getCredentialsPath(options.homeDir);
    await cleanupLegacyCredentialTemps(filePath);
    await writePrivateJsonAtomic(filePath, credentials);
    return filePath;
  });
}

function mutationCoordinator(options: CredentialMutationOptions): CredentialStoreCoordinator {
  return "coordinator" in options && options.coordinator
    ? options.coordinator
    : options.store;
}

function credentialSecretRef(
  kind: CredentialKind,
  generation: string,
  id: string,
): SecretRef {
  if (!/^[A-Za-z0-9_-]{16,64}$/u.test(generation)) {
    throw new TypeError("Credential generation is invalid");
  }
  if (!id || id.trim() !== id || /[\u0000-\u001f\u007f]/u.test(id)) {
    throw new TypeError("Credential binding id is invalid");
  }
  const encodedId = Buffer.from(id, "utf8").toString("base64url");
  const bindingId = `${GENERATION_NAMESPACE}${generation}/${encodedId}`;
  if (bindingId.length > 512) {
    throw new TypeError("Credential binding id exceeds the SecretStore limit");
  }
  return { kind, bindingId };
}

export function applyCredentialsPatch(
  current: ZhixingCredentials,
  patch: Partial<ZhixingCredentials>,
  idMapMode: "merge" | "replace" = "merge",
): ZhixingCredentials {
  const result: ZhixingCredentials = { ...current };
  if (patch.version !== undefined) result.version = patch.version;

  if (patch.providers !== undefined) {
    result.providers =
      idMapMode === "replace"
        ? patch.providers
        : mergeIdMap(current.providers, patch.providers);
  }
  if (patch.channels !== undefined) {
    result.channels =
      idMapMode === "replace"
        ? patch.channels
        : mergeIdMap(current.channels, patch.channels);
  }
  if (patch.mcp !== undefined) {
    result.mcp =
      idMapMode === "replace" ? patch.mcp : mergeIdMap(current.mcp, patch.mcp);
  }

  return result;
}

async function replaceCredentialSet(
  store: SecretStorePort,
  target: ReadonlyMap<string, { kind: CredentialKind; id: string; value: string }>,
  credentialSchemaVersion?: number,
  afterApply?: () => Promise<void>,
): Promise<void> {
  if ((await store.unlockState()) !== "unlocked") {
    throw new Error("SecretStore is not unlocked");
  }
  const previousManifest = await store.get(MANIFEST_REF);
  const previous = previousManifest === null ? null : parseManifest(previousManifest);
  const pendingRetired = previous
    ? await retainPresentGenerations(store, previous.retired ?? [])
    : [];
  const generation = randomBytes(16).toString("base64url");
  const staged = [...target.values()].map(({ kind, id, value }) => ({
    ref: credentialSecretRef(kind, generation, id),
    value,
  }));
  const manifest: CredentialManifest = {
    v: 1,
    generation,
    ...(credentialSchemaVersion !== undefined ? { credentialSchemaVersion } : {}),
    entries: [...target.values()]
      .map(({ kind, id }) => ({ kind, id }))
      .sort((left, right) => `${left.kind}/${left.id}`.localeCompare(`${right.kind}/${right.id}`)),
    ...(previous
      ? {
          retired: [
            ...pendingRetired,
            { generation: previous.generation, entries: previous.entries },
          ],
        }
      : {}),
  };
  const encodedManifest = JSON.stringify(manifest);
  const markerRef = credentialGenerationMarkerRef(generation);
  const marker: CredentialGenerationMarker = {
    v: 1,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    state: "staging",
    generation,
    entries: manifest.entries,
  };
  const encodedMarker = JSON.stringify(marker);

  try {
    await store.put(markerRef, encodedMarker);
    if ((await store.get(markerRef)) !== encodedMarker) {
      throw new Error("SecretStore generation marker read-back verification failed");
    }
    for (const { ref, value } of staged) {
      await store.put(ref, value);
      const readBack = await store.get(ref);
      if (readBack === null || !sameValue(readBack, value)) {
        throw new Error("SecretStore read-back verification failed");
      }
    }
  } catch (error) {
    try {
      await cleanupUncommittedGeneration(store, markerRef, marker);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Credential migration rollback failed");
    }
    throw error;
  }

  const postCommitErrors: unknown[] = [];
  try {
    await store.put(MANIFEST_REF, encodedManifest);
  } catch (error) {
    postCommitErrors.push(error);
  }
  let currentManifest: string | null;
  try {
    currentManifest = await store.get(MANIFEST_REF);
  } catch (error) {
    throw new CredentialCommitStateUnknownError([...postCommitErrors, error]);
  }
  if (currentManifest === null || !sameValue(currentManifest, encodedManifest)) {
    const conflict = new Error("SecretStore credential update was superseded by a concurrent writer");
    const primary = postCommitErrors[0] ?? conflict;
    try {
      await cleanupUncommittedGeneration(store, markerRef, marker);
    } catch (cleanupError) {
      throw new AggregateError(
        postCommitErrors.length > 0
          ? [primary, cleanupError]
          : [conflict, cleanupError],
        "Uncommitted credential generation cleanup failed",
      );
    }
    throw primary;
  }

  const committedMarker = JSON.stringify({ ...marker, state: "committed" });
  try {
    await store.put(markerRef, committedMarker);
    if ((await store.get(markerRef)) !== committedMarker) {
      throw new Error("SecretStore committed-generation marker read-back verification failed");
    }
  } catch (error) {
    postCommitErrors.push(error);
  }
  try {
    await afterApply?.();
  } catch (error) {
    postCommitErrors.push(error);
  }
  try {
    await cleanupGenerationMarkers(store);
    await cleanupCredentialGenerations(store, manifest.retired ?? []);
  } catch (error) {
    postCommitErrors.push(error);
  }
  if (postCommitErrors.length > 0) {
    throw new CredentialPostCommitError(postCommitErrors);
  }
}

function credentialGenerationMarkerRef(generation: string): SecretRef {
  if (!/^[A-Za-z0-9_-]{16,64}$/u.test(generation)) {
    throw new TypeError("Credential generation is invalid");
  }
  return { kind: "provider", bindingId: `${GENERATION_MARKER_NAMESPACE}${generation}` };
}

function credentialEntries(
  credentials: ZhixingCredentials,
): Map<string, { kind: CredentialKind; id: string; value: string }> {
  const result = new Map<string, { kind: CredentialKind; id: string; value: string }>();
  addEntries(result, "provider", credentials.providers);
  addEntries(result, "channel", credentials.channels);
  addEntries(result, "mcp", credentials.mcp);
  return result;
}

function addEntries(
  target: Map<string, { kind: CredentialKind; id: string; value: string }>,
  kind: CredentialKind,
  entries: Record<string, unknown> | undefined,
): void {
  for (const [id, entry] of Object.entries(entries ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    validateBindingId(kind, id);
    target.set(`${kind}/${id}`, { kind, id, value: JSON.stringify(entry) });
  }
}

function assignCredential(
  credentials: ZhixingCredentials,
  kind: CredentialKind,
  id: string,
  entry: unknown,
): void {
  if (kind === "provider") {
    credentials.providers ??= {};
    credentials.providers[id] = entry as NonNullable<ZhixingCredentials["providers"]>[string];
  } else if (kind === "channel") {
    credentials.channels ??= {};
    credentials.channels[id] = entry as Record<string, string>;
  } else {
    credentials.mcp ??= {};
    credentials.mcp[id] = entry as Record<string, string>;
  }
}

function parseStoredEntry(value: string, kind: CredentialKind, id: string): unknown {
  try {
    const entry = JSON.parse(value) as unknown;
    validateEntry(kind, id, entry, "SecretStore");
    return entry;
  } catch (error) {
    throw new Error(`SecretStore credential entry ${kind}/${id} is invalid`, { cause: error });
  }
}

function validateCredentials(value: ZhixingCredentials, source: string): void {
  if (!isPlainObject(value)) throw new CredentialsSchemaError("凭据根结构必须是对象。", source);
  const allowed = new Set(["version", "providers", "channels", "mcp"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new CredentialsSchemaError("凭据文件包含未知顶层字段。", source);
  }
  const version = value.version;
  if (
    version !== undefined &&
    (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1)
  ) {
    throw new CredentialsSchemaError("凭据版本无效。", source);
  }
  validateTable("provider", value.providers, source);
  validateTable("channel", value.channels, source);
  validateTable("mcp", value.mcp, source);
}

function validateTable(kind: CredentialKind, value: unknown, source: string): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) throw new CredentialsSchemaError(`${kind} 凭据表必须是对象。`, source);
  for (const [id, entry] of Object.entries(value)) validateEntry(kind, id, entry, source);
}

function validateEntry(kind: CredentialKind, id: string, entry: unknown, source: string): void {
  validateBindingId(kind, id);
  if (!isPlainObject(entry)) throw new CredentialsSchemaError(`${kind} 凭据条目必须是对象。`, source);
  if (kind !== "provider") {
    if (Object.values(entry).some((value) => typeof value !== "string")) {
      throw new CredentialsSchemaError(`${kind} 凭据字段必须是字符串。`, source);
    }
    return;
  }
  if (Object.keys(entry).some((field) => !PROVIDER_FIELDS.has(field))) {
    throw new CredentialsSchemaError("provider 凭据包含未知字段。", source);
  }
  if (typeof entry.apiKey !== "string") {
    throw new CredentialsSchemaError("provider 凭据必须包含字符串 apiKey。", source);
  }
  if (entry.baseUrl !== undefined && typeof entry.baseUrl !== "string") {
    throw new CredentialsSchemaError("provider baseUrl 必须是字符串。", source);
  }
  if (
    entry.protocol !== undefined &&
    entry.protocol !== "openai-compatible" &&
    entry.protocol !== "anthropic-messages"
  ) {
    throw new CredentialsSchemaError("provider protocol 无效。", source);
  }
  validateQuirks(entry.quirks, source);
  validateModelOverrides(entry.modelOverrides, source);
  validateModelInputCapabilities(entry.modelInputCapabilities, source);
  validateModelList(entry.models, source);
}

function validateQuirks(value: unknown, source: string): void {
  if (value === undefined) return;
  if (!isPlainObject(value) || Object.keys(value).some((field) => !QUIRK_FIELDS.has(field))) {
    throw new CredentialsSchemaError("provider quirks 结构无效。", source);
  }
  if (
    value.maxTokensField !== undefined &&
    value.maxTokensField !== "max_tokens" &&
    value.maxTokensField !== "max_completion_tokens"
  ) {
    throw new CredentialsSchemaError("provider maxTokensField 无效。", source);
  }
  for (const field of ["supportsStreamUsage", "supportsThinking", "supportsTools"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") {
      throw new CredentialsSchemaError(`provider ${field} 必须是布尔值。`, source);
    }
  }
  if (
    value.usageDialect !== undefined &&
    !["auto", "openai-standard", "deepseek"].includes(value.usageDialect as string)
  ) {
    throw new CredentialsSchemaError("provider usageDialect 无效。", source);
  }
  if (
    value.thinkingDialect !== undefined &&
    !["none", "deepseek", "qwen", "glm", "kimi", "anthropic"].includes(
      value.thinkingDialect as string,
    )
  ) {
    throw new CredentialsSchemaError("provider thinkingDialect 无效。", source);
  }
}

function validateModelOverrides(value: unknown, source: string): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    throw new CredentialsSchemaError("provider modelOverrides 必须是对象。", source);
  }
  for (const [modelId, override] of Object.entries(value)) {
    validateMapId("model", modelId, source);
    if (
      !isPlainObject(override) ||
      Object.keys(override).some((field) => !["contextWindow", "maxOutputTokens"].includes(field))
    ) {
      throw new CredentialsSchemaError("provider modelOverrides 条目无效。", source);
    }
    for (const field of ["contextWindow", "maxOutputTokens"] as const) {
      const fieldValue = override[field];
      if (
        fieldValue !== undefined &&
        (!Number.isSafeInteger(fieldValue) || (fieldValue as number) <= 0)
      ) {
        throw new CredentialsSchemaError(`provider ${field} 必须是正安全整数。`, source);
      }
    }
  }
}

function validateModelInputCapabilities(value: unknown, source: string): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    throw new CredentialsSchemaError("provider modelInputCapabilities 必须是对象。", source);
  }
  for (const [modelId, override] of Object.entries(value)) {
    validateMapId("model", modelId, source);
    if (
      !isPlainObject(override) ||
      Object.keys(override).some((field) => field !== "images") ||
      (override.images !== undefined && typeof override.images !== "boolean")
    ) {
      throw new CredentialsSchemaError("provider modelInputCapabilities 条目无效。", source);
    }
  }
}

function validateModelList(value: unknown, source: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new CredentialsSchemaError("provider models 必须是数组。", source);
  }
  const seen = new Set<string>();
  for (const modelId of value) {
    if (typeof modelId !== "string") {
      throw new CredentialsSchemaError("provider models 条目必须是字符串。", source);
    }
    validateMapId("model", modelId, source);
    if (seen.has(modelId)) throw new CredentialsSchemaError("provider models 不得重复。", source);
    seen.add(modelId);
  }
}

function validateMapId(kind: string, id: string, source: string): void {
  if (!id || id.trim() !== id || /[\u0000-\u001f\u007f]/u.test(id)) {
    throw new CredentialsSchemaError(`${kind} 标识无效。`, source);
  }
}

function validateBindingId(kind: CredentialKind, id: string): void {
  credentialSecretRef(kind, "0123456789abcdef", id);
}

function parseManifest(encoded: string): CredentialManifest {
  try {
    const value = JSON.parse(encoded) as Record<string, unknown>;
    if (
      value.v !== 1 ||
      Object.keys(value).some(
        (field) =>
          !["v", "generation", "credentialSchemaVersion", "entries", "retired"].includes(field),
      ) ||
      (value.credentialSchemaVersion !== undefined &&
        (!Number.isSafeInteger(value.credentialSchemaVersion) ||
          (value.credentialSchemaVersion as number) < 1)) ||
      (value.retired !== undefined && !Array.isArray(value.retired))
    ) {
      throw new TypeError("Credential manifest schema is invalid");
    }
    const active = parseCredentialGeneration({
      generation: value.generation,
      entries: value.entries,
    });
    const retired = (value.retired as unknown[] | undefined)?.map(parseCredentialGeneration) ?? [];
    const generations = new Set([active.generation]);
    for (const generation of retired) {
      if (generations.has(generation.generation)) {
        throw new TypeError("Credential manifest contains duplicate generations");
      }
      generations.add(generation.generation);
    }
    return {
      v: 1,
      ...active,
      ...(value.credentialSchemaVersion !== undefined
        ? { credentialSchemaVersion: value.credentialSchemaVersion as number }
        : {}),
      ...(retired.length > 0 ? { retired } : {}),
    };
  } catch (error) {
    throw new Error("SecretStore credential manifest is invalid", { cause: error });
  }
}

function parseCredentialGeneration(value: unknown): CredentialGeneration {
  if (
    !isPlainObject(value) ||
    typeof value.generation !== "string" ||
    !/^[A-Za-z0-9_-]{16,64}$/u.test(value.generation) ||
    !Array.isArray(value.entries) ||
    Object.keys(value).some((field) => !["generation", "entries"].includes(field))
  ) {
    throw new TypeError("Credential generation schema is invalid");
  }
  const seen = new Set<string>();
  const entries = value.entries.map((entry) => {
    if (
      !isPlainObject(entry) ||
      !CREDENTIAL_KINDS.includes(entry.kind as CredentialKind) ||
      typeof entry.id !== "string" ||
      Object.keys(entry).some((field) => !["kind", "id"].includes(field))
    ) {
      throw new TypeError("Credential manifest entry is invalid");
    }
    validateBindingId(entry.kind as CredentialKind, entry.id);
    const key = `${entry.kind}/${entry.id}`;
    if (seen.has(key)) throw new TypeError("Credential manifest contains duplicate entries");
    seen.add(key);
    return { kind: entry.kind as CredentialKind, id: entry.id };
  });
  return { generation: value.generation, entries };
}

function generationRefs(generation: CredentialGeneration): SecretRef[] {
  return generation.entries.map(({ kind, id }) =>
    credentialSecretRef(kind, generation.generation, id),
  );
}

async function retainPresentGenerations(
  store: SecretStorePort,
  generations: readonly CredentialGeneration[],
): Promise<CredentialGeneration[]> {
  const retained: CredentialGeneration[] = [];
  for (const generation of generations) {
    let present = false;
    for (const ref of generationRefs(generation)) {
      if ((await store.get(ref)) !== null) {
        present = true;
        break;
      }
    }
    if (present) retained.push(generation);
  }
  return retained;
}

async function cleanupCredentialGenerations(
  store: SecretStorePort,
  generations: readonly CredentialGeneration[],
): Promise<void> {
  const errors: unknown[] = [];
  for (const generation of generations) {
    for (const ref of generationRefs(generation)) {
      try {
        await store.delete(ref);
        if ((await store.get(ref)) !== null) {
          throw new Error("SecretStore retained a retired credential entry");
        }
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Retired credential generation cleanup failed");
  }
}

async function cleanupUncommittedGeneration(
  store: SecretStorePort,
  markerRef: SecretRef,
  marker: CredentialGenerationMarker,
): Promise<void> {
  const errors: unknown[] = [];
  await cleanupCredentialGenerations(store, [marker]).catch((error: unknown) => errors.push(error));
  if (errors.length === 0) {
    try {
      await store.delete(markerRef);
      if ((await store.get(markerRef)) !== null) {
        throw new Error("SecretStore retained an uncommitted generation marker");
      }
      return;
    } catch (error) {
      errors.push(error);
    }
  }

  try {
    const aborted = JSON.stringify({ ...marker, state: "aborted" });
    await store.put(markerRef, aborted);
    if ((await store.get(markerRef)) !== aborted) {
      throw new Error("SecretStore aborted-generation marker read-back verification failed");
    }
  } catch (error) {
    errors.push(error);
  }
  throw new AggregateError(errors, "Uncommitted credential generation cleanup failed");
}

async function cleanupGenerationMarkers(
  store: SecretStorePort,
): Promise<void> {
  const markers = await store.list(`provider/${GENERATION_MARKER_NAMESPACE}`);
  const errors: unknown[] = [];
  for (const ref of markers) {
    try {
      if (ref.kind !== "provider" || !ref.bindingId.startsWith(GENERATION_MARKER_NAMESPACE)) {
        throw new Error("SecretStore returned an invalid credential generation marker reference");
      }
      const encoded = await store.get(ref);
      if (encoded === null) continue;
      const marker = parseGenerationMarker(encoded);
      if (ref.bindingId !== `${GENERATION_MARKER_NAMESPACE}${marker.generation}`) {
        throw new Error("Credential generation marker does not match its reference");
      }
      const activeGeneration = await readActiveGeneration(store);
      if (marker.generation === activeGeneration) {
        if (marker.state === "aborted") {
          throw new Error("Active credential generation is marked aborted");
        }
        if (marker.state === "staging") {
          const committed = JSON.stringify({ ...marker, state: "committed" });
          await store.put(ref, committed);
          if ((await store.get(ref)) !== committed) {
            throw new Error("SecretStore could not recover the active generation marker");
          }
        }
        continue;
      }
      await cleanupCredentialGenerations(store, [marker]);
      await store.delete(ref);
      if ((await store.get(ref)) !== null) {
        throw new Error("SecretStore retained an obsolete credential generation marker");
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Credential generation marker cleanup failed");
  }
}

async function readActiveGeneration(store: SecretStorePort): Promise<string | null> {
  const encoded = await store.get(MANIFEST_REF);
  return encoded === null ? null : parseManifest(encoded).generation;
}

function parseGenerationMarker(encoded: string): CredentialGenerationMarker {
  const value = JSON.parse(encoded) as Record<string, unknown>;
  if (
    value.v !== 1 ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    typeof value.createdAt !== "string" ||
    new Date(value.createdAt).toISOString() !== value.createdAt ||
    (value.state !== "staging" && value.state !== "committed" && value.state !== "aborted") ||
    Object.keys(value).some(
      (field) => !["v", "pid", "createdAt", "state", "generation", "entries"].includes(field),
    )
  ) {
    throw new TypeError("Credential generation marker is invalid");
  }
  return {
    v: 1,
    pid: value.pid as number,
    createdAt: value.createdAt,
    state: value.state,
    ...parseCredentialGeneration({
      generation: value.generation,
      entries: value.entries,
    }),
  };
}

function sameValue(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Credential value is not finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Credential value cannot be canonicalized");
}

async function writePrivateJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);
    await link(temporary, filePath);
    await unlink(temporary);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function cleanupLegacyCredentialTemps(filePath: string): Promise<void> {
  const directory = path.dirname(filePath);
  const entries = await readdir(directory).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  });
  let removed = false;
  for (const entry of entries) {
    if (isLegacyCredentialTemp(filePath, entry)) {
      await rm(path.join(directory, entry), { force: true });
      removed = true;
    }
  }
  if (removed) await syncDirectory(directory);
}

function isLegacyCredentialTemp(filePath: string, entry: string): boolean {
  const fileName = path.basename(filePath);
  if (!entry.startsWith(`${fileName}.`) || !entry.endsWith(".tmp")) return false;
  return /^\d+\.[a-f0-9]{16}\.tmp$/u.test(
    entry.slice(fileName.length + 1),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const directory = await open(directoryPath, "r");
  try {
    await directory.sync().catch((error: unknown) => {
      if (process.platform === "win32" && (isNodeError(error, "EPERM") || isNodeError(error, "EINVAL"))) {
        return;
      }
      throw error;
    });
  } finally {
    await directory.close();
  }
}
