import { expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import * as persistence from "../../persistence/index.js";
import { FileDurableProjectionIndex } from "../durable-projection-index.js";
import { AuthorityCacheIntegrity } from "../startup-proofs.js";

const checkpoint = { authority: { logId: "migration-source", lsn: 0, frameEndOffset: 0, prefixDigest: "sha256:" + "0".repeat(64) } };
it("keeps published segment files after losing the manifest directory-sync response", async () => {
  const root = await createTempDir("projection-publication-response");
  const open = () => new FileDurableProjectionIndex({ rootDir: root, projectionId: "publication", reducerVersion: 1 });
  const first = open();
  await first.initialize(checkpoint);
  first.publish(await first.prepare([{ kind: "put", key: "durable", value: "kept" }]), checkpoint);
  const original = persistence.syncDirectory;
  let injected = false;
  const fault = vi.spyOn(persistence, "syncDirectory").mockImplementation(async directory => {
    if (!injected && path.resolve(directory) === path.resolve(root)) {
      const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
      if (manifest.generation === 2) { injected = true; throw new Error("injected directory-sync response loss"); }
    }
    return original(directory);
  });
  try { await first.flush({ compact: false }); }
  finally { fault.mockRestore(); await first.stopStorageMaintenance(); }
  expect(injected).toBe(true);
  const cold = open();
  try { await cold.initialize(checkpoint); expect(await cold.get("durable")).toBe("kept"); }
  finally { await cold.stopStorageMaintenance(); }
});

it("publishes a cursor-only page with one atomic manifest and no redundant file intent", async () => {
  const root = await createTempDir("projection-cursor-publication");
  const options = { rootDir: root, projectionId: "cursor", reducerVersion: 1,
    authenticated: true, integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 53)) };
  const index = new FileDurableProjectionIndex(options);
  await index.initialize(checkpoint);
  index.publish(await index.prepare([{ kind: "put", key: "kept", value: "original" }]), checkpoint);
  await index.flush({ compact: false });
  const next = { authority: { ...checkpoint.authority, lsn: 1, frameEndOffset: 100, prefixDigest: "sha256:" + "1".repeat(64) } };
  const publish = vi.spyOn(persistence, "replaceFile");
  try {
    index.coverUnchangedSource(next);
    await index.flush({ compact: false });
    expect(publish.mock.calls.map(([, destination]) => path.basename(destination))).toEqual(["manifest.json"]);
  } finally { publish.mockRestore(); await index.stopStorageMaintenance(); }
  const reopened = new FileDurableProjectionIndex(options);
  try {
    await reopened.initialize(checkpoint);
    expect(reopened.checkpoints()).toEqual(next);
    expect(await reopened.get("kept")).toBe("original");
  } finally { await reopened.stopStorageMaintenance(); }
});

it("keeps existing rows reachable when cursor-only publication loses its directory-sync response", async () => {
  const root = await createTempDir("projection-cursor-response-loss");
  const make = () => new FileDurableProjectionIndex({ rootDir: root, projectionId: "cursor-fault", reducerVersion: 1 });
  const first = make();
  await first.initialize(checkpoint);
  first.publish(await first.prepare([{ kind: "put", key: "kept", value: "original" }]), checkpoint);
  await first.flush({ compact: false });
  const next = { authority: { ...checkpoint.authority, lsn: 1, frameEndOffset: 100, prefixDigest: "sha256:" + "1".repeat(64) } };
  first.coverUnchangedSource(next);
  const original = persistence.syncDirectory;
  let injected = false;
  const fault = vi.spyOn(persistence, "syncDirectory").mockImplementation(async directory => {
    if (!injected && path.resolve(directory) === path.resolve(root)) {
      const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
      if (manifest.checkpoints.authority.lsn === 1) { injected = true; throw new Error("cursor sync response lost"); }
    }
    return original(directory);
  });
  try { await expect(first.flush({ compact: false })).rejects.toThrow("cursor sync response lost"); }
  finally { fault.mockRestore(); await first.stopStorageMaintenance(); }
  expect(injected).toBe(true);
  const reopened = make();
  try { await reopened.initialize(checkpoint); expect(reopened.checkpoints()).toEqual(next); expect(await reopened.get("kept")).toBe("original"); }
  finally { await reopened.stopStorageMaintenance(); }
});
