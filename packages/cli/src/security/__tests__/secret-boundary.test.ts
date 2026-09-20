import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import { resolveSystemProtectedSecretPaths } from "../secret-boundary.js";

describe("resolveSystemProtectedSecretPaths", () => {
  it("protects the selected data root, not a config override or later environment", async () => {
    const configHome = await createTempDir("secret-boundary-config");
    const unrelatedHome = await createTempDir("secret-boundary-home");
    const configPath = path.join(configHome, "custom-config.jsonc");

    vi.stubEnv("ZHIXING_HOME", configHome);
    vi.stubEnv("ZHIXING_CONFIG_PATH", configPath);
    try {
      expect(resolveSystemProtectedSecretPaths(unrelatedHome)).toEqual([
        path.join(unrelatedHome, "credentials.json"),
        path.join(unrelatedHome, "extensions", "artifacts"),
        path.join(unrelatedHome, "secret-vault"),
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
