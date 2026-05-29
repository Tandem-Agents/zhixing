/**
 * 技能索引段渲染 —— Index 层的纯投影。
 *
 * 输入是 Store 已过滤 / 排序 / 取够 top-N 的记录(见 SkillStore.queryTopN),
 * 这里只把它序列化为进系统提示词稳定区的一段文本。纯函数、无副作用、
 * byte-equal 可断言(稳定前缀缓存友好的前提)。
 *
 * 每条只给 id + description(模型靠 id 调 load_skill,无需路径);description 设
 * 单条尺寸上限,使整段总量恒有确定上界、在预算内(配合 top-N 的条数上限)。
 * 无可见技能 → 返 null,调用方据此跳过该段(不破 byte-equal)。
 */

import type { SkillRecord } from "./types.js";

const HEADER = "## Available Skills";
const INSTRUCTION =
  "To use a skill, call the `load_skill` tool with the id shown below. Descriptions are brief — load one for full instructions.";

/** 单条 description 的字符上限(安全网:description 本应简短,超出截断防单条撑爆预算)。 */
const DEFAULT_MAX_DESCRIPTION_CHARS = 200;

export interface RenderSkillIndexOptions {
  /** 单条 description 字符上限,默认 200。 */
  maxDescriptionChars?: number;
}

export function renderSkillIndex(
  records: readonly SkillRecord[],
  opts?: RenderSkillIndexOptions,
): string | null {
  if (records.length === 0) return null;
  const max = opts?.maxDescriptionChars ?? DEFAULT_MAX_DESCRIPTION_CHARS;
  const lines: string[] = [HEADER, INSTRUCTION];
  for (const r of records) {
    const star = r.pinned ? "★ " : "";
    lines.push(`- ${star}**${r.id}**: ${truncate(r.description, max)}`);
  }
  return lines.join("\n");
}

/** 超过上限则截断并以省略号收尾;不超原样返回。 */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
