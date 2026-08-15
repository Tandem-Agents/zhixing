import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { freezeCheckpointDirectory } from "../checkpoint-target.js";

describe("checkpoint child bridge", () => {
  it("opens an existing filesystem root and round-trips bytes through the platform helper", async () => {
    const root = await createTempDir("checkpoint-child-bridge");
    const directory = await freezeCheckpointDirectory(root, false);
    try {
      await directory.handle.writeFile("probe.bin", Buffer.from("node24", "utf8"));
      const bytes = await directory.handle.readFile("probe.bin", -1, 0, 64);
      expect(bytes.toString("utf8")).toBe("node24");
    } finally {
      await directory.handle.close();
    }
  });
});
