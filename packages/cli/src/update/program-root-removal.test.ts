import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { scheduleProgramRootRemoval } from "./program-root-removal.js";

describe("program root removal handoff", () => {
  it("returns after the real platform helper starts without claiming deletion completed", async () => {
    const root = await createTempDir("program-root-removal");
    await mkdir(path.join(root, "versions", "current"), { recursive: true });

    await scheduleProgramRootRemoval(root);

    await expect(stat(root)).resolves.toBeDefined();
  }, 10_000);

  it("rejects a real OS spawn failure instead of claiming acceptance", async () => {
    const root = await createTempDir("program-root-removal-error");
    const missing = path.join(root, "missing-helper");

    await expect(scheduleProgramRootRemoval(
      root,
      () => spawn(missing, [], { detached: true, stdio: "ignore" }),
    )).rejects.toBeInstanceOf(Error);
    await expect(stat(root)).resolves.toBeDefined();
  });
});
