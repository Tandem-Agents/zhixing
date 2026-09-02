import { createTempDir } from "@zhixing/test-utils";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileWorkspaceBindingCatalogPersistence } from "./workspace-binding-catalog-persistence.js";

describe("FileWorkspaceBindingCatalogPersistence", () => {
  it("owns the canonical root and publishes exact bytes through durable CAS", async () => {
    const home = await createTempDir("workspace-binding-catalog-root");
    const persistence = new FileWorkspaceBindingCatalogPersistence({
      zhixingHome: home,
    });
    const bytes =
      '{"capabilityRevision":1,"catalogGeneration":"catalog-initial","logId":"log-a","state":"healthy","version":1}';

    await expect(persistence.load()).resolves.toBeUndefined();
    const committed = await persistence.compareAndSwap({
      expectedSnapshotToken: undefined,
      replacementBytes: bytes,
    });
    expect(committed.kind).toBe("committed");

    const root = path.join(
      home,
      "distributed-runtime",
      "workspace-bindings",
    );
    const manifestPath = path.join(root, "root-manifest.json");
    expect(await readFile(manifestPath, "utf8")).toBe(bytes);
    expect((await readdir(root)).sort()).toEqual(["root-manifest.json"]);
    if (process.platform !== "win32") {
      expect((await stat(manifestPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("serializes concurrent expected-value commits and rejects the stale writer", async () => {
    const home = await createTempDir("workspace-binding-catalog-cas");
    const persistence = new FileWorkspaceBindingCatalogPersistence({
      zhixingHome: home,
    });
    const initial = await persistence.compareAndSwap({
      expectedSnapshotToken: undefined,
      replacementBytes: '{"revision":1}',
    });
    if (initial.kind !== "committed") throw new Error("initial CAS failed");

    const outcomes = await Promise.all([
      persistence.compareAndSwap({
        expectedSnapshotToken: initial.snapshotToken,
        replacementBytes: '{"revision":2}',
      }),
      persistence.compareAndSwap({
        expectedSnapshotToken: initial.snapshotToken,
        replacementBytes: '{"revision":3}',
      }),
    ]);
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual([
      "committed",
      "conflict",
    ]);
    expect(["{\"revision\":2}", "{\"revision\":3}"]).toContain(
      (await persistence.load())?.bytes,
    );
  });
});
