import { describe, expect, it, vi } from "vitest";
import {
  createEventBus,
  getEnabledWorksceneToolActions,
  getWorksceneToolBoundaries,
  type AgentEventMap,
} from "@zhixing/core";
import type {
  AssignmentGlobalQueryPort,
  AssignmentMutationOverlayRecord,
  AssignmentMutationPort,
  AssignmentMutationRequest,
  GlobalReadResult,
  WorksceneDto,
} from "@zhixing/core/contracts";
import { runContextStorage } from "@zhixing/orchestrator/runtime";
import {
  createWorkmodeEnterTool,
  createWorkmodeExitTool,
  createWorksceneChangeApproveTool,
  createWorksceneClearWorkdirCurrentTool,
  createWorksceneListTool,
  createWorksceneRenameCurrentTool,
  createWorksceneSetWorkdirCurrentTool,
  type WorksceneToolDirectory,
} from "../../serve/workmode-tools.js";

const NOW = "2026-08-04T00:00:00.000Z";
const CTX = { toolCallId: "tool-call-1" } as never;

function scene(
  id: string,
  name: string,
  workspace?: { deviceId: string; bindingRef: string },
): WorksceneDto {
  return {
    id,
    revision: 1,
    name,
    ...(workspace ? { workspace } : {}),
    createdAt: NOW,
    lastActiveAt: NOW,
  };
}

function makeDirectory(
  overrides: Partial<WorksceneToolDirectory> = {},
): WorksceneToolDirectory {
  return {
    workspaceCatalog: vi.fn().mockResolvedValue([]),
    selectWorkspace: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as WorksceneToolDirectory;
}

interface RunFixture {
  readonly scenes?: readonly WorksceneDto[];
  readonly postTurnControl?: boolean;
  readonly overlays?: AssignmentMutationOverlayRecord[];
}

async function callInRun<T>(
  fn: () => Promise<T>,
  fixture: RunFixture = {},
): Promise<{
  result: T;
  emitted: unknown[];
  staged: AssignmentMutationOverlayRecord[];
  reads: string[];
}> {
  const bus = createEventBus<AgentEventMap>({ lineage: "main" });
  const emitted: unknown[] = [];
  const staged = fixture.overlays ?? [];
  const reads: string[] = [];
  bus.on("post_turn_control:requested", (intent) => emitted.push(intent));

  const mutations: AssignmentMutationPort = {
    assignmentId: "assignment-1",
    execution: "conversation",
    async stage(input: AssignmentMutationRequest) {
      const recordSeq = staged.length + 1;
      const mutationDigest = `mutation-digest-${recordSeq}`;
      const record: AssignmentMutationOverlayRecord = {
        recordSeq,
        domain: input.domain,
        mutation: input.mutation,
        requestId: input.operationId,
        mutationDigest,
      };
      staged.push(record);
      return {
        kind: "assignment-mutation-staged",
        requestId: record.requestId,
        recordSeq,
        mutationDigest,
      };
    },
    async readOverlay() {
      return staged;
    },
  };

  const query: AssignmentGlobalQueryPort = {
    async read(input): Promise<GlobalReadResult> {
      reads.push(input.kind);
      switch (input.kind) {
        case "workscene-get":
          return {
            kind: "workscene-get",
            scene:
              fixture.scenes?.find((candidate) => candidate.id === input.sceneId) ??
              null,
          };
        case "workscene-list":
          return { kind: "workscene-list", scenes: [...(fixture.scenes ?? [])] };
        default:
          throw new Error(`Unexpected query: ${input.kind}`);
      }
    },
  };

  const result = await runContextStorage.run(
    {
      bus,
      lineage: "main",
      conversationId: "conversation-1",
      assignmentIssuedAt: NOW,
      assignmentMutations: mutations,
      globalQuery: query,
      turnOrigin: {
        channel: "rpc",
        surface: {
          capabilities: {
            postTurnControl: fixture.postTurnControl !== false,
          },
        },
      },
    },
    fn,
  );
  return { result, emitted, staged, reads };
}

describe("workmode enter/exit", () => {
  it("enter 只读权威场景并 emit，缺少 consumer 时在查询前拒绝", async () => {
    const tool = createWorkmodeEnterTool(makeDirectory());
    const admitted = await callInRun(
      () => tool.call({ sceneId: "scene-1" }, CTX),
      { scenes: [scene("scene-1", "场景一")] },
    );
    expect(admitted.result.isError).toBeFalsy();
    expect(admitted.emitted).toEqual([{ kind: "enter", sceneId: "scene-1" }]);
    expect(admitted.reads).toContain("workscene-get");

    const unsupported = await callInRun(
      () => tool.call({ sceneId: "scene-1" }, CTX),
      { scenes: [scene("scene-1", "场景一")], postTurnControl: false },
    );
    expect(unsupported.result.isError).toBe(true);
    expect(unsupported.result.content).toContain("暂不支持");
    expect(unsupported.reads).toEqual([]);
    expect(unsupported.emitted).toEqual([]);
  });

  it("不存在场景不 emit；exit 仍是合法的 turn-boundary 控制", async () => {
    const missing = await callInRun(() =>
      createWorkmodeEnterTool(makeDirectory()).call({ sceneId: "missing" }, CTX),
    );
    expect(missing.result.isError).toBe(true);
    expect(missing.emitted).toEqual([]);

    const exited = await callInRun(() => createWorkmodeExitTool().call({}, CTX));
    expect(exited.result.isError).toBeFalsy();
    expect(exited.emitted).toEqual([{ kind: "exit" }]);
  });
});

describe("workscene staged management", () => {
  const current = { sceneId: "scene-1", sceneName: "旧场景名" };

  it("current rename/set/clear 只写 assignment overlay，不 emit 已应用意图", async () => {
    const directory = makeDirectory({
      selectWorkspace: vi.fn().mockResolvedValue({
        deviceId: "device-a",
        bindingRef: "binding-a",
      }),
    });
    const staged: AssignmentMutationOverlayRecord[] = [];
    const renamed = await callInRun(
      () =>
        createWorksceneRenameCurrentTool(current).call(
          { name: "新场景名" },
          { toolCallId: "rename-call" } as never,
        ),
      { scenes: [scene("scene-1", "旧场景名")], overlays: staged },
    );
    expect(renamed.result.content).toContain("本轮成功完成后生效");

    const set = await callInRun(
      () =>
        createWorksceneSetWorkdirCurrentTool(current, directory).call(
          { deviceName: "本机", workspaceName: "项目" },
          { toolCallId: "set-call" } as never,
        ),
      { scenes: [scene("scene-1", "旧场景名")], overlays: staged },
    );
    const cleared = await callInRun(
      () =>
        createWorksceneClearWorkdirCurrentTool(current).call(
          {},
          { toolCallId: "clear-call" } as never,
        ),
      { scenes: [scene("scene-1", "旧场景名")], overlays: staged },
    );

    expect(staged.map((record) => record.mutation.kind)).toEqual([
      "workscene-rename",
      "workscene-set-workdir",
      "workscene-set-workdir",
    ]);
    expect(staged.map((record) => record.recordSeq)).toEqual([1, 2, 3]);
    expect(set.emitted).toEqual([]);
    expect(cleared.emitted).toEqual([]);
    expect(set.result.content).not.toMatch(/已应用|已切换|已持久化/);
  });

  it("change_approve 五动作均暂存；同 run overlay 提供读己之写", async () => {
    const directory = makeDirectory({
      selectWorkspace: vi.fn().mockResolvedValue({
        deviceId: "device-a",
        bindingRef: "binding-a",
      }),
    });
    const tool = createWorksceneChangeApproveTool(directory);
    expect(tool.inputSchema.properties?.action?.enum).toEqual(
      getEnabledWorksceneToolActions("workscene_change_approve"),
    );
    const staged: AssignmentMutationOverlayRecord[] = [];
    const base = [scene("scene-1", "旧名称")];

    await callInRun(
      () =>
        tool.call(
          { action: "rename", sceneId: "scene-1", name: "新名称" },
          { toolCallId: "rename" } as never,
        ),
      { scenes: base, overlays: staged },
    );
    const removed = await callInRun(
      () =>
        tool.call(
          { action: "remove", sceneId: "scene-1" },
          { toolCallId: "remove" } as never,
        ),
      { scenes: base, overlays: staged },
    );
    expect(removed.result.isError).toBeFalsy();
    expect(staged[1]?.mutation).toMatchObject({
      kind: "workscene-delete",
      sceneId: "scene-1",
      expectedRevision: 2,
    });

    const separate: AssignmentMutationOverlayRecord[] = [];
    await callInRun(
      () =>
        tool.call(
          { action: "add", name: "新场景" },
          { toolCallId: "create" } as never,
        ),
      { overlays: separate },
    );
    await callInRun(
      () =>
        tool.call(
          {
            action: "set_workdir",
            sceneId: "scene-1",
            deviceName: "本机",
            workspaceName: "项目",
          },
          { toolCallId: "set" } as never,
        ),
      { scenes: base, overlays: separate },
    );
    await callInRun(
      () =>
        tool.call(
          { action: "clear_workdir", sceneId: "scene-1" },
          { toolCallId: "clear" } as never,
        ),
      { scenes: base, overlays: separate },
    );
    expect(separate.map((record) => record.mutation.kind)).toEqual([
      "workscene-create",
      "workscene-set-workdir",
      "workscene-set-workdir",
    ]);
  });

  it("缺耐久工具身份或 assignment 上下文时 fail closed", async () => {
    const tool = createWorksceneChangeApproveTool(makeDirectory());
    const noIdentity = await callInRun(() =>
      tool.call({ action: "add", name: "新场景" }, {} as never),
    );
    expect(noIdentity.result.isError).toBe(true);
    expect(noIdentity.staged).toEqual([]);

    await expect(tool.call({ action: "add", name: "新场景" }, CTX)).resolves
      .toMatchObject({ isError: true });
  });
});

describe("workscene path-free reads", () => {
  it("list 只返回产品名称，不泄漏 bindingRef 或路径", async () => {
    const directory = makeDirectory({
      workspaceCatalog: vi.fn().mockResolvedValue([
        {
          deviceId: "device-a",
          deviceName: "本机",
          bindingRef: "binding-secret",
          workspaceName: "项目",
          workspaceBindingRevision: 3,
        },
      ]),
    });
    const result = await callInRun(
      () => createWorksceneListTool(directory).call({}, CTX),
      {
        scenes: [
          scene("scene-a", "场景A", {
            deviceId: "device-a",
            bindingRef: "binding-secret",
          }),
          scene("scene-b", "场景B"),
        ],
      },
    );
    expect(result.result.content).toContain("工作区：本机 / 项目");
    expect(result.result.content).toContain("工作区：未绑定");
    expect(result.result.content).not.toContain("binding-secret");
    expect(result.result.content).not.toMatch(/[A-Z]:\\|\/tmp\//);
  });

  it("声明面仍由共享工具表派生", () => {
    const current = { sceneId: "scene-1", sceneName: "场景" };
    expect(createWorkmodeEnterTool(makeDirectory()).boundaries).toEqual(
      getWorksceneToolBoundaries("workmode_enter"),
    );
    expect(
      createWorksceneSetWorkdirCurrentTool(current, makeDirectory()).boundaries,
    ).toEqual(getWorksceneToolBoundaries("workscene_set_workdir_current"));
  });
});
