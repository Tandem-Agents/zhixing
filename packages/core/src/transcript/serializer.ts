/**
 * 持久化文件写入原语 —— 原子替换与崩溃残留清理。
 *
 * 记录行的解析 / 追加由分片 store 自持（shard/store.ts）；本文件只留与
 * 具体记录格式无关的文件系统原语，供索引原子重写等共用。
 */

import fs from "node:fs/promises";
import path from "node:path";

// ─── 原子写入 ───

/**
 * 原子替换文件内容 —— 写 tmp + rename 的经典模式。
 *
 * 失败模型：
 *   - 写 tmp 失败 → 抛错，原文件不变
 *   - rename 失败 → 抛错，tmp 文件留存（orphan），原文件不变
 *   - 成功 → 原文件被 tmp 完全替代
 *
 * 平台差异：
 *   - POSIX (linux/darwin)：`rename(2)` 原子覆盖，一次调用搞定
 *   - Windows：默认走 fallback —— `unlink old → rename tmp`，避免 MoveFileExW 的
 *     边缘场景（共享驱动器、WSL、旧版 NTFS）破坏原子假设。unlink 与 rename
 *     之间存在"旧已删、新未就位"的崩溃微窗口——但该窗口内的形态是确定的：
 *     unlink 只发生在 tmp 完整落盘之后，故"目标缺失 + tmp 存在"时 tmp 必为
 *     完整新内容，`recoverOrphanTmp` 在下次打开时把它 rename 回目标——
 *     原子替换的承诺跨崩溃成立。
 *
 * DI：`platform` 参数供测试锚定。不传时默认 `process.platform`。
 */
export interface WriteAtomicOptions {
  /** 平台 DI，默认 `process.platform` */
  readonly platform?: NodeJS.Platform;
}

export async function writeAtomic(
  filePath: string,
  content: string | Uint8Array,
  opts?: WriteAtomicOptions,
): Promise<void> {
  const platform = opts?.platform ?? process.platform;
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const tmp = tmpPathFor(filePath);
  // string 默认按 utf-8 写;Uint8Array / Buffer 原样写 —— 二进制安全
  // (技能附属文件需逐字节保真,与 Agent Skills 生态兼容)。
  await fs.writeFile(tmp, content);

  if (platform === "win32") {
    // Windows fallback：先 unlink，再 rename
    try {
      await fs.unlink(filePath);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        // unlink 失败（非"文件不存在"）→ 清理 tmp 后抛错
        await fs.unlink(tmp).catch(() => {});
        throw e;
      }
    }
    try {
      await fs.rename(tmp, filePath);
    } catch (e) {
      await fs.unlink(tmp).catch(() => {});
      throw e;
    }
  } else {
    // POSIX：rename 原子覆盖
    try {
      await fs.rename(tmp, filePath);
    } catch (e) {
      await fs.unlink(tmp).catch(() => {});
      throw e;
    }
  }
}

/**
 * 收尾目标文件的崩溃残留 tmp —— 能恢复则先恢复，其余清理。
 *
 * 恢复判据（与 writeAtomic 的写序构成闭环）：目标文件不存在且存在 tmp，
 * 只可能是 Windows 替换窗口（unlink 旧文件 → rename tmp）内崩溃——而
 * unlink 只发生在 tmp 完整写盘之后，故此形态下 tmp 必为完整新内容 →
 * 取最新一个 rename 回目标。目标文件存在时，全部 tmp 都是 rename 失败 /
 * 多写竞争的残留 → 直接清理。
 *
 * 只扫 `${basename}.*.tmp` 模式 —— 不会误删用户的其他 .tmp 文件。
 * 失败静默（权限、目录不存在等）—— 收尾是 best-effort，不阻塞主流程；
 * 恢复 rename 失败时保留该 tmp（不销毁恢复素材），留待下次收尾重试。
 */
export async function recoverOrphanTmp(targetFilePath: string): Promise<void> {
  const dir = path.dirname(targetFilePath);
  const prefix = `${path.basename(targetFilePath)}.`;

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  const tmps = entries.filter(
    (e) => e.startsWith(prefix) && e.endsWith(".tmp"),
  );
  if (tmps.length === 0) return;

  let toDelete = tmps;
  const targetExists = await fs.access(targetFilePath).then(
    () => true,
    () => false,
  );
  if (!targetExists) {
    // 多个 tmp（多次崩溃叠加）按文件名内嵌时间戳取最新的恢复
    const newest = [...tmps].sort(
      (a, b) => tmpTimestampOf(b, prefix) - tmpTimestampOf(a, prefix),
    )[0]!;
    await fs.rename(path.join(dir, newest), targetFilePath).catch(() => {});
    toDelete = tmps.filter((e) => e !== newest);
  }

  await Promise.all(
    toDelete.map((e) => fs.unlink(path.join(dir, e)).catch(() => {})),
  );
}

/** 解析 tmp 文件名内嵌的毫秒时间戳（`{pid}-{ts}-{rand}` 中段）；不可解析按 0 */
function tmpTimestampOf(entry: string, prefix: string): number {
  const core = entry.slice(prefix.length, -".tmp".length);
  const ts = Number(core.split("-")[1]);
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * 生成唯一的 tmp 文件名。格式：`{targetPath}.{pid}-{ts}-{rand}.tmp`。
 *
 * pid + 毫秒时间戳 + 随机后缀三重保证并发写不碰撞。
 */
function tmpPathFor(filePath: string): string {
  const uniq = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${filePath}.${uniq}.tmp`;
}
