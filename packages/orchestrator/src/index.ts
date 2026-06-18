/**
 * @zhixing/orchestrator 公共 API 入口。
 *
 * 同时提供两种导入风格,任选其一:
 *   - 顶级 barrel(本文件):适合一站式标准引入
 *       `import { createAgentRuntime, runChildAgent, createTaskTool } from "@zhixing/orchestrator"`
 *   - sub-path:适合细粒度 / tree-shake 友好
 *       `import { createAgentRuntime } from "@zhixing/orchestrator/runtime"`
 *       `import { mainProfile } from "@zhixing/orchestrator/profile"`
 *       `import { createSecureExecuteTool } from "@zhixing/orchestrator/security"`
 *       `import { runChildAgent } from "@zhixing/orchestrator/subagent"`
 *       `import { resolveSubAgentResolver } from "@zhixing/orchestrator/confirmation"`
 *       `import { createTaskTool } from "@zhixing/orchestrator/tools"`
 *
 * 各 sub-path 子树的导出名空间不重叠 —— `export *` 安全且零维护成本
 * (新增导出无需在此处补行;若意外引入同名导出,TS 编译期立即报错)。
 */

export * from "./runtime/index.js";
export * from "./profile/index.js";
export * from "./security/index.js";
export * from "./subagent/index.js";
export * from "./confirmation/index.js";
export * from "./tools/index.js";
