import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { resolveSystemProtectedSecretPaths } from "../secret-boundary.js";

describe("resolveSystemProtectedSecretPaths", () => {
  it("跟随 ZHIXING_CONFIG_PATH 的实际目录并覆盖旧明文与完整 vault 文件族", async () => {
    const configHome = await createTempDir("secret-boundary-config");
    const unrelatedHome = await createTempDir("secret-boundary-home");
    const configPath = path.join(configHome, "custom-config.jsonc");

    expect(
      resolveSystemProtectedSecretPaths({
        ZHIXING_CONFIG_PATH: configPath,
        ZHIXING_HOME: unrelatedHome,
      }),
    ).toEqual([
      path.join(configHome, "credentials.json"),
      path.join(configHome, "secret-vault"),
    ]);
  });
});
