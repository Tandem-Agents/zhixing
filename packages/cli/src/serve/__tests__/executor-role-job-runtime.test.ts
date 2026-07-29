import type { IConfirmationBroker } from "@zhixing/core";
import type { McpHub } from "@zhixing/mcp";
import type { AgentRuntime, AgentRuntimeCapacityBinding } from "@zhixing/orchestrator/runtime";
import type { ZhixingConfig } from "@zhixing/providers";
import { describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
  createAgentRuntime: vi.fn(),
}));

vi.mock("@zhixing/orchestrator/runtime", async () => {
  const actual =
    await vi.importActual<typeof import("@zhixing/orchestrator/runtime")>(
      "@zhixing/orchestrator/runtime",
    );
  return {
    ...actual,
    createAgentRuntime: runtimeMocks.createAgentRuntime,
  };
});

const {
  ExecutorJobOwnerLifecycle,
  ExecutorRuntimeSubstrate,
} = await import("../executor-role-runtime.js");

describe("executor role job runtime production assembly", () => {
  it("constructs jobs through the scheduler runtime substrate", async () => {
    const runtime = {} as AgentRuntime;
    runtimeMocks.createAgentRuntime.mockResolvedValueOnce(runtime);
    const schedulerCapacity = {} as AgentRuntimeCapacityBinding;
    const confirmationBroker = {} as IConfirmationBroker;
    const substrate = new ExecutorRuntimeSubstrate({
      config: {} as ZhixingConfig,
      credentials: {},
      mcpHub: {
        catalog: () => [],
        callTool: vi.fn(),
      } as unknown as McpHub,
      systemProtectedPaths: ["protected"],
      interactions: {} as never,
      deviceCapacity: {
        interactive: {} as AgentRuntimeCapacityBinding,
        scheduler: schedulerCapacity,
      },
    });

    await expect(
      substrate.createJobRuntime(
        { kind: "agent-turn", prompt: "scheduled" },
        confirmationBroker,
      ),
    ).resolves.toBe(runtime);
    expect(runtimeMocks.createAgentRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmationBroker,
        deviceCapacity: schedulerCapacity,
        runtimeKind: "ephemeral",
        systemProtectedPaths: ["protected"],
      }),
    );
  });

  it("starts transport before recovery and closes the owner before transport", async () => {
    const order: string[] = [];
    const worker = {
      recover: vi.fn(async () => {
        order.push("recover");
      }),
      stopAccepting: vi.fn(() => {
        order.push("stop-accepting");
      }),
      close: vi.fn(async () => {
        order.push("worker-close");
      }),
    };
    const transport = {
      start: vi.fn(async () => {
        order.push("transport-start");
      }),
      stop: vi.fn(async () => {
        order.push("transport-stop");
      }),
    };
    const lifecycle = new ExecutorJobOwnerLifecycle(
      worker as never,
      transport as never,
    );

    await lifecycle.start();
    await lifecycle.close();
    await lifecycle.close();

    expect(order).toEqual([
      "transport-start",
      "recover",
      "stop-accepting",
      "worker-close",
      "transport-stop",
    ]);
    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(transport.stop).toHaveBeenCalledTimes(1);
  });

  it("rolls back transport and worker when recovery fails", async () => {
    const failure = new Error("recovery failed");
    const worker = {
      recover: vi.fn(async () => {
        throw failure;
      }),
      stopAccepting: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const transport = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const lifecycle = new ExecutorJobOwnerLifecycle(
      worker as never,
      transport as never,
    );

    await expect(lifecycle.start()).rejects.toBe(failure);
    expect(lifecycle.closed).toBe(true);
    expect(worker.stopAccepting).toHaveBeenCalledTimes(1);
    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(transport.stop).toHaveBeenCalledTimes(1);
  });

  it("rolls back both owners when transport startup itself fails", async () => {
    const failure = new Error("transport startup failed");
    const worker = {
      recover: vi.fn(async () => undefined),
      stopAccepting: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const transport = {
      start: vi.fn(async () => {
        throw failure;
      }),
      stop: vi.fn(async () => undefined),
    };
    const lifecycle = new ExecutorJobOwnerLifecycle(
      worker as never,
      transport as never,
    );

    await expect(lifecycle.start()).rejects.toBe(failure);
    expect(worker.recover).not.toHaveBeenCalled();
    expect(worker.stopAccepting).toHaveBeenCalledTimes(1);
    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(transport.stop).toHaveBeenCalledTimes(1);
  });
});
