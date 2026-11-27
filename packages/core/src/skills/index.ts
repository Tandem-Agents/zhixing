/**
 * 技能(Skill)模块 —— 桶导出。
 *
 * 根桶只保留通用 Skill 数据、builtin 内容与接入原语。领域应用合同只从
 * `@zhixing-ai/core/skills/catalog` 发布，Authority/CAS 不经本桶暴露写入口。
 */

export {
  formatQualifiedSkillId,
  parseQualifiedSkillId,
  skillNameToId,
} from "./id.js";
export type { ParsedQualifiedSkillId, SkillNamespace } from "./id.js";
export {
  SKILL_PACKAGE_ARCHIVE_MAGIC,
  SKILL_PACKAGE_ARCHIVE_VERSION,
  SKILL_PACKAGE_HEADER_PREFIX_BYTES,
  SKILL_PACKAGE_MAX_DEPTH,
  SKILL_PACKAGE_MAX_MEMBER_BYTES,
  SKILL_PACKAGE_MAX_MEMBERS,
  SKILL_PACKAGE_MAX_PATH_BYTES,
  SKILL_PACKAGE_MAX_SUMMARY_BYTES,
  SKILL_PACKAGE_MAX_TOTAL_BYTES,
  SKILL_PACKAGE_ROOT_PATH,
  SkillPackageArchiveError,
  assertValidSkillPackageText,
  computeSkillPackageVersion,
  decodeSkillPackageArchive,
  encodeSkillPackageArchive,
  inferSkillMemberMediaType,
  normalizeSkillPackagePath,
  parseSkillPackageHeaderSlice,
  readSkillPackageHeader,
  truncateUtf8ToBytes,
  verifySkillPackageMemberSlice,
} from "./archive.js";
export type {
  DecodedSkillPackageArchive,
  DecodedSkillPackageMember,
  EncodedSkillPackageArchive,
  SkillPackageArchiveErrorCode,
  SkillPackageArchiveHeader,
  SkillPackageMemberInput,
  SkillPackageMemberKind,
  SkillPackageMemberManifest,
} from "./archive.js";
export { AnchorSkillGlobalStateAdapter } from "./global-state-adapter.js";
export type { AnchorSkillGlobalStateAdapterOptions } from "./global-state-adapter.js";
export { renderSkillIndex, renderSkillIndexV2 } from "./render.js";
export type { RenderSkillIndexOptions, SkillIndexEntry } from "./render.js";
export { getBuiltinSkill, listBuiltinSkills, builtinIndexEntries } from "./builtin.js";
export type {
  BuiltinSkillDef,
  BuiltinSkillEntry,
  BuiltinSkillResourceDef,
  BuiltinIndexEntry,
} from "./builtin.js";
export { scanSkillContent, scanHighConfidenceSecrets } from "./content-scan.js";
export type { ContentThreat, HighConfidenceSecretBlockResult } from "./content-scan.js";
export {
  reviewAdmission,
  assessSkill,
  assessSkillPackage,
  acquireToStaging,
  stageLocalSkillPackage,
  writeVerifiedSkillPackageToDirectory,
  computeStagingDigest,
  ADMISSION_MAX_MEMBER_BYTES,
  ADMISSION_MAX_TOTAL_BYTES,
  ADMISSION_TOKEN_TTL_MS,
} from "./admission.js";
export type {
  AdmissionLlm,
  AdmissionVerdict,
  AdmissionAssessment,
  SkillImportSource,
  StageLocalSkillPackageOptions,
  StagedLocalSkillMember,
  StagedLocalSkillPackage,
} from "./admission.js";
export * from "./types.js";
