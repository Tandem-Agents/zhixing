import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
  assistantMessage,
  extractText,
  userMessage,
  type AgentYield,
  type Message,
  type RunResult,
} from "@zhixing-ai/core";
import { ConfirmationBroker, buildConfirmationRequest } from "@zhixing-ai/core/confirmation";
import {
  AdvancementAcceptedTurnApplicationService,
} from "@zhixing-ai/core/advancement/application";
import { advancementExecutionTurnId } from "@zhixing-ai/core/advancement";
import { createSignedTrustRuleSnapshot, protocolDigest } from "@zhixing-ai/core/protocol";
import {
  SessionAdvancementStore,
  createAdvancementRecoveryMaintenance,
} from "@zhixing-ai/owner-services/advancement";
import {
  isLocalConversationId,
  localConversationId,
  worksceneConversationId,
} from "@zhixing-ai/core/conversation";
import { createInitialControlEnvelope } from "@zhixing-ai/owner-kernel/control-admission";
import { createAnchorHostIdleCheck } from "../idle-policy.js";
import {
  CONVERSATION_COMMUNICATION_NEW,
  CONVERSATION_COMMUNICATION_PRODUCT_API_EXACT_SET,
  CONVERSATION_COMMUNICATION_QUERY,
  ConversationDirectoryApplicationService,
  PROGRAM_SINGLE_FRAME_MAX_BYTES,
  createConversationCommunicationProductApiContribution,
  isExtendedConversationDiscoverRequest,
  programConversationTurnId,
} from "@zhixing-ai/core/conversation/application";
import { ProductApiDispatcher } from "@zhixing-ai/core/product-api";
import { WORKSCENE_MANAGEMENT_LIST_QUERY } from "@zhixing-ai/core/workscene/application";
import { ConfirmationHub } from "@zhixing-ai/owner-kernel/confirmation-hub";
import { createConversationAgentTurnAdmissionPort } from "@zhixing-ai/owner-kernel/conversation-agent-turn-admission";
import { ConversationManager } from "@zhixing-ai/owner-kernel/conversation-manager";
import type { RuntimeFactory } from "@zhixing-ai/owner-kernel/types";
import { buildProgramConversationMethods } from "../../../../server/src/rpc/methods/program-conversation.js";
import { createTempDir } from "@zhixing-ai/test-utils";
import { createConversationStorageInfrastructure } from "../conversation-storage-infrastructure.js";
import {
  createConversationCommunicationBinding,
  discoverConversations,
} from "../conversation-communication-binding.js";
import { registerConversationCommunicationMesh } from "../conversation-communication-mesh.js";
import { DurableConversationInteractionObserver } from "../durable-conversation-interactions.js";
import { createHostProgramConversationApplication } from "../program-conversation-host.js";
import {
  MemorySecretStore,
  TEST_DURABLE_IO_TIMEOUT_MS,
  TEST_RUNTIME_AUTHORITY_FACTS,
  createProtocol,
  getOrCreateActiveConversation,
  setupAuthorityRuntime,
} from "./conversation-protocol-runtime-fixture.js";

describe("HostProgramConversationApplication & Unit 1 kernel closure", () => {
  it(
    "covers unified idempotent new, cross-target same --id, bidirectional Run isolation, ConfirmationHub non-interactive resolution, Advancement exclusion, and >1MiB read paging",
    async () => {
      const home = await createTempDir("program-host-unit1");
      const authority = await setupAuthorityRuntime({
        zhixingHome: home,
        secretStore: new MemorySecretStore(),
      });
      await authority.installPermissionSnapshot(
        createSignedTrustRuleSnapshot(
          { snapshotVersion: 1, rules: [], generatedAt: new Date().toISOString() },
          authority.signer,
        ),
      );

      const storageInfra = createConversationStorageInfrastructure({
        zhixingHome: home,
        optimalMaxTokens: 32_000,
        worksceneConversationStorageRemoval: {
          isRemoving: () => false,
        } as never,
      });
      const directory = storageInfra.directory;

      const scenes = new Map<
        string,
        { id: string; name: string; lastActiveAt: string; deleting?: boolean }
      >([
        [
          "scene-alpha",
          {
            id: "scene-alpha",
            name: "Alpha 工作场景",
            lastActiveAt: "2026-11-23T12:00:00.000Z",
          },
        ],
        [
          "scene-busy-del",
          {
            id: "scene-busy-del",
            name: "删除中场景",
            lastActiveAt: "2026-11-23T11:00:00.000Z",
            deleting: true,
          },
        ],
      ]);

      const hub = new ConfirmationHub();
      const hubNotifiedRequests: string[] = [];
      hub.onEvent((ev) => {
        if (ev.type === "request") {
          hubNotifiedRequests.push(`${ev.entry.conversationId ?? ""}:${ev.entry.request.id}`);
        }
      });
      const interactions = new DurableConversationInteractionObserver();
      const brokers = new Map<string, ConfirmationBroker>();
      const getBroker = (id: string) => {
        let b = brokers.get(id);
        if (!b) {
          b = new ConfirmationBroker({ lifecycleObserver: interactions });
          brokers.set(id, b);
        }
        return b;
      };

      let manager!: ConversationManager;
      let holdBusyRun: (() => void) | undefined;
      const busyRunStarted = new Promise<void>((resolve) => {
        holdBusyRun = resolve;
      });
      let releaseBusyRun!: () => void;
      const busyRunGate = new Promise<void>((resolve) => {
        releaseBusyRun = resolve;
      });

      let holdProgramRun: (() => void) | undefined;
      const programRunStarted = new Promise<void>((resolve) => {
        holdProgramRun = resolve;
      });
      let releaseProgramRun!: () => void;
      const programRunGate = new Promise<void>((resolve) => {
        releaseProgramRun = resolve;
      });

      let notifyExtBeforeAdvStarted: (() => void) | undefined;
      const extBeforeAdvStarted = new Promise<void>((resolve) => {
        notifyExtBeforeAdvStarted = resolve;
      });
      let releaseAdvProg!: () => void;
      const advProgGate = new Promise<void>((resolve) => {
        releaseAdvProg = resolve;
      });

      const observedTurnContexts: Array<{
        conversationId: string;
        prompt: string;
        channel?: string;
        controls?: readonly string[];
      }> = [];

      const runtimeFactory: RuntimeFactory = {
        create: async (id) => {
          const broker = getBroker(id);
          return {
            ...TEST_RUNTIME_AUTHORITY_FACTS,
            sessionId: id,
            confirmationBroker: broker,
            async *run(messages, options): AsyncGenerator<AgentYield, RunResult> {
              const lastUser = messages.at(-1)!;
              const prompt = extractText(lastUser);
              observedTurnContexts.push({
                conversationId: id,
                prompt,
                channel: options?.turnContext?.turnOrigin?.channel,
                controls: options?.turnContext?.turnOrigin?.enabledControls,
              });

              const captured: Message[] = [];
              if (prompt === "HOLD_R0") {
                holdBusyRun?.();
                await busyRunGate;
              } else if (prompt === "EXT_BEFORE_ADV") {
                notifyExtBeforeAdvStarted?.();
                await advProgGate;
              } else if (prompt === "HOLD_PROGRAM_P") {
                holdProgramRun?.();
                await programRunGate;
                // Drain inputPort at turn boundary: internal conversation.send MUST NOT have appended into P!
                const appended =
                  (await options?.inputPort?.receive({ boundary: 1, closing: false })) ?? [];
                expect(appended).toEqual([]);
              } else if (prompt === "TRIGGER_TOOL_CONFIRM") {
                const outcome = await broker.requestConfirmation(
                  buildConfirmationRequest({
                    toolName: "bash",
                    input: { command: "echo controlled" },
                    result: { action: "needs-confirm", reason: "controlled" } as never,
                    workingDirectory: home,
                    sessionType: "ci",
                    contextId: { kind: "main" },
                  }),
                );
                const reply = assistantMessage(`confirm:${outcome.kind}`);
                captured.push(reply);
                yield { type: "text_delta", text: extractText(reply) };
                return {
                  agentResult: {
                    reason: "completed",
                    message: reply,
                    usage: { inputTokens: 1, outputTokens: 1 },
                  },
                  runRecord: {
                    timestamp: new Date().toISOString(),
                    messages: [lastUser, ...captured],
                    usage: { inputTokens: 1, outputTokens: 1 },
                  },
                  newMessages: captured,
                  durationMs: 1,
                };
              } else if (prompt === "GIANT_HISTORY") {
                const giantReply = assistantMessage("中".repeat(420_000));
                captured.push(giantReply);
                yield { type: "text_delta", text: "giant" };
                return {
                  agentResult: {
                    reason: "completed",
                    message: giantReply,
                    usage: { inputTokens: 1, outputTokens: 1 },
                  },
                  runRecord: {
                    timestamp: new Date().toISOString(),
                    messages: [lastUser, ...captured],
                    usage: { inputTokens: 1, outputTokens: 1 },
                  },
                  newMessages: captured,
                  durationMs: 1,
                };
              }

              const reply = assistantMessage(`echo:${prompt}`);
              captured.push(reply);
              yield { type: "text_delta", text: `echo:${prompt}` };
              return {
                agentResult: {
                  reason: "completed",
                  message: reply,
                  usage: { inputTokens: 1, outputTokens: 1 },
                },
                runRecord: {
                  timestamp: new Date().toISOString(),
                  messages: [lastUser, ...captured],
                  usage: { inputTokens: 1, outputTokens: 1 },
                },
                newMessages: captured,
                durationMs: 1,
              };
            },
            abort: () => false,
            dispose: async () => {},
          };
        },
      };

      const reviewedRuns: number[] = [];

      const protocol = createProtocol({
        authority,
        manager: () => manager,
        interactions,
      });

      const advancementStore = new SessionAdvancementStore({
        port: protocol.sessionState,
      });

      const acceptedTurns = new AdvancementAcceptedTurnApplicationService({
        catchUp: {
          catchUpAcceptedTurn: async () => ({
            status: "no-pending-recovery" as const,
          }),
        },
        review: {
          reviewAcceptedRun: async (input) => {
            reviewedRuns.push(input.runIndex);
            return { kind: "skipped" as const, reason: "no-active-session" as const };
          },
        },
        results: {
          projectReviewResult: async () => undefined,
        },
        isProgramOriginRun: (id, runId) => protocol.isProgramOriginRun(id, runId),
      });

      manager = new ConversationManager(runtimeFactory, undefined, {
        durableTurnExecutor: protocol,
        confirmationHub: hub,
        appendCommittedRun: async (id, record) => {
          await directory.ensure(id);
          await directory.touch(id);
          return { runIndex: record.runIndex, shardId: "owner-log", appended: true };
        },
        onTurnCommitted: ({ conversationId, turnId, runRecord, ephemeral }) => {
          acceptedTurns.acceptCommittedTurn({
            conversationId,
            turnId,
            runIndex: runRecord.runIndex,
            runRecord,
            ephemeral,
          });
        },
      });

      const workscenes = {
        query: async (op: unknown) => {
          expect(op).toBe(WORKSCENE_MANAGEMENT_LIST_QUERY);
          return {
            scenes: [...scenes.values()].map((s) => ({
              sceneId: s.id,
              revision: 1,
              name: s.name,
              lastActiveAt: s.lastActiveAt,
            })),
          };
        },
      } as never;

      let admissionGen = 0;
      const hostProgram = createHostProgramConversationApplication({
        anchor: {
          directory,
          manager,
          protocol,
          workscenes,
          onAdmissionActivity: () => {
            admissionGen += 1;
          },
        },
      });

      try {
        // 1. Unified idempotent `new`: concurrent distinct keys on scene-alpha converge (one true, one false)
        const [c1, c2] = await Promise.all([
          hostProgram.create({ requestId: "init-1", sceneId: "scene-alpha" }),
          hostProgram.create({ requestId: "init-2", sceneId: "scene-alpha" }),
        ]);
        expect(c1.conversationId).toBe("ws:scene-alpha:primary");
        expect(c2.conversationId).toBe("ws:scene-alpha:primary");
        expect([c1.created, c2.created].sort()).toEqual([false, true]);
        // Same requestId replay preserves original `created` boolean; different intent throws idempotency_conflict
        expect(
          await hostProgram.create({ requestId: "init-1", sceneId: "scene-alpha" }),
        ).toEqual(c1);
        await expect(
          hostProgram.create({ requestId: "init-1", name: "Changed" }),
        ).rejects.toMatchObject({ code: "idempotency_conflict" });

        // Internal principal `conversation:source-a` using the SAME requestId `init-1` does NOT collide with external `program:local`!
        const internalCreated = await hostProgram.createForPrincipal(
          "conversation:source-a",
          { requestId: "init-1", name: "内部新建对话" },
        );
        expect(internalCreated.created).toBe(true);
        expect(internalCreated.scope).toBe("main");

        // Deleting scene fence (`quiescePrefix`) returns temporarily_unavailable (exitCode 3)
        const releaseBusyFence = await manager.quiescePrefix("ws:scene-busy-del:");
        try {
          await expect(
            hostProgram.create({ requestId: "del-fence", sceneId: "scene-busy-del" }),
          ).rejects.toMatchObject({
            code: "temporarily_unavailable",
            options: { exitCode: 3 },
          });
        } finally {
          releaseBusyFence();
        }

        // 2. Cross-target same `--id 1` isolation & replay vs conflict
        const mainConv = await hostProgram.create({
          requestId: "mk-main",
          name: "主对话M",
        });
        const sendM1 = await hostProgram.send({
          conversationId: mainConv.conversationId,
          requestId: "1",
          text: "问题M",
        });
        const sendB1 = await hostProgram.send({
          conversationId: "ws:scene-alpha:primary",
          requestId: "1",
          text: "问题B",
        });
        expect(sendM1.admitted).toBe(true);
        expect(sendB1.admitted).toBe(true);
        if (sendM1.admitted && sendB1.admitted) {
          expect(sendM1.runId).not.toBe(sendB1.runId);
          // Same --id 1 + same text -> replayed: true with exact same runId
          const replayM1 = await hostProgram.send({
            conversationId: mainConv.conversationId,
            requestId: "1",
            text: "问题M",
          });
          expect(replayM1).toEqual({ ...sendM1, replayed: true });
        }
        // Same --id 1 + modified text -> idempotency_conflict (admitted: false)
        const conflictM1 = await hostProgram.send({
          conversationId: mainConv.conversationId,
          requestId: "1",
          text: "篡改后的问题M",
        });
        expect(conflictM1).toMatchObject({
          admitted: false,
          error: { code: "idempotency_conflict" },
        });
        expect(admissionGen).toBeGreaterThanOrEqual(2);

        const resM1 = await hostProgram.result({
          conversationId: mainConv.conversationId,
          requestId: "1",
          waitMs: 10_000,
        });
        const resB1 = await hostProgram.result({
          conversationId: "ws:scene-alpha:primary",
          requestId: "1",
          waitMs: 10_000,
        });
        expect(resM1).toMatchObject({ state: "completed", answer: "echo:问题M" });
        expect(resB1).toMatchObject({ state: "completed", answer: "echo:问题B" });

        // Verify executionTurnContext stripped propose_advancement on program-origin runs
        const mCtx = observedTurnContexts.find((c) => c.prompt === "问题M");
        expect(mCtx?.channel).toBe("program");
        expect(mCtx?.controls ?? []).not.toContain("propose_advancement");

        // 3. Bidirectional busy Run isolation:
        // (a) External send while R0 is running queues as independent Run (does not interrupt R0)
        const convIso = (
          await hostProgram.create({ requestId: "mk-iso", name: "隔离测试" })
        ).conversationId;
        await getOrCreateActiveConversation(authority, manager, convIso);
        const convApp = new ConversationDirectoryApplicationService({
          storage: {
            list: () => directory.list(),
            create: async () => {
              const id = await directory.create();
              return {
                conversationId: id,
                name: id,
                createdAt: new Date().toISOString(),
                lastActiveAt: new Date().toISOString(),
              };
            },
            rename: () => Promise.resolve(null),
            readHistory: async (id, req) => {
              const page = await protocol.sessionState.readTranscriptTail(
                id,
                {
                  principal: { kind: "host", component: "test" },
                  requestId: "h",
                  deadlineAt: new Date(Date.now() + 60_000).toISOString(),
                },
                req.before,
                req.limit,
              );
              return {
                runs: [...page.records]
                  .reverse()
                  .map((record) => ({ record, shardId: "owner-log" })),
                hasMore: !!page.next,
              };
            },
          },
          runtime: {
            read: (id) => ({
              active: manager.has(id),
              busy: manager.getSession(id)?.busy ?? false,
              observerCount: 0,
              pendingCount: manager.pendingCount(id),
            }),
          },
          agentTurns: createConversationAgentTurnAdmissionPort({ manager }),
          agentTurnIdentity: directory,
        });
        const commBinding = createConversationCommunicationBinding({
          directory: convApp,
          manager,
          messages: {
            inspect: (id, mid) => protocol.inspectMessage(id, mid),
            inputsOutsideHistory: (id) => protocol.messageInputsOutsideHistory(id),
          },
        });

        await commBinding.invoke("peer-d", {
          action: "send",
          conversationId: convIso,
          operationId: "start-r0",
          input: "HOLD_R0",
        });
        await busyRunStarted;

        const extDuringR0 = await hostProgram.send({
          conversationId: convIso,
          requestId: "ext-p",
          text: "HOLD_PROGRAM_P",
        });
        expect(extDuringR0.admitted).toBe(true);
        const pendingCheck = await hostProgram.result({
          conversationId: convIso,
          requestId: "ext-p",
          waitMs: 50,
        });
        expect(pendingCheck.state).toBe("pending");

        releaseBusyRun();
        await programRunStarted;

        // (b) Reverse direction: while external Run P is actively running, internal `conversation.send` from D arrives!
        // It MUST NOT append into P; it must queue as the NEXT independent Run!
        const internalDuringP = (await commBinding.invoke("peer-d", {
          action: "send",
          conversationId: convIso,
          operationId: "during-p",
          input: "内部插话D",
        })) as { runId: string };
        if (extDuringR0.admitted) {
          expect(internalDuringP.runId).not.toBe(extDuringR0.runId);
        }

        releaseProgramRun();
        const extPResult = await hostProgram.result({
          conversationId: convIso,
          requestId: "ext-p",
          waitMs: 10_000,
        });
        expect(extPResult).toMatchObject({
          state: "completed",
          answer: "echo:HOLD_PROGRAM_P",
        });

        // 4. ConfirmationHub active + foreground F waiting for human confirmation:
        const fgConv = (
          await hostProgram.create({ requestId: "mk-fg", name: "前台F" })
        ).conversationId;
        await getOrCreateActiveConversation(authority, manager, fgConv);
        const fgBroker = getBroker(fgConv);
        await commBinding.invoke("peer-d", {
          action: "send",
          conversationId: fgConv,
          operationId: "fg-human-confirm",
          input: "TRIGGER_TOOL_CONFIRM",
        });
        await vi.waitFor(
          () => expect(fgBroker.listPending()).toHaveLength(1),
          { timeout: 10_000 },
        );
        expect(
          hubNotifiedRequests.some((entry) => entry.startsWith(`${fgConv}:`)),
        ).toBe(true);

        const confirmTarget = mainConv.conversationId;
        await hostProgram.send({
          conversationId: confirmTarget,
          requestId: "confirm-prog",
          text: "TRIGGER_TOOL_CONFIRM",
        });
        const confirmRes = await hostProgram.result({
          conversationId: confirmTarget,
          requestId: "confirm-prog",
          waitMs: 10_000,
        });
        expect(confirmRes).toMatchObject({
          state: "completed",
          answer: "confirm:deny",
        });
        // Foreground F's human confirmation is still intact and confirmTarget never notified ConfirmationHub!
        expect(fgBroker.listPending()).toHaveLength(1);
        expect(
          hubNotifiedRequests.some((entry) => entry.startsWith(`${confirmTarget}:`)),
        ).toBe(false);
        fgBroker.cancelAll("aborted");

        // 5. Advancement full lifecycle isolation:
        // (a) External send admitted BEFORE human activates advancement -> external commits AFTER activation -> zero review/round consumption!
        const advConv = (
          await hostProgram.create({ requestId: "mk-adv", name: "推进隔离" })
        ).conversationId;
        await getOrCreateActiveConversation(authority, manager, advConv);

        const preAdvSend = await hostProgram.send({
          conversationId: advConv,
          requestId: "pre-adv",
          text: "EXT_BEFORE_ADV",
        });
        expect(preAdvSend.admitted).toBe(true);
        await extBeforeAdvStarted;

        // Activate an open advancement session on advConv in durable SessionAdvancementStore
        const nowIso = new Date().toISOString();
        const originalUserTask = {
          parts: [{ type: "text" as const, text: "把测试修到全绿" }],
        };
        await advancementStore.createSession({
          id: "adv-session-1",
          conversationId: advConv,
          originalUserTask,
          pendingRubricDraft: {
            draftId: "draft-1",
            originalTurnId: "orig-turn",
            source: "generated",
            candidateRubricIds: [],
            title: "测试准则",
            description: "测试描述",
            content: {
              passCriteria: ["通过测试"],
              evidenceRequirements: [],
              failureHandling: [{ id: "fh-1", scenario: "失败", reply: "继续" }],
            },
            createdAt: nowIso,
          },
          createdAt: nowIso,
        });

        // New external send while advancement is open MUST be rejected with needs_attention (admitted: false)
        const blockedByAdv = await hostProgram.send({
          conversationId: advConv,
          requestId: "during-adv",
          text: "推进期新外部请求",
        });
        expect(blockedByAdv).toMatchObject({
          admitted: false,
          error: { code: "needs_attention" },
        });

        // Confirm rubric to `active` state so acceptedTurns would review normal runs
        await advancementStore.confirmRubric(
          advConv,
          "adv-session-1",
          {
            source: { kind: "library", rubricId: "rubric-1", rubricVersion: "v1" },
            title: "测试准则",
            description: "测试描述",
            content: {
              passCriteria: [{ id: "pc-1", text: "通过测试" }],
              evidenceRequirements: [],
              failureHandling: [{ id: "fh-1", scenario: "失败", reply: "继续" }],
            },
            confirmedAt: nowIso,
            confirmedBy: "user",
          },
          {
            turnId: advancementExecutionTurnId("orig-turn", "advancement", "draft-1"),
            surfacePrincipal: "surface:user-1",
            turnOrigin: { channel: "rpc", triggeredBy: "surface:user-1" },
            inputDigest: protocolDigest(
              "AdvancementOriginalTaskInput",
              1,
              originalUserTask,
            ),
          },
          nowIso,
        );

        // Release pre-admitted external run: it finishes & returns answer, with ZERO advancement review!
        reviewedRuns.length = 0;
        releaseAdvProg();
        const preAdvRes = await hostProgram.result({
          conversationId: advConv,
          requestId: "pre-adv",
          waitMs: 10_000,
        });
        expect(preAdvRes).toMatchObject({
          state: "completed",
          answer: "echo:EXT_BEFORE_ADV",
        });
        await new Promise((r) => setTimeout(r, 80));
        expect(reviewedRuns).toEqual([]);

        // Now run a normal non-program turn on advConv and verify it IS reviewed by Advancement!
        await commBinding.invoke("peer-d", {
          action: "send",
          conversationId: advConv,
          operationId: "real-adv-turn",
          input: "正常推进轮次",
        });
        await vi.waitFor(
          () => expect(reviewedRuns.length).toBeGreaterThan(0),
          { timeout: 10_000 },
        );

        // Verify `list` exposes `advancementStatus: "active"` while open
        const listDuringAdv = await hostProgram.list({ query: advConv });
        const advEntry = listDuringAdv.entries.find(
          (e) => e.entryKind === "conversation" && e.conversationId === advConv,
        );
        expect(advEntry).toMatchObject({
          entryKind: "conversation",
          advancementStatus: "active",
        });

        // Cancel advancement cleanly
        await advancementStore.cancelSession(
          advConv,
          "adv-session-1",
          {
            reason: "user-cancelled",
            message: "测试取消推进",
            occurredAt: nowIso,
          },
          nowIso,
        );

        // 6. Single-run > 1 MiB Chinese JSON message read pagination within < 1 MiB frame budget
        await hostProgram.send({
          conversationId: mainConv.conversationId,
          requestId: "giant",
          text: "GIANT_HISTORY",
        });
        const giantRes = await hostProgram.result({
          conversationId: mainConv.conversationId,
          requestId: "giant",
          waitMs: 15_000,
        });
        expect(giantRes.state).toBe("completed");
        expect(giantRes.answerTruncated).toBe(true);
        expect(giantRes.nextCursor).toBeDefined();

        let readCursor: string | undefined;
        let readPages = 0;
        let totalGiantChars = 0;
        do {
          const readPage = await hostProgram.read({
            conversationId: mainConv.conversationId,
            limit: 1,
            ...(readCursor ? { before: readCursor } : {}),
          });
          const frameBytes = Buffer.byteLength(JSON.stringify(readPage), "utf8");
          expect(frameBytes).toBeLessThan(PROGRAM_SINGLE_FRAME_MAX_BYTES);
          for (const e of readPage.entries) {
            if (e.role === "assistant" && e.runId === giantRes.runId) {
              totalGiantChars += e.text.length;
            }
          }
          readPages += 1;
          const reachedEarlierRun = readPage.entries.some(
            (e) => e.runId !== giantRes.runId,
          );
          readCursor =
            !reachedEarlierRun && readPage.hasMore ? readPage.nextBefore : undefined;
        } while (readCursor);
        expect(readPages).toBeGreaterThan(1);
        expect(totalGiantChars).toBe(420_000);

        // 7. Loopback RPC enforcement + internal ProductApi QUERY rejecting `new` + legacy Mesh inbound rejecting extended discover & `new`
        const rpcMethods = buildProgramConversationMethods();
        const rpcList = rpcMethods.find((m) => m.name === "conversation.program.list")!;
        await expect(
          rpcList.handler(
            {},
            {
              connection: { loopback: false } as never,
              server: { programConversation: hostProgram } as never,
            },
          ),
        ).rejects.toMatchObject({
          data: { programError: { code: "unauthorized", exitCode: 1 } },
        });

        const dispatcher = new ProductApiDispatcher(
          CONVERSATION_COMMUNICATION_PRODUCT_API_EXACT_SET,
          [
            createConversationCommunicationProductApiContribution(async (source, req) => {
              if (req.action === "new") {
                return hostProgram.createForPrincipal(`conversation:${source}`, {
                  requestId: req.operationId,
                  name: req.name,
                  sceneId: req.sceneId,
                });
              }
              if (isExtendedConversationDiscoverRequest(req)) {
                return hostProgram.discoverInternal(req);
              }
              return discoverConversations([commBinding], source);
            }),
          ],
        );

        // Read-only CONVERSATION_COMMUNICATION_QUERY rejects `new`
        await expect(
          dispatcher.query(CONVERSATION_COMMUNICATION_QUERY, {
            sourceConversationId: "peer-a",
            request: { action: "new", operationId: "op-1", name: "illegal" },
          }),
        ).rejects.toThrow();

        // Write command CONVERSATION_COMMUNICATION_NEW succeeds
        const viaNewCmd = await dispatcher.command(CONVERSATION_COMMUNICATION_NEW, {
          sourceConversationId: "peer-a",
          request: { action: "new", operationId: "op-2", name: "合法新建" },
        });
        expect(viaNewCmd.result).toMatchObject({ created: true, scope: "main" });

        // Legacy Mesh inbound service rejects `new` and parameterized `discover` with zero writes
        let meshHandler!: (payload: Uint8Array, conn: unknown) => Promise<Uint8Array>;
        registerConversationCommunicationMesh({
          registry: {
            register: (_name: string, def: { handler: typeof meshHandler }) => {
              meshHandler = def.handler;
            },
          } as never,
          authorizePeer: () => true,
          communication: commBinding,
        });
        const meshNewBuf = await meshHandler(
          Buffer.from(
            JSON.stringify({
              v: 1,
              kind: "communication",
              sourceConversationId: "peer-a",
              request: { action: "new", operationId: "op-mesh", name: "nope" },
            }),
          ),
          { peer: { deviceId: "peer-dev" } },
        );
        expect(JSON.parse(Buffer.from(meshNewBuf).toString("utf8"))).toMatchObject({
          v: 1,
          ok: false,
        });
        const meshExtDiscoverBuf = await meshHandler(
          Buffer.from(
            JSON.stringify({
              v: 1,
              kind: "communication",
              sourceConversationId: "peer-a",
              request: { action: "discover", scope: "all", limit: 5 },
            }),
          ),
          { peer: { deviceId: "peer-dev" } },
        );
        expect(
          JSON.parse(Buffer.from(meshExtDiscoverBuf).toString("utf8")),
        ).toMatchObject({
          v: 1,
          ok: false,
        });
        const legacyDiscoverBuf = await meshHandler(
          Buffer.from(
            JSON.stringify({
              v: 1,
              kind: "communication",
              sourceConversationId: "peer-a",
              request: { action: "discover" },
            }),
          ),
          { peer: { deviceId: "peer-dev" } },
        );
        expect(JSON.parse(Buffer.from(legacyDiscoverBuf).toString("utf8"))).toMatchObject({
          v: 1,
          ok: true,
        });

        // 8. Workscene quiescePrefix fence + paired remote/same-prefix local-* transitional safety
        const releaseQuiesce = await manager.quiescePrefix("ws:scene-alpha:");
        try {
          await expect(
            hostProgram.create({ requestId: "quiesced-ws", sceneId: "scene-alpha" }),
          ).rejects.toMatchObject({
            code: "temporarily_unavailable",
            options: { exitCode: 3 },
          });
        } finally {
          releaseQuiesce();
        }

        const remoteDevId = "abababab-1111-4111-8111-222222222222";
        const remoteLocalConvId = localConversationId(
          remoteDevId,
          "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        );
        const meshHostProgram = createHostProgramConversationApplication({
          anchor: {
            protocol,
            manager,
            directory,
            workscenes,
          },
          topology: {
            deviceId: protocol.deviceId,
            currentTrust: () => ({
              members: [
                {
                  state: "active",
                  roles: ["anchor", "executor"],
                  device: { deviceId: protocol.deviceId },
                },
                {
                  state: "active",
                  roles: ["executor"],
                  device: { deviceId: remoteDevId },
                },
              ],
            }),
          },
        });
        const meshList = await meshHostProgram.list({ scope: "local" });
        expect(meshList.partial).toBe(true);
        expect(meshList.unreachableDevices).toContain(remoteDevId);
        await expect(
          meshHostProgram.send({
            conversationId: remoteLocalConvId,
            requestId: "rem-send",
            text: "hi",
          }),
        ).rejects.toMatchObject({
          code: "temporarily_unavailable",
          options: { exitCode: 3 },
        });
        await expect(
          meshHostProgram.read({ conversationId: remoteLocalConvId }),
        ).rejects.toMatchObject({
          code: "temporarily_unavailable",
          options: { exitCode: 3 },
        });
        const remRes = await meshHostProgram.result({
          conversationId: remoteLocalConvId,
          requestId: "rem-send",
        });
        expect(remRes).toMatchObject({
          state: "temporarily_unavailable",
        });

        // 9. F1: Namespace-colliding main titles (`local-*`, `ws:*`, `*:dm:*`), old corrupted receipt fail-closed, and interrupted/quiesced replay materialization
        const trickyTitle = "local-abcdefgh-00000000000000000000000001";
        const trickyCreated = await hostProgram.create({
          requestId: "req-tricky-local-title",
          name: trickyTitle,
        });
        expect(trickyCreated.scope).toBe("main");
        expect(trickyCreated.created).toBe(true);
        expect(isLocalConversationId(trickyCreated.conversationId)).toBe(false);
        const trickyRead = await hostProgram.read({
          conversationId: trickyCreated.conversationId,
        });
        expect(trickyRead.entries).toEqual([]);
        const trickyListed = await hostProgram.list({ query: "local-abcdefgh" });
        expect(
          trickyListed.entries.some(
            (e) =>
              e.entryKind === "conversation" &&
              e.conversationId === trickyCreated.conversationId &&
              e.name === trickyTitle,
          ),
        ).toBe(true);

        // Old corrupted receipt that bound `local-abcdefgh-...` to a main `session-create` fails closed (exit 1, zero directory writes)
        const badReqId = "legacy-bad-main-receipt";
        const badCanonicalReqId = `program-create:${protocolDigest(
          "ProgramConversationCreate",
          1,
          { creatorPrincipal: "program:local", requestId: badReqId },
        )}`;
        const badSource = {
          principal: {
            surfacePrincipal: "program:local",
            deviceId: protocol.deviceId,
            connectionId: "program:local",
          },
        };
        await protocol.controlAdmission.apply({
          envelope: createInitialControlEnvelope({
            requestId: badCanonicalReqId,
            source: badSource,
            at: new Date().toISOString(),
            body: { t: "session-create", requestedName: trickyTitle },
          }),
          source: badSource,
          prepare: () => ({
            result: {
              v: 1,
              status: "ok",
              body: { t: "session-create", conversationId: trickyTitle },
            },
            authorityRevision: 1,
          }),
        });
        await expect(
          hostProgram.create({ requestId: badReqId, name: trickyTitle }),
        ).rejects.toMatchObject({
          code: "invalid_params",
          options: { exitCode: 1 },
        });
        expect(await directory.getStoredConversation(trickyTitle)).toBeNull();

        // Workscene `new` interrupted after controlAdmission.apply before touch/ensure + replay during quiesce vs after quiesce
        scenes.set("scene-replay", {
          id: "scene-replay",
          name: "重放场景",
          lastActiveAt: "2026-11-23T09:00:00.000Z",
        });
        let failTouchOnce = true;
        let touchCalls = 0;
        let ensureCalls = 0;
        const faultProtocol = new Proxy(protocol, {
          get(target, prop) {
            if (prop === "touchWorksceneSession") {
              return async (arg: Parameters<typeof protocol.touchWorksceneSession>[0]) => {
                if (failTouchOnce) {
                  failTouchOnce = false;
                  throw new Error("simulated crash before touchWorksceneSession");
                }
                touchCalls += 1;
                return target.touchWorksceneSession(arg);
              };
            }
            const v = Reflect.get(target, prop, target);
            return typeof v === "function" ? v.bind(target) : v;
          },
        });
        const faultDirectory = new Proxy(directory, {
          get(target, prop) {
            if (prop === "ensure") {
              return async (
                ...args: Parameters<typeof directory.ensure>
              ) => {
                ensureCalls += 1;
                return target.ensure(...args);
              };
            }
            const v = Reflect.get(target, prop, target);
            return typeof v === "function" ? v.bind(target) : v;
          },
        });
        const faultHostProgram = createHostProgramConversationApplication({
          anchor: {
            protocol: faultProtocol,
            manager,
            directory: faultDirectory,
            workscenes,
          },
        });
        await expect(
          faultHostProgram.create({
            requestId: "req-ws-interrupted",
            sceneId: "scene-replay",
          }),
        ).rejects.toThrow("simulated crash before touchWorksceneSession");
        expect(touchCalls).toBe(0);
        expect(ensureCalls).toBe(0);

        const releaseReplayQuiesce = await manager.quiescePrefix("ws:scene-replay:");
        try {
          await expect(
            faultHostProgram.create({
              requestId: "req-ws-interrupted",
              sceneId: "scene-replay",
            }),
          ).rejects.toMatchObject({
            code: "temporarily_unavailable",
            options: { exitCode: 3 },
          });
          expect(touchCalls).toBe(0);
          expect(ensureCalls).toBe(0);
        } finally {
          releaseReplayQuiesce();
        }

        const recoveredWs = await faultHostProgram.create({
          requestId: "req-ws-interrupted",
          sceneId: "scene-replay",
        });
        expect(recoveredWs).toEqual({
          v: 1,
          conversationId: "ws:scene-replay:primary",
          scope: "workscene",
          sceneId: "scene-replay",
          created: true,
        });
        expect(touchCalls).toBe(1);
        expect(ensureCalls).toBe(1);

        // 10. F2: Query failures on `read` / `exists` & `missing | unknown` on `result` run-outcomes
        const brokenReadHost = createHostProgramConversationApplication({
          anchor: {
            protocol: new Proxy(protocol, {
              get(target, prop, receiver) {
                if (prop === "recoveryPage") {
                  return async (
                    req: Parameters<typeof protocol.recoveryPage>[0],
                  ) => {
                    if (req.mode === "body-page") {
                      throw new Error("disk read failure");
                    }
                    if (req.mode === "run-outcomes") {
                      const rid = req.runIds[0]!;
                      return {
                        entries: [
                          {
                            runId: rid,
                            state: rid.includes("missing") ? "missing" : "unknown",
                          },
                        ],
                      };
                    }
                    return target.recoveryPage(req);
                  };
                }
                if (prop === "inspectProgramInputReceipt") {
                  return async (
                    _cid: string,
                    q: { readonly physicalTurnId: string },
                  ) => ({
                    status: "accepted" as const,
                    runId: q.physicalTurnId.slice(0, 12).includes("a")
                      ? "run-missing-1"
                      : "run-unknown-1",
                    deleted: false,
                    clearCovered: false,
                  });
                }
                const v = Reflect.get(target, prop, target);
                return typeof v === "function" ? v.bind(target) : v;
              },
            }),
            manager,
            directory,
            workscenes,
          },
        });
        await expect(
          brokenReadHost.read({ conversationId: trickyCreated.conversationId }),
        ).rejects.toMatchObject({
          code: "temporarily_unavailable",
          options: { exitCode: 3 },
        });
        for (const probeReq of ["probe-a-1", "probe-b-2"]) {
          const out = await brokenReadHost.result({
            conversationId: trickyCreated.conversationId,
            requestId: probeReq,
          });
          expect(out.state).toBe("unknown");
          expect(out.error?.code).toBe("unknown");
          expect(out.error?.retryable).toBe(true);
        }

        // 11. F3: Local-owner serial `beforeDurableAdmit` rechecks open Advancement (and allows same-key replay)
        const localRaceId = localConversationId(
          protocol.deviceId,
          "01ARZ3NDEKTSV4RRFFQ69G5FB0",
        );
        let localAdvOpen = false;
        let durableAdmitCount = 0;
        let acceptedReplayRunId: string | undefined;
        const localRaceManager = {
          usesDurableTurnProtocol: () => true,
          inputReceipt: async () => ({ status: "unknown" as const }),
          admitTurn: async (opts: {
            conversationId?: string;
            beforeEnqueue?: (managed: { conversationId: string }) => Promise<
              { shouldEnqueue: boolean; runId?: string } | undefined
            >;
            makeTask: (managed: { conversationId: string }) => {
              execute: () => Promise<void>;
            };
          }) => {
            // Simulate human opening Advancement AFTER outer precheck, BEFORE serial queue critical section!
            localAdvOpen = true;
            const res = await opts.beforeEnqueue?.({
              conversationId: opts.conversationId!,
            });
            if (res && res.shouldEnqueue === false) {
              return {
                status: "replayed" as const,
                conversationId: opts.conversationId!,
                runId: res.runId,
              };
            }
            return {
              status: "queued" as const,
              conversationId: opts.conversationId!,
              runId: res?.runId ?? "unexpected-run",
            };
          },
          admitDurableTurn: async () => {
            durableAdmitCount += 1;
            return { shouldEnqueue: true, runId: "should-never-admit" };
          },
        } as unknown as ConversationManager;
        const localAdmissionPort = createConversationAgentTurnAdmissionPort({
          manager: localRaceManager,
        });
        const localRaceHost = createHostProgramConversationApplication({
          anchor: { protocol, manager, directory, workscenes },
          localExecutor: {
            owner: {
              agentTurnAdmission: localAdmissionPort,
              conversationAdoptionStatus: async () => ({
                unavailableTransfer: false,
                adopted: false,
                created: true,
                deleted: false,
                hasDurableIdentity: true,
              }),
              currentAuthority: async () => ({
                state: "current" as const,
                ownerEpoch: 1,
              }),
              inspectProgramInputReceipt: async () =>
                acceptedReplayRunId
                  ? {
                      status: "accepted" as const,
                      runId: acceptedReplayRunId,
                      deleted: false,
                      clearCovered: false,
                    }
                  : {
                      status: "unknown" as const,
                      deleted: false,
                      clearCovered: false,
                    },
              hasOpenAdvancementSession: async () => localAdvOpen,
              isShuttingDown: () => false,
              createAgentTurnExecution: () => ({
                execution: {
                  execute: async () => {},
                  cancelPending: () => {},
                },
                outcome: Promise.resolve(),
              }),
            } as never,
          },
        });
        const raceDenied = await localRaceHost.send({
          conversationId: localRaceId,
          requestId: "local-adv-race-new",
          text: "race message",
        });
        expect(raceDenied).toMatchObject({
          admitted: false,
          error: { code: "needs_attention" },
        });
        expect(durableAdmitCount).toBe(0);

        // Same-key replay on local owner STILL succeeds even when Advancement is open
        acceptedReplayRunId = "run-local-prior";
        const raceReplayed = await localRaceHost.send({
          conversationId: localRaceId,
          requestId: "local-adv-race-replay",
          text: "race message",
        });
        expect(raceReplayed).toEqual({
          v: 1,
          admitted: true,
          conversationId: localRaceId,
          requestId: "local-adv-race-replay",
          runId: "run-local-prior",
          replayed: true,
        });

        // 12. F4: Legacy/internal Mesh inbound work arriving mid-idle-sample invalidates the idle exit gate
        let activityGen = 10;
        let stopRequested = 0;
        let releaseLocalIdleQuery: (() => void) | undefined;
        let pauseOnSecondTick = false;
        const idleCheck = createAnchorHostIdleCheck({
          activityGeneration: () => activityGen,
          connectionCount: () => 0,
          channelStates: () => [],
          enabledUserTaskCount: () => 0,
          hasAnchorActiveWork: () => false,
          pendingAnchorClosureWork: async () => ({
            continuableAdmittedRuns: 0,
            pendingFinals: 0,
            pendingAssignments: 0,
            recoveryBacklog: 0,
            activeLocalLeases: 0,
          }),
          hasLocalExecutorBlockingWork: async () => {
            if (pauseOnSecondTick) {
              await new Promise<void>((r) => {
                releaseLocalIdleQuery = r;
              });
            }
            return false;
          },
          requestStop: async () => {
            stopRequested += 1;
          },
        });
        // Tick 1: first idle observation at generation 10
        await idleCheck();
        expect(stopRequested).toBe(0);
        // Tick 2: Anchor already observed idle, paused awaiting localExecutor; inbound legacy Mesh `send` bumps generation!
        pauseOnSecondTick = true;
        const tick2Promise = idleCheck();
        await new Promise((r) => setTimeout(r, 15));
        activityGen += 1; // Simulates wrapActivityCommunication / protocol.onStatus from legacy Mesh inbound send!
        pauseOnSecondTick = false;
        releaseLocalIdleQuery?.();
        await tick2Promise;
        expect(stopRequested).toBe(0);
        // Tick 3: work finished, first clean idle observation at generation 11 -> still does NOT exit yet!
        await idleCheck();
        expect(stopRequested).toBe(0);
        // Tick 4: second consecutive clean idle observation at generation 11 -> exits cleanly!
        await idleCheck();
        expect(stopRequested).toBe(1);

        // 13. R2-1: Durable-layer Advancement gate rejection preserves requestId without receipt consumption
        const gateIso = new Date().toISOString();
        await advancementStore.createSession({
          id: "adv-durable-gate-1",
          conversationId: advConv,
          originalUserTask,
          pendingRubricDraft: {
            draftId: "draft-gate-1",
            originalTurnId: "orig-turn-gate",
            source: "generated",
            candidateRubricIds: [],
            title: "耐久门禁测试准则",
            description: "验证耐久层拒绝不占用原请求号",
            content: {
              passCriteria: ["不污染原请求号"],
              evidenceRequirements: [],
              failureHandling: [{ id: "fh-1", scenario: "失败", reply: "重试" }],
            },
            createdAt: gateIso,
          },
          createdAt: gateIso,
        });
        // Bypass pre-check so the request reaches real `ConversationRunJournal.applyInputControl` while Advancement is open!
        const durableGateHost = createHostProgramConversationApplication({
          anchor: {
            protocol: new Proxy(protocol, {
              get(target, prop) {
                if (prop === "hasOpenAdvancementSession") {
                  return async () => false;
                }
                const v = Reflect.get(target, prop, target);
                return typeof v === "function" ? v.bind(target) : v;
              },
            }),
            manager,
            directory,
            workscenes,
          },
        });
        const gatePhysicalTurnId = programConversationTurnId(
          advConv,
          "durable-gate-repeat",
        );
        const durableRejected = await durableGateHost.send({
          conversationId: advConv,
          requestId: "durable-gate-repeat",
          text: "same content after gate",
        });
        expect(durableRejected).toMatchObject({
          v: 1,
          admitted: false,
          conversationId: advConv,
          requestId: "durable-gate-repeat",
          error: { code: "needs_attention", retryable: false },
        });
        expect(
          await authority.controlAdmission.inputReceipt({
            conversationId: advConv,
            turnId: gatePhysicalTurnId,
            surfacePrincipal: "program:local",
          }),
        ).toEqual({ status: "unknown" });
        expect(
          await protocol.inspectProgramInputReceipt(advConv, {
            physicalTurnId: gatePhysicalTurnId,
          }),
        ).toMatchObject({ status: "unknown" });

        // Close Advancement, then retry with the EXACT SAME requestId and SAME content -> admitted once!
        await advancementStore.cancelSession(
          advConv,
          "adv-durable-gate-1",
          {
            reason: "user-cancelled",
            message: "关闭推进后允许原号重试",
            occurredAt: gateIso,
          },
          gateIso,
        );
        const admittedAfterGate = await hostProgram.send({
          conversationId: advConv,
          requestId: "durable-gate-repeat",
          text: "same content after gate",
        });
        expect(admittedAfterGate.admitted).toBe(true);
        if (!admittedAfterGate.admitted) throw new Error("expected admitted");

        // Second replay with same requestId and same content returns the exact same runId
        const replayedAfterGate = await hostProgram.send({
          conversationId: advConv,
          requestId: "durable-gate-repeat",
          text: "same content after gate",
        });
        expect(replayedAfterGate).toEqual({
          v: 1,
          admitted: true,
          conversationId: advConv,
          requestId: "durable-gate-repeat",
          runId: admittedAfterGate.runId,
          replayed: true,
        });

        // Same requestId with different content after acceptance is deterministically rejected with idempotency_conflict
        const conflictAfterGate = await hostProgram.send({
          conversationId: advConv,
          requestId: "durable-gate-repeat",
          text: "different content",
        });
        expect(conflictAfterGate).toMatchObject({
          v: 1,
          admitted: false,
          conversationId: advConv,
          requestId: "durable-gate-repeat",
          error: { code: "idempotency_conflict", retryable: false },
        });
      } finally {
        releaseBusyRun();
        releaseProgramRun();
        releaseAdvProg();
        await protocol.stopRecoveryLoop();
        await manager.disposeAll();
        await authority.stopStorageMaintenance();
      }
    },
    TEST_DURABLE_IO_TIMEOUT_MS,
  );
});
