import { lstat } from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { ensureDurableDirectory } from "../durable-directory.js";

describe("durable directory", () => {
  it("creates and validates every missing directory level", async () => {
    const root = await createTempDir("durable-directory");
    const target = path.join(root, "authority", "artifacts", "sha256");

    await ensureDurableDirectory(target);
    await ensureDurableDirectory(target);

    for (const directory of [
      path.join(root, "authority"),
      path.join(root, "authority", "artifacts"),
      target,
    ]) {
      const metadata = await lstat(directory);
      expect(metadata.isDirectory()).toBe(true);
      expect(metadata.isSymbolicLink()).toBe(false);
    }
  });
});
