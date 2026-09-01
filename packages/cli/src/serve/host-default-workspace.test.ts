import path from "node:path";
import { describe, expect, it } from "vitest";
import { createHostDefaultWorkspaceProjection } from "./host-default-workspace.js";
import { projectRuntimeConfiguration } from "../runtime/runtime-configuration-projections.js";
import { createRuntimeConfigurationSnapshot } from "../runtime/runtime-configuration-snapshot.js";

function workspaceConfiguration(
  configuration: Parameters<typeof createRuntimeConfigurationSnapshot>[0],
) {
  return projectRuntimeConfiguration(
    createRuntimeConfigurationSnapshot(configuration),
  ).workspace;
}

describe("Host default workspace projection", () => {
  it("projects one configured workspace to both host consumers", () => {
    const root = path.resolve("host-default-workspace");
    const projection = createHostDefaultWorkspaceProjection(
      workspaceConfiguration({ workspace: { root } }),
      "ci",
    );

    expect(projection).toEqual({
      postAdoptionReviewWorkingDirectory: root,
      hostInfoWorkspace: root,
    });
    expect(Object.isFrozen(projection)).toBe(true);
  });

  it("keeps the existing no-workspace host projections in a non-interactive session", () => {
    const projection = createHostDefaultWorkspaceProjection(
      workspaceConfiguration({}),
      "ci",
    );

    expect(projection).toEqual({
      postAdoptionReviewWorkingDirectory: process.cwd(),
      hostInfoWorkspace: undefined,
    });
  });
});
