import { createCipheriv, createDecipheriv, createHash, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import type {
  AuthorityCommitLog,
  DurableProjectionMutation,
  DurableProjectionReadContext,
  FileAuthorityCommitLog,
} from "@zhixing/core/authority";
import { DurableProjectionRecordBindingError } from "@zhixing/core/authority";
import type { ArtifactRef, JsonValue, SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { canonicalize, protocolDigest } from "@zhixing/core/protocol";
import { assertTerminalRouteSecret, createTerminalRouteSecret } from "@zhixing/mesh/bootstrap";
import type { RecoveryRoot } from "@zhixing/mesh/recovery-root";
import { encodeX25519PublicKey, importEncodedPublicKey } from "@zhixing/mesh/recovery-root";

/**
 * 家级路由材料：同一 home 两份互相独立的 32 字节随机秘密。terminal 给被移除的设备找回终态入口与终态取证，
 * discovery 给成员在值班设备更替后找到现任；两者用途严格分开。值班设备生成后不轮换，随计划迁居经已认证的
 * 迁居命令通道交给目标，随灾备经密封给恢复备份钥的制品进完整检查点。WAL、catalog 里只有密文或摘要。
 */
export interface HomeRouteMaterial {
  readonly homeId: string;
  readonly terminal: string;
  readonly discovery: string;
}

export const HOME_ROUTE_MATERIAL_STREAM = "home-route-material";
export const HOME_ROUTE_MATERIAL_PROJECTION_ID = "home-route-material-v1";
const SEALED_KEY = "sealed";
const SEAL_DOMAIN = "zhixing:home-route-material:seal:v1";

const terminalRef = (homeId: string): SecretRef => ({ kind: "terminal-route", bindingId: `home-terminal/${homeId}` });
const discoveryRef = (homeId: string): SecretRef => ({ kind: "terminal-route", bindingId: `home-discovery/${homeId}` });
const stagedRef = (transferId: string): SecretRef => ({ kind: "terminal-route", bindingId: `transfer/${transferId}` });

/** 摘要只含两份秘密各自的哈希，不泄露秘密本身；迁居与密封记录按它核一致。 */
export function homeRouteMaterialDigest(material: HomeRouteMaterial): string {
  return protocolDigest("HomeRouteMaterial", 1, {
    homeId: material.homeId,
    terminal: createHash("sha256").update(material.terminal, "utf8").digest("hex"),
    discovery: createHash("sha256").update(material.discovery, "utf8").digest("hex"),
  });
}

/** 值班设备在需要处调用：缺哪份生成哪份，写入后读回核对。 */
export async function loadOrCreateHomeRouteMaterial(store: SecretStorePort, homeId: string): Promise<HomeRouteMaterial> {
  const terminal = await loadOrCreate(store, terminalRef(homeId));
  const discovery = await loadOrCreate(store, discoveryRef(homeId));
  return Object.freeze({ homeId, terminal, discovery });
}

export async function loadHomeRouteMaterial(store: SecretStorePort, homeId: string): Promise<HomeRouteMaterial | undefined> {
  const terminal = await store.get(terminalRef(homeId));
  const discovery = await store.get(discoveryRef(homeId));
  if (terminal === null || discovery === null) return undefined;
  assertTerminalRouteSecret(terminal);
  assertTerminalRouteSecret(discovery);
  return Object.freeze({ homeId, terminal, discovery });
}

/** 成员侧只存 discovery 一份（配对时由值班设备封装下发）。 */
export async function persistHomeDiscoverySecret(store: SecretStorePort, homeId: string, secret: string): Promise<void> {
  assertTerminalRouteSecret(secret);
  const ref = discoveryRef(homeId);
  await store.put(ref, secret);
  if (await store.get(ref) !== secret) throw new Error("Home discovery secret did not survive durable read-back");
}

export async function loadHomeDiscoverySecret(store: SecretStorePort, homeId: string): Promise<string | undefined> {
  const secret = await store.get(discoveryRef(homeId));
  if (secret === null) return undefined;
  assertTerminalRouteSecret(secret);
  return secret;
}

/** 迁居目标按 transferId 暂存源端交来的材料；安装时激活。 */
export async function stageHomeRouteMaterial(store: SecretStorePort, transferId: string, material: HomeRouteMaterial): Promise<void> {
  assertMaterial(material);
  const value = canonicalize(material);
  await store.put(stagedRef(transferId), value);
  if (await store.get(stagedRef(transferId)) !== value) {
    throw new Error("Staged home route material did not survive durable read-back");
  }
}

export async function loadStagedHomeRouteMaterial(store: SecretStorePort, transferId: string): Promise<HomeRouteMaterial | undefined> {
  const value = await store.get(stagedRef(transferId));
  if (value === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Staged home route material is invalid");
  }
  const material = parsed as HomeRouteMaterial;
  assertMaterial(material);
  return Object.freeze({ homeId: material.homeId, terminal: material.terminal, discovery: material.discovery });
}

/**
 * 安装时激活（迁居暂存或灾备开封所得）：已有同 home 材料必须完全一致（A→B→A 回到原设备时即如此），
 * 不同即失败关闭；写入后读回。暂存在激活后删除。
 */
export async function installHomeRouteMaterial(
  store: SecretStorePort,
  material: HomeRouteMaterial,
  stagedTransferId?: string,
): Promise<void> {
  assertMaterial(material);
  const existing = await loadHomeRouteMaterial(store, material.homeId).catch(() => undefined);
  if (existing && homeRouteMaterialDigest(existing) !== homeRouteMaterialDigest(material)) {
    throw new Error("Installed home route material differs from this device's existing material");
  }
  for (const [ref, value] of [[terminalRef(material.homeId), material.terminal], [discoveryRef(material.homeId), material.discovery]] as const) {
    await store.put(ref, value);
    if (await store.get(ref) !== value) throw new Error("Home route material did not survive durable read-back");
  }
  if (stagedTransferId !== undefined) await store.delete(stagedRef(stagedTransferId));
}

export async function deleteStagedHomeRouteMaterial(store: SecretStorePort, transferId: string): Promise<void> {
  await store.delete(stagedRef(transferId));
}

export interface SealedHomeRouteMaterialRecord {
  readonly v: 1;
  readonly t: "home-route-material-sealed";
  readonly homeId: string;
  readonly materialDigest: string;
  readonly backupKeyId: string;
  readonly sealed: ArtifactRef;
}

export interface IndexedSealedHomeRouteMaterial extends SealedHomeRouteMaterialRecord {
  /** 记录所在 LSN：完整检查点的 upToLsn 不小于它即实际包含这条记录与其保留制品。 */
  readonly lsn: number;
}

export interface HomeRouteMaterialLogPort {
  durableProjection: AuthorityCommitLog["durableProjection"];
  transactDurableProjection: AuthorityCommitLog["transactDurableProjection"];
  readonly artifactStore: Pick<FileAuthorityCommitLog["artifactStore"], "put" | "get">;
}

export function registerHomeRouteMaterialIndex(log: Pick<HomeRouteMaterialLogPort, "durableProjection">): void {
  log.durableProjection({
    projectionId: HOME_ROUTE_MATERIAL_PROJECTION_ID,
    reducerVersion: 1,
    authenticated: true,
    inputs: { streams: [HOME_ROUTE_MATERIAL_STREAM] },
    reduce: async (envelope) => {
      const changes: DurableProjectionMutation[] = [];
      for (const record of envelope.entries) {
        if (record.stream !== HOME_ROUTE_MATERIAL_STREAM) continue;
        const body = validateSealedRecord(record.body);
        changes.push({ kind: "put", key: SEALED_KEY, value: { ...body, lsn: envelope.lsn } as unknown as JsonValue });
      }
      return changes;
    },
  });
}

export async function readSealedHomeRouteMaterial(log: HomeRouteMaterialLogPort): Promise<IndexedSealedHomeRouteMaterial | undefined> {
  registerHomeRouteMaterialIndex(log);
  return (await log.transactDurableProjection(HOME_ROUTE_MATERIAL_PROJECTION_ID, async (view: DurableProjectionReadContext) => ({
    kind: "return" as const,
    value: readIndexed(await view.get(SEALED_KEY)),
  }))).value;
}

/**
 * 当前恢复备份钥下的密封记录：已有同一备份钥与摘要的记录原样返回；没有或备份钥已轮换时重新密封并追加。
 * 读取与追加在同一投影事务内。
 */
export async function ensureSealedHomeRouteMaterial(
  log: HomeRouteMaterialLogPort,
  input: { readonly material: HomeRouteMaterial; readonly backupPublicKey: string; readonly backupKeyId: string },
): Promise<IndexedSealedHomeRouteMaterial> {
  registerHomeRouteMaterialIndex(log);
  const digest = homeRouteMaterialDigest(input.material);
  const current = await readSealedHomeRouteMaterial(log);
  if (current && current.backupKeyId === input.backupKeyId && current.materialDigest === digest && current.homeId === input.material.homeId) {
    return current;
  }
  const sealed = await log.artifactStore.put(sealHomeRouteMaterial(input.material, input.backupPublicKey, input.backupKeyId));
  const body: SealedHomeRouteMaterialRecord = {
    v: 1,
    t: "home-route-material-sealed",
    homeId: input.material.homeId,
    materialDigest: digest,
    backupKeyId: input.backupKeyId,
    sealed,
  };
  await log.transactDurableProjection(HOME_ROUTE_MATERIAL_PROJECTION_ID, async (view: DurableProjectionReadContext) => {
    const existing = readIndexed(await view.get(SEALED_KEY));
    if (existing && existing.backupKeyId === input.backupKeyId && existing.materialDigest === digest) {
      return { kind: "return" as const, value: undefined };
    }
    return {
      kind: "append" as const,
      entries: [{ stream: HOME_ROUTE_MATERIAL_STREAM, body: body as unknown as JsonValue }],
      value: undefined,
    };
  }, { candidateReferences: [sealed] });
  const written = await readSealedHomeRouteMaterial(log);
  if (!written || written.backupKeyId !== input.backupKeyId || written.materialDigest !== digest) {
    throw new Error("Sealed home route material was not recorded");
  }
  return written;
}

/** 灾备目标在安装时用恢复根开封：核 home、备份钥与摘要一致。 */
export async function openSealedHomeRouteMaterial(
  log: HomeRouteMaterialLogPort,
  recoveryRoot: Pick<RecoveryRoot, "backupKeyId" | "decapsulate">,
  homeId: string,
): Promise<HomeRouteMaterial | undefined> {
  const record = await readSealedHomeRouteMaterial(log);
  if (!record) return undefined;
  if (record.homeId !== homeId || record.backupKeyId !== recoveryRoot.backupKeyId) {
    throw new Error("Sealed home route material does not belong to this recovery root");
  }
  const material = unsealHomeRouteMaterial(Buffer.from(await log.artifactStore.get(record.sealed)), recoveryRoot);
  if (material.homeId !== homeId || homeRouteMaterialDigest(material) !== record.materialDigest) {
    throw new Error("Sealed home route material does not match its record");
  }
  return material;
}

/**
 * 接受移除前置：备份 owner 报告的当前可恢复完整检查点（当前恢复根代际、已复制到目标并回读核对）
 * 覆盖到的 LSN 不小于密封记录所在 LSN——完整检查点包含该前缀的全部记录及其保留制品，即实际包含。不比墙钟。
 */
export function backupCoversSealedMaterial(
  status: { readonly fullBackupReady: boolean; readonly upToLsn?: number },
  sealed: IndexedSealedHomeRouteMaterial,
): boolean {
  return status.fullBackupReady && typeof status.upToLsn === "number" && status.upToLsn >= sealed.lsn;
}

export function sealHomeRouteMaterial(material: HomeRouteMaterial, backupPublicKey: string, backupKeyId: string): Buffer {
  assertMaterial(material);
  const ephemeral = generateKeyPairSync("x25519");
  const enc = encodeX25519PublicKey(ephemeral.publicKey);
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: importEncodedPublicKey(backupPublicKey, "x25519") });
  const key = sealKey(shared, material.homeId, backupKeyId, enc);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`${SEAL_DOMAIN}:${material.homeId}:${backupKeyId}`, "utf8"));
  const plaintext = Buffer.from(canonicalize(material), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  plaintext.fill(0);
  key.fill(0);
  return Buffer.from(canonicalize({
    v: 1,
    homeId: material.homeId,
    backupKeyId,
    enc,
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  }), "utf8");
}

function unsealHomeRouteMaterial(bytes: Buffer, recoveryRoot: Pick<RecoveryRoot, "backupKeyId" | "decapsulate">): HomeRouteMaterial {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("Sealed home route material is invalid");
  }
  if (value.v !== 1 || typeof value.homeId !== "string" || value.backupKeyId !== recoveryRoot.backupKeyId ||
      typeof value.enc !== "string" || typeof value.nonce !== "string" || typeof value.ciphertext !== "string") {
    throw new Error("Sealed home route material is invalid");
  }
  const shared = recoveryRoot.decapsulate(value.enc);
  const key = sealKey(shared, value.homeId, recoveryRoot.backupKeyId, value.enc);
  const sealed = Buffer.from(value.ciphertext, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.nonce, "base64url"));
  decipher.setAAD(Buffer.from(`${SEAL_DOMAIN}:${value.homeId}:${recoveryRoot.backupKeyId}`, "utf8"));
  decipher.setAuthTag(sealed.subarray(sealed.byteLength - 16));
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.byteLength - 16)), decipher.final()]);
  } catch {
    throw new Error("Sealed home route material failed authentication");
  } finally {
    key.fill(0);
  }
  const material = JSON.parse(plain.toString("utf8")) as HomeRouteMaterial;
  plain.fill(0);
  assertMaterial(material);
  return Object.freeze({ homeId: material.homeId, terminal: material.terminal, discovery: material.discovery });
}

function sealKey(shared: Buffer, homeId: string, backupKeyId: string, enc: string): Buffer {
  const key = Buffer.from(hkdfSync(
    "sha256",
    shared,
    Buffer.from(SEAL_DOMAIN, "utf8"),
    Buffer.from(canonicalize({ homeId, backupKeyId, enc }), "utf8"),
    32,
  ));
  shared.fill(0);
  return key;
}

async function loadOrCreate(store: SecretStorePort, ref: SecretRef): Promise<string> {
  let secret: string;
  if (store.getOrCreate) {
    secret = await store.getOrCreate(ref, createTerminalRouteSecret);
  } else {
    const existing = await store.get(ref);
    secret = existing ?? createTerminalRouteSecret();
    if (existing === null) await store.put(ref, secret);
  }
  assertTerminalRouteSecret(secret);
  if (await store.get(ref) !== secret) throw new Error("Home route material did not survive durable read-back");
  return secret;
}

function assertMaterial(material: HomeRouteMaterial): void {
  if (!material || typeof material.homeId !== "string" || material.homeId.length === 0) {
    throw new TypeError("Home route material is invalid");
  }
  assertTerminalRouteSecret(material.terminal);
  assertTerminalRouteSecret(material.discovery);
  if (material.terminal === material.discovery) throw new TypeError("Home route material secrets must be independent");
}

function validateSealedRecord(value: unknown): SealedHomeRouteMaterialRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Sealed home route material record is invalid");
  const record = value as Record<string, unknown>;
  if (canonicalize(Object.keys(record).sort()) !== canonicalize(["backupKeyId", "homeId", "materialDigest", "sealed", "t", "v"]) ||
      record.v !== 1 || record.t !== "home-route-material-sealed" || typeof record.homeId !== "string" ||
      typeof record.materialDigest !== "string" || typeof record.backupKeyId !== "string" ||
      !record.sealed || typeof record.sealed !== "object") {
    throw new TypeError("Sealed home route material record is invalid");
  }
  return record as unknown as SealedHomeRouteMaterialRecord;
}

function readIndexed(value: JsonValue | undefined): IndexedSealedHomeRouteMaterial | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.lsn !== "number") {
    throw new DurableProjectionRecordBindingError("Home route material index row is invalid");
  }
  const { lsn, ...record } = value as Record<string, unknown>;
  return { ...validateSealedRecord(record), lsn: lsn as number };
}
