/**
 * Provider 包内部共用的文件 IO 与合并工具。
 *
 * 这些是 writer（writeConfig / writeCredentials）共享的纯工具：
 *   - 原子写：唯一 tmp + wx flag + leak-proof 清理
 *   - id 级 + 字段级合并：与 reader 的 deepMergeConfig 行为对偶
 *
 * 故意不在 index.ts 导出——provider 包外部不应依赖这些 helper，未来重构
 * （提到独立 io 包、换实现等）零外部成本。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * 原子写 JSON：写到同目录唯一临时文件后 rename。
 *
 * 三层防护：
 *   1. **唯一 tmp 命名**：`crypto.randomBytes(8)` 64-bit entropy 让并发 caller
 *      拿到不同 tmp 文件名，不会互相覆盖
 *   2. **flag: "wx"**：fail-fast if exists——belt-and-suspenders 防御 random 极端
 *      碰撞或文件系统快照导致的同名残留
 *   3. **try/finally cleanup**：rename 失败时（EBUSY / 跨设备 / 权限等）显式
 *      unlink tmp，避免目录残留 .tmp 垃圾
 *
 * 同目录 rename 在主流文件系统（NTFS / ext4 / APFS）是原子操作——
 * 进程崩溃或中断不会留半截损坏文件。
 */
export async function writeJsonAtomic(
  filePath: string,
  data: unknown,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });

  const suffix = crypto.randomBytes(8).toString("hex");
  const tmp = `${filePath}.${suffix}.tmp`;

  let renamed = false;
  try {
    await fs.promises.writeFile(
      tmp,
      JSON.stringify(data, null, 2) + "\n",
      { encoding: "utf-8", flag: "wx" },
    );
    await fs.promises.rename(tmp, filePath);
    renamed = true;
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
 * 通用 id 级 + 字段级合并。
 *
 * 语义：
 *   - 同 id 字段级 spread（不丢现有字段）
 *   - patch 新增 id 直接放入
 *   - current 有但 patch 没提的 id 保留
 *
 * 与 reader 端 deepMergeConfig 在 providers / channels 上的合并行为对偶——
 * writer 视角下 "current 文件 + patch" 等同于 reader 视角下 "全局 + 项目" 的
 * id 级合并，让两端对同一份文件的看法一致。
 *
 * 删除单个 id 的语义不在此函数内（patch 不包含 = 保留 current 而非删除）；
 * 显式删除由未来的 removeXxx API 承载。
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
