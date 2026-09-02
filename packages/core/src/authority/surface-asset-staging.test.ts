import { describe, expect, it, vi } from "vitest";
import type { ArtifactRef } from "../contracts/index.js";
import { projectSurfaceAssetStagingPorts } from "./surface-asset-staging.js";

const REF: ArtifactRef = {
  digest: `sha256:${"a".repeat(64)}`,
  bytes: 3,
};

describe("Surface asset staging ports", () => {
  it("projects required frozen upload, recovery, and presence exact-sets", async () => {
    const cursor = {
      next: vi.fn(async () => ({ references: [], done: true })),
      close: vi.fn(async () => undefined),
    };
    const presenceCursor = {
      next: vi.fn(async () => ({ entries: [], done: true })),
      close: vi.fn(async () => undefined),
    };
    const receiver = {
      progress: vi.fn(async () => ({ receivedBytes: 0, complete: false })),
      append: vi.fn(async () => ({ receivedBytes: 1, complete: false })),
      discard: vi.fn(async () => true),
      openPartialReferenceCursor: vi.fn(() => cursor),
      visitPartialReferences: vi.fn(),
      rootDir: "must-not-cross-the-port",
    };
    const presence = {
      mark: vi.fn(async () => undefined),
      has: vi.fn(async () => true),
      removeScopes: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      openReconciliationCursor: vi.fn(() => presenceCursor),
      hasLegacyMigration: vi.fn(async () => false),
      beginLegacyMigration: vi.fn(async () => undefined),
      finishLegacyMigration: vi.fn(async () => undefined),
      visitReferences: vi.fn(),
      rootDir: "must-not-cross-the-port",
    };

    const ports = projectSurfaceAssetStagingPorts(receiver, presence);

    expect(Object.keys(ports)).toEqual(["upload", "recovery", "presence"]);
    expect(Object.keys(ports.upload)).toEqual(["progress", "append", "discard"]);
    expect(Object.keys(ports.recovery)).toEqual([
      "progress",
      "openPartialReferenceCursor",
    ]);
    expect(Object.keys(ports.presence)).toEqual([
      "mark",
      "has",
      "removeScopes",
      "remove",
      "openReconciliationCursor",
      "hasLegacyMigration",
      "beginLegacyMigration",
      "finishLegacyMigration",
    ]);
    expect(Object.isFrozen(ports)).toBe(true);
    expect(Object.isFrozen(ports.upload)).toBe(true);
    expect(Object.isFrozen(ports.recovery)).toBe(true);
    expect(Object.isFrozen(ports.presence)).toBe(true);

    await ports.upload.append(REF, 0, Uint8Array.of(1));
    await ports.recovery.progress(REF);
    expect(ports.recovery.openPartialReferenceCursor()).toBe(cursor);
    await ports.presence.mark(REF, "surface:one");
    expect(ports.presence.openReconciliationCursor()).toBe(presenceCursor);
    expect(receiver.append).toHaveBeenCalledOnce();
    expect(receiver.progress).toHaveBeenCalledOnce();
    expect(presence.mark).toHaveBeenCalledOnce();
  });

  it("fails closed before projecting incomplete mechanisms", () => {
    expect(() =>
      Reflect.apply(projectSurfaceAssetStagingPorts, undefined, [{}, {}])
    ).toThrow("Surface asset staging receiver lacks progress");
  });
});
