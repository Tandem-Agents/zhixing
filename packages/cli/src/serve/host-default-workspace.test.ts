import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ZhixingConfig } from "@zhixing/providers";
import { createHostDefaultWorkspaceProjection } from "./host-default-workspace.js";

describe("Host default workspace projection", () => {
  it("projects one configured workspace to both host consumers", () => {
    const root = path.resolve("host-default-workspace");
    const projection = createHostDefaultWorkspaceProjection({
      workspace: { root },
    } as ZhixingConfig, "ci");

    expect(projection).toEqual({
      postAdoptionReviewWorkingDirectory: root,
      hostInfoWorkspace: root,
    });
    expect(Object.isFrozen(projection)).toBe(true);
  });

  it("keeps the existing no-workspace host projections in a non-interactive session", () => {
    const projection = createHostDefaultWorkspaceProjection(
      {} as ZhixingConfig,
      "ci",
    );

    expect(projection).toEqual({
      postAdoptionReviewWorkingDirectory: process.cwd(),
      hostInfoWorkspace: undefined,
    });
  });
});
