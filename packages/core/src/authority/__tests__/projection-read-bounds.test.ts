// 按键投影的单次读取按段布局有界：冷重开后的一次 get、换键的 get 与一页小 scan，读量取决于增量段数与目录深度，
// 不随键总数按比例增长，也不重放权威日志。
import path from "node:path";
import { expect, it } from "vitest";
import { captureFileIo, createTempDir } from "@zhixing/test-utils";
import { AuthorityCacheIntegrity } from "../startup-proofs.js";
import { FileArtifactStore } from "../artifact-store.js";
import { FileAuthorityCommitLog } from "../commit-log.js";

const integrity = () => new AuthorityCacheIntegrity(Buffer.alloc(32, 53));
const key = (n: number) => `k/${String(n).padStart(8, "0")}`;
function register(log: FileAuthorityCommitLog) {
  log.durableProjection<{ n: number }>({
    projectionId: "read-bounds-v1", reducerVersion: 1, authenticated: true, inputs: { families: ["run:"] },
    reduce: (envelope) => envelope.entries.map((entry) => ({ kind: "put" as const, key: key(entry.body.n), value: { n: entry.body.n, pad: "x".repeat(64) } })),
  });
}

async function measure(keys: number) {
  const root = await createTempDir(`projection-read-bounds-${keys}`);
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const writer = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, { integrity: integrity() });
  register(writer);
  for (let first = 0; first < keys; first += 100)
    await writer.append(Array.from({ length: 100 }, (_, index) => ({ stream: "run:bounds", body: { n: first + index } })));
  await writer.transactDurableProjection("read-bounds-v1", async () => ({ kind: "return", value: undefined }));
  await writer.stopStorageMaintenance();
  // 冷重开：新的日志实例，同一目录与完整性密钥
  const reader = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, { integrity: integrity() });
  register(reader);
  const capture = await captureFileIo(root);
  const read = async (operation: Parameters<FileAuthorityCommitLog["transactDurableProjection"]>[1] extends (current: infer C, ...rest: never[]) => unknown
    ? (current: C) => Promise<unknown> : never) => {
    capture.reset();
    await reader.transactDurableProjection("read-bounds-v1", async (current) => ({ kind: "return", value: await operation(current) }));
    const snapshot = capture.snapshot();
    return { bytes: snapshot.readBytes, log: snapshot.byCategory.log?.readBytes ?? 0 };
  };
  const result = {
    cold: await read((current) => current.get(key(Math.floor(keys / 2)))),
    warm: await read((current) => current.get(key(Math.floor(keys / 3)))),
    scan: await read((current) => current.scan({ gte: key(Math.floor(keys / 4)), lt: "k/~" }, 10)),
  };
  await reader.stopStorageMaintenance();
  return result;
}

it("keeps a cold or warm keyed read bounded by segment layout instead of key count", async () => {
  const [small, large] = [await measure(1000), await measure(10000)];
  for (const operation of ["cold", "warm", "scan"] as const) {
    // 10 倍键数：读量不按比例增长（实测冷读约 8.7KB→21KB、换键 1.8KB→3.3KB、十条扫描 46KB→20KB）
    expect(large[operation].bytes, JSON.stringify({ small, large })).toBeLessThanOrEqual(small[operation].bytes * 3);
    // 只读日志头部与尾部的固定量，不重放 100 个以上的信封
    expect(large[operation].log, JSON.stringify({ small, large })).toBeLessThanOrEqual(8192);
  }
}, 300_000);
