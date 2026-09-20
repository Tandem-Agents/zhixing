import path from "node:path";

import { getPlatformSecretStoreProtectedPaths } from "@zhixing/secrets";

/** 保护入口所选数据根中的秘密文件族；配置文件覆盖不改变 SecretStore 的归属。 */
export function resolveSystemProtectedSecretPaths(
  homeDir: string,
): readonly string[] {

  return [
    path.join(homeDir, "credentials.json"),
    path.join(homeDir, "extensions"),
    ...getPlatformSecretStoreProtectedPaths(homeDir),
  ];
}
