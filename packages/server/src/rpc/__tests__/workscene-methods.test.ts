/**
 * workscene.* RPC 方法契约 —— 管理面薄壳、enter 的取建语义、delete 的
 * active 守卫(场景有活跃会话时拒绝物理删除)。
 *
 * 宿主侧无场景状态机:方法是注册表 / 场景对话域的薄壳,handler 级直测
 * (不起 WS——session-rpc 已覆盖传输层)。
 */

import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import type { WorkScene } from "@zhixing/core";
import { AdvancementStore } from "../../../../core/src/advancement/store.js";
import { createTempDir } from "@zhixing/test-utils";
import { AdvancementController } from "@zhixing/owner-services";
import {
  buildWorksceneListMethod,
  buildWorksceneCreateMethod,
  buildWorksceneRenameMethod,
  buildWorksceneSetWorkdirMethod,
  buildWorksceneDeleteMethod,
  buildWorksceneEnterMethod,
  buildWorksceneExitMethod,
} from "../methods/workscene.js";
import { RPC_ERROR_CODES } from "../protocol.js";
import { WorksceneBusyError } from "@zhixing/owner-kernel";
import {
  ADVANCEMENT_ACTIVE_STATE_QUERY,
  AdvancementReviewAttemptApplicationService,
} from "@zhixing/core/advancement/application";
import {
  bindProductApiOperation,
  defineProductApiContribution,
  defineProductApiExactSet,
} from "@zhixing/core/product-api";
import {
  createWorksceneProductApiContribution,
  WORKSCENE_PRODUCT_API_EXACT_SET,
  WorksceneApplicationService,
} from "@zhixing/core/workscene/application";
import { ProductApiDispatcher } from "@zhixing/core/product-api";
import type { ServerContext } from "../../context.js";
import type { ConversationManager } from "@zhixing/owner-kernel";

type TestWorksceneMechanism = {
  readonly touched: string[];
  recover(): Promise<void>;
  list(): Promise<WorkScene[]>;
  get(id: string): Promise<WorkScene | null>;
  create(input: {
    name: string;
    workspace?: { deviceId: string; bindingRef: string };
    requestId: string;
  }): Promise<{ scene: WorkScene; workspaceWarning?: string }>;
  rename(id: string, name: string, requestId: string): Promise<WorkScene | null>;
  setWorkdir(
    id: string,
    workspace: { deviceId: string; bindingRef: string } | null,
    requestId: string,
  ): Promise<{ scene: WorkScene; workspaceWarning?: string } | null>;
  remove(id: string, requestId: string): Promise<boolean>;
  recordActivity(id: string, conversationId: string, at: string): Promise<void>;
  enterScene(
    sceneId: string,
    observerId: string,
    options?: { readonly requestId?: string },
  ): Promise<{ readonly conversationId: string; readonly scene: WorkScene } | null>;
  exitScene(
    sceneId: string,
    conversationId: string,
    observerId: string,
    requestId: string,
  ): Promise<void>;
  workspaceCatalog(): Promise<readonly {
    deviceId: string;
    deviceName: string;
    bindingRef: string;
    workspaceBindingRevision: number;
    workspaceName: string;
  }[]>;
};

function makeScene(id: string, name = id): WorkScene {
  return {
    id,
    revision: 1,
    name,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-01-01T00:00:00.000Z",
  } as WorkScene;
}

function inputError(message: string): Error {
  return Object.assign(new Error(message), {
    name: "WorksceneInputError",
    code: "WORKSCENE_INPUT",
  });
}

function memoryWorkscenes(): TestWorksceneMechanism {
  const scenes = new Map<string, WorkScene>();
  const touched: string[] = [];
  let next = 0;
  return {
    touched,
    async recover() {},
    async list() {
      return [...scenes.values()];
    },
    async get(id) {
      return scenes.get(id) ?? null;
    },
    async create(opts) {
      const scene = makeScene(`scene-${next++}`, opts.name);
      scenes.set(
        scene.id,
        {
          ...scene,
          ...(opts.workspace ? { workspace: opts.workspace } : {}),
        } as WorkScene,
      );
      return { scene: scenes.get(scene.id)! };
    },
    async rename(id, name) {
      const scene = scenes.get(id);
      if (!scene) return null;
      const renamed = { ...scene, name };
      scenes.set(id, renamed as WorkScene);
      return renamed as WorkScene;
    },
    async remove(id) {
      return scenes.delete(id);
    },
    async setWorkdir(id, workspace) {
      const scene = scenes.get(id);
      if (!scene) return null;
      const changed =
        workspace === null
          ? ({ ...scene, workspace: undefined } as WorkScene)
          : ({ ...scene, workspace } as WorkScene);
      scenes.set(id, changed);
      return { scene: changed };
    },
    async recordActivity(id, _conversationId, _at) {
      touched.push(id);
    },
    async workspaceCatalog() {
      return [];
    },
    async enterScene(sceneId) {
      const scene = scenes.get(sceneId);
      if (!scene) return null;
      touched.push(sceneId);
      return { conversationId: `ws:${sceneId}:conv_main`, scene };
    },
    async exitScene(sceneId) {
      touched.push(sceneId);
    },
  };
}

function makeCtx(opts: {
  workscenes?: TestWorksceneMechanism;
  activeConversations?: string[];
  advancement?: AdvancementController;
  advancementRecovery?: ServerContext["advancementRecovery"];
}) {
  const advancementActiveState = opts.advancement
    ? new AdvancementReviewAttemptApplicationService({
        state: {
          loadActiveSession: (conversationId: string) =>
            opts.advancement!.loadActiveSession(conversationId),
        } as never,
        roots: {} as never,
        mechanism: {} as never,
        reviewerAvailable: false,
      })
    : undefined;
  const advancementContribution = opts.advancement
    ? defineProductApiContribution({
        operations: [
          bindProductApiOperation(
            ADVANCEMENT_ACTIVE_STATE_QUERY,
            async (query) => ({
              result: await advancementActiveState!.queryActiveState(
                query.conversationId,
              ),
              facts: [],
            }),
          ),
        ],
        factEvents: [],
      })
    : undefined;
  const worksceneContribution = opts.workscenes
    ? createWorksceneProductApiContribution(
        new WorksceneApplicationService(
          {
            list: () => opts.workscenes!.list(),
            create: (input) => opts.workscenes!.create(input),
            rename: (input) =>
              opts.workscenes!.rename(
                input.sceneId,
                input.name,
                input.requestId,
              ),
            setWorkspace: (input) =>
              opts.workscenes!.setWorkdir(
                input.sceneId,
                input.workspace,
                input.requestId,
              ),
            delete: (input) =>
              opts.workscenes!.remove(input.sceneId, input.requestId),
          },
          {
            list: () => opts.workscenes!.workspaceCatalog(),
          },
          {
            enter: (input) =>
              opts.workscenes!.enterScene(
                input.sceneId,
                input.observerId,
                { requestId: input.requestId },
              ),
            exit: (input) =>
              opts.workscenes!.exitScene(
                input.sceneId,
                input.conversationId,
                input.observerId,
                input.requestId,
              ),
          },
          {
            get: (sceneId) => opts.workscenes!.get(sceneId),
          },
        ),
      )
    : undefined;
  const productApi = worksceneContribution
    ? new ProductApiDispatcher(
        defineProductApiExactSet({
          operations: [
            ...WORKSCENE_PRODUCT_API_EXACT_SET.operations,
            ...(advancementContribution ? [ADVANCEMENT_ACTIVE_STATE_QUERY] : []),
          ],
          factEvents: [...WORKSCENE_PRODUCT_API_EXACT_SET.factEvents],
        }),
        [
          worksceneContribution,
          ...(advancementContribution ? [advancementContribution] : []),
        ],
      )
    : undefined;
  const server = {
    productApi,
    advancementRecovery: opts.advancementRecovery,
    conversations: {
      list: () =>
        (opts.activeConversations ?? []).map((conversationId) => ({
          conversationId,
        })),
      addObserver: () => {},
    } as unknown as ConversationManager,
  } as unknown as ServerContext;
  return { server, connection: { id: 1 } } as never;
}

async function call(entry: { handler: (p: unknown, c: never) => unknown }, params: unknown, ctx: never) {
  return await entry.handler(params, ctx);
}

describe("workscene.* 方法", () => {
  it("全部七项 Workscene 行为只经同一 Product API，旧 Directory 桥归零", async () => {
    const source = await readFile(
      new URL("../methods/workscene.ts", import.meta.url),
      "utf8",
    );
    expect(source.match(/requireWorksceneApplication\(ctx\.server\)/gu)).toHaveLength(7);
    expect(source).not.toContain("requireWorkscenes");
    expect(source).not.toContain("sceneSummary(");
    expect(source).not.toContain("server.workscenes");
  });

  it("管理面全链:create → list → rename → delete;不存在 NOT_FOUND", async () => {
    const workscenes = memoryWorkscenes();
    const ctx = makeCtx({ workscenes });

    const created = (await call(buildWorksceneCreateMethod(), { name: "评审", requestId: "create-1" }, ctx)) as {
      sceneId: string;
      name: string;
    };
    await call(buildWorksceneCreateMethod(), { name: "评审副本", requestId: "create-2" }, ctx);
    expect(created.name).toBe("评审");

    const listed = (await call(buildWorksceneListMethod(), {}, ctx)) as {
      scenes: Array<{ sceneId: string; workdirWarning?: unknown }>;
    };
    expect(listed.scenes.map((s) => s.sceneId)).toContain(created.sceneId);
    expect(listed.scenes).toHaveLength(2);
    expect(listed.scenes.every((s) => !("workdirWarning" in s))).toBe(true);

    const renamed = (await call(
      buildWorksceneRenameMethod(),
      { sceneId: created.sceneId, name: "评审二", requestId: "rename-1" },
      ctx,
    )) as { name: string };
    expect(renamed.name).toBe("评审二");

    await call(buildWorksceneDeleteMethod(), { sceneId: created.sceneId, requestId: "delete-1" }, ctx);
    expect(await workscenes.get(created.sceneId)).toBeNull();

    await expect(
      call(buildWorksceneRenameMethod(), { sceneId: "ghost", name: "x", requestId: "rename-ghost" }, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.NOT_FOUND });
    await expect(
      call(buildWorksceneDeleteMethod(), { sceneId: "ghost", requestId: "delete-ghost" }, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.NOT_FOUND });
  });

  it("create 边界:拒绝 raw workdir 与非法 workspace;领域校验错误映射 INVALID_PARAMS", async () => {
    const workscenes = memoryWorkscenes();
    const ctx = makeCtx({ workscenes });

    await expect(
      call(
        buildWorksceneCreateMethod(),
        { name: "x", requestId: "raw-path", workdir: "D:\\secret" },
        ctx,
      ),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });

    const invalidWorkscenes = memoryWorkscenes();
    invalidWorkscenes.create = async () => {
      throw inputError("工作目录必须是绝对路径");
    };
    await expect(
      call(
        buildWorksceneCreateMethod(),
        {
          name: "x",
          requestId: "domain-invalid",
          workspace: { deviceId: "device-a", bindingRef: "binding-a" },
        },
        makeCtx({ workscenes: invalidWorkscenes }),
      ),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });

    const invalidRenameWorkscenes = memoryWorkscenes();
    invalidRenameWorkscenes.rename = async () => {
      throw inputError("工作场景名称不能为空");
    };
    await expect(
      call(
        buildWorksceneRenameMethod(),
        { sceneId: "scene-1", name: "   ", requestId: "rename-invalid" },
        makeCtx({ workscenes: invalidRenameWorkscenes }),
      ),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });

    const created = (await call(
      buildWorksceneCreateMethod(),
      {
        name: "任意字符串由领域服务校验",
        requestId: "create-workspace",
        workspace: { deviceId: "device-a", bindingRef: "binding-a" },
      },
      ctx,
    )) as { workspace?: { deviceId: string; bindingRef: string } };
    expect(created.workspace).toEqual({
      deviceId: "device-a",
      bindingRef: "binding-a",
    });
  });

  it("setWorkdir:缺参 invalidParams、null 解绑、not-found 与 BUSY 映射", async () => {
    const workscenes = memoryWorkscenes();
    const ctx = makeCtx({ workscenes });
    const created = (await call(buildWorksceneCreateMethod(), { name: "开发", requestId: "create-set" }, ctx)) as {
      sceneId: string;
    };

    await expect(
      call(buildWorksceneSetWorkdirMethod(), { sceneId: created.sceneId }, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
    await expect(
      call(
        buildWorksceneSetWorkdirMethod(),
        { sceneId: created.sceneId, requestId: "set-invalid", workdir: "D:\\secret" },
        ctx,
      ),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });

    const invalidWorkscenes = memoryWorkscenes();
    invalidWorkscenes.setWorkdir = async () => {
      throw inputError("工作目录不能为空");
    };
    await expect(
      call(
        buildWorksceneSetWorkdirMethod(),
        {
          sceneId: created.sceneId,
          requestId: "set-invalid-workspace",
          workspace: { deviceId: "device-a" },
        },
        makeCtx({ workscenes: invalidWorkscenes }),
      ),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });

    const bound = (await call(
      buildWorksceneSetWorkdirMethod(),
      {
        sceneId: created.sceneId,
        requestId: "set-bound",
        workspace: { deviceId: "device-a", bindingRef: "binding-a" },
      },
      ctx,
    )) as { workspace?: { deviceId: string; bindingRef: string } };
    expect(bound.workspace).toEqual({
      deviceId: "device-a",
      bindingRef: "binding-a",
    });

    const cleared = (await call(
      buildWorksceneSetWorkdirMethod(),
      { sceneId: created.sceneId, requestId: "set-clear", workspace: null },
      ctx,
    )) as { workspace?: unknown };
    expect(cleared.workspace).toBeUndefined();

    await expect(
      call(buildWorksceneSetWorkdirMethod(), { sceneId: "ghost", requestId: "set-ghost", workspace: null }, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.NOT_FOUND });

    const busyWorkscenes = memoryWorkscenes();
    busyWorkscenes.setWorkdir = async () => {
      throw new WorksceneBusyError("busy");
    };
    await expect(
      call(
        buildWorksceneSetWorkdirMethod(),
        { sceneId: created.sceneId, requestId: "set-busy", workspace: null },
        makeCtx({ workscenes: busyWorkscenes }),
      ),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.BUSY });
  });

  it("enter:返回全域键与场景元数据并 touch;场景不存在 NOT_FOUND", async () => {
    const workscenes = memoryWorkscenes();
    const enterSpy = vi.spyOn(workscenes, "enterScene");
    const ctx = makeCtx({ workscenes });
    const created = (await call(buildWorksceneCreateMethod(), { name: "开发", requestId: "create-enter" }, ctx)) as {
      sceneId: string;
    };

    const entered = (await call(
      buildWorksceneEnterMethod(),
      { sceneId: created.sceneId, requestId: "enter-main" },
      ctx,
    )) as { conversationId: string; scene: { sceneId: string; name: string } };
    expect(entered.conversationId).toBe(`ws:${created.sceneId}:conv_main`);
    expect(entered.scene.sceneId).toBe(created.sceneId);
    expect(workscenes.touched).toContain(created.sceneId);
    expect(enterSpy).toHaveBeenCalledWith(
      created.sceneId,
      "1",
      { requestId: "enter-main" },
    );

    await expect(
      call(
        buildWorksceneEnterMethod(),
        { sceneId: "ghost", requestId: "enter-ghost" },
        ctx,
      ),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.NOT_FOUND });
  });

  it("enter 携带场景对话的推进状态快照——打开场景即呈现待确认任务", async () => {
    const workscenes = memoryWorkscenes();
    const created = (await call(
      buildWorksceneCreateMethod(),
      { name: "推进场景", requestId: "create-advancement" },
      makeCtx({ workscenes }),
    )) as { sceneId: string };
    const conversationId = `ws:${created.sceneId}:conv_main`;

    const root = await createTempDir("workscene-advancement");
    const store = new AdvancementStore(`${root}/advancement`);
    await store.createSession({
      id: "adv-ws",
      conversationId,
      originalUserTask: { parts: [{ type: "text", text: "把场景任务做完" }] },
      pendingRubricDraft: {
        draftId: "draft-ws",
        originalTurnId: "turn-ws",
        source: "generated",
        candidateRubricIds: [],
        title: "场景任务验收",
        description: "验收场景任务。",
        content: {
          passCriteria: ["任务完成"],
          evidenceRequirements: [],
          failureHandling: [
            { id: "continue", scenario: "未完成", reply: "请继续。" },
          ],
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const ctx = makeCtx({
      workscenes,
      advancement: new AdvancementController({ store }),
    });

    const entered = (await call(
      buildWorksceneEnterMethod(),
      { sceneId: created.sceneId, requestId: "enter-advancement" },
      ctx,
    )) as {
      conversationId: string;
      advancement?: { status: string; pendingRubricDraft?: { draftId: string } };
    };
    expect(entered.advancement).toMatchObject({
      status: "awaiting-rubric-confirmation",
      advancementSessionId: "adv-ws",
      pendingRubricDraft: { draftId: "draft-ws" },
    });
  });

  it("enter 先由领域服务完成入场登记再恢复推进——恢复期事件对触发者可见", async () => {
    const workscenes = memoryWorkscenes();
    const created = (await call(
      buildWorksceneCreateMethod(),
      { name: "顺序场景", requestId: "create-order" },
      makeCtx({ workscenes }),
    )) as { sceneId: string };

    const calls: string[] = [];
    workscenes.enterScene = async (sceneId) => {
      calls.push("enterScene");
      return { conversationId: `ws:${sceneId}:conv_main`, scene: makeScene(sceneId) };
    };
    const ctx = makeCtx({
      workscenes,
      advancementRecovery: {
        recoverConversation: async () => {
          calls.push("recoverConversation");
          return { status: "no-pending-recovery" };
        },
      },
    });

    await call(
      buildWorksceneEnterMethod(),
      { sceneId: created.sceneId, requestId: "enter-order" },
      ctx,
    );

    expect(calls).toEqual(["enterScene", "recoverConversation"]);
  });

  it("enter 链外推进恢复失败不撤销入场结果", async () => {
    const workscenes = memoryWorkscenes();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const created = (await call(
      buildWorksceneCreateMethod(),
      { name: "恢复失败场景", requestId: "create-recovery-failure" },
      makeCtx({ workscenes }),
    )) as { sceneId: string };

    try {
      const entered = (await call(
        buildWorksceneEnterMethod(),
        { sceneId: created.sceneId, requestId: "enter-recovery-failure" },
        makeCtx({
          workscenes,
          advancementRecovery: {
            recoverConversation: async () => {
              throw new Error("recovery failed");
            },
          },
        }),
      )) as { conversationId: string; advancement?: unknown };

      expect(entered.conversationId).toBe(`ws:${created.sceneId}:conv_main`);
      expect(entered.advancement).toBeUndefined();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("exit:记录离开会话的场景活动(无其他副作用)", async () => {
    const workscenes = memoryWorkscenes();
    const exitSpy = vi.spyOn(workscenes, "exitScene");
    const ctx = makeCtx({ workscenes });
    const r = (await call(
      buildWorksceneExitMethod(),
      {
        sceneId: "s1",
        conversationId: "ws:s1:conv_main",
        requestId: "exit-s1",
      },
      ctx,
    )) as {
      ok: boolean;
    };
    expect(r.ok).toBe(true);
    expect(workscenes.touched).toEqual(["s1"]);
    expect(exitSpy).toHaveBeenCalledWith(
      "s1",
      "ws:s1:conv_main",
      "1",
      "exit-s1",
    );
    await expect(call(
      buildWorksceneExitMethod(),
      {
        sceneId: "s1",
        conversationId: "ws:other:conv_main",
        requestId: "exit-mismatch",
      },
      ctx,
    )).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it("delete 守卫由领域服务生效:BUSY 拒绝", async () => {
    const workscenes = memoryWorkscenes();
    const created = (await call(
      buildWorksceneCreateMethod(),
      { name: "忙场景", requestId: "create-busy" },
      makeCtx({ workscenes }),
    )) as { sceneId: string };

    workscenes.remove = async () => {
      throw new WorksceneBusyError("busy");
    };
    const busyCtx = makeCtx({ workscenes });
    await expect(
      call(
        buildWorksceneDeleteMethod(),
        { sceneId: created.sceneId, requestId: "delete-busy" },
        busyCtx,
      ),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.BUSY });
  });
});

