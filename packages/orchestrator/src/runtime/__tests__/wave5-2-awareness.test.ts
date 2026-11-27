import { describe, expect, it } from "vitest";
import { createEventBus } from "@zhixing-ai/core/events";
import { createLogQueryTools } from "@zhixing-ai/core/logging/application";
import { MockLLMProvider } from "@zhixing-ai/core/loop";
import { loadOrchestrationDefinitionV1, type OrchestrationSystemCapsV1 } from "@zhixing-ai/core/orchestration";
import {
  bindPermissionRuleExecutionSource,
  PermissionStore,
  toPermissionContext,
} from "@zhixing-ai/core/security";
import {
  userMessage,
  type AgentEventMap,
  type ChatRequest,
  type LLMRole,
  type ToolDefinition,
} from "@zhixing-ai/core/types";
import { createAgentRuntime } from "../create-agent-runtime.js";
import { createKernelModelProviderBinding } from "../kernel-model-provider.js";
import { createKernelRuntimeEnvironment } from "../kernel-runtime-environment.js";
import type { KernelSecurityExecutionFactory } from "../kernel-security-execution.js";
import type { KernelToolImplementationPort } from "../kernel-tool-implementation.js";
import { createKernelWindowPromptProjection } from "../kernel-window-prompt.js";
import { createKernelLogFactory } from "../logging.js";
import { runContextStorage, type RunContext } from "../run-context.js";

function createStubToolImplementation(): KernelToolImplementationPort {
  return Object.freeze({
    create: ({ requestedToolNames }) =>
      Object.freeze({
        tools: Object.freeze(
          requestedToolNames.map(
            (name): ToolDefinition => ({
              name,
              description: `stub ${name}`,
              inputSchema: { type: "object" },
              isReadOnly: name === "skill_read" || name === "runtime_inspect",
              boundaries: [{ boundaryType: "process", access: "read", dynamic: false }],
              call: async () => ({ content: `${name} ok` }),
            }),
          ),
        ),
        permissionRuleSets: Object.freeze([]),
      }),
  });
}

function createTestSecurityExecution(): KernelSecurityExecutionFactory {
  return Object.freeze({
    create(request) {
      const store = new PermissionStore({
        rootDir: null,
        extractArgument: request.extractArgument,
      });
      for (const contribution of request.builtinRuleSets) {
        store.registerBuiltinRules(contribution.namespace, [...contribution.rules]);
      }
      const contextId = Object.freeze(toPermissionContext({ kind: "main" }));
      return Object.freeze({
        contextId,
        trustContext: Object.freeze({ kind: "global" }),
        permissionRuleSource: bindPermissionRuleExecutionSource(store, contextId),
        persistentApprovals: true,
        recordApproval(approval) {
          if (approval.kind === "allow-once") {
            return Object.freeze({ kind: "recorded" as const });
          }
          const scope =
            approval.kind === "allow-session"
              ? "session"
              : approval.kind === "allow-context"
                ? "context"
                : "global";
          const rule = PermissionStore.createRule({
            pattern: approval.pattern.pattern,
            decision: "allow",
            scope,
            ...(scope === "context" ? { contextId } : {}),
          });
          store.create(contextId, rule);
          return Object.freeze({ kind: "rule-created" as const, rule });
        },
        securitySnapshot() {
          return Object.freeze({
            contextId,
            workspacePath: request.workspacePath,
            permissionRules: Object.freeze(store.list(contextId)),
            confirmations: Object.freeze([]),
          });
        },
        executionPermissionRules() {
          return Object.freeze(store.snapshot(contextId));
        },
      });
    },
  });
}

function createBinding(
  mainProvider: MockLLMProvider,
  lightProvider?: MockLLMProvider,
) {
  const makeRole = (provider: MockLLMProvider, model: string): LLMRole => ({
    provider,
    model,
    chat: (request) => provider.chat(request),
  });
  const mainRole = makeRole(mainProvider, "mock-main");
  const lightRole = lightProvider ? makeRole(lightProvider, "mock-light") : mainRole;
  return createKernelModelProviderBinding({
    primaryRole: "main",
    roles: {
      main: mainRole,
      light: lightRole,
      power: mainRole,
    },
    roleThinking: { main: undefined, light: undefined, power: undefined },
    defaultMaxOutputTokens: { main: 8192, light: 8192, power: 8192 },
    primary: {
      budget: { contextWindow: 128_000, maxOutputTokens: 8192 },
      inputCapabilities: { images: false },
      attention: { optimalMaxTokens: 64_000, riskMaxTokens: 96_000 },
    },
  });
}

function stubWindowPrompt(skillContent: string | null = null) {
  const projection = createKernelWindowPromptProjection({
    revision: 1,
    segment: "skill-index",
    content: skillContent,
  });
  return Object.freeze({
    async project() {
      return projection;
    },
  });
}

describe("Wave 5.2 orchestrator self-awareness & transient prefix", () => {
  it("normal Task inherits subAgentSupplementalTools/subAgentSkillIndex/RunContext while logOnly narrows to log tools", async () => {
    const provider = new MockLLMProvider([
      {
        toolCalls: [
          {
            id: "tc-normal",
            name: "Task",
            input: { description: "inspect runtime", prompt: "call runtime_inspect" },
          },
        ],
      },
      // Child turn 1: invoke runtime_inspect
      {
        toolCalls: [
          {
            id: "tc-inspect",
            name: "runtime_inspect",
            input: {},
          },
        ],
      },
      // Child turn 2: done
      { text: "normal child done" },
      // Parent turn 2: invoke Task(logOnly: true)
      {
        toolCalls: [
          {
            id: "tc-logonly",
            name: "Task",
            input: {
              description: "inspect logs",
              prompt: "check logs",
              logOnly: true,
            },
          },
        ],
      },
      // Log-only child turn 1
      { text: "log-only child done" },
      // Parent final turn
      { text: "all done" },
    ]);

    const capturedSubContexts: Array<RunContext | undefined> = [];
    const runtime = await createAgentRuntime({
      primaryRole: "main",
      modelProvider: createBinding(provider),
      runtimeEnvironment: createKernelRuntimeEnvironment({
        agentIdentity: { displayName: "知行" },
        sessionType: "interactive",
        workspace: { path: process.cwd(), source: "runtime" },
        globalConfigPath: "/test/config.jsonc",
      }),
      toolImplementation: createStubToolImplementation(),
      windowPrompt: stubWindowPrompt(null),
      securityExecution: createTestSecurityExecution(),
      extraTools: [
        {
          name: "mcp__docs__search",
          description: "mounted mcp tool",
          inputSchema: { type: "object" },
          isReadOnly: true,
          boundaries: [{ boundaryType: "process", access: "read", dynamic: false }],
          call: async () => ({ content: "mcp ok" }),
        },
        ...createLogQueryTools(
          {
            query: async () => ({ entries: [], nextCursor: null }),
          } as never,
          () => ({
            subject: "main",
            revision: "r1",
            manageStorage: true,
            managePolicy: false,
            scopes: [],
          }) as never,
        ),
      ],
      subAgentSupplementalTools: [
        {
          name: "skill_read",
          description: "system-only skill read",
          inputSchema: { type: "object" },
          isReadOnly: true,
          boundaries: [{ boundaryType: "process", access: "read", dynamic: false }],
          call: async () => ({ content: "skill content" }),
        },
        {
          name: "runtime_inspect",
          description: "inspect runtime context",
          inputSchema: { type: "object" },
          isReadOnly: true,
          boundaries: [{ boundaryType: "process", access: "read", dynamic: false }],
          call: async () => {
            capturedSubContexts.push(runContextStorage.getStore());
            return { content: "inspected" };
          },
        },
      ],
      subAgentSkillIndex: "## Available Skills\n- **system:提炼技能**: distill reusable knowledge",
    });

    try {
      const completion = await runtime.run({
        modelInput: { messages: [userMessage("run both tasks")] },
        identity: { conversationId: "conv-awareness-1", turnIndex: 0 },
        control: {},
        observation: {},
        correctness: {},
      });
      expect(completion.terminal.reason).toBe("completed");
      if (completion.terminal.reason === "completed") {
        expect(completion.terminal.message.content).toEqual([
          { type: "text", text: "all done" },
        ]);
      }

      // Call #0 = parent main, Call #1 & #2 = normal child, Call #4 = logOnly child
      const normalChildReq = provider.calls[1] as ChatRequest;
      const normalChildToolNames = (normalChildReq.tools ?? []).map((t) => t.name);
      expect(normalChildToolNames).toContain("skill_read");
      expect(normalChildToolNames).toContain("runtime_inspect");
      expect(normalChildReq.systemPrompt).toContain("system:提炼技能");

      const captured = capturedSubContexts[0];
      expect(captured).toBeDefined();
      expect(captured?.runtimeKind).toBe("sub-agent");
      expect(captured?.lineageRole).toBe("main");
      expect(captured?.effectivePrimaryRole).toBe("main");
      expect(captured?.hasAuthorizedWorkspace).toBe(true);
      expect(captured?.toolNames).toContain("runtime_inspect");
      expect(captured?.toolNames).toContain("skill_read");
      expect(captured?.mountedMcpServers).toEqual([]);

      const logOnlyChildReq = provider.calls[4] as ChatRequest;
      const logOnlyToolNames = (logOnlyChildReq.tools ?? []).map((t) => t.name).sort();
      expect(logOnlyToolNames).toEqual(["log_read", "log_search"]);
      expect(logOnlyChildReq.systemPrompt).not.toContain("Available Skills");
    } finally {
      await runtime.dispose();
    }
  });

  it("runOrchestrationV1 populates orchestration-node RunContext and lineageRole in both online and cold paths", async () => {
    const lightProvider = new MockLLMProvider([
      { toolCalls: [{ id: "orc-1", name: "runtime_inspect", input: {} }] },
      { text: "online-node-done" },
      { toolCalls: [{ id: "orc-2", name: "runtime_inspect", input: {} }] },
      { text: "cold-node-done" },
    ]);
    const mainProvider = new MockLLMProvider([]);
    const observed: Array<RunContext | undefined> = [];

    const runtime = await createAgentRuntime({
      primaryRole: "main",
      modelProvider: createBinding(mainProvider, lightProvider),
      runtimeEnvironment: createKernelRuntimeEnvironment({
        agentIdentity: { displayName: "知行" },
        sessionType: "interactive",
        workspace: { path: null, source: "none" },
        globalConfigPath: "/test/config.jsonc",
      }),
      toolImplementation: createStubToolImplementation(),
      windowPrompt: stubWindowPrompt(null),
      securityExecution: createTestSecurityExecution(),
      extraTools: [
        {
          name: "mcp__alpha__ping",
          description: "mcp alpha tool",
          inputSchema: { type: "object" },
          isReadOnly: true,
          boundaries: [{ boundaryType: "process", access: "read", dynamic: false }],
          call: async () => ({ content: "pong" }),
        },
        {
          name: "runtime_inspect",
          description: "inspect runtime",
          inputSchema: { type: "object" },
          isReadOnly: true,
          boundaries: [{ boundaryType: "process", access: "read", dynamic: false }],
          call: async () => {
            observed.push(runContextStorage.getStore());
            return { content: "ok" };
          },
        },
      ],
    });

    const caps: OrchestrationSystemCapsV1 = {
      maxNodes: 4,
      maxParallel: 1,
      maxRunMs: 10_000,
      maxNodeTimeoutMs: 5_000,
      maxNodeTurns: 4,
      maxNodeTokens: 2_000,
      maxContextSnapshotTokens: 1_000,
      maxInstructionChars: 500,
      maxInputChars: 500,
      maxOutputChars: 500,
      allowedNodeKinds: ["agent"],
      allowedTools: ["runtime_inspect"],
    };
    const loaded = loadOrchestrationDefinitionV1(
      {
        version: 1,
        id: "orc-awareness",
        title: "Orc Awareness",
        policy: {
          maxParallel: 1,
          maxRunMs: 10_000,
          defaultNodeTimeoutMs: 5_000,
          defaultMaxTurns: 4,
          defaultMaxTokens: 2_000,
          allowedTools: ["runtime_inspect"],
          failureMode: "fail_fast",
        },
        input: { required: false, format: "text", maxChars: 100 },
        nodes: [
          {
            id: "node-a",
            kind: "agent",
            dependsOn: [],
            instruction: "call runtime_inspect",
            context: {
              includeRunInput: false,
              includeContextSnapshot: false,
              includeNodeOutputs: "dependencies",
            },
            output: { required: true, format: "text", maxChars: 200 },
            policy: {
              timeoutMs: 5_000,
              maxTurns: 4,
              maxTokens: 2_000,
              modelRole: "light",
              tools: ["runtime_inspect"],
            },
          },
        ],
      },
      caps,
    );
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error("expected valid orchestration");

    try {
      const parentBus = createEventBus<AgentEventMap>({ lineage: "main" });
      const { logs: onlineLogs } = createKernelLogFactory("conv-online");
      const onlineResult = await runContextStorage.run(
        { bus: parentBus, lineage: "main", conversationId: "conv-online", logPorts: onlineLogs },
        () =>
          runtime.runOrchestrationV1({
            executable: loaded.executable,
            eventBus: createEventBus<AgentEventMap>({ lineage: "main/orc" }),
            parentLineage: "main/orc",
          }),
      );
      expect(onlineResult.status).toBe("completed");
      expect(observed[0]?.runtimeKind).toBe("orchestration-node");
      expect(observed[0]?.lineageRole).toBe("light");
      expect(observed[0]?.effectivePrimaryRole).toBe("light");
      expect(observed[0]?.hasAuthorizedWorkspace).toBe(false);
      expect(observed[0]?.logPorts).toBe(onlineLogs);
      expect(observed[0]?.mountedMcpServers).toEqual([]);

      const { logs: coldLogs } = createKernelLogFactory("conv-cold");
      const coldResult = await runtime.runOrchestrationV1({
        executable: loaded.executable,
        eventBus: createEventBus<AgentEventMap>({ lineage: "cold-orc" }),
        parentLineage: "cold-orc",
        runContext: {
          conversationId: "conv-cold",
          logPorts: coldLogs,
        },
      });
      expect(coldResult.status).toBe("completed");
      expect(observed[1]?.runtimeKind).toBe("orchestration-node");
      expect(observed[1]?.lineageRole).toBe("light");
      expect(observed[1]?.effectivePrimaryRole).toBe("light");
      expect(observed[1]?.conversationId).toBe("conv-cold");
      expect(observed[1]?.logPorts).toBe(coldLogs);
    } finally {
      await runtime.dispose();
    }
  });

  it("resets appendOnlyTurnContext prefix projection generation after a run with transient onBeforeRun injectUserContext", async () => {
    const provider = Object.assign(
      new MockLLMProvider([
        { text: "turn1" },
        { text: "turn2" },
        { text: "turn3" },
      ]),
      { appendOnlyTurnContext: true as const },
    );
    let injectNext = true;

    const runtime = await createAgentRuntime({
      primaryRole: "main",
      modelProvider: createBinding(provider),
      runtimeEnvironment: createKernelRuntimeEnvironment({
        agentIdentity: { displayName: "知行" },
        sessionType: "interactive",
        workspace: { path: null, source: "none" },
        globalConfigPath: "/test/config.jsonc",
      }),
      toolImplementation: createStubToolImplementation(),
      windowPrompt: stubWindowPrompt(null),
      securityExecution: createTestSecurityExecution(),
      lifecycle: [
        {
          id: "transient-injector",
          onBeforeRun: (ctx) => {
            if (injectNext) {
              injectNext = false;
              ctx.injectUserContext("<transient-hint>ephemeral</transient-hint>");
            }
          },
        },
      ],
    });

    try {
      const m1 = userMessage("hello 1");
      await runtime.run({
        modelInput: { messages: [m1] },
        identity: { turnIndex: 0 },
        control: {},
        observation: {},
        correctness: {},
      });

      const m2 = userMessage("hello 2");
      await runtime.run({
        modelInput: {
          messages: [
            m1,
            { role: "assistant", content: [{ type: "text", text: "turn1" }] },
            m2,
          ],
        },
        identity: { turnIndex: 1 },
        control: {},
        observation: {},
        correctness: {},
      });

      const m3 = userMessage("hello 3");
      await runtime.run({
        modelInput: {
          messages: [
            m1,
            { role: "assistant", content: [{ type: "text", text: "turn1" }] },
            m2,
            { role: "assistant", content: [{ type: "text", text: "turn2" }] },
            m3,
          ],
        },
        identity: { turnIndex: 2 },
        control: {},
        observation: {},
        correctness: {},
      });

      const inv1 = provider.calls[0]?.invalidatedPrefixBeforeIndex;
      const inv2 = provider.calls[1]?.invalidatedPrefixBeforeIndex;
      const inv3 = provider.calls[2]?.invalidatedPrefixBeforeIndex;
      expect(inv1).toBeUndefined();
      expect(inv2).toBe(3);
      expect(inv3).toBe(4);
      expect(provider.calls[2]?.messages.length).toBe(7);
    } finally {
      await runtime.dispose();
    }
  });
});
