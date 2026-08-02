import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ChannelRegistry, deliveryRecord } from "@zhixing/core";
import type {
  SecretRef,
  SecretStorePort,
  TranscriptRunRecord,
} from "@zhixing/core/contracts";
import {
  byteDigest,
  canonicalize,
  createConversationSealedBundle,
  sealedBundleArtifact,
} from "@zhixing/core/protocol";
import { createTempDir } from "@zhixing/test-utils";
import {
  setupAuthorityRuntime,
  setupDelivery,
  type AuthorityRuntimeStack,
  type DeliveryStack,
} from "../setup-delivery.js";

const quietLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const TEST_EXECUTOR_READINESS = {
  tools: [] as string[],
  mcpServers: [] as string[],
  credentialBindings: [],
  deviceScopedCredentialBindingIds: [] as string[],
  credentialGeneration: null,
};

async function putConversationBundle(
  artifacts: DeliveryStack["artifacts"],
  input: {
    assignmentId: string;
    runId: string;
    conversationId: string;
  },
) {
  const runRecord: TranscriptRunRecord = {
    type: "run",
    runId: input.runId,
    runIndex: 1,
    timestamp: "2026-07-25T00:00:00.000Z",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "prepare delivery" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "delivery ready" }],
      },
    ],
  };
  const runRecordRef = await artifacts.put(
    Buffer.from(canonicalize(runRecord), "utf8"),
  );
  const emptyDigest = byteDigest(Buffer.alloc(0));
  const bundle = createConversationSealedBundle({
    assignmentId: input.assignmentId,
    executorId: "executor-test",
    streamFinal: { finalSeq: 1, streamDigest: emptyDigest },
    usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
    usageFinal: { reportDigest: emptyDigest, upToUsageSeq: 0 },
    dependencyArtifacts: [],
    body: {
      t: "conversation",
      runId: input.runId,
      conversationId: input.conversationId,
      ownerEpoch: 1,
      baseRevision: 0,
      runRecord: { ref: runRecordRef },
      contentAssets: [],
    },
  });
  const artifact = sealedBundleArtifact(bundle);
  return artifacts.put(artifact.bytes);
}

describe("setupDelivery authority production path", () => {
  let home: string;
  let stack: DeliveryStack | null = null;
  let secrets: MemorySecretStore;
  let authorityRuntime: AuthorityRuntimeStack;

  beforeEach(async () => {
    home = await createTempDir("delivery");
    secrets = new MemorySecretStore();
    authorityRuntime = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: secrets,
      executorReadiness: TEST_EXECUTOR_READINESS,
    });
  });

  afterEach(async () => {
    if (stack) {
      await stack.stop().catch(() => {});
      stack = null;
    }
  });

  it("assembles a valid DeliveryStack with an empty channel registry", async () => {
    const channels = new ChannelRegistry();
    stack = await setupDelivery({
      channels,
      zhixingHome: home,
      authorityRuntime,
      logger: quietLogger,
    });
    expect(stack).toBeDefined();
    expect(stack.authorityDelivery).toBeDefined();
    expect(stack.authority).toBeDefined();
    expect(stack.authorityLog).toBeDefined();
    expect(stack.artifacts).toBeDefined();
    expect(stack.participant).toBeDefined();
    expect(stack.controlAdmission).toBeDefined();
    expect(stack.outboxRegistry).toBeDefined();
    expect(typeof stack.statusHistory).toBe("function");
    expect(typeof stack.resolve).toBe("function");
    expect(typeof stack.stop).toBe("function");
  });

  it("publishes a revisioned resolved notice through the production control path", async () => {
    const channels = new ChannelRegistry();
    stack = await setupDelivery({
      channels,
      zhixingHome: home,
      authorityRuntime,
      logger: quietLogger,
    });
    const sourceRef = await putConversationBundle(stack.artifacts, {
      assignmentId: "assignment-resolution",
      runId: "run-resolution",
      conversationId: "conversation-resolution",
    });
    const prepared = await stack.authority.coordinate(() =>
      stack!.authorityLog.transactProjection(
        {},
        (state) => state,
        (_state, context) => {
          const enqueues = stack!.authority.prepareEnqueues([
            {
              keyBody: {
                kind: "conversation-final-delivery",
                conversationId: "conversation-resolution",
                runId: "run-resolution",
                commitRevision: 1,
              },
              intent: {
                endpoint: {
                  kind: "channel",
                  target: { channelId: "feishu", to: "chat-1" },
                },
                content: { text: "resolve me" },
                priority: "normal",
                createdAt: context.at,
                maxAttempts: 3,
              },
            },
          ], context.at);
          if (!enqueues.accepted) throw new Error(enqueues.error.message);
          return {
            kind: "append" as const,
            entries: [
              {
                stream: "run:conversation-resolution",
                body: {
                  t: "committed",
                  runId: "run-resolution",
                  assignmentId: "assignment-resolution",
                  bundle: { ref: sourceRef },
                  commitRevision: 1,
                },
              },
              ...enqueues.records.map(deliveryRecord),
            ],
            value: enqueues.items[0]!.itemId,
          };
        },
        { candidateReferences: [sourceRef] },
      ),
    );
    const claim = await stack.authority.claim({
      itemId: prepared.value,
      outcomePolicy: { kind: "manual-resolution" },
    });
    expect(claim.kind).toBe("send");
    await stack.authority.claim({ itemId: prepared.value });
    const uncertain = await stack.authority.get(prepared.value);
    expect(uncertain?.state).toBe("uncertain");
    const listener = vi.fn();
    stack.onStatus(() => {
      throw new Error("simulated status consumer failure");
    });
    stack.onStatus(listener);

    await stack.resolve({
      requestId: "request:delivery-resolution",
      source: {
        principal: {
          surfacePrincipal: "surface:user-1",
          deviceId: "device-1",
          connectionId: "connection-1",
        },
      },
      body: {
        t: "delivery-resolve",
        itemId: prepared.value,
        attempt: uncertain!.currentAttempt,
        anchorEpoch: 1,
        openFactDigest: uncertain!.openFact!.openFactDigest,
        decision: "abandon",
      },
    });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: { execution: "delivery", itemId: prepared.value },
        state: "delivery-resolved",
        decision: "abandon",
      }),
    );
    await expect(stack.statusHistory({ [prepared.value]: 0 })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "delivery-resolved" }),
      ]),
    );
  }, 15_000);

  it("rebuilds queued delivery authority from the shared durable log", async () => {
    const channels = new ChannelRegistry();
    stack = await setupDelivery({
      channels,
      zhixingHome: home,
      authorityRuntime,
      logger: quietLogger,
    });
    const authority = stack.authority;
    const sourceRef = await putConversationBundle(stack.artifacts, {
      assignmentId: "assignment-1",
      runId: "run-1",
      conversationId: "conversation-1",
    });
    const transaction = await authority.coordinate(() => stack!.authorityLog.transactProjection(
      {},
      (state) => state,
      (_state, context) => {
        const prepared = authority.prepareEnqueues([
          {
            keyBody: {
              kind: "conversation-final-delivery",
              conversationId: "conversation-1",
              runId: "run-1",
              commitRevision: 1,
            },
            intent: {
              endpoint: {
                kind: "channel",
                target: { channelId: "feishu", to: "chat-1" },
              },
              content: { text: "done" },
              priority: "normal",
              source: { kind: "agent", conversationId: "conversation-1" },
              createdAt: context.at,
              maxAttempts: 3,
            },
          },
        ], context.at);
        if (!prepared.accepted) throw new Error(prepared.error.message);
        return {
          kind: "append" as const,
          entries: [
            {
              stream: "run:conversation-1",
              body: {
                t: "committed",
                runId: "run-1",
                assignmentId: "assignment-1",
                bundle: { ref: sourceRef },
                commitRevision: 1,
              },
            },
            ...prepared.records.map(deliveryRecord),
          ],
          value: prepared.items[0]!.itemId,
        };
      },
      { candidateReferences: [sourceRef] },
    ));
    expect((await authority.get(transaction.value))?.state).toBe("queued");

    await stack.stop();
    authorityRuntime = await setupAuthorityRuntime({
      zhixingHome: home,
      secretStore: secrets,
      executorReadiness: TEST_EXECUTOR_READINESS,
    });
    stack = await setupDelivery({
      channels,
      zhixingHome: home,
      authorityRuntime,
      logger: quietLogger,
    });
    expect((await stack.authority.get(transaction.value))?.state).toBe("queued");
  }, 15_000);
});

class MemorySecretStore implements SecretStorePort {
  readonly values = new Map<string, string>();
  async put(ref: SecretRef, value: string) { this.values.set(secretKey(ref), value); }
  async get(ref: SecretRef) { return this.values.get(secretKey(ref)) ?? null; }
  async delete(ref: SecretRef) { this.values.delete(secretKey(ref)); }
  async list(prefix: string) {
    return [...this.values.keys()]
      .filter((value) => value.startsWith(prefix))
      .map((value) => {
        const separator = value.indexOf("/");
        return {
          kind: value.slice(0, separator) as SecretRef["kind"],
          bindingId: value.slice(separator + 1),
        };
      });
  }
  async unlockState() { return "unlocked" as const; }
}

function secretKey(ref: SecretRef): string {
  return `${ref.kind}/${ref.bindingId}`;
}
