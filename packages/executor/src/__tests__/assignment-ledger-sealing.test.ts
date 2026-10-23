// 拆分自 assignment-ledger.test.ts（按主题分文件以便并行执行）：sealing。
import { FileAuthorityCommitLog } from "@zhixing/core/authority";
import type { AssignmentActivationProof, AssignmentEntry, DispatchEnvelope } from "@zhixing/core/contracts";
import { advanceAssignmentLedger, createSignedConversationEnvelope, dispatchEnvelopeArtifact, dispatchEnvelopeDigest, protocolDigest, createConversationSealedBundle, sealedBundleArtifact, signCancelProof, validateAssignmentEntry, validateConversationEnvelope, validateNonEmptyUserTurnInput, validateStagedMutationRecord, validateTranscriptRunRecord } from "@zhixing/core/protocol";
import { InProcessConversationDispatcher } from "@zhixing/owner-kernel/conversation-assignment";
import { describe, expect, it, onTestFinished } from "vitest";
import { NOW, EXECUTOR_ID, CONVERSATION_ID, RUN_ID, ASSIGNMENT_ID, SHA256_ZERO, ABORT_TICKET_DIGEST, DURABLE_IO_TEST_TIMEOUT_MS, allowOnceDecisionDigest, createUnassignedHarness, createHarness, createUnsignedEnvelope, ingress, ownerContext, submissionContext, storedAssignmentFact, appendCompleteConversationCommit, putRealSealedBundleRef, sealDefaultBundle, createAlternativeDispatch, createCancellationSubmission, createBundleSubmission, reopenJournal, withoutSignature, replayFixtureLog } from "./assignment-ledger-fixture.js";

describe("conversation assignment protocol", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
  it("rejects dispatch not-started proof after durable started and stops only dispatch recovery", async () => {
    const harness = await createHarness();
    await harness.journal.reportStarted(
      ASSIGNMENT_ID,
      submissionContext(harness.unsigned),
    );
    const payload = {
      v: 1 as const,
      assignmentId: ASSIGNMENT_ID,
      executorId: EXECUTOR_ID,
      dispatchDigest: dispatchEnvelopeDigest(harness.dispatch.envelope),
      error: {
        code: "missing-base" as const,
        message: "required base is unavailable",
        retryable: true,
      },
      lastRecordSeq: 1,
      ledgerDigest: SHA256_ZERO,
    };
    const proof = {
      ...payload,
      signature: harness.identity.sign("DispatchRejectionProof", 1, payload),
    };
    await harness.journal.acceptDispatchRejection({
      v: 1,
      accepted: false,
      outcome: "rejected-before-received",
      error: payload.error,
      proof,
    });

    expect(await harness.journal.currentState(RUN_ID)).toBe("uncertain");
    expect(await harness.journal.assignmentsAwaitingRecovery()).toEqual([]);
    expect(await reopenJournal(harness).assignmentsAwaitingRecovery()).toEqual([]);
  });

  it("treats an already-started supersede proof as the durable started report", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    const fence = await harness.journal.requestSupersede(
      ASSIGNMENT_ID,
      "supersede-after-start",
    );
    const proof = await harness.ledger.supersede(
      ASSIGNMENT_ID,
      fence,
      ownerContext(ASSIGNMENT_ID, "executor.supersede"),
    );

    expect(proof.decision).toBe("already-started");
    await harness.journal.acceptSupersedeProof(proof);
    expect(await harness.journal.currentState(RUN_ID)).toBe("running");
    expect(await harness.journal.pendingSupersedes()).toEqual([]);
  });

  it("keeps a later cancel when an in-flight supersede proves already-started", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    const fence = await harness.journal.requestSupersede(
      ASSIGNMENT_ID,
      "supersede-started-before-cancel",
    );
    const proof = await harness.ledger.supersede(
      ASSIGNMENT_ID,
      fence,
      ownerContext(ASSIGNMENT_ID, "executor.supersede"),
    );
    const cancellation = await harness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "cancel-after-started-supersede",
    });
    if (cancellation.state !== "cancel-requested") throw new Error("cancel fence missing");
    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      cancellation.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );

    await harness.journal.acceptSupersedeProof(proof);
    expect(await harness.journal.currentState(RUN_ID)).toBe("cancel-requested");
    expect(await harness.journal.pendingSupersedes()).toEqual([]);
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      (await harness.ledger.cancelProof(ASSIGNMENT_ID))!,
      submissionContext(harness.unsigned),
    );
    expect(await harness.journal.currentState(RUN_ID)).toBe("cancelled");
  });

  it("replays a durable owner cancellation and accepts its not-started proof", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const cancelled = await harness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "cancel-before-start",
    });
    expect(cancelled.state).toBe("cancel-requested");
    if (cancelled.state !== "cancel-requested") throw new Error("cancel fence missing");
    expect(await harness.journal.pendingCancellations()).toEqual([
      { assignmentId: ASSIGNMENT_ID, fence: cancelled.fence },
    ]);

    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      cancelled.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    const proof = await harness.ledger.cancelProof(ASSIGNMENT_ID);
    expect(proof?.decision).toBe("not-started");
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      proof!,
      submissionContext(harness.unsigned),
    );
    expect(await harness.journal.currentState(RUN_ID)).toBe("cancelled");
    expect(await harness.journal.pendingCancellations()).toEqual([]);
    const accepted = (await harness.log.readStream(`run:${CONVERSATION_ID}`)).filter(
      (record) =>
        (record.body as { readonly t?: string }).t === "cancel-proof-accepted",
    );
    expect(accepted).toHaveLength(1);

    const beforeReplay = (await harness.log.readAll()).length;
    const reopened = reopenJournal(harness);
    await reopened.submitCancelProof(
      ASSIGNMENT_ID,
      proof!,
      submissionContext(harness.unsigned),
    );
    expect(await harness.log.readAll()).toHaveLength(beforeReplay);

    const conflictingPayload = {
      ...withoutSignature(proof!),
      issuedAt: "2026-07-13T09:00:01.000Z",
    };
    const conflicting = signCancelProof(conflictingPayload, harness.identity);
    await expect(
      reopened.submitCancelProof(
        ASSIGNMENT_ID,
        conflicting,
        submissionContext(harness.unsigned),
      ),
    ).rejects.toThrow("different durable termination proof");
  });

  it("rejects non-atomic owner termination facts during replay", async () => {
    const bareState = await createHarness();
    await replayFixtureLog(bareState).append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "state",
          runId: RUN_ID,
          assignmentId: ASSIGNMENT_ID,
          state: "cancelled",
          statusRevision: 3,
        },
      },
    ]);
    await expect(bareState.journal.currentState(RUN_ID)).rejects.toThrow(
      "not atomic with its termination proof",
    );

    const bareAccepted = await createHarness();
    await bareAccepted.ledger.dispatch(
      bareAccepted.dispatch.envelope,
      bareAccepted.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await bareAccepted.ledger.abortFromSurface(ASSIGNMENT_ID, {
      ticketDigest: ABORT_TICKET_DIGEST,
      surfacePrincipal: "surface:user-1",
    });
    await replayFixtureLog(bareAccepted).append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "cancel-proof-accepted",
          assignmentId: ASSIGNMENT_ID,
          proof: (await bareAccepted.ledger.cancelProof(ASSIGNMENT_ID))!,
        },
      },
    ]);
    await expect(bareAccepted.journal.currentState(RUN_ID)).rejects.toThrow(
      "Accepted cancel proof replay contract",
    );

    const bareSupersede = await createHarness();
    const fence = await bareSupersede.journal.requestSupersede(
      ASSIGNMENT_ID,
      "bare-supersede-proof",
    );
    const proof = await bareSupersede.ledger.supersede(
      ASSIGNMENT_ID,
      fence,
      ownerContext(ASSIGNMENT_ID, "executor.supersede"),
    );
    await replayFixtureLog(bareSupersede).append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: { t: "assignment-superseded", assignmentId: ASSIGNMENT_ID, proof },
      },
    ]);
    await expect(bareSupersede.journal.currentState(RUN_ID)).rejects.toThrow(
      "Assignment supersede replay contract",
    );
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("rejects non-atomic initial facts, cross-conversation dispatches, and non-head assignments", async () => {
    const admittedOnly = await createUnassignedHarness();
    await replayFixtureLog(admittedOnly).append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "admitted",
          ingressKey: "surface:user-1/split-admission",
          runId: "run-split-admission",
          input: { parts: [{ type: "text", text: "split" }] },
          ingress: ingress(),
          invocation: { kind: "agent", source: "interactive" },
          queuedPosition: 1,
        },
      },
    ]);
    await expect(admittedOnly.journal.currentState("run-split-admission")).rejects.toThrow(
      "not atomic with its initial queued state",
    );

    const assignedOnly = await createUnassignedHarness();
    const bareAssignment = await storedAssignmentFact(
      assignedOnly,
      assignedOnly.unsigned,
    );
    await replayFixtureLog(assignedOnly).append([
      { stream: `run:${CONVERSATION_ID}`, body: bareAssignment.record },
    ]);
    await expect(
      assignedOnly.journal.reportStarted(
        ASSIGNMENT_ID,
        submissionContext(assignedOnly.unsigned),
      ),
    ).rejects.toThrow("not atomic with dispatched state");
    await expect(assignedOnly.journal.currentState(RUN_ID)).rejects.toThrow(
      "not atomic with dispatched state",
    );

    const crossConversation = await createUnassignedHarness();
    const foreignUnsigned = createUnsignedEnvelope(crossConversation.identity, {
      conversationId: "conversation-foreign",
    });
    const foreignAssignment = await storedAssignmentFact(
      crossConversation,
      foreignUnsigned,
    );
    await replayFixtureLog(crossConversation).append([
      { stream: `run:${CONVERSATION_ID}`, body: foreignAssignment.record },
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "state",
          runId: RUN_ID,
          assignmentId: ASSIGNMENT_ID,
          state: "dispatched",
          statusRevision: 2,
        },
      },
    ]);
    await expect(crossConversation.journal.pendingDispatches()).rejects.toThrow(
      "does not match its dispatch artifact",
    );

    const nonHead = await createUnassignedHarness();
    await nonHead.journal.admit({
      ingressKey: "surface:user-1/queued-second",
      runId: "run-second",
      userInput: { parts: [{ type: "text", text: "second" }] },
      ingress: ingress(),
      invocation: { kind: "agent", source: "interactive" },
      queuedPosition: 1,
    });
    const secondUnsigned = createUnsignedEnvelope(nonHead.identity, {
      runId: "run-second",
      assignmentId: "assignment-second",
    });
    const secondAssignment = await storedAssignmentFact(nonHead, secondUnsigned);
    await replayFixtureLog(nonHead).append([
      { stream: `run:${CONVERSATION_ID}`, body: secondAssignment.record },
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "state",
          runId: "run-second",
          assignmentId: "assignment-second",
          state: "dispatched",
          statusRevision: 2,
        },
      },
    ]);
    await expect(nonHead.journal.currentState("run-second")).rejects.toThrow(
      "Run assignment is duplicated, misplaced, or not atomic with dispatched state",
    );
  });

  it("rejects unknown fields in durable owner run records", async () => {
    const harness = await createHarness();
    await replayFixtureLog(harness).append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "capability-revoked",
          assignmentId: ASSIGNMENT_ID,
          capId: harness.unsigned.capabilities[0]!.capId,
          futureField: true,
        } as never,
      },
    ]);
    await expect(harness.journal.currentState(RUN_ID)).rejects.toThrow(
      "fields are incomplete or unknown",
    );
  });

  it("rejects invalid durable admission values before they reach queue indexes", async () => {
    const harness = await createHarness();
    // Inject through a peer without owner projections so this still exercises
    // replay rejection; the live read index also rejects this on append now.
    const corruptPeer = new FileAuthorityCommitLog(harness.log.rootDir, harness.artifacts, {clock: () => NOW});
    onTestFinished(() => corruptPeer.stopStorageMaintenance());
    await corruptPeer.append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "admitted",
          ingressKey: "surface:user-2/ingress-invalid",
          runId: "run-invalid",
          input: { parts: [{ type: "text", text: "invalid" }] },
          ingress: ingress(),
          invocation: { kind: "agent", source: "interactive" },
          queuedPosition: "1",
        } as never,
      },
    ]);
    await expect(harness.journal.currentState(RUN_ID)).rejects.toThrow(
      "Admitted queued position",
    );
    await expect(
      harness.journal.admit({
        ingressKey: "surface:user-2/ingress-invalid-source",
        runId: "run-invalid-source",
        userInput: { parts: [{ type: "text", text: "invalid" }] },
        ingress: { ...ingress(), receivedAt: "not-a-time" },
        invocation: { kind: "agent", source: "interactive" },
        queuedPosition: 2,
      }),
    ).rejects.toThrow("canonical ISO timestamp");
  });

  it("fails closed across nested wire, durable, manifest, message, and optional schemas", async () => {
    const harness = await createHarness();
    const pollutedInput = {
      parts: [
        {
          type: "image",
          source: { type: "url", url: "https://example.test/image", future: true },
        },
      ],
    };
    expect(() => validateNonEmptyUserTurnInput(pollutedInput)).toThrow(
      "unknown",
    );
    await expect(
      harness.journal.admit({
        ingressKey: "surface:user-2/ingress-polluted-input",
        runId: "run-polluted-input",
        userInput: pollutedInput as never,
        ingress: ingress(),
        invocation: { kind: "agent", source: "interactive" },
        queuedPosition: 2,
      }),
    ).rejects.toThrow("unknown");

    const pollutedMessage = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "hello", future: true }],
    };
    expect(() =>
      createSignedConversationEnvelope(
        {
          ...harness.unsigned,
          work: {
            ...harness.unsigned.work,
            windowInput: {
              t: "full",
              windowEpoch: 1,
              messages: [pollutedMessage],
            },
          },
        } as never,
        harness.identity,
        harness.identity,
      ),
    ).toThrow("unknown");
    expect(() =>
      createSignedConversationEnvelope(
        {
          ...harness.unsigned,
          work: {
            ...harness.unsigned.work,
            windowInput: {
              t: "delta",
              baseEpoch: 1,
              targetEpoch: 2,
              baseDigest: SHA256_ZERO,
              targetDigest: SHA256_ZERO,
              appended: [pollutedMessage],
            },
          },
        } as never,
        harness.identity,
        harness.identity,
      ),
    ).toThrow("unknown");
    expect(() =>
      createSignedConversationEnvelope(
        {
          ...harness.unsigned,
          manifest: {
            ...harness.unsigned.manifest,
            environment: {
              credentialBindings: [
                { service: "calendar", bindingId: "binding-1", future: true },
              ],
            },
          },
        } as never,
        harness.identity,
        harness.identity,
      ),
    ).toThrow("unknown");

    expect(() =>
      validateTranscriptRunRecord({
        type: "run",
        runId: RUN_ID,
        runIndex: 8,
        timestamp: NOW,
        messages: [pollutedMessage],
      } as never),
    ).toThrow("unknown");
    expect(() =>
      validateTranscriptRunRecord({
        type: "run",
        runId: RUN_ID,
        runIndex: 8,
        timestamp: NOW,
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-use-noncanonical",
                name: "write-file",
                input: { nested: new Date(NOW) },
              },
            ],
          },
        ],
      } as never),
    ).toThrow("canonical JSON");
    expect(() =>
      validateStagedMutationRecord({
        v: 1,
        t: "staged-mutation",
        seq: 1,
        domain: "global",
        requestId: "polluted-workscene",
        mutation: { kind: "workscene-create", name: "scene", workspace: false },
      }),
    ).toThrow("plain object");
    expect(() =>
      createConversationSealedBundle({
        assignmentId: ASSIGNMENT_ID,
        executorId: EXECUTOR_ID,
        streamFinal: { finalSeq: 1, streamDigest: SHA256_ZERO },
        usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
        usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
        dependencyArtifacts: [],
        body: {
          t: "conversation",
          runId: RUN_ID,
          conversationId: CONVERSATION_ID,
          ownerEpoch: 3,
          baseRevision: 7,
          runRecord: {
            type: "run",
            runId: RUN_ID,
            runIndex: 8,
            timestamp: NOW,
            messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
          },
          contentAssets: [],
          mutationBatch: false,
        } as never,
      }),
    ).toThrow("Mutation batch summary");
    expect(() =>
      validateAssignmentEntry(
        {
          recordSeq: 1,
          body: {
            v: 1,
            t: "bundle_sealed",
            bundle: { ref: dispatchEnvelopeArtifact(harness.dispatch.envelope).ref },
            mutationBatch: false,
          } as never,
        },
        harness.identity,
      ),
    ).toThrow("mutation batch container");
    expect(() =>
      validateConversationEnvelope(harness.dispatch.envelope, harness.identity),
    ).not.toThrow();
  });

  it("fails closed on wrong-version or polluted executor ledger and response contracts", async () => {
    const validationHarness = await createHarness();
    expect(() =>
      validateAssignmentEntry(
        {
          recordSeq: 1,
          body: {
            v: 1,
            t: "staged-mutation",
            seq: 1,
            domain: "session",
            requestId: "invalid-nested-mutation",
            mutation: { kind: "future-session-mutation" },
          },
        },
        validationHarness.identity,
      ),
    ).toThrow("closed union");
    for (const invalidBody of [
      { v: 2, t: "started" },
      { v: 1, t: "cancel-proof-owner-accepted" },
      {
        v: 2,
        t: "cancel-proof-owner-accepted",
        futureField: true,
      },
      {
        v: 1,
        t: "interaction-settlement-owner-accepted",
        assignmentId: ASSIGNMENT_ID,
        ticketDigest: SHA256_ZERO,
        settlementVersion: 1,
      },
      {
        v: 2,
        t: "interaction-settlement-owner-accepted",
        assignmentId: ASSIGNMENT_ID,
        ticketDigest: SHA256_ZERO,
        settlementVersion: 3,
      },
      {
        v: 2,
        t: "interaction-settlement-owner-accepted",
        assignmentId: ASSIGNMENT_ID,
        ticketDigest: SHA256_ZERO,
        settlementVersion: 1,
        futureField: true,
      },
      {
        v: 1,
        t: "supersede-fenced",
        fenceSeq: 1,
        requestId: "future-request",
        futureField: true,
      },
    ]) {
      const executorReplay = await createHarness();
      await executorReplay.log.append([
        {
          stream: `assignment:${ASSIGNMENT_ID}`,
          body: { recordSeq: 1, body: invalidBody } as never,
        },
      ]);
      await expect(
        executorReplay.ledger.queryLedger(
          ASSIGNMENT_ID,
          ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
        ),
      ).rejects.toThrow();
    }

    const owner = await createHarness();
    await expect(
      owner.journal.validateExecutorDispatchResult({
        v: 1,
        accepted: true,
        futureField: true,
      } as never),
    ).rejects.toThrow("Accepted dispatch result");
    await expect(
      owner.journal.validateExecutorDispatchResult({
        v: 2,
        accepted: true,
      } as never),
    ).rejects.toThrow("version must be 1");
    await expect(
      owner.journal.reconcileStarted(ASSIGNMENT_ID, {
        v: 1,
        assignmentId: ASSIGNMENT_ID,
        phase: "started",
        lastSeq: 2,
        futureField: true,
      } as never),
    ).rejects.toThrow("Ledger snapshot");
    expect(await owner.journal.currentState(RUN_ID)).toBe("dispatched");
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("rejects every incomplete atomic closure for conflict and uncertain resolution", async () => {
    const ackedConflict = await createHarness();
    const ackedAlternative = createAlternativeDispatch(ackedConflict);
    await ackedConflict.ledger.dispatch(
      ackedConflict.dispatch.envelope,
      ackedConflict.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const ackedResult = await ackedConflict.ledger.dispatch(
      ackedAlternative.envelope,
      ackedAlternative.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    if (ackedResult.accepted || ackedResult.outcome !== "conflicting-redelivery") {
      throw new Error("expected owner-authoritative conflict");
    }
    await replayFixtureLog(ackedConflict).append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "dispatch-conflict",
          assignmentId: ASSIGNMENT_ID,
          proof: ackedResult.proof,
          handling: "acked-original",
        },
      },
    ]);
    await expect(ackedConflict.journal.currentState(RUN_ID)).rejects.toThrow(
      "incomplete",
    );

    const openedConflict = await createHarness();
    const openedAlternative = createAlternativeDispatch(openedConflict);
    await openedConflict.ledger.dispatch(
      openedAlternative.envelope,
      openedAlternative.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const openedResult = await openedConflict.ledger.dispatch(
      openedConflict.dispatch.envelope,
      openedConflict.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    if (openedResult.accepted || openedResult.outcome !== "conflicting-redelivery") {
      throw new Error("expected mismatched conflict");
    }
    await replayFixtureLog(openedConflict).append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "dispatch-conflict",
          assignmentId: ASSIGNMENT_ID,
          proof: openedResult.proof,
          handling: "opened-uncertain",
        },
      },
    ]);
    await expect(openedConflict.journal.currentState(RUN_ID)).rejects.toThrow(
      "incomplete",
    );

    for (const decision of [
      {
        kind: "proven-not-started-redispatched" as const,
        by: EXECUTOR_ID,
        state: "queued" as const,
        expected: "missing its atomic authority facts",
      },
      {
        kind: "user-abandoned" as const,
        by: "surface:user-1",
        state: "cancelled" as const,
        expected: "missing its atomic authority facts",
      },
    ]) {
      const incompleteResolution = await createHarness();
      const fact = await incompleteResolution.journal.markAssignmentUncertain(
        ASSIGNMENT_ID,
        "ledger-unknown",
      );
      const resolution = {
        kind: decision.kind,
        by: decision.by,
        at: NOW,
        factDigest: protocolDigest("UncertainResolutionDecision", 1, {
          openFactDigest: fact.openFactDigest,
          kind: decision.kind,
          by: decision.by,
          at: NOW,
        }),
      };
      await replayFixtureLog(incompleteResolution).append([
        {
          stream: `run:${CONVERSATION_ID}`,
          body: {
            t: "resolution",
            runId: RUN_ID,
            fact: { ...fact, resolution },
          },
        },
        ...incompleteResolution.unsigned.capabilities.map((capability) => ({
          stream: `run:${CONVERSATION_ID}`,
          body: {
            t: "capability-revoked" as const,
            capId: capability.capId,
            assignmentId: ASSIGNMENT_ID,
          },
        })),
        {
          stream: `run:${CONVERSATION_ID}`,
          body: {
            t: "state",
            runId: RUN_ID,
            assignmentId: ASSIGNMENT_ID,
            state: decision.state,
            statusRevision: 4,
          },
        },
      ]);
      await expect(
        incompleteResolution.journal.currentState(RUN_ID),
      ).rejects.toThrow(decision.expected);
    }

    const wrongApplied = await createHarness();
    const fact = await wrongApplied.journal.markAssignmentUncertain(
      ASSIGNMENT_ID,
      "ledger-unknown",
    );
    const resolution = {
      kind: "user-abandoned" as const,
      by: "surface:user-1",
      at: NOW,
      factDigest: protocolDigest("UncertainResolutionDecision", 1, {
        openFactDigest: fact.openFactDigest,
        kind: "user-abandoned",
        by: "surface:user-1",
        at: NOW,
      }),
    };
    const authorityRevision =
      ((await wrongApplied.log.readAll()).at(-1)?.lsn ?? 0) + 1;
    const wrongAppliedRecords = [
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "resolution",
          runId: RUN_ID,
          fact: { ...fact, resolution },
        },
      },
      ...wrongApplied.unsigned.capabilities.map((capability) => ({
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "capability-revoked" as const,
          capId: capability.capId,
          assignmentId: ASSIGNMENT_ID,
        },
      })),
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "state",
          runId: RUN_ID,
          assignmentId: ASSIGNMENT_ID,
          state: "cancelled",
          statusRevision: 4,
        },
      },
      {
        stream: "control",
        body: {
          t: "applied",
          requestId: "unrelated-resolution",
          authorityRevision,
          result: {
            v: 1,
            status: "ok",
            body: {
              t: "uncertain-resolve",
              state: "cancelled",
              factDigest: fact.openFactDigest,
            },
          },
        },
      },
    ];
    await expect(wrongApplied.log.append(wrongAppliedRecords)).rejects.toThrow(
      "Control applied record has no received predecessor",
    );
    // 正式写入口已拒绝；隔离写者用于继续验证已有损坏历史的冷读拒绝。
    const rawResolution = new FileAuthorityCommitLog(wrongApplied.log.rootDir, wrongApplied.artifacts, { clock: () => NOW });
    onTestFinished(() => rawResolution.stopStorageMaintenance());
    await rawResolution.append(wrongAppliedRecords);
    await expect(wrongApplied.journal.currentState(RUN_ID)).rejects.toThrow(
      "missing its atomic authority facts",
    );
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("requires complete sidecars and capability revocations for conversation commit", async () => {
    const incomplete = await createHarness();
    await incomplete.ledger.dispatch(
      incomplete.dispatch.envelope,
      incomplete.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await incomplete.ledger.start(ASSIGNMENT_ID);
    const incompleteBundle = await sealDefaultBundle(incomplete.ledger);
    await replayFixtureLog(incomplete).append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "committed",
          runId: RUN_ID,
          assignmentId: ASSIGNMENT_ID,
          bundle: { ref: sealedBundleArtifact(incompleteBundle).ref },
          commitRevision: incompleteBundle.body.baseRevision + 1,
        },
      },
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "state",
          runId: RUN_ID,
          assignmentId: ASSIGNMENT_ID,
          state: "committed",
          statusRevision: 3,
        },
      },
    ]);
    await expect(
      incomplete.journal.submitBundle(
        incompleteBundle,
        submissionContext(incomplete.unsigned),
      ),
    ).rejects.toThrow("Committed run replay contract");
    await expect(incomplete.journal.currentState(RUN_ID)).rejects.toThrow(
      "Committed run replay contract",
    );

    const missingBaseSidecars = await createHarness();
    await missingBaseSidecars.ledger.dispatch(
      missingBaseSidecars.dispatch.envelope,
      missingBaseSidecars.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await missingBaseSidecars.ledger.start(ASSIGNMENT_ID);
    const sidecarlessBundle = await sealDefaultBundle(missingBaseSidecars.ledger);
    await replayFixtureLog(missingBaseSidecars).append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "committed",
          runId: RUN_ID,
          assignmentId: ASSIGNMENT_ID,
          bundle: { ref: sealedBundleArtifact(sidecarlessBundle).ref },
          commitRevision: sidecarlessBundle.body.baseRevision + 1,
        },
      },
      ...missingBaseSidecars.unsigned.capabilities.map((capability) => ({
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "capability-revoked" as const,
          capId: capability.capId,
          assignmentId: ASSIGNMENT_ID,
        },
      })),
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "state",
          runId: RUN_ID,
          assignmentId: ASSIGNMENT_ID,
          state: "committed",
          statusRevision: 3,
        },
      },
    ]);
    await expect(
      missingBaseSidecars.journal.submitBundle(
        sidecarlessBundle,
        submissionContext(missingBaseSidecars.unsigned),
      ),
    ).rejects.toThrow(/content sidecar|missing its content, publish, or final sidecars/);
    await expect(
      missingBaseSidecars.journal.currentState(RUN_ID),
    ).rejects.toThrow(/missing its content, publish, or final sidecars|Submission guard commit has no unique content sidecar/);

    const missingPublish = await createHarness();
    await missingPublish.ledger.dispatch(
      missingPublish.dispatch.envelope,
      missingPublish.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await missingPublish.ledger.start(ASSIGNMENT_ID);
    await missingPublish.ledger.stageMutation(ASSIGNMENT_ID, {
      domain: "session",
      requestId: "missing-publish-sidecars",
      mutation: {
        kind: "task-list-op",
        op: {
          op: "set",
          state: {
            items: [{ id: "task-sidecar", content: "ship", status: "pending" }],
          },
        },
      },
    });
    const missingPublishBundle = await sealDefaultBundle(missingPublish.ledger);
    const missingPublishRevision = missingPublishBundle.body.baseRevision + 1;
    await replayFixtureLog(missingPublish).append([
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "committed",
          runId: RUN_ID,
          assignmentId: ASSIGNMENT_ID,
          bundle: { ref: sealedBundleArtifact(missingPublishBundle).ref },
          commitRevision: missingPublishRevision,
        },
      },
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          kind: "content-asset-index",
          entries: missingPublishBundle.body.contentAssets,
        },
      },
      ...missingPublish.unsigned.capabilities.map((capability) => ({
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "capability-revoked" as const,
          capId: capability.capId,
          assignmentId: ASSIGNMENT_ID,
        },
      })),
      {
        stream: `run:${CONVERSATION_ID}`,
        body: {
          t: "state",
          runId: RUN_ID,
          assignmentId: ASSIGNMENT_ID,
          state: "committed",
          statusRevision: 3,
        },
      },
      {
        stream: "final-outbox",
        body: {
          t: "final",
          conversationId: CONVERSATION_ID,
          runId: RUN_ID,
          commitRevision: missingPublishRevision,
          digest: missingPublishBundle.digest,
          state: "pending",
        },
      },
    ]);
    await expect(
      missingPublish.journal.submitBundle(
        missingPublishBundle,
        submissionContext(missingPublish.unsigned),
      ),
    ).rejects.toThrow(/durable sidecars|missing its content, publish, or final sidecars/);
    await expect(missingPublish.journal.currentState(RUN_ID)).rejects.toThrow(
      "missing its content, publish, or final sidecars",
    );

    const complete = await createHarness();
    await complete.ledger.dispatch(
      complete.dispatch.envelope,
      complete.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await complete.ledger.start(ASSIGNMENT_ID);
    const bundle = await sealDefaultBundle(complete.ledger);
    await expect(
      complete.journal.submitBundle(bundle, submissionContext(complete.unsigned)),
    ).resolves.toMatchObject({ committed: true });
    const committed = (await complete.log.readAll()).find((envelope) =>
      envelope.entries.some(
        (entry) =>
          entry.stream === `run:${CONVERSATION_ID}` &&
          (entry.body as { readonly t?: string }).t === "committed",
      ),
    );
    expect(
      committed?.entries.some(
        (entry) =>
          entry.stream === `run:${CONVERSATION_ID}` &&
          (entry.body as { readonly t?: string }).t === "capability-revoked",
      ),
    ).toBe(true);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("rejects incomplete historical commit fences and conflict late-bundle closures", async () => {
    for (const variant of ["executor", "owner-epoch"] as const) {
      const harness = await createHarness();
      await harness.ledger.dispatch(
        harness.dispatch.envelope,
        harness.dispatch.activation,
        ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
      );
      await harness.ledger.start(ASSIGNMENT_ID);
      const valid = await sealDefaultBundle(harness.ledger);
      const { v: _version, digest: _digest, ...payload } = valid;
      const invalid = createConversationSealedBundle({
        ...payload,
        ...(variant === "executor" ? { executorId: "executor-foreign" } : {}),
        body: {
          ...valid.body,
          ...(variant === "owner-epoch" ? { ownerEpoch: 4 } : {}),
        },
      });
      await harness.artifacts.put(sealedBundleArtifact(invalid).bytes);
      await appendCompleteConversationCommit({ ...harness, log: replayFixtureLog(harness) }, invalid, 3, true);

      await expect(
        reopenJournal(harness).submitBundle(
          invalid,
          submissionContext(harness.unsigned),
        ),
      ).rejects.toThrow(/durable assignment fence|historical assignment fence/);
      await expect(harness.journal.currentState(RUN_ID)).rejects.toThrow(
        "historical assignment fence",
      );
    }

    const conflicted = await createHarness();
    const alternative = createAlternativeDispatch(conflicted);
    await conflicted.ledger.dispatch(
      alternative.envelope,
      alternative.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await conflicted.ledger.start(ASSIGNMENT_ID);
    const conflict = await conflicted.ledger.dispatch(
      conflicted.dispatch.envelope,
      conflicted.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    if (conflict.accepted || conflict.outcome !== "conflicting-redelivery") {
      throw new Error("expected mismatched conflict");
    }
    await conflicted.journal.recordDispatchConflict(conflicted.dispatch, conflict);
    const bundle = await sealDefaultBundle(conflicted.ledger);
    const fact = await conflicted.journal.currentResolution(RUN_ID);
    if (!fact || fact.cause !== "dispatch-conflict") {
      throw new Error("dispatch conflict resolution fact missing");
    }
    const resolution = {
      kind: "late-bundle-committed" as const,
      by: EXECUTOR_ID,
      at: NOW,
      factDigest: protocolDigest("UncertainResolutionDecision", 1, {
        openFactDigest: fact.openFactDigest,
        kind: "late-bundle-committed",
        by: EXECUTOR_ID,
        at: NOW,
      }),
    };
    // 以迟到包提交收束调度冲突：会话读索引在写入时即拒绝。
    await expect(appendCompleteConversationCommit(conflicted, bundle, 4, false, {
      ...fact,
      resolution,
    })).rejects.toThrow("Dispatch conflict cannot close through a late bundle commit");
    // 不经读索引写入的同类历史（例如旧版本留下的记录），回放时同样被拒绝。
    const raw = new FileAuthorityCommitLog(conflicted.log.rootDir, conflicted.artifacts);
    await appendCompleteConversationCommit({ ...conflicted, log: raw }, bundle, 4, false, {
      ...fact,
      resolution,
    });
    await raw.stopStorageMaintenance();
    const corrupted = /Committed run replay contract|Dispatch conflict cannot close through a late bundle commit/u;
    await expect(
      reopenJournal(conflicted).submitBundle(
        bundle,
        submissionContext(conflicted.unsigned),
      ),
    ).rejects.toThrow(corrupted);
    await expect(conflicted.journal.currentState(RUN_ID)).rejects.toThrow(corrupted);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("recovers a cancelled run from a dispatch rejection whose response was lost", async () => {
    const harness = await createHarness();
    const badPayload = {
      ...withoutSignature(harness.dispatch.activation),
      manifestDigest: SHA256_ZERO,
    };
    const badActivation: AssignmentActivationProof<"conversation"> = {
      ...badPayload,
      signature: harness.identity.sign("AssignmentActivationProof", 1, badPayload),
    };
    const rejected = await harness.ledger.dispatch(
      harness.dispatch.envelope,
      badActivation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    expect(rejected).toMatchObject({
      accepted: false,
      outcome: "rejected-before-received",
    });
    const cancellation = await harness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "cancel-after-dispatch-rejection",
    });
    if (cancellation.state !== "cancel-requested") throw new Error("cancel fence missing");
    await expect(
      harness.ledger.cancel(
        ASSIGNMENT_ID,
        cancellation.fence,
        ownerContext(ASSIGNMENT_ID, "executor.cancel"),
      ),
    ).resolves.toBeUndefined();

    const dispatcher = new InProcessConversationDispatcher({
      enabled: true,
      journal: harness.journal,
      executor: harness.ledger,
      contexts: { create: ownerContext },
      cancellationSubmission: createCancellationSubmission(harness),
      bundleSubmission: createBundleSubmission(harness),
    });
    expect(await dispatcher.recoverCancellationProofs()).toBe(1);
    expect(await harness.journal.currentState(RUN_ID)).toBe("cancelled");
    expect(await harness.journal.pendingCancellations()).toEqual([]);
  });

  it("halts a running assignment only after every side effect closes", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    await harness.journal.reportStarted(
      ASSIGNMENT_ID,
      submissionContext(harness.unsigned),
    );
    const effect = await harness.ledger.startSideEffect(ASSIGNMENT_ID, {
      kind: "external-call",
      toolName: "calendar.create",
      summary: "create calendar event",
      target: "external-service",
    });
    const cancelled = await harness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "cancel-running",
    });
    if (cancelled.state !== "cancel-requested") throw new Error("cancel fence missing");
    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      cancelled.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    expect(await harness.ledger.cancelProof(ASSIGNMENT_ID)).toBeUndefined();
    await expect(
      harness.ledger.startSideEffect(ASSIGNMENT_ID, {
        kind: "external-call",
        toolName: "calendar.delete",
        summary: "delete calendar event",
        target: "external-service",
      }),
    ).rejects.toThrow("active, unfenced");

    await harness.ledger.completeSideEffect(ASSIGNMENT_ID, effect.effectSeq, {
      status: "ok",
      resultDigest: SHA256_ZERO,
    });
    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      cancelled.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    const proof = await harness.ledger.cancelProof(ASSIGNMENT_ID);
    expect(proof).toMatchObject({ decision: "halted", lastEffectSeq: 1 });
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      proof!,
      submissionContext(harness.unsigned),
    );
    expect(await harness.journal.currentState(RUN_ID)).toBe("cancelled");
  });

  it("replays completed interaction and mutation requests after cancellation fences new work", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    await harness.ledger.requestInteraction(ASSIGNMENT_ID, {
      requestId: "interaction-before-cancel",
      toolName: "write-file",
      display: { title: "Write file", lines: ["workspace/report.md"] },
      issuedAt: NOW,
      ttlMs: 60_000,
      expiresAt: "2026-07-13T09:01:00.000Z",
    });
    const outcome = {
      t: "answered" as const,
      authority: { via: "surface-ticket" as const, ticketId: "ticket-before-cancel" },
      decision: { allowed: true },
      decisionDigest: allowOnceDecisionDigest("interaction-before-cancel"),
      by: "surface:user-1",
    };
    const finished = await harness.ledger.finishInteraction(
      ASSIGNMENT_ID,
      "interaction-before-cancel",
      outcome,
    );
    const mutation = {
      domain: "session" as const,
      requestId: "mutation-before-cancel",
      mutation: {
        kind: "task-list-op" as const,
        op: {
          op: "set" as const,
          state: { items: [{ id: "task-before-cancel", content: "ship", status: "pending" as const }] },
        },
      },
    };
    const staged = await harness.ledger.stageMutation(ASSIGNMENT_ID, mutation);
    const cancellation = await harness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "cancel-after-results",
    });
    if (cancellation.state !== "cancel-requested") throw new Error("cancel fence missing");
    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      cancellation.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );

    await expect(
      harness.ledger.finishInteraction(
        ASSIGNMENT_ID,
        "interaction-before-cancel",
        outcome,
      ),
    ).resolves.toEqual(finished);
    await expect(harness.ledger.stageMutation(ASSIGNMENT_ID, mutation)).resolves.toEqual(staged);
  });

  it("rejects sealing while a side effect is open in both producer and replay", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    await harness.ledger.startSideEffect(ASSIGNMENT_ID, {
      kind: "external-call",
      toolName: "calendar.create",
      summary: "create calendar event",
      target: "external-service",
    });
    await expect(sealDefaultBundle(harness.ledger)).rejects.toThrow(
      "open side effect",
    );

    const corruptBundle = await putRealSealedBundleRef(harness);
    await harness.log.append<AssignmentEntry>([
      {
        stream: `assignment:${ASSIGNMENT_ID}`,
        body: {
          recordSeq: 5,
          body: {
            v: 1,
            t: "bundle_sealed",
            bundle: { ref: corruptBundle },
          },
        },
      },
    ]);
    await expect(
      harness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      ),
    ).rejects.toThrow("bundle_sealed has no started prefix");
  });

  it.each([
    ["received", "is not the first record"],
    ["dispatch-rejected", "has no durable owner control prefix"],
  ] as const)(
    "rejects a late %s record after an abort fence during replay",
    async (kind, expectedError) => {
      const harness = await createHarness();
      const cancellation = await harness.journal.cancelRun({
        runId: RUN_ID,
        requestId: `abort-before-${kind}`,
      });
      if (cancellation.state !== "cancel-requested") throw new Error("cancel fence missing");
      const artifact = dispatchEnvelopeArtifact(harness.dispatch.envelope);
      const lateBody: AssignmentEntry["body"] =
        kind === "received"
          ? {
              v: 1,
              t: "received",
              envelope: { ref: artifact.ref },
              activation: harness.dispatch.activation,
            }
          : {
              v: 1,
              t: "dispatch-rejected",
              dispatchDigest: dispatchEnvelopeDigest(harness.dispatch.envelope),
              reason: {
                code: "fence-rejected",
                retryable: false,
                message: "Dispatch was fenced before receipt",
              },
            };
      await harness.log.append<AssignmentEntry>([
        {
          stream: `assignment:${ASSIGNMENT_ID}`,
          body: {
            recordSeq: 1,
            body: {
              v: 1,
              t: "control-lease-renewed",
              lease: harness.dispatch.envelope.controlLease,
            },
          },
        },
        {
          stream: `assignment:${ASSIGNMENT_ID}`,
          body: {
            recordSeq: 2,
            body: {
              v: 1,
              t: "abort-requested",
              via: "owner-fence",
              refId: cancellation.fence.requestId,
            },
          },
        },
        {
          stream: `assignment:${ASSIGNMENT_ID}`,
          body: { recordSeq: 3, body: lateBody },
        },
      ]);

      await expect(
        harness.ledger.queryLedger(
          ASSIGNMENT_ID,
          ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
        ),
      ).rejects.toThrow(expectedError);
    },
  );

  it.each([
    ["dispatch rejection", "dispatch-rejected", "durable owner control prefix"],
    ["supersede fence", "supersede-fenced", "controllable assignment prefix"],
    ["owner cancel fence", "owner-fence", "durable authorization prefix"],
    ["surface abort ticket", "abort-ticket", "durable authorization prefix"],
  ] as const)(
    "rejects %s without its required durable authority prefix",
    async (_label, kind, expected) => {
      const harness = await createUnassignedHarness();
      const body: AssignmentEntry["body"] = kind === "dispatch-rejected"
        ? {
            v: 1,
            t: "dispatch-rejected",
            dispatchDigest: protocolDigest(
              "DispatchEnvelope",
              1,
              harness.unsigned,
            ),
            reason: {
              code: "invalid",
              retryable: false,
              message: "invalid dispatch",
            },
          }
        : kind === "supersede-fenced"
          ? {
              v: 1,
              t: "supersede-fenced",
              fenceSeq: 1,
              requestId: "supersede-without-control",
            }
          : {
              v: 1,
              t: "abort-requested",
              via: kind,
              refId: `${kind}-without-authority`,
              ...(kind === "abort-ticket"
                ? { surfacePrincipal: "surface:origin" }
                : {}),
            };
      await harness.log.append<AssignmentEntry>([
        {
          stream: `assignment:${ASSIGNMENT_ID}`,
          body: { recordSeq: 1, body },
        },
      ]);

      await expect(harness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      )).rejects.toThrow(expected);
    },
  );

  it("rejects sealing with a pending interaction during replay", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    await harness.ledger.requestInteraction(ASSIGNMENT_ID, {
      requestId: "pending-at-seal",
      toolName: "write-file",
      display: { title: "Write file", lines: ["workspace/report.md"] },
      issuedAt: NOW,
      ttlMs: 60_000,
      expiresAt: "2026-07-13T09:01:00.000Z",
    });
    await expect(sealDefaultBundle(harness.ledger)).rejects.toThrow(
      "before every interaction obligation is complete",
    );
    const corruptBundle = await putRealSealedBundleRef(harness);
    await harness.log.append<AssignmentEntry>([
      {
        stream: `assignment:${ASSIGNMENT_ID}`,
        body: {
          recordSeq: 5,
          body: { v: 1, t: "bundle_sealed", bundle: { ref: corruptBundle } },
        },
      },
    ]);

    await expect(
      harness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      ),
    ).rejects.toThrow("bundle_sealed has no started prefix");
  });

  it("rejects terminal records until every finished interaction is mirrored", async () => {
    const sealHarness = await createHarness();
    await sealHarness.ledger.dispatch(
      sealHarness.dispatch.envelope,
      sealHarness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await sealHarness.ledger.start(ASSIGNMENT_ID);
    await sealHarness.ledger.requestInteraction(ASSIGNMENT_ID, {
      requestId: "unmirrored-at-seal",
      toolName: "write-file",
      display: { title: "Write file", lines: ["workspace/report.md"] },
      issuedAt: NOW,
      ttlMs: 60_000,
      expiresAt: "2026-07-13T09:01:00.000Z",
    });
    await sealHarness.ledger.finishInteraction(
      ASSIGNMENT_ID,
      "unmirrored-at-seal",
      {
        t: "answered",
        authority: { via: "surface-ticket", ticketId: "seal-ticket" },
        decision: { allowed: true },
        decisionDigest: allowOnceDecisionDigest("unmirrored-at-seal"),
        by: "surface:user-1",
      },
    );
    await expect(sealDefaultBundle(sealHarness.ledger)).rejects.toThrow(
      "before every interaction obligation is complete",
    );
    const corruptBundle = await putRealSealedBundleRef(sealHarness);
    await sealHarness.log.append<AssignmentEntry>([
      {
        stream: `assignment:${ASSIGNMENT_ID}`,
        body: {
          recordSeq: 6,
          body: { v: 1, t: "bundle_sealed", bundle: { ref: corruptBundle } },
        },
      },
    ]);
    await expect(
      sealHarness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      ),
    ).rejects.toThrow("bundle_sealed has no started prefix");

    const haltHarness = await createHarness();
    await haltHarness.ledger.dispatch(
      haltHarness.dispatch.envelope,
      haltHarness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await haltHarness.ledger.start(ASSIGNMENT_ID);
    await haltHarness.ledger.requestInteraction(ASSIGNMENT_ID, {
      requestId: "unmirrored-at-halt",
      toolName: "write-file",
      display: { title: "Write file", lines: ["workspace/report.md"] },
      issuedAt: NOW,
      ttlMs: 60_000,
      expiresAt: "2026-07-13T09:01:00.000Z",
    });
    await haltHarness.ledger.finishInteraction(
      ASSIGNMENT_ID,
      "unmirrored-at-halt",
      {
        t: "answered",
        authority: { via: "surface-ticket", ticketId: "halt-ticket" },
        decision: { allowed: true },
        decisionDigest: allowOnceDecisionDigest("unmirrored-at-halt"),
        by: "surface:user-1",
      },
    );
    const cancellation = await haltHarness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "halt-with-unmirrored-interaction",
    });
    if (cancellation.state !== "cancel-requested") throw new Error("cancel fence missing");
    await expect(
      haltHarness.ledger.cancel(
        ASSIGNMENT_ID,
        cancellation.fence,
        ownerContext(ASSIGNMENT_ID, "executor.cancel"),
      ),
    ).resolves.toBeUndefined();
    await expect(haltHarness.ledger.cancelProof(ASSIGNMENT_ID)).resolves.toBeUndefined();
    const page = await haltHarness.ledger.queryLedger(
      ASSIGNMENT_ID,
      ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      { fromSeq: 1, limit: 256 },
    );
    if (!("entries" in page)) throw new Error("expected ledger evidence page");
    const proof = signCancelProof(
      {
        v: 1,
        assignmentId: ASSIGNMENT_ID,
        executorId: EXECUTOR_ID,
        authority: {
          execution: "conversation",
          conversationId: CONVERSATION_ID,
          ownerEpoch: 3,
        },
        cause: "owner-fence",
        fence: cancellation.fence,
        decision: "halted",
        lastEffectSeq: 0,
        lastRecordSeq: page.toSeq,
        usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
        ledgerDigest: page.chainDigest,
        issuedAt: NOW,
      },
      haltHarness.identity,
    );
    await haltHarness.log.append<AssignmentEntry>([
      {
        stream: `assignment:${ASSIGNMENT_ID}`,
        body: {
          recordSeq: page.toSeq + 1,
          body: { v: 1, t: "halted", proof },
        },
      },
    ]);
    await expect(
      haltHarness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      ),
    ).rejects.toThrow("halted does not close the durable cancellation prefix");
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("rejects halting with a pending interaction during replay", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    await harness.ledger.requestInteraction(ASSIGNMENT_ID, {
      requestId: "pending-at-halt",
      toolName: "write-file",
      display: { title: "Write file", lines: ["workspace/report.md"] },
      issuedAt: NOW,
      ttlMs: 60_000,
      expiresAt: "2026-07-13T09:01:00.000Z",
    });
    const cancellation = await harness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "halt-with-pending-interaction",
    });
    if (cancellation.state !== "cancel-requested") throw new Error("cancel fence missing");
    const page = await harness.ledger.queryLedger(
      ASSIGNMENT_ID,
      ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      { fromSeq: 1, limit: 256 },
    );
    if (!("entries" in page)) throw new Error("expected ledger evidence page");
    const abort: AssignmentEntry = {
      recordSeq: page.toSeq + 1,
      body: {
        v: 1,
        t: "abort-requested",
        via: "owner-fence",
        refId: cancellation.fence.requestId,
      },
    };
    const abortDigest = advanceAssignmentLedger(page.chainDigest, abort);
    const proof = signCancelProof(
      {
        v: 1,
        assignmentId: ASSIGNMENT_ID,
        executorId: EXECUTOR_ID,
        authority: {
          execution: "conversation",
          conversationId: CONVERSATION_ID,
          ownerEpoch: 3,
        },
        cause: "owner-fence",
        fence: cancellation.fence,
        decision: "halted",
        lastEffectSeq: 0,
        lastRecordSeq: abort.recordSeq,
        usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
        ledgerDigest: abortDigest,
        issuedAt: NOW,
      },
      harness.identity,
    );
    await harness.log.append<AssignmentEntry>([
      { stream: `assignment:${ASSIGNMENT_ID}`, body: abort },
      {
        stream: `assignment:${ASSIGNMENT_ID}`,
        body: {
          recordSeq: abort.recordSeq + 1,
          body: { v: 1, t: "halted", proof },
        },
      },
    ]);

    await expect(
      harness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      ),
    ).rejects.toThrow("halted does not close the durable cancellation prefix");
  });

  it("rejects a second freshly signed halted terminal during replay", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    const cancellation = await harness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "duplicate-halted-terminal",
    });
    if (cancellation.state !== "cancel-requested") throw new Error("cancel fence missing");
    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      cancellation.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    const original = await harness.ledger.cancelProof(ASSIGNMENT_ID);
    if (!original) throw new Error("cancel proof missing");
    const page = await harness.ledger.queryLedger(
      ASSIGNMENT_ID,
      ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      { fromSeq: 1, limit: 256 },
    );
    if (!("entries" in page)) throw new Error("expected ledger evidence page");
    const duplicate = signCancelProof(
      {
        ...withoutSignature(original),
        lastRecordSeq: page.toSeq,
        ledgerDigest: page.chainDigest,
      },
      harness.identity,
    );
    await harness.log.append<AssignmentEntry>([
      {
        stream: `assignment:${ASSIGNMENT_ID}`,
        body: {
          recordSeq: page.toSeq + 1,
          body: { v: 1, t: "halted", proof: duplicate },
        },
      },
    ]);

    await expect(
      harness.ledger.queryLedger(
        ASSIGNMENT_ID,
        ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      ),
    ).rejects.toThrow("halted does not close the durable cancellation prefix");
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("keeps a late halted proof as evidence when cancellation was already uncertain", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    await harness.journal.reportStarted(
      ASSIGNMENT_ID,
      submissionContext(harness.unsigned),
    );
    const effect = await harness.ledger.startSideEffect(ASSIGNMENT_ID, {
      kind: "tool-mutation",
      toolName: "write",
      summary: "write workspace file",
      target: "workspace-file",
    });
    const cancelled = await harness.journal.cancelRun({
      runId: RUN_ID,
      requestId: "cancel-unproven",
    });
    if (cancelled.state !== "cancel-requested") throw new Error("cancel fence missing");
    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      cancelled.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    await harness.journal.markAssignmentUncertain(ASSIGNMENT_ID, "cancel-unproven");
    expect(await harness.journal.pendingCancellations()).toHaveLength(1);

    await harness.ledger.completeSideEffect(ASSIGNMENT_ID, effect.effectSeq, {
      status: "aborted",
    });
    await harness.ledger.cancel(
      ASSIGNMENT_ID,
      cancelled.fence,
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    );
    const contradictory = (await harness.ledger.cancelProof(ASSIGNMENT_ID))!;
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      contradictory,
      submissionContext(harness.unsigned),
    );
    expect(await harness.journal.currentState(RUN_ID)).toBe("uncertain");
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      contradictory,
      submissionContext(harness.unsigned),
    );
    expect(await harness.journal.currentState(RUN_ID)).toBe("uncertain");
    expect(await harness.journal.pendingCancellations()).toEqual([]);
  });

  it("accepts an abort-ticket not-started proof during owner recovery", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.abortFromSurface(ASSIGNMENT_ID, {
      ticketDigest: ABORT_TICKET_DIGEST,
      surfacePrincipal: "surface:user-1",
    });
    const proof = await harness.ledger.cancelProof(ASSIGNMENT_ID);
    expect(proof).toMatchObject({ cause: "abort-ticket", decision: "not-started" });
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      proof!,
      submissionContext(harness.unsigned),
    );
    expect(await harness.journal.currentState(RUN_ID)).toBe("cancelled");
  });

  it("accepts an abort-ticket halted proof for a running assignment", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.ledger.start(ASSIGNMENT_ID);
    await harness.journal.reportStarted(
      ASSIGNMENT_ID,
      submissionContext(harness.unsigned),
    );
    await harness.ledger.abortFromSurface(ASSIGNMENT_ID, {
      ticketDigest: ABORT_TICKET_DIGEST,
      surfacePrincipal: "surface:user-1",
    });
    const proof = await harness.ledger.cancelProof(ASSIGNMENT_ID);
    expect(proof).toMatchObject({ cause: "abort-ticket", decision: "halted" });
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      proof!,
      submissionContext(harness.unsigned),
    );
    expect(await harness.journal.currentState(RUN_ID)).toBe("cancelled");
  });
});
