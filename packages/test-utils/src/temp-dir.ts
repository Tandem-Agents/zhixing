/**
 * Fail-safe 临时目录管理 —— 创建即注册自动清理，调用方拿到的只有目录路径。
 *
 * 设计原则：
 *   - 不可能忘 cleanup：API 接口面只返回 dir 字符串，cleanup 由 helper 内部
 *     通过 onTestFinished 注册到当前 test 生命周期；调用方没有"忘记调用"的机会
 *   - 不可能让 helper 自身 leak：onTestFinished 在错误上下文（beforeAll / 顶层）
 *     抛错时主动清理已创建的 dir，并把错误转为 user-friendly 提示
 *   - 偶发 cleanup 失败可见但不破坏 CI：Windows 文件锁等系统性问题靠
 *     console.warn 暴露给开发者，OS 临时目录回收策略兜底偶发遗留
 *
 * Prefix `zhixing-test-{label}-` 统一命名空间：
 *   - 与运行时数据 ~/.zhixing 清晰区分
 *   - 一刀清理友好（rm -rf $TEMP/zhixing-test-*）
 *
 * 不覆盖的场景：跨 test 共享 tmpDir（beforeAll 创建一次给所有 it 用）。
 * 那种场景应继续用经典 beforeAll + afterAll + fs.rm 写法 —— onTestFinished
 * 没有 beforeAll 上下文。
 */

import { onTestFinished } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LABEL_PATTERN = /^[a-z0-9-]+$/;
const PREFIX = "zhixing-test-";

/**
 * 创建测试用临时目录，测试结束后自动清理。
 *
 * @param label 子标识，必须小写 kebab 格式（[a-z0-9-]+），用于让 prefix 包含
 *              语义信息（如 "skill" / "outbox" / "scheduler"）。空白 / 大写 /
 *              下划线立即抛错。
 * @returns 新创建的临时目录绝对路径
 *
 * @throws 当 label 不符合 kebab 格式时
 * @throws 当在错误上下文（beforeAll / afterAll / describe 顶层）调用时——此时
 *         本函数会先主动清理已创建的目录再抛错，不会让 helper 自身造成 leak
 */
export async function createTempDir(label: string): Promise<string> {
  if (!LABEL_PATTERN.test(label)) {
    throw new Error(
      `createTempDir label 必须是小写 kebab 格式（[a-z0-9-]+），收到："${label}"`,
    );
  }

  const dir = await mkdtemp(join(tmpdir(), `${PREFIX}${label}-`));

  try {
    onTestFinished(async () => {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (err) {
        // cleanup 失败让开发者看到（系统性问题 vs 偶发失败），但不破坏测试通过状态
        // eslint-disable-next-line no-console
        console.warn(
          `[test-utils] 清理临时目录失败: ${dir} —— ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    });
  } catch (err) {
    // onTestFinished 在错误上下文（beforeAll / 顶层）抛错——主动清理已创建的
    // dir 避免 helper 自身造成 leak，同时把错误转为更明确的开发者提示
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error(
      "createTempDir 必须在 vitest 测试上下文内调用（it / test / beforeEach / afterEach），" +
        "不能在 beforeAll / afterAll / describe 顶层调用。" +
        "跨 test 共享临时目录的场景请用经典 beforeAll + afterAll + fs.rm 写法。",
      { cause: err },
    );
  }

  return dir;
}
