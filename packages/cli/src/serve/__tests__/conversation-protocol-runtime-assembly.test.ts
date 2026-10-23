// 拆分自 conversation-protocol-runtime.test.ts（按主题分文件以便并行执行）：assembly。
import { localConversationId } from "@zhixing/core/conversation";
import { userMessageFromTurnInput, type Message } from "@zhixing/core";
import { type AgentYield, type RunResult } from "@zhixing/core/loop";
import { type PermissionRule } from "@zhixing/core/security";
import { createSignedTrustRuleSnapshot, protocolDigest } from "@zhixing/core/protocol";
import { ConversationManager } from "@zhixing/owner-kernel/conversation-manager";
import { createInitialControlEnvelope } from "@zhixing/owner-kernel/control-admission";
import { DurableConversationAdmissionRejectedError } from "@zhixing/owner-kernel/run-turn";
import { type RuntimeFactory, type SessionRuntime } from "@zhixing/owner-kernel/types";
import { projectSessionTurn } from "@zhixing/rpc";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import { ConversationProtocolRuntime, DurableConversationInteractionObserver, createConversationAuxiliaryRecoveryAssemblyHandle, createConversationCommittedTurnListenerAssemblyHandle, createConversationManagerAssemblyHandle } from "../conversation-protocol-runtime.js";
import { anchorConversationOwnerRuntime } from "../conversation-owner-runtime.js";
import { fixtureLocalOwnerRuntime } from "./local-owner-assembly-fixture.js";
import { createConversationAssignmentArtifactAuthorityIndex, createConversationExecutorHostBoundary, ConversationExecutorTopologyAdapter, NO_REMOTE_CONVERSATION_EXECUTORS, type ConversationExecutorTopologyDirectory } from "../conversation-executor-dispatch.js";
import { TEST_EXECUTOR_READINESS, TEST_DURABLE_IO_TIMEOUT_MS, TEST_ANCHOR_LOSSLESS_DATA_PLANE, TEST_LOCAL_EXECUTOR, TEST_RUNTIME_AUTHORITY_FACTS, setupAuthorityRuntime, createProtocol, registerActiveConversation, getOrCreateActiveConversation, expectSettled, MemorySecretStore, mutationPublisher } from "./conversation-protocol-runtime-fixture.js";

describe("ConversationProtocolRuntime", () => {
  it("requires its private manager assembly handle to complete exactly once", () => {
    const assembly = createConversationManagerAssemblyHandle();
    const manager = {} as ConversationManager;

    expect(() => assembly.resolve()).toThrow(/not assembled/u);
    assembly.complete(manager);
    expect(assembly.resolve()).toBe(manager);
    expect(() => assembly.complete(manager)).toThrow(/already assembled/u);
  });

  it("requires its private auxiliary recovery handle to complete exactly once", async () => {
    const assembly = createConversationAuxiliaryRecoveryAssemblyHandle();
    const recover = vi.fn(async (_conversationId: string) => {});

    expect(() => assembly.resolve("conversation-before-complete")).toThrow(
      /not assembled/u,
    );
    assembly.complete(recover);
    await expect(assembly.resolve("conversation-ready")).resolves.toBeUndefined();
    expect(recover).toHaveBeenCalledWith("conversation-ready");
    expect(() => assembly.complete(recover)).toThrow(/already assembled/u);
  });

  it("requires its private committed-turn listener handle to complete exactly once", () => {
    const assembly = createConversationCommittedTurnListenerAssemblyHandle();
    const listener = vi.fn();
    const info = {} as Parameters<typeof assembly.notify>[0];

    expect(() => assembly.notify(info)).toThrow(/not assembled/u);
    assembly.complete(listener);
    assembly.notify(info);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(info);
    expect(() => assembly.complete(listener)).toThrow(/already assembled/u);
  });

  it("keeps mutation publisher ownership behind provenance binding leases", async () => {
    const home = await createTempDir("conversation-protocol-publisher-lease");
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
    });
    const protocol = createProtocol({
      authority,
      manager: () => {
        throw new Error("manager is not used by publisher binding");
      },
      interactions: new DurableConversationInteractionObserver(),
    });
    const oldPublisher = mutationPublisher("old");
    const replacementPublisher = mutationPublisher("replacement");
    const foreignPublisher = mutationPublisher("foreign");

    const releaseOld = protocol.bindMutationPublisher(oldPublisher);
    expect(() => protocol.bindMutationPublisher(replacementPublisher)).toThrow(
      "Conversation mutation publisher is already bound",
    );

    releaseOld();
    const releaseReplacement = protocol.bindMutationPublisher(replacementPublisher);
    releaseOld();
    expect(() => protocol.bindMutationPublisher(foreignPublisher)).toThrow(
      "Conversation mutation publisher is already bound",
    );

    releaseReplacement();
    expect(() => protocol.bindMutationPublisher(foreignPublisher)).not.toThrow();
  });

  it("requires executor dispatch and an immutable Host topology directory", async () => {
    const home = await createTempDir("conversation-protocol-dispatch-owner");
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
    });
    expect(() =>
      new ConversationProtocolRuntime({
        authority,
        losslessDataPlane: TEST_ANCHOR_LOSSLESS_DATA_PLANE,
        manager: () => {
          throw new Error("test manager is unavailable");
        },
        recoverAuxiliary: async () => {},
        interactions: new DurableConversationInteractionObserver(),
        executorDispatch: undefined as never,
        assignmentArtifactAuthority: createConversationAssignmentArtifactAuthorityIndex(),
      })
    ).toThrow("Conversation protocol requires the executor dispatch application");

    expect(() =>
      new ConversationProtocolRuntime({
        authority,
        losslessDataPlane: TEST_ANCHOR_LOSSLESS_DATA_PLANE,
        manager: () => {
          throw new Error("test manager is unavailable");
        },
        recoverAuxiliary: undefined as never,
        interactions: new DurableConversationInteractionObserver(),
        executorDispatch: createConversationExecutorHostBoundary({
          authority: anchorConversationOwnerRuntime(authority),
          directory: NO_REMOTE_CONVERSATION_EXECUTORS,
          clock: () => new Date().toISOString(),
        }).application,
        assignmentArtifactAuthority: createConversationAssignmentArtifactAuthorityIndex(),
      })
    ).toThrow("Conversation protocol requires auxiliary recovery");

    const first: ConversationExecutorTopologyDirectory = {
      candidates: async () => [],
      forExecutor: () => undefined,
    };
    const topology = new ConversationExecutorTopologyAdapter(first);
    expect(topology).not.toHaveProperty("bindDirectory");
    expect(() => new ConversationExecutorTopologyAdapter(undefined as never)).toThrow(
      "Conversation executor topology directory is required",
    );
  });

  it("runs and recovers a device-local conversation entirely on the executor authority domain", async () => {
    const home = await createTempDir("conversation-protocol-local-owner");
    const secretStore = new MemorySecretStore();
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore });
    await authority.installPermissionSnapshot(
      createSignedTrustRuleSnapshot(
        {
          snapshotVersion: 1,
          rules: [],
          generatedAt: new Date().toISOString(),
        },
        authority.signer,
      ),
    );
    const conversationId = localConversationId(
      authority.deviceId,
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
    let executions = 0;
    const runtime: SessionRuntime = {
      ...TEST_RUNTIME_AUTHORITY_FACTS,
      sessionId: "runtime-local-owner",
      async *run(messages): AsyncGenerator<AgentYield, RunResult> {
        executions += 1;
        const assistant: Message = {
          role: "assistant",
          content: [{ type: "text", text: "local done" }],
        };
        return {
          agentResult: {
            reason: "completed",
            message: assistant,
            usage: { inputTokens: 2, outputTokens: 2 },
          },
          runRecord: {
            timestamp: new Date().toISOString(),
            messages: [messages.at(-1)!, assistant],
            usage: { inputTokens: 2, outputTokens: 2 },
            source: "interactive",
          },
          newMessages: [assistant],
          durationMs: 1,
        };
      },
      abort: () => false,
      async dispose() {},
    };
    const factory: RuntimeFactory = { create: vi.fn(async () => runtime) };
    let manager!: ConversationManager;
    const protocol = createProtocol({
      owner: fixtureLocalOwnerRuntime(authority),
      manager: () => manager,
      interactions: new DurableConversationInteractionObserver(),
      localExecutor: {
        ...TEST_LOCAL_EXECUTOR,
        runtimeFactory: factory,
      },
    });
    manager = new ConversationManager(factory, undefined, {
      ensureConversation: (id) => protocol.ensureSession(id),
      initTranscript: (id) => protocol.ensureSession(id),
      appendRun: async () => {
        throw new Error("local owner must not use legacy transcript persistence");
      },
      appendCommittedRun: async (_id, record) => ({
        runIndex: record.runIndex,
        shardId: "owner-log",
        appended: true,
      }),
      durableTurnExecutor: protocol,
      onTurnCommitted: () => {},
    });
    await protocol.ensureSession(conversationId);
    const managed = await manager.getOrCreate(conversationId);
    const first = await projectSessionTurn({
      manager,
      managed,
      text: "run locally",
      turnId: "local:turn:1",
      runOptions: {
        source: "interactive",
        turnContext: { turnId: "local:turn:1" },
      },
      notify: () => {},
    });
    expectSettled(first);
    expect(executions).toBe(1);

    const executorEntries = (await authority.executorLog.readAll()).flatMap(
      (commit) => commit.entries,
    );
    expect(
      executorEntries.some((entry) => entry.stream === `run:${conversationId}`),
    ).toBe(true);
    expect(
      executorEntries.some((entry) => entry.stream.includes(conversationId)),
    ).toBe(true);
    expect(
      (await authority.authorityLog.readAll())
        .flatMap((commit) => commit.entries)
        .some((entry) => entry.stream.includes(conversationId)),
    ).toBe(false);
    const restartedAuthority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore,
    });
    let restartedManager!: ConversationManager;
    const restartedProtocol = createProtocol({
      owner: fixtureLocalOwnerRuntime(restartedAuthority),
      manager: () => restartedManager,
      interactions: new DurableConversationInteractionObserver(),
      localExecutor: {
        ...TEST_LOCAL_EXECUTOR,
        runtimeFactory: factory,
      },
    });
    restartedManager = new ConversationManager(factory, undefined, {
      ensureConversation: (id) => restartedProtocol.ensureSession(id),
      initTranscript: (id) => restartedProtocol.ensureSession(id),
      appendRun: async () => {
        throw new Error("local owner must not use legacy transcript persistence");
      },
      appendCommittedRun: async (_id, record) => ({
        runIndex: record.runIndex,
        shardId: "owner-log",
        appended: false,
      }),
      durableTurnExecutor: restartedProtocol,
      onTurnCommitted: () => {},
    });
    await restartedProtocol.recover();
    expect(await restartedProtocol.listSessions()).toEqual([conversationId]);
    const meta = await restartedProtocol.sessionState.readSessionMeta(
      conversationId,
      {
        principal: { kind: "host", component: "local-owner-test" },
        requestId: "local-owner-test:meta",
        deadlineAt: new Date(Date.now() + 30_000).toISOString(),
      },
    );
    expect(meta.turnCount).toBe(1);
    expect(executions).toBe(1);

    const ownerContext = (requestId: string) => ({
      principal: { kind: "host" as const, component: "local-owner-test" },
      requestId,
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    });
    await restartedProtocol.sessionState.mutate(
      conversationId,
      {
        kind: "task-list-op",
        op: {
          op: "set",
          state: {
            items: [
              { id: "local-task", content: "finish locally", status: "in_progress" },
            ],
          },
        },
      },
      ownerContext("local-owner-test:task-list"),
    );
    await restartedProtocol.sessionState.mutate(
      conversationId,
      { kind: "session-meta", patch: { name: "Local durable session" } },
      ownerContext("local-owner-test:rename"),
    );
    await restartedProtocol.sessionState.mutate(
      conversationId,
      { kind: "window-op", op: "compact" },
      ownerContext("local-owner-test:compact"),
    );
    expect(
      await restartedProtocol.sessionState.readTaskList(
        conversationId,
        ownerContext("local-owner-test:read-task-list"),
      ),
    ).toEqual({
      items: [
        { id: "local-task", content: "finish locally", status: "in_progress" },
      ],
    });
    const transcript = await restartedProtocol.sessionState.readTranscriptTail(
      conversationId,
      ownerContext("local-owner-test:read-transcript"),
      undefined,
      10,
    );
    expect(transcript.records).toHaveLength(1);
    expect(
      await restartedProtocol.sessionState.readSessionMeta(
        conversationId,
        ownerContext("local-owner-test:read-renamed-meta"),
      ),
    ).toMatchObject({ name: "Local durable session", turnCount: 1 });

    await restartedProtocol.sessionState.mutate(
      conversationId,
      { kind: "window-op", op: "clear" },
      ownerContext("local-owner-test:clear"),
    );
    expect(
      await restartedProtocol.sessionState.readTaskList(
        conversationId,
        ownerContext("local-owner-test:read-cleared-task-list"),
      ),
    ).toEqual({ items: [] });
    expect(
      await restartedProtocol.sessionState.readSessionMeta(
        conversationId,
        ownerContext("local-owner-test:read-cleared-meta"),
      ),
    ).toMatchObject({ turnCount: 0 });
    const deleteConversationId = localConversationId(
      restartedAuthority.deviceId,
      "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    );
    await restartedProtocol.ensureSession(deleteConversationId);
    await restartedProtocol.sessionState.mutate(
      deleteConversationId,
      { kind: "conversation-delete" },
      ownerContext("local-owner-test:delete"),
    );
    await expect(restartedProtocol.sessionExists(deleteConversationId)).resolves.toBe(false);
    const listSessions = vi.spyOn(restartedProtocol, "listSessions").mockRejectedValue(new Error("Single-conversation queries must not enumerate unrelated conversations"));
    await expect(restartedProtocol.inspectMessage(deleteConversationId, "missing")).resolves.toBeUndefined();
    await expect(restartedProtocol.messageInputsOutsideHistory(deleteConversationId)).resolves.toEqual({ inputs: [], truncated: false });
    await expect(restartedProtocol.inspectMessage("missing", "missing")).resolves.toBeUndefined();
    await expect(restartedProtocol.messageInputsOutsideHistory(conversationId)).resolves.toMatchObject({ inputs: expect.any(Array) });
    expect(listSessions).not.toHaveBeenCalled();
    listSessions.mockRestore();
    await expect(
      restartedProtocol.sessionState.mutate(
        deleteConversationId,
        { kind: "conversation-delete" },
        ownerContext("local-owner-test:delete"),
      ),
    ).resolves.toEqual({ revision: 1 });
    await expect(
      restartedProtocol.sessionState.mutate(
        deleteConversationId,
        { kind: "session-meta", patch: { name: "must not resurrect" } },
        ownerContext("local-owner-test:after-delete"),
      ),
    ).rejects.toMatchObject({ code: "not-found" });
    const missingConversationId = localConversationId(
      restartedAuthority.deviceId,
      "01ARZ3NDEKTSV4RRFFQ69G5FAX",
    );
    await expect(
      restartedProtocol.sessionState.mutate(
        missingConversationId,
        { kind: "window-op", op: "compact" },
        ownerContext("local-owner-test:missing"),
      ),
    ).rejects.toMatchObject({ code: "not-found" });
    await expect(restartedProtocol.ensureSession("conversation-anchor")).rejects.toThrow(
      "does not belong to this owner domain",
    );
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("establishes the owner session identity before the first input and workscene activity", async () => {
    const home = await createTempDir("conversation-protocol-session-identity");
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
    });
    const protocol = createProtocol({
      authority,
      manager: () => {
        throw new Error("manager is not used by admission");
      },
      interactions: new DurableConversationInteractionObserver(),
    });

    const conversationId = "conversation-first-input";
    await expect(protocol.admit({
      conversationId,
      input: "first input",
      invocation: { kind: "agent", source: "interactive" },
      options: {
        source: "interactive",
        turnContext: { turnId: "rpc:first-input" },
      },
      surfacePrincipal: "rpc:owner",
    })).resolves.toMatchObject({ shouldSchedule: true });

    const worksceneConversation = "ws:scene-first-activity:primary";
    await expect(protocol.touchWorksceneSession({
      conversationId: worksceneConversation,
      sceneId: "scene-first-activity",
      requestId: "workscene-enter:scene-first-activity",
      at: new Date().toISOString(),
    })).resolves.toMatchObject({ revision: 1 });

    const creations = (await authority.authorityLog.readAll())
      .flatMap((commit) => commit.entries)
      .map((entry) => entry.body as {
        t?: string;
        envelope?: { body?: { t?: string; sceneId?: string } };
      })
      .filter((body) =>
        body.t === "received" && body.envelope?.body?.t === "session-create"
      );
    expect(creations.map((body) => body.envelope.body)).toEqual([
      { t: "session-create" },
      { t: "session-create", sceneId: "scene-first-activity" },
    ]);
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("durably binds first-party environment selection to admission and rejects channel construction", async () => {
    const home = await createTempDir("conversation-protocol-environment-selection");
    const secretStore = new MemorySecretStore();
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore,
    });
    const conversationId = "conversation-environment-selection";
    let manager!: ConversationManager;
    const protocol = createProtocol({
      authority,
      manager: () => manager,
      interactions: new DurableConversationInteractionObserver(),
    });
    manager = new ConversationManager(
      {
        create: vi.fn(async () => ({
          ...TEST_RUNTIME_AUTHORITY_FACTS,
          sessionId: conversationId,
          async *run(): AsyncGenerator<AgentYield, RunResult> {
            throw new Error("environment admission must not execute");
          },
          abort: () => false,
          async dispose() {},
        })),
      },
      undefined,
      { durableTurnExecutor: protocol, onTurnCommitted: () => {} },
    );
    await getOrCreateActiveConversation(authority, manager, conversationId);

    const firstParty = {
      conversationId,
      input: "use selected workspace",
      invocation: { kind: "agent" as const, source: "interactive" as const },
      environment: {
        workspace: { deviceId: authority.deviceId, bindingRef: "workspace-a" },
      },
      options: {
        source: "interactive" as const,
        turnContext: {
          turnId: "rpc:environment-selection",
          turnOrigin: { channel: "rpc", triggeredBy: "connection-1" },
        },
      },
      surfacePrincipal: "rpc:owner",
    };
    const admitted = await protocol.admit(firstParty);

    const replayProtocol = createProtocol({
      authority,
      manager: () => manager,
      interactions: new DurableConversationInteractionObserver(),
    });
    await expect(replayProtocol.admit(firstParty)).resolves.toEqual({
      runId: admitted.runId,
      shouldSchedule: true,
    });
    replayProtocol.deferScheduling(conversationId, admitted.runId);
    const conflictingReplay = replayProtocol.admit({
        ...firstParty,
        environment: {
          workspace: { deviceId: authority.deviceId, bindingRef: "workspace-b" },
        },
      });
    await expect(conflictingReplay).rejects.toBeInstanceOf(
      DurableConversationAdmissionRejectedError,
    );
    await expect(conflictingReplay).rejects.toThrow(/payload|bound|conflict/iu);

    await expect(
      protocol.admit({
        ...firstParty,
        options: {
          source: "channel",
          turnContext: {
            turnId: "feishu:environment-selection",
            turnOrigin: {
              channel: "feishu",
              triggeredBy: "user-a",
              target: { channelId: "feishu", to: "chat-a", threadId: "thread-a" },
            },
          },
        },
      }),
    ).rejects.toThrow("Only first-party");
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("requires the matching upload grant before admitting attachments", async () => {
    let now = new Date().toISOString();
    const home = await createTempDir("conversation-protocol-attachments");
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
      clock: () => now,
    });
    const protocol = createProtocol({
      authority,
      manager: () => {
        throw new Error("manager is not used by admission");
      },
      clock: () => now,
      interactions: new DurableConversationInteractionObserver(),
    });
    const stored = await authority.artifacts.put(
      Buffer.from("surface attachment"),
    );
    const attachment = { ...stored, kind: "file" as const };
    const conversationId = "conversation-attachments";
    const turnId = "rpc:attachment";
    const surfacePrincipal = "rpc:owner";
    const ingress = {
      kind: "first-party" as const,
      surfacePrincipal,
      deviceId: authority.deviceId,
      ingressId: turnId,
      receivedAt: now,
    };
    const requestId = `input:${protocolDigest("ConversationInputIdentity", 1, {
      surfacePrincipal,
      ingressId: turnId,
    })}`;
    const invocation = { kind: "agent" as const, source: "interactive" as const };
    const envelope = createInitialControlEnvelope({
      requestId,
      source: {
        principal: {
          surfacePrincipal,
          deviceId: authority.deviceId,
          connectionId: "connection:local",
        },
        ingress,
      },
      at: now,
      body: {
        t: "input",
        conversationId,
        ingress: { ingressId: turnId, source: "first-party" },
        input: { parts: [{ type: "text", text: "inspect attachment" }] },
        attachments: [attachment],
        invocation,
        ownerEpoch: authority.anchorEpoch,
      },
    });
    const issueRequest = {
      kind: "asset-upload" as const,
      scope: {
        domain: "conversation" as const,
        conversationId,
        ownerEpoch: authority.anchorEpoch,
      },
      surfacePrincipal,
      requestId,
      assets: [stored],
      payloadDigest: envelope.payloadDigest,
    };
    await expect(authority.surfaceAssets.issue(issueRequest)).rejects.toThrow(
      "not owned",
    );
    await registerActiveConversation(authority, conversationId, now);
    await expect(
      authority.surfaceAssets.issue({
        ...issueRequest,
        scope: {
          ...issueRequest.scope,
          ownerEpoch: authority.anchorEpoch + 1,
        },
      }),
    ).rejects.toThrow("not owned");
    await authority.surfaceAssets.issue({
      ...issueRequest,
    });
    const input = {
      conversationId,
      input: "inspect attachment",
      attachments: [attachment],
      invocation,
      options: {
        source: "interactive" as const,
        turnContext: { turnId },
      },
      surfacePrincipal,
    };

    const first = await protocol.admit(input);
    expect(first).toMatchObject({
      shouldSchedule: true,
    });
    await expect(
      authority.surfaceAssets.issue({
        kind: "asset-download",
        scope: {
          domain: "conversation",
          conversationId,
          ownerEpoch: authority.anchorEpoch,
        },
        surfacePrincipal,
        requestId: "request-download-adopted",
        assets: [stored],
      }),
    ).resolves.toMatchObject({ kind: "asset-download" });
    now = new Date(Date.parse(now) + 2 * 60 * 60 * 1_000).toISOString();
    await expect(protocol.admit(input)).resolves.toMatchObject({
      runId: first.runId,
      shouldSchedule: false,
    });
    await expect(
      protocol.admit({
        ...input,
        options: {
          ...input.options,
          turnContext: { turnId: "rpc:attachment-without-grant" },
        },
      }),
    ).rejects.toThrow(/upload grant is unknown/);
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("continues a durable receipt after its upload grant expires", async () => {
    let now = new Date().toISOString();
    const home = await createTempDir("conversation-protocol-pending-attachment");
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
      clock: () => now,
    });
    const protocol = createProtocol({
      authority,
      manager: () => {
        throw new Error("manager is not used by admission");
      },
      clock: () => now,
      interactions: new DurableConversationInteractionObserver(),
    });
    const stored = await authority.artifacts.put(Buffer.from("pending attachment"));
    const attachment = { ...stored, kind: "file" as const };
    const conversationId = "conversation-pending-attachment";
    const turnId = "rpc:pending-attachment";
    const surfacePrincipal = "rpc:owner";
    const ingress = {
      kind: "first-party" as const,
      surfacePrincipal,
      deviceId: authority.deviceId,
      ingressId: turnId,
      receivedAt: now,
    };
    const requestId = `input:${protocolDigest("ConversationInputIdentity", 1, {
      surfacePrincipal,
      ingressId: turnId,
    })}`;
    const invocation = { kind: "agent" as const, source: "interactive" as const };
    const source = {
      principal: {
        surfacePrincipal,
        deviceId: authority.deviceId,
        connectionId: "connection:local",
      },
      ingress,
    };
    const envelope = createInitialControlEnvelope({
      requestId,
      source,
      at: now,
      body: {
        t: "input",
        conversationId,
        ingress: { ingressId: turnId, source: "first-party" },
        input: { parts: [{ type: "text", text: "resume pending attachment" }] },
        attachments: [attachment],
        invocation,
        ownerEpoch: authority.anchorEpoch,
      },
    });
    await registerActiveConversation(authority, conversationId, now);
    await authority.surfaceAssets.issue({
      kind: "asset-upload",
      scope: {
        domain: "conversation",
        conversationId,
        ownerEpoch: authority.anchorEpoch,
      },
      surfacePrincipal,
      requestId,
      assets: [stored],
      payloadDigest: envelope.payloadDigest,
    });
    await authority.authorityLog.append([
      {
        stream: "control",
        body: { t: "received", requestId, envelope, ingress },
      },
    ]);
    const adoption = vi.spyOn(authority.surfaceAssets, "assertUploadAdoption");
    now = new Date(Date.parse(now) + 2 * 60 * 60 * 1_000).toISOString();

    await expect(
      protocol.admit({
        conversationId,
        input: "resume pending attachment",
        attachments: [attachment],
        invocation,
        options: {
          source: "interactive",
          turnContext: { turnId },
        },
        surfacePrincipal,
      }),
    ).resolves.toMatchObject({ shouldSchedule: true });
    expect(adoption).not.toHaveBeenCalled();
    const records = (await authority.authorityLog.readStream("control"))
      .map((entry) => entry.body as { t?: string; requestId?: string })
      .filter((record) => record.requestId === requestId);
    expect(records.map((record) => record.t)).toEqual(["received", "applied"]);
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("recovers expired reservations on both resource-governor halves", async () => {
    const home = await createTempDir("conversation-protocol-resource-recovery");
    const secretStore = new MemorySecretStore();
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore });
    const anchorRecovery = vi.spyOn(authority.resourceGovernor, "reclaimExpired");
    const executorRecovery = vi.spyOn(
      authority.executorResourceGovernor,
      "reclaimExpired",
    );
    const protocol = createProtocol({
      authority,
      manager: () => {
        throw new Error("empty recovery must not load a conversation manager");
      },
      interactions: new DurableConversationInteractionObserver(),
    });

    await protocol.recover();

    expect(anchorRecovery).toHaveBeenCalledOnce();
    expect(executorRecovery).toHaveBeenCalledOnce();
  }, TEST_DURABLE_IO_TIMEOUT_MS);

  it("binds exact runtime facts and rejects readiness drift before received", async () => {
    const home = await createTempDir("conversation-protocol-runtime-binding");
    const secretStore = new MemorySecretStore();
    let readiness = {
      ...TEST_EXECUTOR_READINESS,
      tools: ["web_fetch"],
      mcpServers: ["server-a"],
    };
    const readinessReads: string[][] = [];
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore,
      executorReadiness: () => {
        readinessReads.push([...readiness.tools]);
        return readiness;
      },
    });
    const rule: PermissionRule = {
      id: "rule-runtime-binding",
      pattern: { tool: "bash", argument: "npm test" },
      decision: "allow",
      scope: "global",
      createdAt: 1,
      lastMatchedAt: 2,
      matchCount: 3,
    };
    const runtime: SessionRuntime = {
      sessionId: "runtime-binding",
      executionPermissionRules: () => [rule],
      securitySnapshot: () => ({
        contextId: { kind: "main" },
        workspacePath: null,
        permissionRules: [],
        builtinRules: [],
        rateLimits: [],
        confirmations: [],
      }),
      executionProfile: () => ({
        tools: ["web_fetch"],
        mcpServers: ["server-a"],
        providerIds: [],
      }),
      async *run(): AsyncGenerator<AgentYield, RunResult> {
        throw new Error("runtime must not start after readiness drift");
      },
      abort: () => false,
      async dispose() {},
    };
    const prepare = authority.prepareConversationAssignment;
    let prepared: Awaited<ReturnType<typeof prepare>> | undefined;
    const validateBinding = authority.validateConversationRuntimeBinding;
    const bindingResults: Array<Awaited<ReturnType<typeof validateBinding>>> = [];
    const validateBindingSpy = vi
      .spyOn(authority, "validateConversationRuntimeBinding")
      .mockImplementation(async (input) => {
        const result = await validateBinding(input);
        bindingResults.push(result);
        return result;
      });
    const prepareSpy = vi
      .spyOn(authority, "prepareConversationAssignment")
      .mockImplementation(async (input) => {
        prepared = await prepare(input);
        readiness = { ...readiness, tools: [] };
        return prepared;
      });
    let manager!: ConversationManager;
    const protocol = createProtocol({
      authority,
      manager: () => manager,
      interactions: new DurableConversationInteractionObserver(),
    });
    manager = new ConversationManager(
      { create: vi.fn(async () => runtime) },
      undefined,
      { durableTurnExecutor: protocol, onTurnCommitted: () => {} },
    );
    const managed = await getOrCreateActiveConversation(
      authority,
      manager,
      "conversation-runtime-binding",
    );
    const execution = protocol.run({
      conversationId: managed.conversationId,
      input: "check binding",
      messages: [userMessageFromTurnInput("check binding")],
      baseRevision: managed.turnCount,
      runtime,
      invocation: { kind: "agent", source: "interactive" },
      options: {
        source: "interactive",
        turnContext: { turnId: "rpc:runtime-binding" },
      },
    });
    try {
      await expect(execution.next()).rejects.toThrow(
        "Local executor rejected a freshly issued assignment",
      );
      expect(validateBindingSpy).toHaveBeenCalledOnce();
      expect(readinessReads).toEqual([["web_fetch"], ["web_fetch"], []]);
      expect(bindingResults).toMatchObject([
        { code: "capability-gap", retryable: true },
      ]);
      expect(prepared?.policy.manifestCapabilities).toMatchObject({
        tools: ["web_fetch"],
        mcpServers: ["server-a"],
      });
      expect(prepared?.policy.permissionSnapshot.rules).toEqual([
        {
          id: rule.id,
          pattern: rule.pattern,
          decision: rule.decision,
          scope: rule.scope,
          createdAt: rule.createdAt,
        },
      ]);
      const entries = (await authority.authorityLog.readAll()).flatMap(
        (commit) => commit.entries,
      );
      expect(entries.map((entry) => (entry.body as { t?: string }).t)).toContain(
        "assigned",
      );
      const assignmentEntries = await Promise.all(
        (await authority.executorLog.readAll())
          .flatMap((commit) => commit.entries)
          .filter((entry) => entry.stream.startsWith("assignment:"))
          .map(async (entry) => {
            const body = entry.body as {
              readonly recordSeq?: number;
              readonly body?: { readonly t?: string };
              readonly ref?: Parameters<typeof authority.artifacts.get>[0];
            };
            if (body.ref === undefined) return body;
            return JSON.parse(
              Buffer.from(await authority.artifacts.get(body.ref)).toString("utf8"),
            ) as {
              readonly recordSeq: number;
              readonly body: { readonly t?: string };
            };
          }),
      );
      expect(assignmentEntries.map((entry) => entry.body?.t)).toEqual([
        "control-lease-renewed",
        "dispatch-rejected",
      ]);
    } finally {
      validateBindingSpy.mockRestore();
      prepareSpy.mockRestore();
    }
  }, TEST_DURABLE_IO_TIMEOUT_MS);
});
