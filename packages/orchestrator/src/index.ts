/**
 * @zhixing/orchestrator 公共 API 入口。
 *
 * 同时提供两种导入风格,任选其一:
 *   - 顶级 barrel(本文件):适合一站式标准引入
 *       `import { createAgentRuntime, mainProfile } from "@zhixing/orchestrator"`
 *   - sub-path:适合细粒度 / tree-shake 友好
 *       `import { createAgentRuntime } from "@zhixing/orchestrator/runtime"`
 *       `import { mainProfile } from "@zhixing/orchestrator/profile"`
 *       `import { createSecureExecuteTool } from "@zhixing/orchestrator/security"`
 *
 * 三个 sub-path 子树的导出名空间不重叠 —— `export *` 安全且零维护成本
 * (新增导出无需在此处补行;若意外引入同名导出,TS 编译期立即报错)。
 */

export * from "./runtime/index.js";
export * from "./profile/index.js";
export * from "./security/index.js";
