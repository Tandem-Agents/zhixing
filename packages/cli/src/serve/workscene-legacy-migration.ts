import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import {
  WorkspaceBindingConflictError,
  canonicalLegacyWorksceneImport,
  getWorkSceneDir,
  getWorkSceneIndexPath,
  markLegacyWorksceneCutover,
  withLegacyWorksceneWriteFence,
  worksceneImportSetDigest,
  worksceneImportSetDigestNext,
  type WorkScene,
} from "@zhixing/core";
import type {
  Digest,
  GlobalStatePort,
  WorksceneMigrationMutation,
  WorkspaceBindingMigrationPort,
} from "@zhixing/core/contracts";
import { defineDurableRuntimeContract } from "@zhixing/core/contracts";
import { canonicalize, protocolDigest } from "@zhixing/core/protocol";
import { syncDirectory } from "@zhixing/core/persistence";
import {
  claimDeviceCapacity,
  maintenanceRetryDelayMs,
  runStorageMaintenanceStep,
  storageMaintenanceObligation,
  storageMaintenanceRequest,
  type StorageMaintenanceGovernorPort,
  StorageMaintenanceTaskRunner,
} from "@zhixing/core/resources";

const REPORT_VERSION = 3;
const PAGE_SIZE = 64;
const MAX_LEGACY_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_LEGACY_SCENE_BYTES = 512 * 1024;
const MAX_SOURCE_PAGE_BYTES = 64 * 1024 * 1024;
const MAX_REPORT_BYTES = 64 * 1024;

interface LegacySnapshot {
  readonly digest: Digest;
  readonly sceneIds: readonly string[];
}

interface MigrationReport {
  readonly version: typeof REPORT_VERSION;
  readonly migrationId: string;
  readonly sourceSnapshotToken: string;
  readonly sourceDigest: Digest;
  readonly status: "open" | "activated" | "abandoned";
  readonly phase:
    | "snapshot"
    | "bindings"
    | "scenes"
    | "cutover"
    | "cleanup";
  readonly nextPage: number;
  readonly pageCount: number;
  readonly importSetDigest: Digest;
  readonly reason?: string;
}

export class LegacyWorksceneMigrationReportCorruptionError extends Error {
  readonly reasonCode = "WORKSCENE_MIGRATION_REPORT_CORRUPT";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LegacyWorksceneMigrationReportCorruptionError";
  }
}

interface LegacyMigrationOptions {
  readonly rootDir: string;
  readonly deviceId: string;
  readonly anchorEpoch: number;
  readonly globalState: GlobalStatePort;
  readonly bindings?: WorkspaceBindingMigrationPort;
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly migrationRunner?: StorageMaintenanceTaskRunner;
  readonly abort?: AbortSignal;
}

export async function migrateLegacyWorkscenes(
  options: LegacyMigrationOptions,
): Promise<void> {
  const abort = options.abort ?? new AbortController().signal;
  const ownedRunner = options.migrationRunner
    ? undefined
    : new StorageMaintenanceTaskRunner(options.storageMaintenance);
  const runner = options.migrationRunner ?? ownedRunner!;
  try {
    while (true) {
      abort.throwIfAborted();
      const reportPath = path.join(
        options.rootDir,
        "workscene-legacy-migration.json",
      );
      await governedIo(
        options.storageMaintenance,
        options.deviceId,
        { operation: "ensure-migration-root" },
        { writeBytes: 4 * 1024, ioOperations: 2 },
        () => mkdir(options.rootDir, { recursive: true, mode: 0o700 }),
      );
      let report = await readReport(
        reportPath,
        options.storageMaintenance,
        options.deviceId,
      );
      if (report?.status === "activated") return;
      if (!report || report.status === "abandoned") {
        const initial = await readLegacySnapshot(
          options.storageMaintenance,
          options.deviceId,
        );
        if (!initial) return;
        report = {
          version: REPORT_VERSION,
          migrationId: `workscene-migration:${randomUUID()}`,
          sourceSnapshotToken: randomUUID(),
          sourceDigest: initial.digest,
          status: "open",
          phase: "snapshot",
          nextPage: 0,
          pageCount: Math.ceil(initial.sceneIds.length / PAGE_SIZE),
          importSetDigest: worksceneImportSetDigest([]),
        };
        await writeReport(reportPath, report, options.storageMaintenance);
      }

      try {
        const outcome = await runner.run(
          storageMaintenanceObligation(
            "workspace-migration",
            options.deviceId,
            {
              migrationId: report.migrationId,
              sourceSnapshotToken: report.sourceSnapshotToken,
            },
            {
              owner: "workspace-binding-migrator",
              obligation: "committed",
            },
          ),
          abort,
          (taskAbort) =>
            driveOpenMigration(options, report, reportPath, taskAbort),
        );
        if (outcome === "done") return;
      } catch (error) {
        if (abort.aborted) throw abort.reason;
        const retryAfterMs = maintenanceRetryDelayMs(error);
        if (retryAfterMs === undefined) throw error;
        await waitForRetry(abort, Math.max(1, retryAfterMs));
        continue;
      }
      await waitForRetry(abort, 50);
    }
  } finally {
    ownedRunner?.stop();
  }
}

async function driveOpenMigration(
  options: LegacyMigrationOptions,
  initial: MigrationReport,
  reportPath: string,
  abort: AbortSignal,
): Promise<"done" | "retry"> {
  if (initial.phase === "cleanup") {
    await finishSourceCleanup(
      options.rootDir,
      initial,
      reportPath,
      options.storageMaintenance,
      abort,
    );
    return "done";
  }
  const current = await readLegacySnapshot(
    options.storageMaintenance,
    initial.migrationId,
  );
  if (!current || current.digest !== initial.sourceDigest) {
    await abandonMigration(
      options,
      initial,
      "Legacy source changed before cutover",
    );
    await writeReport(
      reportPath,
      {
        ...initial,
        status: "abandoned",
        reason: "WORKSCENE_MIGRATION_SOURCE_CHANGED",
      },
      options.storageMaintenance,
    );
    return "retry";
  }

  let report = initial;
  if (report.phase === "snapshot") {
    report = await writeSourcePages(
      options.rootDir,
      report,
      current.sceneIds,
      options.storageMaintenance,
    );
    const frozenDigest = await readFrozenSnapshotDigest(
      options.rootDir,
      report,
      options.storageMaintenance,
    );
    if (frozenDigest !== report.sourceDigest) {
      await abandonMigration(
        options,
        report,
        "Frozen legacy source pages do not match their source commitment",
      );
      await writeReport(
        reportPath,
        {
          ...report,
          status: "abandoned",
          reason: "WORKSCENE_MIGRATION_SOURCE_PAGES_CORRUPT",
        },
        options.storageMaintenance,
      );
      return "retry";
    }
    report = { ...report, phase: "bindings", nextPage: 0 };
    await writeReport(reportPath, report, options.storageMaintenance);
  }

  report = await importBindingPages(options, report, reportPath, abort);
  report = await importScenePages(options, report, reportPath, abort);

  const cutover = await withLegacyWorksceneWriteFence(async () => {
    const current = await readLegacySnapshot(
      options.storageMaintenance,
      report.migrationId,
    );
    if (!current || current.digest !== report.sourceDigest) {
      return "source-changed" as const;
    }
    const frozenDigest = await readFrozenSnapshotDigest(
      options.rootDir,
      report,
      options.storageMaintenance,
    );
    if (frozenDigest !== report.sourceDigest) {
      return "source-pages-corrupt" as const;
    }
    await applyMigration(
      options.globalState,
      {
        kind: "workscene-activate-device-registry",
        migrationId: report.migrationId,
        sourceSnapshotToken: report.sourceSnapshotToken,
        importSetDigest: report.importSetDigest,
      },
      `legacy-activate:${report.migrationId}`,
      options.anchorEpoch,
    );
    await governedIo(
      options.storageMaintenance,
      report.migrationId,
      { operation: "commit-legacy-cutover-marker" },
      {
        readBytes: 4 * 1024,
        writeBytes: 4 * 1024,
        temporaryBytes: 4 * 1024,
        ioOperations: 4,
      },
      () =>
        markLegacyWorksceneCutover({
          migrationId: report.migrationId,
          sourceSnapshotToken: report.sourceSnapshotToken,
          sourceDigest: report.sourceDigest,
        }),
    );
    return "activated" as const;
  });
  if (cutover !== "activated") {
    const sourcePagesCorrupt = cutover === "source-pages-corrupt";
    await abandonMigration(
      options,
      report,
      sourcePagesCorrupt
        ? "Frozen legacy source pages do not match their source commitment"
        : "Legacy source changed before cutover",
    );
    await writeReport(
      reportPath,
      {
        ...report,
        status: "abandoned",
        reason: sourcePagesCorrupt
          ? "WORKSCENE_MIGRATION_SOURCE_PAGES_CORRUPT"
          : "WORKSCENE_MIGRATION_SOURCE_CHANGED",
      },
      options.storageMaintenance,
    );
    return "retry";
  }

  await options.bindings?.activateLegacy(
    {
      migrationId: report.migrationId,
      sourceSnapshotToken: report.sourceSnapshotToken,
    },
    abort,
  );
  const cleanupReport: MigrationReport = {
    ...report,
    status: "open",
    phase: "cleanup",
    nextPage: 0,
  };
  await writeReport(
    reportPath,
    cleanupReport,
    options.storageMaintenance,
  );
  await finishSourceCleanup(
    options.rootDir,
    cleanupReport,
    reportPath,
    options.storageMaintenance,
    abort,
  );
  return "done";
}

async function importBindingPages(
  options: LegacyMigrationOptions,
  initial: MigrationReport,
  reportPath: string,
  abort: AbortSignal,
): Promise<MigrationReport> {
  let report = initial;
  if (report.phase !== "bindings") return report;
  while (report.nextPage < report.pageCount) {
    abort.throwIfAborted();
    const page = await readSourcePage(
      options.rootDir,
      report,
      report.nextPage,
      options.storageMaintenance,
    );
    if (options.bindings) {
      for (const scene of page) {
        abort.throwIfAborted();
        if (!scene.workdir) continue;
        try {
          await options.bindings.importLegacy(
            {
              migrationId: report.migrationId,
              sourceSnapshotToken: report.sourceSnapshotToken,
              displayName: normalizedLegacyName(scene),
              absolutePath: path.normalize(scene.workdir),
            },
            abort,
          );
        } catch (error) {
          if (
            !(error instanceof WorkspaceBindingConflictError) ||
            error.reason !== "legacy-name-conflict"
          ) {
            throw error;
          }
        }
      }
    }
    report = { ...report, nextPage: report.nextPage + 1 };
    await writeReport(reportPath, report, options.storageMaintenance);
  }
  report = { ...report, phase: "scenes", nextPage: 0 };
  await writeReport(reportPath, report, options.storageMaintenance);
  return report;
}

async function importScenePages(
  options: LegacyMigrationOptions,
  initial: MigrationReport,
  reportPath: string,
  abort: AbortSignal,
): Promise<MigrationReport> {
  let report = initial;
  if (report.phase === "cutover") return report;
  while (report.nextPage < report.pageCount) {
    abort.throwIfAborted();
    const page = await readSourcePage(
      options.rootDir,
      report,
      report.nextPage,
      options.storageMaintenance,
    );
    let digest = report.importSetDigest;
    for (const scene of page) {
      abort.throwIfAborted();
      const workspace = await resolveImportedWorkspace(
        options,
        report,
        scene,
        abort,
      );
      const imported = canonicalLegacyWorksceneImport({
        id: scene.id,
        name: scene.name,
        createdAt: scene.createdAt,
        ...(workspace ? { workspace } : {}),
      });
      await applyMigration(
        options.globalState,
        {
          kind: "workscene-import-legacy",
          migrationId: report.migrationId,
          sourceSnapshotToken: report.sourceSnapshotToken,
          scene: {
            id: imported.id,
            name: imported.name,
            ...(imported.workspace ? { workspace: imported.workspace } : {}),
            createdAt: imported.createdAt,
          },
        },
        `legacy-import:${report.migrationId}:${imported.id}`,
        options.anchorEpoch,
      );
      digest = worksceneImportSetDigestNext(digest, imported);
    }
    report = {
      ...report,
      nextPage: report.nextPage + 1,
      importSetDigest: digest,
    };
    await writeReport(reportPath, report, options.storageMaintenance);
  }
  report = { ...report, phase: "cutover" };
  await writeReport(reportPath, report, options.storageMaintenance);
  return report;
}

async function resolveImportedWorkspace(
  options: LegacyMigrationOptions,
  report: MigrationReport,
  scene: WorkScene,
  abort: AbortSignal,
): Promise<{ deviceId: string; bindingRef: string } | undefined> {
  if (!options.bindings || !scene.workdir) return undefined;
  try {
    const binding = await options.bindings.importLegacy(
      {
        migrationId: report.migrationId,
        sourceSnapshotToken: report.sourceSnapshotToken,
        displayName: normalizedLegacyName(scene),
        absolutePath: path.normalize(scene.workdir),
      },
      abort,
    );
    return { deviceId: options.deviceId, bindingRef: binding.bindingRef };
  } catch (error) {
    if (
      error instanceof WorkspaceBindingConflictError &&
      error.reason === "legacy-name-conflict"
    ) {
      return undefined;
    }
    throw error;
  }
}

async function abandonMigration(
  options: LegacyMigrationOptions,
  report: MigrationReport,
  reason: string,
): Promise<void> {
  const abort = options.abort ?? new AbortController().signal;
  await options.bindings?.abandonLegacy(
    {
      migrationId: report.migrationId,
      sourceSnapshotToken: report.sourceSnapshotToken,
      reason,
    },
    abort,
  );
  await applyMigration(
    options.globalState,
    {
      kind: "workscene-abandon-legacy-import",
      migrationId: report.migrationId,
      sourceSnapshotToken: report.sourceSnapshotToken,
      reason,
    },
    `legacy-abandon:${report.migrationId}`,
    options.anchorEpoch,
  );
}

async function applyMigration(
  globalState: GlobalStatePort,
  mutation: WorksceneMigrationMutation,
  requestId: string,
  anchorEpoch: number,
): Promise<void> {
  await globalState.mutate(mutation, {
    principal: { kind: "host", component: "workscene-migration-owner" },
    requestId,
    authority: { domain: "global", anchorEpoch },
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
  });
}

function normalizedLegacyName(scene: WorkScene): string {
  const name = scene.name.trim().normalize("NFKC");
  if (!name) throw new TypeError("Legacy workscene name is empty");
  return name;
}

async function readLegacySnapshot(
  governor: StorageMaintenanceGovernorPort | undefined,
  migrationId: string,
): Promise<LegacySnapshot | undefined> {
  const indexPath = getWorkSceneIndexPath();
  const rawIndex = await governedIo(
    governor,
    migrationId,
    { operation: "read-legacy-index" },
    { readBytes: 64 * 1024 * 1024, ioOperations: 1 },
    () =>
      readUtf8Bounded(indexPath, MAX_LEGACY_INDEX_BYTES).catch(
        (error: unknown) => {
          if (isMissing(error)) return undefined;
          throw error;
        },
      ),
  );
  if (rawIndex === undefined) return undefined;
  const parsed = JSON.parse(rawIndex) as { scenes?: unknown };
  if (
    !Array.isArray(parsed.scenes) ||
    parsed.scenes.some((sceneId) => typeof sceneId !== "string")
  ) {
    throw new TypeError("Legacy workscene index is malformed");
  }
  if (new Set(parsed.scenes).size !== parsed.scenes.length) {
    throw new TypeError("Legacy workscene index contains duplicate identities");
  }
  const sceneIds = [...parsed.scenes].sort((left, right) =>
    left.localeCompare(right, "en-US"),
  );
  const pageCount = Math.ceil(sceneIds.length / PAGE_SIZE);
  let digest = initialLegacySnapshotDigest(pageCount);
  for (let index = 0; index < sceneIds.length; index += PAGE_SIZE) {
    const pageNumber = index / PAGE_SIZE;
    const page = await governedIo(
      governor,
      migrationId,
      { operation: "read-legacy-snapshot-page", pageNumber },
      {
        readBytes: 64 * 1024 * 1024,
        ioOperations: PAGE_SIZE,
      },
      async () => {
        const values: WorkScene[] = [];
        for (const sceneId of sceneIds.slice(index, index + PAGE_SIZE)) {
          const raw = await readUtf8Bounded(
            path.join(getWorkSceneDir(sceneId), "meta.json"),
            MAX_LEGACY_SCENE_BYTES,
          );
          const scene = JSON.parse(raw) as WorkScene;
          validateLegacyScene(scene, sceneId);
          values.push(scene);
        }
        return values;
      },
    );
    digest = nextLegacySnapshotDigest(digest, pageNumber, page);
  }
  return { digest, sceneIds };
}

function validateLegacyScene(scene: WorkScene, expectedId: string): void {
  if (
    scene.id !== expectedId ||
    typeof scene.name !== "string" ||
    typeof scene.createdAt !== "string" ||
    typeof scene.lastActiveAt !== "string" ||
    (scene.workdir !== undefined && typeof scene.workdir !== "string")
  ) {
    throw new TypeError("Legacy workscene metadata is malformed");
  }
}

async function writeSourcePages(
  rootDir: string,
  initial: MigrationReport,
  sceneIds: readonly string[],
  governor: StorageMaintenanceGovernorPort | undefined,
): Promise<MigrationReport> {
  const directory = sourcePagesDirectory(rootDir, initial.sourceSnapshotToken);
  await governedIo(
    governor,
    initial.migrationId,
    { operation: "ensure-source-pages-directory" },
    { writeBytes: 4 * 1024, ioOperations: 2 },
    () => mkdir(directory, { recursive: true, mode: 0o700 }),
  );
  let report = initial;
  while (report.nextPage < report.pageCount) {
    const pageNumber = report.nextPage;
    const index = pageNumber * PAGE_SIZE;
    await governedIo(
      governor,
      report.migrationId,
      { operation: "write-source-page", pageNumber },
      {
        readBytes: 64 * 1024 * 1024,
        writeBytes: 64 * 1024 * 1024,
        temporaryBytes: 16 * 1024 * 1024,
        ioOperations: PAGE_SIZE + 4,
      },
      async () => {
        const page: WorkScene[] = [];
        for (const sceneId of sceneIds.slice(index, index + PAGE_SIZE)) {
          const raw = await readUtf8Bounded(
            path.join(getWorkSceneDir(sceneId), "meta.json"),
            MAX_LEGACY_SCENE_BYTES,
          );
          const scene = JSON.parse(raw) as WorkScene;
          validateLegacyScene(scene, sceneId);
          page.push(scene);
        }
        return writeAtomicJson(sourcePagePath(directory, pageNumber), page);
      },
    );
    report = { ...report, nextPage: pageNumber + 1 };
    await writeReport(
      path.join(rootDir, "workscene-legacy-migration.json"),
      report,
      governor,
    );
  }
  return report;
}

async function readSourcePage(
  rootDir: string,
  report: MigrationReport,
  pageNumber: number,
  governor: StorageMaintenanceGovernorPort | undefined,
): Promise<WorkScene[]> {
  return governedIo(
    governor,
    report.migrationId,
    { operation: "read-source-page", pageNumber },
    { readBytes: 64 * 1024 * 1024, ioOperations: 1 },
    async () => {
      const raw = await readUtf8Bounded(
        sourcePagePath(
          sourcePagesDirectory(rootDir, report.sourceSnapshotToken),
          pageNumber,
        ),
        MAX_SOURCE_PAGE_BYTES,
      );
      const page = JSON.parse(raw) as WorkScene[];
      if (!Array.isArray(page) || page.length > PAGE_SIZE) {
        throw new TypeError("Legacy workscene source page is malformed");
      }
      for (const scene of page) validateLegacyScene(scene, scene.id);
      return page;
    },
  );
}

async function finishSourceCleanup(
  rootDir: string,
  initial: MigrationReport,
  reportPath: string,
  governor: StorageMaintenanceGovernorPort | undefined,
  abort: AbortSignal,
): Promise<void> {
  let report = initial;
  while (report.nextPage < report.pageCount) {
    abort.throwIfAborted();
    const pageNumber = report.nextPage;
    await governedIo(
      governor,
      report.migrationId,
      { operation: "remove-source-page", pageNumber },
      {
        writeBytes: MAX_SOURCE_PAGE_BYTES,
        ioOperations: 1,
      },
      () =>
        rm(
          sourcePagePath(
            sourcePagesDirectory(rootDir, report.sourceSnapshotToken),
            pageNumber,
          ),
          { force: true },
        ),
    );
    report = { ...report, nextPage: pageNumber + 1 };
    await writeReport(reportPath, report, governor);
  }
  await governedIo(
    governor,
    report.migrationId,
    { operation: "remove-source-pages-directory" },
    {
      writeBytes: 4 * 1024,
      ioOperations: 1,
    },
    () =>
      rmdir(sourcePagesDirectory(rootDir, report.sourceSnapshotToken)).catch(
        (error: unknown) => {
          if (!isMissing(error)) throw error;
        },
      ),
  );
  await writeReport(
    reportPath,
    { ...report, status: "activated", phase: "cleanup" },
    governor,
  );
}

async function readFrozenSnapshotDigest(
  rootDir: string,
  report: MigrationReport,
  governor: StorageMaintenanceGovernorPort | undefined,
): Promise<Digest> {
  let digest = initialLegacySnapshotDigest(report.pageCount);
  for (let pageNumber = 0; pageNumber < report.pageCount; pageNumber += 1) {
    const page = await readSourcePage(rootDir, report, pageNumber, governor);
    digest = nextLegacySnapshotDigest(digest, pageNumber, page);
  }
  return digest;
}

function initialLegacySnapshotDigest(pageCount: number): Digest {
  return protocolDigest("LegacyWorksceneSnapshot", 3, {
    pageCount,
    pageSize: PAGE_SIZE,
  });
}

function nextLegacySnapshotDigest(
  previousDigest: Digest,
  pageNumber: number,
  page: readonly WorkScene[],
): Digest {
  return protocolDigest("LegacyWorksceneSnapshotPage", 3, {
    previousDigest,
    pageNumber,
    page,
  });
}

function sourcePagesDirectory(rootDir: string, token: string): string {
  return path.join(rootDir, "source-pages", token);
}

function sourcePagePath(directory: string, pageNumber: number): string {
  return path.join(directory, `${String(pageNumber).padStart(8, "0")}.json`);
}

async function readReport(
  target: string,
  governor: StorageMaintenanceGovernorPort | undefined,
  resourceId: string,
): Promise<MigrationReport | undefined> {
  const raw = await governedIo(
    governor,
    resourceId,
    { operation: "read-migration-report" },
    { readBytes: 64 * 1024, ioOperations: 1 },
    () =>
      readUtf8Bounded(target, MAX_REPORT_BYTES).catch((error: unknown) => {
        if (isMissing(error)) return undefined;
        throw error;
      }),
  );
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new LegacyWorksceneMigrationReportCorruptionError(
      "Legacy workscene migration report is malformed",
      { cause: error },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LegacyWorksceneMigrationReportCorruptionError(
      "Legacy workscene migration report is malformed",
    );
  }
  const report = parsed as MigrationReport;
  const expectedKeys =
    report.reason === undefined
      ? [
          "importSetDigest",
          "migrationId",
          "nextPage",
          "pageCount",
          "phase",
          "sourceDigest",
          "sourceSnapshotToken",
          "status",
          "version",
        ]
      : [
          "importSetDigest",
          "migrationId",
          "nextPage",
          "pageCount",
          "phase",
          "reason",
          "sourceDigest",
          "sourceSnapshotToken",
          "status",
          "version",
        ];
  if (
    Object.keys(report).sort().join(",") !== expectedKeys.sort().join(",") ||
    report.version !== REPORT_VERSION ||
    !["open", "activated", "abandoned"].includes(report.status) ||
    !["snapshot", "bindings", "scenes", "cutover", "cleanup"].includes(
      report.phase,
    ) ||
    typeof report.migrationId !== "string" ||
    report.migrationId.length === 0 ||
    typeof report.sourceSnapshotToken !== "string" ||
    report.sourceSnapshotToken.length === 0 ||
    !/^sha256:[0-9a-f]{64}$/u.test(report.sourceDigest) ||
    !/^sha256:[0-9a-f]{64}$/u.test(report.importSetDigest) ||
    !Number.isSafeInteger(report.nextPage) ||
    report.nextPage < 0 ||
    !Number.isSafeInteger(report.pageCount) ||
    report.pageCount < 0 ||
    report.nextPage > report.pageCount ||
    (report.reason !== undefined &&
      (typeof report.reason !== "string" || report.reason.length === 0)) ||
    (report.phase === "snapshot" &&
      report.importSetDigest !== worksceneImportSetDigest([])) ||
    (report.status === "activated" &&
      (report.phase !== "cleanup" || report.nextPage !== report.pageCount)) ||
    (report.status === "abandoned" && report.reason === undefined)
  ) {
    throw new LegacyWorksceneMigrationReportCorruptionError(
      "Legacy workscene migration report is malformed",
    );
  }
  return report;
}

async function writeReport(
  target: string,
  report: MigrationReport,
  governor: StorageMaintenanceGovernorPort | undefined,
): Promise<void> {
  await governedIo(
    governor,
    report.migrationId,
    { operation: "write-report", phase: report.phase, page: report.nextPage },
    {
      writeBytes: 64 * 1024,
      temporaryBytes: 64 * 1024,
      ioOperations: 4,
    },
    () => writeAtomicJson(target, report),
  );
}

async function writeAtomicJson(target: string, value: unknown): Promise<void> {
  const temp = `${target}.tmp`;
  const handle = await open(temp, "w", 0o600);
  try {
    await handle.writeFile(canonicalize(value), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, target);
  await syncDirectory(path.dirname(target));
}

async function readUtf8Bounded(
  target: string,
  maxBytes: number,
): Promise<string> {
  const handle = await open(target, "r");
  try {
    const metadata = await handle.stat();
    if (metadata.size > maxBytes) {
      throw new RangeError(`Legacy migration file exceeds ${maxBytes} bytes`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

interface GovernedIoCost {
  readonly readBytes?: number;
  readonly writeBytes?: number;
  readonly temporaryBytes?: number;
  readonly ioOperations: number;
}

function governedIo<T>(
  governor: StorageMaintenanceGovernorPort | undefined,
  resourceId: string,
  identity: unknown,
  cost: GovernedIoCost,
  operation: () => Promise<T>,
): Promise<T> {
  return runStorageMaintenanceStep(
    governor,
    storageMaintenanceRequest("workspace-migration", resourceId, identity, {
      obligation: "committed",
    }),
    async () => {
      if (cost.readBytes) {
        claimDeviceCapacity("readBytes", cost.readBytes);
      }
      if (cost.writeBytes) {
        claimDeviceCapacity("writeBytes", cost.writeBytes);
      }
      if (cost.temporaryBytes) {
        claimDeviceCapacity("temporaryBytes", cost.temporaryBytes);
      }
      claimDeviceCapacity("ioOperations", cost.ioOperations);
      return operation();
    },
  );
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function waitForRetry(abort: AbortSignal, delayMs: number): Promise<void> {
  if (abort.aborted) return Promise.reject(abort.reason);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      abort.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abort.reason);
    };
    abort.addEventListener("abort", onAbort, { once: true });
    timer.unref?.();
  });
}

export const LEGACY_WORKSCENE_MIGRATION_DURABLE_CONTRACT = defineDurableRuntimeContract({
  recordFamily: "legacy-workscene-migration",
  producer: "migrateLegacyWorkscenes",
  recoveryOwner: "workscene-migration-owner",
  resourceIdentity: "legacy-workscene-migration:<migrationId>",
  recoveryClass: "committed-forward-recovery",
  cases: [
    ...["open", "activated", "abandoned", "terminal-revival"].map((key) => ({ kind: "variant" as const, key })),
    { kind: "rejection", key: "source-changed", reasonCode: "WORKSCENE_MIGRATION_SOURCE_CHANGED" },
    { kind: "rejection", key: "import-set-mismatch", reasonCode: "WORKSCENE_CONFLICT" },
    { kind: "rejection", key: "post-cutover-write", reasonCode: "WORKSCENE_LEGACY_READ_ONLY" },
    ...["malformed-report", "broken-terminal"].map((key) => ({ kind: "corruption" as const, key, reasonCode: "WORKSCENE_MIGRATION_REPORT_CORRUPT" })),
    { kind: "corruption", key: "source-pages-mismatch", reasonCode: "WORKSCENE_MIGRATION_SOURCE_PAGES_CORRUPT" },
    { kind: "corruption", key: "cutover-marker-mismatch", reasonCode: "WORKSCENE_LEGACY_CUTOVER_CONFLICT" },
  ],
} as const);
