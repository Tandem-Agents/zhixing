/**
 * 技能(Skill)模块 —— 桶导出。
 *
 * 当前导出 Store 基础(id 变换、路径、数据模型)。随增量推进,Store 实现、
 * Index 投影、Loader 工具、Admission 规则在此逐步补全。
 */

export { skillNameToId } from "./id.js";
export { SkillStore } from "./store.js";
export { renderSkillIndex } from "./render.js";
export type { RenderSkillIndexOptions, SkillIndexEntry } from "./render.js";
export { getBuiltinSkill, builtinIndexEntries } from "./builtin.js";
export { runSkillSavePipeline } from "./save-pipeline.js";
export type { SkillSaveOutcome } from "./save-pipeline.js";
export type {
  BuiltinSkillDef,
  BuiltinSkillEntry,
  BuiltinIndexEntry,
} from "./builtin.js";
export { draftSkill, reviseSkill } from "./drafting.js";
export type {
  SkillDraftLlm,
  DraftSeed,
  SkillDraftResult,
  SkillReviseResult,
} from "./drafting.js";
export { scanSkillContent } from "./content-scan.js";
export type { ContentThreat } from "./content-scan.js";
export { reviewAdmission, assessSkill, acquireToStaging } from "./admission.js";
export type {
  AdmissionLlm,
  AdmissionVerdict,
  AdmissionAssessment,
  SkillImportSource,
} from "./admission.js";
export * from "./types.js";
export * from "./paths.js";
