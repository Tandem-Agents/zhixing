/**
 * SnapshotStore 契约：每快照一文件、写读往返保真、降序列出、读容错。
 */

import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { SnapshotStore } from "../store.js";

let convDir: string;
let store: SnapshotStore;

beforeEach(async () => {
  const tmp = await createTempDir("snapshot-store");
  convDir = path.join(tmp, "conversations");
  store = new SnapshotStore(convDir, { platform: "linux" });
});

const input = (covered: number) => ({
  coveredThroughRunIndex: covered,
  structuredSummary: { facts: `f${covered}`, state: "s", active: "a" },
  tokensBefore: 1000,
  tokensAfter: 100,
});

describe("SnapshotStore", () => {
  it("写读往返保真；每快照一个独立文件", async () => {
    const written = await store.write("c1", input(5));
    expect(written.version).toBe(1);
    expect(written.conversationId).toBe("c1");
    expect(written.createdAt).toBeTruthy();

    const files = await fs.readdir(path.join(convDir, "c1", "snapshots"));
    expect(files).toHaveLength(1);

    const listed = await store.list("c1");
    expect(listed).toEqual([written]);
  });

  it("list 按 createdAt 降序（最新在前）", async () => {
    const a = await store.write("c2", input(1));
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.write("c2", input(2));

    const listed = await store.list("c2");
    expect(listed.map((s) => s.coveredThroughRunIndex)).toEqual([
      b.coveredThroughRunIndex,
      a.coveredThroughRunIndex,
    ]);
  });

  it("坏文件跳过（读容错）；目录不存在返回空", async () => {
    expect(await store.list("none")).toEqual([]);

    await store.write("c3", input(1));
    await fs.writeFile(
      path.join(convDir, "c3", "snapshots", "broken.json"),
      "{ not json",
      "utf-8",
    );
    const listed = await store.list("c3");
    expect(listed).toHaveLength(1);
    expect(listed[0]!.coveredThroughRunIndex).toBe(1);
  });
});
