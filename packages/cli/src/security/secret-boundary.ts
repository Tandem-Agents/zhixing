import path from "node:path";
import { resolveHomeDir } from "@zhixing/providers";
import { getPlatformSecretStoreProtectedPaths } from "@zhixing/secrets";

/**
 * 解析当前进程实际使用的秘密文件族。路径来源与启动加载器相同，因此
 * ZHIXING_CONFIG_PATH、ZHIXING_HOME 和默认目录不会形成两套安全边界。
 */
export function resolveSystemProtectedSecretPaths(
  env: Record<string, string | undefined> = process.env,
): readonly string[] {
  const homeDir = resolveHomeDir(env);
  return [
    path.join(homeDir, "credentials.json"),
    ...getPlatformSecretStoreProtectedPaths(homeDir),
  ];
}
