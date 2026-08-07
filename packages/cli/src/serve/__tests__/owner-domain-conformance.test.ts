import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import type { AdvancementControlEvent } from "@zhixing/core/advancement";
import { localConversationId } from "@zhixing/core";
import { ConversationManager } from "@zhixing/owner-kernel";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { setupAuthorityRuntime } from "../../setup-delivery.js";
import { localConversationOwnerRuntime } from "../conversation-owner-runtime.js";
import {
  ConversationProtocolRuntime,
  DurableConversationInteractionObserver,
} from "../conversation-protocol-runtime.js";
import { createLocalOwnerAssemblyFixture } from "./local-owner-assembly-fixture.js";

const READINESS = {
  tools: [] as string[],
  mcpServers: [] as string[],
  credentialBindings: [],
  deviceScopedCredentialBindingIds: [] as string[],
  credentialGeneration: null,
};

const CONFIGURATIONS = [
  { name: "anchor", enableAnchor: true, enableLocalExecutor: true, domain: "anchor" },
] as const;

const LOCAL_PROFILES = [
  { profile: "anchor-executor", withWorkspace: true },
  { profile: "executor-only", withWorkspace: false },
] as const;

describe("conversation owner domain conformance", () => {
  it.each(CONFIGURATIONS)(
    "runs the shared session/history contract in $name",
    async (configuration) => {
      const authority = await setupAuthorityRuntime({
        zhixingHome: await createTempDir(`owner-domain-${configuration.name}`),
        secretStore: new MemorySecretStore(),
        executorReadiness: READINESS,
        enableAnchor: configuration.enableAnchor,
        enableLocalExecutor: configuration.enableLocalExecutor,
      });
      const conversationId = configuration.domain === "local"
        ? localConversationId(authority.deviceId, "01ARZ3NDEKTSV4RRFFQ69G5FAV")
        : "conversation-domain-conformance";
      const unknownId = configuration.domain === "local"
        ? localConversationId(authority.deviceId, "01ARZ3NDEKTSV4RRFFQ69G5FAW")
        : "conversation-domain-unknown";
      const manager = new ConversationManager({
        create: async () => {
          throw new Error("shared owner conformance does not execute a model");
        },
      });
      const protocol = new ConversationProtocolRuntime({
        ...(configuration.domain === "local"
          ? { owner: localConversationOwnerRuntime(authority) }
          : { authority }),
        manager: () => manager,
        interactions: new DurableConversationInteractionObserver(),
      });
      const context = (requestId: string) => ({
        principal: { kind: "host" as const, component: "owner-domain-conformance" },
        requestId,
        deadlineAt: new Date(Date.now() + 30_000).toISOString(),
      });
      try {
        await protocol.ensureSession(conversationId);
        await protocol.ensureSession(conversationId);
        expect(await protocol.listSessions()).toEqual([conversationId]);
        await expect(
          protocol.sessionState.mutate(
            unknownId,
            { kind: "session-meta", patch: { name: "forbidden" } },
            context("unknown-write"),
          ),
        ).rejects.toMatchObject({ code: "not-found" });

        const renameContext = context("rename-once");
        const renamed = await protocol.sessionState.mutate(
          conversationId,
          { kind: "session-meta", patch: { name: "Conformant" } },
          renameContext,
        );
        expect(
          await protocol.sessionState.readSessionMeta(
            conversationId,
            context("read-meta"),
          ),
        ).toMatchObject({ name: "Conformant" });
        expect(await protocol.statusHistory([])).toEqual({ notices: [], next: [] });
        expect(await protocol.finalHistory(conversationId, 0)).toEqual([]);

        await protocol.sessionState.mutate(
          conversationId,
          { kind: "conversation-delete" },
          context("delete-once"),
        );
        await expect(
          protocol.sessionState.mutate(
            conversationId,
            { kind: "session-meta", patch: { name: "Conformant" } },
            renameContext,
          ),
        ).resolves.toEqual(renamed);
        await expect(
          protocol.sessionState.mutate(
            conversationId,
            { kind: "session-meta", patch: { name: "must-fail" } },
            context("fresh-after-delete"),
          ),
        ).rejects.toMatchObject({ code: "not-found" });
      } finally {
        await protocol.stopRecoveryLoop();
        await manager.disposeAll();
        await authority.stopStorageMaintenance();
      }
    },
    60_000,
  );

  it.each(LOCAL_PROFILES)(
    "runs the production assembly contract in $profile",
    async ({ profile, withWorkspace }) => {
      const fixture = await createLocalOwnerAssemblyFixture({
        profile,
        withWorkspace,
        pendingConfirmation: true,
      });
      let restarted:
        | Awaited<ReturnType<typeof createLocalOwnerAssemblyFixture>>
        | undefined;
      try {
        await fixture.assembly.start();
        const conversationId = await fixture.port.createConversation();
        await fixture.port.ensureSession(conversationId);
        expect(Boolean(fixture.environment)).toBe(withWorkspace);
        const advancement = advancementCreatedEvent(conversationId, profile);
        await fixture.port.mutateSession(
          conversationId,
          { kind: "advancement-event", events: [advancement] },
          context(`production-advancement-${profile}`),
        );
        await expect(
          fixture.port.sessionState.readAdvancementState(
            conversationId,
            context(`production-advancement-read-${profile}`),
          ),
        ).resolves.toMatchObject({
          id: advancement.sessionId,
          status: "awaiting-rubric-confirmation",
        });

        const turn = fixture.port.runTurn({
          conversationId,
          text: `production conformance ${profile}`,
          turnId: `production-conformance-${profile}`,
          ...(fixture.environment ? { environment: fixture.environment } : {}),
        });
        const pending = await waitForPendingInteraction(fixture.port);
        await fixture.port.resolveNoInteractiveSurface({
          assignmentId: pending.assignmentId,
          requestId: pending.request.requestId,
        });
        const outcome = await turn;
        if (outcome.kind === "error") throw outcome.error;
        expect(outcome).toMatchObject({
          kind: "settled",
          runResult: { agentResult: { reason: "completed" } },
        });

        const committed = await waitForFinal(fixture.port, conversationId);
        expect(committed).toHaveLength(1);
        await expect(fixture.port.pendingInteractions()).resolves.toEqual([]);
        await expect(fixture.port.rubricCatalog.listForMatching()).resolves.toEqual([]);
        const transcript = await fixture.port.sessionState.readTranscriptTail(
          conversationId,
          context(`production-tail-${profile}`),
          undefined,
          10,
        );
        expect(transcript.records).toHaveLength(1);

        await fixture.assembly.close();
        await fixture.authority.stopStorageMaintenance();
        restarted = await createLocalOwnerAssemblyFixture({
          profile,
          home: fixture.home,
        });
        await restarted.assembly.start();
        expect(restarted.runtime.executions()).toBe(0);
        await expect(restarted.port.listConversations()).resolves.toEqual([
          conversationId,
        ]);
        await expect(restarted.port.finalHistory(conversationId, 0)).resolves.toEqual(
          committed,
        );
      } finally {
        if (restarted) {
          await restarted.assembly.close().catch(() => {});
          await restarted.authority.stopStorageMaintenance().catch(() => {});
        } else {
          await fixture.assembly.close().catch(() => {});
          await fixture.authority.stopStorageMaintenance().catch(() => {});
        }
      }
    },
    120_000,
  );
});

function advancementCreatedEvent(
  conversationId: string,
  profile: (typeof LOCAL_PROFILES)[number]["profile"],
): AdvancementControlEvent {
  const timestamp = "2026-08-07T00:00:00.000Z";
  return {
    type: "session_created",
    timestamp,
    sessionId: `advancement-${profile}`,
    conversationId,
    originalUserTask: {
      parts: [{ type: "text", text: `production advancement ${profile}` }],
    },
    pendingRubricDraft: {
      draftId: `draft-${profile}`,
      originalTurnId: `turn-${profile}`,
      source: "generated",
      candidateRubricIds: [],
      title: "Production conformance",
      description: "Verifies the local advancement assembly boundary",
      content: {
        passCriteria: ["The production assembly persists advancement state"],
        evidenceRequirements: [],
        failureHandling: [],
      },
      createdAt: timestamp,
    },
  };
}

async function waitForPendingInteraction(
  port: Awaited<ReturnType<typeof createLocalOwnerAssemblyFixture>>["port"],
) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const pending = await port.pendingInteractions();
    if (pending[0]) return pending[0];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for durable local interaction");
}

function context(requestId: string) {
  return {
    principal: { kind: "host" as const, component: "owner-domain-conformance" },
    requestId,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
  };
}

async function waitForFinal(
  port: Awaited<ReturnType<typeof createLocalOwnerAssemblyFixture>>["port"],
  conversationId: string,
) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const history = await port.finalHistory(conversationId, 0);
    if (history.length > 0) return history;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for authoritative local final");
}

class MemorySecretStore implements SecretStorePort {
  readonly #values = new Map<string, string>();

  async put(ref: SecretRef, value: string): Promise<void> {
    this.#values.set(`${ref.kind}/${ref.bindingId}`, value);
  }

  async get(ref: SecretRef): Promise<string | null> {
    return this.#values.get(`${ref.kind}/${ref.bindingId}`) ?? null;
  }

  async delete(ref: SecretRef): Promise<void> {
    this.#values.delete(`${ref.kind}/${ref.bindingId}`);
  }

  async list(prefix: string): Promise<SecretRef[]> {
    return [...this.#values.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => {
        const separator = key.indexOf("/");
        return {
          kind: key.slice(0, separator) as SecretRef["kind"],
          bindingId: key.slice(separator + 1),
        };
      });
  }

  async unlockState(): Promise<"unlocked"> {
    return "unlocked";
  }
}
