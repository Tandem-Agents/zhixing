import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.hoisted(() => vi.fn());

vi.mock("../process-identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../process-identity.js")>();
  return {
    ...actual,
    createProcessIdentityResolver: () => actual.createProcessIdentityResolver({
      platform: "win32",
      execute,
      probe: () => "present",
    }),
  };
});

describe("FileLock default process identity resolver", () => {
  beforeEach(() => {
    vi.resetModules();
    execute.mockReset();
  });

  it("reads the successful self birth once across independent acquisitions", async () => {
    execute.mockResolvedValue("638907060300000000");
    const { acquireFileLock } = await import("../file-lock.js");
    const root = await createTempDir("file-lock-default-resolver");

    const releaseFirst = await acquireFileLock(path.join(root, "first.lock"), {
      staleMs: 30_000,
      waitMs: 1_000,
    });
    await releaseFirst();
    const releaseSecond = await acquireFileLock(path.join(root, "second.lock"), {
      staleMs: 30_000,
      waitMs: 1_000,
    });
    await releaseSecond();

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not cache an unavailable self birth", async () => {
    execute
      .mockRejectedValueOnce(new Error("identity unavailable"))
      .mockResolvedValue("638907060300000001");
    const { acquireFileLock } = await import("../file-lock.js");
    const root = await createTempDir("file-lock-default-retry");

    await expect(acquireFileLock(path.join(root, "first.lock"), {
      staleMs: 30_000,
      waitMs: 1_000,
    })).rejects.toThrow(/identity is unavailable/u);
    const release = await acquireFileLock(path.join(root, "second.lock"), {
      staleMs: 30_000,
      waitMs: 1_000,
    });
    await release();

    expect(execute).toHaveBeenCalledTimes(2);
  });
});
