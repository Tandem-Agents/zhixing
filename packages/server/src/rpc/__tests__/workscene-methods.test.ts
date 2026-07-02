/**
 * workscene.* RPC 方法契约 —— 管理面薄壳、enter 的取建语义、delete 的
 * active 守卫(场景有活跃会话时拒绝物理删除)。
 *
 * 宿主侧无场景状态机:方法是注册表 / 场景对话域的薄壳,handler 级直测
 * (不起 WS——session-rpc 已覆盖传输层)。
 */

import { describe, expect, it } from "vitest";
import { AdvancementStore, type WorkScene } from "@zhixing/core";
import { createTempDir } from "@zhixing/test-utils";
import { AdvancementController } from "../../advancement/controller.js";
import {
  buildWorksceneListMethod,
  buildWorksceneCreateMethod,
  buildWorksceneRenameMethod,
  buildWorksceneDeleteMethod,
  buildWorksceneEnterMethod,
  buildWorksceneExitMethod,
} from "../methods/workscene.js";
import { RPC_ERROR_CODES } from "../protocol.js";
import type { WorksceneDirectory } from "../../runtime/workscene-directory.js";
import type { ServerContext } from "../../context.js";
import type { ConversationManager } from "../../runtime/conversation-manager.js";

function makeScene(id: string, name = id): WorkScene {
  return {
    id,
    name,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-01-01T00:00:00.000Z",
  } as WorkScene;
}

function memoryWorkscenes(): WorksceneDirectory & { touched: string[] } {
  const scenes = new Map<string, WorkScene>();
  const touched: string[] = [];
  let next = 0;
  return {
    touched,
    async list() {
      return [...scenes.values()];
    },
    async get(id) {
      return scenes.get(id) ?? null;
    },
    async create(opts) {
      const scene = makeScene(`scene-${next++}`, opts.name);
      scenes.set(scene.id, { ...scene, workdir: opts.workdir } as WorkScene);
      return scenes.get(scene.id)!;
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
    async touch(id) {
      touched.push(id);
    },
    async enterConversation(sceneId) {
      const scene = scenes.get(sceneId);
      if (!scene) return null;
      return { conversationId: `ws:${sceneId}:conv_main`, scene };
    },
  };
}

function makeCtx(opts: {
  workscenes?: WorksceneDirectory;
  activeConversations?: string[];
  advancement?: AdvancementController;
}) {
  const server = {
    workscenes: opts.workscenes,
    advancement: opts.advancement,
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
  it("管理面全链:create → list → rename → delete;不存在 NOT_FOUND", async () => {
    const workscenes = memoryWorkscenes();
    const ctx = makeCtx({ workscenes });

    const created = (await call(buildWorksceneCreateMethod(), { name: "评审" }, ctx)) as {
      sceneId: string;
      name: string;
    };
    expect(created.name).toBe("评审");

    const listed = (await call(buildWorksceneListMethod(), {}, ctx)) as {
      scenes: Array<{ sceneId: string }>;
    };
    expect(listed.scenes.map((s) => s.sceneId)).toContain(created.sceneId);

    const renamed = (await call(
      buildWorksceneRenameMethod(),
      { sceneId: created.sceneId, name: "评审二" },
      ctx,
    )) as { name: string };
    expect(renamed.name).toBe("评审二");

    await call(buildWorksceneDeleteMethod(), { sceneId: created.sceneId }, ctx);
    expect(await workscenes.get(created.sceneId)).toBeNull();

    await expect(
      call(buildWorksceneRenameMethod(), { sceneId: "ghost", name: "x" }, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.NOT_FOUND });
    await expect(
      call(buildWorksceneDeleteMethod(), { sceneId: "ghost" }, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.NOT_FOUND });
  });

  it("create 边界:相对 workdir 拒绝(远程调用方无'相对于宿主 cwd'语义),绝对路径通过", async () => {
    const workscenes = memoryWorkscenes();
    const ctx = makeCtx({ workscenes });

    await expect(
      call(buildWorksceneCreateMethod(), { name: "x", workdir: "rel/path" }, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
    await expect(
      call(buildWorksceneCreateMethod(), { name: "x", workdir: 42 }, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });

    const abs = process.platform === "win32" ? "C:\\proj" : "/proj";
    const created = (await call(
      buildWorksceneCreateMethod(),
      { name: "绝对", workdir: abs },
      ctx,
    )) as { workdir?: string };
    expect(created.workdir).toBe(abs);
  });

  it("enter:返回全域键与场景元数据并 touch;场景不存在 NOT_FOUND", async () => {
    const workscenes = memoryWorkscenes();
    const ctx = makeCtx({ workscenes });
    const created = (await call(buildWorksceneCreateMethod(), { name: "开发" }, ctx)) as {
      sceneId: string;
    };

    const entered = (await call(
      buildWorksceneEnterMethod(),
      { sceneId: created.sceneId },
      ctx,
    )) as { conversationId: string; scene: { sceneId: string; name: string } };
    expect(entered.conversationId).toBe(`ws:${created.sceneId}:conv_main`);
    expect(entered.scene.sceneId).toBe(created.sceneId);
    expect(workscenes.touched).toContain(created.sceneId);

    await expect(
      call(buildWorksceneEnterMethod(), { sceneId: "ghost" }, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.NOT_FOUND });
  });

  it("enter 携带场景对话的推进状态快照——打开场景即呈现待确认任务", async () => {
    const workscenes = memoryWorkscenes();
    const created = (await call(
      buildWorksceneCreateMethod(),
      { name: "推进场景" },
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
      { sceneId: created.sceneId },
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

  it("enter 先入组播名册再恢复推进——恢复期事件对触发者可见", async () => {
    const workscenes = memoryWorkscenes();
    const created = (await call(
      buildWorksceneCreateMethod(),
      { name: "顺序场景" },
      makeCtx({ workscenes }),
    )) as { sceneId: string };

    const calls: string[] = [];
    const server = {
      workscenes,
      conversations: {
        addObserver: () => calls.push("addObserver"),
      },
      advancementRecovery: {
        recoverConversation: async () => {
          calls.push("recoverConversation");
          return { status: "no-pending-recovery" };
        },
      },
    } as unknown as ServerContext;

    await call(
      buildWorksceneEnterMethod(),
      { sceneId: created.sceneId },
      { server, connection: { id: 1 } } as never,
    );

    expect(calls).toEqual(["addObserver", "recoverConversation"]);
  });

  it("exit:touch 场景(无其他副作用)", async () => {
    const workscenes = memoryWorkscenes();
    const ctx = makeCtx({ workscenes });
    const r = (await call(buildWorksceneExitMethod(), { sceneId: "s1" }, ctx)) as {
      ok: boolean;
    };
    expect(r.ok).toBe(true);
    expect(workscenes.touched).toEqual(["s1"]);
  });

  it("delete 守卫:场景有活跃会话(ws: 前缀命中)→ BUSY 拒绝", async () => {
    const workscenes = memoryWorkscenes();
    const created = (await call(
      buildWorksceneCreateMethod(),
      { name: "忙场景" },
      makeCtx({ workscenes }),
    )) as { sceneId: string };

    const busyCtx = makeCtx({
      workscenes,
      activeConversations: [`ws:${created.sceneId}:conv_main`],
    });
    await expect(
      call(buildWorksceneDeleteMethod(), { sceneId: created.sceneId }, busyCtx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.BUSY });
    // 场景未被删
    expect(await workscenes.get(created.sceneId)).not.toBeNull();
  });
});

