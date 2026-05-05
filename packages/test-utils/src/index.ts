/**
 * 知行 monorepo 内部测试基础设施公共 API。
 *
 * 不发布，只被各 package 的 *.test.ts 通过 `@zhixing/test-utils` import。
 * 当前组件：
 *   - createTempDir: fail-safe 临时目录管理（自动清理，不可能漏 cleanup）
 */

export { createTempDir } from "./temp-dir.js";
