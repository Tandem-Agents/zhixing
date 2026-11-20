/**
 * 策展目录维护流水线：可审差异报告、旧端兼容读取校验与真实 Ed25519 四角色 TUF 本地发布/续签/根轮换（设计 §4.1、§4.2）。
 *
 * 维护责任清晰分离：
 * - 事实目录差异与推荐变更分开呈现，确保事实更新不暗改用途推荐或用户默认；
 * - 发布前执行 Schema 严格校验与旧端兼容读取器校验（确认新能力仅局部隔离为 `requiresUpgrade`）；
 * - `renewTufMetadata` 仅续签信任元数据期限并递增版本号，绝不虚改任何模型的 `verifiedAt` 日期；
 * - `rotateTufRoot` 执行 TUF 1.0.37 双阈值签名连续根轮换（vN → vN+1）。
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ModelAdapterId } from "@zhixing-ai/core";
import { writeBytesAtomic } from "../internal/io.js";
import type { ConnectionAuthConfig, ConnectionNetworkConfig } from "../types.js";
import { discoverConnectionModels } from "../discovery/native-discovery.js";
import { isStructuredNonChatModel } from "./synthesis.js";
import {
  evaluateCapabilities,
  isStrictRfc3339Utc,
  LOCAL_SUPPORTED_CATALOG_CAPABILITIES,
  parseCuratedCatalogBundle,
  type CuratedCatalogBundle,
  type CuratedModelEntry,
  type CuratedPreset,
  type CuratedRecommendation,
} from "./schema.js";
import {
  validateTufMetadataBytes,
  verifyTufEnvelopeSignatureAgainstRoot,
  type TufRoleName,
} from "./tuf/restricted-tuf-client.js";
import { canonicalize } from "./tuf/vendor/tuf-js-5.0.1-patched.mjs";

// ─── 1. 可审差异报告（区分事实目录与用途推荐） ───

export interface FieldChange {
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
}

export interface PresetDiffEntry {
  readonly presetId: string;
  readonly change: "added" | "removed" | "updated";
  readonly fields: readonly FieldChange[];
}

export interface ModelDiffEntry {
  readonly presetId: string;
  readonly modelId: string;
  readonly change: "added" | "removed" | "updated";
  readonly fields: readonly FieldChange[];
  readonly evidenceSource?: string;
  readonly verifiedAt?: string;
}

export interface RecommendationDiffEntry {
  readonly role: string;
  readonly change: "added" | "removed" | "updated";
  readonly before?: CuratedRecommendation;
  readonly after?: CuratedRecommendation;
}

export interface CuratedCatalogDiff {
  readonly previousRevision: string;
  readonly nextRevision: string;
  readonly bundleFieldsChanged: readonly FieldChange[];
  readonly presets: readonly PresetDiffEntry[];
  readonly models: readonly ModelDiffEntry[];
  readonly recommendations: readonly RecommendationDiffEntry[];
  readonly attentionThresholdsChanged: readonly string[];
  readonly warnings: readonly string[];
}

export function diffCuratedCatalogs(
  previous: CuratedCatalogBundle,
  next: CuratedCatalogBundle,
): CuratedCatalogDiff {
  const bundleFieldsChanged = diffObjectsDeep(
    previous as unknown as Record<string, unknown>,
    next as unknown as Record<string, unknown>,
    new Set([
      "catalogRevision",
      "publishedAt",
      "presets",
      "models",
      "recommendations",
      "attentionThresholds",
    ]),
  );
  const presets: PresetDiffEntry[] = [];
  const models: ModelDiffEntry[] = [];
  const recommendations: RecommendationDiffEntry[] = [];
  const attentionThresholdsChanged: string[] = [];
  const warnings: string[] = [];

  const prevPresets = new Map(previous.presets.map((p) => [p.id, p]));
  const nextPresets = new Map(next.presets.map((p) => [p.id, p]));

  for (const [id, np] of nextPresets) {
    const pp = prevPresets.get(id);
    if (!pp) {
      presets.push({
        presetId: id,
        change: "added",
        fields: diffObjectsDeep({}, np as unknown as Record<string, unknown>, new Set(["id"])),
      });
      continue;
    }
    const fields = diffPresetFields(pp, np);
    if (fields.length > 0) {
      presets.push({ presetId: id, change: "updated", fields });
      if (
        (pp.baseUrl !== np.baseUrl || pp.protocol !== np.protocol) &&
        pp.presetRevision === np.presetRevision
      ) {
        warnings.push(
          `预设 "${id}" 修改了 baseUrl 或 protocol，但未递增 presetRevision（当前仍为 ${np.presetRevision}）`,
        );
      }
      if (!pp.discovery.authoritativeNativeFacts && np.discovery.authoritativeNativeFacts) {
        warnings.push(
          `预设 "${id}" 将 discovery.authoritativeNativeFacts 提升为 true（发现事实将升格为运行硬约束，请重点核验官方来源）`,
        );
      }
    }
  }
  for (const id of prevPresets.keys()) {
    if (!nextPresets.has(id)) {
      presets.push({ presetId: id, change: "removed", fields: [] });
      warnings.push(`预设 "${id}" 被移除：建议优先使用 lifecycle="retired" 而非直接删除以保留旧连接解释`);
    }
  }

  const prevModels = new Map(previous.models.map((m) => [`${m.presetId}::${m.id}`, m]));
  const nextModels = new Map(next.models.map((m) => [`${m.presetId}::${m.id}`, m]));

  for (const [key, nm] of nextModels) {
    const pm = prevModels.get(key);
    if (!pm) {
      models.push({
        presetId: nm.presetId,
        modelId: nm.id,
        change: "added",
        fields: diffObjectsDeep({}, nm as unknown as Record<string, unknown>, new Set(["presetId", "id"])),
        ...(nm.evidenceSource ? { evidenceSource: nm.evidenceSource } : {}),
        ...(nm.verifiedAt ? { verifiedAt: nm.verifiedAt } : {}),
      });
      continue;
    }
    const fields = diffModelFields(pm, nm);
    if (fields.length > 0) {
      models.push({
        presetId: nm.presetId,
        modelId: nm.id,
        change: "updated",
        fields,
        ...(nm.evidenceSource ? { evidenceSource: nm.evidenceSource } : {}),
        ...(nm.verifiedAt ? { verifiedAt: nm.verifiedAt } : {}),
      });
      if (nm.lifecycle === "retired" && !nm.lifecycleReason && !nm.replacementModelId) {
        warnings.push(`退役模型 "${nm.presetId}/${nm.id}" 建议填写 lifecycleReason 或 replacementModelId`);
      }
    }
  }
  for (const [key, pm] of prevModels) {
    if (!nextModels.has(key)) {
      models.push({
        presetId: pm.presetId,
        modelId: pm.id,
        change: "removed",
        fields: [],
      });
    }
  }

  // 独立比对用途推荐（全字段比对，绝不与事实目录更新混为一谈）
  const prevRecs = new Map(previous.recommendations.map((r) => [r.role, r]));
  const nextRecs = new Map(next.recommendations.map((r) => [r.role, r]));
  for (const role of ["main", "light", "power"] as const) {
    const pr = prevRecs.get(role);
    const nr = nextRecs.get(role);
    if (!pr && nr) {
      recommendations.push({ role, change: "added", after: nr });
    } else if (pr && !nr) {
      recommendations.push({ role, change: "removed", before: pr });
    } else if (pr && nr && canonicalize(pr) !== canonicalize(nr)) {
      recommendations.push({ role, change: "updated", before: pr, after: nr });
    }
  }

  const allThresholdKeys = new Set([
    ...Object.keys(previous.attentionThresholds),
    ...Object.keys(next.attentionThresholds),
  ]);
  for (const key of [...allThresholdKeys].sort()) {
    const pt = previous.attentionThresholds[key];
    const nt = next.attentionThresholds[key];
    if (canonicalize(pt ?? null) !== canonicalize(nt ?? null)) {
      attentionThresholdsChanged.push(key);
    }
  }

  return {
    previousRevision: previous.catalogRevision,
    nextRevision: next.catalogRevision,
    bundleFieldsChanged,
    presets,
    models,
    recommendations,
    attentionThresholdsChanged,
    warnings,
  };
}

export function formatCatalogDiffMarkdown(diff: CuratedCatalogDiff): string {
  const lines: string[] = [
    `# 模型目录变更审阅单（${diff.previousRevision} → ${diff.nextRevision}）`,
  ];

  if (diff.bundleFieldsChanged.length > 0) {
    lines.push("", `## 0. 目录顶层契约变更（${diff.bundleFieldsChanged.length} 项）`);
    for (const f of diff.bundleFieldsChanged) {
      lines.push(`- \`${f.field}\`: ${JSON.stringify(f.before)} → ${JSON.stringify(f.after)}`);
    }
  }

  lines.push("", `## 1. 服务商预设变更（${diff.presets.length} 项）`);
  if (diff.presets.length === 0) {
    lines.push("- 无变更");
  } else {
    for (const p of diff.presets) {
      const detail = p.fields
        .map((f) => `${f.field}: ${JSON.stringify(f.before)} → ${JSON.stringify(f.after)}`)
        .join("; ");
      lines.push(`- [${p.change}] \`${p.presetId}\`${detail ? ` — ${detail}` : ""}`);
    }
  }

  lines.push("", `## 2. 事实模型条目变更（${diff.models.length} 项）`);
  if (diff.models.length === 0) {
    lines.push("- 无变更");
  } else {
    for (const m of diff.models) {
      const detail = m.fields
        .map((f) => `${f.field}: ${JSON.stringify(f.before)} → ${JSON.stringify(f.after)}`)
        .join("; ");
      const prov = [m.evidenceSource, m.verifiedAt].filter(Boolean).join(" @ ");
      lines.push(
        `- [${m.change}] \`${m.presetId}/${m.modelId}\`${detail ? ` — ${detail}` : ""}${prov ? `（依据：${prov}）` : ""}`,
      );
    }
  }

  lines.push("", `## 3. 用途推荐变更（独立维护，${diff.recommendations.length} 项）`);
  if (diff.recommendations.length === 0) {
    lines.push("- 无变更（事实修订未改动用途推荐）");
  } else {
    for (const r of diff.recommendations) {
      const before = r.before ? `${r.before.presetId}/${r.before.modelId}` : "(无)";
      const after = r.after ? `${r.after.presetId}/${r.after.modelId}` : "(无)";
      lines.push(`- [${r.change}] \`${r.role}\`: ${before} → ${after}`);
    }
  }

  if (diff.attentionThresholdsChanged.length > 0) {
    lines.push("", `## 4. 注意力阈值变更：${diff.attentionThresholdsChanged.join(", ")}`);
  }

  if (diff.warnings.length > 0) {
    lines.push("", "## 审阅警示");
    for (const w of diff.warnings) {
      lines.push(`- [WARN] ${w}`);
    }
  }
  return lines.join("\n") + "\n";
}

export interface CatalogReviewBinding {
  readonly schemaVersion: 1;
  readonly baseRevision: string;
  readonly baseCanonicalSha256: string;
  readonly candidateRevision: string;
  readonly candidateCanonicalSha256: string;
  readonly diffMarkdownSha256: string;
  /**
   * 内容绑定的最终人审批准摘要：
   * `sha256(canonicalize({ schemaVersion: 1, baseCanonicalSha256, candidateCanonicalSha256, diffMarkdownSha256 }))`。
   * 只要基线目录、待发候选目录或审阅差异单有任意一处变动，批准摘要必然失配。
   */
  readonly approvalDigest: string;
}

export interface CatalogReviewResult {
  readonly diff: CuratedCatalogDiff;
  readonly diffMarkdown: string;
  readonly binding: CatalogReviewBinding;
}

/**
 * 基于真实基线目录与真实待发候选目录计算内容绑定的人审审阅单与批准摘要（CLI / CI / 维护手册唯一合同）。
 */
export function computeCatalogReviewBinding(
  baseCatalog: CuratedCatalogBundle,
  candidateCatalog: CuratedCatalogBundle,
): CatalogReviewResult {
  const base = parseCuratedCatalogBundle(baseCatalog);
  const candidate = parseCuratedCatalogBundle(candidateCatalog);
  const diff = diffCuratedCatalogs(base, candidate);
  const diffMarkdown = formatCatalogDiffMarkdown(diff);
  const baseCanonicalSha256 = crypto
    .createHash("sha256")
    .update(canonicalize(base), "utf8")
    .digest("hex");
  const candidateCanonicalSha256 = crypto
    .createHash("sha256")
    .update(canonicalize(candidate), "utf8")
    .digest("hex");
  const diffMarkdownSha256 = crypto.createHash("sha256").update(diffMarkdown, "utf8").digest("hex");
  const approvalDigest = crypto
    .createHash("sha256")
    .update(
      canonicalize({
        schemaVersion: 1,
        baseCanonicalSha256,
        candidateCanonicalSha256,
        diffMarkdownSha256,
      }),
      "utf8",
    )
    .digest("hex");
  return {
    diff,
    diffMarkdown,
    binding: {
      schemaVersion: 1,
      baseRevision: base.catalogRevision,
      baseCanonicalSha256,
      candidateRevision: candidate.catalogRevision,
      candidateCanonicalSha256,
      diffMarkdownSha256,
      approvalDigest,
    },
  };
}

/**
 * 核验待发布候选目录与当前真实基线目录严格匹配经人审批准的内容绑定摘要；
 * 任何基线漂移、候选篡改（哪怕单字段 384000 → 384001 或布尔位改动）或过期批准均立即拒绝签发。
 */
export function verifyCatalogReviewBinding(input: {
  readonly baseCatalog: CuratedCatalogBundle;
  readonly candidateCatalog: CuratedCatalogBundle;
  readonly expectedApprovalDigest: string;
  readonly expectedBaseCanonicalSha256?: string;
  readonly expectedCandidateCanonicalSha256?: string;
}): CatalogReviewResult {
  const actual = computeCatalogReviewBinding(input.baseCatalog, input.candidateCatalog);
  const expected = input.expectedApprovalDigest.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(expected)) {
    throw new Error(`人审批准摘要格式非法（需 64 位十六进制 SHA-256）：${input.expectedApprovalDigest}`);
  }
  if (
    input.expectedBaseCanonicalSha256 &&
    input.expectedBaseCanonicalSha256.trim().toLowerCase() !== actual.binding.baseCanonicalSha256
  ) {
    throw new Error(
      `人审批准绑定失效：基线目录已漂移（期望 ${input.expectedBaseCanonicalSha256}，实际 ${actual.binding.baseCanonicalSha256}），请基于最新基线重新审阅`,
    );
  }
  if (
    input.expectedCandidateCanonicalSha256 &&
    input.expectedCandidateCanonicalSha256.trim().toLowerCase() !==
      actual.binding.candidateCanonicalSha256
  ) {
    throw new Error(
      `人审批准绑定失效：待发候选目录与已审阅候选不一致（期望 ${input.expectedCandidateCanonicalSha256}，实际 ${actual.binding.candidateCanonicalSha256}），请重新审阅`,
    );
  }
  if (actual.binding.approvalDigest !== expected) {
    throw new Error(
      `人审批准摘要不匹配（基线 ${actual.binding.baseCanonicalSha256.slice(0, 12)} / 候选 ${actual.binding.candidateCanonicalSha256.slice(0, 12)}）：期望 ${expected}，实际 ${actual.binding.approvalDigest}；请重新生成审阅单并确认`,
    );
  }
  return actual;
}

// ─── 2. 旧端兼容读取器校验（设计 §4.1） ───

export interface CompatibilityCheckReport {
  readonly compatible: boolean;
  readonly parsedRevision?: string;
  readonly usablePresetCount: number;
  readonly upgradeRequiredPresets: readonly string[];
  readonly usableModelCount: number;
  readonly upgradeRequiredModels: readonly string[];
  readonly hasUpgradeNotice: boolean;
  readonly error?: string;
}

/**
 * 模拟目标旧端能力集合读取候选目录包，核实：
 * - 整包合法且不因单条新能力条目作废；
 * - 新能力条目被局部隔离到 `upgradeRequiredPresets` / `upgradeRequiredModels`。
 */
export function verifyCatalogCompatibilityForReader(
  rawBundle: unknown,
  readerCapabilities: readonly string[] = LOCAL_SUPPORTED_CATALOG_CAPABILITIES,
): CompatibilityCheckReport {
  const capSet = new Set(readerCapabilities);
  try {
    const bundle = parseCuratedCatalogBundle(rawBundle, { supportedCapabilities: capSet });
    const upgradeRequiredPresets: string[] = [];
    let usablePresetCount = 0;
    for (const p of bundle.presets) {
      if (evaluateCapabilities(p.requiredCapabilities, capSet).requiresUpgrade) {
        upgradeRequiredPresets.push(p.id);
      } else {
        usablePresetCount++;
      }
    }
    const upgradeRequiredModels: string[] = [];
    let usableModelCount = 0;
    for (const m of bundle.models) {
      if (evaluateCapabilities(m.requiredCapabilities, capSet).requiresUpgrade) {
        upgradeRequiredModels.push(`${m.presetId}/${m.id}`);
      } else {
        usableModelCount++;
      }
    }
    return {
      compatible: true,
      parsedRevision: bundle.catalogRevision,
      usablePresetCount,
      upgradeRequiredPresets,
      usableModelCount,
      upgradeRequiredModels,
      hasUpgradeNotice: Boolean(bundle.upgradeNotice),
    };
  } catch (err) {
    return {
      compatible: false,
      usablePresetCount: 0,
      upgradeRequiredPresets: [],
      usableModelCount: 0,
      upgradeRequiredModels: [],
      hasUpgradeNotice: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── 3. 真实 Ed25519 四角色 TUF 发布、周期续签与连续根轮换 ───

export interface TufRoleKeyPair {
  readonly keyid: string;
  readonly publicKeyHex: string;
  readonly keyObject: {
    readonly keytype: "ed25519";
    readonly scheme: "ed25519";
    readonly keyval: { readonly public: string };
  };
  readonly privateKeyPem: string;
}

export interface TufOnlineRoleKeySet {
  readonly timestamp: TufRoleKeyPair;
  readonly snapshot: TufRoleKeyPair;
  readonly targets: TufRoleKeyPair;
}

export interface TufFourRoleKeySet extends TufOnlineRoleKeySet {
  readonly root: TufRoleKeyPair;
}

export function generateTufEd25519KeyPair(): TufRoleKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  if (!jwk.x) throw new Error("Failed to export Ed25519 public key JWK");
  const publicKeyHex = Buffer.from(jwk.x, "base64url").toString("hex");
  const keyObject = {
    keytype: "ed25519" as const,
    scheme: "ed25519" as const,
    keyval: { public: publicKeyHex },
  };
  const keyid = crypto
    .createHash("sha256")
    .update(canonicalize(keyObject), "utf8")
    .digest("hex");
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  return { keyid, publicKeyHex, keyObject, privateKeyPem };
}

export function generateTufFourRoleKeySet(): TufFourRoleKeySet {
  return {
    root: generateTufEd25519KeyPair(),
    timestamp: generateTufEd25519KeyPair(),
    snapshot: generateTufEd25519KeyPair(),
    targets: generateTufEd25519KeyPair(),
  };
}

export function signTufEnvelope(
  signed: Record<string, unknown>,
  signers: readonly TufRoleKeyPair[],
): Buffer {
  const payload = Buffer.from(canonicalize(signed), "utf8");
  const signatures = signers.map((signer) => {
    const key = crypto.createPrivateKey(signer.privateKeyPem);
    const sig = crypto.sign(null, payload, key).toString("hex");
    return { keyid: signer.keyid, sig };
  });
  return Buffer.from(JSON.stringify({ signed, signatures }, null, 2) + "\n", "utf8");
}

export function buildRootSignedObject(args: {
  readonly version: number;
  readonly expires: string;
  readonly keys: TufFourRoleKeySet;
}): Record<string, unknown> {
  if (!isStrictRfc3339Utc(args.expires)) {
    throw new Error(`Invalid strict RFC 3339 expires: ${args.expires}`);
  }
  const rolePairs: Record<TufRoleName, TufRoleKeyPair> = {
    root: args.keys.root,
    timestamp: args.keys.timestamp,
    snapshot: args.keys.snapshot,
    targets: args.keys.targets,
  };
  const keysMap: Record<string, unknown> = {};
  const rolesMap: Record<string, unknown> = {};
  for (const role of ["root", "timestamp", "snapshot", "targets"] as const) {
    const pair = rolePairs[role];
    keysMap[pair.keyid] = pair.keyObject;
    rolesMap[role] = { keyids: [pair.keyid], threshold: 1 };
  }
  return {
    _type: "root",
    spec_version: "1.0.31",
    version: args.version,
    expires: args.expires,
    consistent_snapshot: false,
    keys: keysMap,
    roles: rolesMap,
  };
}

export interface PublishTufRepositoryInput {
  readonly outputDir: string;
  readonly catalog: CuratedCatalogBundle;
  readonly targetPath?: string;
  readonly keys: TufFourRoleKeySet;
  readonly rootVersion?: number;
  readonly targetsVersion?: number;
  readonly snapshotVersion?: number;
  readonly timestampVersion?: number;
  readonly now?: Date;
  readonly rootExpiresDays?: number;
  readonly targetsExpiresDays?: number;
  readonly snapshotExpiresDays?: number;
  readonly timestampExpiresHours?: number;
  /** 若为连续根轮换发布，可传入旧根密钥以生成双签 `vN.root.json`。 */
  readonly previousRootSigner?: TufRoleKeyPair;
}

export interface PublishedTufRepositoryResult {
  readonly metadataDir: string;
  readonly targetsDir: string;
  readonly targetPath: string;
  readonly catalogRevision: string;
  readonly targetSha256: string;
  readonly targetBytes: number;
  readonly rootVersion: number;
  readonly targetsVersion: number;
  readonly snapshotVersion: number;
  readonly timestampVersion: number;
  readonly rootBytes: Buffer;
}

function addMsIso(base: Date, ms: number): string {
  return new Date(base.getTime() + ms).toISOString().replace(/\.\d{3}Z$/u, "Z");
}

/**
 * 将已审阅的 `CuratedCatalogBundle` 发布为标准 TUF 1.0.37 本地静态仓库（真实 Ed25519 四角色签名）。
 */
export async function publishTufCatalogRepository(
  input: PublishTufRepositoryInput,
): Promise<PublishedTufRepositoryResult> {
  // 发布前强制执行完整 Schema 校验
  const validatedCatalog = parseCuratedCatalogBundle(input.catalog);
  const targetPath = input.targetPath ?? "catalog-v1.json";
  const now = input.now ?? new Date();
  const rootVersion = input.rootVersion ?? 1;
  const targetsVersion = input.targetsVersion ?? 1;
  const snapshotVersion = input.snapshotVersion ?? 1;
  const timestampVersion = input.timestampVersion ?? 1;

  const metadataDir = path.join(input.outputDir, "metadata");
  const targetsDir = path.join(input.outputDir, "targets");
  await fs.mkdir(metadataDir, { recursive: true });
  await fs.mkdir(targetsDir, { recursive: true });

  const targetBuf = Buffer.from(JSON.stringify(validatedCatalog, null, 2) + "\n", "utf8");
  const targetSha256 = crypto.createHash("sha256").update(targetBuf).digest("hex");

  const rootExpires = addMsIso(now, (input.rootExpiresDays ?? 365) * 86_400_000);
  const targetsExpires = addMsIso(now, (input.targetsExpiresDays ?? 30) * 86_400_000);
  const snapshotExpires = addMsIso(now, (input.snapshotExpiresDays ?? 7) * 86_400_000);
  const timestampExpires = addMsIso(now, (input.timestampExpiresHours ?? 24) * 3_600_000);

  const rootSigners = input.previousRootSigner
    ? [input.previousRootSigner, input.keys.root]
    : [input.keys.root];
  const rootBytes = signTufEnvelope(
    buildRootSignedObject({ version: rootVersion, expires: rootExpires, keys: input.keys }),
    rootSigners,
  );
  const targetsBytes = signTufEnvelope(
    {
      _type: "targets",
      spec_version: "1.0.31",
      version: targetsVersion,
      expires: targetsExpires,
      targets: {
        [targetPath]: {
          length: targetBuf.byteLength,
          hashes: { sha256: targetSha256 },
          custom: {
            catalogRevision: validatedCatalog.catalogRevision,
            schemaVersion: validatedCatalog.schemaVersion,
          },
        },
      },
    },
    [input.keys.targets],
  );
  const targetsSha256 = crypto.createHash("sha256").update(targetsBytes).digest("hex");
  const snapshotBytes = signTufEnvelope(
    {
      _type: "snapshot",
      spec_version: "1.0.31",
      version: snapshotVersion,
      expires: snapshotExpires,
      meta: {
        "targets.json": {
          version: targetsVersion,
          length: targetsBytes.byteLength,
          hashes: { sha256: targetsSha256 },
        },
      },
    },
    [input.keys.snapshot],
  );
  const snapshotSha256 = crypto.createHash("sha256").update(snapshotBytes).digest("hex");
  const timestampBytes = signTufEnvelope(
    {
      _type: "timestamp",
      spec_version: "1.0.31",
      version: timestampVersion,
      expires: timestampExpires,
      meta: {
        "snapshot.json": {
          version: snapshotVersion,
          length: snapshotBytes.byteLength,
          hashes: { sha256: snapshotSha256 },
        },
      },
    },
    [input.keys.timestamp],
  );

  // 发布自检：所有产物必须通过与客户端完全相同的外包安全策略校验
  validateTufMetadataBytes(rootBytes, "root");
  validateTufMetadataBytes(targetsBytes, "targets");
  validateTufMetadataBytes(snapshotBytes, "snapshot");
  validateTufMetadataBytes(timestampBytes, "timestamp");

  await writeBytesAtomic(path.join(targetsDir, targetPath), targetBuf);
  await writeBytesAtomic(path.join(metadataDir, `${rootVersion}.root.json`), rootBytes);
  await writeBytesAtomic(path.join(metadataDir, "targets.json"), targetsBytes);
  await writeBytesAtomic(path.join(metadataDir, "snapshot.json"), snapshotBytes);
  await writeBytesAtomic(path.join(metadataDir, "timestamp.json"), timestampBytes);

  return {
    metadataDir,
    targetsDir,
    targetPath,
    catalogRevision: validatedCatalog.catalogRevision,
    targetSha256,
    targetBytes: targetBuf.byteLength,
    rootVersion,
    targetsVersion,
    snapshotVersion,
    timestampVersion,
    rootBytes,
  };
}

async function readHighestVersionedRoot(
  metadataDir: string,
): Promise<{ readonly version: number; readonly bytes: Buffer }> {
  const entries = await fs.readdir(metadataDir);
  let bestVersion = 0;
  let bestFile: string | undefined;
  for (const name of entries) {
    const match = /^(\d+)\.root\.json$/u.exec(name);
    if (!match) continue;
    const ver = Number.parseInt(match[1]!, 10);
    if (Number.isSafeInteger(ver) && ver > bestVersion) {
      bestVersion = ver;
      bestFile = name;
    }
  }
  if (!bestFile) {
    throw new Error(`TUF 仓库缺少版本化根元数据（<v>.root.json）：${metadataDir}`);
  }
  const bytes = await fs.readFile(path.join(metadataDir, bestFile));
  const summary = validateTufMetadataBytes(bytes, "root");
  if (summary.version !== bestVersion) {
    throw new Error(`TUF 根文件 ${bestFile} 内部 version=${summary.version} 与文件名不一致`);
  }
  return { version: bestVersion, bytes };
}

export interface PublishTufCatalogUpdateInput {
  readonly outputDir: string;
  readonly catalog: CuratedCatalogBundle;
  readonly targetPath?: string;
  /** 日常目录发布仅使用在线三角色密钥（root 私钥全程保持离线）。 */
  readonly keys: TufOnlineRoleKeySet;
  readonly now?: Date;
  readonly targetsExpiresDays?: number;
  readonly snapshotExpiresDays?: number;
  readonly timestampExpiresHours?: number;
}

/**
 * 向已初始化的 TUF 1.0.37 静态仓库发布新修订目录（root 私钥全程不触网）：
 * - 自动读取现有最高版本 `<v>.root.json` 及当前 `targets/snapshot/timestamp` 版本号并严格 +1；
 * - 写入前以现有 `<v>.root.json` 对新签发的 `targets/snapshot/timestamp` 执行真实 Ed25519 验签自检；
 * - 绝不改动任何既有 `<v>.root.json`。
 */
export async function publishTufCatalogUpdate(
  input: PublishTufCatalogUpdateInput,
): Promise<PublishedTufRepositoryResult> {
  const validatedCatalog = parseCuratedCatalogBundle(input.catalog);
  const metadataDir = path.join(input.outputDir, "metadata");
  const targetsDir = path.join(input.outputDir, "targets");
  const targetPath = input.targetPath ?? "catalog-v1.json";
  const now = input.now ?? new Date();

  const currentRoot = await readHighestVersionedRoot(metadataDir);
  const existingTargets = validateTufMetadataBytes(
    await fs.readFile(path.join(metadataDir, "targets.json")),
    "targets",
  );
  const existingSnapshot = validateTufMetadataBytes(
    await fs.readFile(path.join(metadataDir, "snapshot.json")),
    "snapshot",
  );
  const existingTimestamp = validateTufMetadataBytes(
    await fs.readFile(path.join(metadataDir, "timestamp.json")),
    "timestamp",
  );

  const nextTargetsVersion = existingTargets.version + 1;
  const nextSnapshotVersion = existingSnapshot.version + 1;
  const nextTimestampVersion = existingTimestamp.version + 1;

  const targetBuf = Buffer.from(JSON.stringify(validatedCatalog, null, 2) + "\n", "utf8");
  const targetSha256 = crypto.createHash("sha256").update(targetBuf).digest("hex");

  const targetsBytes = signTufEnvelope(
    {
      _type: "targets",
      spec_version: "1.0.31",
      version: nextTargetsVersion,
      expires: addMsIso(now, (input.targetsExpiresDays ?? 30) * 86_400_000),
      targets: {
        [targetPath]: {
          length: targetBuf.byteLength,
          hashes: { sha256: targetSha256 },
          custom: {
            catalogRevision: validatedCatalog.catalogRevision,
            schemaVersion: validatedCatalog.schemaVersion,
          },
        },
      },
    },
    [input.keys.targets],
  );
  const targetsSha256 = crypto.createHash("sha256").update(targetsBytes).digest("hex");
  const snapshotBytes = signTufEnvelope(
    {
      _type: "snapshot",
      spec_version: "1.0.31",
      version: nextSnapshotVersion,
      expires: addMsIso(now, (input.snapshotExpiresDays ?? 7) * 86_400_000),
      meta: {
        "targets.json": {
          version: nextTargetsVersion,
          length: targetsBytes.byteLength,
          hashes: { sha256: targetsSha256 },
        },
      },
    },
    [input.keys.snapshot],
  );
  const snapshotSha256 = crypto.createHash("sha256").update(snapshotBytes).digest("hex");
  const timestampBytes = signTufEnvelope(
    {
      _type: "timestamp",
      spec_version: "1.0.31",
      version: nextTimestampVersion,
      expires: addMsIso(now, (input.timestampExpiresHours ?? 24) * 3_600_000),
      meta: {
        "snapshot.json": {
          version: nextSnapshotVersion,
          length: snapshotBytes.byteLength,
          hashes: { sha256: snapshotSha256 },
        },
      },
    },
    [input.keys.timestamp],
  );

  // 落盘前以现有仓库最高版本根验证在线角色签名与策略，密钥不匹配立即失败关闭
  verifyTufEnvelopeSignatureAgainstRoot(targetsBytes, currentRoot.bytes, "targets");
  verifyTufEnvelopeSignatureAgainstRoot(snapshotBytes, currentRoot.bytes, "snapshot");
  verifyTufEnvelopeSignatureAgainstRoot(timestampBytes, currentRoot.bytes, "timestamp");

  await fs.mkdir(targetsDir, { recursive: true });
  await writeBytesAtomic(path.join(targetsDir, targetPath), targetBuf);
  await writeBytesAtomic(path.join(metadataDir, "targets.json"), targetsBytes);
  await writeBytesAtomic(path.join(metadataDir, "snapshot.json"), snapshotBytes);
  await writeBytesAtomic(path.join(metadataDir, "timestamp.json"), timestampBytes);

  return {
    metadataDir,
    targetsDir,
    targetPath,
    catalogRevision: validatedCatalog.catalogRevision,
    targetSha256,
    targetBytes: targetBuf.byteLength,
    rootVersion: currentRoot.version,
    targetsVersion: nextTargetsVersion,
    snapshotVersion: nextSnapshotVersion,
    timestampVersion: nextTimestampVersion,
    rootBytes: currentRoot.bytes,
  };
}

/**
 * 周期续签在线元数据（timestamp / snapshot / targets）期限并递增版本号，
 * 仅使用在线角色密钥（root 私钥保持离线），严禁修改目标目录字节或虚改任何模型的 `verifiedAt` 日期（设计 §4.2）。
 */
export async function renewTufMetadata(input: {
  readonly outputDir: string;
  readonly targetPath?: string;
  readonly keys: TufOnlineRoleKeySet;
  readonly now?: Date;
  readonly targetsExpiresDays?: number;
  readonly snapshotExpiresDays?: number;
  readonly timestampExpiresHours?: number;
}): Promise<{
  readonly targetsVersion: number;
  readonly snapshotVersion: number;
  readonly timestampVersion: number;
  readonly targetSha256Unchanged: string;
}> {
  const metadataDir = path.join(input.outputDir, "metadata");
  const targetsDir = path.join(input.outputDir, "targets");
  const targetPath = input.targetPath ?? "catalog-v1.json";
  const now = input.now ?? new Date();

  const currentRoot = await readHighestVersionedRoot(metadataDir);
  const existingTargets = validateTufMetadataBytes(
    await fs.readFile(path.join(metadataDir, "targets.json")),
    "targets",
  );
  const existingSnapshot = validateTufMetadataBytes(
    await fs.readFile(path.join(metadataDir, "snapshot.json")),
    "snapshot",
  );
  const existingTimestamp = validateTufMetadataBytes(
    await fs.readFile(path.join(metadataDir, "timestamp.json")),
    "timestamp",
  );
  const targetBuf = await fs.readFile(path.join(targetsDir, targetPath));
  const targetSha256 = crypto.createHash("sha256").update(targetBuf).digest("hex");
  const catalog = parseCuratedCatalogBundle(JSON.parse(targetBuf.toString("utf8")));

  const nextTargetsVersion = existingTargets.version + 1;
  const nextSnapshotVersion = existingSnapshot.version + 1;
  const nextTimestampVersion = existingTimestamp.version + 1;

  const targetsBytes = signTufEnvelope(
    {
      _type: "targets",
      spec_version: "1.0.31",
      version: nextTargetsVersion,
      expires: addMsIso(now, (input.targetsExpiresDays ?? 30) * 86_400_000),
      targets: {
        [targetPath]: {
          length: targetBuf.byteLength,
          hashes: { sha256: targetSha256 },
          custom: {
            catalogRevision: catalog.catalogRevision,
            schemaVersion: catalog.schemaVersion,
          },
        },
      },
    },
    [input.keys.targets],
  );
  const targetsSha256 = crypto.createHash("sha256").update(targetsBytes).digest("hex");
  const snapshotBytes = signTufEnvelope(
    {
      _type: "snapshot",
      spec_version: "1.0.31",
      version: nextSnapshotVersion,
      expires: addMsIso(now, (input.snapshotExpiresDays ?? 7) * 86_400_000),
      meta: {
        "targets.json": {
          version: nextTargetsVersion,
          length: targetsBytes.byteLength,
          hashes: { sha256: targetsSha256 },
        },
      },
    },
    [input.keys.snapshot],
  );
  const snapshotSha256 = crypto.createHash("sha256").update(snapshotBytes).digest("hex");
  const timestampBytes = signTufEnvelope(
    {
      _type: "timestamp",
      spec_version: "1.0.31",
      version: nextTimestampVersion,
      expires: addMsIso(now, (input.timestampExpiresHours ?? 24) * 3_600_000),
      meta: {
        "snapshot.json": {
          version: nextSnapshotVersion,
          length: snapshotBytes.byteLength,
          hashes: { sha256: snapshotSha256 },
        },
      },
    },
    [input.keys.timestamp],
  );

  // 落盘前对照当前仓库最高版本根做 Ed25519 验签自检
  verifyTufEnvelopeSignatureAgainstRoot(targetsBytes, currentRoot.bytes, "targets");
  verifyTufEnvelopeSignatureAgainstRoot(snapshotBytes, currentRoot.bytes, "snapshot");
  verifyTufEnvelopeSignatureAgainstRoot(timestampBytes, currentRoot.bytes, "timestamp");

  await writeBytesAtomic(path.join(metadataDir, "targets.json"), targetsBytes);
  await writeBytesAtomic(path.join(metadataDir, "snapshot.json"), snapshotBytes);
  await writeBytesAtomic(path.join(metadataDir, "timestamp.json"), timestampBytes);

  return {
    targetsVersion: nextTargetsVersion,
    snapshotVersion: nextSnapshotVersion,
    timestampVersion: nextTimestampVersion,
    targetSha256Unchanged: targetSha256,
  };
}

export interface RotateTufRootInput {
  readonly outputDir: string;
  readonly targetPath?: string;
  readonly previousRootKey: TufRoleKeyPair;
  readonly nextKeys: TufFourRoleKeySet;
  readonly now?: Date;
  readonly rootExpiresDays?: number;
  readonly targetsExpiresDays?: number;
  readonly snapshotExpiresDays?: number;
  readonly timestampExpiresHours?: number;
}

export interface RotateTufRootResult {
  readonly previousRootVersion: number;
  readonly nextRootVersion: number;
  readonly nextRootBytes: Buffer;
  readonly targetsVersion: number;
  readonly snapshotVersion: number;
  readonly timestampVersion: number;
  readonly targetSha256Unchanged: string;
}

/**
 * 离线 TUF 1.0.37 连续双阈值根轮换（vN → vN+1）：
 * - 保留所有历史 `<1..N>.root.json` 不删改；
 * - 生成由旧根私钥与新根私钥共同签名的 `<N+1>.root.json`，并同时用旧根和新根验签自检；
 * - 随后用新在线三角色密钥续签 `targets/snapshot/timestamp`（目标目录字节与 `verifiedAt` 严格不变）。
 */
export async function rotateTufRoot(input: RotateTufRootInput): Promise<RotateTufRootResult> {
  const metadataDir = path.join(input.outputDir, "metadata");
  const now = input.now ?? new Date();
  const prevRoot = await readHighestVersionedRoot(metadataDir);
  const nextRootVersion = prevRoot.version + 1;
  const nextRootExpires = addMsIso(now, (input.rootExpiresDays ?? 365) * 86_400_000);

  const nextRootSigners =
    input.previousRootKey.keyid === input.nextKeys.root.keyid
      ? [input.nextKeys.root]
      : [input.previousRootKey, input.nextKeys.root];
  const nextRootBytes = signTufEnvelope(
    buildRootSignedObject({
      version: nextRootVersion,
      expires: nextRootExpires,
      keys: input.nextKeys,
    }),
    nextRootSigners,
  );

  // TUF 1.0.37 双阈值校验：新根必须同时通过旧根与新根自身阈值验签
  verifyTufEnvelopeSignatureAgainstRoot(nextRootBytes, prevRoot.bytes, "root");
  verifyTufEnvelopeSignatureAgainstRoot(nextRootBytes, nextRootBytes, "root");

  await writeBytesAtomic(path.join(metadataDir, `${nextRootVersion}.root.json`), nextRootBytes);

  const renewed = await renewTufMetadata({
    outputDir: input.outputDir,
    ...(input.targetPath ? { targetPath: input.targetPath } : {}),
    keys: input.nextKeys,
    now,
    ...(input.targetsExpiresDays !== undefined ? { targetsExpiresDays: input.targetsExpiresDays } : {}),
    ...(input.snapshotExpiresDays !== undefined ? { snapshotExpiresDays: input.snapshotExpiresDays } : {}),
    ...(input.timestampExpiresHours !== undefined
      ? { timestampExpiresHours: input.timestampExpiresHours }
      : {}),
  });

  return {
    previousRootVersion: prevRoot.version,
    nextRootVersion,
    nextRootBytes,
    ...renewed,
  };
}

// ─── 4. 官方资料采集 → 可审差异 → 旧端兼容核验 → 按需续签触发（设计 §4.1、§4.2） ───

export interface UpstreamCatalogCollectionSource {
  readonly presetId: string;
  readonly endpoint: string;
  readonly adapter: ModelAdapterId;
  readonly auth: ConnectionAuthConfig;
  readonly secretValue?: string;
  readonly network?: ConnectionNetworkConfig;
  readonly allowOptionalCompatProbe?: boolean;
  readonly evidenceSource?: string;
}

export interface CollectUpstreamCatalogInput {
  readonly baseCatalog: CuratedCatalogBundle;
  readonly sources: readonly UpstreamCatalogCollectionSource[];
  readonly nextRevision?: string;
  readonly legacyReaderCapabilities?: readonly string[];
  readonly now?: Date;
  readonly signal?: AbortSignal;
}

export interface UpstreamSourceCollectionReport {
  readonly presetId: string;
  readonly status: string;
  readonly discoveredCount: number;
  readonly mergedChatCount: number;
  readonly filteredNonChatCount: number;
  readonly message: string;
}

export interface CollectUpstreamCatalogResult {
  readonly candidate: CuratedCatalogBundle;
  readonly diff: CuratedCatalogDiff;
  readonly diffMarkdown: string;
  /** 内容绑定的人审确认摘要（绑定真实基线 + 真实候选 + 审阅差异单，单字段改动即失效）。 */
  readonly reviewDigest: string;
  readonly reviewBinding: CatalogReviewBinding;
  readonly readerCompatibility: CompatibilityCheckReport;
  readonly sourceReports: readonly UpstreamSourceCollectionReport[];
}

/**
 * 官方资料采集流水线：调用受控原生发现器拉取获准官方接口，按结构化断言过滤非对话条目，
 * 仅合并事实字段（绝不顺带改写独立维护的 `recommendations`），并自动产出可审 diff、审阅摘要与旧端兼容报告。
 */
export async function collectUpstreamCatalogCandidate(
  input: CollectUpstreamCatalogInput,
): Promise<CollectUpstreamCatalogResult> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString().replace(/\.\d{3}Z$/u, "Z");
  const base = parseCuratedCatalogBundle(input.baseCatalog);
  const nextModels: CuratedModelEntry[] = base.models.map((m) => structuredClone(m));
  const modelIndex = new Map<string, number>();
  for (let i = 0; i < nextModels.length; i += 1) {
    modelIndex.set(`${nextModels[i]!.presetId}::${nextModels[i]!.id}`, i);
  }
  const sourceReports: UpstreamSourceCollectionReport[] = [];

  for (const src of input.sources) {
    const disc = await discoverConnectionModels({
      connectionId: `collector-${src.presetId}`,
      presetId: src.presetId,
      adapter: src.adapter,
      endpoint: src.endpoint,
      auth: src.auth,
      ...(src.secretValue ? { secretValue: src.secretValue } : {}),
      network: src.network ?? { proxy: "inherit" },
      catalog: base,
      ...(src.allowOptionalCompatProbe !== undefined
        ? { allowOptionalCompatProbe: src.allowOptionalCompatProbe }
        : {}),
      signal: input.signal,
    });

    if (disc.status !== "discovered") {
      sourceReports.push({
        presetId: src.presetId,
        status: disc.status,
        discoveredCount: 0,
        mergedChatCount: 0,
        filteredNonChatCount: 0,
        message: disc.userMessage,
      });
      continue;
    }

    let mergedChatCount = 0;
    let filteredNonChatCount = 0;
    const evidence = src.evidenceSource ?? `Official upstream discovery (${disc.sanitizedEndpoint})`;

    for (const item of disc.models) {
      if (isStructuredNonChatModel({ discovered: item })) {
        filteredNonChatCount += 1;
        continue;
      }
      const key = `${src.presetId}::${item.id}`;
      const existingIdx = modelIndex.get(key);
      if (existingIdx !== undefined) {
        const cur = nextModels[existingIdx]!;
        const updated: CuratedModelEntry = {
          ...cur,
          ...(item.name ? { name: item.name } : {}),
          ...(item.contextWindow !== undefined ? { contextWindow: item.contextWindow } : {}),
          ...(item.maxOutputTokens !== undefined ? { maxOutputTokens: item.maxOutputTokens } : {}),
          ...(item.supportsTools !== undefined ? { supportsTools: item.supportsTools } : {}),
          ...(item.supportsImages !== undefined ? { supportsImages: item.supportsImages } : {}),
          ...(item.supportsThinking !== undefined ? { supportsThinking: item.supportsThinking } : {}),
          ...(item.pricing ? { pricing: item.pricing } : {}),
          ...(item.lifecycle ? { lifecycle: item.lifecycle } : {}),
          evidenceSource: evidence,
          verifiedAt: nowIso,
        };
        nextModels[existingIdx] = updated;
      } else {
        const created: CuratedModelEntry = {
          presetId: src.presetId,
          id: item.id,
          name: item.name ?? item.id,
          purpose: "chat",
          lifecycle: item.lifecycle ?? "active",
          ...(item.contextWindow !== undefined ? { contextWindow: item.contextWindow } : {}),
          ...(item.maxOutputTokens !== undefined ? { maxOutputTokens: item.maxOutputTokens } : {}),
          ...(item.supportsTools !== undefined ? { supportsTools: item.supportsTools } : {}),
          ...(item.supportsImages !== undefined ? { supportsImages: item.supportsImages } : {}),
          ...(item.supportsThinking !== undefined ? { supportsThinking: item.supportsThinking } : {}),
          ...(item.pricing ? { pricing: item.pricing } : {}),
          evidenceSource: evidence,
          verifiedAt: nowIso,
        };
        modelIndex.set(key, nextModels.length);
        nextModels.push(created);
      }
      mergedChatCount += 1;
    }

    sourceReports.push({
      presetId: src.presetId,
      status: disc.status,
      discoveredCount: disc.models.length,
      mergedChatCount,
      filteredNonChatCount,
      message: disc.userMessage,
    });
  }

  const candidate = parseCuratedCatalogBundle({
    ...base,
    catalogRevision: input.nextRevision ?? `${nowIso.slice(0, 10).replaceAll("-", ".")}-collected`,
    publishedAt: nowIso,
    models: nextModels,
    // 严格保持推荐表独立：事实采集绝不改写用途推荐
    recommendations: structuredClone(base.recommendations),
  });
  const review = computeCatalogReviewBinding(base, candidate);
  const readerCompatibility = verifyCatalogCompatibilityForReader(
    candidate,
    input.legacyReaderCapabilities ?? LOCAL_SUPPORTED_CATALOG_CAPABILITIES,
  );

  return {
    candidate,
    diff: review.diff,
    diffMarkdown: review.diffMarkdown,
    reviewDigest: review.binding.approvalDigest,
    reviewBinding: review.binding,
    readerCompatibility,
    sourceReports,
  };
}

export interface TufRenewalDueCheckResult {
  readonly due: boolean;
  readonly rolesDue: readonly TufRoleName[];
  readonly details: Readonly<
    Record<"timestamp" | "snapshot" | "targets", { readonly expires: string; readonly remainingHours: number; readonly due: boolean }>
  >;
}

/**
 * 检查本地/CI TUF 静态仓库元数据是否进入到期前续签窗口（触发周期续签，绝不改模型 `verifiedAt`）。
 */
export async function checkTufRenewalDue(input: {
  readonly outputDir: string;
  readonly now?: Date;
  readonly timestampThresholdHours?: number;
  readonly snapshotThresholdHours?: number;
  readonly targetsThresholdHours?: number;
}): Promise<TufRenewalDueCheckResult> {
  const nowMs = (input.now ?? new Date()).getTime();
  const metadataDir = path.join(input.outputDir, "metadata");
  const thresholds = {
    timestamp: (input.timestampThresholdHours ?? 12) * 3_600_000,
    snapshot: (input.snapshotThresholdHours ?? 48) * 3_600_000,
    targets: (input.targetsThresholdHours ?? 7 * 24) * 3_600_000,
  } as const;

  const rolesDue: TufRoleName[] = [];
  const details = {} as Record<
    "timestamp" | "snapshot" | "targets",
    { readonly expires: string; readonly remainingHours: number; readonly due: boolean }
  >;
  for (const role of ["timestamp", "snapshot", "targets"] as const) {
    const bytes = await fs.readFile(path.join(metadataDir, `${role}.json`));
    const summary = validateTufMetadataBytes(bytes, role);
    const remainingMs = Date.parse(summary.expires) - nowMs;
    const isDue = remainingMs <= thresholds[role];
    if (isDue) rolesDue.push(role);
    details[role] = {
      expires: summary.expires,
      remainingHours: Math.round((remainingMs / 3_600_000) * 100) / 100,
      due: isDue,
    };
  }
  return {
    due: rolesDue.length > 0,
    rolesDue,
    details,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 全键递归深度比对（消除手工字段白名单遗漏）：
 * - 按确定性字典序遍历 `Object.keys(a) ∪ Object.keys(b)`；
 * - 嵌套普通对象逐层展开为点分路径（如 `discovery.authoritativeNativeFacts`、`defaultNetwork.proxy`、`quirks.thinkingDialect`）；
 * - 任意影响用户或运行语义的字段变更均不可能从审阅单中消失。
 */
function diffObjectsDeep(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  excludeTopLevelKeys: ReadonlySet<string> = new Set(),
  prefix = "",
): FieldChange[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort((x, y) =>
    x.localeCompare(y, "en-US"),
  );
  const changes: FieldChange[] = [];
  for (const key of keys) {
    if (!prefix && excludeTopLevelKeys.has(key)) continue;
    const before = a[key];
    const after = b[key];
    if (before === undefined && after === undefined) continue;
    const fieldPath = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(before) && isPlainObject(after)) {
      changes.push(...diffObjectsDeep(before, after, new Set(), fieldPath));
      continue;
    }
    const beforeNorm = before === undefined ? null : before;
    const afterNorm = after === undefined ? null : after;
    if (before === undefined || after === undefined || canonicalize(beforeNorm) !== canonicalize(afterNorm)) {
      changes.push({ field: fieldPath, before, after });
    }
  }
  return changes;
}

function diffPresetFields(a: CuratedPreset, b: CuratedPreset): FieldChange[] {
  return diffObjectsDeep(
    a as unknown as Record<string, unknown>,
    b as unknown as Record<string, unknown>,
    new Set(["id"]),
  );
}

function diffModelFields(a: CuratedModelEntry, b: CuratedModelEntry): FieldChange[] {
  return diffObjectsDeep(
    a as unknown as Record<string, unknown>,
    b as unknown as Record<string, unknown>,
    new Set(["presetId", "id"]),
  );
}
