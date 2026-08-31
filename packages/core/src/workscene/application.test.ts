import { describe, expect, it, vi } from "vitest";
import { ProductApiDispatcher } from "../product-api/catalog.js";
import type { WorksceneDto } from "../contracts/state.js";
import {
  createWorksceneProductApiContribution,
  WORKSCENE_ENTRY_ENTER_COMMAND,
  WORKSCENE_ENTRY_EXIT_COMMAND,
  WORKSCENE_MANAGEMENT_CREATE_COMMAND,
  WORKSCENE_MANAGEMENT_LIST_QUERY,
  WORKSCENE_PRODUCT_API_EXACT_SET,
  WorksceneApplicationError,
  WorksceneApplicationService,
  type WorksceneEntryPort,
  type WorksceneManagementPort,
  type WorksceneRuntimeProjectionReadPort,
  type WorksceneWorkspaceAdministrationReadPort,
} from "./application.js";

function scene(
  id: string,
  overrides: Partial<WorksceneDto> = {},
): WorksceneDto {
  return {
    id,
    revision: 1,
    name: id,
    createdAt: "2026-08-31T00:00:00.000Z",
    lastActiveAt: "2026-08-31T01:00:00.000Z",
    ...overrides,
  };
}

function fixture(overrides: Partial<WorksceneManagementPort> = {}) {
  const scenes = new Map<string, WorksceneDto>([
    [
      "scene-a",
      scene("scene-a", {
        name: "场景 A",
        workspace: { deviceId: "device-a", bindingRef: "binding-a" },
      }),
    ],
  ]);
  const management: WorksceneManagementPort = {
    list: vi.fn(async () => [...scenes.values()]),
    create: vi.fn(async (input) => {
      const created = scene("scene-created", {
        name: input.name,
        ...(input.workspace ? { workspace: input.workspace } : {}),
      });
      scenes.set(created.id, created);
      return { scene: created, workspaceWarning: "probe pending" };
    }),
    rename: vi.fn(async (input) => {
      const current = scenes.get(input.sceneId);
      if (!current) return null;
      const renamed = { ...current, revision: current.revision + 1, name: input.name };
      scenes.set(input.sceneId, renamed);
      return renamed;
    }),
    setWorkspace: vi.fn(async (input) => {
      const current = scenes.get(input.sceneId);
      if (!current) return null;
      const changed: WorksceneDto = {
        ...current,
        revision: current.revision + 1,
        ...(input.workspace ? { workspace: input.workspace } : { workspace: undefined }),
      };
      scenes.set(input.sceneId, changed);
      return { scene: changed };
    }),
    delete: vi.fn(async (input) => scenes.delete(input.sceneId)),
    ...overrides,
  };
  const workspaces: WorksceneWorkspaceAdministrationReadPort = {
    list: vi.fn(async () => [
      {
        deviceId: "device-a",
        bindingRef: "binding-a",
        workspaceBindingRevision: 7,
        deviceName: "本机",
        workspaceName: "代码库",
      },
    ]),
  };
  const entry: WorksceneEntryPort = {
    enter: vi.fn(async (input) => {
      const current = scenes.get(input.sceneId);
      return current
        ? { conversationId: `ws:${input.sceneId}:conv_main`, scene: current }
        : null;
    }),
    exit: vi.fn(async () => {}),
  };
  const runtime: WorksceneRuntimeProjectionReadPort = {
    get: vi.fn(async (sceneId) => scenes.get(sceneId) ?? null),
  };
  const application = new WorksceneApplicationService(
    management,
    workspaces,
    entry,
    runtime,
  );
  return { application, management, workspaces, entry, runtime, scenes };
}

describe("WorksceneApplicationService", () => {
  it("owns finite frozen conversation runtime routing without infrastructure details", async () => {
    const f = fixture();

    await expect(f.application.projectConversationRuntime({
      conversationId: "conversation-main",
    })).resolves.toEqual({ kind: "main" });
    const projected = await f.application.projectConversationRuntime({
      conversationId: "ws:scene-a:conversation-1",
    });
    expect(projected).toEqual({
      kind: "scene",
      scene: { sceneId: "scene-a", name: "场景 A" },
      workspace: { deviceId: "device-a", bindingRef: "binding-a" },
    });
    expect(Object.isFrozen(projected)).toBe(true);
    if (projected.kind === "scene") {
      expect(Object.isFrozen(projected.scene)).toBe(true);
      expect(Object.isFrozen(projected.workspace)).toBe(true);
    }
    expect(f.runtime.get).toHaveBeenCalledTimes(1);
  });

  it("fails closed for invalid or missing runtime projection input and rereads current authority", async () => {
    const f = fixture();
    await expect(f.application.projectConversationRuntime({} as never)).rejects
      .toMatchObject({ kind: "invalid-input" });
    await expect(f.application.projectConversationRuntime({
      conversationId: "ws:missing:conversation-1",
    })).rejects.toMatchObject({
      kind: "not-found",
      message: '工作场景 "missing" 不存在,无法装配会话',
    });

    f.scenes.set("scene-a", scene("scene-a", { name: "更新后" }));
    await expect(f.application.projectConversationRuntime({
      conversationId: "ws:scene-a:conversation-1",
    })).resolves.toMatchObject({ scene: { name: "更新后" }, workspace: null });
  });

  it("owns the stable list projection and Workspace Administration enrichment", async () => {
    const f = fixture();
    const result = await f.application.query({ kind: "list" });

    expect(result).toEqual({
      scenes: [
        {
          sceneId: "scene-a",
          revision: 1,
          name: "场景 A",
          workspace: {
            deviceId: "device-a",
            bindingRef: "binding-a",
            workspaceBindingRevision: 7,
            deviceName: "本机",
            workspaceName: "代码库",
          },
          lastActiveAt: "2026-08-31T01:00:00.000Z",
        },
      ],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.scenes)).toBe(true);
    expect(Object.isFrozen(result.scenes[0]?.workspace)).toBe(true);
  });

  it("normalizes names once and preserves request/workspace identity at the mechanism port", async () => {
    const f = fixture();
    const result = await f.application.execute({
      kind: "create",
      name: "  新场景  ",
      workspace: { deviceId: "device-a", bindingRef: "binding-a" },
      requestId: "surface:create:1",
    });

    expect(f.management.create).toHaveBeenCalledWith({
      name: "新场景",
      workspace: { deviceId: "device-a", bindingRef: "binding-a" },
      requestId: "surface:create:1",
    });
    expect(result).toMatchObject({
      kind: "created",
      scene: {
        sceneId: "scene-created",
        name: "新场景",
        workspaceWarning: "probe pending",
      },
    });
  });

  it("owns not-found/input/busy categories without swallowing mechanism failures", async () => {
    const missing = fixture();
    await expect(
      missing.application.execute({
        kind: "rename",
        sceneId: "missing",
        name: "新名",
        requestId: "rename:missing",
      }),
    ).rejects.toMatchObject({
      kind: "not-found",
      code: "WORKSCENE_NOT_FOUND",
      message: "Workscene not found: missing",
    });

    await expect(
      missing.application.execute({
        kind: "create",
        name: "   ",
        requestId: "create:invalid",
      }),
    ).rejects.toBeInstanceOf(WorksceneApplicationError);

    const busy = fixture({
      setWorkspace: async () => {
        throw Object.assign(new Error("scene busy"), { code: "WORKSCENE_BUSY" });
      },
    });
    await expect(
      busy.application.execute({
        kind: "set-workspace",
        sceneId: "scene-a",
        workspace: null,
        requestId: "set:busy",
      }),
    ).rejects.toMatchObject({ kind: "busy", code: "WORKSCENE_BUSY" });

    const failure = new Error("authority unavailable");
    const failed = fixture({ delete: async () => { throw failure; } });
    await expect(
      failed.application.execute({
        kind: "delete",
        sceneId: "scene-a",
        requestId: "delete:failed",
      }),
    ).rejects.toBe(failure);
    await expect(
      failed.application.execute({
        kind: "unknown",
        requestId: "unknown:1",
      } as never),
    ).rejects.toMatchObject({ kind: "invalid-input" });
  });

  it("owns enter/exit identity, terminal and stable scene projection", async () => {
    const f = fixture();
    const entered = await f.application.execute({
      kind: "enter",
      sceneId: "scene-a",
      observerId: "connection:7",
      requestId: "enter:7",
    });
    expect(f.entry.enter).toHaveBeenCalledWith({
      sceneId: "scene-a",
      observerId: "connection:7",
      requestId: "enter:7",
    });
    expect(entered).toMatchObject({
      kind: "entered",
      conversationId: "ws:scene-a:conv_main",
      scene: {
        sceneId: "scene-a",
        workspace: {
          workspaceBindingRevision: 7,
          deviceName: "本机",
          workspaceName: "代码库",
        },
      },
    });

    await expect(f.application.execute({
      kind: "enter",
      sceneId: "missing",
      observerId: "connection:7",
      requestId: "enter:missing",
    })).rejects.toMatchObject({ kind: "not-found" });
    await expect(f.application.execute({
      kind: "enter",
      sceneId: "scene-a",
      observerId: "",
      requestId: "enter:invalid",
    })).rejects.toMatchObject({ kind: "invalid-input" });

    await expect(f.application.execute({
      kind: "exit",
      sceneId: "scene-a",
      conversationId: "ws:scene-a:conv_main",
      observerId: "connection:7",
      requestId: "exit:7",
    })).resolves.toEqual({ kind: "exited", ok: true });
    expect(f.entry.exit).toHaveBeenCalledWith({
      sceneId: "scene-a",
      conversationId: "ws:scene-a:conv_main",
      observerId: "connection:7",
      requestId: "exit:7",
    });
  });

  it("contributes exactly one query and six commands with no invented Fact Event", async () => {
    const f = fixture();
    const dispatcher = new ProductApiDispatcher(
      WORKSCENE_PRODUCT_API_EXACT_SET,
      [createWorksceneProductApiContribution(f.application)],
    );

    expect(
      await dispatcher.query(WORKSCENE_MANAGEMENT_LIST_QUERY, { kind: "list" }),
    ).toHaveProperty("scenes", expect.any(Array));
    const result = await dispatcher.command(WORKSCENE_MANAGEMENT_CREATE_COMMAND, {
      kind: "create",
      name: "经 Product API 创建",
      requestId: "product-api:create",
    });
    expect(result.result.kind).toBe("created");
    expect(result.facts).toEqual([]);
    expect((await dispatcher.command(WORKSCENE_ENTRY_ENTER_COMMAND, {
      kind: "enter",
      sceneId: "scene-a",
      observerId: "connection:1",
      requestId: "product-api:enter",
    })).result.kind).toBe("entered");
    expect((await dispatcher.command(WORKSCENE_ENTRY_EXIT_COMMAND, {
      kind: "exit",
      sceneId: "scene-a",
      conversationId: "ws:scene-a:conv_main",
      observerId: "connection:1",
      requestId: "product-api:exit",
    })).result).toEqual({ kind: "exited", ok: true });
    expect(WORKSCENE_PRODUCT_API_EXACT_SET.factEvents).toEqual([]);
  });
});
