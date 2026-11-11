import {
  ImmediateRootReplayTerminalError,
  type ImmediateRootResourceLease,
  type ResourceReservationPort,
} from "@zhixing-ai/core/contracts";
import { WorkspaceControlAttemptSpentError } from "@zhixing-ai/core/environment/workspace-administration";
import { describe, expect, it, vi } from "vitest";
import { ExecutorWorkspaceAdministrationControl, LocalWorkspaceResidualRootPendingError } from "./local-workspace-control.js";

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
    acquireRoot: vi.fn<ResourceReservationPort["acquireRoot"]>(async () => lease),
    settle: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    inspectImmediateRoot: vi.fn<ResourceReservationPort["inspectImmediateRoot"]>(
      async () => ({ kind: "absent" }),
    ),
    reclaimExpired: vi.fn(async () => 0),
  } satisfies Pick<
    ResourceReservationPort,
    "acquireRoot" | "settle" | "release" | "inspectImmediateRoot"
  > & { reclaimExpired(): Promise<number> };
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
        control.execute({ requestId: "environment-admin:device-a:request-a" }, abort, async (context) => {
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
        { requestId: "environment-admin:device-a:request-b" },
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
        { requestId: "environment-admin:device-a:request-success" },
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
        { requestId: "environment-admin:device-a:request-settle" },
        new AbortController().signal,
        async () => "done",
      ),
    ).rejects.toThrow("settle failed");
    expect(unsettled.resources.release).toHaveBeenCalledTimes(1);
  });

  it("主体超过治理器调用标识上限时只换调用标识，资源根与控制上下文的主体不变", async () => {
    const { control, resources } = harness();
    const requestId = `environment-admin:device-a:${"x".repeat(240)}`;
    let seen: string | undefined;
    await control.execute({ requestId, attempt: 1 }, new AbortController().signal, async (context) => {
      seen = context.requestId;
      return "done";
    });
    const [workload, , , context] = resources.acquireRoot.mock.calls[0]!;
    expect(workload.id).toBe(requestId);
    expect(seen).toBe(requestId);
    expect(context.requestId).toMatch(/^environment-admin-call:sha256:[0-9a-f]{64}$/u);
    expect(resources.settle.mock.calls[0]![1]).toBe(context);
  });

  it("一次性请求不核对资源根，按尝试 1 取根", async () => {
    const { control, resources } = harness();
    await control.execute({ requestId: "environment-admin:device-a:once" }, new AbortController().signal, async () => "done");
    expect(resources.inspectImmediateRoot).not.toHaveBeenCalled();
    expect(resources.acquireRoot.mock.calls[0]![0]).toEqual({
      kind: "control",
      id: "environment-admin:device-a:once",
      attempt: 1,
    });
  });

  it("耐久尝试的根没取过或仍在排队时沿用该尝试（排队项由这次取根消化）", async () => {
    for (const inspection of [
      { kind: "absent" as const },
      { kind: "queued" as const, reservationId: "reservation-queued" },
    ]) {
      const { control, resources } = harness();
      resources.inspectImmediateRoot.mockResolvedValueOnce(inspection);
      await expect(control.execute(
        { requestId: "environment-admin:device-a:durable", attempt: 3 },
        new AbortController().signal,
        async () => "done",
      )).resolves.toBe("done");
      expect(resources.inspectImmediateRoot).toHaveBeenCalledWith({
        kind: "control",
        id: "environment-admin:device-a:durable",
        attempt: 3,
      });
      expect(resources.acquireRoot.mock.calls[0]![0]).toMatchObject({ attempt: 3 });
    }
  });

  it("耐久尝试的根已被用过时先收敛残留再报用尽，不在该尝试下执行", async () => {
    const operation = vi.fn(async () => "never");
    const cases = [
      { state: "active" as const, settle: 1, release: 1 },
      { state: "settled" as const, settle: 0, release: 1 },
      { state: "released" as const, settle: 0, release: 0 },
      { state: "reclaimed" as const, settle: 0, release: 0 },
    ];
    for (const item of cases) {
      const { control, resources, lease } = harness();
      resources.inspectImmediateRoot.mockResolvedValueOnce({ kind: "reservation", state: item.state, lease });
      await expect(control.execute(
        { requestId: "environment-admin:device-a:durable", attempt: 2 },
        new AbortController().signal,
        operation,
      )).rejects.toBeInstanceOf(WorkspaceControlAttemptSpentError);
      expect(resources.settle).toHaveBeenCalledTimes(item.settle);
      expect(resources.release).toHaveBeenCalledTimes(item.release);
      expect(resources.acquireRoot).not.toHaveBeenCalled();
    }
    // 已出队；残留收敛失败（如租约已过期）不挡推进，交治理器到期回收
    const dequeued = harness();
    dequeued.resources.inspectImmediateRoot.mockResolvedValueOnce({ kind: "dequeued", reason: "expired" });
    await expect(dequeued.control.execute(
      { requestId: "environment-admin:device-a:durable", attempt: 2 },
      new AbortController().signal,
      operation,
    )).rejects.toThrow("资源根已出队（expired）");
    const expired = harness();
    expired.resources.inspectImmediateRoot.mockResolvedValueOnce({ kind: "reservation", state: "active", lease: expired.lease });
    expired.resources.settle.mockRejectedValueOnce(new TypeError("Executor resource lease is expired or replaced"));
    await expect(expired.control.execute(
      { requestId: "environment-admin:device-a:durable", attempt: 2 },
      new AbortController().signal,
      operation,
    )).rejects.toMatchObject({ code: "LOCAL_WORKSPACE_CONTROL_ATTEMPT_SPENT", attempt: 2 });
    expect(operation).not.toHaveBeenCalled();
  });

  it("残留根收束失败：租约未过期原样抛出；已过期按治理器到期回收并确认终态，仍未终态则不推进", async () => {
    const live = harness();
    const fresh = { ...live.lease, expiry: new Date(Date.now() + 10 * 60_000).toISOString() };
    live.resources.inspectImmediateRoot.mockResolvedValueOnce({ kind: "reservation", state: "active", lease: fresh });
    const unknown = new Error("disk unavailable");
    live.resources.settle.mockRejectedValueOnce(unknown);
    await expect(live.control.execute(
      { requestId: "environment-admin:device-a:durable", attempt: 2 },
      new AbortController().signal,
      async () => "never",
    )).rejects.toBe(unknown);
    expect(live.resources.reclaimExpired).not.toHaveBeenCalled();
    // 临近到期的残留：调用期限不超过租约到期
    const near = harness();
    const nearLease = { ...near.lease, expiry: new Date(Date.now() + 5_000).toISOString() };
    near.resources.inspectImmediateRoot.mockResolvedValueOnce({ kind: "reservation", state: "active", lease: nearLease });
    await expect(near.control.execute({ requestId: "environment-admin:device-a:durable", attempt: 2 }, new AbortController().signal, async () => "never"))
      .rejects.toBeInstanceOf(WorkspaceControlAttemptSpentError);
    expect(Date.parse(near.resources.settle.mock.calls[0]![1].deadlineAt)).toBeLessThanOrEqual(Date.parse(nearLease.expiry));

    const expired = harness();
    expired.resources.inspectImmediateRoot
      .mockResolvedValueOnce({ kind: "reservation", state: "active", lease: expired.lease })
      .mockResolvedValueOnce({ kind: "reservation", state: "reclaimed", lease: expired.lease });
    expired.resources.settle.mockRejectedValueOnce(new TypeError("Executor resource lease is expired or replaced"));
    await expect(expired.control.execute({ requestId: "environment-admin:device-a:durable", attempt: 2 }, new AbortController().signal, async () => "never"))
      .rejects.toMatchObject({ code: "LOCAL_WORKSPACE_CONTROL_ATTEMPT_SPENT", message: expect.stringContaining("已被回收") });
    expect(expired.resources.reclaimExpired).toHaveBeenCalledOnce();

    const pending = harness();
    pending.resources.inspectImmediateRoot.mockResolvedValue({ kind: "reservation", state: "active", lease: pending.lease });
    pending.resources.settle.mockRejectedValueOnce(new TypeError("Executor resource lease is expired or replaced"));
    await expect(pending.control.execute({ requestId: "environment-admin:device-a:durable", attempt: 2 }, new AbortController().signal, async () => "never"))
      .rejects.toBeInstanceOf(LocalWorkspaceResidualRootPendingError);
    expect(pending.resources.acquireRoot).not.toHaveBeenCalled();
  });

  it("取根时治理器判为重放终态，耐久尝试报用尽、一次性请求原样抛出", async () => {
    const durable = harness();
    const terminal = new ImmediateRootReplayTerminalError({ kind: "reservation", state: "released", lease: durable.lease });
    durable.resources.acquireRoot.mockRejectedValueOnce(terminal);
    await expect(durable.control.execute(
      { requestId: "environment-admin:device-a:durable", attempt: 1 },
      new AbortController().signal,
      async () => "never",
    )).rejects.toMatchObject({ code: "LOCAL_WORKSPACE_CONTROL_ATTEMPT_SPENT", message: expect.stringContaining("资源根已释放") });
    const once = harness();
    once.resources.acquireRoot.mockRejectedValueOnce(terminal);
    await expect(once.control.execute(
      { requestId: "environment-admin:device-a:once" },
      new AbortController().signal,
      async () => "never",
    )).rejects.toBe(terminal);
  });
});
