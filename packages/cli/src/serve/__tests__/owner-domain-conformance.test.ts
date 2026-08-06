import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
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

const READINESS = {
  tools: [] as string[],
  mcpServers: [] as string[],
  credentialBindings: [],
  deviceScopedCredentialBindingIds: [] as string[],
  credentialGeneration: null,
};

const CONFIGURATIONS = [
  { name: "anchor", enableAnchor: true, enableLocalExecutor: true, domain: "anchor" },
  {
    name: "local-anchor-executor",
    enableAnchor: true,
    enableLocalExecutor: true,
    domain: "local",
  },
  {
    name: "local-executor-only",
    enableAnchor: false,
    enableLocalExecutor: true,
    domain: "local",
  },
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
});

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
