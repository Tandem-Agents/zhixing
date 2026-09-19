import { createTempDir } from "@zhixing/test-utils";
import { realpath } from "node:fs/promises";
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
});
