/** RuntimeHost owns generic assembly only; product decisions arrive frozen. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mainProfile } from "@zhixing/orchestrator/profile";
import { createKernelRuntimeIdentityContribution } from "@zhixing/orchestrator/runtime";

const { createAgentRuntimeMock } = vi.hoisted(() => ({
  createAgentRuntimeMock: vi.fn(),
}));

vi.mock("@zhixing/orchestrator/runtime", async (orig) => {
  const actual = await orig<typeof import("@zhixing/orchestrator/runtime")>();
  return { ...actual, createAgentRuntime: createAgentRuntimeMock };
});

const { RuntimeHost } = await import("@zhixing/runtime-host/runtime-host");
const { createConversationRuntimeProjection } = await import(
  "@zhixing/runtime-host/conversation-runtime-projection"
);
const { createRuntimeToolProjection } = await import(
  "@zhixing/runtime-host/conversation-runtime-projection"
);

function makeHostOptions() {
  const issuedProviderSets: Array<readonly unknown[]> = [];
  const turnContextProviders = vi.fn(() => {
    const providers = Object.freeze([
      { id: "scheduler", shouldInject: () => false, render: () => ({ title: "", body: "" }) },
      { id: "task-list", shouldInject: () => false, render: () => ({ title: "", body: "" }) },
    ]);
    issuedProviderSets.push(providers);
    return providers;
  });
  const segmentDeps = { marker: "segment-deps" };
  const decorateRunBus = () => () => {};
  const artifactStore = { marker: "artifact-store" };
  const modelBinding = Object.freeze({ marker: "model-binding" });
  const runtimeEnvironment = Object.freeze({ marker: "runtime-environment" });
  const modelProvider = Object.freeze({
    create: vi.fn(() => modelBinding),
  });
  const runtimeEnvironmentFactory = Object.freeze({
    create: vi.fn(() => runtimeEnvironment),
  });
  const toolImplementation = Object.freeze({ create: vi.fn() });
  const deviceCapacity = {
    interactive: { kind: "interactive" },
    scheduler: { kind: "scheduler" },
    orchestration: { kind: "orchestration" },
  };
  const options = {
    modelProvider,
    runtimeEnvironment: runtimeEnvironmentFactory,
    toolImplementation,
    systemProtectedPaths: ["/host/credentials.json", "/host/secret-vault"],
    artifactStore: () => artifactStore,
    segmentDeps,
    deviceCapacity,
    decorateRunBus,
    onSecurityBlocked: vi.fn(),
    turnContextProviders,
  } as never;
  return {
    options,
    issuedProviderSets,
    turnContextProviders,
    segmentDeps,
    decorateRunBus,
    artifactStore,
    modelBinding,
    modelProvider,
    runtimeEnvironment,
    runtimeEnvironmentFactory,
    toolImplementation,
    deviceCapacity,
  };
}

function runtimeTools(
  names: readonly string[] = ["schedule", "product-tool"],
  mcpServers: readonly string[] = ["alpha"],
) {
  return createRuntimeToolProjection({
    extraTools: names.map((name) => ({ name }) as never),
    executionMcpServers: mcpServers,
  });
}

function runtimeProfile() {
  const profile = mainProfile();
  return Object.freeze({
    ...profile,
    constraints: Object.freeze([...profile.constraints]),
    enabledTools: Object.freeze([...profile.enabledTools]),
    ...(profile.capabilities
      ? { capabilities: Object.freeze({ ...profile.capabilities }) }
      : {}),
  });
}

function projection(overrides: {
  workspace?: string | null;
  sceneId?: string;
} = {}) {
  return createConversationRuntimeProjection({
    ...(Object.hasOwn(overrides, "workspace")
      ? { workspace: overrides.workspace }
      : {}),
    primaryRole: overrides.sceneId ? "power" : "main",
    profile: mainProfile({ hasWorkspace: overrides.workspace !== null }),
    ...(overrides.sceneId
      ? {
          runtimeIdentity: createKernelRuntimeIdentityContribution(
            overrides.sceneId,
          ),
        }
      : {}),
    runtimeTools: runtimeTools(),
  });
}

beforeEach(() => {
  createAgentRuntimeMock.mockReset();
  createAgentRuntimeMock.mockImplementation(async () => ({ marker: "runtime" }));
});

describe("generic conversation projection", () => {
  it("passes one frozen product projection without interpreting it", async () => {
    const {
      options,
      segmentDeps,
      decorateRunBus,
      artifactStore,
      modelBinding,
      modelProvider,
      runtimeEnvironment,
      runtimeEnvironmentFactory,
      toolImplementation,
    } =
      makeHostOptions();
    const host = new RuntimeHost(options);
    const input = projection({ workspace: "/project", sceneId: "scope-1" });

    await host.createConversationRuntime(input);

    const params = createAgentRuntimeMock.mock.calls[0]![0];
    expect(params.segmentDeps).toBe(segmentDeps);
    expect(params.decorateRunBus).toBe(decorateRunBus);
    expect(params.artifactStore).toBe(artifactStore);
    expect(params.toolImplementation).toBe(toolImplementation);
    expect(modelProvider.create).toHaveBeenCalledWith({ primaryRole: "power" });
    expect(runtimeEnvironmentFactory.create).toHaveBeenCalledWith({
      workspace: "/project",
    });
    expect(params.modelProvider).toBe(modelBinding);
    expect(params.runtimeEnvironment).toBe(runtimeEnvironment);
    expect(params.primaryRole).toBe("power");
    expect(params.runtimeIdentity).toBe(input.runtimeIdentity);
    expect(params.runtimeIdentity).toMatchObject({ sceneId: "scope-1" });
    expect(params.profile).toBe(input.profile);
    expect(params.extraTools).toEqual(input.runtimeTools.extraTools);
    expect(params.executionMcpServers).toBe(
      input.runtimeTools.executionMcpServers,
    );
    expect(params.runtimeKind).toBe("conversation");
  });

  it("preserves explicit null and undefined workspace projections", async () => {
    const { options } = makeHostOptions();
    const host = new RuntimeHost(options);

    await host.createConversationRuntime(projection({ workspace: null }));
    await host.createConversationRuntime(projection());

    expect(options.runtimeEnvironment.create).toHaveBeenNthCalledWith(1, {
      workspace: null,
    });
    expect(options.runtimeEnvironment.create).toHaveBeenNthCalledWith(2, {});
  });

  it("rejects a mutable projection before publishing a runtime", async () => {
    const { options } = makeHostOptions();
    const host = new RuntimeHost(options);
    const mutable = {
      primaryRole: "main",
      profile: runtimeProfile(),
      runtimeTools: { extraTools: [], executionMcpServers: [] },
    } as never;

    await expect(host.createConversationRuntime(mutable)).rejects.toThrow(
      "Conversation runtime projection must be immutable",
    );
    expect(createAgentRuntimeMock).not.toHaveBeenCalled();
  });

  it("rejects a structurally similar identity without Kernel provenance", async () => {
    const { options } = makeHostOptions();
    const host = new RuntimeHost(options);
    const invalid = Object.freeze({
      ...projection(),
      runtimeIdentity: Object.freeze({ sceneId: "scope-1" }),
    }) as never;

    await expect(host.createConversationRuntime(invalid)).rejects.toThrow(
      "Kernel runtime identity contribution is invalid",
    );
    expect(createAgentRuntimeMock).not.toHaveBeenCalled();
  });
});

describe("shared assembly inputs", () => {
  it("rejects an extended or duplicate product tool projection before publication", async () => {
    const { options } = makeHostOptions();
    const host = new RuntimeHost(options);
    const extended = Object.freeze({
      ...runtimeTools(["schedule"]),
      productMetadata: "forbidden",
    }) as never;

    await expect(host.createEphemeralRuntime(extended)).rejects.toThrow(
      "Runtime tool projection must be finite and immutable",
    );
    expect(() => runtimeTools(["schedule", "schedule"])).toThrow(
      "Runtime tool projection contains an invalid or duplicate tool",
    );
    expect(createAgentRuntimeMock).not.toHaveBeenCalled();
  });

  it("conversation / ephemeral / durable job obtain providers before publication", async () => {
    const {
      options,
      issuedProviderSets,
      modelProvider,
      runtimeEnvironmentFactory,
      turnContextProviders,
    } = makeHostOptions();
    const host = new RuntimeHost(options);

    await host.createConversationRuntime(projection());
    await host.createEphemeralRuntime(runtimeTools(["schedule"]));
    await host.createJobRuntime({
      confirmationBroker: {} as never,
      profile: runtimeProfile(),
      runtimeTools: runtimeTools(["task_list"]),
    });

    expect(turnContextProviders).toHaveBeenCalledTimes(3);
    expect(modelProvider.create).toHaveBeenCalledTimes(3);
    expect(runtimeEnvironmentFactory.create).toHaveBeenCalledTimes(3);
    expect(issuedProviderSets).toHaveLength(3);
    expect(new Set(issuedProviderSets).size).toBe(3);
    for (const [index, providers] of issuedProviderSets.entries()) {
      expect(Object.isFrozen(providers)).toBe(true);
      expect(providers.map((provider) => (provider as { id: string }).id)).toEqual([
        "scheduler",
        "task-list",
      ]);
      expect(createAgentRuntimeMock.mock.calls[index]![0].turnContextProviders).toBe(
        providers,
      );
    }
  });

  it("provider factory failure does not publish a runtime", async () => {
    const { options, modelProvider } = makeHostOptions();
    const failure = new Error("provider assembly failed");
    modelProvider.create.mockImplementationOnce(() => {
      throw failure;
    });
    const host = new RuntimeHost(options);

    await expect(host.createConversationRuntime(projection())).rejects.toBe(failure);
    expect(createAgentRuntimeMock).not.toHaveBeenCalled();
  });

  it("forwards the product-selected job profile while preserving model and capacity binding", async () => {
    const { options, deviceCapacity, modelBinding, modelProvider } =
      makeHostOptions();
    const host = new RuntimeHost(options);
    const profile = runtimeProfile();

    await host.createJobRuntime({
      confirmationBroker: {} as never,
      profile,
      runtimeTools: runtimeTools(["schedule"]),
      modelOverride: "job-model",
    });

    const params = createAgentRuntimeMock.mock.calls[0]![0];
    expect(params.profile).toBe(profile);
    expect(modelProvider.create).toHaveBeenCalledWith({
      primaryRole: "main",
      mainModelOverride: "job-model",
    });
    expect(params.modelProvider).toBe(modelBinding);
    expect(params.deviceCapacity).toBe(deviceCapacity.scheduler);
    expect(params.orchestrationCapacity).toBe(deviceCapacity.orchestration);
  });
});
