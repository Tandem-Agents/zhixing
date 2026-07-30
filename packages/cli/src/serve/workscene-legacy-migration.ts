import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
} from "node:fs/promises";
import path from "node:path";
import {
  getWorkSceneDir,
  getWorkSceneIndexPath,
  WorkspaceBindingConflictError,
  worksceneImportSetDigest,
  type AnchorWorksceneRegistry,
  type WorkScene,
} from "@zhixing/core";
import type {
  WorksceneDto,
  WorkspaceBindingMigrationPort,
} from "@zhixing/core/contracts";
import {
  canonicalize,
  protocolDigest,
} from "@zhixing/core/protocol";
import { syncDirectory } from "@zhixing/core/persistence";

const REPORT_VERSION = 1;

interface LegacySnapshot {
  readonly digest: string;
  readonly scenes: readonly WorkScene[];
}

interface MigrationReport {
  readonly version: typeof REPORT_VERSION;
  readonly migrationId: string;
  readonly sourceSnapshotToken: string;
  readonly sourceDigest: string;
  readonly status: "open" | "activated" | "abandoned";
  readonly scenes: readonly WorkScene[];
  readonly reason?: string;
}

export async function migrateLegacyWorkscenes(options: {
  readonly rootDir: string;
  readonly deviceId: string;
  readonly registry: AnchorWorksceneRegistry;
  readonly bindings?: WorkspaceBindingMigrationPort;
  readonly abort?: AbortSignal;
}): Promise<void> {
  const abort = options.abort ?? new AbortController().signal;
  const reportPath = path.join(options.rootDir, "workscene-legacy-migration.json");
  const initial = await readLegacySnapshot();
  if (!initial) return;

  await mkdir(options.rootDir, { recursive: true, mode: 0o700 });
  let report = await readReport(reportPath);
  if (report?.status === "activated") return;
  if (
    report?.status === "open" &&
    report.sourceDigest !== initial.digest
  ) {
    await options.bindings?.abandonLegacy(
      {
        migrationId: report.migrationId,
        sourceSnapshotToken: report.sourceSnapshotToken,
        reason: "Legacy source changed before cutover",
      },
      abort,
    );
    await options.registry.applyMigration(
      {
        kind: "workscene-abandon-legacy-import",
        migrationId: report.migrationId,
        sourceSnapshotToken: report.sourceSnapshotToken,
        reason: "Legacy source changed before cutover",
      },
      { requestId: `legacy-abandon:${report.migrationId}` },
    );
    report = { ...report, status: "abandoned", reason: "source-changed" };
    await writeReport(reportPath, report);
  }
  if (!report || report.status === "abandoned") {
    report = {
      version: REPORT_VERSION,
      migrationId: `workscene-migration:${randomUUID()}`,
      sourceSnapshotToken: randomUUID(),
      sourceDigest: initial.digest,
      status: "open",
      scenes: initial.scenes,
    };
    await writeReport(reportPath, report);
  }

  abort.throwIfAborted();
  const imports = await materializeImports(
    report,
    options.deviceId,
    options.bindings,
    abort,
  );
  for (const scene of imports) {
    abort.throwIfAborted();
    await options.registry.applyMigration(
      {
        kind: "workscene-import-legacy",
        migrationId: report.migrationId,
        sourceSnapshotToken: report.sourceSnapshotToken,
        scene: {
          id: scene.id,
          name: scene.name,
          ...(scene.workspace ? { workspace: scene.workspace } : {}),
          createdAt: scene.createdAt,
        },
      },
      { requestId: `legacy-import:${report.migrationId}:${scene.id}` },
    );
  }

  const current = await readLegacySnapshot();
  if (!current || current.digest !== report.sourceDigest) {
    await options.bindings?.abandonLegacy(
      {
        migrationId: report.migrationId,
        sourceSnapshotToken: report.sourceSnapshotToken,
        reason: "Legacy source changed before cutover",
      },
      abort,
    );
    await options.registry.applyMigration(
      {
        kind: "workscene-abandon-legacy-import",
        migrationId: report.migrationId,
        sourceSnapshotToken: report.sourceSnapshotToken,
        reason: "Legacy source changed before cutover",
      },
      { requestId: `legacy-abandon:${report.migrationId}` },
    );
    await writeReport(reportPath, {
      ...report,
      status: "abandoned",
      reason: "source-changed",
    });
    return migrateLegacyWorkscenes(options);
  }

  await options.registry.applyMigration(
    {
      kind: "workscene-activate-device-registry",
      migrationId: report.migrationId,
      sourceSnapshotToken: report.sourceSnapshotToken,
      importSetDigest: worksceneImportSetDigest(imports),
    },
    { requestId: `legacy-activate:${report.migrationId}` },
  );
  // The anchor cutover is the public authority fact. Binding activation follows
  // while startup is still closed; a crash between them replays this exact
  // activation before any serving port can observe the new registry.
  await options.bindings?.activateLegacy(
    {
      migrationId: report.migrationId,
      sourceSnapshotToken: report.sourceSnapshotToken,
    },
    abort,
  );
  await writeReport(reportPath, {
    ...report,
    status: "activated",
    scenes: [],
  });
}

async function materializeImports(
  report: MigrationReport,
  deviceId: string,
  bindings: WorkspaceBindingMigrationPort | undefined,
  abort: AbortSignal,
): Promise<WorksceneDto[]> {
  const grouped = new Map<string, WorkScene[]>();
  for (const scene of report.scenes) {
    if (!scene.workdir) continue;
    const key = path.normalize(scene.workdir);
    const group = grouped.get(key) ?? [];
    group.push(scene);
    grouped.set(key, group);
  }
  const candidateNames = workspaceNameCandidates(grouped);
  const workspaceByPath = new Map<
    string,
    { deviceId: string; bindingRef: string }
  >();
  if (!bindings) {
    return [...report.scenes]
      .sort((left, right) => left.id.localeCompare(right.id, "en-US"))
      .map((scene) => ({
        id: scene.id,
        revision: 1,
        name: scene.name,
        createdAt: scene.createdAt,
        lastActiveAt: scene.lastActiveAt,
      }));
  }
  const orderedPaths = [...grouped].sort((left, right) => {
    const leftScene = [...left[1]].sort((a, b) =>
      a.id.localeCompare(b.id, "en-US")
    )[0]!;
    const rightScene = [...right[1]].sort((a, b) =>
      a.id.localeCompare(b.id, "en-US")
    )[0]!;
    return (
      leftScene.id.localeCompare(rightScene.id, "en-US") ||
      left[0].localeCompare(right[0], "en-US")
    );
  });
  for (const [absolutePath] of orderedPaths) {
    for (const displayName of candidateNames.get(absolutePath) ?? []) {
      try {
        const binding = await bindings.importLegacy(
          {
            migrationId: report.migrationId,
            sourceSnapshotToken: report.sourceSnapshotToken,
            displayName,
            absolutePath,
          },
          abort,
        );
        workspaceByPath.set(absolutePath, {
          deviceId,
          bindingRef: binding.bindingRef,
        });
        break;
      } catch (error) {
        if (!(error instanceof WorkspaceBindingConflictError)) throw error;
      }
    }
  }

  return [...report.scenes]
    .sort((left, right) => left.id.localeCompare(right.id, "en-US"))
    .map((scene): WorksceneDto => {
      const imported: WorksceneDto = {
        id: scene.id,
        revision: 1,
        name: scene.name,
        createdAt: scene.createdAt,
        lastActiveAt: scene.lastActiveAt,
      };
      const workspace = scene.workdir
        ? workspaceByPath.get(path.normalize(scene.workdir))
        : undefined;
      if (workspace) {
        imported.workspace = workspace;
      }
      return imported;
    });
}

function workspaceNameCandidates(
  groups: ReadonlyMap<string, readonly WorkScene[]>,
): Map<string, readonly string[]> {
  const result = new Map<string, readonly string[]>();
  for (const [absolutePath, scenes] of groups) {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const scene of [...scenes].sort((left, right) =>
      left.id.localeCompare(right.id, "en-US")
    )) {
      const name = scene.name.trim().normalize("NFKC");
      const key = name.toLocaleLowerCase("en-US");
      if (!name || seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }
    result.set(absolutePath, names);
  }
  return result;
}

async function readLegacySnapshot(): Promise<LegacySnapshot | undefined> {
  const indexPath = getWorkSceneIndexPath();
  if (!(await exists(indexPath))) return undefined;
  const rawIndex = await readFile(indexPath, "utf8");
  const parsed = JSON.parse(rawIndex) as { scenes?: unknown };
  if (
    !Array.isArray(parsed.scenes) ||
    parsed.scenes.some((sceneId) => typeof sceneId !== "string")
  ) {
    throw new TypeError("Legacy workscene index is malformed");
  }
  const scenes: WorkScene[] = [];
  const source: unknown[] = [JSON.parse(rawIndex)];
  for (const sceneId of parsed.scenes) {
    const metaPath = path.join(getWorkSceneDir(sceneId), "meta.json");
    const raw = await readFile(metaPath, "utf8");
    const scene = JSON.parse(raw) as WorkScene;
    validateLegacyScene(scene, sceneId);
    scenes.push(scene);
    source.push(scene);
  }
  return {
    digest: protocolDigest("LegacyWorksceneSnapshot", 1, source),
    scenes,
  };
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

async function readReport(target: string): Promise<MigrationReport | undefined> {
  if (!(await exists(target))) return undefined;
  const report = JSON.parse(await readFile(target, "utf8")) as MigrationReport;
  if (
    report.version !== REPORT_VERSION ||
    !["open", "activated", "abandoned"].includes(report.status) ||
    typeof report.migrationId !== "string" ||
    typeof report.sourceSnapshotToken !== "string" ||
    typeof report.sourceDigest !== "string" ||
    !Array.isArray(report.scenes)
  ) {
    throw new TypeError("Legacy workscene migration report is malformed");
  }
  return report;
}

async function writeReport(target: string, report: MigrationReport): Promise<void> {
  const temp = `${target}.tmp`;
  const handle = await open(temp, "w", 0o600);
  try {
    await handle.writeFile(canonicalize(report), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, target);
  await syncDirectory(path.dirname(target));
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    (error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return false;
      }
      throw error;
    },
  );
}
