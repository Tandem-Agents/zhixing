/**
 * 技能(Skill)模块 —— 桶导出。
 *
 * 根桶只保留通用 Skill 数据、builtin 内容与接入原语。领域应用合同只从
 * `@zhixing/core/skills/catalog` 发布，Authority/CAS 不经本桶暴露写入口。
 */

export { skillNameToId } from "./id.js";
export { AnchorSkillGlobalStateAdapter } from "./global-state-adapter.js";
export type { AnchorSkillGlobalStateAdapterOptions } from "./global-state-adapter.js";
export { renderSkillIndex } from "./render.js";
export type { RenderSkillIndexOptions, SkillIndexEntry } from "./render.js";
export { getBuiltinSkill, builtinIndexEntries } from "./builtin.js";
export type {
  BuiltinSkillDef,
  BuiltinSkillEntry,
  BuiltinIndexEntry,
} from "./builtin.js";
export { scanSkillContent } from "./content-scan.js";
export type { ContentThreat } from "./content-scan.js";
export {
  reviewAdmission,
  assessSkill,
  acquireToStaging,
  computeStagingDigest,
  ADMISSION_TOKEN_TTL_MS,
} from "./admission.js";
export type {
  AdmissionLlm,
  AdmissionVerdict,
  AdmissionAssessment,
  SkillImportSource,
} from "./admission.js";
export * from "./types.js";
