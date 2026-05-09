import type { AnchorGenerator } from "../types.js";

/**
 * grep 工具事实锚 —— 锚化 regex 搜索调用历史。
 *
 * 成功：`[grep "<pattern>", <N> match lines]`
 * 失败：`[grep "<pattern>", error]`
 *
 * grep 输出每行一条匹配，行数 ≈ 匹配条数（足够 LLM 评估搜索结果规模）。
 */
export const grepAnchor: AnchorGenerator = {
  toolName: "grep",
  generate(toolUse, toolResult) {
    const pattern = toolUse.input.pattern;
    if (typeof pattern !== "string" || pattern.length === 0) return null;
    if (toolResult.isError) return `[grep "${pattern}", error]`;
    const matchLineCount = countNonEmptyLines(toolResult.content);
    return `[grep "${pattern}", ${matchLineCount} match lines]`;
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
