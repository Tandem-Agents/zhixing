/**
 * Orchestrator 工具模块 —— 编排器入口型工具的归属。
 *
 * 区别于 `@zhixing/tools-builtin`(纯独立功能工具:read / write / bash 等),
 * 本子树只持有依赖编排器内部模块(runChildAgent / runContextStorage 等)的
 * 派生工具实现；纯 builtin 实现由 Host edge 经 Kernel Tool implementation port 注入。
 */

export {
  createTaskTool,
  formatChildResultAsToolResult,
  TASK_TOOL_CAPABILITY_DESCRIPTOR,
  TASK_INPUT_SCHEMA,
  TASK_TOOL_PROMPT,
  type TaskToolEnv,
} from "./task.js";
