import type {
  ImmediateRootResourceLease,
  ResourceReservationPort,
} from "@zhixing/core/contracts";
import { describe, expect, it, vi } from "vitest";
import { ExecutorWorkspaceAdministrationControl } from "./local-workspace-control.js";

function harness() {
  const lease: ImmediateRootResourceLease = {
    v: 1,
    reservationId: "reservation-a",
    admissionClass: "interactive",
    workload: { kind: "control", id: "environment-admin:device-a:request-a", attempt: 1 },
    scopeBinding: { kind: "control", subject: "environment-admin:device-a:request-a" },
    audience: { executorId: "executor-a" },
    budget: { maxCalls: 8 },
    domain: {
      kind: "local",
      localDomainId: "local-domain-a",
      localGovernorEpoch: 1,
    },
    issuedAt: "2026-09-02T00:00:00.000Z",
    expiry: "2026-09-02T00:00:30.000Z",
    digest: `sha256:${"0".repeat(64)}`,
    signature: {
      alg: "test",
      keyId: "test",
      sig: `sha256:${"1".repeat(64)}`,
    },
  };
  const resources = {
    acquireRoot: vi.fn(async () => lease),
    settle: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  } satisfies Pick<
    ResourceReservationPort,
    "acquireRoot" | "settle" | "release"
  >;
  return {
    lease,
    resources,
    control: new ExecutorWorkspaceAdministrationControl({
      executorId: "executor-a",
      resources,
    }),
  };
}

describe("ExecutorWorkspaceAdministrationControl", () => {
  it("acquires, settles and releases one interactive control lease", async () => {
    const { control, lease, resources } = harness();
    const abort = new AbortController().signal;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T00:00:00.000Z"));
    try {
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
          principal: { kind: "host", component: "resource-governor" },
          requestId: "environment-admin:device-a:request-a",
          deadlineAt: "2026-09-02T00:00:30.000Z",
        }),
        { executorId: "executor-a" },
      );
      expect(resources.settle).toHaveBeenCalledTimes(1);
      expect(resources.release).toHaveBeenCalledTimes(1);
      expect(resources.settle.mock.invocationCallOrder[0]).toBeLessThan(
        resources.release.mock.invocationCallOrder[0]!,
      );
    } finally {
      vi.useRealTimers();
    }
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

  it("propagates release failure after success and still releases after settle failure", async () => {
    const successful = harness();
    successful.resources.release.mockRejectedValueOnce(new Error("release failed"));
    await expect(
      successful.control.execute(
        "environment-admin:device-a:request-success",
        new AbortController().signal,
        async () => "done",
      ),
    ).rejects.toThrow("release failed");
    expect(successful.resources.settle).toHaveBeenCalledTimes(1);
    expect(successful.resources.release).toHaveBeenCalledTimes(1);

    const unsettled = harness();
    unsettled.resources.settle.mockRejectedValueOnce(new Error("settle failed"));
    await expect(
      unsettled.control.execute(
        "environment-admin:device-a:request-settle",
        new AbortController().signal,
        async () => "done",
      ),
    ).rejects.toThrow("settle failed");
    expect(unsettled.resources.release).toHaveBeenCalledTimes(1);
  });
});
