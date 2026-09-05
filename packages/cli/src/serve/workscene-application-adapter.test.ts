import { describe, expect, it, vi } from "vitest";
import {
  createAnchorWorksceneAdvancementApplicationPort,
  createAnchorWorksceneApplicationPorts,
  createAnchorWorksceneConversationStorageProjectionCleanup,
} from "./workscene-application-adapter.js";

describe("createAnchorWorksceneAdvancementApplicationPort", () => {
  it("maps the finite recovery, active-state and diagnostic demands", async () => {
    const projection = Object.freeze({
      advancementSessionId: "adv-scene-1",
      status: "active" as const,
    });
    const recovery = {
      recoverConversation: vi.fn(async () => ({ status: "recovered" })),
    };
    const activeState = {
      queryActiveState: vi.fn(async () => projection),
    };
    const logger = { error: vi.fn() };
    const port = createAnchorWorksceneAdvancementApplicationPort({
      recovery,
      activeState,
      logger,
    });

    await port.recoverConversation("ws:scene-1:conv_main");
    await expect(port.queryActiveState("ws:scene-1:conv_main")).resolves.toBe(
      projection,
    );
    const failure = new Error("recovery failed");
    port.reportFailure({
      conversationId: "ws:scene-1:conv_main",
      error: failure,
    });

    expect(recovery.recoverConversation).toHaveBeenCalledWith(
      "ws:scene-1:conv_main",
    );
    expect(activeState.queryActiveState).toHaveBeenCalledWith(
      "ws:scene-1:conv_main",
    );
    expect(logger.error).toHaveBeenCalledWith(
      "[workscene.enter] advancement recovery failed:",
      failure,
    );
    expect(Object.keys(port)).toEqual([
      "recoverConversation",
      "queryActiveState",
      "reportFailure",
    ]);
    expect(Object.isFrozen(port)).toBe(true);
  });
});

describe("createAnchorWorksceneApplicationPorts", () => {
  it("maps management, entry and Workspace Administration to finite ports", async () => {
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
      enterScene: vi.fn(async () => ({
        conversationId: "ws:scene-1:conv_main",
        scene,
      })),
      exitScene: vi.fn(async () => {}),
      get: vi.fn(async () => scene),
    };
    const ports = createAnchorWorksceneApplicationPorts(directory);

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

    await expect(ports.entry.enter({
      sceneId: "scene-1",
      observerId: "connection:1",
      requestId: "enter:1",
    })).resolves.toMatchObject({ conversationId: "ws:scene-1:conv_main" });
    expect(directory.enterScene).toHaveBeenCalledWith(
      "scene-1",
      "connection:1",
      { requestId: "enter:1" },
    );
    await ports.entry.exit({
      sceneId: "scene-1",
      conversationId: "ws:scene-1:conv_main",
      observerId: "connection:1",
      requestId: "exit:1",
    });
    expect(directory.exitScene).toHaveBeenCalledWith(
      "scene-1",
      "ws:scene-1:conv_main",
      "connection:1",
      "exit:1",
    );
    await expect(ports.runtime.get("scene-1")).resolves.toEqual(scene);
    expect(directory.get).toHaveBeenCalledWith("scene-1");
  });
});

describe("createAnchorWorksceneConversationStorageProjectionCleanup", () => {
  it("exposes only the committed physical projection and rejects another scope", async () => {
    const storage = {
      deleteStoredConversation: vi.fn(async () => true),
      deleteProductConversation: vi.fn(),
    };
    const cleanup = createAnchorWorksceneConversationStorageProjectionCleanup(
      storage,
    );

    await cleanup.removeCommittedProjection({
      sceneId: "scene-1",
      conversationId: "ws:scene-1:primary",
    });
    expect(storage.deleteStoredConversation).toHaveBeenCalledWith(
      "ws:scene-1:primary",
    );
    expect(Object.keys(cleanup)).toEqual(["removeCommittedProjection"]);
    expect(Object.isFrozen(cleanup)).toBe(true);

    await expect(cleanup.removeCommittedProjection({
      sceneId: "scene-1",
      conversationId: "ws:scene-2:primary",
    })).rejects.toMatchObject({ code: "WORKSCENE_INPUT" });
    await expect(cleanup.removeCommittedProjection({
      sceneId: "scene-1",
      conversationId: "ordinary-conversation",
    })).rejects.toMatchObject({ code: "WORKSCENE_INPUT" });
    expect(storage.deleteStoredConversation).toHaveBeenCalledTimes(1);
    expect(storage.deleteProductConversation).not.toHaveBeenCalled();
  });
});
