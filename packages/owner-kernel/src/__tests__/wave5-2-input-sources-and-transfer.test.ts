import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { FileArtifactStore, FileAuthorityCommitLog } from "@zhixing-ai/core/authority";
import type { IngressContext, TransferRecord } from "@zhixing-ai/core/contracts";
import { createConversationSealedBundle } from "@zhixing-ai/core/protocol";
import { createTempDir } from "@zhixing-ai/test-utils";
import {
  ConversationReadIndex,
  deriveDurableAdmittedInputIdentity,
} from "../conversation-read-index.js";
import {
  ConversationAdoptionCoordinator,
  ConversationTransferIncompatibleTargetError,
  ConversationTransferSource,
  conversationHasV2OnlyInputSources,
  readConversationTransferState,
} from "../conversation-transfer.js";
import { channelSurfacePrincipal } from "../control-admission.js";
import { decideInputControl } from "../conversation-journal/operations/admission-input.js";
import { trackAuthorityLog, DURABLE_IO_TEST_TIMEOUT_MS } from "./durable-io-test-support.js";
import {
  BASE_CONVERSATION,
  BASE_NOW,
  BASE_TRANSFER,
  baseSigner,
  baseVerifier,
  createConversationBaseHarness,
} from "./conversation-base-harness.js";

async function newLogFixture(label: string) {
  const root = await createTempDir(label);
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = trackAuthorityLog(
    new FileAuthorityCommitLog(path.join(root, "log"), artifacts, { clock: () => BASE_NOW }),
  );
  onTestFinished(() => log.stopStorageMaintenance());
  return { root, artifacts, log };
}

describe("Wave 5.2 input source durability & transfer compatibility", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
  it("deriveDurableAdmittedInputIdentity preserves or derives exact source variants without forging user", () => {
    expect(deriveDurableAdmittedInputIdentity(undefined)).toBeUndefined();
    expect(
      deriveDurableAdmittedInputIdentity({
        kind: "first-party",
        surfacePrincipal: "rpc:local",
        deviceId: "dev-1",
        ingressId: "",
        receivedAt: BASE_NOW,
      }),
    ).toBeUndefined();

    const explicit: IngressContext = {
      kind: "first-party",
      surfacePrincipal: "rpc:local",
      deviceId: "dev-1",
      ingressId: "ing-explicit",
      receivedAt: BASE_NOW,
      turnOrigin: {
        channel: "rpc",
        messageIdentity: {
          id: "custom-msg-id",
          source: { kind: "conversation", conversationId: "parent-conv" },
        },
      },
    };
    const cloned = deriveDurableAdmittedInputIdentity(explicit);
    expect(cloned).toEqual({
      id: "custom-msg-id",
      source: { kind: "conversation", conversationId: "parent-conv" },
    });
    expect(cloned).not.toBe(explicit.turnOrigin?.messageIdentity);

    expect(
      deriveDurableAdmittedInputIdentity({
        kind: "first-party",
        surfacePrincipal: "workscene:local",
        deviceId: "dev-1",
        ingressId: "ing-ws",
        receivedAt: BASE_NOW,
        turnOrigin: {
          worksceneContinuation: {
            source: "subtask",
            worksceneId: "ws-1",
            sourceConversationId: "src-1",
          },
        },
      } as unknown as IngressContext),
    ).toEqual({
      id: "ing-ws",
      source: { kind: "system", subsystem: "workscene-continuation" },
    });

    expect(
      deriveDurableAdmittedInputIdentity({
        kind: "first-party",
        surfacePrincipal: "ext:local",
        deviceId: "dev-1",
        ingressId: "ing-ext",
        receivedAt: BASE_NOW,
        turnOrigin: { channel: "extension" },
      }),
    ).toEqual({
      id: "ing-ext",
      source: { kind: "system", subsystem: "extension-continuation" },
    });

    expect(
      deriveDurableAdmittedInputIdentity({
        kind: "first-party",
        surfacePrincipal: "adv:local",
        deviceId: "dev-1",
        ingressId: "ing-adv",
        receivedAt: BASE_NOW,
        turnOrigin: { channel: "advancement" },
      }),
    ).toEqual({
      id: "ing-adv",
      source: { kind: "system", subsystem: "advancement-proxy" },
    });

    expect(
      deriveDurableAdmittedInputIdentity({
        kind: "first-party",
        surfacePrincipal: "sched:local",
        deviceId: "dev-1",
        ingressId: "ing-sched",
        receivedAt: BASE_NOW,
        turnOrigin: { channel: "scheduler" },
      }),
    ).toEqual({
      id: "ing-sched",
      source: { kind: "system", subsystem: "scheduled-job" },
    });

    expect(
      deriveDurableAdmittedInputIdentity({
        kind: "first-party",
        surfacePrincipal: "program:local",
        deviceId: "dev-1",
        ingressId: "ing-prog",
        receivedAt: BASE_NOW,
        turnOrigin: { channel: "program" },
      }),
    ).toEqual({
      id: "ing-prog",
      source: { kind: "program" },
    });

    expect(
      deriveDurableAdmittedInputIdentity({
        kind: "channel",
        channelId: "feishu",
        channelMessageId: "cm-1",
        ingressId: "ing-ch",
        receivedAt: BASE_NOW,
        responder: { channelId: "feishu", targetId: "chat-1", sessionKey: "sk-1" } as never,
      }),
    ).toEqual({
      id: "ing-ch",
      source: { kind: "channel", channelId: "feishu" },
    });

    expect(
      deriveDurableAdmittedInputIdentity({
        kind: "first-party",
        surfacePrincipal: "cli:local",
        deviceId: "dev-1",
        ingressId: "ing-user-legacy",
        receivedAt: BASE_NOW,
      }),
    ).toBeUndefined();

    expect(
      deriveDurableAdmittedInputIdentity({
        kind: "first-party",
        surfacePrincipal: "cli:local",
        deviceId: "dev-1",
        ingressId: "ing-user",
        receivedAt: BASE_NOW,
        turnOrigin: {
          channel: "rpc",
          messageIdentity: { id: "ing-user", source: { kind: "user" } },
        },
      }),
    ).toEqual({
      id: "ing-user",
      source: { kind: "user" },
    });
  });

  it("ConversationReadIndex projects channel/workscene/program identities cleanly", async () => {
    const { artifacts, log } = await newLogFixture("read-index-v2-sources");
    const index = new ConversationReadIndex(log, artifacts, baseVerifier);
    const convId = "conv-v2-dir";

    await log.append([
      {
        stream: `run:${convId}`,
        body: {
          t: "admitted",
          runId: "run-ch",
          ingressKey: "k-ch",
          queuedPosition: 1,
          invocation: { kind: "agent", source: "interactive" },
          ingress: {
            kind: "channel",
            surfacePrincipal: channelSurfacePrincipal({ channelId: "feishu", platformSubject: "user-1" }),
            responder: { channelId: "feishu", platformSubject: "user-1" },
            replyTarget: { channelId: "feishu", to: "chat-1" },
            deviceId: "dev-1",
            ingressId: "msg-ch",
            receivedAt: BASE_NOW,
          },
          input: { parts: [{ type: "text", text: "from feishu" }] },
        },
      },
      {
        stream: `run:${convId}`,
        body: {
          t: "state",
          runId: "run-ch",
          state: "queued",
          statusRevision: 1,
        },
      },
      {
        stream: `run:${convId}`,
        body: {
          t: "admitted",
          runId: "run-prog",
          ingressKey: "k-prog",
          queuedPosition: 2,
          invocation: { kind: "agent", source: "interactive" },
          ingress: {
            kind: "first-party",
            surfacePrincipal: "program:local",
            deviceId: "dev-1",
            ingressId: "msg-prog",
            receivedAt: BASE_NOW,
            turnOrigin: { channel: "program" },
          },
          input: { parts: [{ type: "text", text: "from program" }] },
        },
      },
      {
        stream: `run:${convId}`,
        body: {
          t: "state",
          runId: "run-prog",
          state: "queued",
          statusRevision: 1,
        },
      },
      {
        stream: `run:${convId}`,
        body: {
          t: "admitted",
          runId: "run-legacy-no-origin",
          ingressKey: "k-legacy",
          queuedPosition: 3,
          invocation: { kind: "agent", source: "interactive" },
          ingress: {
            kind: "first-party",
            surfacePrincipal: "cli:local",
            deviceId: "dev-1",
            ingressId: "msg-legacy",
            receivedAt: BASE_NOW,
          },
          input: { parts: [{ type: "text", text: "legacy first-party" }] },
        },
      },
      {
        stream: `run:${convId}`,
        body: {
          t: "state",
          runId: "run-legacy-no-origin",
          state: "queued",
          statusRevision: 1,
        },
      },
    ]);

    const chMeta = await index.messageMetadata(convId, "msg-ch");
    expect(chMeta.value?.pointer.identity).toEqual({
      id: "msg-ch",
      source: { kind: "channel", channelId: "feishu" },
    });
    const progMeta = await index.messageMetadata(convId, "msg-prog");
    expect(progMeta.value?.pointer.identity).toEqual({
      id: "msg-prog",
      source: { kind: "program" },
    });
    const legacyMeta = await index.messageMetadata(convId, "msg-legacy");
    expect(legacyMeta.value?.pointer.identity).toEqual({
      id: "msg-legacy",
      source: { kind: "user" },
    });
    const legacyAt = await index.inputsAt(convId, [
      {
        runId: "run-legacy-no-origin",
        inputKey: "k-legacy",
        position: 3,
        identity: { id: "msg-legacy", source: { kind: "user" } },
        initial: true,
        item: 4,
        lsn: (await log.checkpoint()).lsn,
        checkpoint: await log.checkpoint(),
      },
    ]);
    expect(legacyAt[0]?.identity).toBeUndefined();
  });

  it("busy run-input-appended only accepts source.kind === conversation and queues all other sources separately", () => {
    const facts = {
      session: {
        deleted: false,
        pendingLifecycleProjectionSize: 0,
        hasOpenAdvancementSession: () => false,
        findActiveAdvancementSessionId: () => undefined,
      },
      queueInput: {
        getRunIdByIngress: () => undefined,
        getAdmitted: () => ({
          record: {
            t: "admitted" as const,
            runId: "active-run",
            ingressKey: "cli/active",
            queuedPosition: 1,
            ingress: {
              kind: "first-party" as const,
              surfacePrincipal: "cli:local",
              deviceId: "dev-1",
              ingressId: "active",
              receivedAt: BASE_NOW,
            },
            input: { stored: { inline: { parts: [{ type: "text" as const, text: "hi" }] } } },
            invocation: { kind: "agent" as const, source: "interactive" as const },
          },
        }),
        getOpenInputAssignment: (runId: string) =>
          runId === "active-run" ? "assign-1" : undefined,
        hasAdmitted: () => false,
      },
      assignment: {
        activeRunId: "active-run",
        getRunState: (runId: string) =>
          runId === "active-run" ? { state: "running" } : undefined,
      },
    };

    const runCase = (ingress: IngressContext, runId: string) =>
      decideInputControl({
        conversationId: "conv-busy",
        ownerEpoch: 1,
        runId,
        userInput: { parts: [{ type: "text", text: "msg" }] },
        invocation: { kind: "agent", source: "interactive" },
        environment: undefined,
        attachments: [],
        storedInput: { storage: "inline", value: { parts: [{ type: "text", text: "msg" }] } },
        request: {
          t: "input",
          conversationId: "conv-busy",
          ownerEpoch: 1,
          ingress: { ingressId: ingress.ingressId, source: ingress.kind },
          input: { parts: [{ type: "text", text: "msg" }] },
          invocation: { kind: "agent", source: "interactive" },
        },
        ingress,
        nextLsn: 10,
        worksceneDeleted: false,
        facts: facts as never,
      });

    const convRes = runCase(
      {
        kind: "first-party",
        surfacePrincipal: "rpc:local",
        deviceId: "dev-1",
        ingressId: "ing-conv",
        receivedAt: BASE_NOW,
        turnOrigin: {
          channel: "rpc",
          messageIdentity: {
            id: "msg-conv",
            source: { kind: "conversation", conversationId: "sender-conv" },
          },
        },
      },
      "new-run-conv",
    );
    expect(convRes.authorityEntries?.[0]?.body).toMatchObject({
      t: "run-input-appended",
      runId: "active-run",
    });

    const nonConvIngresses: IngressContext[] = [
      {
        kind: "first-party",
        surfacePrincipal: "rpc:local",
        deviceId: "dev-1",
        ingressId: "ing-user",
        receivedAt: BASE_NOW,
      },
      {
        kind: "first-party",
        surfacePrincipal: "program:local",
        deviceId: "dev-1",
        ingressId: "ing-prog",
        receivedAt: BASE_NOW,
        turnOrigin: { channel: "program" },
      },
      {
        kind: "channel",
        channelId: "feishu",
        channelMessageId: "cm-2",
        ingressId: "ing-ch",
        receivedAt: BASE_NOW,
        responder: { channelId: "feishu", targetId: "t2", sessionKey: "s2" } as never,
      },
      {
        kind: "first-party",
        surfacePrincipal: "ext:local",
        deviceId: "dev-1",
        ingressId: "ing-ext",
        receivedAt: BASE_NOW,
        turnOrigin: {
          channel: "extension",
          messageIdentity: {
            id: "msg-ext",
            source: { kind: "system", subsystem: "extension-continuation" },
          },
        },
      },
      {
        kind: "first-party",
        surfacePrincipal: "adv:local",
        deviceId: "dev-1",
        ingressId: "ing-adv",
        receivedAt: BASE_NOW,
        turnOrigin: {
          channel: "advancement",
          messageIdentity: {
            id: "msg-adv",
            source: { kind: "system", subsystem: "advancement-proxy" },
          },
        },
      },
      {
        kind: "first-party",
        surfacePrincipal: "sched:local",
        deviceId: "dev-1",
        ingressId: "ing-sched",
        receivedAt: BASE_NOW,
        turnOrigin: {
          channel: "scheduler",
          messageIdentity: {
            id: "msg-sched",
            source: { kind: "system", subsystem: "scheduled-job" },
          },
        },
      },
      {
        kind: "first-party",
        surfacePrincipal: "ws:local",
        deviceId: "dev-1",
        ingressId: "ing-ws",
        receivedAt: BASE_NOW,
        turnOrigin: {
          messageIdentity: {
            id: "msg-ws",
            source: { kind: "system", subsystem: "workscene-continuation" },
          },
        },
      },
    ];

    for (const [idx, ingress] of nonConvIngresses.entries()) {
      const res = runCase(ingress, `queued-${idx}`);
      expect(res.authorityEntries?.[0]?.body).toMatchObject({
        t: "admitted",
        runId: `queued-${idx}`,
      });
    }
  });

  it("closeQueuedRun persists reason bounded to <= 512 UTF-8 bytes", async () => {
    const harness = await createConversationBaseHarness();
    await harness.admit(harness.sourceJournal, "run-close-1", 1);
    const longReason = "错".repeat(300); // 900 UTF-8 bytes
    await harness.sourceJournal.closeQueuedRun("run-close-1", "failed", longReason);

    const envelopes = await harness.source.log.readAll();
    const entries = envelopes.flatMap((env) => env.entries);
    const closedState = entries
      .map((entry) => entry.body as Record<string, unknown>)
      .find((body) => body.t === "state" && body.runId === "run-close-1" && body.state === "failed");

    expect(closedState).toBeDefined();
    expect(typeof closedState?.reason).toBe("string");
    expect(Buffer.byteLength(closedState?.reason as string, "utf8")).toBeLessThanOrEqual(512);
    expect((closedState?.reason as string).length).toBeGreaterThan(0);
  });

  it("conversationHasV2OnlyInputSources and ConversationAdoptionCoordinator block incompatible targets before prepare", async () => {
    const harness = await createConversationBaseHarness();
    await harness.source.log.append([
      {
        stream: `run:${BASE_CONVERSATION}`,
        body: {
          t: "admitted",
          runId: "run-v2-ch",
          ingressKey: "k-v2-ch",
          queuedPosition: 1,
          invocation: { kind: "agent", source: "interactive" },
          ingress: {
            kind: "channel",
            surfacePrincipal: channelSurfacePrincipal({ channelId: "feishu", platformSubject: "user-1" }),
            responder: { channelId: "feishu", platformSubject: "user-1" },
            replyTarget: { channelId: "feishu", to: "chat-1" },
            deviceId: "dev-1",
            ingressId: "ing-v2-ch",
            receivedAt: BASE_NOW,
          },
          input: { parts: [{ type: "text", text: "hi" }] },
        },
      },
      {
        stream: `run:${BASE_CONVERSATION}`,
        body: {
          t: "state",
          runId: "run-v2-ch",
          state: "queued",
          statusRevision: 1,
        },
      },
    ]);

    await expect(
      conversationHasV2OnlyInputSources(harness.source.log, harness.source.artifacts, BASE_CONVERSATION),
    ).resolves.toBe(true);

    const targetPrepare = vi.fn(async () => undefined);
    const sourcePrepareSpy = vi.spyOn(harness.exporter, "prepare");
    const incompatibleCoordinator = new ConversationAdoptionCoordinator({
      source: harness.exporter,
      target: {
        prepare: targetPrepare as never,
        import: vi.fn() as never,
        commit: vi.fn() as never,
      } as never,
      targetSupportsV2InputSources: () => false,
    });

    await expect(
      incompatibleCoordinator.adopt({
        requestId: "req-incompat",
        transferId: BASE_TRANSFER,
        sourceDeviceId: "dev-source",
        targetDeviceId: "dev-target",
        conversationId: BASE_CONVERSATION,
        sourceOwnerEpoch: 1,
      }),
    ).rejects.toThrow(ConversationTransferIncompatibleTargetError);
    expect(targetPrepare).not.toHaveBeenCalled();
    expect(sourcePrepareSpy).not.toHaveBeenCalled();

    // Sealed bundle containing program inputIdentity also triggers detection
    const { artifacts: bArtifacts, log: bLog } = await newLogFixture("bundle-v2-check");
    const sealed = createConversationSealedBundle({
      assignmentId: "a-b1",
      executorId: "executor-test",
      dependencyArtifacts: [],
      streamFinal: { finalSeq: 1, streamDigest: "sha256:" + "0".repeat(64) },
      usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
      usageFinal: { reportDigest: "sha256:" + "0".repeat(64), upToUsageSeq: 0 },
      body: {
        t: "conversation",
        conversationId: "conv-bundle-v2",
        runId: "run-b1",
        ownerEpoch: 1,
        baseRevision: 0,
        contentAssets: [],
        runRecord: {
          type: "run",
          timestamp: BASE_NOW,
          runId: "run-b1",
          runIndex: 1,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "from program" }],
              inputIdentity: { id: "m-prog", source: { kind: "program" } },
            },
          ],
        },
      },
    });
    const bundleRef = await bArtifacts.put(Buffer.from(JSON.stringify(sealed), "utf8"));
    await bLog.append([
      {
        stream: "run:conv-bundle-v2",
        body: { t: "committed", runId: "run-b1", assignmentId: "a-b1", bundle: { ref: bundleRef } },
      },
    ]);
    await expect(
      conversationHasV2OnlyInputSources(bLog, bArtifacts, "conv-bundle-v2"),
    ).resolves.toBe(true);

    // Legacy conversation with only user + conversation sources succeeds even when targetSupportsV2InputSources is false
    const legacyHarness = await createConversationBaseHarness();
    await legacyHarness.admit(legacyHarness.sourceJournal, "run-legacy-1", 1);
    await expect(
      conversationHasV2OnlyInputSources(
        legacyHarness.source.log,
        legacyHarness.source.artifacts,
        BASE_CONVERSATION,
      ),
    ).resolves.toBe(false);

    const compatSource = new ConversationTransferSource({
      deviceId: "source-dev",
      log: legacyHarness.source.log,
      artifacts: legacyHarness.source.artifacts,
      signer: baseSigner("source"),
      verifier: baseVerifier,
      acceptsConversationId: (id) => id === BASE_CONVERSATION,
      isCurrentAnchor: () => true,
      conversationState: async () => ({ exists: true, deleted: false, ownerEpoch: 1 }),
      settleConversation: async () => undefined,
      snapshotSessionState: async () => ({ reducerVersion: "v1", value: {} }),
      targetSupportsV2InputSources: () => false,
    });
    await expect(
      compatSource.assertCompatibleWithTarget({
        targetDeviceId: "old-device",
        conversationId: BASE_CONVERSATION,
      }),
    ).resolves.toBeUndefined();

    // Pre-prepare check passed on pure-v1; simulate a v2 channel input arriving before freeze().
    await compatSource.prepare({
      requestId: "req-race-1",
      transferId: BASE_TRANSFER,
      targetDeviceId: "old-device",
      conversationId: BASE_CONVERSATION,
      sourceOwnerEpoch: 1,
    });
    await legacyHarness.source.log.append([
      {
        stream: `run:${BASE_CONVERSATION}`,
        body: {
          t: "admitted",
          runId: "run-v2-race",
          ingressKey: "k-v2-race",
          queuedPosition: 2,
          invocation: { kind: "agent", source: "interactive" },
          ingress: {
            kind: "channel",
            surfacePrincipal: channelSurfacePrincipal({ channelId: "feishu", platformSubject: "user-race" }),
            responder: { channelId: "feishu", platformSubject: "user-race" },
            replyTarget: { channelId: "feishu", to: "chat-race" },
            deviceId: "dev-1",
            ingressId: "ing-v2-race",
            receivedAt: BASE_NOW,
          },
          input: { parts: [{ type: "text", text: "race input" }] },
        },
      },
      {
        stream: `run:${BASE_CONVERSATION}`,
        body: {
          t: "state",
          runId: "run-v2-race",
          state: "queued",
          statusRevision: 1,
        },
      },
    ]);
    await expect(compatSource.freeze(BASE_TRANSFER)).rejects.toThrow(
      ConversationTransferIncompatibleTargetError,
    );
    const preparedAbort = await compatSource.prepareAbort(BASE_TRANSFER, "target-rejected");
    await compatSource.acceptAbort(preparedAbort);
    const afterAbort = await readConversationTransferState(
      legacyHarness.source.log,
      BASE_TRANSFER,
      baseVerifier,
    );
    expect(afterAbort?.phase).toBe("aborted");
  });
});
