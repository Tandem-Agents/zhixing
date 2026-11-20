/**
 * 受限四角色 TUF（1.0.37）可信目录更新客户端（设计 §4.2、codex-tuf-preflight.md）。
 *
 * 完整安全与耐久不变量：
 * 1. 基于锁定、可复现的 `tuf-js@5.0.1` 窄存储补丁内联产物（4 处 `persistMetadata` 均 `await`）；
 * 2. 外包严格校验覆盖本地磁盘与网络下载的全部元数据：
 *    - 严格 RFC 3339 UTC 期限（拒绝非法日历日期与宽松 `Date.parse`，过期判断交 TUF 阶段以允许过期旧根连续轮换至合法新根）；
 *    - 仅允许 `root` / `timestamp` / `snapshot` / `targets` 四角色；
 *    - 禁止 `targets.delegations`（任何委托字段一律拒绝）；
 *    - 仅允许 `keytype: "ed25519"` + `scheme: "ed25519"`，严查 `keyid === sha256(canonicalize(key))`、
 *      拒绝重复 `keyid` 与不同 `keyid` 指向同一 Ed25519 公钥的阈值绕过；
 * 3. 原始字节耐久保存：经 `writeBytesAtomic` 直接写入原始字节，绝不重序列化；
 * 4. 每轮刷新新建 `Updater` 并在结束后丢弃（每轮独立校验时钟）；
 * 5. 目标目录先写入隔离候选路径并完成长度/SHA-256/Schema 校验后再原子激活；
 *    异常恢复只回退目标目录内容，绝不倒退已接纳的 TUF 信任根或元数据版本；
 * 6. 全程走受控单跳网络 `createConnectionDeliveryFetch`（SSRF、代理策略、私网许可与 `AbortSignal`）。
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createConnectionDeliveryFetch } from "../../adapters/delivery-transport.js";
import { writeBytesAtomic } from "../../internal/io.js";
import type { ConnectionNetworkConfig, NetworkConfig } from "../../types.js";
import {
  isStrictRfc3339Utc,
  parseCuratedCatalogBundle,
  type CuratedCatalogBundle,
} from "../schema.js";
import {
  DownloadHTTPError,
  Updater,
  canonicalize,
  type TufFetcher,
  type TufMetadataStore,
} from "./vendor/tuf-js-5.0.1-patched.mjs";

export const TUF_ALLOWED_ROLES = ["root", "timestamp", "snapshot", "targets"] as const;
export type TufRoleName = (typeof TUF_ALLOWED_ROLES)[number];

const ALLOWED_ROLE_SET = new Set<string>(TUF_ALLOWED_ROLES);
const MAX_TUF_METADATA_BYTES = 512 * 1024;
const MAX_TUF_TARGET_BYTES = 8 * 1024 * 1024;
const HEX_64_RE = /^[0-9a-f]{64}$/iu;
const HEX_128_RE = /^[0-9a-f]{128}$/iu;

export class TufSecurityPolicyError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_json"
      | "metadata_too_large"
      | "invalid_role"
      | "invalid_rfc3339"
      | "delegations_forbidden"
      | "unsupported_key_scheme"
      | "keyid_mismatch"
      | "duplicate_keyid"
      | "duplicate_public_key"
      | "invalid_threshold"
      | "invalid_signature_shape"
      | "target_hash_mismatch"
      | "target_length_mismatch"
      | "target_not_found",
  ) {
    super(message);
    this.name = "TufSecurityPolicyError";
  }
}

export interface TufMetadataSummary {
  readonly role: TufRoleName;
  readonly version: number;
  readonly expires: string;
}

/**
 * 外包安全策略校验：在 `tuf-js` 接纳或持久化任何字节之前，严格核验原始 JSON 字节。
 * 故意只校验格式/日期合法性、角色白名单、无委托、独立 Ed25519 公钥与防重复 keyid；
 * 是否过期留给 TUF 状态机在对应阶段裁决（确保允许过期旧根 v1 连续轮换至合法新根 v2）。
 */
export function validateTufMetadataBytes(
  rawBytes: Uint8Array,
  expectedRole?: TufRoleName,
): TufMetadataSummary {
  if (rawBytes.byteLength === 0 || rawBytes.byteLength > MAX_TUF_METADATA_BYTES) {
    throw new TufSecurityPolicyError(
      `TUF 元数据字节长度越界（${rawBytes.byteLength} bytes）`,
      "metadata_too_large",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(rawBytes).toString("utf8"));
  } catch {
    throw new TufSecurityPolicyError("TUF 元数据不是合法 JSON", "invalid_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TufSecurityPolicyError("TUF 元数据顶层必须是对象", "invalid_json");
  }
  const envelope = parsed as Record<string, unknown>;
  const signed = envelope["signed"];
  const signatures = envelope["signatures"];
  if (!signed || typeof signed !== "object" || Array.isArray(signed)) {
    throw new TufSecurityPolicyError("TUF 元数据缺少 signed 对象", "invalid_json");
  }
  if (!Array.isArray(signatures) || signatures.length === 0) {
    throw new TufSecurityPolicyError("TUF 元数据缺少非空 signatures 数组", "invalid_signature_shape");
  }

  // 检查 signatures 中无重复 keyid 且格式有效
  const seenSigKeyIds = new Set<string>();
  for (const sig of signatures) {
    if (!sig || typeof sig !== "object" || Array.isArray(sig)) {
      throw new TufSecurityPolicyError("TUF 签名条目形状非法", "invalid_signature_shape");
    }
    const rec = sig as Record<string, unknown>;
    const keyid = rec["keyid"];
    const sigHex = rec["sig"];
    if (typeof keyid !== "string" || !HEX_64_RE.test(keyid)) {
      throw new TufSecurityPolicyError("TUF 签名 keyid 格式非法", "invalid_signature_shape");
    }
    if (typeof sigHex !== "string" || !HEX_128_RE.test(sigHex)) {
      throw new TufSecurityPolicyError("TUF 签名仅允许 64 字节十六进制 Ed25519 签名", "invalid_signature_shape");
    }
    const normKeyId = keyid.toLowerCase();
    if (seenSigKeyIds.has(normKeyId)) {
      throw new TufSecurityPolicyError(`TUF 元数据包含重复签名 keyid：${normKeyId}`, "duplicate_keyid");
    }
    seenSigKeyIds.add(normKeyId);
  }

  const s = signed as Record<string, unknown>;
  const roleType = s["_type"];
  if (typeof roleType !== "string" || !ALLOWED_ROLE_SET.has(roleType)) {
    throw new TufSecurityPolicyError(`TUF 元数据包含受限四角色之外的 _type：${String(roleType)}`, "invalid_role");
  }
  if (expectedRole && roleType !== expectedRole) {
    throw new TufSecurityPolicyError(
      `TUF 元数据角色不匹配：期望 ${expectedRole}，实际 ${roleType}`,
      "invalid_role",
    );
  }
  const version = s["version"];
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    throw new TufSecurityPolicyError(`TUF ${roleType} version 非法：${String(version)}`, "invalid_json");
  }
  const expires = s["expires"];
  if (!isStrictRfc3339Utc(expires)) {
    throw new TufSecurityPolicyError(
      `TUF ${roleType} expires 必须是严格 RFC 3339 UTC 时间：${String(expires)}`,
      "invalid_rfc3339",
    );
  }

  if (roleType === "root") {
    validateRootRoleStrict(s);
  } else if (roleType === "targets") {
    if ("delegations" in s && s["delegations"] !== undefined) {
      throw new TufSecurityPolicyError(
        "受限四角色 TUF 策略明确禁止 targets.delegations 委托字段",
        "delegations_forbidden",
      );
    }
  }

  return {
    role: roleType as TufRoleName,
    version,
    expires,
  };
}

function validateRootRoleStrict(signed: Record<string, unknown>): void {
  const keys = signed["keys"];
  const roles = signed["roles"];
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) {
    throw new TufSecurityPolicyError("root.keys 必须是对象", "invalid_json");
  }
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) {
    throw new TufSecurityPolicyError("root.roles 必须是对象", "invalid_json");
  }
  const keysMap = keys as Record<string, unknown>;
  const rolesMap = roles as Record<string, unknown>;

  // 严格限定仅存在四个标准角色
  const roleNames = Object.keys(rolesMap);
  if (
    roleNames.length !== TUF_ALLOWED_ROLES.length ||
    !TUF_ALLOWED_ROLES.every((r) => Object.hasOwn(rolesMap, r))
  ) {
    throw new TufSecurityPolicyError(
      `root.roles 必须且仅包含四角色（root/timestamp/snapshot/targets），实际：${roleNames.join(", ")}`,
      "invalid_role",
    );
  }

  // 验证每把公钥均为独立合规 Ed25519 且 keyid === sha256(canonicalize(keyObj))
  const pubHexByKeyId = new Map<string, string>();
  for (const [keyid, keyVal] of Object.entries(keysMap)) {
    if (!HEX_64_RE.test(keyid)) {
      throw new TufSecurityPolicyError(`root.keys 包含非法 keyid：${keyid}`, "keyid_mismatch");
    }
    if (!keyVal || typeof keyVal !== "object" || Array.isArray(keyVal)) {
      throw new TufSecurityPolicyError(`root.keys[${keyid}] 必须是对象`, "unsupported_key_scheme");
    }
    const k = keyVal as Record<string, unknown>;
    if (k["keytype"] !== "ed25519" || k["scheme"] !== "ed25519") {
      throw new TufSecurityPolicyError(
        `受限 TUF 仅允许 ed25519 公钥与签名方案（发现 ${String(k["keytype"])}/${String(k["scheme"])}）`,
        "unsupported_key_scheme",
      );
    }
    const kv = k["keyval"];
    if (!kv || typeof kv !== "object" || Array.isArray(kv)) {
      throw new TufSecurityPolicyError(`root.keys[${keyid}].keyval 非法`, "unsupported_key_scheme");
    }
    const pub = (kv as Record<string, unknown>)["public"];
    if (typeof pub !== "string" || !HEX_64_RE.test(pub)) {
      throw new TufSecurityPolicyError(
        `root.keys[${keyid}].keyval.public 必须是 32 字节十六进制 Ed25519 公钥`,
        "unsupported_key_scheme",
      );
    }
    const expectedKeyId = crypto
      .createHash("sha256")
      .update(canonicalize(k), "utf8")
      .digest("hex");
    if (expectedKeyId !== keyid.toLowerCase()) {
      throw new TufSecurityPolicyError(
        `root.keys[${keyid}] 的 keyid 与 canonicalize(key) SHA-256 不一致`,
        "keyid_mismatch",
      );
    }
    pubHexByKeyId.set(keyid.toLowerCase(), pub.toLowerCase());
  }

  // 校验四角色阈值：禁止同角色重复 keyid 或不同 keyid 复用同一 Ed25519 公钥
  for (const roleName of TUF_ALLOWED_ROLES) {
    const roleDef = rolesMap[roleName];
    if (!roleDef || typeof roleDef !== "object" || Array.isArray(roleDef)) {
      throw new TufSecurityPolicyError(`root.roles.${roleName} 必须是对象`, "invalid_threshold");
    }
    const r = roleDef as Record<string, unknown>;
    const threshold = r["threshold"];
    const keyids = r["keyids"];
    if (typeof threshold !== "number" || !Number.isSafeInteger(threshold) || threshold < 1) {
      throw new TufSecurityPolicyError(`root.roles.${roleName}.threshold 非法`, "invalid_threshold");
    }
    if (!Array.isArray(keyids) || keyids.length < threshold) {
      throw new TufSecurityPolicyError(
        `root.roles.${roleName}.keyids 数量不足以满足 threshold=${threshold}`,
        "invalid_threshold",
      );
    }
    const seenIds = new Set<string>();
    const seenPubs = new Set<string>();
    for (const rawId of keyids) {
      if (typeof rawId !== "string") {
        throw new TufSecurityPolicyError(`root.roles.${roleName}.keyids 含非字符串`, "invalid_threshold");
      }
      const normId = rawId.toLowerCase();
      if (seenIds.has(normId)) {
        throw new TufSecurityPolicyError(
          `root.roles.${roleName}.keyids 包含重复 keyid：${normId}`,
          "duplicate_keyid",
        );
      }
      seenIds.add(normId);
      const pubHex = pubHexByKeyId.get(normId);
      if (!pubHex) {
        throw new TufSecurityPolicyError(
          `root.roles.${roleName} 引用未在 root.keys 声明的 keyid：${normId}`,
          "keyid_mismatch",
        );
      }
      if (seenPubs.has(pubHex)) {
        throw new TufSecurityPolicyError(
          `root.roles.${roleName} 中多个 keyid 复用同一 Ed25519 公钥（拒绝阈值绕过）`,
          "duplicate_public_key",
        );
      }
      seenPubs.add(pubHex);
    }
  }
}

export interface TufRepositorySource {
  readonly metadataBaseUrl: string;
  readonly targetsBaseUrl: string;
  readonly targetPath: string;
  /** 初始信任根原始字节（仅在本地尚无已接纳 `root.json` 时引导落盘，绝不覆盖更新的已接纳根）。 */
  readonly bootstrapRootBytes: Uint8Array;
  readonly network?: ConnectionNetworkConfig;
  readonly networkProxy?: NetworkConfig["proxy"];
}

export interface RefreshCatalogWithTufOptions {
  readonly storeDir: string;
  readonly repository: TufRepositorySource;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** 仅用于测试故障注入（如模拟写入中断/崩溃时验证未推进下一阶段且不破坏已有目录）。 */
  readonly writeInterceptor?: (
    stage: "metadata" | "candidate" | "active",
    name: string,
    bytes: Uint8Array,
  ) => Promise<void> | void;
  /** 可选自定义受控 Fetcher（默认使用 `createConnectionDeliveryFetch`）。 */
  readonly customFetch?: typeof fetch;
}

export interface TufRefreshOutcome {
  readonly catalog: CuratedCatalogBundle;
  readonly catalogBytes: Buffer;
  readonly catalogSha256: string;
  readonly rootVersion: number;
  readonly timestampVersion: number;
  readonly snapshotVersion: number;
  readonly targetsVersion: number;
}

export function resolveTufMetadataDir(storeDir: string): string {
  return path.join(storeDir, "tuf-metadata");
}

export function resolveActiveCatalogPath(storeDir: string): string {
  return path.join(storeDir, "active-catalog.json");
}

export function resolvePreviousCatalogPath(storeDir: string): string {
  return path.join(storeDir, "previous-catalog.json");
}

export function resolveActiveTargetsProofPath(storeDir: string): string {
  return path.join(storeDir, "active-catalog.tuf-targets.json");
}

export function resolvePreviousTargetsProofPath(storeDir: string): string {
  return path.join(storeDir, "previous-catalog.tuf-targets.json");
}

export function resolveTufRootHistoryDir(storeDir: string): string {
  return path.join(resolveTufMetadataDir(storeDir), "root-history");
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

interface ParsedTufEnvelope {
  readonly signed: Record<string, unknown>;
  readonly signatures: readonly { readonly keyid: string; readonly sig: string }[];
}

function parseValidatedEnvelope(rawBytes: Uint8Array, expectedRole?: TufRoleName): ParsedTufEnvelope {
  validateTufMetadataBytes(rawBytes, expectedRole);
  return JSON.parse(Buffer.from(rawBytes).toString("utf8")) as ParsedTufEnvelope;
}

function createEd25519PublicKeyFromHex(pubHex: string): crypto.KeyObject {
  return crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pubHex, "hex")]),
    format: "der",
    type: "spki",
  });
}

/**
 * 真实 Ed25519 阈值验签：用指定 root 元数据中该角色的授权公钥集合与阈值，
 * 对 `canonicalize(envelope.signed)` 逐条核验签名，要求不同 keyid 且不同 Ed25519 公钥的
 * 合法签名数达到 `role.threshold`。
 */
export function verifyTufEnvelopeSignatureAgainstRoot(
  envelopeBytes: Uint8Array,
  rootEnvelopeBytes: Uint8Array,
  role: TufRoleName,
): { readonly version: number; readonly signed: Record<string, unknown> } {
  const rootEnv = parseValidatedEnvelope(rootEnvelopeBytes, "root");
  const targetEnv = parseValidatedEnvelope(envelopeBytes, role);
  const rootKeys = rootEnv.signed["keys"] as Record<
    string,
    { readonly keyval: { readonly public: string } }
  >;
  const rootRoles = rootEnv.signed["roles"] as Record<
    string,
    { readonly keyids: readonly string[]; readonly threshold: number }
  >;
  const roleDef = rootRoles[role];
  if (!roleDef) {
    throw new TufSecurityPolicyError(`root.roles 缺少角色 ${role}`, "invalid_role");
  }
  const authorizedKeyIds = new Set(roleDef.keyids.map((id) => id.toLowerCase()));
  const payload = Buffer.from(canonicalize(targetEnv.signed), "utf8");
  const verifiedKeyIds = new Set<string>();
  const verifiedPubKeys = new Set<string>();

  for (const sig of targetEnv.signatures) {
    const normKeyId = sig.keyid.toLowerCase();
    if (!authorizedKeyIds.has(normKeyId) || verifiedKeyIds.has(normKeyId)) continue;
    const keyEntry = Object.entries(rootKeys).find(([k]) => k.toLowerCase() === normKeyId)?.[1];
    if (!keyEntry) continue;
    const pubHex = keyEntry.keyval.public.toLowerCase();
    if (verifiedPubKeys.has(pubHex)) continue;
    try {
      const keyObj = createEd25519PublicKeyFromHex(pubHex);
      const ok = crypto.verify(null, payload, keyObj, Buffer.from(sig.sig, "hex"));
      if (ok) {
        verifiedKeyIds.add(normKeyId);
        verifiedPubKeys.add(pubHex);
      }
    } catch {
      // 忽略单条非法签名，统一按阈值判定
    }
  }

  if (verifiedPubKeys.size < roleDef.threshold) {
    throw new TufSecurityPolicyError(
      `TUF ${role} Ed25519 签名未满足阈值（需要 ${roleDef.threshold}，有效 ${verifiedPubKeys.size}）`,
      "invalid_signature_shape",
    );
  }
  return {
    version: targetEnv.signed["version"] as number,
    signed: targetEnv.signed,
  };
}

export interface VerifiedDiskCatalogOutcome {
  readonly ok: true;
  readonly source: "trusted-remote" | "recovered-previous";
  readonly catalog: CuratedCatalogBundle;
  readonly rootVersion: number;
  readonly targetsVersion: number;
  readonly sha256: string;
}

export interface UnverifiedDiskCatalogOutcome {
  readonly ok: false;
  readonly rootVersion?: number;
  readonly reason: string;
}

interface VerifiedRootChainOutcome {
  readonly ok: true;
  readonly rootBytes: Buffer;
  readonly verifiedRoot: { readonly version: number; readonly signed: Record<string, unknown> };
  readonly trustedRoots: readonly Buffer[];
}

interface UnverifiedRootChainOutcome {
  readonly ok: false;
  readonly rootVersion?: number;
  readonly reason: string;
}

async function verifyRootChainFromDisk(
  metadataDir: string,
  rootHistoryDir: string,
  pinnedBootstrapRootBytes?: Uint8Array,
): Promise<VerifiedRootChainOutcome | UnverifiedRootChainOutcome> {
  const rootPath = path.join(metadataDir, "root.json");

  let rootBytes: Buffer;
  try {
    rootBytes = await fs.readFile(rootPath);
  } catch {
    return { ok: false, reason: "missing-tuf-root" };
  }

  let verifiedRoot: { readonly version: number; readonly signed: Record<string, unknown> };
  try {
    verifiedRoot = verifyTufEnvelopeSignatureAgainstRoot(rootBytes, rootBytes, "root");
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "invalid-tuf-root-signature",
    };
  }

  // 构建受信任的历史根链（若提供了固定引导根，则必须证实当前 root.json 与固定引导根同源或经双阈值连续轮换而来）
  const trustedRoots: Buffer[] = [];
  if (pinnedBootstrapRootBytes) {
    try {
      const bootVer = verifyTufEnvelopeSignatureAgainstRoot(
        pinnedBootstrapRootBytes,
        pinnedBootstrapRootBytes,
        "root",
      );
      if (verifiedRoot.version < bootVer.version) {
        return { ok: false, reason: "root-version-below-bootstrap" };
      }
      if (verifiedRoot.version === bootVer.version) {
        if (Buffer.compare(rootBytes, Buffer.from(pinnedBootstrapRootBytes)) !== 0) {
          return { ok: false, reason: "root-mismatch-with-pinned-bootstrap" };
        }
        trustedRoots.push(rootBytes);
      } else {
        // 校验 v_boot -> ... -> v_current 连续双阈值根轮换链
        let prevRoot: Buffer = Buffer.from(pinnedBootstrapRootBytes);
        trustedRoots.push(prevRoot);
        for (let v = bootVer.version + 1; v <= verifiedRoot.version; v += 1) {
          const nextRoot =
            v === verifiedRoot.version
              ? rootBytes
              : await fs.readFile(path.join(rootHistoryDir, `${v}.root.json`));
          // TUF 1.0.37 双阈值：同时满足旧根 v-1 与新根 v 的 root 阈值签名
          const checkOld = verifyTufEnvelopeSignatureAgainstRoot(nextRoot, prevRoot, "root");
          const checkNew = verifyTufEnvelopeSignatureAgainstRoot(nextRoot, nextRoot, "root");
          if (checkOld.version !== v || checkNew.version !== v) {
            return { ok: false, reason: `root-chain-version-mismatch-v${v}` };
          }
          trustedRoots.push(nextRoot);
          prevRoot = nextRoot;
        }
      }
    } catch {
      return { ok: false, rootVersion: verifiedRoot.version, reason: "root-bootstrap-chain-unverified" };
    }
  } else {
    trustedRoots.push(rootBytes);
    // 可选加载磁盘历史根（仅接收经连续双阈值链路指向当前 root.json 的历史根）
    for (let v = verifiedRoot.version - 1; v >= 1; v -= 1) {
      try {
        const candidatePrev = await fs.readFile(path.join(rootHistoryDir, `${v}.root.json`));
        verifyTufEnvelopeSignatureAgainstRoot(candidatePrev, candidatePrev, "root");
        verifyTufEnvelopeSignatureAgainstRoot(trustedRoots[0]!, candidatePrev, "root");
        trustedRoots.unshift(candidatePrev);
      } catch {
        break;
      }
    }
  }

  return {
    ok: true,
    rootBytes,
    verifiedRoot,
    trustedRoots,
  };
}

/**
 * 启动/恢复磁盘目录的加密验签核验（F3 / R2-2 / R2-3 闭环）：
 * - 绝不把“可解析 JSON + 通过 Schema”等同于已验签的 `trusted-remote`；
 * - 第一步必须验证 `tuf-metadata/root.json` 的真实 Ed25519 自签链与固定引导根同源/双阈值连续轮换链；
 * - 正常稳态优先按完整 `timestamp → snapshot → targets` 链核验 `active-catalog.json`；
 * - 若上一轮刷新在任意元数据写入边界（`root`/`timestamp`/`snapshot`/`targets` 写中断）或根轮换中途失败，
 *   不得因未完成的远端前滚链而丢弃已接纳且完好的旧目录：继续核验随 `active-catalog.json` 配对落盘且由
 *   受信任根链真实 Ed25519 签名的 `active-catalog.tuf-targets.json`（及原始字节 length + sha256 + Schema）；
 * - 仅当 `active-catalog.json` 损坏、篡改或处于 `activeProof → active` 切换中断窗口时，
 *   尝试经同一受信任根链验签的 `previous-catalog.json` + `previous-catalog.tuf-targets.json`，
 *   绝不修改或倒退已接纳的 `tuf-metadata/`。
 */
export async function verifyAcceptedDiskCatalog(options: {
  readonly storeDir: string;
  readonly targetPath?: string;
  readonly pinnedBootstrapRootBytes?: Uint8Array;
}): Promise<VerifiedDiskCatalogOutcome | UnverifiedDiskCatalogOutcome> {
  const metadataDir = resolveTufMetadataDir(options.storeDir);
  const rootHistoryDir = resolveTufRootHistoryDir(options.storeDir);

  const rootChain = await verifyRootChainFromDisk(
    metadataDir,
    rootHistoryDir,
    options.pinnedBootstrapRootBytes,
  );
  if (!rootChain.ok) {
    return rootChain;
  }
  const { rootBytes, verifiedRoot, trustedRoots } = rootChain;

  // 尝试核验完整一致的 timestamp -> snapshot -> targets 链；
  // 若刷新中途中断导致元数据版本暂不齐平（如 timestamp=2, snapshot=1 或根轮换中断），
  // 保留已前滚的元数据不倒退，并继续基于受信任根链核验已接纳目标的独立配对 targets proof。
  let cleanCurrentTargetsBytes: Buffer | undefined;
  let maxAllowedTargetsVersion: number | undefined;
  try {
    const tsBytes = await fs.readFile(path.join(metadataDir, "timestamp.json"));
    const snapBytes = await fs.readFile(path.join(metadataDir, "snapshot.json"));
    const tgtBytes = await fs.readFile(path.join(metadataDir, "targets.json"));

    const ts = verifyTufEnvelopeSignatureAgainstRoot(tsBytes, rootBytes, "timestamp");
    const snap = verifyTufEnvelopeSignatureAgainstRoot(snapBytes, rootBytes, "snapshot");
    const tgt = verifyTufEnvelopeSignatureAgainstRoot(tgtBytes, rootBytes, "targets");

    const tsSnapMeta = (ts.signed["meta"] as Record<string, { version?: number }> | undefined)?.[
      "snapshot.json"
    ];
    const snapTgtMeta = (snap.signed["meta"] as Record<string, { version?: number }> | undefined)?.[
      "targets.json"
    ];
    if (
      tsSnapMeta &&
      typeof tsSnapMeta.version === "number" &&
      snap.version >= tsSnapMeta.version &&
      snapTgtMeta &&
      typeof snapTgtMeta.version === "number" &&
      tgt.version >= snapTgtMeta.version
    ) {
      cleanCurrentTargetsBytes = tgtBytes;
      maxAllowedTargetsVersion = tgt.version;
    }
  } catch {
    // 完整前滚链未就绪或中途中断，继续检查已落盘的 targets.json 版本上界与配对 proof
  }

  if (maxAllowedTargetsVersion === undefined) {
    try {
      const diskTgtBytes = await fs.readFile(path.join(metadataDir, "targets.json"));
      for (const rBytes of [...trustedRoots].reverse()) {
        try {
          const verifiedDiskTgt = verifyTufEnvelopeSignatureAgainstRoot(diskTgtBytes, rBytes, "targets");
          maxAllowedTargetsVersion = verifiedDiskTgt.version;
          break;
        } catch {
          // 尝试链中前序根（应对刚完成 root 轮换、尚未重写 targets 的中断窗口）
        }
      }
    } catch {
      // 无 targets.json 时依赖受信任根链直接校验配对 proof 的 Ed25519 签名与摘要
    }
  }

  const verifyTargetsEnvelopeAndBytes = async (
    targetFile: string,
    targetsEnvelope: Buffer,
    allowHistoricalRoot: boolean,
  ): Promise<{ catalog: CuratedCatalogBundle; targetsVersion: number; sha256: string } | undefined> => {
    // 验证 targetsEnvelope 签名（优先当前根，恢复旧目标/中断态时允许经连续双阈值根链验证的历史根）
    const candidateRoots = allowHistoricalRoot ? [...trustedRoots].reverse() : [rootBytes];
    let verifiedTargets: { version: number; signed: Record<string, unknown> } | undefined;
    for (const rBytes of candidateRoots) {
      try {
        verifiedTargets = verifyTufEnvelopeSignatureAgainstRoot(targetsEnvelope, rBytes, "targets");
        break;
      } catch {
        // 尝试链中前序根
      }
    }
    if (!verifiedTargets) return undefined;
    if (maxAllowedTargetsVersion !== undefined && verifiedTargets.version > maxAllowedTargetsVersion) {
      return undefined;
    }

    const targetsMap = verifiedTargets.signed["targets"] as
      | Record<string, { length?: number; hashes?: Record<string, string> }>
      | undefined;
    if (!targetsMap || typeof targetsMap !== "object") return undefined;

    const targetEntry = options.targetPath
      ? targetsMap[options.targetPath]
      : Object.values(targetsMap)[0];
    if (!targetEntry || typeof targetEntry.length !== "number") return undefined;
    const expectedHash = targetEntry.hashes?.["sha256"];
    if (typeof expectedHash !== "string" || !HEX_64_RE.test(expectedHash)) return undefined;

    let rawTargetBytes: Buffer;
    try {
      rawTargetBytes = await fs.readFile(targetFile);
    } catch {
      return undefined;
    }
    if (rawTargetBytes.byteLength !== targetEntry.length) return undefined;
    const actualHash = crypto.createHash("sha256").update(rawTargetBytes).digest("hex");
    if (actualHash !== expectedHash.toLowerCase()) return undefined;

    try {
      const catalog = parseCuratedCatalogBundle(JSON.parse(rawTargetBytes.toString("utf8")));
      return { catalog, targetsVersion: verifiedTargets.version, sha256: actualHash };
    } catch {
      return undefined;
    }
  };

  // 1. 正常稳态：优先校验 active-catalog.json 对当前一致 targets.json 的原始字节签名与摘要
  const activePath = resolveActiveCatalogPath(options.storeDir);
  if (cleanCurrentTargetsBytes) {
    const directActive = await verifyTargetsEnvelopeAndBytes(activePath, cleanCurrentTargetsBytes, false);
    if (directActive) {
      return {
        ok: true,
        source: "trusted-remote",
        catalog: directActive.catalog,
        rootVersion: verifiedRoot.version,
        targetsVersion: directActive.targetsVersion,
        sha256: directActive.sha256,
      };
    }
  }

  // 1b. 中断稳健恢复：若刷新在 root/timestamp/snapshot/targets 任意写入边界或目标切换前中断，
  //     核验与 active-catalog.json 配对落盘且经受信任根链真实 Ed25519 签名的 active-catalog.tuf-targets.json
  try {
    const activeProofBytes = await fs.readFile(resolveActiveTargetsProofPath(options.storeDir));
    const pairedActive = await verifyTargetsEnvelopeAndBytes(activePath, activeProofBytes, true);
    if (pairedActive) {
      return {
        ok: true,
        source: "trusted-remote",
        catalog: pairedActive.catalog,
        rootVersion: verifiedRoot.version,
        targetsVersion: pairedActive.targetsVersion,
        sha256: pairedActive.sha256,
      };
    }
  } catch {
    // 无配对 proof 或校验不通过，转入 previous 恢复
  }

  // 2. active 缺失、损坏、篡改或在 activeProof -> active 切换间崩溃时，
  //    仅当 previous-catalog.json 拥有通过同一受信任根链验签的配对 proof 时才恢复
  try {
    const prevPath = resolvePreviousCatalogPath(options.storeDir);
    const prevProofBytes = await fs.readFile(resolvePreviousTargetsProofPath(options.storeDir));
    const verifiedPrev = await verifyTargetsEnvelopeAndBytes(prevPath, prevProofBytes, true);
    if (verifiedPrev) {
      return {
        ok: true,
        source: "recovered-previous",
        catalog: verifiedPrev.catalog,
        rootVersion: verifiedRoot.version,
        targetsVersion: verifiedPrev.targetsVersion,
        sha256: verifiedPrev.sha256,
      };
    }
  } catch {
    // previous 不可用或未通过验签
  }

  return {
    ok: false,
    rootVersion: verifiedRoot.version,
    reason: "target-digest-or-schema-verification-failed",
  };
}

function roleFileName(role: string): string {
  return role.endsWith(".json") ? role : `${role}.json`;
}

function roleKeyFromFileName(fileName: string): TufRoleName {
  const base = fileName.endsWith(".json") ? fileName.slice(0, -5) : fileName;
  if (!ALLOWED_ROLE_SET.has(base)) {
    throw new TufSecurityPolicyError(`不支持的 TUF 角色存储名：${fileName}`, "invalid_role");
  }
  return base as TufRoleName;
}

/**
 * 执行一轮完整的受限四角色 TUF 刷新：
 * 1. 从磁盘预载并严格校验已有原始字节元数据（如首次则原子落盘 bootstrap root）；
 * 2. 构造全新 `Updater`（保证每轮独立时钟）；
 * 3. `await updater.refresh()`（4 处持久化点均先外包校验再 `await writeBytesAtomic`）；
 * 4. 校验目标元数据、下载至隔离候选路径、校验长度/SHA-256/Schema 后原子激活 `active-catalog.json`。
 */
export async function refreshCatalogWithTuf(
  options: RefreshCatalogWithTufOptions,
): Promise<TufRefreshOutcome> {
  const metadataDir = resolveTufMetadataDir(options.storeDir);
  const candidatesDir = path.join(options.storeDir, "candidates");
  const activePath = resolveActiveCatalogPath(options.storeDir);
  const previousPath = resolvePreviousCatalogPath(options.storeDir);

  const rootHistoryDir = resolveTufRootHistoryDir(options.storeDir);
  await fs.mkdir(metadataDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(rootHistoryDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(candidatesDir, { recursive: true, mode: 0o700 });

  // 1. 预载磁盘上已接纳的原始字节元数据（不重序列化）；若尚无 root.json 则先校验并原子写入 bootstrapRootBytes
  const loadedMetadata = new Map<TufRoleName, Buffer>();
  const rootPath = path.join(metadataDir, "root.json");
  let hasExistingRoot = false;
  try {
    const existingRoot = await fs.readFile(rootPath);
    const existingRootSummary = validateTufMetadataBytes(existingRoot, "root");
    // 若磁盘已有 root.json，必须证实与当前仓库固定引导根同源或经连续双阈值根轮换而来，防止混用无关仓库的信任根
    const chainCheck = await verifyRootChainFromDisk(
      metadataDir,
      rootHistoryDir,
      options.repository.bootstrapRootBytes,
    );
    if (!chainCheck.ok) {
      throw new TufSecurityPolicyError(
        `本地已接纳的 TUF 信任根与当前所选仓库固定引导根不属同一信任链（${chainCheck.reason}）`,
        "keyid_mismatch",
      );
    }
    loadedMetadata.set("root", existingRoot);
    hasExistingRoot = true;
    // 确保已有根留存在 root-history 以支撑冷启动连续根链核验
    const histPath = path.join(rootHistoryDir, `${existingRootSummary.version}.root.json`);
    await fs.access(histPath).catch(async () => {
      await writeBytesAtomic(histPath, existingRoot, { signal: options.signal });
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw err;
    }
  }

  if (!hasExistingRoot) {
    const bootSummary = validateTufMetadataBytes(options.repository.bootstrapRootBytes, "root");
    const bootstrapBuf = Buffer.from(options.repository.bootstrapRootBytes);
    await options.writeInterceptor?.("metadata", "root", bootstrapBuf);
    await writeBytesAtomic(rootPath, bootstrapBuf, { signal: options.signal });
    await writeBytesAtomic(
      path.join(rootHistoryDir, `${bootSummary.version}.root.json`),
      bootstrapBuf,
      { signal: options.signal },
    );
    loadedMetadata.set("root", bootstrapBuf);
  }

  for (const role of ["timestamp", "snapshot", "targets"] as const) {
    const p = path.join(metadataDir, `${role}.json`);
    try {
      const bytes = await fs.readFile(p);
      validateTufMetadataBytes(bytes, role);
      loadedMetadata.set(role, bytes);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw err;
      }
    }
  }

  // 2. 构建受控单跳网络 Fetcher（若 targetsBaseUrl 与 metadataBaseUrl 异源，则分别独立构建单跳传输）
  const networkCfg: ConnectionNetworkConfig = options.repository.network ?? { proxy: "inherit" };
  const sameOriginTargets = (() => {
    try {
      return (
        new URL(options.repository.metadataBaseUrl).origin ===
        new URL(options.repository.targetsBaseUrl).origin
      );
    } catch {
      return true;
    }
  })();
  const transport = options.customFetch
    ? undefined
    : createConnectionDeliveryFetch({
        proxyPolicy: networkCfg.proxy,
        ...(options.repository.networkProxy !== undefined
          ? { networkProxy: options.repository.networkProxy }
          : {}),
        ...(networkCfg.allowPrivateOrigin ? { allowPrivateOrigin: true } : {}),
        confirmedOrigin: options.repository.metadataBaseUrl,
      });
  const targetTransport =
    options.customFetch || sameOriginTargets
      ? undefined
      : createConnectionDeliveryFetch({
          proxyPolicy: networkCfg.proxy,
          ...(options.repository.networkProxy !== undefined
            ? { networkProxy: options.repository.networkProxy }
            : {}),
          ...(networkCfg.allowPrivateOrigin ? { allowPrivateOrigin: true } : {}),
          confirmedOrigin: options.repository.targetsBaseUrl,
        });
  const metadataFetchFn = options.customFetch ?? transport!.fetch;
  const targetFetchFn = options.customFetch ?? (targetTransport ?? transport)!.fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;

  const downloadControlledBytes = async (
    url: string,
    maxLength: number,
    isMetadata: boolean,
  ): Promise<Buffer> => {
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`TUF fetch timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onAbort = () => {
      controller.abort(options.signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const activeFetch = isMetadata ? metadataFetchFn : targetFetchFn;
      const response = await activeFetch(url, {
        method: "GET",
        headers: { Accept: "application/json, application/octet-stream" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new DownloadHTTPError(
          `Failed to download ${url}: HTTP ${response.status}`,
          response.status,
        );
      }
      const bytes = await readBoundedBuffer(response, maxLength);
      if (isMetadata) {
        // 网络侧下载的每一份 TUF 元数据在交给 tuf-js 状态机之前必须通过外包严格校验
        validateTufMetadataBytes(bytes);
      }
      return bytes;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  };

  const metadataFetcher: TufFetcher = {
    async downloadBytes(url: string, maxLength: number): Promise<Buffer> {
      const cap = Math.min(maxLength, MAX_TUF_METADATA_BYTES);
      return downloadControlledBytes(url, cap, true);
    },
  };

  const metadataStore: TufMetadataStore = {
    read(fileName: string): Buffer {
      const role = roleKeyFromFileName(fileName);
      const cached = loadedMetadata.get(role);
      if (!cached) {
        throw new Error(`TUF local metadata missing: ${role}`);
      }
      return cached;
    },
    async write(metaDataName: string, bytesData: Buffer): Promise<void> {
      const role = roleKeyFromFileName(metaDataName);
      const rawBuf = Buffer.isBuffer(bytesData) ? bytesData : Buffer.from(bytesData);
      // 落盘前再做一次严格外包校验，绝不落盘被篡改或越权元数据
      const summary = validateTufMetadataBytes(rawBuf, role);
      await options.writeInterceptor?.("metadata", role, rawBuf);
      const dest = path.join(metadataDir, roleFileName(role));
      await writeBytesAtomic(dest, rawBuf, { signal: options.signal });
      if (role === "root") {
        await writeBytesAtomic(
          path.join(rootHistoryDir, `${summary.version}.root.json`),
          rawBuf,
          { signal: options.signal },
        );
      }
      loadedMetadata.set(role, rawBuf);
    },
  };

  try {
    // 3. 每轮新建 Updater（确保每次刷新使用独立的新鲜时钟）
    const updater = new Updater({
      metadataDir,
      metadataBaseUrl: options.repository.metadataBaseUrl.replace(/\/+$/u, "") + "/",
      targetDir: candidatesDir,
      targetBaseUrl: options.repository.targetsBaseUrl.replace(/\/+$/u, "") + "/",
      fetcher: metadataFetcher,
      metadataStore,
      config: {
        maxDelegations: 0,
        rootMaxLength: MAX_TUF_METADATA_BYTES,
        timestampMaxLength: MAX_TUF_METADATA_BYTES,
        snapshotMaxLength: MAX_TUF_METADATA_BYTES,
        targetsMaxLength: MAX_TUF_METADATA_BYTES,
      },
    });

    await updater.refresh();

    const targetInfo = await updater.getTargetInfo(options.repository.targetPath);
    if (!targetInfo) {
      throw new TufSecurityPolicyError(
        `TUF targets 元数据中未找到目标目录：${options.repository.targetPath}`,
        "target_not_found",
      );
    }
    if (targetInfo.length <= 0 || targetInfo.length > MAX_TUF_TARGET_BYTES) {
      throw new TufSecurityPolicyError(
        `TUF 目标目录声明长度非法：${targetInfo.length}`,
        "target_length_mismatch",
      );
    }
    const expectedSha256 = targetInfo.hashes["sha256"];
    if (typeof expectedSha256 !== "string" || !HEX_64_RE.test(expectedSha256)) {
      throw new TufSecurityPolicyError("TUF 目标缺少合法 sha256 摘要", "target_hash_mismatch");
    }

    // 4. 下载目标包（使用受控单跳网络与严格长度上限）
    const targetUrl = `${options.repository.targetsBaseUrl.replace(/\/+$/u, "")}/${options.repository.targetPath.replace(/^\/+/u, "")}`;
    const targetBytes = await downloadControlledBytes(
      targetUrl,
      Math.min(targetInfo.length, MAX_TUF_TARGET_BYTES),
      false,
    );

    if (targetBytes.byteLength !== targetInfo.length) {
      throw new TufSecurityPolicyError(
        `目标目录长度不匹配：声明 ${targetInfo.length}，实际 ${targetBytes.byteLength}`,
        "target_length_mismatch",
      );
    }
    const actualSha256 = crypto.createHash("sha256").update(targetBytes).digest("hex");
    if (actualSha256 !== expectedSha256.toLowerCase()) {
      throw new TufSecurityPolicyError(
        `目标目录 SHA-256 不匹配：声明 ${expectedSha256}，实际 ${actualSha256}`,
        "target_hash_mismatch",
      );
    }

    // 5. 先落盘至隔离候选路径并校验完整目录 Schema，通过后再原子激活（不覆盖损坏既有目录）
    const candidateFile = path.join(
      candidatesDir,
      `candidate-${actualSha256.slice(0, 16)}-${crypto.randomBytes(4).toString("hex")}.json`,
    );
    let parsedCatalog: CuratedCatalogBundle;
    try {
      const parsedJson = JSON.parse(targetBytes.toString("utf8"));
      parsedCatalog = parseCuratedCatalogBundle(parsedJson);
      await options.writeInterceptor?.("candidate", path.basename(candidateFile), targetBytes);
      await writeBytesAtomic(candidateFile, targetBytes, { signal: options.signal });

      // 备份旧有效目标及其已验签 targets proof 供极端场景恢复（绝不碰 TUF 信任元数据）
      const activeProofPath = resolveActiveTargetsProofPath(options.storeDir);
      const previousProofPath = resolvePreviousTargetsProofPath(options.storeDir);
      try {
        const [existingActive, existingProof] = await Promise.all([
          fs.readFile(activePath),
          fs.readFile(activeProofPath),
        ]);
        if (existingActive.byteLength > 0 && existingProof.byteLength > 0) {
          await writeBytesAtomic(previousProofPath, existingProof, { signal: options.signal });
          await writeBytesAtomic(previousPath, existingActive, { signal: options.signal });
        }
      } catch {
        // 旧目录或旧 proof 缺失/损坏则忽略备份，直接以已验签新目录恢复
      }

      const acceptedTargetsBytes = loadedMetadata.get("targets")!;
      await options.writeInterceptor?.("active", "active-catalog.tuf-targets.json", acceptedTargetsBytes);
      await writeBytesAtomic(activeProofPath, acceptedTargetsBytes, { signal: options.signal });
      await options.writeInterceptor?.("active", "active-catalog.json", targetBytes);
      await writeBytesAtomic(activePath, targetBytes, { signal: options.signal });
    } finally {
      await fs.unlink(candidateFile).catch(() => {});
    }

    const rootMeta = validateTufMetadataBytes(loadedMetadata.get("root")!, "root");
    const tsMeta = validateTufMetadataBytes(loadedMetadata.get("timestamp")!, "timestamp");
    const snapMeta = validateTufMetadataBytes(loadedMetadata.get("snapshot")!, "snapshot");
    const targetsMeta = validateTufMetadataBytes(loadedMetadata.get("targets")!, "targets");

    return {
      catalog: parsedCatalog,
      catalogBytes: targetBytes,
      catalogSha256: actualSha256,
      rootVersion: rootMeta.version,
      timestampVersion: tsMeta.version,
      snapshotVersion: snapMeta.version,
      targetsVersion: targetsMeta.version,
    };
  } finally {
    await transport?.close().catch(() => {});
    await targetTransport?.close().catch(() => {});
  }
}

async function readBoundedBuffer(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) {
    const ab = await response.arrayBuffer();
    if (ab.byteLength > maxBytes) {
      throw new TufSecurityPolicyError(
        `响应字节数超过上限（${ab.byteLength} > ${maxBytes}）`,
        "metadata_too_large",
      );
    }
    return Buffer.from(ab);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          throw new TufSecurityPolicyError(
            `响应字节数超过上限（>${maxBytes} bytes）`,
            "metadata_too_large",
          );
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
