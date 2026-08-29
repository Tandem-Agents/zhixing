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

type AssembledCtx = { scheduler: () => unknown };

function makeHostOptions() {
  const assembled: AssembledCtx[] = [];
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
  const baseTools = [{ name: "schedule" }];
  const options = {
    systemProtectedPaths: ["/host/credentials.json", "/host/secret-vault"],
    artifactStore: () => artifactStore,
    segmentDeps,
    extraTools: {
      taskListService: {},
      mcpHub: { catalog: vi.fn(() => []) },
      assembleTools: vi.fn((ctx: AssembledCtx) => {
        assembled.push(ctx);
        return [...baseTools];
      }),
    },
    scheduler: () => ({ marker: "facade" }),
    decorateRunBus,
    onSecurityBlocked: vi.fn(),
    turnContextProviders,
  } as never;
  return {
    options,
    assembled,
    issuedProviderSets,
    turnContextProviders,
    segmentDeps,
    decorateRunBus,
    artifactStore,
    baseTools,
  };
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
    productTools: [{ name: "product-tool" } as never],
  });
}

beforeEach(() => {
  createAgentRuntimeMock.mockReset();
  createAgentRuntimeMock.mockImplementation(async () => ({ marker: "runtime" }));
});

describe("generic conversation projection", () => {
  it("passes one frozen product projection without interpreting it", async () => {
    const { options, segmentDeps, decorateRunBus, artifactStore, baseTools } =
      makeHostOptions();
    const host = new RuntimeHost(options);
    const input = projection({ workspace: "/project", sceneId: "scope-1" });

    await host.createConversationRuntime(input);

    const params = createAgentRuntimeMock.mock.calls[0]![0];
    expect(params.segmentDeps).toBe(segmentDeps);
    expect(params.decorateRunBus).toBe(decorateRunBus);
    expect(params.artifactStore).toBe(artifactStore);
    expect(params.workspace).toBe("/project");
    expect(params.primaryRole).toBe("power");
    expect(params.runtimeIdentity).toBe(input.runtimeIdentity);
    expect(params.runtimeIdentity).toMatchObject({ sceneId: "scope-1" });
    expect(params.profile).toBe(input.profile);
    expect(params.extraTools.map((tool: { name: string }) => tool.name)).toEqual([
      ...baseTools.map((tool) => tool.name),
      "product-tool",
    ]);
    expect(params.runtimeKind).toBe("conversation");
  });

  it("preserves explicit null and undefined workspace projections", async () => {
    const { options } = makeHostOptions();
    const host = new RuntimeHost(options);

    await host.createConversationRuntime(projection({ workspace: null }));
    await host.createConversationRuntime(projection());

    expect(createAgentRuntimeMock.mock.calls[0]![0].workspace).toBeNull();
    expect(createAgentRuntimeMock.mock.calls[1]![0].workspace).toBeUndefined();
  });

  it("rejects a mutable projection before publishing a runtime", async () => {
    const { options } = makeHostOptions();
    const host = new RuntimeHost(options);
    const mutable = {
      primaryRole: "main",
      profile: mainProfile(),
      productTools: [],
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
  it("conversation / ephemeral / durable job obtain providers before publication", async () => {
    const { options, issuedProviderSets, turnContextProviders } = makeHostOptions();
    const host = new RuntimeHost(options);

    await host.createConversationRuntime(projection());
    await host.createEphemeralRuntime();
    await host.createJobRuntime({
      instruction: {} as never,
      confirmationBroker: {} as never,
    });

    expect(turnContextProviders).toHaveBeenCalledTimes(3);
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
    const { options } = makeHostOptions();
    const failure = new Error("provider assembly failed");
    options.turnContextProviders = () => {
      throw failure;
    };
    const host = new RuntimeHost(options);

    await expect(host.createConversationRuntime(projection())).rejects.toBe(failure);
    expect(createAgentRuntimeMock).not.toHaveBeenCalled();
  });
});
