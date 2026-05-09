import type { AnchorGenerator } from "../types.js";

/**
 * edit 工具事实锚 —— 锚化文件编辑调用历史。
 *
 * 成功：`[edit <path>, ok]`
 * 失败：`[edit <path>, error]`
 */
export const editAnchor: AnchorGenerator = {
  toolName: "edit",
  generate(toolUse, toolResult) {
    const path = toolUse.input.path;
    if (typeof path !== "string" || path.length === 0) return null;
    const status = toolResult.isError ? "error" : "ok";
    return `[edit ${path}, ${status}]`;
  },
};
