/**
 * Provider 包内部共用的文件 IO 与合并工具。
 *
 * 这些是 writer（writeConfig / writeCredentials）共享的纯工具：
 *   - 原子写：唯一 tmp + wx flag + leak-proof 清理
 *   - id 级 + 字段级合并：供 applyConfigPatch / applyCredentialsPatch 的 merge 模式复用
 *
 * 故意不在 index.ts 导出——provider 包外部不应依赖这些 helper，未来重构
 * （提到独立 io 包、换实现等）零外部成本。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ensureDurableDirectory, syncDirectory } from "@zhixing-ai/core/persistence";

async function renameAtomicWithWindowsRetry(
  source: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  const started = performance.now();
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    try {
      await fs.promises.rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      const remaining = 1_000 - (performance.now() - started);
      if (
        process.platform !== "win32" ||
        !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") ||
        remaining <= 0 ||
        attempt >= 10
      ) {
        throw error;
      }
      await delay(Math.min(remaining, 10 * 2 ** Math.min(attempt, 4)), undefined, {
        ...(signal ? { signal } : {}),
      });
    }
  }
}

/**
 * 耐久原子写原始字节：同步临时文件，再经原子替换落盘并同步父目录。
 *
 * 供 TUF 原始元数据字节（严禁重序列化）、隔离派生缓存与 JSON 配置共用：
 *   1. **唯一 tmp 命名**：`crypto.randomBytes(8)` 64-bit entropy 让并发 caller
 *      拿到不同 tmp 文件名，不会互相覆盖
 *   2. **flag: "wx"**：fail-fast if exists——防御极端碰撞或同名残留
 *   3. **Windows 友好原子替换**：经 `fs.promises.rename` 与 Windows 短时读锁重试完成原子替换
 *   4. **try/finally cleanup**：任一步骤失败均显式清理未提交 `.tmp` 文件
 */
export async function writeBytesAtomic(
  filePath: string,
  bytes: Uint8Array,
  options: { readonly mode?: number; readonly signal?: AbortSignal } = {},
): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDurableDirectory(dir);

  const suffix = crypto.randomBytes(8).toString("hex");
  const tmp = `${filePath}.${suffix}.tmp`;
  const mode = options.mode ?? 0o600;

  let renamed = false;
  try {
    options.signal?.throwIfAborted();
    const handle = await fs.promises.open(tmp, "wx", mode);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameAtomicWithWindowsRetry(tmp, filePath, options.signal);
    renamed = true;
    await syncDirectory(dir);
  } finally {
    if (!renamed) {
      try {
        await fs.promises.unlink(tmp);
      } catch {
        // tmp 可能不存在（writeFile 失败）或被清理过——ignore
      }
    }
  }
}

/**
 * 耐久原子写 JSON：复用 `writeBytesAtomic` 原语。
 */
export async function writeJsonAtomic(
  filePath: string,
  data: unknown,
): Promise<void> {
  const payload = Buffer.from(JSON.stringify(data, null, 2) + "\n", "utf8");
  await writeBytesAtomic(filePath, payload);
}

/**
 * 通用 id 级 + 字段级合并。
 *
 * 语义：
 *   - 同 id 字段级 spread（不丢现有字段）
 *   - patch 新增 id 直接放入
 *   - current 有但 patch 没提的 id 保留
 *
 * 供 applyConfigPatch / applyCredentialsPatch 的 merge 模式做"current 文件 + 部分
 * patch"的 id 级合并（同 id 字段级 spread、新增 id 放入、未提及 id 保留）。
 *
 * 删除单个 id 的语义不在此函数内（patch 不包含 = 保留 current 而非删除）；
 * 显式删除由编辑器的 replace 模式（省略即删除）承载。
 */
export function mergeIdMap<T extends object>(
  current: Record<string, T> | undefined,
  patch: Record<string, T>,
): Record<string, T> {
  const result: Record<string, T> = { ...current };
  for (const [id, fields] of Object.entries(patch)) {
    const existing = result[id];
    result[id] = existing ? { ...existing, ...fields } : fields;
  }
  return result;
}
