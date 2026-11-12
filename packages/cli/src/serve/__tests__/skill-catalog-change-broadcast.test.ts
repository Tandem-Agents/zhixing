// 技能目录变化的真实装配验收：真实宿主权威运行时（含 setup-delivery 的适配器与中继）、真实发布链、
// 真实 Server 与两个已认证的 WebSocket 客户端。全程不启动恢复循环：运行中保存技能，运行提交成功时目录拥有者
// 就发出事实，两个已连接的表面各收到一次 skill.changed，之后的恢复轮不重复；只有 usage 的提交不通知；
// 经 RPC 的管理命令每个客户端只收到一次，不会被重复广播。
import { describe, expect, it } from "vitest";
import { createTempDir } from "@zhixing-ai/test-utils";
import type { Message } from "@zhixing-ai/core";
import { createEventBus } from "@zhixing-ai/core/events";
import { createSignedTrustRuleSnapshot } from "@zhixing-ai/core/protocol";
import { defineProductApiExactSet, ProductApiDispatcher } from "@zhixing-ai/core/product-api";
import {
  createSkillCatalogProductApiContribution,
  SKILL_CATALOG_PRODUCT_API_EXACT_SET,
  SkillCatalogApplicationService,
} from "@zhixing-ai/core/skills/catalog";
import { createAnchorSkillCatalogManagementCorrectnessPort } from "@zhixing-ai/core/skills/catalog-correctness";
import { skillNameToId } from "@zhixing-ai/core/skills/id";
import { runContextStorage } from "@zhixing-ai/orchestrator/runtime";
import { ConversationManager } from "@zhixing-ai/owner-kernel/conversation-manager";
import { GlobalMutationCommitCoordinator } from "@zhixing-ai/owner-kernel/global-mutation-commit-coordinator";
import { SchedulerConversationMutationPublisher } from "@zhixing-ai/owner-kernel/scheduler-conversation-publisher";
import type { SessionRuntime } from "@zhixing-ai/owner-kernel/types";
import { projectSessionTurn } from "@zhixing-ai/rpc";
import { startServer } from "../../../../server/src/server.js";
import { createServerContext } from "../../../../server/src/context.js";
import { DEFAULT_SERVER_CONFIG } from "../../../../server/src/types.js";
import { createAssignmentSkillPorts } from "../../runtime/assignment-skill-adapter.js";
import { DurableConversationInteractionObserver } from "../conversation-protocol-runtime.js";
import {
  TEST_RUNTIME_AUTHORITY_FACTS,
  createProtocol,
  expectSettled,
  getOrCreateActiveConversation,
  MemorySecretStore,
  setupAuthorityRuntime,
} from "./conversation-protocol-runtime-fixture.js";

const TOKEN = "skill-catalog-change-token";
const SKILL = "Relay Skill";
/** 断言“恰好一次”时，收到之后再等这么久，确认没有第二条 */
const QUIET_MS = 400;

describe("skill catalog change broadcast through the real Host and Server", () => {
  it("notifies every connected client once per structural commit and not for usage", async () => {
    const home = await createTempDir("skill-catalog-change");
    const authority = await setupAuthorityRuntime({ zhixingHome: home, secretStore: new MemorySecretStore() });
    await authority.installPermissionSnapshot(createSignedTrustRuleSnapshot(
      { snapshotVersion: 1, rules: [], generatedAt: new Date().toISOString() }, authority.signer));
    const coordinator = new GlobalMutationCommitCoordinator({ log: authority.authorityLog, artifacts: authority.artifacts,
      participants: authority.globalMutationParticipants, refreshSchedule: async () => {}, scheduleDefinitionFor: () => undefined });
    const publisher = new SchedulerConversationMutationPublisher({ anchorEpoch: authority.anchorEpoch, coordinator, sourceForAssignment: () => ({}) });
    const skills = createAssignmentSkillPorts(authority.artifacts, { admissionLlm: async () => { throw Error("not needed"); } });
    let action: "save" | "load" = "save";
    const runtime: SessionRuntime = { ...TEST_RUNTIME_AUTHORITY_FACTS, sessionId: "skill-change",
      async *run(messages, options) {
        await runContextStorage.run({ bus: createEventBus(), lineage: "main", assignmentMutations: options?.assignmentMutations,
          globalQuery: options?.globalQuery, assignmentIssuedAt: options?.assignmentIssuedAt }, async () => {
          if (action === "save") {
            const saved = await skills.saveApplication.save({ name: SKILL, description: "Relay fixture", body: "Do the relay thing.", mode: "main" }, "tool-save");
            expect(saved.outcome).toBe("created");
          } else {
            await skills.loadApplication.load({ id: skillNameToId(SKILL), operationId: "load-relay" });
          }
        });
        const assistant: Message = { role: "assistant", content: [{ type: "text", text: "done" }] };
        const usage = { inputTokens: 0, outputTokens: 0 };
        return { agentResult: { reason: "completed" as const, message: assistant, usage },
          runRecord: { timestamp: new Date().toISOString(), messages: [messages.at(-1)!, assistant], usage }, newMessages: [assistant], durationMs: 1 };
      }, abort: () => false, async dispose() {},
    };
    let manager!: ConversationManager;
    const protocol = createProtocol({ authority, manager: () => manager, interactions: new DurableConversationInteractionObserver() });
    const unbind = protocol.bindMutationPublisher(publisher);
    manager = new ConversationManager({ create: async () => runtime }, undefined, { durableTurnExecutor: protocol,
      appendCommittedRun: async (_id, record) => ({ runIndex: record.runIndex, shardId: "owner-log", appended: true }), onTurnCommitted: () => {} });

    const productApi = new ProductApiDispatcher(
      defineProductApiExactSet({ operations: [...SKILL_CATALOG_PRODUCT_API_EXACT_SET.operations],
        factEvents: [...SKILL_CATALOG_PRODUCT_API_EXACT_SET.factEvents] }),
      [createSkillCatalogProductApiContribution(new SkillCatalogApplicationService(createAnchorSkillCatalogManagementCorrectnessPort({
        globalState: () => authority.globalState!, anchorEpoch: () => authority.anchorEpoch })))],
    );
    const server = await startServer({
      context: createServerContext({ config: { ...DEFAULT_SERVER_CONFIG, port: 0 }, version: "0.1.0-test", token: TOKEN, productApi,
        conversation: { durablePrincipal: (input: object) => ({ ...input, deviceId: "device-test" }), removeObserverFromAll() {}, async disposeAll() {} } as never }),
      skillCatalogEvents: authority.skillCatalogEvents,
    });
    const first = await connect(server.port);
    const second = await connect(server.port);
    const emitted: number[] = [];
    const stopWatching = authority.skillCatalogEvents.onChanged((fact) => { emitted.push(fact.catalogRevision); });
    try {
      await first.request("auth", { token: TOKEN, client: { id: "surface-a" } });
      await second.request("auth", { token: TOKEN, client: { id: "surface-b" } });
      const before = await first.request("skill.list", {}) as { structuralVersion: number; skills: unknown[] };
      expect(before.skills).toEqual([]);

      const managed = await getOrCreateActiveConversation(authority, manager, "skill-change");
      expectSettled(await projectSessionTurn({ manager, managed, text: "save", turnId: "save-turn", notify: () => {}, runOptions: { source: "interactive" } }));
      // 运行结算前提交已成功：事实此时已经发出，不靠恢复轮，也不靠等待
      const listed = await first.request("skill.list", {}) as { structuralVersion: number; skills: Array<{ id: string }> };
      expect(listed.skills.map((skill) => skill.id)).toEqual([skillNameToId(SKILL)]);
      expect(emitted).toEqual([listed.structuralVersion]);
      // 客户端只等网络送达
      for (const client of [first, second]) {
        expect(await client.changes()).toEqual([{ structuralVersion: listed.structuralVersion }]);
      }
      // 之后的恢复轮确认物化，同一结构变化不再通知
      expect(await protocol.recover()).toBeGreaterThan(0);
      for (const client of [first, second]) expect(await client.changes()).toEqual([]);

      action = "load";
      expectSettled(await projectSessionTurn({ manager, managed, text: "load", turnId: "load-turn", notify: () => {}, runOptions: { source: "interactive" } }));
      // 让 usage 也走完物化，“不通知”才不是因为根本没有物化
      expect(await protocol.recover()).toBeGreaterThan(0);
      const afterUsage = await first.request("skill.list", {}) as { structuralVersion: number };
      expect(afterUsage.structuralVersion).toBeGreaterThan(listed.structuralVersion);
      for (const client of [first, second]) expect(await client.changes()).toEqual([]);

      await first.request("skill.setState", { skillId: skillNameToId(SKILL), pinned: true });
      const afterPin = await first.request("skill.list", {}) as { structuralVersion: number };
      for (const client of [first, second]) {
        expect(await client.changes()).toEqual([{ structuralVersion: afterPin.structuralVersion }]);
      }
    } finally {
      stopWatching();
      first.close(); second.close();
      await server.close();
      unbind(); await protocol.stopRecoveryLoop(); await manager.disposeAll();
    }
  }, 60_000);
});

interface Client {
  request(method: string, params: unknown): Promise<unknown>;
  /** 收到第一条（或等满 QUIET_MS）之后再静候 QUIET_MS，返回期间收到的全部 skill.changed 并清空 */
  changes(): Promise<unknown[]>;
  close(): void;
}

async function connect(port: number): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("websocket open failed")), { once: true });
  });
  let next = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let changed: unknown[] = [];
  let arrived: (() => void) | undefined;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: unknown; method?: string; params?: unknown };
    if (message.id !== undefined && pending.has(message.id)) {
      const waiter = pending.get(message.id)!;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    } else if (message.method === "skill.changed") {
      changed.push(message.params);
      arrived?.();
    }
  });
  return {
    request(method, params) {
      const id = ++next;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    },
    async changes() {
      if (!changed.length) await new Promise<void>((resolve) => { arrived = resolve; setTimeout(resolve, 2_000); });
      arrived = undefined;
      await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
      const result = changed;
      changed = [];
      return result;
    },
    close() { socket.close(); },
  };
}
