/**
 * Skill Catalog 的跨边界数据模型。Authority 记录拥有目录状态，正文由不可变
 * ArtifactRef 指向 CAS；类型不携带本机路径或第二份可写状态。
 */

/** 技能来源 —— `own` 为对话保存，`linked` 为正式 admission。 */
export type SkillSource = "own" | "linked";

/** 模式分区 —— 决定投影注入哪个 runtime 的系统提示词。 */
export type SkillMode = "main" | "work";
export type SkillModeDto = "main" | "work";

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

/** Path-free Authority Catalog entry shared by runtime and management views. */
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
