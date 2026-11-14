import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { userTurnInputFromText, type Message } from "@zhixing-ai/core";
import type { AgentYield, RunResult } from "@zhixing-ai/core/loop";
import { DeviceLifecycleJournal } from "@zhixing-ai/core/authority";
import {
  parseAdmittedConversationRunSource,
} from "@zhixing-ai/core/delivery";
import type { ChannelDeliveryEffectSource } from "@zhixing-ai/core/delivery/channel-effect";
import { protocolDigest, createSignedTrustRuleSnapshot } from "@zhixing-ai/core/protocol";
import { isLocalConversationId } from "@zhixing-ai/core/conversation";
import { createLocalConversationDirectoryApplication } from "../local-conversation-directory-application.js";
import {
  anchorConversationHostStopRevision,
  composeConversationHostStopPorts,
  createAnchorConversationStopOwner,
  resolveHostStopDeliveryLifecycleSources,
  restoreConversationHostStopSnapshot,
} from "../anchor-conversation-stop-owner.js";
import { createConversationAgentTurnAdmissionPort } from "@zhixing-ai/owner-kernel/conversation-agent-turn-admission";
import { ConversationManager } from "@zhixing-ai/owner-kernel/conversation-manager";
import type { RuntimeFactory, SessionRuntime } from "@zhixing-ai/owner-kernel/types";
import { projectSessionTurn, type ProjectedSessionTurnResult } from "@zhixing-ai/rpc";
import {
  AssignmentStreamSpool,
  AssignmentStreamWriter,
  ConversationAssignmentLedger,
  InProcessAssignmentSubmission,
} from "@zhixing-ai/executor";
import { createHostAdvancementModelProviderFactory } from "../../runtime/advancement-model-provider.js";
import { projectRuntimeConfiguration } from "../../runtime/runtime-configuration-projections.js";
import { createRuntimeConfigurationSnapshot } from "../../runtime/runtime-configuration-snapshot.js";
import {
  createConversationExecutorHostBoundary,
  NO_REMOTE_CONVERSATION_EXECUTORS,
} from "../conversation-executor-dispatch.js";
import { DurableConversationInteractionObserver } from "../conversation-protocol-runtime.js";
import { LocalConversationOwnerAssembly } from "../local-conversation-owner.js";
import {
  freezeHostStopAcceptedWork,
  HOST_STOP_ACCEPTED_WORK_OWNERS,
  HostStopAcceptedWorkPendingError,
  HostStopCoordinator,
  hostStopDeliveryLifecycleSources,
  loadHostStopAcceptedWork,
  type HostStopAcceptedWorkPorts,
  type HostStopAcceptedWorkSnapshot,
} from "../host-stop-lifecycle.js";
import { setupDelivery, type DeliveryStack } from "../../setup-delivery.js";
import {
  createProtocol,
  getOrCreateActiveConversation,
  registerActiveConversation,
  setupAuthorityRuntime,
  TEST_RUNTIME_AUTHORITY_FACTS,
} from "./conversation-protocol-runtime-fixture.js";
import {
  FIXTURE_CONFIG,
  FixtureSecretStore,
  fixtureLocalOwnerRuntime,
} from "./local-owner-assembly-fixture.js";
import { createDeviceCapacityRuntime } from "../../__tests__/device-capacity-fixture.js";
import { createTempDir } from "@zhixing-ai/test-utils";

const FIXTURE_CONFIGURATION = projectRuntimeConfiguration(
  createRuntimeConfigurationSnapshot(FIXTURE_CONFIG),
);

const quietLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

async function compileCommandStopBindings(ports: Record<string, unknown>) {
  const sourceText = await readFile(new URL("../command.ts", import.meta.url), "utf8");
  const source = ts.createSourceFile("command.ts", sourceText, ts.ScriptTarget.Latest, true);
  const declarations = new Map<string, ts.VariableDeclaration | ts.FunctionDeclaration>();
  const visit = (node: ts.Node) => {
    if (
      (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      declarations.set(node.name.text, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const declaration = (name: string) => {
    const node = declarations.get(name);
    if (!node) throw new Error(`Missing production declaration: ${name}`);
    return ts.isFunctionDeclaration(node) ? node.getText(source) : `const ${node.getText(source)};`;
  };
  const property = (node: ts.Node, name: string): ts.Expression => {
    if (!ts.isObjectLiteralExpression(node)) throw new Error("Expected production object literal");
    const found = node.properties.find((p) => p.name?.getText(source) === name);
    if (!found || !ts.isPropertyAssignment(found)) {
      throw new Error(`Missing production property: ${name}`);
    }
    return found.initializer;
  };
  const stop = (declarations.get("stopCoordinator") as ts.VariableDeclaration)
    .initializer as ts.NewExpression;
  const stopOptions = stop.arguments![0]!;
  const runtimeNode = property(stopOptions, "runtime");
  const closeAdmission = property(runtimeNode, "closeAdmission").getText(source);
  const settleImmediate = property(runtimeNode, "settleImmediate").getText(source);
  const drainAcceptedWork = property(runtimeNode, "drainAcceptedWork").getText(source);
  const cancelAcceptedWork = property(runtimeNode, "cancelAcceptedWork").getText(source);
  const flushDurableState = property(runtimeNode, "flushDurableState").getText(source);
  const settlePhysicalSteps = property(runtimeNode, "settlePhysicalSteps").getText(source);
  const onAcceptedWorkFrozen = property(stopOptions, "onAcceptedWorkFrozen").getText(source);

  const removalWorkNode = (
    declarations.get("currentRemovalAcceptedWork") as ts.VariableDeclaration
  ).initializer as ts.ObjectLiteralExpression;
  const removalCloseAdmission = property(removalWorkNode, "closeAdmission").getText(source);
  const removalOnFrozen = property(removalWorkNode, "onFrozen").getText(source);

  const currentDeviceRemovalInit = (
    declarations.get("currentDeviceRemoval") as ts.VariableDeclaration
  ).initializer as ts.ConditionalExpression;
  const createRemovalCall = currentDeviceRemovalInit.whenTrue as ts.CallExpression;
  const removalReleaseAdmission = property(
    createRemovalCall.arguments[0]!,
    "releaseAdmission",
  ).getText(source);

  const optionalDeclarations = [
    "anchorConversationStopOwner",
    "conversationStopPorts",
    "assertAcceptedWorkSubset",
    "deliveryLifecycleSourcesFromOwnerItems",
    "captureStopAcceptedWork",
    "assertStopAcceptedWorkSettled",
    "stopPort",
    "acceptedWork",
  ]
    .filter((name) => declarations.has(name))
    .map(declaration);
  const body = [
    "let managedHostStopping = false;",
    ...optionalDeclarations,
    `return {`,
    `  getManagedHostStopping: () => managedHostStopping,`,
    `  acceptedWork,`,
    `  onAcceptedWorkFrozen: ${onAcceptedWorkFrozen},`,
    `  currentRemoval: { closeAdmission: ${removalCloseAdmission}, onFrozen: ${removalOnFrozen}, releaseAdmission: ${removalReleaseAdmission} },`,
    `  runtime: { closeAdmission: ${closeAdmission}, settleImmediate: ${settleImmediate}, drainAcceptedWork: ${drainAcceptedWork}, cancelAcceptedWork: ${cancelAcceptedWork}, flushDurableState: ${flushDurableState}, settlePhysicalSteps: ${settlePhysicalSteps} }`,
    `};`,
  ].join("\n");
  const transpiled = ts.transpileModule(`function create(){${body}}`, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(ports), `${transpiled}; return create();`)(
    ...Object.values(ports),
  ) as {
    getManagedHostStopping: () => boolean;
    acceptedWork: HostStopAcceptedWorkPorts;
    onAcceptedWorkFrozen: (snapshot: HostStopAcceptedWorkSnapshot) => Promise<void>;
    currentRemoval: {
      closeAdmission: (operationId: string) => Promise<void>;
      onFrozen: (snapshot: HostStopAcceptedWorkSnapshot) => Promise<void>;
      releaseAdmission: (operationId: string) => Promise<void>;
    };
    runtime: {
      closeAdmission: (operationId: string) => Promise<void>;
      settleImmediate: () => Promise<void>;
      drainAcceptedWork: () => Promise<void>;
      cancelAcceptedWork: (timeoutMs: number) => Promise<void>;
      flushDurableState: () => Promise<
        readonly { readonly kind: "accepted-work"; readonly digest: string }[]
      >;
      settlePhysicalSteps: () => Promise<void>;
    };
  };
}

interface TurnGate {
  readonly entered: Promise<void>;
  readonly release: () => void;
  readonly aborts: () => number;
}

function createControllableGate(): TurnGate & {
  markEntered: () => void;
  hold: Promise<void>;
  recordAbort: () => void;
} {
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let abortCount = 0;
  return {
    entered,
    markEntered,
    hold,
    release,
    aborts: () => abortCount,
    recordAbort: () => {
      abortCount += 1;
    },
  };
}

async function createDualDomainHarness(options?: {
  readonly existingHome?: string;
  readonly existingSecretStore?: FixtureSecretStore;
  readonly existingCapacity?: ReturnType<typeof createDeviceCapacityRuntime>;
  readonly anchorRunHook?: (input: {
    readonly conversationId: string;
    readonly messages: readonly Message[];
    readonly signal?: AbortSignal;
    readonly reserveUsage?: () => Promise<void>;
  }) => Promise<string>;
  readonly localRunHook?: (input: {
    readonly conversationId: string;
    readonly messages: readonly Message[];
    readonly signal?: AbortSignal;
  }) => Promise<string>;
  readonly withDelivery?: ChannelDeliveryEffectSource;
  readonly startupLifecycle?: {
    readonly operationId: string;
    readonly kind: "stop" | "executor-removal" | "anchor-uninstall";
    readonly alreadySettled: boolean;
    readonly recoverAcceptedWork?: boolean;
  };
  readonly startupHostStopSnapshot?: HostStopAcceptedWorkSnapshot;
}) {
  const home = options?.existingHome ?? (await createTempDir("b408-dual-domain"));
  const secretStore = options?.existingSecretStore ?? new FixtureSecretStore();
  const capacity =
    options?.existingCapacity ?? createDeviceCapacityRuntime(path.join(home, "capacity"));
  const authority = await setupAuthorityRuntime({
    zhixingHome: home,
    secretStore,
    enableAnchor: true,
    enableLocalExecutor: true,
    deviceCapacity: capacity.arbiter,
    storageMaintenance: capacity.storage,
  });
  if (!options?.existingHome) {
    await authority.installPermissionSnapshot(
      createSignedTrustRuleSnapshot(
        { snapshotVersion: 1, rules: [], generatedAt: "2026-08-07T00:00:00.000Z" },
        authority.signer,
      ),
    );
  }

  const deliveryStack: DeliveryStack | undefined = options?.withDelivery
    ? await setupDelivery({
        channels: options.withDelivery,
        zhixingHome: home,
        authorityRuntime: authority,
        logger: quietLogger,
        ...(options.startupLifecycle
          ? {
              startupLifecycle: {
                operationId: options.startupLifecycle.operationId,
                sources: [],
                deliveries: options.startupHostStopSnapshot?.owners.delivery ?? [],
                alreadySettled: options.startupLifecycle.alreadySettled,
              },
            }
          : {}),
      })
    : undefined;
  if (deliveryStack && !options?.startupLifecycle) {
    deliveryStack.activate();
  }

  const anchorFactory: RuntimeFactory = {
    create: async (conversationId): Promise<SessionRuntime> => ({
      ...TEST_RUNTIME_AUTHORITY_FACTS,
      sessionId: conversationId,
      async *run(messages, runOpts): AsyncGenerator<AgentYield, RunResult> {
        const reserveUsage = async () => {
          if (runOpts?.modelCallResourceMeter) {
            const reserved = await runOpts.modelCallResourceMeter.reserve({
              callIndex: 1,
              tokenUpperBound: 8,
            });
            await runOpts.modelCallResourceMeter.consume({
              usageId: reserved.usageId,
              tokens: 2,
            });
          }
        };
        const replyText = options?.anchorRunHook
          ? await options.anchorRunHook({
              conversationId,
              messages,
              signal: runOpts?.signal,
              reserveUsage,
            })
          : (await reserveUsage(), "anchor turn completed");
        const assistant: Message = {
          role: "assistant",
          content: [{ type: "text", text: replyText }],
        };
        return {
          agentResult: {
            reason: "completed",
            message: assistant,
            usage: { inputTokens: 1, outputTokens: 1 },
          },
          runRecord: {
            timestamp: new Date().toISOString(),
            messages: [messages.at(-1)!, assistant],
            usage: { inputTokens: 1, outputTokens: 1 },
            source: "interactive",
          },
          newMessages: [assistant],
          durationMs: 5,
        };
      },
      abort: () => true,
      dispose: async () => {},
    }),
  };

  let anchorManager!: ConversationManager;
  const anchorProtocol = createProtocol({
    authority,
    manager: () => anchorManager,
    interactions: new DurableConversationInteractionObserver(),
    onFinal: async () => {},
  });
  if (deliveryStack) {
    anchorProtocol.bindDeliveryDrain(() => deliveryStack.flush());
  }
  const anchorCommitted = new Set<string>();
  anchorManager = new ConversationManager(anchorFactory, undefined, {
    durableTurnExecutor: anchorProtocol,
    onTurnCommitted: () => {},
    loadHistory: async () => undefined,
    initTranscript: async () => {},
    appendRun: async () => {
      throw new Error("durable must not use legacy append");
    },
    appendCommittedRun: async (_id, record) => {
      const appended = !anchorCommitted.has(record.runId);
      anchorCommitted.add(record.runId);
      return { runIndex: record.runIndex, shardId: "owner-log", appended };
    },
  });
  if (!options?.startupLifecycle) {
    anchorProtocol.startRecoveryLoop();
  }

  const boundAnchorConversationStopOwner = createAnchorConversationStopOwner({
    manager: anchorManager,
    protocol: anchorProtocol,
  });
  if (options?.startupLifecycle && options.startupLifecycle.kind !== "executor-removal") {
    await boundAnchorConversationStopOwner?.openClosedStartup(
      options.startupLifecycle.operationId,
      { alreadySettled: options.startupLifecycle.alreadySettled },
    );
  }

  const localOwnerRuntime = fixtureLocalOwnerRuntime(authority);
  const localStreamSpool = new AssignmentStreamSpool(
    path.join(home, "local-streams"),
    authority.artifacts,
  );
  const localFactory: RuntimeFactory = {
    create: async (conversationId): Promise<SessionRuntime> => ({
      ...TEST_RUNTIME_AUTHORITY_FACTS,
      sessionId: conversationId,
      async *run(messages, runOpts): AsyncGenerator<AgentYield, RunResult> {
        const replyText = options?.localRunHook
          ? await options.localRunHook({
              conversationId,
              messages,
              signal: runOpts?.signal,
            })
          : "local done";
        const assistant: Message = {
          role: "assistant",
          content: [{ type: "text", text: replyText }],
        };
        return {
          agentResult: {
            reason: "completed",
            message: assistant,
            usage: { inputTokens: 1, outputTokens: 1 },
          },
          runRecord: {
            timestamp: new Date().toISOString(),
            messages: [messages.at(-1)!, assistant],
            usage: { inputTokens: 1, outputTokens: 1 },
            source: "interactive",
          },
          newMessages: [assistant],
          durationMs: 2,
        };
      },
      abort: () => true,
      dispose: async () => {},
    }),
  };
  const localExecutorBoundary = createConversationExecutorHostBoundary({
    authority: localOwnerRuntime,
    directory: NO_REMOTE_CONVERSATION_EXECUTORS,
    clock: () => new Date().toISOString(),
    local: {
      ConversationAssignmentLedger,
      InProcessAssignmentSubmission,
      runtimeFactory: localFactory,
      createStream: ({ assignmentId, ref }) =>
        AssignmentStreamWriter.open(localStreamSpool, assignmentId, ref),
    },
  });
  const localAssembly = await LocalConversationOwnerAssembly.create({
    owner: localOwnerRuntime,
    executorDispatch: localExecutorBoundary.application,
    assignmentStaging: localExecutorBoundary.staging!,
    runtimeFactory: localFactory,
    interactions: new DurableConversationInteractionObserver(),
    advancementModelProvider: createHostAdvancementModelProviderFactory({
      configuration: FIXTURE_CONFIGURATION.advancement,
      credentials: { providers: { deepseek: { apiKey: "fixture-key" } } },
      governProvider: (provider) => provider,
    }),
    evidence: {
      collect: async () => {
        throw new Error("fixture: evidence unavailable");
      },
    },
    currentAnchorDeviceId: () => authority.deviceId,
  });
  await localAssembly.start(
    options?.startupLifecycle
      ? {
          lifecycle: {
            operationId: options.startupLifecycle.operationId,
            kind: options.startupLifecycle.kind,
            recoverAcceptedWork: options.startupLifecycle.recoverAcceptedWork ?? true,
            alreadySettled: options.startupLifecycle.alreadySettled,
          },
        }
      : {},
  );

  if (options?.startupHostStopSnapshot && options.startupLifecycle) {
    await restoreConversationHostStopSnapshot(
      options.startupHostStopSnapshot,
      {
        anchor: boundAnchorConversationStopOwner,
        local: localAssembly,
      },
      options.startupLifecycle.alreadySettled,
    );
  }

  const channelEvents: string[] = [];
  let channelConnected = true;
  const bindings = await compileCommandStopBindings({
    protocolDigest,
    parseAdmittedConversationRunSource,
    composeConversationHostStopPorts,
    resolveHostStopDeliveryLifecycleSources,
    restoreConversationHostStopSnapshot,
    HostStopAcceptedWorkPendingError,
    hostStopDeliveryLifecycleSources,
    startupLifecycle: options?.startupLifecycle
      ? { alreadySettled: options.startupLifecycle.alreadySettled }
      : undefined,
    advancementRecovery: undefined,
    boundAnchorConversationStopOwner,
    boundLocalConversationOwner: localAssembly,
    boundConversations: anchorManager,
    boundConversationProtocol: anchorProtocol,
    boundAuthorityRuntime: authority,
    boundJobRelayObligations: { listOpen: async () => [] },
    boundExecutorJobOwner: {
      acceptedWorkItems: async () => [],
      pauseAccepting: () => {},
      resumeAccepting: () => {},
      drain: async () => {},
    },
    boundInboundRouter: {
      refuseNewMessages: () => {},
      resumeNewMessages: () => {},
      drainAcceptedMessages: async () => {},
    },
    boundChannelStatuses: () =>
      options?.withDelivery
        ? [{ channelId: "feishu", state: channelConnected ? "connected" : "disconnected" }]
        : [],
    boundChannelConnections: {
      suspendConfigured: async () => {
        channelEvents.push("suspend");
      },
      disconnectConfigured: async () => {
        channelEvents.push("disconnect");
        channelConnected = false;
      },
      connectConfigured: async () => {
        channelEvents.push("connect");
        channelConnected = true;
      },
    },
    boundDeliveryStack: deliveryStack,
    schedulerApplication: {
      captureAcceptedWork: async () => [],
      assertAcceptedWorkSettled: async () => {},
      closeAdmission: () => {},
      resumeAdmission: () => {},
    },
    settleScheduleForTransfer: async () => {},
    schedulerGenerationOwner: { reconcileExecutionTerminals: async () => {} },
    lifecycleAuthorityLog: authority.authorityLog,
    recoverStartupLifecycleAcceptedWork: async () => {
      await boundAnchorConversationStopOwner?.recoverAcceptedWorkForLifecycle();
      await localAssembly.recoverAcceptedWorkForLifecycle();
    },
  });

  const journal = new DeviceLifecycleJournal(authority.authorityLog);
  const homeId = (await authority.authorityLog.originCheckpoint()).logId;

  const submitAnchorTurn = async (input: {
    readonly conversationId: string;
    readonly turnId: string;
    readonly text: string;
  }) => {
    const anchorAdmission = createConversationAgentTurnAdmissionPort({ manager: anchorManager });
    let resolveTurnOutcome!: (res: ProjectedSessionTurnResult) => void;
    const outcome = new Promise<ProjectedSessionTurnResult>((resolve) => {
      resolveTurnOutcome = resolve;
    });
    const turnAbort = new AbortController();
    const admitted = await anchorAdmission.admit({
      identity: {
        kind: "existing",
        conversationId: input.conversationId,
        exists: (id) => anchorProtocol.sessionExists(id),
      },
      turnId: input.turnId,
      input: userTurnInputFromText(input.text),
      invocation: { kind: "agent" },
      caller: {
        kind: "surface",
        surfacePrincipal: "rpc:owner",
        connectionId: `conn-${input.turnId}`,
      },
      execution: {
        execute: async ({ conversationId, turnId }) => {
          try {
            const managed = anchorManager.getSession(conversationId)!;
            const res = await projectSessionTurn({
              manager: anchorManager,
              managed,
              text: input.text,
              turnId,
              abortSignal: turnAbort.signal,
              runOptions: {
                source: "interactive",
                surfacePrincipal: "rpc:owner",
                signal: turnAbort.signal,
                turnContext: { turnId },
              },
              notify: () => {},
            });
            resolveTurnOutcome(res);
          } finally {
            anchorManager.setBusy(conversationId, false);
          }
        },
        cancelPending: () => {
          turnAbort.abort();
          resolveTurnOutcome({ kind: "aborted" });
        },
        abort: () => turnAbort.abort(),
      },
    });
    if (admitted.status === "immediate") {
      admitted.start();
    }
    return { admitted, outcome, turnAbort };
  };

  const submitLocalTurn = async (input: {
    readonly conversationId: string;
    readonly turnId: string;
    readonly text: string;
  }) => {
    const localPort = localAssembly.port();
    const conversationApplication = createLocalConversationDirectoryApplication({
      owner: localPort,
      observerCount: () => 0,
    });
    const turn = localPort.createAgentTurnExecution({
      input: userTurnInputFromText(input.text),
      notify: () => {},
    });
    const caller = {
      kind: "surface" as const,
      surfacePrincipal: "surface:local:first-party",
      connectionId: `local-conn-${input.turnId}`,
    };
    const turnIdentity = conversationApplication.prepareAgentTurnIdentity({
      kind: "prepare-agent-turn-identity",
      turnId: input.turnId,
      identitySource: "provided",
      caller,
    });
    await conversationApplication.admitAgentTurn({
      kind: "admit-agent-turn",
      conversationId: input.conversationId,
      input: userTurnInputFromText(input.text),
      turnIdentity,
      caller,
      execution: turn.execution,
    });
    return turn.outcome;
  };

  return {
    home,
    secretStore,
    capacity,
    authority,
    deliveryStack,
    channelEvents,
    anchorManager,
    anchorProtocol,
    boundAnchorConversationStopOwner: boundAnchorConversationStopOwner!,
    localAssembly,
    bindings,
    journal,
    homeId,
    submitAnchorTurn,
    submitLocalTurn,
    close: async () => {
      await deliveryStack?.stop().catch(() => {});
      await anchorProtocol.stopRecoveryLoop();
      await localAssembly.close();
      await authority.stopStorageMaintenance().catch(() => {});
      await authority.startupCleanup.run().catch(() => {});
    },
  };
}

describe("B4-08 dual-domain Anchor + Local conversation host-stop regression", () => {
  it("waits for an active Anchor turn during drain and aborts durably on cancel when Local is empty", async () => {
    const gate = createControllableGate();
    const h = await createDualDomainHarness({
      anchorRunHook: async ({ signal, reserveUsage }) => {
        gate.markEntered();
        await Promise.race([
          gate.hold,
          new Promise<never>((_, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                gate.recordAbort();
                reject(signal.reason ?? new Error("aborted"));
              },
              { once: true },
            );
          }),
        ]);
        await reserveUsage?.();
        return "anchor turn drained cleanly";
      },
    });
    try {
      const anchorConvId = "chat-20261113-01ee";
      await getOrCreateActiveConversation(h.authority, h.anchorManager, anchorConvId);
      const { admitted, outcome } = await h.submitAnchorTurn({
        conversationId: anchorConvId,
        turnId: "turn-61",
        text: "hold turn 61",
      });
      expect(admitted.status).toBe("immediate");
      await gate.entered;

      const coordinator = new HostStopCoordinator({
        journal: h.journal,
        homeId: h.homeId,
        localDeviceId: h.authority.deviceId,
        host: {
          kind: "foreground",
          processId: process.pid,
          startedAt: new Date().toISOString(),
        },
        acceptedWork: h.bindings.acceptedWork,
        artifactStore: h.authority.artifacts,
        onAcceptedWorkFrozen: h.bindings.onAcceptedWorkFrozen,
        runtime: h.bindings.runtime,
      });

      let prepareSettled = false;
      const preparePromise = coordinator
        .prepare({
          requestId: "b408-drain-stop",
          reason: "user-stop",
          strategy: "drain",
          timeoutMs: 10_000,
        })
        .then((res) => {
          prepareSettled = true;
          return res;
        });

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(prepareSettled).toBe(false);
      expect(gate.aborts()).toBe(0);

      gate.release();
      const turnResult = await outcome;
      if (turnResult.kind === "error") throw turnResult.error;
      expect(turnResult.kind).toBe("settled");

      const stopResult = await preparePromise;
      expect(stopResult.phase).toBe("ready-to-stop");
      const operationId = protocolDigest("HostStopOperation", 1, {
        requestId: "b408-drain-stop",
        homeId: h.homeId,
      });
      const opState = await h.journal.state(operationId);
      const snapshot = await loadHostStopAcceptedWork(opState!, h.authority.artifacts);
      expect(snapshot.owners.conversation).toEqual([
        {
          id: anchorConvId,
          revision: anchorConversationHostStopRevision(anchorConvId, anchorConvId),
        },
      ]);
    } finally {
      gate.release();
      await h.close();
    }

    // Cancel path on Anchor busy / Local empty
    const cancelGate = createControllableGate();
    const hCancel = await createDualDomainHarness({
      anchorRunHook: async ({ signal }) => {
        cancelGate.markEntered();
        await Promise.race([
          cancelGate.hold,
          new Promise<never>((_, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                cancelGate.recordAbort();
                reject(signal.reason ?? new Error("aborted"));
              },
              { once: true },
            );
          }),
        ]);
        return "unreachable";
      },
    });
    try {
      const convId = "chat-20261113-cancel";
      await getOrCreateActiveConversation(hCancel.authority, hCancel.anchorManager, convId);
      await hCancel.submitAnchorTurn({
        conversationId: convId,
        turnId: "turn-cancel-1",
        text: "cancel me",
      });
      await cancelGate.entered;
      const coordinator = new HostStopCoordinator({
        journal: hCancel.journal,
        homeId: hCancel.homeId,
        localDeviceId: hCancel.authority.deviceId,
        host: {
          kind: "foreground",
          processId: process.pid,
          startedAt: new Date().toISOString(),
        },
        acceptedWork: hCancel.bindings.acceptedWork,
        artifactStore: hCancel.authority.artifacts,
        onAcceptedWorkFrozen: hCancel.bindings.onAcceptedWorkFrozen,
        runtime: hCancel.bindings.runtime,
      });
      const stopRes = await coordinator.prepare({
        requestId: "b408-cancel-stop",
        reason: "user-stop",
        strategy: "cancel",
        timeoutMs: 10_000,
      });
      expect(stopRes.phase).toBe("ready-to-stop");
      expect(cancelGate.aborts()).toBeGreaterThan(0);
    } finally {
      cancelGate.release();
      await hCancel.close();
    }
  }, 60_000);

  it("waits for BOTH Anchor and Local active turns when both domains are busy (and when only Local is busy)", async () => {
    const anchorGate = createControllableGate();
    const localGate = createControllableGate();
    const h = await createDualDomainHarness({
      anchorRunHook: async ({ reserveUsage }) => {
        anchorGate.markEntered();
        await anchorGate.hold;
        await reserveUsage?.();
        return "anchor finished";
      },
      localRunHook: async () => {
        localGate.markEntered();
        await localGate.hold;
        return "local finished";
      },
    });
    try {
      const anchorConvId = "chat-20261113-both";
      await getOrCreateActiveConversation(h.authority, h.anchorManager, anchorConvId);
      const anchorTurn = await h.submitAnchorTurn({
        conversationId: anchorConvId,
        turnId: "anchor-turn-both",
        text: "anchor work",
      });
      await anchorGate.entered;

      const localPort = h.localAssembly.port();
      const localConvId = await localPort.createConversation();
      expect(isLocalConversationId(localConvId)).toBe(true);
      const localTurnPromise = h.submitLocalTurn({
        conversationId: localConvId,
        turnId: "local-turn-both",
        text: "local work",
      });
      await localGate.entered;

      const coordinator = new HostStopCoordinator({
        journal: h.journal,
        homeId: h.homeId,
        localDeviceId: h.authority.deviceId,
        host: {
          kind: "foreground",
          processId: process.pid,
          startedAt: new Date().toISOString(),
        },
        acceptedWork: h.bindings.acceptedWork,
        artifactStore: h.authority.artifacts,
        onAcceptedWorkFrozen: h.bindings.onAcceptedWorkFrozen,
        runtime: h.bindings.runtime,
      });

      let settled = false;
      const prep = coordinator
        .prepare({
          requestId: "b408-both-busy",
          reason: "user-stop",
          strategy: "drain",
          timeoutMs: 10_000,
        })
        .then((r) => {
          settled = true;
          return r;
        });

      await new Promise((r) => setTimeout(r, 120));
      expect(settled).toBe(false);

      // Release Anchor first -> Local is still held (verifies Local busy / Anchor settled still blocks!)
      anchorGate.release();
      await anchorTurn.outcome;
      await new Promise((r) => setTimeout(r, 150));
      expect(settled).toBe(false);

      // Release Local -> now both domains settle to ready-to-stop
      localGate.release();
      const localRes = await localTurnPromise;
      expect(localRes.kind).toBe("settled");
      const res = await prep;
      expect(res.phase).toBe("ready-to-stop");
    } finally {
      anchorGate.release();
      localGate.release();
      await h.close();
    }
  }, 60_000);

  it("captures queued admitted-run intents before assignment, rejects post-close turns, preserves active work on timeout, and retries cleanly", async () => {
    const turnGates = new Map<string, ReturnType<typeof createControllableGate>>([
      ["queued-1", createControllableGate()],
      ["queued-2", createControllableGate()],
    ]);
    let callCount = 0;
    const h = await createDualDomainHarness({
      anchorRunHook: async ({ signal, reserveUsage }) => {
        callCount += 1;
        const gate = callCount === 1 ? turnGates.get("queued-1")! : turnGates.get("queued-2")!;
        gate.markEntered();
        await Promise.race([
          gate.hold,
          new Promise<never>((_, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                gate.recordAbort();
                reject(signal.reason ?? new Error("aborted"));
              },
              { once: true },
            );
          }),
        ]);
        await reserveUsage?.();
        return `completed-${callCount}`;
      },
    });
    try {
      const convId = "chat-20261113-queue";
      await getOrCreateActiveConversation(h.authority, h.anchorManager, convId);
      const t1 = await h.submitAnchorTurn({
        conversationId: convId,
        turnId: "turn-q1",
        text: "first turn",
      });
      expect(t1.admitted.status).toBe("immediate");
      await turnGates.get("queued-1")!.entered;

      // Enqueue second turn while first turn is running -> durably admitted before assignment!
      const t2 = await h.submitAnchorTurn({
        conversationId: convId,
        turnId: "turn-q2",
        text: "second queued turn",
      });
      expect(t2.admitted.status).toBe("queued");

      const coordinator = new HostStopCoordinator({
        journal: h.journal,
        homeId: h.homeId,
        localDeviceId: h.authority.deviceId,
        host: {
          kind: "foreground",
          processId: process.pid,
          startedAt: new Date().toISOString(),
        },
        acceptedWork: h.bindings.acceptedWork,
        artifactStore: h.authority.artifacts,
        onAcceptedWorkFrozen: h.bindings.onAcceptedWorkFrozen,
        runtime: h.bindings.runtime,
      });

      // Short timeout -> fails with HostStopAcceptedWorkPendingError WITHOUT aborting active turn!
      await expect(
        coordinator.prepare({
          requestId: "b408-timeout-retry",
          reason: "user-stop",
          strategy: "drain",
          timeoutMs: 80,
        }),
      ).rejects.toBeInstanceOf(HostStopAcceptedWorkPendingError);
      expect(turnGates.get("queued-1")!.aborts()).toBe(0);

      // Gate is now closed -> any new turn submission is rejected with lifecycle-busy
      const t3 = await h.submitAnchorTurn({
        conversationId: convId,
        turnId: "turn-q3-rejected",
        text: "post-close turn",
      });
      expect(t3.admitted.status).toBe("lifecycle-busy");

      // Verify frozen snapshot captured both admitted-run intents (including queued t2 before assignment!)
      const operationId = protocolDigest("HostStopOperation", 1, {
        requestId: "b408-timeout-retry",
        homeId: h.homeId,
      });
      const opState = await h.journal.state(operationId);
      expect(opState?.phase).toBe("gate-closed");
      const snapshot = await loadHostStopAcceptedWork(opState!, h.authority.artifacts);
      expect(
        snapshot.owners.intent.filter((i) => parseAdmittedConversationRunSource(i.id) !== undefined)
          .length,
      ).toBe(2);

      // Release both turns and retry the same stop request -> resumes from gate-closed to ready-to-stop!
      turnGates.get("queued-1")!.release();
      await turnGates.get("queued-2")!.entered;
      turnGates.get("queued-2")!.release();
      const [r1, r2] = await Promise.all([t1.outcome, t2.outcome]);
      expect(r1.kind).toBe("settled");
      expect(r2.kind).toBe("settled");

      const retryRes = await coordinator.prepare({
        requestId: "b408-timeout-retry",
        reason: "user-stop",
        strategy: "drain",
        timeoutMs: 10_000,
      });
      expect(retryRes.phase).toBe("ready-to-stop");
    } finally {
      turnGates.get("queued-1")!.release();
      turnGates.get("queued-2")!.release();
      await h.close();
    }
  }, 60_000);

  it("recovers cold restart from gate-closed after assignment and local resource leases are already released, and fails closed on unknown items", async () => {
    const gate = createControllableGate();
    const h1 = await createDualDomainHarness({
      anchorRunHook: async ({ reserveUsage }) => {
        gate.markEntered();
        await gate.hold;
        await reserveUsage?.();
        return "done before crash";
      },
    });
    const home = h1.home;
    const secretStore = h1.secretStore;
    const capacity = h1.capacity;
    let operationId = "";
    let frozenSnapshot!: HostStopAcceptedWorkSnapshot;
    try {
      const convId = "chat-20261113-cold";
      await getOrCreateActiveConversation(h1.authority, h1.anchorManager, convId);
      const t1 = await h1.submitAnchorTurn({
        conversationId: convId,
        turnId: "turn-cold-1",
        text: "freeze with active lease",
      });
      await gate.entered;

      const coordinator1 = new HostStopCoordinator({
        journal: h1.journal,
        homeId: h1.homeId,
        localDeviceId: h1.authority.deviceId,
        host: {
          kind: "foreground",
          processId: 999991,
          startedAt: "2026-11-14T00:00:00.000Z",
        },
        acceptedWork: h1.bindings.acceptedWork,
        artifactStore: h1.authority.artifacts,
        onAcceptedWorkFrozen: h1.bindings.onAcceptedWorkFrozen,
        runtime: h1.bindings.runtime,
      });
      await expect(
        coordinator1.prepare({
          requestId: "b408-cold-restart",
          reason: "user-stop",
          strategy: "drain",
          timeoutMs: 60,
        }),
      ).rejects.toBeInstanceOf(HostStopAcceptedWorkPendingError);

      operationId = protocolDigest("HostStopOperation", 1, {
        requestId: "b408-cold-restart",
        homeId: h1.homeId,
      });
      const opState1 = await h1.journal.state(operationId);
      frozenSnapshot = await loadHostStopAcceptedWork(opState1!, h1.authority.artifacts);
      expect(frozenSnapshot.owners.assignment.length).toBe(1);
      expect(frozenSnapshot.owners.lease.length).toBe(1);

      // Now let the turn complete and release its local resource lease BEFORE simulated crash!
      gate.release();
      const res1 = await t1.outcome;
      expect(res1.kind).toBe("settled");
    } finally {
      gate.release();
      await h1.close();
    }

    // Cold restart on same home directory with startupHostStopSnapshot pre-restored
    const h2 = await createDualDomainHarness({
      existingHome: home,
      existingSecretStore: secretStore,
      existingCapacity: capacity,
      startupLifecycle: {
        operationId,
        kind: "stop",
        alreadySettled: false,
      },
      startupHostStopSnapshot: frozenSnapshot,
    });
    try {
      // Fail-closed checks on unknown conversation / assignment / lease items
      await expect(
        restoreConversationHostStopSnapshot(
          {
            ...frozenSnapshot,
            owners: {
              ...frozenSnapshot.owners,
              conversation: [
                ...frozenSnapshot.owners.conversation,
                { id: "chat-unknown-999", revision: "bogus" },
              ],
            },
          },
          { anchor: h2.boundAnchorConversationStopOwner, local: h2.localAssembly },
        ),
      ).rejects.toThrow(/Unrecognized or unowned frozen conversation/);

      await expect(
        restoreConversationHostStopSnapshot(
          {
            ...frozenSnapshot,
            owners: {
              ...frozenSnapshot.owners,
              assignment: [{ id: "local:unknown-asg", revision: "bogus" }],
            },
          },
          { anchor: h2.boundAnchorConversationStopOwner, local: h2.localAssembly },
        ),
      ).rejects.toThrow(/Unrecognized or unowned frozen assignment/);

      await expect(
        restoreConversationHostStopSnapshot(
          {
            ...frozenSnapshot,
            owners: {
              ...frozenSnapshot.owners,
              lease: [{ id: "resv:unknown", revision: "bogus" }],
            },
          },
          { anchor: h2.boundAnchorConversationStopOwner, local: h2.localAssembly },
        ),
      ).rejects.toThrow(/Unrecognized or unowned frozen lease/);

      const coordinator2 = new HostStopCoordinator({
        journal: h2.journal,
        homeId: h2.homeId,
        localDeviceId: h2.authority.deviceId,
        host: {
          kind: "foreground",
          processId: process.pid,
          startedAt: new Date().toISOString(),
        },
        acceptedWork: h2.bindings.acceptedWork,
        artifactStore: h2.authority.artifacts,
        onAcceptedWorkFrozen: h2.bindings.onAcceptedWorkFrozen,
        runtime: h2.bindings.runtime,
        isHostStopped: async () => true,
      });
      const resumed = await coordinator2.resumeActive();
      expect(resumed.find((op) => op.identity.operationId === operationId)?.phase).toBe("terminal");
    } finally {
      await h2.close();
    }
  }, 60_000);

  it("Finding 1 regression: recovers legacy Anchor-only gate-closed snapshot with omitted inactive durable conversations while rejecting tampered revisions or omitted active work", async () => {
    const h1 = await createDualDomainHarness();
    const home = h1.home;
    const secretStore = h1.secretStore;
    const capacity = h1.capacity;
    const activeConvId = "chat-20261113-legacy-open";
    const historicalIdleConvId = "chat-20261110-legacy-idle";
    let operationId = "";
    let legacySnapshot!: HostStopAcceptedWorkSnapshot;
    try {
      // Create an inactive historical durable session on disk (not open in baseline boundConversations.list())
      await h1.anchorProtocol.ensureSession(historicalIdleConvId);
      // Create an active open session in memory
      await getOrCreateActiveConversation(h1.authority, h1.anchorManager, activeConvId);

      // Construct exact pre-upgrade Anchor-only gate-closed artifact:
      // - owners.conversation uses protocolDigest("HostStopConversation", 1, { conversationId, sessionId })
      // - historicalIdleConvId is omitted because baseline boundConversations.list() only listed open sessions
      operationId = protocolDigest("HostStopOperation", 1, {
        requestId: "legacy-anchor-stop",
        homeId: h1.homeId,
      });
      await h1.journal.accept({
        v: 1,
        kind: "stop",
        requestId: "legacy-anchor-stop",
        operationId,
        homeId: h1.homeId,
        localDeviceId: h1.authority.deviceId,
        strategy: "drain",
        host: {
          kind: "foreground",
          processId: 888881,
          startedAt: "2026-11-13T00:00:00.000Z",
        },
      });
      const noopPort = (items: readonly { id: string; revision: string }[]) => ({
        freeze: async () => items,
        settle: async () => {},
        readBack: async () => {},
      });
      const legacyPorts = Object.fromEntries(
        HOST_STOP_ACCEPTED_WORK_OWNERS.map((owner) => [
          owner,
          noopPort(
            owner === "conversation"
              ? [
                  {
                    id: activeConvId,
                    revision: protocolDigest("HostStopConversation", 1, {
                      conversationId: activeConvId,
                      sessionId: activeConvId,
                    }),
                  },
                ]
              : [],
          ),
        ]),
      ) as unknown as HostStopAcceptedWorkPorts;
      const stored = await freezeHostStopAcceptedWork(
        operationId,
        legacyPorts,
        h1.authority.artifacts,
      );
      legacySnapshot = stored.snapshot;
      await h1.journal.advance(operationId, "gate-closed", [stored.evidence]);
    } finally {
      await h1.close();
    }

    // Verify tampered { conversationId }-only revision AND omitted active session both fail closed!
    const hCheck = await createDualDomainHarness({
      existingHome: home,
      existingSecretStore: secretStore,
      existingCapacity: capacity,
      startupLifecycle: {
        operationId,
        kind: "stop",
        alreadySettled: false,
      },
    });
    try {
      await expect(
        restoreConversationHostStopSnapshot(
          {
            ...legacySnapshot,
            owners: {
              ...legacySnapshot.owners,
              conversation: [
                {
                  id: activeConvId,
                  revision: protocolDigest("HostStopConversation", 1, {
                    conversationId: activeConvId,
                  }),
                },
              ],
            },
          },
          { anchor: hCheck.boundAnchorConversationStopOwner, local: hCheck.localAssembly },
        ),
      ).rejects.toThrow(/revision does not match authoritative HostStopConversation identity/);

      // If historicalIdleConvId is open in memory at restore time while omitted from snapshot -> fail closed!
      await hCheck.anchorManager.getOrCreate(historicalIdleConvId);
      await expect(
        restoreConversationHostStopSnapshot(legacySnapshot, {
          anchor: hCheck.boundAnchorConversationStopOwner,
          local: hCheck.localAssembly,
        }),
      ).rejects.toThrow(/omits active conversation/);
    } finally {
      await hCheck.close();
    }

    // Cold-restart upgraded Host on the exact legacy gate-closed snapshot -> settles to terminal!
    const h2 = await createDualDomainHarness({
      existingHome: home,
      existingSecretStore: secretStore,
      existingCapacity: capacity,
      startupLifecycle: {
        operationId,
        kind: "stop",
        alreadySettled: false,
      },
      startupHostStopSnapshot: legacySnapshot,
    });
    try {
      const coordinator2 = new HostStopCoordinator({
        journal: h2.journal,
        homeId: h2.homeId,
        localDeviceId: h2.authority.deviceId,
        host: {
          kind: "foreground",
          processId: process.pid,
          startedAt: new Date().toISOString(),
        },
        acceptedWork: h2.bindings.acceptedWork,
        artifactStore: h2.authority.artifacts,
        onAcceptedWorkFrozen: h2.bindings.onAcceptedWorkFrozen,
        runtime: h2.bindings.runtime,
        isHostStopped: async () => true,
      });
      const resumed = await coordinator2.resumeActive();
      expect(resumed.find((op) => op.identity.operationId === operationId)?.phase).toBe("terminal");

      // Post-restore newly created durable conversation is NOT in #legacyIdleConversations -> fails assertSubsetItems!
      await h2.anchorProtocol.ensureSession("chat-20261114-unowned-post-restore");
      await expect(
        h2.bindings.acceptedWork.conversation.readBack({
          operationId,
          strategy: "drain",
          frozen: legacySnapshot.owners.conversation,
        }),
      ).rejects.toThrow(/unowned or successor/);
    } finally {
      await h2.close();
    }
  }, 60_000);

  it("Finding 2 regression: anchor-uninstall cold restart from gate-frozen initializes Anchor stop owner gate and settles or releases cleanly", async () => {
    const h1 = await createDualDomainHarness();
    const home = h1.home;
    const secretStore = h1.secretStore;
    const capacity = h1.capacity;
    const convId = "chat-20261114-uninstall";
    const operationId = "op-anchor-uninstall-migration-1";
    let frozenSnapshot!: HostStopAcceptedWorkSnapshot;
    try {
      await getOrCreateActiveConversation(h1.authority, h1.anchorManager, convId);
      await h1.bindings.currentRemoval.closeAdmission(operationId);
      const ownersEntries = await Promise.all(
        HOST_STOP_ACCEPTED_WORK_OWNERS.map(async (owner) => [
          owner,
          await h1.bindings.acceptedWork[owner].freeze(operationId),
        ]),
      );
      frozenSnapshot = {
        v: 1,
        operationId,
        owners: Object.fromEntries(ownersEntries) as HostStopAcceptedWorkSnapshot["owners"],
      };
    } finally {
      await h1.close();
    }

    // Cold restart with kind: "anchor-uninstall" skipping closeAdmission (just like migration at gate-frozen!)
    const h2 = await createDualDomainHarness({
      existingHome: home,
      existingSecretStore: secretStore,
      existingCapacity: capacity,
      startupLifecycle: {
        operationId,
        kind: "anchor-uninstall",
        alreadySettled: false,
      },
      startupHostStopSnapshot: frozenSnapshot,
    });
    try {
      await h2.bindings.currentRemoval.onFrozen(frozenSnapshot);
      for (const owner of HOST_STOP_ACCEPTED_WORK_OWNERS) {
        await h2.bindings.acceptedWork[owner].settle({
          operationId,
          strategy: "drain",
          timeoutMs: 5_000,
          frozen: frozenSnapshot.owners[owner],
        });
        await h2.bindings.acceptedWork[owner].readBack({
          operationId,
          strategy: "drain",
          frozen: frozenSnapshot.owners[owner],
        });
      }
      // Also verify currentRemoval.releaseAdmission cleanly reopens both conversation gates
      await h2.bindings.currentRemoval.releaseAdmission(operationId);
      expect(h2.bindings.getManagedHostStopping()).toBe(false);
      await getOrCreateActiveConversation(h2.authority, h2.anchorManager, convId);
      const postReleaseTurn = await h2.submitAnchorTurn({
        conversationId: convId,
        turnId: "turn-after-uninstall-cancel",
        text: "reopened gate works",
      });
      expect(postReleaseTurn.admitted.status).toBe("immediate");
      const out = await postReleaseTurn.outcome;
      expect(out.kind).toBe("settled");
    } finally {
      await h2.close();
    }
  }, 60_000);

  it("settles real setupDelivery queued/in-flight channel deliveries before channel disconnect, derives permits from legacy frozen assignment, and rejects unfrozen runs", async () => {
    let releaseChannelSend!: () => void;
    const channelSendHold = new Promise<void>((resolve) => {
      releaseChannelSend = resolve;
    });
    let markChannelSendEntered!: () => void;
    const channelSendEntered = new Promise<void>((resolve) => {
      markChannelSendEntered = resolve;
    });
    const timeline: string[] = [];

    const channelEffect: ChannelDeliveryEffectSource = {
      status: () => "connected",
      send: async () => {
        timeline.push("delivery-send-start");
        markChannelSendEntered();
        await channelSendHold;
        timeline.push("delivery-send-done");
        return { success: true, messageId: "msg-1", retryable: false };
      },
    };

    const h = await createDualDomainHarness({ withDelivery: channelEffect });
    let stopPromise: Promise<{ readonly phase: string }> | undefined;
    let drainTask: Promise<void> | undefined;
    try {
      const convId = "chat-20261114-delivery";
      const unfrozenConvId = "chat-20261114-unfrozen-delivery";
      await getOrCreateActiveConversation(h.authority, h.anchorManager, convId);

      // Enqueue a real channel control-response delivery before freeze
      await h.anchorProtocol.cancel({
        conversationId: convId,
        requestId: "cancel-before-stop",
        principal: {
          surfacePrincipal: "rpc:owner",
          deviceId: h.authority.deviceId,
          connectionId: "conn-deliv",
        },
        response: { replyTarget: { channelId: "feishu", to: "chat-1" } },
      });
      // Kick delivery so it enters in-flight send
      drainTask = h.deliveryStack!.flush();
      await channelSendEntered;

      const coordinator = new HostStopCoordinator({
        journal: h.journal,
        homeId: h.homeId,
        localDeviceId: h.authority.deviceId,
        host: {
          kind: "foreground",
          processId: process.pid,
          startedAt: new Date().toISOString(),
        },
        acceptedWork: h.bindings.acceptedWork,
        artifactStore: h.authority.artifacts,
        onAcceptedWorkFrozen: h.bindings.onAcceptedWorkFrozen,
        runtime: h.bindings.runtime,
      });

      stopPromise = coordinator.prepare({
        requestId: "b408-delivery-order",
        reason: "user-stop",
        strategy: "drain",
        timeoutMs: 10_000,
      });

      // Deterministically wait until accepted-work is frozen (`gate-closed`) and DeliveryLifecycle is installed & sealed at delivery.settle
      let activeOpId: string | undefined;
      const waitDeadline = Date.now() + 8_000;
      while (Date.now() < waitDeadline) {
        const activeOps = await h.journal.active();
        const op = activeOps[0];
        if (op?.phase === "gate-closed") {
          try {
            await h.deliveryStack!.lifecycle.read(op.identity.operationId);
            activeOpId = op.identity.operationId;
            break;
          } catch {
            // onAcceptedWorkFrozen still installing DeliveryLifecycle
          }
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(activeOpId).toBeDefined();
      await new Promise((r) => setTimeout(r, 200));
      await registerActiveConversation(h.authority, unfrozenConvId, new Date().toISOString());

      // Channel must NOT disconnect while delivery is still in-flight!
      expect(h.channelEvents).not.toContain("disconnect");

      const expectControlDeliveryRejected = async (
        fn: () => Promise<unknown>,
        pattern: RegExp,
      ) => {
        let caught: unknown;
        try {
          await fn();
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeDefined();
        const messages =
          caught instanceof AggregateError
            ? [caught.message, ...caught.errors.map((e) => String((e as Error)?.message ?? e))].join(
                "\n",
              )
            : String((caught as Error)?.message ?? caught);
        expect(messages).toMatch(pattern);
      };

      // 1) Unfrozen conversation source is rejected because it is outside the frozen lifecycle source exact-set
      await expectControlDeliveryRejected(
        () =>
          h.anchorProtocol.cancel({
            conversationId: unfrozenConvId,
            requestId: "cancel-unfrozen-conv",
            principal: {
              surfacePrincipal: "rpc:owner",
              deviceId: h.authority.deviceId,
              connectionId: "conn-deliv-unfrozen",
            },
            response: { replyTarget: { channelId: "feishu", to: "chat-1" } },
          }),
        /Delivery source is not part of the frozen lifecycle operation/,
      );

      // 2) Even the frozen conversation source is rejected once delivery.settle has sealed producer admission
      await expectControlDeliveryRejected(
        () =>
          h.anchorProtocol.cancel({
            conversationId: convId,
            requestId: "cancel-after-seal",
            principal: {
              surfacePrincipal: "rpc:owner",
              deviceId: h.authority.deviceId,
              connectionId: "conn-deliv-2",
            },
            response: { replyTarget: { channelId: "feishu", to: "chat-1" } },
          }),
        /Delivery producer admission is sealed for the lifecycle operation/,
      );

      releaseChannelSend();
      await drainTask;
      const stopRes = await stopPromise;
      expect(stopRes.phase).toBe("ready-to-stop");
      timeline.push(...h.channelEvents.filter((e) => e === "disconnect"));
      expect(timeline.indexOf("delivery-send-done")).toBeLessThan(timeline.indexOf("disconnect"));

      // Also verify legacy frozen assignment item derives exact admitted-run delivery source permit!
      const turnForProv = createControllableGate();
      const hLegacyAsg = await createDualDomainHarness({
        anchorRunHook: async ({ reserveUsage }) => {
          turnForProv.markEntered();
          await turnForProv.hold;
          await reserveUsage?.();
          return "ok";
        },
      });
      try {
        await getOrCreateActiveConversation(
          hLegacyAsg.authority,
          hLegacyAsg.anchorManager,
          "chat-prov",
        );
        const t = await hLegacyAsg.submitAnchorTurn({
          conversationId: "chat-prov",
          turnId: "turn-prov-1",
          text: "prov",
        });
        await turnForProv.entered;
        const closure = await hLegacyAsg.anchorProtocol.pendingClosureWork("chat-prov");
        expect(closure.items.assignments.length).toBe(1);
        const emptyOwners = Object.fromEntries(
          HOST_STOP_ACCEPTED_WORK_OWNERS.map((owner) => [owner, []]),
        ) as unknown as HostStopAcceptedWorkSnapshot["owners"];
        const legacyAsgSnapshot: HostStopAcceptedWorkSnapshot = {
          v: 1,
          operationId: "legacy-asg-op",
          owners: {
            ...emptyOwners,
            assignment: closure.items.assignments,
          },
        };
        const derivedSources = await resolveHostStopDeliveryLifecycleSources(legacyAsgSnapshot, {
          anchor: hLegacyAsg.boundAnchorConversationStopOwner,
          local: hLegacyAsg.localAssembly,
        });
        expect(
          derivedSources.some((s) => parseAdmittedConversationRunSource(s.id) !== undefined),
        ).toBe(true);
        turnForProv.release();
        await t.outcome;
      } finally {
        turnForProv.release();
        await hLegacyAsg.close();
      }
    } finally {
      releaseChannelSend();
      await drainTask?.catch(() => {});
      await stopPromise?.catch(() => {});
      await h.close();
    }
  }, 60_000);
});
