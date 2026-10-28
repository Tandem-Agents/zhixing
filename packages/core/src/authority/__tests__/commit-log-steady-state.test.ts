import { expect, it, onTestFinished, vi } from "vitest";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { FileArtifactStore } from "../artifact-store.js";
import { FileAuthorityCommitLog } from "../commit-log.js";
import { AuthorityCacheIntegrity } from "../startup-proofs.js";
import * as verified from "../verified-wal-view.js";
import * as wal from "../wal-frame.js";

async function fixture(authenticated: boolean) {
  const root = await createTempDir("commit-log-steady-state");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const integrity = authenticated ? new AuthorityCacheIntegrity(Buffer.alloc(32, 23)) : undefined;
  const create = () => {
    const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts,
      authenticated ? { startupProofs: true, integrity } : {});
    onTestFinished(() => log.stopStorageMaintenance());
    return log;
  };
  return { create };
}

/** 一次操作里按路径读日志文件版本的次数与文件头解码次数。 */
async function measure(operation: () => Promise<unknown>) {
  const versions = vi.spyOn(verified, "readWalVersion");
  const headers = vi.spyOn(wal, "decodeAuthorityWalFileHeader");
  try {
    await operation();
    return { pathVersions: versions.mock.calls.filter(([file]) => typeof file === "string").length, headers: headers.mock.calls.length };
  } finally { versions.mockRestore(); headers.mockRestore(); }
}

it("认证日志稳态：文件版本与已核验尾部一致时每次操作只按路径读一次元数据、不重读文件头", async () => {
  const { create } = await fixture(true);
  const log = create();
  await log.append([{ stream: "control", body: { value: 1 } }]);
  await log.append([{ stream: "control", body: { value: 2 } }]);
  await log.checkpoint();
  expect(await measure(() => log.checkpoint())).toEqual({ pathVersions: 1, headers: 0 });
  // 追加本身也不为文件头或同一份元数据多开文件
  expect((await measure(() => log.append([{ stream: "control", body: { value: 3 } }]))).headers).toBe(0);
  expect((await log.readStream<{ value: number }>("control")).map(record => record.body.value)).toEqual([1, 2, 3]);
}, 30_000);

it("认证日志的文件版本变化（另一实例追加）后重新读文件头并采纳新尾部", async () => {
  const { create } = await fixture(true);
  const log = create();
  await log.append([{ stream: "control", body: { value: 1 } }]);
  await log.checkpoint();
  const peer = create();
  await peer.append([{ stream: "control", body: { value: 2 } }]);
  const measured = await measure(() => log.checkpoint());
  expect(measured.headers).toBe(1);
  expect((await log.readStream<{ value: number }>("control")).map(record => record.body.value)).toEqual([1, 2]);
}, 30_000);

it("非认证日志照旧每次操作重读文件头", async () => {
  const { create } = await fixture(false);
  const log = create();
  await log.append([{ stream: "control", body: { value: 1 } }]);
  await log.checkpoint();
  expect((await measure(() => log.checkpoint())).headers).toBe(1);
}, 30_000);
