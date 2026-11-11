import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  CompletedWorkspaceAdministrationOperationError,
  type WorkspaceAdministrationConsumptionCredential,
} from "@zhixing-ai/core/environment/workspace-administration";
import {
  LocalWorkspaceHostNotWritableError,
  type LocalWorkspaceClient,
} from "./local-workspace-management-host.js";
import {
  createWorksceneAndReadWorkspaceView,
  describeRecoveredOperations,
  describeWorkspaceResult,
  localWorkspaceUserError,
  useLocalWorkspaceClient,
} from "./workspace-command.js";

it("Terminal workspace creation binds authorization and recovered receipts to its entry home", async () => {
  // Execute the actual terminal composition callback without booting the terminal or a Host.
  const source = ts.createSourceFile("application.ts",
    await readFile(new URL("../terminal/application.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest, true);
  let callback: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === "createWithLocalWorkspace") {
      callback = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(callback).toBeDefined();
  const home = "bound-terminal-home-a";
  const authorization = { deviceId: "device-a", bindingRef: "binding-a" };
  const create = vi.fn(async () => ({ sceneId: "created-scene" }));
  const facade = {};
  const withWorkspace = vi.fn(async (operation, delivery, actualHome) => {
    expect(actualHome).toBe(home);
    await delivery.recovered([{
      operation: "authorize", target: "recovered-scene", outcome: "succeeded",
      controlWorkspace: authorization, credential,
    }]);
    return delivery.result(await operation({
      authorizeForControl: async () => authorization,
    }), credential);
  });
  const callbackSource = callback!.getText(source);
  const moduleImport = /await import\('\.\.\/runtime\/workspace-command\.js'\)/gu;
  expect([...callbackSource.matchAll(moduleImport)]).toHaveLength(1);
  const emitted = ts.transpileModule(
    "class Entry { #workscene = worksceneFacade; #logging = undefined; home = entryHome; callback = " +
      callbackSource.replace(moduleImport, "workspaceModule") + "; } new Entry().callback;",
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const invoke = runInNewContext(emitted, {
    entryHome: home,
    current: () => undefined,
    workspaceModule: {
      withLocalWorkspaceClient: withWorkspace,
      createWorksceneFromLocalWorkspaceAuthorization: create,
    },
    worksceneFacade: facade,
  });
  vi.stubEnv("ZHIXING_HOME", "unrelated-home-b");
  try {
    await invoke("new-scene", "/workspace");
    expect(withWorkspace).toHaveBeenCalledOnce();
    expect(create).toHaveBeenNthCalledWith(1, facade, "recovered-scene", authorization, credential);
    expect(create).toHaveBeenNthCalledWith(2, facade, "new-scene", authorization, credential);
  } finally {
    vi.unstubAllEnvs();
  }
});

const credential: WorkspaceAdministrationConsumptionCredential = {
  outboxId: "outbox-a",
  localSeq: 1,
  operationId: "workspace-operation-a",
  inputDigest: "sha256:input",
  resultDigest: "sha256:result",
};

function client(confirmDelivered: () => Promise<void>): LocalWorkspaceClient {
  return {
    status: vi.fn(),
    list: vi.fn(),
    viewByName: vi.fn(),
    create: vi.fn(),
    authorizeForControl: vi.fn(),
    rename: vi.fn(),
    repath: vi.fn(),
    remove: vi.fn(),
    previewReset: vi.fn(),
    confirmReset: vi.fn(),
    consumptionCredential: () => credential,
    confirmDelivered,
  };
}

describe("useLocalWorkspaceClient", () => {
  it("confirms a completed business failure only after its delivery callback succeeds", async () => {
    const order: string[] = [];
    const failure = new CompletedWorkspaceAdministrationOperationError(
      "WORKSPACE_POLICY_REJECTED",
      "rejected by policy",
    );
    await expect(
      useLocalWorkspaceClient(
        client(async () => {
          order.push("confirmed");
        }),
        async () => {
          throw failure;
        },
        {
          result: vi.fn(),
          recovered: vi.fn(),
          failure: async (error, deliveredCredential) => {
            expect(error).toBe(failure);
            expect(deliveredCredential).toEqual(credential);
            order.push("delivered");
          },
        },
      ),
    ).rejects.toBe(failure);
    expect(order).toEqual(["delivered", "confirmed"]);
    expect(failure.deliveryConfirmed).toBe(true);
  });

  it("retains a completed business failure when its delivery callback fails", async () => {
    const confirmDelivered = vi.fn(async () => undefined);
    const deliveryFailure = new Error("presentation unavailable");
    const failure = new CompletedWorkspaceAdministrationOperationError(
      "WORKSPACE_POLICY_REJECTED",
      "rejected by policy",
    );
    await expect(
      useLocalWorkspaceClient(
        client(confirmDelivered),
        async () => {
          throw failure;
        },
        {
          result: vi.fn(),
          recovered: vi.fn(),
          failure: async () => {
            throw deliveryFailure;
          },
        },
      ),
    ).rejects.toBe(deliveryFailure);
    expect(confirmDelivered).not.toHaveBeenCalled();
    expect(failure.deliveryConfirmed).toBe(false);
  });
});

describe("createWorksceneFromLocalWorkspaceAuthorization", () => {
  it("creates with the legacy authorization wire and then reads the domain view when metadata is absent", async () => {
    const order: string[] = [];
    const scene = { sceneId: "scene-a", name: "Paper" };
    const create = vi.fn(async () => {
      order.push("create");
      return scene as never;
    });
    const workspace = client(async () => undefined);
    vi.mocked(workspace.viewByName).mockImplementation(async () => {
      order.push("view");
      return {
        name: "Paper",
        path: "C:\\paper",
        revision: 1,
        workspaceBindingRevision: 7,
      };
    });

    await expect(
      createWorksceneAndReadWorkspaceView(
        { create },
        workspace,
        "Paper",
        {
          deviceId: "device-a",
          bindingRef: "binding-a",
        },
        credential,
      ),
    ).resolves.toEqual({
      scene,
      authorization: { deviceId: "device-a", bindingRef: "binding-a" },
      workspace: {
        name: "Paper",
        path: "C:\\paper",
        revision: 1,
        workspaceBindingRevision: 7,
      },
    });
    expect(create).toHaveBeenCalledWith(
      "Paper",
      { deviceId: "device-a", bindingRef: "binding-a" },
      expect.stringMatching(/^workscene-create:sha256:/u),
    );
    expect(workspace.viewByName).toHaveBeenCalledWith("Paper");
    expect(workspace.list).not.toHaveBeenCalled();
    expect(order).toEqual(["create", "view"]);
  });
});

describe("workspace command output for people", () => {
  it("describes each result with the revision and generation later commands need", () => {
    expect(describeWorkspaceResult.status({ catalogGeneration: "catalog-initial", state: "healthy" } as never))
      .toEqual(["本机工作区目录：正常", "目录世代：catalog-initial（灾难恢复重置时用 --generation 指定）"]);
    expect(describeWorkspaceResult.list([])).toEqual(["还没有已授权的本机工作区。可用 zz workspace create <名称> <路径> 授权。"]);
    const view = { name: "甲", path: "E:/w", revision: 3, workspaceBindingRevision: 1 } as never;
    expect(describeWorkspaceResult.list([view]).join("\n")).toContain("甲  E:/w  （修订 3）");
    expect(describeWorkspaceResult.created(view)).toEqual(["已授权工作区「甲」：E:/w（修订 3）"]);
    expect(describeWorkspaceResult.removed("甲")).toEqual(["已移除工作区「甲」的授权。"]);
  });

  it("turns internal diagnostic codes into instructions and keeps unknown failures intact", () => {
    const recovering = Object.assign(new Error("Local workspace host is recovering committed operations"), { code: "LOCAL_WORKSPACE_RECOVERING_COMMITTED" });
    const localized = localWorkspaceUserError(recovering) as Error & { code: string };
    expect(localized.message).toBe("本机工作区正在完成上次的操作，请稍后重试。");
    expect(localized.code).toBe("LOCAL_WORKSPACE_RECOVERING_COMMITTED");
    expect(localized.cause).toBe(recovering);
    const other = Object.assign(new Error("disk full"), { code: "LOCAL_WORKSPACE_OPERATION_FAILED" });
    expect(localWorkspaceUserError(other)).toBe(other);
  });

  it("工作区写操作与重置的业务拒绝给出可照做的中文说明，不露出内部原文与标识", () => {
    const cases: readonly (readonly [string, string, string])[] = [
      ["LOCAL_WORKSPACE_NAME_IN_USE", "Workspace display name is already in use", "已有同名工作区，请换一个名称。"],
      ["WORKSPACE_BINDING_REVISION", "Workspace binding revision conflict for wsp-1: expected 5, actual 1",
        "工作区记录已变化；请先运行 zz workspace list 查看最新修订号再重试。"],
      ["LOCAL_WORKSPACE_CATALOG_HEALTHY", "本机工作区目录正常，无需也不能重置", "本机工作区目录正常，无需也不能重置。"],
      ["LOCAL_WORKSPACE_CATALOG_CHANGED", "工作区目录世代已经变化，请重新查看恢复影响",
        "工作区目录世代已经变化；请运行 zz workspace status 查看当前目录世代，需要时重新预览。"],
      ["WORKSPACE_CATALOG_CONFLICT", "A healthy workspace catalog cannot be reset",
        "工作区目录状态已经变化，这份重置确认不再适用；请运行 zz workspace status 查看当前状态，需要时重新预览。"],
    ];
    for (const [code, raw, text] of cases) {
      const localized = localWorkspaceUserError(new CompletedWorkspaceAdministrationOperationError(code, raw)) as Error & { code: string };
      expect(localized.message).toBe(text);
      expect(localized.code).toBe(code);
    }
  });

  it("宿主不可写时说出当时状态、操作号与具体原因，不笼统让用户稍后重试", () => {
    const degraded = new LocalWorkspaceHostNotWritableError({
      state: "degraded",
      diagnostic: { code: "LOCAL_WORKSPACE_OPERATION_FAILED", message: "disk full", localSeq: 3 },
    });
    expect((localWorkspaceUserError(degraded) as Error).message)
      .toBe("本机工作区上次的第 3 号操作无法自动完成：disk full（诊断码 LOCAL_WORKSPACE_OPERATION_FAILED）。");
    const retrying = new LocalWorkspaceHostNotWritableError({
      state: "recovering",
      diagnostic: { code: "EXECUTOR_RESOURCE_BACKPRESSURE", message: "capacity is limited", localSeq: 4 },
    });
    expect((localWorkspaceUserError(retrying) as Error).message)
      .toBe("本机工作区上次的第 4 号操作还没完成（capacity is limited，诊断码 EXECUTOR_RESOURCE_BACKPRESSURE）；再次运行会接着完成它。");
    expect((localWorkspaceUserError(retrying) as Error & { cause?: unknown }).cause).toBe(retrying);
  });

  it("逐条说明补完的上次操作，并说明本命令会接着执行", () => {
    expect(describeRecoveredOperations([
      { operationId: "a", operation: "create", target: "甲", outcome: "succeeded", credential },
      { operationId: "b", operation: "rename", target: "乙", outcome: "failed", credential, error: { code: "WORKSPACE_BINDING_REVISION", message: "Workspace binding revision conflict for wsp-1: expected 5, actual 1" } },
      { operationId: "c", operation: "remove", target: "丙", outcome: "failed", credential, error: { code: "SOME_INTERNAL_CODE", message: "原样保留的原因" } },
    ])).toEqual([
      "已补完上次中断的 3 个本机工作区操作：",
      "  授权工作区「甲」：成功",
      "  改名「乙」：未完成（工作区记录已变化；请先运行 zz workspace list 查看最新修订号再重试）",
      "  移除工作区「丙」：未完成（原样保留的原因）",
    ]);
  });
});
