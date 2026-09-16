import { describe, expect, it } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import { setupAuthorityRuntime } from "../../setup-delivery.js";
import {
  createAnchorRuntimeCapabilityCatalog,
  createAnchorRuntimeProjectionAssembly,
} from "../workscene-runtime-projection.js";
import { createAgentJobRuntimePort } from "../agent-job-runtime.js";
import type { SecretRef } from "@zhixing/core/contracts";

class MemorySecrets {
  entries = new Map<string, string>();
  async put(ref: { kind: string; bindingId: string }, value: string) {
    this.entries.set(`${ref.kind}/${ref.bindingId}`, value);
  }
  async get(ref: { kind: string; bindingId: string }) {
    return this.entries.get(`${ref.kind}/${ref.bindingId}`) ?? null;
  }
  async delete(ref: { kind: string; bindingId: string }) {
    this.entries.delete(`${ref.kind}/${ref.bindingId}`);
  }
  async list(): Promise<SecretRef[]> {
    return [];
  }
  async unlockState() {
    return "unlocked" as const;
  }
}

async function fixture() {
  let servers = ["alpha"];
  const mcpTools = {
    snapshot: () => ({
      tools: servers.map((id) => ({
        name: `mcp__${id}__lookup`,
        description: "fixture",
        inputSchema: { type: "object" as const },
        call: async () => ({ content: "fixture" }),
      })),
      serverIds: [...servers],
    }),
  };
  const extraTools = { assembleTools: () => [] } as never;
  const capabilities = createAnchorRuntimeCapabilityCatalog({
    extraTools,
    mcpTools,
    scheduler: {} as never,
  });
  const projection = createAnchorRuntimeProjectionAssembly({
    agentIdentity: { displayName: "知行" },
    capabilities,
    workscenes: {} as never,
    worksceneAssignmentTools: {} as never,
    extraTools,
    mcpTools,
    scheduler: {} as never,
    skillArtifacts: {} as never,
    createToolImplementation: () =>
      Object.freeze({ create: () => {} }) as never,
    securityExecution: {
      bind: () => Object.freeze({ create: () => {} }),
    } as never,
    createGuidanceLifecycle: () => ({ id: "fixture" }),
  });
  const schedulerCapabilities = () => projection.jobCapabilities();
  const authority = await setupAuthorityRuntime({
    zhixingHome: await createTempDir("autonomy-job-probe"),
    secretStore: new MemorySecrets(),
    executorReadiness: () => ({
      ...capabilities.capabilityCatalog(),
      credentialBindings: [],
      deviceScopedCredentialBindingIds: [],
      credentialGeneration: null,
    }),
  });
  const instruction = {
    kind: "agent-turn" as const,
    prompt: "查询并交付原任务",
  };
  const prepare = (tools?: string[]) =>
    authority.prepareJobAssignment({
      instruction: { ...instruction, ...(tools ? { tools } : {}) },
      capabilities: schedulerCapabilities(),
    });
  const issueRuntime = async (frozen: {
    tools: readonly string[];
    mcpServers: readonly string[];
  }) => {
    let seen: { tools: string[]; mcpServers: string[] } | undefined;
    const handle = await createAgentJobRuntimePort({
      create: async (request, _broker, capabilities) => {
        // Same Anchor production factory selection as command.ts. Only the model/Kernel is a fixture.
        const product = projection.job(request, capabilities);
        return {
          executionProfile: () => ({
            tools: [
              ...product.profile.enabledTools,
              ...product.runtimeTools.extraTools.map((t) => t.name),
            ],
            mcpServers: product.runtimeTools.executionMcpServers,
            providerIds: [],
          }),
          run: async () => {
            seen = {
              tools: [
                ...product.profile.enabledTools,
                ...product.runtimeTools.extraTools.map((t) => t.name),
              ],
              mcpServers: [...product.runtimeTools.executionMcpServers],
            };
            return {
              terminal: {
                reason: "completed",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "fixture" }],
                },
                usage: { inputTokens: 0, outputTokens: 0 },
              },
            };
          },
          dispose: async () => {},
        } as never;
      },
    }).create({
      taskId: "task-probe",
      jobRunId: "run-probe",
      confirmationBroker: {} as never,
      capabilities: frozen,
    });
    const generator = handle.run(instruction, {
      abortSignal: new AbortController().signal,
      onProtocolEvent: async () => {},
      authorizeToolExecution: async () => [],
      toolSideEffectObserver: {} as never,
      assignmentMutations: {} as never,
      assignmentIssuedAt: new Date().toISOString(),
    });
    await generator.next();
    await handle.dispose();
    return seen!;
  };
  return {
    prepare,
    issueRuntime,
    enableBeta: () => {
      servers = ["alpha", "beta"];
    },
    authority,
  };
}

describe("whole-module job capability probe", () => {
  it("does not sign conversation-only tools for jobs even if the device advertises them", async () => {
    const f = await fixture();
    try {
      await expect(f.prepare(["workmode_enter"])).rejects.toThrow(
        "no compatible executor",
      );
      expect(
        (await f.prepare(["read"])).policy.manifestCapabilities.tools,
      ).toEqual(["read"]);
    } finally {
      await f.authority.startupCleanup.run();
    }
  });
  it("issues new jobs from the current eligible product inventory after MCP activation", async () => {
    const f = await fixture();
    try {
      f.enableBeta();
      const prepared = await f.prepare();
      const actual = await f.issueRuntime(prepared.policy.manifestCapabilities);
      expect(prepared.policy.manifestCapabilities.tools).toContain(
        "mcp__beta__lookup",
      );
      expect(prepared.policy.manifestCapabilities.tools).not.toContain(
        "workmode_enter",
      );
      expect(prepared.policy.manifestCapabilities.mcpServers).toEqual([
        "alpha",
        "beta",
      ]);
      expect(actual.tools).toContain("mcp__beta__lookup");
      expect(actual.mcpServers).toEqual(["alpha", "beta"]);
    } finally {
      await f.authority.startupCleanup.run();
    }
  });
  it("keeps a previously issued job frozen through the production agent job bridge", async () => {
    const f = await fixture();
    try {
      const prepared = await f.prepare();
      f.enableBeta();
      const actual = await f.issueRuntime(prepared.policy.manifestCapabilities);
      expect(
        actual.tools.filter(
          (t) => !prepared.policy.manifestCapabilities.tools.includes(t),
        ),
      ).toEqual([]);
      expect(
        actual.mcpServers.filter(
          (t) => !prepared.policy.manifestCapabilities.mcpServers.includes(t),
        ),
      ).toEqual([]);
    } finally {
      await f.authority.startupCleanup.run();
    }
  });
});
