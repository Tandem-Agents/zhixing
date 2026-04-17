/**
 * 共享 Token 管理
 *
 * Server 启动时生成（如不存在），路径默认 ~/.zhixing/server.token。
 * Token = 32 字节随机数的 hex 编码（64 字符）。
 *
 * 文件权限：0600（仅所有者可读写）。Windows 上 mode 参数被忽略，
 * 但路径本身在用户 home 下，权限继承用户目录的 ACL。
 */

import { randomBytes } from "node:crypto";
import { readFile, writeFile, chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_TOKEN_PATH = join(homedir(), ".zhixing", "server.token");

export async function loadOrCreateToken(tokenPath?: string): Promise<{
  token: string;
  path: string;
  generated: boolean;
}> {
  const path = tokenPath ?? DEFAULT_TOKEN_PATH;

  try {
    const existing = (await readFile(path, "utf-8")).trim();
    if (existing.length >= 32) {
      return { token: existing, path, generated: false };
    }
    // 内容损坏 → 重新生成
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw err;
    }
    // ENOENT → 生成
  }

  const token = randomBytes(32).toString("hex");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, token + "\n", "utf-8");
  try {
    await chmod(path, 0o600);
  } catch {
    // Windows 不支持 chmod 的 POSIX 权限位——忽略
  }
  return { token, path, generated: true };
}
