/**
 * renderProgressiveHint — 把 ArgSchema 渲染成人读的 hint 字符串
 *
 * 用于 TypeaheadPanel 在 dropdown 下方显示下一个参数的 schema 概要。
 *
 * 示例输出：
 *   - `[level: on|off|ask|full]`（enum）
 *   - `[mode: on|off|status]`（enum，optional → 加 "?"）
 *   - `[prompt: text]`（自由文本）
 *   - `[depth: number (1-10)]`（数字 + 范围）
 *   - `[enabled: true|false]`（布尔）
 *   - `[path: path]`（路径）
 *   - `[name: ...]`（async-enum，候选需查询）
 */

import type { ArgChoice, ArgSchema } from "./types.js";

// ─── 公开 API ───

/**
 * 把一个 ArgSchema 渲染成 hint 字符串。
 *
 * @param schema 参数 schema
 * @returns 格式化的 hint 字符串，如 `[level: on|off|ask|full]`
 */
export function renderProgressiveHint(schema: ArgSchema): string {
  const optionalMark = schema.required ? "" : "?";
  const name = schema.name + optionalMark;

  switch (schema.kind) {
    case "enum":
      return `[${name}: ${formatChoices(schema.choices)}]`;
    case "async-enum":
      return `[${name}: …]`;
    case "text":
      return `[${name}: ${schema.placeholder ?? "text"}]`;
    case "path":
      return `[${name}: ${schema.onlyDirectories ? "directory" : "path"}]`;
    case "boolean":
      return `[${name}: true|false]`;
    case "number": {
      const range = formatNumberRange(schema.min, schema.max);
      return range ? `[${name}: number (${range})]` : `[${name}: number]`;
    }
    default:
      return `[${name}]`;
  }
}

/**
 * 渲染多个参数的完整 hint 行。已填充的参数标 ✓，当前参数高亮。
 *
 * 例：`✓ level · [mode?: on|off|status]`
 */
export function renderFullHintLine(
  schemas: readonly ArgSchema[],
  argIndex: number,
): string {
  const parts: string[] = [];
  for (let i = 0; i < schemas.length; i++) {
    if (i < argIndex) {
      // 已填充
      parts.push(`✓ ${schemas[i]!.name}`);
    } else if (i === argIndex) {
      // 当前参数
      parts.push(renderProgressiveHint(schemas[i]!));
    } else {
      // 后续参数（淡化显示 —— 渲染器决定颜色）
      parts.push(renderProgressiveHint(schemas[i]!));
    }
  }
  return parts.join(" · ");
}

// ─── 内部辅助 ───

function formatChoices(choices: readonly ArgChoice[]): string {
  return choices
    .map((c) => (typeof c === "string" ? c : c.value))
    .join("|");
}

function formatNumberRange(
  min: number | undefined,
  max: number | undefined,
): string | null {
  if (min !== undefined && max !== undefined) return `${min}-${max}`;
  if (min !== undefined) return `≥${min}`;
  if (max !== undefined) return `≤${max}`;
  return null;
}
