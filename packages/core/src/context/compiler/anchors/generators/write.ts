import type { AnchorGenerator } from "../types.js";

/**
 * write 工具事实锚 —— 锚化文件写入调用历史。
 *
 * 成功：`[write <path>, ok]`
 * 失败：`[write <path>, error]`
 */
export const writeAnchor: AnchorGenerator = {
  toolName: "write",
  generate(toolUse, toolResult) {
    const path = toolUse.input.path;
    if (typeof path !== "string" || path.length === 0) return null;
    const status = toolResult.isError ? "error" : "ok";
    return `[write ${path}, ${status}]`;
  },
};
