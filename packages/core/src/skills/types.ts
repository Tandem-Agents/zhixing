/**
 * Skill Catalog 的跨边界数据模型。Authority 记录拥有目录状态，正文由不可变
 * ArtifactRef 指向 CAS；类型不携带本机路径或第二份可写状态。
 */

import { protocolDigest } from "../protocol/canonical.js";

/** 技能来源 —— `own` 为对话保存，`linked` 为正式 admission。 */
export type SkillSource = "own" | "linked";

/** 模式分区 —— 决定投影注入哪个 runtime 的系统提示词。 */
export type SkillMode = "main" | "work";
export type SkillModeDto = "main" | "work";

/** 正交可见性控制：与顶层 `disabled` 总闸分离。 */
export interface SkillVisibility {
  readonly modelAutoIndex: boolean;
  readonly userSlashCommand: boolean;
}

export const DEFAULT_SKILL_VISIBILITY: SkillVisibility = Object.freeze({
  modelAutoIndex: true,
  userSlashCommand: true,
});

export const SYSTEM_SKILL_VISIBILITY: SkillVisibility = Object.freeze({
  modelAutoIndex: true,
  userSlashCommand: false,
});

/** Authority Catalog 内的累计使用事实。 */
export interface SkillUsage {
  /** 最后一次 load_skill 命中的 ISO 时间。 */
  lastHitAt: string;
  /** 累计命中次数。 */
  hitCount: number;
}

/** 技能使用度量的跨边界稳定快照。 */
export interface SkillUsageRecord {
  skillId: string;
  occurredAt: import("../types/distributed.js").IsoTime;
  hitDelta: 1;
}

/** Path-free Authority Catalog entry shared by runtime and management views (v1 12 keys). */
export interface SkillCatalogEntry {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  mode: SkillModeDto;
  pinned: boolean;
  disabled: boolean;
  createdAt: import("../types/distributed.js").IsoTime;
  usage: SkillUsage | null;
  contentRef: import("../contracts/foundation.js").ArtifactRef;
  revision: number;
  digest: import("../contracts/foundation.js").Digest;
}

/** Unified Skill Package v2 catalog entry carrying visibility and optional package archive ref. */
export interface SkillCatalogEntryV2 extends SkillCatalogEntry {
  visibility: SkillVisibility;
  packageRef?: import("../contracts/foundation.js").ArtifactRef;
}

export type SkillV1ProjectionSurface = "skill-list" | "skill-catalog" | "offline-asset";

export function parseSkillVisibilityFromFrontmatter(
  data: Record<string, unknown>,
  defaults: SkillVisibility = DEFAULT_SKILL_VISIBILITY,
): SkillVisibility {
  const disableModel = data["disable-model-invocation"];
  const disableSlash = data["disable-slash-command"];
  return {
    modelAutoIndex:
      typeof disableModel === "boolean" ? !disableModel : defaults.modelAutoIndex,
    userSlashCommand:
      typeof disableSlash === "boolean" ? !disableSlash : defaults.userSlashCommand,
  };
}

export function computeSkillEntryV2Digest(
  entry: Omit<SkillCatalogEntryV2, "digest">,
): SkillCatalogEntryV2["digest"] {
  const payload = {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    source: entry.source,
    mode: entry.mode,
    pinned: entry.pinned,
    disabled: entry.disabled,
    createdAt: entry.createdAt,
    usage: entry.usage ? { ...entry.usage } : null,
    contentRef: { digest: entry.contentRef.digest, bytes: entry.contentRef.bytes },
    revision: entry.revision,
    visibility: {
      modelAutoIndex: entry.visibility.modelAutoIndex,
      userSlashCommand: entry.visibility.userSlashCommand,
    },
    ...(entry.packageRef
      ? { packageRef: { digest: entry.packageRef.digest, bytes: entry.packageRef.bytes } }
      : {}),
  } satisfies Omit<SkillCatalogEntryV2, "digest">;
  return protocolDigest("SkillCatalogEntry", 2, payload);
}

/**
 * 将旧 12 键 `SkillCatalogEntry` 投影为合法的 `SkillCatalogEntryV2`：
 * 保留原业务字段，补齐默认可见性，不含 `packageRef`，并用 `"SkillCatalogEntry"` v2 重算摘要。
 */
export function projectV1SkillEntryToV2(entry: SkillCatalogEntry): SkillCatalogEntryV2 {
  const base: Omit<SkillCatalogEntryV2, "digest"> = {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    source: entry.source,
    mode: entry.mode,
    pinned: entry.pinned,
    disabled: entry.disabled,
    createdAt: entry.createdAt,
    usage: entry.usage ? { ...entry.usage } : null,
    contentRef: { digest: entry.contentRef.digest, bytes: entry.contentRef.bytes },
    revision: entry.revision,
    visibility: { ...DEFAULT_SKILL_VISIBILITY },
  };
  return {
    ...base,
    digest: computeSkillEntryV2Digest(base),
  };
}

/**
 * 按消费面折算为旧 12 键 `SkillCatalogEntry`（供 v1 `"skill-catalog"` / `skill.list` / 共享离线资产使用）：
 * - `skill-list`: `disabled || !visibility.userSlashCommand`
 * - `skill-catalog`: `disabled || !visibility.modelAutoIndex`
 * - `offline-asset`: `disabled || !visibility.modelAutoIndex || !visibility.userSlashCommand`
 */
export function projectSkillEntryToV1(
  entry: SkillCatalogEntryV2,
  surface: SkillV1ProjectionSurface,
): SkillCatalogEntry {
  const disabled =
    surface === "skill-list"
      ? entry.disabled || !entry.visibility.userSlashCommand
      : surface === "skill-catalog"
        ? entry.disabled || !entry.visibility.modelAutoIndex
        : entry.disabled || !entry.visibility.modelAutoIndex || !entry.visibility.userSlashCommand;
  const content = {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    source: entry.source,
    mode: entry.mode,
    pinned: entry.pinned,
    disabled,
    createdAt: entry.createdAt,
    usage: entry.usage ? { ...entry.usage } : null,
    contentRef: { digest: entry.contentRef.digest, bytes: entry.contentRef.bytes },
    revision: entry.revision,
  };
  return {
    ...content,
    digest: protocolDigest("SkillCatalogEntry", 1, content),
  };
}

/** A committed Skill fact. Bindings may project it to their own transport vocabulary. */
export interface SkillCatalogChangedFact {
  readonly kind: "skill-catalog-changed";
  readonly catalogRevision: number;
}
