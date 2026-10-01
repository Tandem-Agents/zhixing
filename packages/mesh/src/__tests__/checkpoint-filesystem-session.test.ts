import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
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
  beforeEach(() => vi.clearAllMocks());
  it.each(["EACCES", "ETIMEDOUT", "ERR_CHILD_PROCESS_EXITED", "ERR_CHILD_PROCESS_PROTOCOL"])("retains %s until the owner is fenced", async code => {
    vi.mocked(verifyCheckpointBridgeArtifactAsync).mockResolvedValue("fixture-executable");
    let closed = false;
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), ref() {}, unref() {},
      kill() { queueMicrotask(() => { closed = true; child.emit("close", 1); }); return true; },
    });
    vi.mocked(spawn).mockReturnValue(child as any);
    const session = CheckpointDirectoryHandle.createWindowsSession(code === "ETIMEDOUT" ? 50 : 5000);
    const result = session.openPath("fixture-root", false).catch(error => ({ error, closed }));
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    if (code === "ERR_CHILD_PROCESS_EXITED") { closed = true; child.emit("close", 7, null); }
    else if (code === "ERR_CHILD_PROCESS_PROTOCOL") child.stdout.write("malformed reply\n");
    else if (code !== "ETIMEDOUT") child.emit("error", Object.assign(Error("private native path"), { code }));
    expect(await result).toMatchObject({ error: { code }, closed: true });
    if (code === "ERR_CHILD_PROCESS_EXITED") expect(await result).toMatchObject({ error: { exitCode: 7 } });
    await session.close();
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  });

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
