/**
 * 知行 monorepo 内部测试基础设施公共 API。
 *
 * 不发布，只被各 package 的 *.test.ts 通过 `@zhixing/test-utils` import。
 * 当前组件：
 *   - createTempDir: it-scope fail-safe 临时目录（onTestFinished 自动清理）
 *   - createDescribeTempDir: describe-scope 共享临时目录（afterAll 自动清理）
 */

export { createTempDir, createDescribeTempDir } from "./temp-dir.js";
export type { DescribeTempDir } from "./temp-dir.js";
