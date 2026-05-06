/**
 * Fail-safe 临时目录管理 —— 创建即注册自动清理，调用方拿到的只有目录路径。
 *
 * 两个对偶 API 覆盖测试期临时目录的全部 scope：
 *
 *   - `createTempDir(label)`           it-scope，单个测试专用，onTestFinished 自动清理
 *   - `createDescribeTempDir(label)`   describe-scope，跨多 test 共享，afterAll 自动清理
 *
 * 设计原则：
 *   - 不可能忘 cleanup：API 接口面不返回任何"需要 caller 调 cleanup"的对象，
 *     cleanup 全部走 vitest 生命周期 hook 注册；调用方没有"忘记调用"的机会
 *   - 不可能让 helper 自身 leak：错误上下文（如 createTempDir 在 beforeAll 调）
 *     抛错时主动清理已创建的 dir，并转为 user-friendly 错误
 *   - 偶发 cleanup 失败可见但不破坏 CI：Windows 文件锁等系统性问题靠
 *     console.warn 暴露给开发者，OS 临时目录回收策略兜底偶发遗留
 *
 * Prefix `zhixing-test-{label}-` 统一命名空间：
 *   - 与运行时数据 ~/.zhixing 清晰区分
 *   - 一刀清理友好（rm -rf $TEMP/zhixing-test-*）
 */

import { afterAll, beforeAll, onTestFinished } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LABEL_PATTERN = /^[a-z0-9-]+$/;
const PREFIX = "zhixing-test-";

function validateLabel(api: string, label: string): void {
  if (!LABEL_PATTERN.test(label)) {
    throw new Error(
      `${api} label 必须是小写 kebab 格式（[a-z0-9-]+），收到："${label}"`,
    );
  }
}

async function safeCleanup(dir: string): Promise<void> {
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
}

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
  validateLabel("createTempDir", label);

  const dir = await mkdtemp(join(tmpdir(), `${PREFIX}${label}-`));

  try {
    onTestFinished(() => safeCleanup(dir));
  } catch (err) {
    // onTestFinished 在错误上下文（beforeAll / 顶层）抛错——主动清理已创建的
    // dir 避免 helper 自身造成 leak，同时把错误转为更明确的开发者提示
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error(
      "createTempDir 必须在 vitest 测试上下文内调用（it / test / beforeEach / afterEach），" +
        "不能在 beforeAll / afterAll / describe 顶层调用。" +
        "跨 test 共享临时目录的场景请用 createDescribeTempDir。",
      { cause: err },
    );
  }

  return dir;
}

/**
 * describe-scope 句柄：跨多个 it 共享的临时目录访问器。
 *
 * 由 `createDescribeTempDir` 返回；调用 `getDir()` 拿到 beforeAll 创建的目录路径。
 * 在 beforeAll 跑完前调用（如 describe 顶层立即调）会抛 user-friendly 错误。
 */
export interface DescribeTempDir {
  /** 返回 beforeAll 创建的临时目录路径——必须在 it / test / beforeEach 内调用。 */
  getDir(): string;
}

/**
 * 在 describe scope 内创建跨 test 共享的临时目录，suite 结束后自动清理。
 *
 * 与 `createTempDir` 形成 it-scope / describe-scope 完整对偶：
 *   - `createTempDir(label)`         单 test 专用，每 test 独立 dir，onTestFinished 清理
 *   - `createDescribeTempDir(label)` 跨 test 共享，单一 dir，afterAll 清理
 *
 * 必须在 describe 块内**顶层**调用——helper 内部用 beforeAll / afterAll 注册
 * 创建与清理 hook，这两个 hook 只能在 describe scope 内合法注册。在 it 内、
 * 或 describe 之外调用，vitest 会抛 "hook outside scope" 错。
 *
 * @param label 子标识，必须小写 kebab 格式（[a-z0-9-]+），用于让 prefix 包含
 *              语义信息。空白 / 大写 / 下划线立即抛错。
 * @returns DescribeTempDir 句柄；getDir() 在 beforeAll 跑完前调（如 describe
 *          顶层立即调）会 throw user-friendly 错误。
 *
 * @throws 当 label 不符合 kebab 格式时
 */
export function createDescribeTempDir(label: string): DescribeTempDir {
  validateLabel("createDescribeTempDir", label);

  let dir: string | null = null;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), `${PREFIX}${label}-`));
  });

  afterAll(async () => {
    if (dir === null) return;
    const target = dir;
    dir = null;
    await safeCleanup(target);
  });

  return {
    getDir(): string {
      if (dir === null) {
        throw new Error(
          "createDescribeTempDir.getDir() 在 beforeAll 跑完前不可用——" +
            "确保在 it / test / beforeEach 内调用，不要在 describe 顶层立即调",
        );
      }
      return dir;
    },
  };
}
