import { describe, expect, it, vi } from "vitest";
import { createAnchorWorksceneManagementPorts } from "./workscene-management-adapter.js";

describe("createAnchorWorksceneManagementPorts", () => {
  it("only maps the finite Workscene mechanism and Workspace Administration read port", async () => {
    const scene = {
      id: "scene-1",
      revision: 2,
      name: "场景",
      createdAt: "2026-08-31T00:00:00.000Z",
      lastActiveAt: "2026-08-31T01:00:00.000Z",
    };
    const directory = {
      list: vi.fn(async () => [scene]),
      create: vi.fn(async () => ({ scene })),
      rename: vi.fn(async () => scene),
      setWorkdir: vi.fn(async () => ({ scene })),
      remove: vi.fn(async () => true),
      workspaceCatalog: vi.fn(async () => [
        {
          deviceId: "device-a",
          deviceName: "本机",
          bindingRef: "binding-a",
          workspaceBindingRevision: 3,
          workspaceName: "代码库",
        },
      ]),
    };
    const ports = createAnchorWorksceneManagementPorts(directory);

    await expect(ports.management.list()).resolves.toEqual([scene]);
    await ports.management.rename({
      sceneId: "scene-1",
      name: "新名",
      requestId: "rename:1",
    });
    expect(directory.rename).toHaveBeenCalledWith(
      "scene-1",
      "新名",
      "rename:1",
    );
    await ports.management.setWorkspace({
      sceneId: "scene-1",
      workspace: null,
      requestId: "workspace:1",
    });
    expect(directory.setWorkdir).toHaveBeenCalledWith(
      "scene-1",
      null,
      "workspace:1",
    );
    await expect(ports.workspaces.list()).resolves.toEqual([
      {
        deviceId: "device-a",
        deviceName: "本机",
        bindingRef: "binding-a",
        workspaceBindingRevision: 3,
        workspaceName: "代码库",
      },
    ]);
  });
});
