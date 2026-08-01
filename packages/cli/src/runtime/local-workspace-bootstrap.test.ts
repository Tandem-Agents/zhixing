import { stat } from "node:fs/promises";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import {
  acquireExecutorLocalWorkspaceOwner,
  defineLocalWorkspaceAssemblyIdentity,
} from "./local-workspace-bootstrap.js";
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

  it("makes executor ownership required and rejects it for non-executor roles", async () => {
    const home = await createTempDir("workspace-bootstrap-identity");
    const owner = await acquireLocalWorkspaceOwner(home);
    try {
      expect(defineLocalWorkspaceAssemblyIdentity(["executor"], owner)).toEqual({
        kind: "executor",
        lease: owner,
      });
      expect(() => defineLocalWorkspaceAssemblyIdentity(["anchor"], owner))
        .toThrow("non-executor");
      expect(() => defineLocalWorkspaceAssemblyIdentity(["executor"], undefined))
        .toThrow("did not acquire");
      expect(defineLocalWorkspaceAssemblyIdentity(["anchor"], undefined)).toEqual({
        kind: "non-executor",
      });
    } finally {
      await owner.release();
    }
  });
});
