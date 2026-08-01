import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AnchorWorksceneGlobalStateAdapter,
  getWorkSceneDir,
  getWorkSceneIndexPath,
  markLegacyWorksceneCutover,
  worksceneImportSetDigest,
} from "@zhixing/core";
import { FileArtifactStore, FileAuthorityCommitLog } from "@zhixing/core/authority";
import type { LocalWorkspaceBinding, WorkspaceBindingMigrationPort } from "@zhixing/core/contracts";
import { protocolDigest } from "@zhixing/core/protocol";
import { StorageMaintenanceTaskRunner } from "@zhixing/core/resources";
import {
  assert,
  createS7TempDir,
  expectFailure,
  observeOutcome,
  observeProducerHandle,
  observeRecoveryOwnerHandle,
  observeReasonCode,
  type DurableCaseKind,
} from "@zhixing/core/test-support/s7-durable-harness";
import {
  LocalWorkspaceOperationOutbox,
  type LocalWorkspaceWriteOperation,
} from "../../runtime/local-workspace-operation-outbox.js";
import { LocalWorkspaceManagementHost, readLocalWorkspaceHostStatus } from "../../runtime/local-workspace-management-host.js";
import { acquireLocalWorkspaceOwner } from "../../runtime/local-workspace-owner.js";
import { WORKSPACE_CATALOG_RESET_IMPACT } from "../../runtime/workspace-reset-impact.js";
import {
  migrateLegacyWorkscenes,
} from "../workscene-legacy-migration.js";

const NOW = "2026-08-01T00:00:00.000Z";
const EXPIRY = "2026-08-01T01:00:00.000Z";

export async function executeLegacyWorksceneMigrationCase(
  kind: DurableCaseKind,
  caseKey: string,
): Promise<void> {
  await withLegacyHome(async (home) => {
    if (kind === "variant" && caseKey === "open") {
      await seedLegacyWorkscenes([{ id: "legacy-a", name: "Legacy", workdir: path.join(home, "workspace") }]);
      const fixture = await createLegacyMigrationFixture(home, {
        async importLegacy() { throw new Error("stop-after-open-report"); },
      });
      await expectFailure(() => runLegacyMigration(fixture), "stop-after-open-report");
      assert((await readMigrationReport(fixture.rootDir)).status === "open", "open report was not durable", { kind: "variant", caseKey: "open" });
      return;
    }

    if (kind === "variant" && caseKey === "activated") {
      await seedLegacyWorkscenes([{ id: "legacy-a", name: "Legacy", workdir: path.join(home, "workspace") }]);
      const fixture = await createLegacyMigrationFixture(home);
      await runLegacyMigration(fixture);
      assert((await readMigrationReport(fixture.rootDir)).status === "activated", "migration did not activate");
      const restarted = await createLegacyGlobalState(home, fixture.log);
      const result = await restarted.read(
        { kind: "workscene-get", sceneId: "legacy-a" },
        globalReadContext("legacy-replay"),
      );
      assert(result.kind === "workscene-get" && result.scene?.id === "legacy-a", "migration owner did not replay activation", { kind: "variant", caseKey: "activated" });
      return;
    }

    if ((kind === "variant" && caseKey === "abandoned") ||
        (kind === "rejection" && caseKey === "source-changed")) {
      await seedLegacyWorkscenes([{ id: "legacy-a", name: "Legacy", workdir: path.join(home, "workspace") }]);
      let changed = false;
      const fixture = await createLegacyMigrationFixture(home, {
        async importLegacy(input) {
          if (!changed) {
            changed = true;
            await writeFile(
              path.join(getWorkSceneDir("legacy-a"), "meta.json"),
              JSON.stringify({
                id: "legacy-a",
                name: "Changed",
                createdAt: NOW,
                lastActiveAt: NOW,
              }),
              "utf8",
            );
          }
          return legacyBinding(input.absolutePath);
        },
      });
      await runLegacyMigration({
        ...fixture,
        migrationRunner: singlePassMigrationRunner(),
      });
      const report = await readMigrationReport(fixture.rootDir);
      if (kind === "variant") {
        assert(report.status === "abandoned", "source change did not produce the abandoned terminal", { kind: "variant", caseKey: "abandoned" });
      } else {
        assert(report.reason === "WORKSCENE_MIGRATION_SOURCE_CHANGED", "source change rejection did not retain its stable reason", { kind: "rejection", caseKey: "source-changed" });
        observeReasonCode(report.reason, "abandoned report after the frozen source changed");
      }
      return;
    }

    if (kind === "variant" && caseKey === "terminal-revival") {
      await seedLegacyWorkscenes([{
        id: "legacy-a",
        name: "Legacy",
        workdir: path.join(home, "workspace"),
      }]);
      const fixture = await createLegacyMigrationFixture(home);
      await runLegacyMigration(fixture);
      const before = await fixture.log.readAll();
      await runLegacyMigration(fixture);
      assert((await fixture.log.readAll()).length === before.length, "activated migration was revived", { kind: "variant", caseKey: "terminal-revival" });
      return;
    }

    if (kind === "rejection" && caseKey === "import-set-mismatch") {
      await seedLegacyWorkscenes([{
        id: "legacy-a",
        name: "Legacy",
        workdir: path.join(home, "workspace"),
      }]);
      const paused = await createLegacyMigrationFixture(home, {
        async importLegacy() { throw new Error("pause-before-import-set-check"); },
      });
      await expectFailure(
        () => runLegacyMigration(paused),
        "pause-before-import-set-check",
      );
      const report = await readMigrationReport(paused.rootDir);
      await paused.globalState.mutate({
        kind: "workscene-import-legacy",
        migrationId: report.migrationId,
        sourceSnapshotToken: report.sourceSnapshotToken,
        scene: { id: "preexisting", name: "Preexisting", createdAt: NOW },
      }, globalControlContext("legacy-import"));
      const resumed = await createLegacyMigrationFixture(
        home,
        {},
        undefined,
        paused.rootDir,
        paused.log,
      );
      await expectFailure(
        () => runLegacyMigration(resumed),
        "open import set",
        { kind: "rejection", caseKey: "import-set-mismatch" },
      );
      return;
    }

    if (kind === "rejection" && caseKey === "post-cutover-write") {
      await seedLegacyWorkscenes([{ id: "legacy-a", name: "Legacy" }]);
      const fixture = await createLegacyMigrationFixture(home);
      await runLegacyMigration(fixture);
      const { FsWorkSceneRegistry } = await import("../../../../core/src/workscene/registry.js");
      await expectFailure(() => new FsWorkSceneRegistry().add({ name: "Late" }), "read-only", { kind: "rejection", caseKey: "post-cutover-write" });
      return;
    }

    const rootDir = path.join(home, "migration");
    await mkdir(rootDir, { recursive: true });
    if (kind === "corruption" && caseKey === "malformed-report") {
      await writeFile(path.join(rootDir, "workscene-legacy-migration.json"), "{}", "utf8");
      const fixture = await createLegacyMigrationFixture(home, {}, undefined, rootDir);
      await expectFailure(() => runLegacyMigration(fixture), "report is malformed", { kind: "corruption", caseKey: "malformed-report" });
      return;
    }
    if (kind === "corruption" && caseKey === "broken-terminal") {
      await writeFile(
        path.join(rootDir, "workscene-legacy-migration.json"),
        JSON.stringify({
          version: 3,
          migrationId: "migration-terminal",
          sourceSnapshotToken: "snapshot-terminal",
          sourceDigest: protocolDigest("LegacySource", 1, {}),
          status: "activated",
          phase: "cutover",
          nextPage: 0,
          pageCount: 0,
          importSetDigest: worksceneImportSetDigest([]),
        }),
        "utf8",
      );
      const fixture = await createLegacyMigrationFixture(home, {}, undefined, rootDir);
      await expectFailure(() => runLegacyMigration(fixture), "report is malformed", { kind: "corruption", caseKey: "broken-terminal" });
      return;
    }
    if (kind === "corruption" && caseKey === "source-pages-mismatch") {
      await seedLegacyWorkscenes([{ id: "legacy-a", name: "Legacy", workdir: path.join(home, "workspace") }]);
      const first = await createLegacyMigrationFixture(home, {
        async importLegacy() { throw new Error("pause-after-source-pages"); },
      }, undefined, rootDir);
      await expectFailure(() => runLegacyMigration(first), "pause-after-source-pages");
      const report = await readMigrationReport(rootDir);
      const pageFile = path.join(rootDir, "source-pages", report.sourceSnapshotToken, "00000000.json");
      const page = JSON.parse(await readFile(pageFile, "utf8")) as Array<Record<string, unknown>>;
      page[0]!.name = "Tampered frozen page";
      await writeFile(pageFile, JSON.stringify(page), "utf8");
      const resumed = await createLegacyMigrationFixture(home, {}, undefined, rootDir, first.log);
      await runLegacyMigration({
        ...resumed,
        migrationRunner: singlePassMigrationRunner(),
      });
      const finalReport = await readMigrationReport(rootDir);
      assert(finalReport.status === "abandoned", `tampered source page did not fail closed: ${JSON.stringify(finalReport)}`, { kind: "corruption", caseKey: "source-pages-mismatch" });
      observeReasonCode(
        finalReport.reason ?? "",
        "abandoned report after reopening tampered frozen source pages",
      );
      return;
    }
    if (kind === "corruption" && caseKey === "cutover-marker-mismatch") {
      await seedLegacyWorkscenes([{ id: "legacy-a", name: "Legacy" }]);
      await markLegacyWorksceneCutover({
        migrationId: "another-migration",
        sourceSnapshotToken: "another-snapshot",
        sourceDigest: protocolDigest("LegacySource", 1, { other: true }),
      });
      const fixture = await createLegacyMigrationFixture(home, {}, undefined, rootDir);
      await expectFailure(() => runLegacyMigration(fixture), "cut over", { kind: "corruption", caseKey: "cutover-marker-mismatch" });
      return;
    }
    throw new Error(`Unimplemented legacy migration case: ${kind}:${caseKey}`);
  });
}

async function withLegacyHome(operation: (home: string) => Promise<void>): Promise<void> {
  const previous = process.env.ZHIXING_HOME;
  const home = await createS7TempDir("s7-legacy-migration");
  process.env.ZHIXING_HOME = home;
  try {
    await operation(home);
  } finally {
    if (previous === undefined) delete process.env.ZHIXING_HOME;
    else process.env.ZHIXING_HOME = previous;
  }
}

async function seedLegacyWorkscenes(
  scenes: readonly Array<{
    readonly id: string;
    readonly name: string;
    readonly workdir?: string;
  }>,
): Promise<void> {
  await mkdir(path.dirname(getWorkSceneIndexPath()), { recursive: true });
  await writeFile(getWorkSceneIndexPath(), JSON.stringify({ scenes: scenes.map(({ id }) => id) }), "utf8");
  for (const scene of scenes) {
    await mkdir(getWorkSceneDir(scene.id), { recursive: true });
    await writeFile(path.join(getWorkSceneDir(scene.id), "meta.json"), JSON.stringify({
      ...scene,
      createdAt: NOW,
      lastActiveAt: NOW,
    }), "utf8");
  }
}

async function createLegacyMigrationFixture(
  overrides: Partial<WorkspaceBindingMigrationPort> | string,
  maybeOverrides: Partial<WorkspaceBindingMigrationPort> = {},
  abort?: AbortSignal,
  rootDir?: string,
  existingLog?: FileAuthorityCommitLog,
) {
  const home = typeof overrides === "string" ? overrides : process.env.ZHIXING_HOME!;
  const bindingOverrides = typeof overrides === "string" ? maybeOverrides : overrides;
  const log = existingLog ?? new FileAuthorityCommitLog(
    path.join(home, "authority"),
    new FileArtifactStore(path.join(home, "artifacts")),
    { clock: () => NOW },
  );
  const globalState = await createLegacyGlobalState(home, log);
  const bindings: WorkspaceBindingMigrationPort = {
    async importLegacy(input) { return legacyBinding(input.absolutePath); },
    async activateLegacy() {},
    async abandonLegacy() {},
    ...bindingOverrides,
  };
  return {
    rootDir: rootDir ?? path.join(home, "migration"),
    deviceId: "device-a",
    anchorEpoch: 1,
    globalState,
    bindings,
    log,
    ...(abort ? { abort } : {}),
  };
}

async function createLegacyGlobalState(_home: string, log: FileAuthorityCommitLog) {
  return new AnchorWorksceneGlobalStateAdapter({
    log,
    anchorEpoch: 1,
    removeScene: async () => {},
    clock: () => NOW,
  });
}

async function runLegacyMigration(
  fixture: Parameters<typeof migrateLegacyWorkscenes>[0],
): Promise<void> {
  try {
    await migrateLegacyWorkscenes(fixture);
  } finally {
    observeProducerHandle(
      migrateLegacyWorkscenes,
      "migrateLegacyWorkscenes",
      "legacy-workscene-migration:migration-a",
    );
    observeRecoveryOwnerHandle(
      fixture.migrationRunner ?? migrateLegacyWorkscenes,
      "workscene-migration-owner",
    );
  }
}

function singlePassMigrationRunner(): StorageMaintenanceTaskRunner {
  return {
    async run(_obligation: unknown, abort: AbortSignal, execute: (abort: AbortSignal) => Promise<unknown>) {
      await execute(abort);
      return "done";
    },
    stop() {},
  } as unknown as StorageMaintenanceTaskRunner;
}

function legacyBinding(absolutePath: string): LocalWorkspaceBinding {
  return {
    bindingRef: "binding-legacy",
    revision: 1,
    displayName: "Legacy",
    absolutePath,
    workspaceBindingRevision: 1,
  };
}

async function readMigrationReport(rootDir: string): Promise<{
  readonly status: string;
  readonly reason?: string;
  readonly sourceSnapshotToken: string;
}> {
  return JSON.parse(
    await readFile(path.join(rootDir, "workscene-legacy-migration.json"), "utf8"),
  ) as never;
}

function globalControlContext(requestId: string) {
  return {
    principal: { kind: "host" as const, component: "s7-migration" },
    requestId,
    authority: { domain: "global" as const, anchorEpoch: 1 },
    deadlineAt: EXPIRY,
  };
}

function globalReadContext(requestId: string) {
  return globalControlContext(requestId);
}



export async function executeLocalWorkspaceOutboxCase(
  kind: DurableCaseKind,
  caseKey: string,
): Promise<void> {
  if (kind === "variant") {
    if (caseKey === "prepared") {
      const outbox = await createOutbox();
      const prepared = await outbox.prepare(createInput("prepared"));
      assert(prepared.state === "prepared", "prepare did not persist the prepared state");
      await recoverOutboxWithHost(outbox);
      assert(
        (await new LocalWorkspaceOperationOutbox({
          rootDir: outboxRoot(outbox),
        }).pending()).operations[0]?.state === "prepared",
        "recovery host changed an uncommitted operation",
        { kind: "variant", caseKey: "prepared" },
      );
    } else if (caseKey === "committed") {
      const outbox = await createOutbox();
      const committed = await outbox.commit(
        await outbox.prepare(createInput("committed")),
      );
      assert(committed.state === "committed", "commit did not persist the committed state");
      const recovery = await recoverOutboxWithHost(outbox);
      assert(recovery.executions === 1, "recovery host did not drive the committed side effect once");
      assert(
        (await recovery.outbox.pending()).operations[0]?.state === "completed",
        "recovery host did not complete the committed operation",
        { kind: "variant", caseKey: "committed" },
      );
    } else if (caseKey === "completed") {
      const outbox = await createOutbox();
      const committed = await outbox.commit(
        await outbox.prepare(createInput("completed")),
      );
      const completed = await outbox.complete(committed, {
        ok: true,
        value: { name: "completed" },
      });
      assert(completed.state === "completed", "completion did not persist the completed state");
      const recovery = await recoverOutboxWithHost(outbox);
      assert(recovery.executions === 0, "recovery host repeated a completed side effect");
      assert(
        (await recovery.outbox.pending()).operations[0]?.state === "completed",
        "recovery host did not replay the completed state",
        { kind: "variant", caseKey: "completed" },
      );
    } else if (caseKey === "abandoned") {
      const root = path.join(
        await createS7TempDir("s7-outbox-abandoned"),
        "runtime",
        "local-workspace-operation-outbox",
      );
      let now = "2026-08-01T00:00:00.000Z";
      const outbox = trackOutbox(new LocalWorkspaceOperationOutbox({
        rootDir: root,
        clock: () => now,
      }), root);
      const prepared = await outbox.prepare({
        kind: "reset",
        expectedCatalogGeneration: "catalog-a",
        impact: WORKSPACE_CATALOG_RESET_IMPACT,
      });
      now = "2026-08-01T00:15:00.001Z";
      await expectFailure(
        () => outbox.commit(prepared, { impact: WORKSPACE_CATALOG_RESET_IMPACT }),
        "abandoned",
      );
      const recovery = await recoverOutboxWithHost(outbox);
      assert(
        (await recovery.outbox.pending()).operations[0]?.state === "abandoned",
        "expired preview did not recover as abandoned",
        { kind: "variant", caseKey: "abandoned" },
      );
    } else {
      throw new Error(`Unimplemented local workspace outbox variant: ${caseKey}`);
    }
    return;
  }

  if (kind === "rejection") {
    if (caseKey === "identity-mismatch") {
      const outbox = await createOutbox();
      const prepared = await outbox.prepare(createInput("identity"));
      await expectFailure(
        () => outbox.commit({ ...prepared, operationId: `${prepared.operationId}-forged` }),
        "identity",
        { kind: "rejection", caseKey: "identity-mismatch" },
      );
      await recoverOutboxWithHost(outbox);
    } else if (caseKey === "confirmation-hole") {
      const outbox = await createOutbox();
      await outbox.prepare(createInput("hole-one"));
      const second = await outbox.commit(
        await outbox.prepare(createInput("hole-two")),
      );
      const completed = await outbox.complete(second, { ok: true, value: null });
      await expectFailure(
        () => outbox.acknowledge({
          outboxId: outbox.outboxId,
          throughSeq: completed.localSeq,
          prefixDigest: completed.resultDigest!,
          entries: [{
            localSeq: completed.localSeq,
            operationId: completed.operationId,
            inputDigest: completed.inputDigest,
            resultDigest: completed.resultDigest!,
          }],
        }),
        "hole",
        { kind: "rejection", caseKey: "confirmation-hole" },
      );
      await recoverOutboxWithHost(outbox);
    } else {
      throw new Error(`Unimplemented local workspace outbox rejection: ${caseKey}`);
    }
    return;
  }

  if (caseKey === "checkpoint-chain") {
    const root = path.join(
      await createS7TempDir("s7-outbox-chain"),
      "runtime",
      "local-workspace-operation-outbox",
    );
    const outbox = trackOutbox(
      new LocalWorkspaceOperationOutbox({ rootDir: root }),
      root,
    );
    await outbox.prepare(createInput("chain"));
    const file = path.join(root, "operations.ndjson");
    const content = await readFile(file, "utf8");
    await writeFile(
      file,
      content.replace(
        /"digest":"sha256:[0-9a-f]+"/u,
        '"digest":"sha256:0000000000000000000000000000000000000000000000000000000000000000"',
      ),
      "utf8",
    );
    const recovered = await recoverOutboxWithHost(outbox);
    assert(
      recovered.status.state === "degraded" &&
        recovered.status.diagnostic?.message.toLowerCase().includes("digest") === true,
      "corrupt outbox chain did not produce a durable degraded diagnostic",
      { kind: "corruption", caseKey: "checkpoint-chain" },
    );
    observeReasonCode(
      recovered.status.diagnostic?.code ?? "",
      "host diagnostic after reopening the corrupt outbox chain",
    );
  } else if (caseKey === "establishment-marker") {
    const root = path.join(
      await createS7TempDir("s7-outbox-marker"),
      "runtime",
      "local-workspace-operation-outbox",
    );
    const outbox = trackOutbox(
      new LocalWorkspaceOperationOutbox({ rootDir: root }),
      root,
    );
    await outbox.initialize();
    const marker = `${root}.established`;
    const value = JSON.parse(await readFile(marker, "utf8"));
    value.outboxId = "outbox-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    await writeFile(marker, `${JSON.stringify(value)}\n`, "utf8");
    const recovered = await recoverOutboxWithHost(outbox);
    assert(
      recovered.status.state === "degraded" &&
        recovered.status.diagnostic?.message.toLowerCase().includes("identity") === true,
      "corrupt outbox identity did not produce a durable degraded diagnostic",
      { kind: "corruption", caseKey: "establishment-marker" },
    );
    observeReasonCode(
      recovered.status.diagnostic?.code ?? "",
      "host diagnostic after reopening the corrupt establishment marker",
    );
  } else {
    throw new Error(`Unimplemented local workspace outbox corruption: ${caseKey}`);
  }
}



function createInput(name: string): LocalWorkspaceWriteOperation {
  return {
    kind: "create",
    purpose: "settings",
    displayName: name,
    absolutePath: path.resolve(name),
  };
}

const roots = new WeakMap<LocalWorkspaceOperationOutbox, string>();

async function createOutbox(): Promise<LocalWorkspaceOperationOutbox> {
  const root = path.join(
    await createS7TempDir("s7-outbox-scenario"),
    "runtime",
    "local-workspace-operation-outbox",
  );
  const outbox = trackOutbox(
    new LocalWorkspaceOperationOutbox({ rootDir: root }),
    root,
  );
  await outbox.initialize();
  observeProducerHandle(
    outbox,
    "LocalWorkspaceOperationOutbox",
    root,
  );
  return outbox;
}

function trackOutbox(
  outbox: LocalWorkspaceOperationOutbox,
  root: string,
): LocalWorkspaceOperationOutbox {
  roots.set(outbox, root);
  observeProducerHandle(
    outbox,
    "LocalWorkspaceOperationOutbox",
    root,
  );
  return outbox;
}

async function recoverOutboxWithHost(
  outbox: LocalWorkspaceOperationOutbox,
): Promise<{
  readonly executions: number;
  readonly outbox: LocalWorkspaceOperationOutbox;
  readonly status: Awaited<ReturnType<typeof readLocalWorkspaceHostStatus>>;
}> {
  const root = outboxRoot(outbox);
  const home = path.dirname(path.dirname(root));
  const lease = await acquireLocalWorkspaceOwner(home);
  const recoveredOutbox = new LocalWorkspaceOperationOutbox({ rootDir: root });
  let executions = 0;
  const unavailable = async (): Promise<never> => {
    throw new Error("Unexpected local workspace recovery operation");
  };
  const host = new LocalWorkspaceManagementHost({
    lease,
    facade: {
      status: async () => ({
        state: "healthy" as const,
        catalogGeneration: "catalog-a",
      }),
      list: async () => [],
      create: async (displayName: string, absolutePath: string) => {
        executions += 1;
        return {
          name: displayName,
          path: absolutePath,
          revision: 1,
          workspaceBindingRevision: 1,
        };
      },
      authorizeForControl: async () => ({
        deviceId: "device-a",
        bindingRef: "binding-a",
      }),
      rename: unavailable,
      repath: unavailable,
      remove: unavailable,
      reset: unavailable,
    },
    outbox: recoveredOutbox,
  });
  try {
    await host.start();
    observeRecoveryOwnerHandle(
      host,
      "LocalWorkspaceManagementHost",
    );
    const status = await waitForLocalWorkspaceHostSettlement(home);
    return {
      executions,
      outbox: recoveredOutbox,
      status,
    };
  } finally {
    await host.close();
    await lease.release();
  }
}

async function waitForLocalWorkspaceHostSettlement(
  home: string,
): Promise<Awaited<ReturnType<typeof readLocalWorkspaceHostStatus>>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await readLocalWorkspaceHostStatus(home);
    if (status.state !== "recovering") return status;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Local workspace recovery did not reach a durable settlement");
}

function outboxRoot(outbox: LocalWorkspaceOperationOutbox): string {
  const root = roots.get(outbox);
  if (!root) throw new Error("Outbox scenario root is unavailable");
  return root;
}
