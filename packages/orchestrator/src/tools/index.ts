/**
 * Orchestrator 工具模块 —— 编排器入口型工具的归属。
 *
 * 区别于 `@zhixing/tools-builtin`(纯独立功能工具:read / write / bash 等),
 * 本子树持有需要直接依赖编排器内部模块(runChildAgent / runContextStorage 等)
 * 的工具实现,保证依赖图严格 acyclic(orchestrator → tools-builtin,反向不行)。
 */

export {
  createTaskTool,
  formatChildResultAsToolResult,
  TASK_INPUT_SCHEMA,
  TASK_TOOL_PROMPT,
  type TaskToolEnv,
} from "./task.js";
