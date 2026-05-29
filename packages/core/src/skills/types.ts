/**
 * 技能(Skill)模块数据模型。
 *
 * 两层物理分离:内容层 = `SKILL.md`(frontmatter + 正文,生态标准,零私有字段);
 * 状态/度量层 = zhixing 私有旁路(`index.json` 状态、`usage/<id>.json` 度量)。
 * 存在性由磁盘目录(own/linked)决定,这里的状态对象只在技能"已存在"前提下描述它。
 */

/** 技能来源 —— 由所在目录直接决定,不入 index(目录能定的不存字段)。 */
export type SkillSource = "own" | "linked";

/** 模式分区 —— 决定索引注入哪个 runtime 的系统提示词。权威在 index,frontmatter 不含。 */
export type SkillMode = "main" | "work";

/**
 * `index.json` 里每条技能的状态旁路。
 *
 * 它**不决定技能是否存在**(那由目录扫描决定),只对扫到的技能附加可变状态。
 * 首次扫到无记录时持久化默认值 + `createdAt`;index 损坏不致命(技能仍在、状态重置)。
 */
export interface SkillState {
  /** = skillNameToId(frontmatter.name);撞名时 own 遮蔽 linked。 */
  id: string;
  /** 初值由创建 / 接入上下文定,之后用户可改。 */
  mode: SkillMode;
  /** 强制进 top-N + 不被技能管家淘汰。 */
  pinned: boolean;
  /** 临时禁用:不进索引,但保留技能。 */
  disabled: boolean;
  /** 首次扫到 / 接入 / 创建时写一次、之后不变;top-N 对无 usage 新技能的排序 fallback。 */
  createdAt: string;
}

/** `usage/<id>.json` 度量旁路 —— 高频写、与内容和结构性状态都分通道。 */
export interface SkillUsage {
  /** 最后一次 load_skill 命中的 ISO 时间。 */
  lastHitAt: string;
  /** 累计命中次数。 */
  hitCount: number;
}

/**
 * Store 扫描 + 解析后的一条技能,供 Index / 控制面 / `/<name>` 消费。
 *
 * 合并了三处事实:磁盘目录(`source` / `dir`)、`SKILL.md` frontmatter(`name` /
 * `description`)、`index.json` 状态(`mode` / `pinned` / `disabled` / `createdAt`)。
 * 不含 usage —— 度量是高频旁路,仅排序时按需读,不挂在每条记录上。
 */
export interface SkillRecord {
  /** = skillNameToId(name)。 */
  id: string;
  /** 来自 SKILL.md frontmatter,原样保留(含 Unicode),仅供显示。 */
  name: string;
  /** 来自 frontmatter,索引段展示、决定模型能否检索命中。 */
  description: string;
  /** 由所在目录(own/linked)决定。 */
  source: SkillSource;
  /** 该技能实际目录的绝对路径(目录名不必等于 id)。 */
  dir: string;
  mode: SkillMode;
  pinned: boolean;
  disabled: boolean;
  createdAt: string;
}

/**
 * 创建 / 编辑技能的草稿 —— 由起草引擎产出、用户策展确认后落盘。
 * id 由 name 派生(skillNameToId),不入草稿;创建恒落 own(本地区)。
 */
export interface SkillDraft {
  name: string;
  description: string;
  body: string;
  mode: SkillMode;
}
