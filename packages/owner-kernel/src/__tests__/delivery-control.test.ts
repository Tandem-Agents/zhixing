import path from "node:path";
import {
  AuthorityStorageError,
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "@zhixing/core/authority";
import {
  DeliveryAuthority,
  decideDeliveryResolution,
  deliveryRecord,
  emptyDeliveryProjection,
  prepareDeliveryEnqueues,
  reduceDeliveryAuthorityRecord,
  type DeliveryEnqueueInput,
} from "@zhixing/core/delivery";
import {
  DeliveryProjectionInvariantError,
  DeliveryUncertainResolutionApplicationService,
  type DeliveryUncertainResolutionCommand,
} from "@zhixing/core/delivery/application";
import {
  createConversationSealedBundle,
  sealedBundleArtifact,
} from "@zhixing/core/protocol";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import {
  ControlAdmissionJournal,
  createDeliveryControlEnvelope,
  type TrustedControlSource,
} from "../control-admission.js";
import { createDeliveryResolutionCorrectnessPort } from "../delivery-control.js";
import { createOwnerDeliveryLifecycleBinding } from "../delivery-obligation-correctness.js";
import {
  DURABLE_IO_TEST_TIMEOUT_MS,
  trackAuthorityLog,
} from "./durable-io-test-support.js";

const NOW = "2026-07-17T02:00:00.000Z";
const FIXTURE_DIGEST = `sha256:${"0".repeat(64)}` as const;

async function createHarness() {
  const root = await createTempDir("delivery-control");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = trackAuthorityLog(new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
    clock: () => NOW,
  }));
  const authority = new DeliveryAuthority({ log, anchorEpoch: 7 });
  const lifecycle = createOwnerDeliveryLifecycleBinding({ authority }).application;
  const admission = new ControlAdmissionJournal(log, artifacts);
  const input: DeliveryEnqueueInput = {
    keyBody: {
      kind: "conversation-final-delivery",
      conversationId: "conversation-1",
      runId: "run-1",
      commitRevision: 1,
    },
    intent: {
      endpoint: {
        kind: "channel",
        target: { channelId: "feishu", to: "user-1" },
      },
      content: { text: "done" },
      priority: "normal",
      createdAt: NOW,
      maxAttempts: 3,
    },
  };
  const source = sealedBundleArtifact(createConversationSealedBundle({
    assignmentId: "assignment-1",
    executorId: "executor-1",
    streamFinal: { finalSeq: 1, streamDigest: FIXTURE_DIGEST },
    usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
    usageFinal: { reportDigest: FIXTURE_DIGEST, upToUsageSeq: 0 },
    dependencyArtifacts: [],
    body: {
      t: "conversation",
      runId: "run-1",
      conversationId: "conversation-1",
      ownerEpoch: 1,
      baseRevision: 0,
      runRecord: {
        type: "run",
        runId: "run-1",
        runIndex: 1,
        timestamp: NOW,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "deliver the completed run" }],
          },
        ],
      },
      contentAssets: [],
    },
  }));
  const sourceRef = await artifacts.put(source.bytes);
  const created = await authority.coordinate(async () => (
    await log.transactProjection<Record<string, never>, unknown, ReturnType<DeliveryAuthority["prepareEnqueues"]>>(
      {},
      (state) => state,
      () => {
        const decision = authority.prepareEnqueues([input], NOW, prepareDeliveryEnqueues);
        if (!decision.accepted) return { kind: "return", value: decision };
        return {
          kind: "append",
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
            ...decision.records.map(deliveryRecord),
          ],
          value: decision,
        };
      },
      { candidateReferences: [sourceRef] },
    )
  ).value);
  if (!created.accepted) throw new Error("fixture delivery was rejected");
  const itemId = created.items[0]!.itemId;
  await lifecycle.claim({ itemId, outcomePolicy: { kind: "manual-resolution" } });
  await lifecycle.claim({ itemId, outcomePolicy: { kind: "manual-resolution" } });
  const item = await authority.get(itemId);
  if (!item?.openFact) throw new Error("fixture delivery did not become uncertain");
  return { artifacts, log, authority, admission, item };
}

function source(): TrustedControlSource {
  return {
    principal: {
      surfacePrincipal: "surface:user-1",
      deviceId: "device-1",
      connectionId: "connection-1",
    },
  };
}

function commandFromEnvelope(
  envelope: ReturnType<typeof createDeliveryControlEnvelope>,
): DeliveryUncertainResolutionCommand {
  return {
    requestId: envelope.requestId,
    itemId: envelope.body.itemId,
    attempt: envelope.body.attempt,
    anchorEpoch: envelope.body.anchorEpoch,
    openFactDigest: envelope.body.openFactDigest,
    decision: envelope.body.decision,
    principal: envelope.principal,
  };
}

function application(input: {
  readonly admission: ControlAdmissionJournal;
  readonly authority: DeliveryAuthority;
  readonly onResolved?: Parameters<typeof createDeliveryResolutionCorrectnessPort>[0]["onResolved"];
}) {
  return new DeliveryUncertainResolutionApplicationService(
    createDeliveryResolutionCorrectnessPort({
      ...input,
      clock: () => NOW,
    }),
  );
}

describe("delivery resolution control", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
  it("maps a Delivery projection invariant to the stable Authority corruption contract", async () => {
    const prepared = prepareDeliveryEnqueues(emptyDeliveryProjection(), [
      {
        keyBody: {
          kind: "conversation-final-delivery",
          conversationId: "conversation-corrupt",
          runId: "run-corrupt",
          commitRevision: 1,
        },
        intent: {
          endpoint: {
            kind: "channel",
            target: { channelId: "feishu", to: "user-1" },
          },
          content: { text: "corrupt" },
          priority: "normal",
          createdAt: NOW,
          maxAttempts: 3,
        },
      },
    ], NOW);
    if (!prepared.accepted) throw new Error("fixture enqueue was rejected");
    const itemId = prepared.items[0]!.itemId;
    const enqueued = prepared.records[0];
    if (enqueued?.t !== "enqueued") throw new Error("expected enqueue fixture record");
    const projection = emptyDeliveryProjection();
    projection.items.set(itemId, {
      id: itemId,
      idempotencyKey: enqueued.idempotencyKey,
      keyBody: enqueued.keyBody,
      intentDigest: enqueued.intentDigest,
      intent: enqueued.intent,
      state: "attempting",
      statusRevision: 2,
      currentAttempt: 1,
      automaticAttemptsUsed: 1,
    });
    const authority = {
      transactDeliveryLifecycle: async <Value>(decide: Parameters<
        DeliveryAuthority["transactDeliveryLifecycle"]
      >[0]) => decide({
        projection,
        transactionAt: NOW,
        currentAnchorEpoch: 7,
      }).value as Value,
      list: async () => [],
      snapshot: () => [],
    } as unknown as DeliveryAuthority;

    const application = createOwnerDeliveryLifecycleBinding({ authority }).application;
    const failure = await application.claim({
      itemId,
      outcomePolicy: { kind: "manual-resolution" },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AuthorityStorageError);
    expect(failure).toMatchObject({
      code: "commit-log-corrupt",
      message: "Open delivery attempt has no start fact",
      cause: expect.any(DeliveryProjectionInvariantError),
    });
  });

  it("atomically appends the user decision and its applied control result", async () => {
    const fixture = await createHarness();
    const trusted = source();
    const envelope = createDeliveryControlEnvelope({
      requestId: "delivery-resolution-1",
      source: trusted,
      at: NOW,
      body: {
        t: "delivery-resolve",
        itemId: fixture.item.id,
        attempt: fixture.item.currentAttempt,
        anchorEpoch: 7,
        openFactDigest: fixture.item.openFact!.openFactDigest,
        decision: "user-verified-sent",
      },
    });

    const app = application({
      admission: fixture.admission,
      authority: fixture.authority,
    });
    const first = await app.execute(commandFromEnvelope(envelope));
    const replay = await app.execute(commandFromEnvelope(envelope));

    expect(first).toMatchObject({
      kind: "applied",
      result: { status: "ok", body: { t: "delivery-resolve", applied: true } },
    });
    expect(replay).toMatchObject({ kind: "replayed", result: first.result });
    expect(await fixture.authority.get(fixture.item.id)).toMatchObject({
      state: "verified-sent",
      resolution: { decision: "user-verified-sent", by: "surface:user-1" },
    });
    const commits = await fixture.log.readAll();
    const resolutionCommit = commits.find((commit) =>
      commit.entries.some(
        (entry) =>
          entry.stream === "delivery" &&
          (entry.body as { readonly t?: string }).t === "delivery-resolved",
      ),
    );
    expect(resolutionCommit?.entries.map((entry) => entry.stream)).toEqual([
      "delivery",
      "control",
    ]);
  });

  it("rejects a resolution fact bound to a different durable control request", async () => {
    const fixture = await createHarness();
    const trusted = source();
    const envelope = createDeliveryControlEnvelope({
      requestId: "delivery-resolution-mismatched",
      source: trusted,
      at: NOW,
      body: {
        t: "delivery-resolve",
        itemId: fixture.item.id,
        attempt: fixture.item.currentAttempt,
        anchorEpoch: 7,
        openFactDigest: fixture.item.openFact!.openFactDigest,
        decision: "abandon",
      },
    });
    await fixture.log.append([
      {
        stream: "control",
        body: {
          t: "received",
          requestId: envelope.requestId,
          envelope,
        },
      },
    ]);
    const projection = await fixture.log.transactProjection(
      emptyDeliveryProjection(),
      reduceDeliveryAuthorityRecord,
      (state, context) => ({ kind: "return" as const, value: { state, context } }),
      { stream: "delivery" },
    );
    const resolution = decideDeliveryResolution(
      projection.value.state,
      {
        itemId: fixture.item.id,
        attempt: fixture.item.currentAttempt,
        anchorEpoch: 7,
        openFactDigest: fixture.item.openFact!.openFactDigest,
        decision: "user-verified-sent",
        by: trusted.principal.surfacePrincipal,
      },
      projection.value.context,
      7,
    );
    if (!resolution.accepted) throw new Error("fixture resolution was rejected");
    await fixture.log.append([
      deliveryRecord(resolution.record),
      {
        stream: "control",
        body: {
          t: "applied",
          requestId: envelope.requestId,
          result: {
            v: 1,
            status: "ok",
            body: { t: "delivery-resolve", applied: true },
          },
          authorityRevision: projection.value.context.nextLsn,
        },
      },
    ]);

    await expect(
      application({
        admission: new ControlAdmissionJournal(fixture.log, fixture.artifacts),
        authority: new DeliveryAuthority({ log: fixture.log, anchorEpoch: 7 }),
      }).execute(commandFromEnvelope(envelope)),
    ).rejects.toThrow("does not bind its durable control request");
  });

  it("rejects a stale epoch without appending a resolution fact", async () => {
    const fixture = await createHarness();
    const trusted = source();
    const envelope = createDeliveryControlEnvelope({
      requestId: "delivery-resolution-stale",
      source: trusted,
      at: NOW,
      body: {
        t: "delivery-resolve",
        itemId: fixture.item.id,
        attempt: fixture.item.currentAttempt,
        anchorEpoch: 6,
        openFactDigest: fixture.item.openFact!.openFactDigest,
        decision: "abandon",
      },
    });

    const result = await application({
      admission: fixture.admission,
      authority: fixture.authority,
    }).execute(commandFromEnvelope(envelope));

    expect(result.result).toMatchObject({
      status: "rejected",
      error: { code: "epoch-stale" },
    });
    expect(await fixture.authority.get(fixture.item.id)).toMatchObject({ state: "uncertain" });
  });

  it("rejects an open-fact mismatch without appending a resolution fact", async () => {
    const fixture = await createHarness();
    const trusted = source();
    const envelope = createDeliveryControlEnvelope({
      requestId: "delivery-resolution-open-fact-mismatch",
      source: trusted,
      at: NOW,
      body: {
        t: "delivery-resolve",
        itemId: fixture.item.id,
        attempt: fixture.item.currentAttempt,
        anchorEpoch: 7,
        openFactDigest: `sha256:${"f".repeat(64)}`,
        decision: "abandon",
      },
    });

    const result = await application({
      admission: fixture.admission,
      authority: fixture.authority,
    }).execute(commandFromEnvelope(envelope));

    expect(result.result).toMatchObject({
      status: "rejected",
      error: { code: "fence-rejected" },
    });
    expect(await fixture.authority.get(fixture.item.id)).toMatchObject({ state: "uncertain" });
  });

  it.each(["sync", "async"] as const)(
    "keeps an applied resolution authoritative when the %s live observer fails",
    async (mode) => {
      const fixture = await createHarness();
      const trusted = source();
      const envelope = createDeliveryControlEnvelope({
        requestId: `delivery-resolution-observer-${mode}`,
        source: trusted,
        at: NOW,
        body: {
          t: "delivery-resolve",
          itemId: fixture.item.id,
          attempt: fixture.item.currentAttempt,
          anchorEpoch: 7,
          openFactDigest: fixture.item.openFact!.openFactDigest,
          decision: "abandon",
        },
      });
      const history = vi
        .spyOn(fixture.authority, "statusHistory")
        .mockRejectedValue(new Error("simulated post-commit read failure"));
      const observer = mode === "sync"
        ? () => {
            throw new Error("simulated sync observer failure");
          }
        : async () => {
            throw new Error("simulated async observer failure");
          };

      await expect(
        application({
          admission: fixture.admission,
          authority: fixture.authority,
          onResolved: observer,
        }).execute(commandFromEnvelope(envelope)),
      ).resolves.toMatchObject({
        kind: "applied",
        result: { status: "ok", body: { applied: true } },
      });
      expect(history).not.toHaveBeenCalled();
      history.mockRestore();
      expect(await fixture.authority.statusHistory(fixture.item.id, 0)).toContainEqual(
        expect.objectContaining({
          state: "delivery-resolved",
          decision: "abandon",
        }),
      );
    },
  );

  it("rejects an orphan delivery source through the control consumer's full reducer", async () => {
    const root = await createTempDir("delivery-control-orphan");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    const log = trackAuthorityLog(new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
      clock: () => NOW,
    }));
    const admission = new ControlAdmissionJournal(log, artifacts);
    const prepared = prepareDeliveryEnqueues(emptyDeliveryProjection(), [
      {
        keyBody: {
          kind: "conversation-final-delivery",
          conversationId: "conversation-orphan",
          runId: "run-orphan",
          commitRevision: 1,
        },
        intent: {
          endpoint: {
            kind: "channel",
            target: { channelId: "feishu", to: "user-1" },
          },
          content: { text: "orphan" },
          priority: "normal",
          createdAt: NOW,
          maxAttempts: 3,
        },
      },
    ], NOW);
    if (!prepared.accepted) throw new Error("fixture enqueue was rejected");
    await log.append(prepared.records.map(deliveryRecord));
    const trusted = source();
    const envelope = createDeliveryControlEnvelope({
      requestId: "delivery-resolution-orphan",
      source: trusted,
      at: NOW,
      body: {
        t: "delivery-resolve",
        itemId: prepared.items[0]!.itemId,
        attempt: 1,
        anchorEpoch: 7,
        openFactDigest: `sha256:${"a".repeat(64)}`,
        decision: "abandon",
      },
    });
    const authority = {
      anchorEpoch: 7,
      coordinate: <Result>(operation: () => Promise<Result>) => operation(),
      statusHistory: async () => [],
    } as unknown as DeliveryAuthority;

    await expect(application({
      admission,
      authority,
    }).execute(commandFromEnvelope(envelope))).rejects.toThrow(
      "Delivery enqueue must have exactly one matching authority source fact",
    );
  });
});
