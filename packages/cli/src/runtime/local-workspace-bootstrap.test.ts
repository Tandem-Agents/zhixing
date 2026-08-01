import { stat } from "node:fs/promises";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { acquireExecutorLocalWorkspaceOwner } from "./local-workspace-bootstrap.js";
import { acquireLocalWorkspaceOwner } from "./local-workspace-owner.js";

describe("local workspace role-gated bootstrap", () => {
  it("does not acquire or create owner state for an anchor-only topology", async () => {
    const home = await createTempDir("workspace-bootstrap-anchor");
    await expect(acquireExecutorLocalWorkspaceOwner(home, ["anchor"]))
      .resolves.toBeUndefined();
    await expect(stat(`${home}/runtime`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the canonical owner lock for every executor topology", async () => {
    const home = await createTempDir("workspace-bootstrap-executor");
    const roleOwner = await acquireExecutorLocalWorkspaceOwner(home, ["executor"]);
    expect(roleOwner).toBeDefined();
    await expect(acquireLocalWorkspaceOwner(home)).rejects.toThrow("busy");
    await roleOwner!.release();
    const successor = await acquireLocalWorkspaceOwner(home);
    await successor.release();
  });
});
