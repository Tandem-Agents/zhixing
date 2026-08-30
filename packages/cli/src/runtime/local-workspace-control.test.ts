import type { ExecutorResourceGovernor } from "@zhixing/executor";
import { describe, expect, it, vi } from "vitest";
import { ExecutorWorkspaceAdministrationControl } from "./local-workspace-control.js";

function harness() {
  const lease = { leaseId: "lease-a" };
  const resources = {
    acquireRoot: vi.fn(async () => lease),
    settle: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  };
  return {
    lease,
    resources,
    control: new ExecutorWorkspaceAdministrationControl({
      executorId: "executor-a",
      resources: resources as unknown as ExecutorResourceGovernor,
    }),
  };
}

describe("ExecutorWorkspaceAdministrationControl", () => {
  it("acquires, settles and releases one interactive control lease", async () => {
    const { control, lease, resources } = harness();
    const abort = new AbortController().signal;
    await expect(
      control.execute("environment-admin:device-a:request-a", abort, async (context) => {
        expect(context).toEqual({
          requestId: "environment-admin:device-a:request-a",
          lease,
          abort,
        });
        return "done";
      }),
    ).resolves.toBe("done");

    expect(resources.acquireRoot).toHaveBeenCalledWith(
      {
        kind: "control",
        id: "environment-admin:device-a:request-a",
        attempt: 1,
      },
      { maxCalls: 8 },
      { admissionClass: "interactive", entry: "environment-control" },
      expect.objectContaining({
        requestId: "environment-admin:device-a:request-a",
      }),
      { executorId: "executor-a" },
    );
    expect(resources.settle).toHaveBeenCalledTimes(1);
    expect(resources.release).toHaveBeenCalledTimes(1);
    expect(resources.settle.mock.invocationCallOrder[0]).toBeLessThan(
      resources.release.mock.invocationCallOrder[0]!,
    );
  });

  it("releases after an operation failure without replacing the original error", async () => {
    const { control, resources } = harness();
    resources.release.mockRejectedValueOnce(new Error("release failed"));
    await expect(
      control.execute(
        "environment-admin:device-a:request-b",
        new AbortController().signal,
        async () => {
          throw new Error("operation failed");
        },
      ),
    ).rejects.toThrow("operation failed");
    expect(resources.settle).toHaveBeenCalledTimes(1);
    expect(resources.release).toHaveBeenCalledTimes(1);
  });
});
