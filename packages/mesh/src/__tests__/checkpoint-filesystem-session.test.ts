import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { verifyCheckpointBridgeArtifactAsync } from "../checkpoint-bridge-artifact.js";
import { CheckpointDirectoryHandle } from "../checkpoint-child-bridge.js";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(() => {
    throw Error("Unexpected late native owner");
  }),
}));
vi.mock("../checkpoint-bridge-artifact.js", async (original) => ({
  ...(await original<typeof import("../checkpoint-bridge-artifact.js")>()),
  verifyCheckpointBridgeArtifactAsync: vi.fn(),
}));

describe.skipIf(process.platform !== "win32")("owned filesystem startup", () => {
  it("does not spawn when artifact verification finishes after close", async () => {
    let complete!: (path: string) => void;
    vi.mocked(verifyCheckpointBridgeArtifactAsync).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const session = CheckpointDirectoryHandle.createWindowsSession();
    const opening = session.openPath("unused-fixture-root", false).then(
      () => {
        throw Error("Closed session opened a directory");
      },
      (error: Error) => error,
    );
    await vi.waitFor(() => expect(verifyCheckpointBridgeArtifactAsync).toHaveBeenCalledOnce());
    let settled = false;
    const closing = session.close().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    complete("unused-fixture-executable");
    await closing;
    expect((await opening).message).toContain("closed");
    expect(spawn).not.toHaveBeenCalled();
    expect(session.failed).toBe(true);
  });
});
