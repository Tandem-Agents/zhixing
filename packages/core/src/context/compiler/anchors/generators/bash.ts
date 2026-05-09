import type { AnchorGenerator } from "../types.js";

/**
 * bash 工具事实锚 —— 锚化 shell 命令执行历史。
 *
 * 成功：`[bash "<command>", ok, <N> lines]`
 * 失败：`[bash "<command>", error, <N> lines]`
 *
 * command 过长时截断到首 80 字符并加省略号，避免 anchor 自身过长。
 * 行数反映输出体量级别（足够 LLM 评估命令产出规模）。
 */
const COMMAND_PREVIEW_MAX = 80;

export const bashAnchor: AnchorGenerator = {
  toolName: "bash",
  generate(toolUse, toolResult) {
    const command = toolUse.input.command;
    if (typeof command !== "string" || command.length === 0) return null;
    const preview = truncateCommand(command);
    const status = toolResult.isError ? "error" : "ok";
    const lineCount = toolResult.content.split("\n").length;
    return `[bash "${preview}", ${status}, ${lineCount} lines]`;
  },
};

function truncateCommand(cmd: string): string {
  // 单行化（去换行）+ 长度截断 —— 避免 anchor 文本被命令换行污染
  const flattened = cmd.replace(/\s+/g, " ").trim();
  if (flattened.length <= COMMAND_PREVIEW_MAX) return flattened;
  return `${flattened.slice(0, COMMAND_PREVIEW_MAX)}…`;
}
