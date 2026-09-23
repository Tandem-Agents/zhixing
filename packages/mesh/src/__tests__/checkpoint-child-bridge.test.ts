import { createTempDir } from "@zhixing/test-utils";
import { realpath, open } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freezeCheckpointDirectory } from "../checkpoint-target.js";

describe("checkpoint child bridge", () => {
  it("opens an existing filesystem root and round-trips bytes through the platform helper", async () => {
    const root = await realpath(await createTempDir("checkpoint-child-bridge"));
    const directory = await freezeCheckpointDirectory(root, false);
    try {
      await directory.handle.writeFile("probe.bin", Buffer.from("node24", "utf8"));
      const bytes = await directory.handle.readFile("probe.bin", -1, 0, 64);
      expect(bytes.toString("utf8")).toBe("node24");
      expect(await directory.handle.listEntries(10)).toEqual(["probe.bin"]);
      expect(await directory.handle.listEntries(10)).toEqual(["probe.bin"]);
      await directory.handle.renameTo("probe.bin", directory.handle, "renamed.bin");
      expect(await directory.handle.listEntries(10)).toEqual(["renamed.bin"]);
      await directory.handle.sync();
      await directory.handle.unlink("renamed.bin", false);
      expect(await directory.handle.listEntries(10)).toEqual([]);
    } finally {
      await directory.handle.close();
    }
  });

  it("uses a fixed OS lock and confirms truncation with an external reader still open", async () => {
    const root = await realpath(await createTempDir("checkpoint-log-primitives"));
    const directory = await freezeCheckpointDirectory(root, false);
    let release: (() => Promise<void>) | undefined;
    try {
      release = await directory.handle.tryLock("writer.lock"); expect(release).toBeDefined();
      expect(await directory.handle.tryLock("writer.lock")).toBeUndefined();
      await directory.handle.writeFile("retired.jsonl", Buffer.alloc(8192)); await directory.handle.sync();
      const identity = await directory.handle.statFile("retired.jsonl");
      const reader = await open(path.join(root, "retired.jsonl"), "r");
      try {
        await directory.handle.truncateFile("retired.jsonl", identity.identity, 0);
        expect((await reader.stat()).size).toBe(0);
        await directory.handle.removeRetired("retired.jsonl", identity.identity); await directory.handle.sync();
        expect(await directory.handle.listEntries(10)).not.toContain("retired.jsonl");
      } finally { await reader.close(); }
      await release(); release = undefined;
      release = await directory.handle.tryLock("writer.lock"); expect(release).toBeDefined();
    } finally { await release?.(); await directory.handle.close(); }
  });
});
