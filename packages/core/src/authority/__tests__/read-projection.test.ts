import { expect, it, vi, onTestFinished } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import path from "node:path";
import { readFile, writeFile, rename, utimes, stat, appendFile, unlink } from "node:fs/promises";
import { acquireFileLock } from "../../persistence/file-lock.js";
import { FileAuthorityCommitLog } from "../commit-log.js";
import { FileArtifactStore } from "../artifact-store.js";
async function fixture() {
  const root = await createTempDir("read-projection");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts);
  onTestFinished(() => log.stopStorageMaintenance());
  return { log, artifacts };
}
it("reads an unchanged durable projection without a writer claim and sees the next peer commit", async () => {
  const { log, artifacts } = await fixture();
  await log.append([{ stream: "control", body: { value: 1 } }]);
  const reduce = (state: number) => state + 1;
  const first = await log.readProjection(0, reduce, { stream: "control" });
  const transact = vi.spyOn(log, "transactProjection");
  const release = await acquireFileLock(path.join(log.rootDir, ".commit-log.lock"), { staleMs: 30_000, waitMs: 100 });
  try {
    expect(await log.readProjection(first.state, reduce, { stream: "control", cursor: first.cursor })).toMatchObject({ state: 1, lastLsn: 1 });
    expect(transact).not.toHaveBeenCalled();
  } finally { await release(); }
  const peer = new FileAuthorityCommitLog(log.rootDir, artifacts);
  onTestFinished(() => peer.stopStorageMaintenance());
  await peer.append([{ stream: "control", body: { value: 2 } }]);
  const next = await log.readProjection(first.state, reduce, { stream: "control", cursor: first.cursor });
  expect(next).toMatchObject({ state: 2, lastLsn: 2 });
  expect(transact).toHaveBeenCalledOnce();
  await log.append([{ stream: "control", body: { value: 3 } }]);
  expect(await log.readProjection(next.state, reduce, { stream: "control", cursor: next.cursor })).toMatchObject({ state: 3, lastLsn: 3 });
});
it.each(["corrupt", "replacement", "missing", "partial"])("read-only projection never trusts changed %s bytes", async mode => {
  const { log } = await fixture();
  await log.append([{ stream: "control", body: { text: "original" } }]);
  const first = await log.readProjection(0, state => state + 1);
  const transact = vi.spyOn(log, "transactProjection");
  const metadata = await stat(log.logPath);
  if (mode === "partial") await appendFile(log.logPath, Buffer.from([1, 2, 3]));
  else if (mode === "missing") await unlink(log.logPath);
  else {
    const bytes = await readFile(log.logPath);
    bytes[bytes.indexOf(Buffer.from("original"))] ^= 1;
    if (mode === "replacement") {
      await writeFile(log.logPath + ".replacement", bytes);
      await rename(log.logPath + ".replacement", log.logPath);
    } else await writeFile(log.logPath, bytes);
    await utimes(log.logPath, metadata.atime, metadata.mtime);
  }
  const read = log.readProjection(first.state, state => state + 1, { cursor: first.cursor });
  if (mode === "partial") await expect(read).resolves.toMatchObject({ state: 1, lastLsn: 1 });
  else await expect(read).rejects.toBeInstanceOf(Error);
  expect(transact).toHaveBeenCalledOnce();
});
