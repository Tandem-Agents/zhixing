import {
  lstat,
  open,
  opendir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { toSafePathSegment } from "@zhixing/core";
import {
  durablyRemoveDirectory,
  durablyRemoveFile,
  ensureDurableDirectory,
  syncDirectory,
} from "@zhixing/core/persistence";
import { protocolDigest } from "@zhixing/core/protocol";
import {
  claimDeviceCapacity,
  runStorageMaintenanceStep,
  storageMaintenanceRequest,
  type StorageMaintenanceGovernorPort,
} from "@zhixing/core/resources";
import type {
  WorksceneConversationStorageRemovalPort,
  WorksceneSceneStorageRemovalPort,
} from "./workscene-storage-removal.js";

const CURSOR_VERSION = 1;
const DEFAULT_PAGE_SIZE = 64;
const MAX_PAGE_SIZE = 256;
const MAX_CURSOR_BYTES = 64 * 1024;
const MAX_DIRECTORY_DEPTH = 256;

interface CleanupCursorPayload {
  readonly v: typeof CURSOR_VERSION;
  readonly targetDigest: string;
  readonly stack: readonly (readonly string[])[];
}

interface CleanupCursorRecord extends CleanupCursorPayload {
  readonly digest: string;
}

interface MutableCleanupCursor {
  v: typeof CURSOR_VERSION;
  targetDigest: string;
  stack: string[][];
}

interface CleanupTarget {
  readonly targetDigest: string;
  readonly directory: string;
  readonly boundaryDirectory: string;
  readonly cursorPath: string;
}

type CleanupStep = <T>(
  resourceIdentity: string,
  operation: () => Promise<T>,
) => Promise<T>;

interface WorksceneStorageCleanupInfrastructure {
  readonly conversations: WorksceneConversationStorageRemovalPort;
  readonly scenes: WorksceneSceneStorageRemovalPort;
}

interface WorksceneStorageCleanupOptions {
  readonly storageMaintenance?: StorageMaintenanceGovernorPort;
  readonly workscenesRoot: string;
}

/**
 * The single physical cleanup owner for system-managed workscene storage.
 *
 * Business deletion remains authoritative in the workscene/session journals.
 * This owner persists only a rebuildable traversal cursor, admits one physical
 * filesystem step at a time, and can resume after any page boundary or crash.
 */
export function createWorksceneStorageCleanupInfrastructure(input: Readonly<{
  zhixingHome: string;
  storageMaintenance?: StorageMaintenanceGovernorPort;
}>): WorksceneStorageCleanupInfrastructure {
  if (!input.zhixingHome) {
    throw new TypeError("Workscene cleanup infrastructure requires a Host home");
  }
  const workscenesRoot = path.resolve(input.zhixingHome, "workscenes");
  const cleanup = createDurableWorksceneStorageCleanup({
    workscenesRoot,
    ...(input.storageMaintenance
      ? { storageMaintenance: input.storageMaintenance }
      : {}),
  });
  return Object.freeze({
    conversations: Object.freeze({
      removeConversation: (sceneId: string, localConversationId: string) =>
        cleanup.removeConversation(sceneId, localConversationId),
    }),
    scenes: Object.freeze({
      removeScene: (sceneId: string) => cleanup.removeScene(sceneId),
    }),
  });
}

function createDurableWorksceneStorageCleanup(
  options: WorksceneStorageCleanupOptions,
): WorksceneConversationStorageRemovalPort & WorksceneSceneStorageRemovalPort {
  const runCleanupStep: CleanupStep = (resourceIdentity, operation) =>
      runStorageMaintenanceStep(
        options.storageMaintenance,
        storageMaintenanceRequest(
          "workscene-cleanup",
          resourceIdentity,
          {},
          { obligation: "committed" },
        ),
        operation,
      );
  const sceneDirectory = (sceneId: string) =>
    path.join(options.workscenesRoot, toSafePathSegment(sceneId));
  return new DurableWorksceneStorageCleanup({
    pageSize: DEFAULT_PAGE_SIZE,
    runCleanupStep,
    sceneDirectory,
    conversationDirectory: (sceneId, localConversationId) =>
      path.join(
        sceneDirectory(sceneId),
        "conversations",
        toSafePathSegment(localConversationId),
      ),
    cursorDirectory: path.join(options.workscenesRoot, ".cleanup"),
  });
}

class DurableWorksceneStorageCleanup
  implements WorksceneConversationStorageRemovalPort, WorksceneSceneStorageRemovalPort
{
  readonly #pageSize: number;
  readonly #runCleanupStep: CleanupStep;
  readonly #sceneDirectory: (sceneId: string) => string;
  readonly #conversationDirectory: (
    sceneId: string,
    localConversationId: string,
  ) => string;
  readonly #cursorDirectory: string;
  readonly #sceneChains = new Map<string, Promise<unknown>>();

  constructor(options: {
    readonly pageSize: number;
    readonly runCleanupStep: CleanupStep;
    readonly sceneDirectory: (sceneId: string) => string;
    readonly conversationDirectory: (
      sceneId: string,
      localConversationId: string,
    ) => string;
    readonly cursorDirectory: string;
  }) {
    if (
      !Number.isSafeInteger(options.pageSize) ||
      options.pageSize < 1 ||
      options.pageSize > MAX_PAGE_SIZE
    ) {
      throw new TypeError("Workscene cleanup page size is outside the supported bound");
    }
    this.#pageSize = options.pageSize;
    this.#runCleanupStep = options.runCleanupStep;
    this.#sceneDirectory = options.sceneDirectory;
    this.#conversationDirectory = options.conversationDirectory;
    this.#cursorDirectory = path.resolve(options.cursorDirectory);
  }

  removeConversation(
    sceneId: string,
    localConversationId: string,
  ): Promise<void> {
    return this.#serialize(sceneId, async () => {
      const sceneDirectory = path.resolve(this.#sceneDirectory(sceneId));
      const sceneDigest = protocolDigest("WorksceneCleanupScene", 1, { sceneId });
      const targetDigest = protocolDigest("WorksceneCleanupTarget", 1, {
          kind: "conversation",
          sceneId,
          localConversationId,
        });
      await this.#removeTarget({
        directory: this.#conversationDirectory(sceneId, localConversationId),
        boundaryDirectory: sceneDirectory,
        targetDigest,
        cursorPath: path.join(
          this.#cursorDirectory,
          "conversations",
          toSafePathSegment(sceneDigest),
          `${toSafePathSegment(targetDigest)}.json`,
        ),
      });
    });
  }

  removeScene(sceneId: string): Promise<void> {
    return this.#serialize(sceneId, async () => {
      const sceneDirectory = path.resolve(this.#sceneDirectory(sceneId));
      const sceneDigest = protocolDigest("WorksceneCleanupScene", 1, { sceneId });
      const sceneTargetDigest = protocolDigest("WorksceneCleanupTarget", 1, {
          kind: "workscene",
          sceneId,
        });
      const sceneCursorDirectory = path.join(this.#cursorDirectory, "scenes");
      await this.#removeTarget({
        directory: sceneDirectory,
        boundaryDirectory: sceneDirectory,
        targetDigest: sceneTargetDigest,
        cursorPath: path.join(
          sceneCursorDirectory,
          `${toSafePathSegment(sceneDigest)}.json`,
        ),
      });

      // A crash after the activity tombstone can make the next recovery skip
      // the per-conversation call. Retire every cursor owned by this scene
      // before the authoritative deletion is allowed to complete.
      const conversationCursorRoot = path.join(
        this.#cursorDirectory,
        "conversations",
      );
      const conversationCursorDirectory = path.join(
        conversationCursorRoot,
        toSafePathSegment(sceneDigest),
      );
      const cursorCleanupDigest = protocolDigest("WorksceneCleanupTarget", 1, {
        kind: "conversation-cursors",
        sceneId,
      });
      await this.#removeTarget({
        directory: conversationCursorDirectory,
        boundaryDirectory: conversationCursorRoot,
        targetDigest: cursorCleanupDigest,
        cursorPath: path.join(
          sceneCursorDirectory,
          `${toSafePathSegment(sceneDigest)}.cursor-gc.json`,
        ),
      });
    });
  }

  #serialize<T>(sceneId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#sceneChains.get(sceneId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.#sceneChains.set(sceneId, current);
    const cleanup = () => {
      if (this.#sceneChains.get(sceneId) === current) {
        this.#sceneChains.delete(sceneId);
      }
    };
    void current.then(cleanup, cleanup);
    return current;
  }

  async #removeTarget(target: CleanupTarget): Promise<void> {
    const targetDirectory = path.resolve(target.directory);
    assertWithinBoundary(targetDirectory, target.boundaryDirectory);
    const cursorPath = path.resolve(target.cursorPath);
    assertWithinBoundary(cursorPath, this.#cursorDirectory);
    const cursor = await this.#runCleanupStep(
      `cursor:${target.targetDigest}:read`,
      () => readCursor(cursorPath, target.targetDigest),
    );

    while (cursor.stack.length > 0) {
      for (
        let completed = 0;
        completed < this.#pageSize && cursor.stack.length > 0;
        completed += 1
      ) {
        await this.#runCleanupStep(
          `target:${target.targetDigest}:leaf`,
          () => advanceOne(targetDirectory, cursor),
        );
      }
      if (cursor.stack.length > 0) {
        await this.#runCleanupStep(
          `cursor:${target.targetDigest}:write`,
          () => writeCursor(cursorPath, cursor),
        );
      }
    }

    await this.#runCleanupStep(
      `cursor:${target.targetDigest}:complete`,
      () => durablyRemoveFile(cursorPath).then(() => undefined),
    );
  }

}

async function advanceOne(
  targetDirectory: string,
  cursor: MutableCleanupCursor,
): Promise<void> {
  const relative = cursor.stack.at(-1);
  if (!relative) return;
  const current = resolveRelative(targetDirectory, relative);
  let metadata;
  try {
    claimDeviceCapacity("ioOperations", 1);
    metadata = await lstat(current);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    cursor.stack.pop();
    return;
  }

  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    await durablyRemoveFile(current);
    cursor.stack.pop();
    return;
  }

  claimDeviceCapacity("readBytes", 4 * 1024);
  claimDeviceCapacity("ioOperations", 2);
  const directory = await opendir(current, { bufferSize: 1 });
  let entry;
  try {
    entry = await directory.read();
  } finally {
    await directory.close();
  }
  if (entry) {
    assertSafeEntryName(entry.name);
    if (relative.length >= MAX_DIRECTORY_DEPTH) {
      throw new Error("Workscene cleanup directory depth exceeds the supported bound");
    }
    cursor.stack.push([...relative, entry.name]);
    return;
  }

  const outcome = await durablyRemoveDirectory(current);
  if (outcome !== "not-empty") cursor.stack.pop();
}

async function readCursor(
  cursorPath: string,
  targetDigest: string,
): Promise<MutableCleanupCursor> {
  try {
    claimDeviceCapacity("ioOperations", 1);
    const metadata = await lstat(cursorPath);
    if (!metadata.isFile() || metadata.size > MAX_CURSOR_BYTES) {
      throw new CleanupCursorCorruptionError(
        "Workscene cleanup cursor is invalid",
      );
    }
    claimDeviceCapacity("readBytes", metadata.size);
    claimDeviceCapacity("ioOperations", 1);
    const raw = await readFile(cursorPath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CleanupCursorCorruptionError(
        "Workscene cleanup cursor is not valid JSON",
      );
    }
    return validateCursor(parsed, targetDigest);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return { v: CURSOR_VERSION, targetDigest, stack: [[]] };
    }
    if (error instanceof CleanupCursorCorruptionError) {
      await durablyRemoveFile(cursorPath);
      return { v: CURSOR_VERSION, targetDigest, stack: [[]] };
    }
    throw error;
  }
}

async function writeCursor(
  cursorPath: string,
  cursor: MutableCleanupCursor,
): Promise<void> {
  const payload: CleanupCursorPayload = {
    v: CURSOR_VERSION,
    targetDigest: cursor.targetDigest,
    stack: cursor.stack.map((segments) => [...segments]),
  };
  const record: CleanupCursorRecord = {
    ...payload,
    digest: protocolDigest("WorksceneCleanupCursor", 1, payload),
  };
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  if (bytes.byteLength > MAX_CURSOR_BYTES) {
    throw new Error("Workscene cleanup cursor exceeds the supported bound");
  }
  await ensureDurableDirectory(path.dirname(cursorPath));
  const temporary = `${cursorPath}.tmp`;
  claimDeviceCapacity("temporaryBytes", bytes.byteLength);
  claimDeviceCapacity("writeBytes", bytes.byteLength);
  claimDeviceCapacity("ioOperations", 5);
  let published = false;
  try {
    await durablyRemoveFile(temporary);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, cursorPath);
    await syncDirectory(path.dirname(cursorPath));
    published = true;
  } finally {
    if (!published) await unlink(temporary).catch(() => undefined);
  }
}

function validateCursor(
  value: unknown,
  targetDigest: string,
): MutableCleanupCursor {
  if (!isRecord(value) || !hasExactKeys(value, ["digest", "stack", "targetDigest", "v"])) {
    throw new CleanupCursorCorruptionError(
      "Workscene cleanup cursor has an invalid schema",
    );
  }
  if (
    value.v !== CURSOR_VERSION ||
    value.targetDigest !== targetDigest ||
    typeof value.digest !== "string" ||
    !Array.isArray(value.stack) ||
    value.stack.length > MAX_DIRECTORY_DEPTH + 1
  ) {
    throw new CleanupCursorCorruptionError(
      "Workscene cleanup cursor does not bind its target",
    );
  }
  const stack = value.stack.map((entry) => {
    if (!Array.isArray(entry) || entry.length > MAX_DIRECTORY_DEPTH) {
      throw new CleanupCursorCorruptionError(
        "Workscene cleanup cursor path is invalid",
      );
    }
    return entry.map((segment) => {
      if (typeof segment !== "string" || !isSafeEntryName(segment)) {
        throw new CleanupCursorCorruptionError(
          "Workscene cleanup cursor path is invalid",
        );
      }
      return segment;
    });
  });
  const payload: CleanupCursorPayload = {
    v: CURSOR_VERSION,
    targetDigest,
    stack,
  };
  if (value.digest !== protocolDigest("WorksceneCleanupCursor", 1, payload)) {
    throw new CleanupCursorCorruptionError(
      "Workscene cleanup cursor digest is invalid",
    );
  }
  return { ...payload, stack };
}

function assertWithinBoundary(candidate: string, boundaryDirectory: string): void {
  const boundary = path.resolve(boundaryDirectory);
  if (
    candidate !== boundary &&
    !candidate.startsWith(`${boundary}${path.sep}`)
  ) {
    throw new Error("Workscene cleanup path escapes its ownership boundary");
  }
}

function resolveRelative(root: string, segments: readonly string[]): string {
  const candidate = path.resolve(root, ...segments);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error("Workscene cleanup cursor escapes its target");
  }
  return candidate;
}

function assertSafeEntryName(name: string): void {
  if (!isSafeEntryName(name)) {
    throw new Error("Workscene cleanup cursor contains an unsafe path segment");
  }
}

function isSafeEntryName(name: string): boolean {
  return !(
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class CleanupCursorCorruptionError extends Error {}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
