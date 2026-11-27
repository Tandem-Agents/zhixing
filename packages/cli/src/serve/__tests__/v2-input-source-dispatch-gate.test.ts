import { afterEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import type { Message } from "@zhixing-ai/core";
import type { AgentYield, RunResult } from "@zhixing-ai/core/loop";
import type { RunExecutorPort, TrustRuleSnapshot } from "@zhixing-ai/core/contracts";
import {
  createSignedCapabilityDescriptor,
  createSignedExecutorVersionInventory,
} from "@zhixing-ai/core/protocol";
import { DeviceKey, enrollDeviceIdentity } from "@zhixing-ai/mesh/device-identity";
import { ConversationAssignmentLedger, InProcessAssignmentSubmission } from "@zhixing-ai/executor";
import { ConversationManager } from "@zhixing-ai/owner-kernel/conversation-manager";
import { ConversationRunJournal } from "@zhixing-ai/owner-kernel/conversation-assignment";
import { projectSessionTurn } from "@zhixing-ai/rpc";
import type { RuntimeFactory, SessionRuntime } from "@zhixing-ai/owner-kernel/types";
import { createTempDir } from "@zhixing-ai/test-utils";
import { anchorConversationOwnerRuntime } from "../conversation-owner-runtime.js";
import {
  createConversationExecutorHostBoundary,
  type ConversationExecutorTopologyDirectory,
  type ConversationExecutorTopologyTarget,
} from "../conversation-executor-dispatch.js";
import {
  MemorySecretStore,
  TEST_RUNTIME_AUTHORITY_FACTS,
  createProtocol,
  getOrCreateActiveConversation,
  setupAuthorityRuntime,
} from "./conversation-protocol-runtime-fixture.js";

const CLEANUPS: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (CLEANUPS.length > 0) {
    const fn = CLEANUPS.pop()!;
    await fn();
  }
});

async function makeLegacyRemoteCandidate(executorId: string) {
  const remoteKey = await DeviceKey.generate();
  const now = new Date().toISOString();
  const remoteIdentity = enrollDeviceIdentity(remoteKey, {
    displayName: "legacy-remote",
    platform: "linux",
    enrolledAt: now,
  });
  const dispatchCalls: unknown[] = [];
  const executor: RunExecutorPort = {
    async dispatch(envelope) {
      dispatchCalls.push(envelope);
      return { accepted: true };
    },
    async poll() {
      return [];
    },
    async cancel() {},
  };
  const target: ConversationExecutorTopologyTarget = {
    executorId,
    deviceId: remoteIdentity.deviceId,
    executor,
    async synchronizePermission(snapshot: TrustRuleSnapshot, executionAssets) {
      const assetBundle =
        typeof executionAssets === "function" ? await executionAssets() : executionAssets;
      const descriptor = createSignedCapabilityDescriptor(
        {
          executorId,
          revision: 1,
          protocolVersion: "1",
          workspaces: [],
          tools: ["load_skill", "read"],
          mcpServers: [],
          credentialBindings: [],
          evidenceCapabilities: [],
          at: now,
        },
        remoteKey,
      );
      const inventory = createSignedExecutorVersionInventory(
        {
          executorId,
          inventoryRevision: 1,
          capabilityRevision: 1,
          configVersions: {
            runtimeConfigRev: 1,
            modelProfileRev: 1,
            policyRev: 1,
          },
          assetVersions: {
            skillsRev: Math.max(1, assetBundle?.snapshot.skillCatalogRevision ?? 1),
            rubricsRev: 1,
            promptAssetsRev: 1,
          },
          permissionSnapshotHighWater: snapshot.snapshotVersion,
          credentialBindingRevisions: [],
          at: now,
        },
        remoteKey,
      );
      return { descriptor, inventory };
    },
  };
  const directory: ConversationExecutorTopologyDirectory = {
    candidates: async () => [target],
    forExecutor: (id) => (id === executorId ? target : undefined),
  };
  return { remoteIdentity, target, directory, dispatchCalls };
}

function makeLocalRuntimeFactory(executions: string[]): RuntimeFactory {
  return {
    async create(conversationId: string): Promise<SessionRuntime> {
      return {
        ...TEST_RUNTIME_AUTHORITY_FACTS,
        sessionId: `local-${conversationId}`,
        async *run(messages, options): AsyncGenerator<AgentYield, RunResult> {
          executions.push(conversationId);
          const meter = options?.modelCallResourceMeter;
          if (meter) {
            const reserved = await meter.reserve({ callIndex: 1, tokenUpperBound: 8 });
            await meter.consume({ usageId: reserved.usageId, tokens: 2 });
          }
          const user = messages.at(-1)!;
          const assistant: Message = { role: "assistant", content: [{ type: "text", text: "local v2 ok" }] };
          return {
            agentResult: { reason: "completed", message: assistant, usage: { inputTokens: 2, outputTokens: 2 } },
            runRecord: { timestamp: new Date().toISOString(), messages: [user, assistant], usage: { inputTokens: 2, outputTokens: 2 } },
            newMessages: [assistant],
            durationMs: 1,
          };
        },
        abort: () => false,
        async dispose() {},
      };
    },
  };
}

describe("v2 input source pre-dispatch gate", { timeout: 60_000 }, () => {
  it("blocks channel and program turns on pure-Anchor with only legacy remote executors before issuing any envelope", async () => {
    const home = await createTempDir("v2-gate-anchor");
    const remote = await makeLegacyRemoteCandidate("executor:legacy-remote");
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
      enableLocalExecutor: false,
      trustedIdentities: [remote.remoteIdentity],
    });
    CLEANUPS.push(async () => {
      await authority.startupCleanup.run();
      await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    });
    await authority.synchronizeExecutorBaseline!(remote.target);

    const owner = anchorConversationOwnerRuntime(authority);
    const boundary = createConversationExecutorHostBoundary({
      authority: owner,
      directory: remote.directory,
      clock: () => new Date().toISOString(),
    });
    const anchorExecutions: string[] = [];
    const statuses: Array<{ ref: { runId: string }; state: string }> = [];
    let manager!: ConversationManager;
    const protocol = createProtocol({
      owner,
      manager: () => manager,
      interactions: { withBinding: (_b, op) => op(), drainAssignment: async () => {}, releaseAssignment: () => {} } as never,
      executorDispatch: boundary.application,
      onStatus: (notice) => {
        statuses.push(notice);
      },
    });
    manager = new ConversationManager(
      makeLocalRuntimeFactory(anchorExecutions),
      undefined,
      {
        appendCommittedRun: async (_convId, record) => ({ runIndex: record.runIndex, shardId: "durable", appended: true }),
        durableTurnExecutor: protocol,
        onTurnCommitted: () => {},
      },
    );
    const managed = await getOrCreateActiveConversation(authority, manager, "conv-pure-anchor");

    for (const [idx, spec] of ([
      {
        turnId: "turn-ch-1",
        source: "channel" as const,
        turnContext: {
          turnId: "turn-ch-1",
          emissionTarget: { channelId: "feishu", to: "u1" },
          turnOrigin: {
            channel: "feishu",
            target: { channelId: "feishu", to: "u1" },
            messageIdentity: { id: "msg-ch-1", source: { kind: "channel" as const, channelId: "feishu" } },
          },
        },
      },
      {
        turnId: "turn-pg-1",
        source: "interactive" as const,
        turnContext: {
          turnId: "turn-pg-1",
          turnOrigin: {
            channel: "program",
            messageIdentity: { id: "msg-pg-1", source: { kind: "program" as const } },
          },
        },
      },
    ]).entries()) {
      const outcome = await projectSessionTurn({
        manager,
        managed,
        text: `v2 source turn ${idx}`,
        turnId: spec.turnId,
        runOptions: {
          source: spec.source,
          turnContext: spec.turnContext,
        },
        notify: () => {},
      });
      expect(outcome.kind).toBe("error");
      if (outcome.kind === "error") {
        expect(outcome.error).toBeInstanceOf(AggregateError);
        expect((outcome.error as AggregateError).errors.some((e) => /does not support v2 message input sources/i.test(String(e)))).toBe(true);
      }
      expect(anchorExecutions).toHaveLength(0);
      expect(remote.dispatchCalls).toHaveLength(0);
    }

    const journal = new ConversationRunJournal({
      conversationId: managed.conversationId,
      ownerEpoch: authority.anchorEpoch,
      log: authority.authorityLog,
      artifacts: authority.artifacts,
      signer: authority.signer,
      verifier: authority.verifier,
      clock: () => new Date().toISOString(),
      currentAuthority: { deviceId: authority.deviceId, executorId: authority.executorId },
      submission: { authenticate() {}, authorize() {} },
      authority: { decideAtPrefix: () => ({ committed: false, error: { code: "capability-gap", message: "none", retryable: false } }) },
      projection: { async project() {} },
    });
    const observedRunIds = [...new Set(statuses.map((s) => s.ref.runId))];
    expect(observedRunIds).toHaveLength(2);
    expect(statuses.filter((s) => s.state === "failed")).toHaveLength(2);
    for (const runId of observedRunIds) {
      expect(await journal.runState(runId)).toBe("failed");
    }
    expect(remote.dispatchCalls).toHaveLength(0);
  });

  it("routes channel/program turns to local v2 executor instead of legacy remote candidate on hybrid host", async () => {
    const home = await createTempDir("v2-gate-hybrid");
    const remote = await makeLegacyRemoteCandidate("executor:legacy-remote");
    const authority = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: new MemorySecretStore(),
      enableLocalExecutor: true,
      trustedIdentities: [remote.remoteIdentity],
    });
    CLEANUPS.push(async () => {
      await authority.startupCleanup.run();
      await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    });
    await authority.synchronizeExecutorBaseline!(remote.target);

    const executions: string[] = [];
    const owner = anchorConversationOwnerRuntime(authority);
    const boundary = createConversationExecutorHostBoundary({
      authority: owner,
      directory: remote.directory,
      clock: () => new Date().toISOString(),
      local: {
        ConversationAssignmentLedger,
        InProcessAssignmentSubmission,
        runtimeFactory: makeLocalRuntimeFactory(executions),
      },
    });
    let manager!: ConversationManager;
    const protocol = createProtocol({
      owner,
      manager: () => manager,
      interactions: { withBinding: (_b, op) => op(), drainAssignment: async () => {}, releaseAssignment: () => {} } as never,
      executorDispatch: boundary.application,
      ...(boundary.staging ? { assignmentStaging: boundary.staging } : {}),
    });
    manager = new ConversationManager(
      makeLocalRuntimeFactory(executions),
      undefined,
      {
        appendCommittedRun: async (_convId, record) => ({ runIndex: record.runIndex, shardId: "local", appended: true }),
        durableTurnExecutor: protocol,
        onTurnCommitted: () => {},
      },
    );
    const managed = await getOrCreateActiveConversation(authority, manager, "conv-hybrid");

    const outcome = await projectSessionTurn({
      manager,
      managed,
      text: "channel message on hybrid host",
      turnId: "turn-hyb-ch-1",
      runOptions: {
        source: "channel",
        turnContext: {
          turnId: "turn-hyb-ch-1",
          emissionTarget: { channelId: "feishu", to: "u1" },
          turnOrigin: {
            channel: "feishu",
            target: { channelId: "feishu", to: "u1" },
            messageIdentity: { id: "msg-hyb-ch-1", source: { kind: "channel", channelId: "feishu" } },
          },
        },
      },
      notify: () => {},
    });
    expect(outcome.kind).toBe("settled");
    expect(executions).toEqual(["conv-hybrid"]);
    expect(remote.dispatchCalls).toHaveLength(0);
  });
});
