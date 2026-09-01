import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  AnchorWorksceneGlobalStateAdapter,
  parseConversationId,
} from "@zhixing/core";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "@zhixing/core/authority";
import type {
  WorkspaceProbeResult,
} from "@zhixing/core/contracts";
import type { ConversationManager } from "@zhixing/owner-kernel";
import { createTempDir } from "@zhixing/test-utils";
import type { AuthorityRuntimeStack } from "../../setup-delivery.js";
import { createConversationStorageInfrastructure } from "../conversation-storage-infrastructure.js";
import { createAnchorWorksceneConversationStorageProjectionCleanup } from "../workscene-application-adapter.js";
import { createWorksceneDirectory } from "../workscene-directory.js";
import { createWorksceneStorageCleanupInfrastructure } from "../workscene-storage-cleanup.js";

let originalHome: string | undefined;
let home: string;
let requestSequence = 0;

function requestId(prefix: string): string {
  requestSequence += 1;
  return `${prefix}-${requestSequence}`;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function busyError(message = "busy"): Error {
  return Object.assign(new Error(message), {
    name: "WorksceneBusyError",
    code: "WORKSCENE_BUSY",
  });
}

beforeEach(async () => {
  home = await createTempDir("workscene-directory");
  originalHome = process.env.ZHIXING_HOME;
  process.env.ZHIXING_HOME = home;
  requestSequence = 0;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.ZHIXING_HOME;
  else process.env.ZHIXING_HOME = originalHome;
});

describe("workscene directory", { timeout: 30_000 }, () => {
  it("linearizes CRUD and preserves not-found results", async () => {
    const fixture = await createFixture();
    expect(await fixture.directory.rename("ghost", "x", requestId("rename"))).toBeNull();
    expect(await fixture.directory.remove("ghost", requestId("remove"))).toBe(false);

    const { scene } = await fixture.directory.create({
      name: "评审场景",
      requestId: requestId("create"),
    });
    expect((await fixture.directory.list()).map(({ id }) => id)).toContain(scene.id);

    const renamed = await fixture.directory.rename(
      scene.id,
      "新场景名",
      requestId("rename"),
    );
    expect(renamed?.name).toBe("新场景名");
    expect(renamed?.revision).toBeGreaterThan(scene.revision);

    expect(await fixture.directory.remove(scene.id, requestId("remove"))).toBe(true);
    expect(await fixture.directory.get(scene.id)).toBeNull();
  });

  it("derives one owner conversation identity and reuses it across concurrent enters", async () => {
    const fixture = await createFixture();
    const { scene } = await fixture.directory.create({
      name: "开发场景",
      requestId: requestId("create"),
    });

    const [first, second, third] = await Promise.all([
      fixture.directory.enterScene(scene.id, "surface-a"),
      fixture.directory.enterScene(scene.id, "surface-b"),
      fixture.directory.enterScene(scene.id, "surface-c"),
    ]);
    expect(second?.conversationId).toBe(first?.conversationId);
    expect(third?.conversationId).toBe(first?.conversationId);
    const parsed = parseConversationId(first!.conversationId);
    expect(parsed.scope).toEqual({ kind: "workscene", sceneId: scene.id });
    expect(await fixture.directory.enterScene("ghost", "surface-a")).toBeNull();
  });

  it("accepts directory/missing workspace probes, rejects hard states and never exposes paths", async () => {
    const fixture = await createFixture();
    await expect(
      fixture.directory.create({ name: "   ", requestId: requestId("create") }),
    ).rejects.toThrow("Workscene name must be a non-empty bounded string");

    const workspace = { deviceId: "device-a", bindingRef: "workspace-a" };
    const created = await fixture.directory.create({
      name: "有工作区",
      workspace,
      requestId: requestId("create"),
    });
    expect(created.scene.workspace).toEqual(workspace);
    expect(JSON.stringify(created)).not.toContain(home);

    fixture.setProbe("missing");
    const rebound = await fixture.directory.setWorkdir(
      created.scene.id,
      workspace,
      requestId("set"),
    );
    expect(rebound?.workspaceWarning).toContain("下次进入将自动创建");

    fixture.setProbe("non_directory");
    await expect(
      fixture.directory.setWorkdir(
        created.scene.id,
        workspace,
        requestId("set"),
      ),
    ).rejects.toMatchObject({ code: "WORKSCENE_INPUT" });
    const cleared = await fixture.directory.setWorkdir(
      created.scene.id,
      null,
      requestId("clear"),
    );
    expect(cleared?.scene).not.toHaveProperty("workspace");
  });

  it("quiesces set/delete in the per-scene chain and never deletes the user workspace", async () => {
    const calls: string[] = [];
    const manager = {
      async quiescePrefix(prefix: string) {
        calls.push(`quiesce:${prefix}`);
        return () => calls.push(`release:${prefix}`);
      },
      addObserver: () => true,
    } as unknown as ConversationManager;
    const fixture = await createFixture(manager);
    const userWorkspace = path.join(home, "user-workspace");
    await fs.mkdir(userWorkspace);
    const { scene } = await fixture.directory.create({
      name: "守卫场景",
      requestId: requestId("create"),
    });

    await fixture.directory.setWorkdir(scene.id, null, requestId("set"));
    expect(await fixture.directory.remove(scene.id, requestId("remove"))).toBe(true);
    expect(calls).toEqual([
      `quiesce:ws:${scene.id}:`,
      `release:ws:${scene.id}:`,
      `quiesce:ws:${scene.id}:`,
      `release:ws:${scene.id}:`,
    ]);
    expect((await fs.stat(userWorkspace)).isDirectory()).toBe(true);
  });

  it("rejects delete while an entered observer holds the scene", async () => {
    const observers = new Set<string>();
    const manager = {
      addObserver(conversationId: string) {
        observers.add(conversationId);
        return true;
      },
      async getOrCreate() {
        return {} as never;
      },
      async quiescePrefix(prefix: string) {
        if ([...observers].some((id) => id.startsWith(prefix))) throw busyError();
        return () => {};
      },
    } as unknown as ConversationManager;
    const fixture = await createFixture(manager);
    const { scene } = await fixture.directory.create({
      name: "入场优先",
      requestId: requestId("create"),
    });

    await expect(fixture.directory.enterScene(scene.id, "surface-a")).resolves.toBeTruthy();
    await expect(
      fixture.directory.remove(scene.id, requestId("remove")),
    ).rejects.toMatchObject({ code: "WORKSCENE_BUSY" });
    expect(await fixture.directory.get(scene.id)).not.toBeNull();
  });

  it("serializes remove ahead of enter and prevents deleted-scene re-entry", async () => {
    const gate = deferred();
    const calls: string[] = [];
    const manager = {
      addObserver() {
        calls.push("observer");
        return true;
      },
      async quiescePrefix() {
        calls.push("quiesce");
        await gate.promise;
        return () => calls.push("release");
      },
    } as unknown as ConversationManager;
    const fixture = await createFixture(manager);
    const { scene } = await fixture.directory.create({
      name: "删除优先",
      requestId: requestId("create"),
    });

    const removing = fixture.directory.remove(scene.id, requestId("remove"));
    await Promise.resolve();
    const entering = fixture.directory.enterScene(scene.id, "surface-a");
    gate.resolve();

    await expect(removing).resolves.toBe(true);
    await expect(entering).resolves.toBeNull();
    expect(calls).toEqual(["quiesce", "release"]);
  });

  it("redrives a committed deletion after cleanup failure and preserves exact replay", async () => {
    let failCleanup = true;
    const fixture = await createFixture(undefined, async () => {
      if (failCleanup) throw new Error("injected cleanup failure");
    });
    const { scene } = await fixture.directory.create({
      name: "可恢复删除",
      requestId: requestId("create"),
    });
    const deleteRequestId = requestId("remove");

    await expect(
      fixture.directory.remove(scene.id, deleteRequestId),
    ).resolves.toBe(true);
    await expect(
      fixture.globalState.read(
        { kind: "workscene-get", sceneId: scene.id },
        globalContext(requestId("read-after-delete")),
      ),
    ).resolves.toMatchObject({ kind: "workscene-get", scene: null });

    failCleanup = false;
    await expect(fixture.directory.recover()).resolves.toBeUndefined();
    await expect(
      fixture.directory.remove(scene.id, deleteRequestId),
    ).resolves.toBe(true);
    await expect(
      fixture.directory.remove(scene.id, requestId("remove")),
    ).resolves.toBe(false);
  });

  it("records activity only through the matching conversation owner fact", async () => {
    const fixture = await createFixture();
    const { scene } = await fixture.directory.create({
      name: "活动场景",
      requestId: requestId("create"),
    });
    const entered = await fixture.directory.enterScene(scene.id, "surface-a", {
      recordActivity: false,
    });
    await expect(
      fixture.directory.recordActivity(
        scene.id,
        entered!.conversationId,
        "2026-07-30T00:00:00.000Z",
      ),
    ).resolves.toBeUndefined();
    await expect(
      fixture.directory.recordActivity(
        "another-scene",
        entered!.conversationId,
        "2026-07-30T00:00:00.000Z",
      ),
    ).rejects.toMatchObject({ code: "WORKSCENE_INPUT" });
  });
});

async function createFixture(
  conversations?: ConversationManager,
  removeSceneDirectory?: (sceneId: string) => Promise<void>,
) {
  const artifacts = new FileArtifactStore(path.join(home, "authority-artifacts"));
  const log = new FileAuthorityCommitLog(
    path.join(home, "authority-log"),
    artifacts,
  );
  let cleanup = async (
    sceneId: string,
    _conversationIds: readonly string[],
  ) => {
    await removeSceneDirectory?.(sceneId);
  };
  const globalState = new AnchorWorksceneGlobalStateAdapter({
    log,
    anchorEpoch: 1,
    removeScene: (sceneId, conversationIds) =>
      cleanup(sceneId, conversationIds),
  });
  onTestFinished(async () => {
    await globalState.stop();
    await log.stopStorageMaintenance();
  });
  const worksceneStorageCleanup = createWorksceneStorageCleanupInfrastructure({
    zhixingHome: home,
  });
  const conversationDirectory = createConversationStorageInfrastructure({
    optimalMaxTokens: 20_000,
    worksceneConversationStorageRemoval: worksceneStorageCleanup.conversations,
  }).directory;
  let probe: WorkspaceProbeResult["probe"] = "directory";
  const authority = {
    anchorEpoch: 1,
    deviceId: "device-a",
    globalState,
    recoverWorksceneState: () => globalState.recoverPendingDeletions(),
    replayWorksceneMutation: (requestId: string) =>
      globalState.replayMutation(requestId),
    installWorksceneCleanup: (
      next: (
        sceneId: string,
        conversationIds: readonly string[],
      ) => Promise<void>,
    ) => {
      cleanup = async (sceneId, conversationIds) => {
        await removeSceneDirectory?.(sceneId);
        await next(sceneId, conversationIds);
      };
    },
    workspaceCatalog: () => [{
      executorId: "executor-a",
      deviceId: "device-a",
      deviceName: "本机",
      bindingRef: "workspace-a",
      displayName: "工作区",
      workspaceBindingRevision: 1,
    }],
    resourceGovernor: {
      acquireRoot: vi.fn(async () => ({ leaseId: "lease-a" })),
      settle: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    },
    environmentProbeOwner: {
      issue: vi.fn((input) => input),
      accept: vi.fn((_request, result) => result),
    },
    workspaceProbe: {
      probe: vi.fn(async (request: Record<string, unknown>) => ({
        ...request,
        executorId: "executor-a",
        probe,
      })),
    },
  } as unknown as AuthorityRuntimeStack;
  return {
    directory: createWorksceneDirectory({
      authority: () => authority,
      conversationAuthority: () => ({
        async touchWorksceneSession(input) {
          await appendActivity(log, input, "upsert");
          return { revision: 1, at: input.at };
        },
        async deleteWorksceneSession(input) {
          await appendActivity(log, input, "delete");
          return { revision: 1, at: input.at };
        },
      }),
      conversationStorageProjectionCleanup:
        createAnchorWorksceneConversationStorageProjectionCleanup(
          conversationDirectory,
        ),
      sceneStorageRemoval: worksceneStorageCleanup.scenes,
      recoverWorksceneState: () => globalState.recoverPendingDeletions(),
      replayWorksceneMutation: (requestId) =>
        globalState.replayMutation(requestId),
      ...(conversations ? { conversations: () => conversations } : {}),
    }),
    globalState,
    setProbe(value: WorkspaceProbeResult["probe"]) {
      probe = value;
    },
  };
}

async function appendActivity(
  log: FileAuthorityCommitLog,
  input: { conversationId: string; sceneId: string; at: string },
  operation: "upsert" | "delete",
) {
  await log.append([
    {
      stream: `session-activity:${input.conversationId}`,
      body: {
        kind: "session-activity",
        operation,
        conversationId: input.conversationId,
        sceneId: input.sceneId,
        sessionRevision: 1,
        lastActiveAt: input.at,
      },
    },
  ]);
}

function globalContext(requestId: string) {
  return {
    principal: { kind: "host" as const, component: "workscene-test" },
    requestId,
    authority: { domain: "global" as const, anchorEpoch: 1 },
    deadlineAt: "2099-01-01T00:00:00.000Z",
  };
}
