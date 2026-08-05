import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";

const faults = vi.hoisted(() => ({
  postSyncStat: false,
  postSyncClose: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const isAuthorityWal = String(args[0]).endsWith("authority.log");
      if (!isAuthorityWal) return handle;
      let synced = false;
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === "sync") {
            return async () => {
              await target.sync();
              synced = true;
            };
          }
          if (property === "stat") {
            return async () => {
              if (synced && faults.postSyncStat) {
                throw new Error("injected post-sync stat failure");
              }
              return target.stat();
            };
          }
          if (property === "close") {
            return async () => {
              await target.close();
              if (synced && faults.postSyncClose) {
                throw new Error("injected post-sync close failure");
              }
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

import { FileArtifactStore } from "../artifact-store.js";
import { FileAuthorityCommitLog } from "../commit-log.js";

describe("FileAuthorityCommitLog post-sync boundary", () => {
  it("publishes the committed envelope without post-sync metadata I/O", async () => {
    const fixture = await createFixture();
    faults.postSyncStat = true;

    await expect(
      fixture.log.append([{ stream: "control", body: { t: "committed" } }]),
    ).resolves.toMatchObject({ lsn: 1 });
    await expect(fixture.projection.get("last")).resolves.toEqual({
      t: "committed",
    });
    await expect(fixture.log.readAll()).resolves.toHaveLength(1);
  });

  it("keeps a synced commit successful when close reports a later failure", async () => {
    const fixture = await createFixture();
    faults.postSyncClose = true;

    await expect(
      fixture.log.append([{ stream: "control", body: { t: "committed" } }]),
    ).resolves.toMatchObject({ lsn: 1 });
    await expect(fixture.projection.get("last")).resolves.toEqual({
      t: "committed",
    });
  });
});

async function createFixture() {
  faults.postSyncStat = false;
  faults.postSyncClose = false;
  const root = await createTempDir("authority-post-sync");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
    clock: () => "2026-08-05T00:00:00.000Z",
  });
  const projection = log.durableProjection({
    projectionId: "post-sync-test",
    reducerVersion: 1,
    reduce: (envelope) => envelope.entries
      .filter((entry) => entry.stream === "control")
      .map((entry) => ({ kind: "put" as const, key: "last", value: entry.body })),
  });
  return { log, projection };
}
