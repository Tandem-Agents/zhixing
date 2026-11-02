import { describe, expect, it } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import { setupAuthorityRuntime } from "../../setup-delivery.js";
import {
  createAnchorRuntimeCapabilityCatalog,
  createAnchorRuntimeProjectionAssembly,
} from "../workscene-runtime-projection.js";
import { createAgentJobRuntimePort } from "../agent-job-runtime.js";
import { createPermissionStorageInfrastructure } from "../permission-storage-infrastructure.js";
import { hostToolPermissionRuleSets } from "../../runtime/kernel-tool-implementation.js";
import { jobRunTrustScopeInput } from "@zhixing/core/trust-administration";
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
  // 写者打开日志前原子取得缓存完整性密钥：仅缺失时创建，已有值从不覆盖。
  async getOrCreate(ref: { kind: string; bindingId: string }, create: () => string) {
    const key = `${ref.kind}/${ref.bindingId}`;
    if (!this.entries.has(key)) this.entries.set(key, create());
    return this.entries.get(key)!;
  }
  async getExisting(ref: { kind: string; bindingId: string }) {
    return this.entries.get(`${ref.kind}/${ref.bindingId}`) ?? null;
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
    schedulerCapabilities,
  };
}

describe("whole-module job capability probe", () => {
  it("freezes a complete job snapshot from the production rule owner and matches it on the executor", async () => {
    const f = await fixture();
    const anchor = createPermissionStorageInfrastructure({
      zhixingHome: await createTempDir("job-snapshot-anchor"),
      persistentApprovals: true,
    });
    const executor = createPermissionStorageInfrastructure({ zhixingHome: await createTempDir("job-snapshot-executor") });
    const runtimeRequest = Object.freeze({
      extractArgument: (request: { readonly arguments: Readonly<Record<string, unknown>> }) =>
        String(request.arguments.url ?? request.arguments.command ?? ""),
      builtinRuleSets: Object.freeze([]),
      workspacePath: null,
    });
    const allow = (scope: Parameters<typeof anchor.runtime.bind>[0], kind: "allow-context" | "allow-session", argument: string) =>
      anchor.runtime.bind(scope).create(runtimeRequest).recordApproval({
        kind,
        pattern: { pattern: { tool: "bash", argument }, label: argument },
        requestId: `request:${kind}:${argument}`,
      });
    const binding = (workspaceBindingRevision: number) =>
      ({ deviceId: "device-1", bindingRef: "binding-1", workspaceBindingRevision });
    try {
      await allow({}, "allow-context", "npm test");
      // 对话运行里的会话授权只在那个运行时里：job 派发时不存在运行时，会话池为空
      await allow({}, "allow-session", "npm run lint");
      await allow({ workspace: binding(2) }, "allow-context", "npm run build");
      // 用户在主范围拒绝一个预批准站点（准备条件，不是被测提交）
      await (anchor.management as unknown as {
        createExecutionRule(context: unknown, rule: unknown): Promise<void>;
      }).createExecutionRule({ kind: "main" }, {
        id: "user-deny-npm", pattern: { tool: "web_fetch", argument: "https://npmjs.com/**" }, decision: "deny",
        scope: "context", createdAt: 1, lastMatchedAt: 0, matchCount: 0, contextId: { kind: "main" },
      });

      const asked: unknown[] = [];
      const prepared = await f.authority.prepareJobAssignment({
        instruction: { kind: "agent-turn", prompt: "查询并交付原任务", tools: ["web_fetch", "bash"] },
        capabilities: f.schedulerCapabilities(),
        // 与锚点调度器同一组合：范围由清单工作区推导，内置规则随签发工具集合
        permissionRulesFor: ({ environment, tools }) => {
          asked.push({ environment, tools });
          return anchor.executionRulesFor(jobRunTrustScopeInput(environment), hostToolPermissionRuleSets(tools));
        },
      });
      expect(asked).toEqual([{ environment: {}, tools: ["bash", "web_fetch"] }]);
      expect(prepared.environment).not.toHaveProperty("workspace");
      const frozen = prepared.policy.permissionSnapshot.rules;

      // 执行端只用已验冻结快照匹配（不并入本地规则）
      const source = executor.runtime.bind({}).create(runtimeRequest).permissionRuleSource;
      const match = (tool: string, args: Record<string, unknown>) => source.matchFrozen(frozen, {
        tool,
        arguments: args,
        context: { cwd: "/", trust: { kind: "global" }, sessionType: "ci" },
      });
      expect(match("web_fetch", { url: "https://docs.python.org/3/library/" })).toMatchObject({ scope: "builtin", decision: "allow" });
      expect(match("web_fetch", { url: "https://npmjs.com/package/left-pad" })).toMatchObject({ id: "user-deny-npm", decision: "deny" });
      expect(match("web_fetch", { url: "https://unapproved.example/x" })).toBeNull();
      expect(match("bash", { command: "npm test" })).toMatchObject({ decision: "allow", scope: "context" });
      expect(match("bash", { command: "npm run lint" })).toBeNull();
      expect(match("bash", { command: "npm run build" })).toBeNull();

      // 工具集合不含 web_fetch 时不带它的内置规则
      expect(anchor.executionRulesFor({}, hostToolPermissionRuleSets(["bash"])).some((rule) => rule.scope === "builtin"))
        .toBe(false);
      // 工作区修订隔离：同修订带上，改路径后的新修订不带
      const workspaceSource = executor.runtime.bind({ workspace: binding(2) }).create(runtimeRequest).permissionRuleSource;
      const build = { tool: "bash", arguments: { command: "npm run build" },
        context: { cwd: "/", trust: { kind: "global" as const }, sessionType: "ci" as const } };
      expect(workspaceSource.matchFrozen(anchor.executionRulesFor({ workspace: binding(2) }), build))
        .toMatchObject({ decision: "allow" });
      const repathedSource = executor.runtime.bind({ workspace: binding(3) }).create(runtimeRequest).permissionRuleSource;
      expect(repathedSource.matchFrozen(anchor.executionRulesFor({ workspace: binding(3) }), build)).toBeNull();
    } finally {
      await f.authority.startupCleanup.run();
    }
  }, 30_000);
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
  }, 30_000);
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
  }, 30_000);
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
  }, 30_000);
});
