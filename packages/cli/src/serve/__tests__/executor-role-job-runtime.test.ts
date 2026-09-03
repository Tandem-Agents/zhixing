import type { ArtifactStore, IConfirmationBroker } from "@zhixing/core";
import type { AgentRuntime, AgentRuntimeCapacityBinding } from "@zhixing/orchestrator/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectRuntimeConfiguration } from "../../runtime/runtime-configuration-projections.js";
import { createRuntimeConfigurationSnapshot } from "../../runtime/runtime-configuration-snapshot.js";

const runtimeMocks = vi.hoisted(() => ({
  createAgentRuntime: vi.fn(),
  modelProviderCreate: vi.fn((input) => ({ kind: "model", input })),
  runtimeEnvironmentCreate: vi.fn((input) => ({ kind: "environment", input })),
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

vi.mock("../../runtime/kernel-runtime-bindings.js", () => ({
  createHostKernelModelProviderFactory: () => ({
    create: runtimeMocks.modelProviderCreate,
  }),
  createHostKernelRuntimeEnvironmentFactory: () => ({
    create: runtimeMocks.runtimeEnvironmentCreate,
  }),
}));

const {
  ExecutorJobOwnerLifecycle,
  ExecutorRuntimeSubstrate,
} = await import("../executor-role-runtime.js");

const toolImplementation = Object.freeze({ create: vi.fn() }) as never;
const permissionStorage = Object.freeze({ create: vi.fn() }) as never;
const deviceRemovalLifecycle = Object.freeze({}) as never;

beforeEach(() => {
  runtimeMocks.createAgentRuntime.mockReset();
  runtimeMocks.modelProviderCreate.mockClear();
  runtimeMocks.runtimeEnvironmentCreate.mockClear();
});

describe("executor role conversation runtime production assembly", () => {
  it("forwards explicit workscene identity and keeps ordinary workspace runtimes in main mode", async () => {
    const runtime = {} as AgentRuntime;
    runtimeMocks.createAgentRuntime.mockResolvedValue(runtime);
    const configuration = projectRuntimeConfiguration(
      createRuntimeConfigurationSnapshot({}),
    );
    const substrate = new ExecutorRuntimeSubstrate({
      modelConfiguration: configuration.model,
      kernelEnvironmentConfiguration: configuration.kernelEnvironment,
      credentials: {},
      toolImplementation,
      permissionStorage,
      mcpTools: { snapshot: () => ({ tools: [], serverIds: [] }) },
      systemProtectedPaths: ["protected"],
      interactions: {} as never,
      artifactStore: () => ({} as ArtifactStore),
      deviceCapacity: {
        interactive: {} as AgentRuntimeCapacityBinding,
        scheduler: {} as AgentRuntimeCapacityBinding,
        orchestration: {} as AgentRuntimeCapacityBinding,
      },
    });

    await substrate.createConversationRuntime(
      "/scene-workspace",
      "ws:scene-a:primary",
    );
    expect(runtimeMocks.createAgentRuntime).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        primaryRole: "power",
      }),
    );
    expect(runtimeMocks.modelProviderCreate).toHaveBeenNthCalledWith(1, {
      primaryRole: "power",
    });
    expect(runtimeMocks.runtimeEnvironmentCreate).toHaveBeenNthCalledWith(1, {
      workspace: "/scene-workspace",
    });
    const worksceneIdentity = runtimeMocks.createAgentRuntime.mock.calls[0]![0]
      .runtimeIdentity;
    expect(worksceneIdentity).toMatchObject({ sceneId: "scene-a" });
    expect(Object.isFrozen(worksceneIdentity)).toBe(true);

    await substrate.createConversationRuntime(
      "/ordinary-workspace",
      "ordinary-conversation",
    );
    const mainParams = runtimeMocks.createAgentRuntime.mock.calls[1]![0];
    expect(runtimeMocks.modelProviderCreate).toHaveBeenNthCalledWith(2, {
      primaryRole: "main",
    });
    expect(runtimeMocks.runtimeEnvironmentCreate).toHaveBeenNthCalledWith(2, {
      workspace: "/ordinary-workspace",
    });
    expect(mainParams.runtimeIdentity).toBeUndefined();
    expect(mainParams.primaryRole).toBeUndefined();
  });
});

describe("executor role job runtime production assembly", () => {
  it("capability catalog 与用户 job 工具选择都不再接受旧 memory 工具", () => {
    const configuration = projectRuntimeConfiguration(
      createRuntimeConfigurationSnapshot({}),
    );
    const substrate = new ExecutorRuntimeSubstrate({
      modelConfiguration: configuration.model,
      kernelEnvironmentConfiguration: configuration.kernelEnvironment,
      credentials: {},
      toolImplementation,
      permissionStorage,
      mcpTools: { snapshot: () => ({ tools: [], serverIds: [] }) },
      systemProtectedPaths: ["protected"],
      interactions: {} as never,
      artifactStore: () => ({} as ArtifactStore),
      deviceCapacity: {
        interactive: {} as AgentRuntimeCapacityBinding,
        scheduler: {} as AgentRuntimeCapacityBinding,
        orchestration: {} as AgentRuntimeCapacityBinding,
      },
    });

    expect(substrate.capabilityCatalog().tools).not.toContain("memory");
    expect(() => substrate.createJobRuntime(
      { kind: "agent-turn", prompt: "scheduled", tools: ["memory"] },
      {} as IConfirmationBroker,
    )).toThrow("Job requested unavailable tools: memory");
    expect(runtimeMocks.createAgentRuntime).not.toHaveBeenCalled();
  });

  it("constructs jobs through the scheduler runtime substrate", async () => {
    const runtime = {} as AgentRuntime;
    runtimeMocks.createAgentRuntime.mockResolvedValueOnce(runtime);
    const schedulerCapacity = {} as AgentRuntimeCapacityBinding;
    const orchestrationCapacity = {} as AgentRuntimeCapacityBinding;
    const artifactStore = {} as ArtifactStore;
    const confirmationBroker = {} as IConfirmationBroker;
    const configuration = projectRuntimeConfiguration(
      createRuntimeConfigurationSnapshot({}),
    );
    const substrate = new ExecutorRuntimeSubstrate({
      modelConfiguration: configuration.model,
      kernelEnvironmentConfiguration: configuration.kernelEnvironment,
      credentials: {},
      toolImplementation,
      permissionStorage,
      mcpTools: { snapshot: () => ({ tools: [], serverIds: [] }) },
      systemProtectedPaths: ["protected"],
      interactions: {} as never,
      artifactStore: () => artifactStore,
      deviceCapacity: {
        interactive: {} as AgentRuntimeCapacityBinding,
        scheduler: schedulerCapacity,
        orchestration: orchestrationCapacity,
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
        artifactStore,
        deviceCapacity: schedulerCapacity,
        orchestrationCapacity,
        runtimeKind: "ephemeral",
        systemProtectedPaths: ["protected"],
      }),
    );
    expect(runtimeMocks.modelProviderCreate).toHaveBeenCalledWith({
      primaryRole: "main",
    });
    expect(runtimeMocks.runtimeEnvironmentCreate).toHaveBeenCalledWith({});
  });

  it("makes the owner ready before transport recovery and closes it before transport", async () => {
    const order: string[] = [];
    const owner = {
      start: vi.fn(async () => {
        order.push("owner-ready");
      }),
      recoverAcceptedWorkForLifecycle: vi.fn(async () => {
        order.push("recover");
      }),
      resumeAccepting: vi.fn(() => {
        order.push("owner-resume");
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
      resumeAcceptingAfterLifecycle: vi.fn(() => {
        order.push("transport-resume");
      }),
      stop: vi.fn(async () => {
        order.push("transport-stop");
      }),
    };
    const lifecycle = new ExecutorJobOwnerLifecycle(
      owner as never,
      transport as never,
    );

    await lifecycle.start({ deviceRemovalLifecycle });
    await lifecycle.close();
    await lifecycle.close();

    expect(order).toEqual([
      "owner-ready",
      "transport-start",
      "recover",
      "owner-resume",
      "transport-resume",
      "stop-accepting",
      "worker-close",
      "transport-stop",
    ]);
    expect(owner.close).toHaveBeenCalledTimes(1);
    expect(transport.stop).toHaveBeenCalledTimes(1);
  });

  it("rolls back transport and worker when recovery fails", async () => {
    const failure = new Error("recovery failed");
    const owner = {
      start: vi.fn(async () => undefined),
      recoverAcceptedWorkForLifecycle: vi.fn(async () => {
        throw failure;
      }),
      resumeAccepting: vi.fn(),
      stopAccepting: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const transport = {
      start: vi.fn(async () => undefined),
      resumeAcceptingAfterLifecycle: vi.fn(),
      stop: vi.fn(async () => undefined),
    };
    const lifecycle = new ExecutorJobOwnerLifecycle(
      owner as never,
      transport as never,
    );

    await expect(lifecycle.start({ deviceRemovalLifecycle })).rejects.toBe(failure);
    expect(lifecycle.closed).toBe(true);
    expect(owner.stopAccepting).toHaveBeenCalledTimes(1);
    expect(owner.close).toHaveBeenCalledTimes(1);
    expect(transport.stop).toHaveBeenCalledTimes(1);
  });

  it("passes the same closed lifecycle projection to transport and job owner", async () => {
    const owner = {
      start: vi.fn(async () => undefined),
      recoverAcceptedWorkForLifecycle: vi.fn(async () => undefined),
      resumeAccepting: vi.fn(),
      stopAccepting: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const transport = {
      start: vi.fn(async () => undefined),
      resumeAcceptingAfterLifecycle: vi.fn(),
      stop: vi.fn(async () => undefined),
    };
    const lifecycle = new ExecutorJobOwnerLifecycle(owner as never, transport as never);

    await lifecycle.start({
      deviceRemovalLifecycle,
      admissionClosed: true,
      recoverAcceptedWork: false,
    });

    expect(owner.start).toHaveBeenCalledWith({
      admissionClosed: true,
      recoverAcceptedWork: false,
    });
    expect(transport.start).toHaveBeenCalledWith({
      deviceRemovalLifecycle,
      lifecycleAdmissionClosed: true,
      recoverAcceptedWork: false,
    });
    await lifecycle.close();
  });

  it("rolls back both owners when transport startup itself fails", async () => {
    const failure = new Error("transport startup failed");
    const owner = {
      start: vi.fn(async () => undefined),
      recoverAcceptedWorkForLifecycle: vi.fn(async () => undefined),
      resumeAccepting: vi.fn(),
      stopAccepting: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const transport = {
      start: vi.fn(async () => {
        throw failure;
      }),
      resumeAcceptingAfterLifecycle: vi.fn(),
      stop: vi.fn(async () => undefined),
    };
    const lifecycle = new ExecutorJobOwnerLifecycle(
      owner as never,
      transport as never,
    );

    await expect(lifecycle.start({ deviceRemovalLifecycle })).rejects.toBe(failure);
    expect(owner.start).toHaveBeenCalledOnce();
    expect(owner.stopAccepting).toHaveBeenCalledTimes(1);
    expect(owner.close).toHaveBeenCalledTimes(1);
    expect(transport.stop).toHaveBeenCalledTimes(1);
  });
});
