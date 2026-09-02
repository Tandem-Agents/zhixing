import type { DataPlaneTicket } from "@zhixing/core/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  AssignmentDataPlaneTopologyAdapter,
  type AssignmentDataPlaneTarget,
} from "./assignment-data-plane-topology.js";

const ticket = { ticketId: "ticket-1" } as DataPlaneTicket;

describe("AssignmentDataPlaneTopologyAdapter", () => {
  it("projects the local mechanism through the same finite target contract", async () => {
    const acceptTicket = vi.fn(async () => undefined);
    const authorize = vi.fn(async () => undefined);
    const answer = vi.fn(async () => undefined);
    const ownerStream = { subscribe: vi.fn(), acknowledge: vi.fn() };
    const surfaceStream = { subscribe: vi.fn(), acknowledge: vi.fn() };
    const adapter = new AssignmentDataPlaneTopologyAdapter({
      local: {
        executorId: "executor-local",
        ownerDeviceId: "device-owner",
        transport: {
          acceptTicket,
          authorizeOwnerPresentedSurface: authorize,
          ownerStreamClient: () => ownerStream as never,
          surfaceStreamClient: () => surfaceStream as never,
        },
        interactions: {
          answerInteractionWithTicket: answer,
          resolveNoInteractiveSurface: vi.fn(async () => undefined),
        },
      },
    });

    const target = adapter.targetForExecutor("executor-local");
    await target.acceptTicket(ticket);
    await target.answerChannel({
      assignmentId: "assignment-1",
      requestId: "request-1",
      ticketId: "ticket-1",
      surfacePrincipal: "surface:channel",
      decision: { kind: "deny", reason: "denied" },
    });

    expect(acceptTicket).toHaveBeenCalledWith(ticket);
    expect(authorize).toHaveBeenCalledWith(
      "ticket-1",
      "interact",
      "assignment-1",
    );
    expect(answer).toHaveBeenCalledWith(expect.objectContaining({
      decision: { kind: "deny", reason: "denied" },
    }));
    expect(target.ownerStream()).toBe(ownerStream);
    expect(target.directSurfaceStream("surface:channel")).toBe(surfaceStream);
  });

  it("selects the remote mechanism without changing the upper target contract", () => {
    const remote = target();
    const remoteDataPlaneTarget = vi.fn(() => remote);
    const adapter = new AssignmentDataPlaneTopologyAdapter({
      remote: { remoteDataPlaneTarget },
    });

    expect(adapter.targetForExecutor("executor-remote")).toBe(remote);
    expect(remoteDataPlaneTarget).toHaveBeenCalledWith("executor-remote");
  });

  it("fails closed when no mechanism owns the requested executor", () => {
    const adapter = new AssignmentDataPlaneTopologyAdapter({});
    expect(() => adapter.targetForExecutor("executor-missing")).toThrow(
      /unavailable/u,
    );
  });
});

function target(): AssignmentDataPlaneTarget {
  return {
    acceptTicket: vi.fn(async () => undefined),
    answerChannel: vi.fn(async () => undefined),
    resolveNoInteractiveSurface: vi.fn(async () => undefined),
    ownerStream: vi.fn(),
    directSurfaceStream: vi.fn(),
  } as never;
}
