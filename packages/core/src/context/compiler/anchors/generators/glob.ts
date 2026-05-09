import type { AnchorGenerator } from "../types.js";

/**
 * glob 工具事实锚 —— 锚化文件 pattern 匹配调用历史。
 *
 * 成功：`[glob "<pattern>", <N> matches]`
 * 失败：`[glob "<pattern>", error]`
 *
 * glob 输出每行一个文件路径，行数 = 匹配数。
 */
export const globAnchor: AnchorGenerator = {
  toolName: "glob",
  generate(toolUse, toolResult) {
    const pattern = toolUse.input.pattern;
    if (typeof pattern !== "string" || pattern.length === 0) return null;
    if (toolResult.isError) return `[glob "${pattern}", error]`;
    const matchCount = countNonEmptyLines(toolResult.content);
    return `[glob "${pattern}", ${matchCount} matches]`;
  },
};

function countNonEmptyLines(text: string): number {
  if (text.length === 0) return 0;
  let count = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length > 0) count++;
  }
  return count;
}
