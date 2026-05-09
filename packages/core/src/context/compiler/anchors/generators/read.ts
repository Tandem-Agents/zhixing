import type { AnchorGenerator } from "../types.js";

/**
 * read 工具事实锚 —— 锚化 file 读取调用历史。
 *
 * 成功：`[read <path>, <N> lines]`
 * 失败：`[read <path>, error]`
 *
 * 行数从 content 文本计数；tier-compressor 截断后的内容仍能给出近似行数
 * （足够 LLM 评估 file 大小级别）。
 */
export const readAnchor: AnchorGenerator = {
  toolName: "read",
  generate(toolUse, toolResult) {
    const path = toolUse.input.path;
    if (typeof path !== "string" || path.length === 0) return null;
    if (toolResult.isError) return `[read ${path}, error]`;
    const lineCount = toolResult.content.split("\n").length;
    return `[read ${path}, ${lineCount} lines]`;
  },
};
