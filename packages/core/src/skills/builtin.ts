/**
 * 能力登记处 —— 系统内置能力(builtin)的单一注册点。
 *
 * 能力内化机制的承载:系统能力 = 内置技能(程序性知识),与用户技能同走
 * 渐进披露管线(索引常驻 → 命中唤醒 → load_skill 加载全文 → 工具落地)。
 * 登记一次,两个消费者各取投影:Store(loadText 分支 / 索引拼池)读方法,
 * runtime 装配读关联工具(随能力增量补字段)。
 *
 * 实现形态 = 代码内注册集(TS 字符串模块):全仓 prompt 均为代码内常量、
 * 构建不打包非 JS 资源,代码内注册集零 fs 读取、零路径问题、天然随版本
 * 分发——升级即更新、用户目录零污染。
 *
 * 与用户资产的硬边界(零状态记录):
 *   - 不落用户磁盘、不进 `index.json`(无 pinned / disabled —— 用户管不了
 *     机制内部件,定制走 fork-to-own:own 同名即遮蔽 builtin,原件随版本演进)
 *   - 不进 `listAll`(slash 补全零暴露 —— 进入即把系统能力变相恢复成用户
 *     命令入口)、不进 `listForManagement`(管理列表零暴露)
 *   - 唤醒只有两路:模型自主(索引命中)+ 用户自然语言(模型理解后 load_skill)
 *   - 适用模式由条目自带声明(不走用户 mode 状态过滤),缺省全模式
 *   - 索引占独立小额度,不挤占用户技能 top-N
 */

import { skillNameToId } from "./id.js";
import type { SkillMode } from "./types.js";
import { BUILTIN_SKILL_DEFS } from "./builtin-skills.js";

/** 登记一份内置能力方法所需的内容(id 由 name 派生,登记时算好)。 */
export interface BuiltinSkillDef {
  /** 显示名;id = skillNameToId(name),与用户技能同一变换、不断链。 */
  name: string;
  /** 索引行展示,决定模型能否检索命中 —— 以"什么时候该用"为导向。 */
  description: string;
  /** 方法正文(SKILL 正文形态,load_skill 加载的全文)。 */
  body: string;
  /** 适用模式 —— 在哪些模式的索引可见;由能力自身声明,非用户状态。 */
  modes: readonly SkillMode[];
  /**
   * 能力的配套落地工具引用(工具名,实现经 BUILTIN_TOOL_FACTORIES 装配)。
   * 红线:每能力 ≤ 1 工具、优先零工具——方法能指导模型用既有工具完成的
   * 不开新工具,只有不变量需要焊接时才开(测试锁此红线;能力增多触发暴露
   * 形态切换为执行网关时,本字段即网关的校验依据,登记零返工)。
   */
  tools?: readonly string[];
}

/** 登记处条目 —— def + 派生 id 定格。 */
export interface BuiltinSkillEntry extends BuiltinSkillDef {
  id: string;
}

/** 索引拼池用的最小条目形态(renderSkillIndex 的入参子集)。 */
export interface BuiltinIndexEntry {
  id: string;
  description: string;
  pinned: false;
}

const REGISTRY: ReadonlyMap<string, BuiltinSkillEntry> = new Map(
  BUILTIN_SKILL_DEFS.map((def) => {
    const id = skillNameToId(def.name);
    return [id, { ...def, id }];
  }),
);

/** 按 id 取内置能力;不存在返回 null(Store loadText 据此走目录/builtin 分支)。 */
export function getBuiltinSkill(id: string): BuiltinSkillEntry | null {
  return REGISTRY.get(id) ?? null;
}

/**
 * 取某模式下应进索引的 builtin 条目(独立于用户 top-N 的分池)。
 *
 * excludeIds = 用户技能全集 id(own 同名遮蔽 builtin:用户版生效时索引
 * 不再展示 builtin 条目,load_skill 也会命中用户版——展示与加载一致)。
 */
export function builtinIndexEntries(
  mode: SkillMode,
  excludeIds: ReadonlySet<string>,
): BuiltinIndexEntry[] {
  const out: BuiltinIndexEntry[] = [];
  for (const entry of REGISTRY.values()) {
    if (!entry.modes.includes(mode)) continue;
    if (excludeIds.has(entry.id)) continue;
    out.push({ id: entry.id, description: entry.description, pinned: false });
  }
  return out;
}
