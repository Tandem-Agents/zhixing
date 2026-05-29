/**
 * 技能(Skill)模块 —— 桶导出。
 *
 * 当前导出 Store 基础(id 变换、路径、数据模型)。随增量推进,Store 实现、
 * Index 投影、Loader 工具、Admission 规则在此逐步补全。
 */

export { skillNameToId } from "./id.js";
export { SkillStore } from "./store.js";
export { renderSkillIndex } from "./render.js";
export type { RenderSkillIndexOptions } from "./render.js";
export * from "./types.js";
export * from "./paths.js";
