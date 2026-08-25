import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  type AuthorityCommitLog,
  type DurableProjectionIndex,
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "../authority/index.js";
import type { GlobalControlCallContext } from "../contracts/index.js";
import { IncrementalWorksceneActivityProjection } from "./activity-projection.js";
import { AnchorWorksceneGlobalStateAdapter } from "./global-state-adapter.js";

const NOW = "2026-07-30T00:00:00.000Z";
const LATER = "2026-07-30T00:05:00.000Z";
// 隔离文件约 25 秒、最慢单项约 3 秒；根级 Windows 并发 fsync 时文件达到
// 约 53 秒并击穿 30 秒外层边界。只调整真实耐久组的测试预算。
const DURABLE_IO_TEST_TIMEOUT_MS = 60_000;
describe("AnchorWorksceneGlobalStateAdapter", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
  it("is the guarded exact read/write surface and merges incremental activity", async () => {
    const fixture = await createFixture();
    const created = await fixture.adapter.mutate(
      { kind: "workscene-create", name: "Project" },
      context("create"),
    );
    if (created.kind !== "workscene-applied") throw new Error("unexpected result");

    await appendActivity(fixture.log, {
      conversationId: `ws:${created.scene.id}:one`,
      sceneId: created.scene.id,
      at: LATER,
    });
    const exact = await fixture.adapter.read(
      { kind: "workscene-get", sceneId: created.scene.id },
      context("get"),
    );
    expect(exact).toEqual({
      kind: "workscene-get",
      scene: expect.objectContaining({
        id: created.scene.id,
      }),
    });
    await expectLastActiveAt(fixture.adapter, created.scene.id, LATER);
    await expect(
      fixture.adapter.read(
        { kind: "workscene-list" },
        {
          ...context("forged"),
          principal: { kind: "usage-reporter", executorId: "executor-a" },
        },
      ),
    ).rejects.toThrow();
    await expect(
      fixture.adapter.read(
        { kind: "workscene-list" },
        {
          ...context("stale-anchor"),
          authority: { domain: "global", anchorEpoch: 2 },
        },
      ),
    ).rejects.toThrow("authority fence");
    await expect(
      fixture.adapter.read(
        { kind: "workscene-list" },
        {
          ...context("wrong-domain"),
          authority: { domain: "session", anchorEpoch: 1 },
        } as unknown as GlobalControlCallContext,
      ),
    ).rejects.toThrow("authority fence");
    await expect(
      fixture.adapter.mutate(
        {
          kind: "workscene-rename",
          sceneId: created.scene.id,
          name: "Renamed",
          expectedRevision: created.scene.revision,
        },
        context("wrong-revision", created.scene.revision + 1),
      ),
    ).rejects.toThrow("revisions disagree");
  });

  it("keeps one contribution per conversation and recomputes the scene maximum", async () => {
    const fixture = await createFixture();
    const created = await fixture.adapter.mutate(
      { kind: "workscene-create", name: "Project" },
      context("create"),
    );
    if (created.kind !== "workscene-applied") throw new Error("unexpected result");
    await appendActivity(fixture.log, {
      conversationId: "ws:scene-a:first",
      sceneId: "scene-a",
      at: LATER,
    });
    await appendActivity(fixture.log, {
      conversationId: "ws:scene-a:second",
      sceneId: "scene-a",
      at: NOW,
    });
    await expectLastActiveAt(fixture.adapter, "scene-a", LATER);
    await appendActivity(fixture.log, {
      conversationId: "ws:scene-a:first",
      sceneId: "scene-a",
      at: "2026-07-30T00:06:00.000Z",
    }, "delete", 2);
    await expectLastActiveAt(fixture.adapter, "scene-a", NOW);

    const restarted = new AnchorWorksceneGlobalStateAdapter({
      log: fixture.log,
      anchorEpoch: 1,
      removeScene: async () => {},
      clock: () => NOW,
    });
    onTestFinished(() => restarted.stop());
    await expectLastActiveAt(restarted, "scene-a", NOW);
  });

  it("reduces every activity record in one commit envelope against the same batch overlay", async () => {
    const fixture = await createFixture();
    await fixture.adapter.mutate(
      { kind: "workscene-create", name: "Project" },
      context("create"),
    );
    await fixture.log.append([
      activityEntry("ws:scene-a:first", "scene-a", NOW, "upsert", 1),
      activityEntry("ws:scene-a:second", "scene-a", LATER, "upsert", 1),
    ]);
    await expectLastActiveAt(fixture.adapter, "scene-a", LATER);

    await fixture.log.append([
      activityEntry("ws:scene-a:second", "scene-a", LATER, "delete", 2),
      activityEntry(
        "ws:scene-a:first",
        "scene-a",
        "2026-07-30T00:01:00.000Z",
        "upsert",
        2,
      ),
    ]);
    await expectLastActiveAt(
      fixture.adapter,
      "scene-a",
      "2026-07-30T00:01:00.000Z",
    );
  });

  it("redrives the committed deletion until cleanup and confirmation converge", async () => {
    const removeScene = vi
      .fn<(sceneId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("injected cleanup failure"))
      .mockResolvedValue(undefined);
    const fixture = await createFixture(removeScene);
    const created = await fixture.adapter.mutate(
      { kind: "workscene-create", name: "Disposable" },
      context("create"),
    );
    if (created.kind !== "workscene-applied") throw new Error("unexpected result");

    await expect(
      fixture.adapter.mutate(
        {
          kind: "workscene-delete",
          sceneId: created.scene.id,
          expectedRevision: created.scene.revision,
        },
        context("delete", created.scene.revision),
      ),
    ).resolves.toMatchObject({ kind: "workscene-deleted", revision: 2 });
    await fixture.adapter.recoverPendingDeletions();
    expect(removeScene).toHaveBeenCalledTimes(2);
  });

  it("recovers pending deletions through a bounded durable cursor", async () => {
    let failCleanup = true;
    const completed: string[] = [];
    const sceneIds = ["scene-a", "scene-b"];
    const fixture = await createFixture(
      async (sceneId) => {
        if (failCleanup) throw new Error("defer cleanup");
        completed.push(sceneId);
      },
      {
        deletionPageSize: 1,
        sceneIdFactory: () => sceneIds.shift()!,
      },
    );
    for (const [index, name] of ["First", "Second"].entries()) {
      const created = await fixture.adapter.mutate(
        { kind: "workscene-create", name },
        context(`create-${index}`),
      );
      if (created.kind !== "workscene-applied") throw new Error("unexpected result");
      await expect(
        fixture.adapter.mutate(
          {
            kind: "workscene-delete",
            sceneId: created.scene.id,
            expectedRevision: created.scene.revision,
          },
          context(`delete-${index}`, created.scene.revision),
        ),
      ).resolves.toMatchObject({ kind: "workscene-deleted" });
    }
    failCleanup = false;
    await fixture.adapter.recoverPendingDeletions();
    expect(completed).toEqual(["scene-a", "scene-b"]);
  });
});

describe("IncrementalWorksceneActivityProjection lifecycle", () => {
  it("waits for an in-flight read-behind refresh and rejects new work after stop", async () => {
    let resolveStarted!: () => void;
    let resolveGet!: (value: unknown) => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const pendingGet = new Promise<unknown>((resolve) => {
      resolveGet = resolve;
    });
    const get = vi.fn(() => {
      resolveStarted();
      return pendingGet;
    });
    const projection = new IncrementalWorksceneActivityProjection({
      log: {
        durableProjection: () => ({ get } as unknown as DurableProjectionIndex),
      } as unknown as AuthorityCommitLog,
    });

    expect(projection.peek("scene-a")).toBeUndefined();
    await started;
    let stopped = false;
    const stopping = projection.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    resolveGet({ sceneId: "scene-a", lastActiveAt: NOW });
    await stopping;
    expect(stopped).toBe(true);
    expect(projection.peek("scene-a")).toBe(NOW);
    expect(get).toHaveBeenCalledTimes(1);
  });
});

function context(
  requestId: string,
  expectedRevision?: number,
): GlobalControlCallContext {
  return {
    principal: { kind: "host", component: "workscene-test" },
    requestId,
    authority: { domain: "global", anchorEpoch: 1 },
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    deadlineAt: "2026-07-30T01:00:00.000Z",
  };
}

async function appendActivity(
  log: FileAuthorityCommitLog,
  input: { conversationId: string; sceneId: string; at: string },
  operation: "upsert" | "delete" = "upsert",
  sessionRevision = 1,
) {
  await log.append([
    activityEntry(
      input.conversationId,
      input.sceneId,
      input.at,
      operation,
      sessionRevision,
    ),
  ]);
}

function activityEntry(
  conversationId: string,
  sceneId: string,
  at: string,
  operation: "upsert" | "delete",
  sessionRevision: number,
) {
  return {
    stream: `session-activity:${conversationId}`,
    body: {
      kind: "session-activity" as const,
      operation,
      conversationId,
      sceneId,
      sessionRevision,
      lastActiveAt: at,
    },
  };
}

async function createFixture(
  removeScene: (
    sceneId: string,
    conversationIds: readonly string[],
  ) => Promise<void> = async () => {},
  options: {
    readonly deletionPageSize?: number;
    readonly sceneIdFactory?: () => string;
  } = {},
) {
  const root = await createTempDir("zhixing-workscene-global-state");
  let log: FileAuthorityCommitLog | undefined;
  let adapter: AnchorWorksceneGlobalStateAdapter | undefined;
  onTestFinished(async () => {
    await adapter?.stop();
    await log?.stopStorageMaintenance();
  });
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  log = new FileAuthorityCommitLog(
    path.join(root, "authority"),
    artifacts,
    { clock: () => NOW },
  );
  adapter = new AnchorWorksceneGlobalStateAdapter({
    log,
    anchorEpoch: 1,
    removeScene,
    clock: () => NOW,
    sceneIdFactory: options.sceneIdFactory ?? (() => "scene-a"),
    ...(options.deletionPageSize
      ? { deletionPageSize: options.deletionPageSize }
      : {}),
  });
  return {
    log,
    adapter,
  };
}

async function lastActiveAt(
  adapter: AnchorWorksceneGlobalStateAdapter,
  sceneId: string,
): Promise<string | undefined> {
  const result = await adapter.read(
    { kind: "workscene-get", sceneId },
    context(`read-${sceneId}`),
  );
  return result.kind === "workscene-get"
    ? result.scene?.lastActiveAt
    : undefined;
}

async function expectLastActiveAt(
  adapter: AnchorWorksceneGlobalStateAdapter,
  sceneId: string,
  expected: string,
): Promise<void> {
  await expect.poll(() => lastActiveAt(adapter, sceneId)).toBe(expected);
}
