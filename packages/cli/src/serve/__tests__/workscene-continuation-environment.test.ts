import { it, expect, vi } from "vitest";
import { resolve } from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import {
  WorksceneContinuationApplication,
  type WorksceneContinuationSource,
} from "@zhixing/core/workscene/application";
import { setupAuthorityRuntime } from "../../setup-delivery.js";
import { createWorksceneContinuationPort } from "../workscene-continuation-adapter.js";
import { createDeviceCapacityRuntime } from "../../__tests__/device-capacity-fixture.js";
class MemorySecrets {
  entries = new Map();
  async put(ref: { kind: string; bindingId: string }, value: string) {
    this.entries.set(`${ref.kind}/${ref.bindingId}`, value);
  }
  async get(ref: { kind: string; bindingId: string }) {
    return this.entries.get(`${ref.kind}/${ref.bindingId}`) ?? null;
  }
  async delete(ref: { kind: string; bindingId: string }) {
    this.entries.delete(`${ref.kind}/${ref.bindingId}`);
  }
  async list() {
    return [];
  }
  async unlockState() {
    return "unlocked" as const;
  }
}
it("retains the original remote workspace through product continuation, admission adapter and assignment", async () => {
  const readiness = () => ({
    tools: [],
    mcpServers: [],
    credentialBindings: [],
    deviceScopedCredentialBindingIds: [],
    credentialGeneration: null,
  });
  const remoteHome = await createTempDir("autonomy-return-remote");
  const capacity = createDeviceCapacityRuntime(resolve(remoteHome, "capacity"));
  const remote = await setupAuthorityRuntime({
    zhixingHome: remoteHome,
    secretStore: new MemorySecrets(),
    executorId: "remote",
    executorReadiness: readiness,
    enableAnchor: false,
    deviceCapacity: capacity.arbiter,
    storageMaintenance: capacity.storage,
  });
  const anchor = await setupAuthorityRuntime({
    zhixingHome: await createTempDir("autonomy-return-anchor"),
    secretStore: new MemorySecrets(),
    executorId: "anchor",
    executorReadiness: readiness,
    trustedIdentities: [remote.identity],
  });
  try {
    remote.reconcileTrustedDevices([anchor.identity], [anchor.deviceId]);
    const migration = remote.workspaceBindingMigration!;
    const binding = await migration.importLegacy(
      {
        migrationId: "probe",
        sourceSnapshotToken: "initial",
        displayName: "Remote project",
        absolutePath: resolve(remoteHome, "project"),
      },
      new AbortController().signal,
    );
    await migration.activateLegacy(
      { migrationId: "probe", sourceSnapshotToken: "initial" },
      new AbortController().signal,
    );
    const common = {
      conversationId: "remote-main",
      executionProfile: { tools: [], mcpServers: [], providerIds: [] },
      permissionRules: [],
      recentExecutorId: remote.executorId,
      targets: [
        {
          executorId: remote.executorId,
          deviceId: remote.deviceId,
          synchronizePermission: (
            snapshot: import("@zhixing/core/contracts").TrustRuleSnapshot,
          ) => remote.installPermissionSnapshot(snapshot),
        },
      ],
    };
    const environment = {
      workspace: { deviceId: remote.deviceId, bindingRef: binding.bindingRef },
    };
    const original = await anchor.prepareConversationAssignment({
      ...common,
      environment,
    });
    expect(original.executorId).toBe(remote.executorId);
    expect(original.environment.workspace?.bindingRef).toBe(binding.bindingRef);
    const handoff = {
      goal: "完成远端项目任务",
      constraints: [],
      completed: [],
      remaining: ["核实资料后修改原项目"],
    };
    const sources: WorksceneContinuationSource[] = [
      {
        conversationId: "remote-main",
        runId: "root",
        ingressId: "root-turn",
        state: "committed",
        current: true,
        result: "",
        surfacePrincipal: "owner",
        environment,
        origin: { channel: "rpc" },
        control: {
          intent: {
            kind: "delegate_mcp",
            candidate: {
              serverId: "demo",
              source: "inferred",
              entry: { command: "node" },
              secretFields: [],
            },
            handoff,
          },
        },
      },
    ];
    const admissions: Parameters<
      import("@zhixing/owner-kernel/conversation-manager").ConversationManager["admitDurableTurn"]
    >[0][] = [];
    const manager = {
      findDurableRunByIngress: async () => undefined,
      admitDurableTurn: async (request: (typeof admissions)[number]) => {
        admissions.push(request);
        return { shouldEnqueue: false };
      },
    };
    const protocol = {
      worksceneContinuationSources: async (id: string) =>
        sources.filter((s) => s.conversationId === id),
      isWorksceneContinuationCurrent: async () => true,
    };
    const port = createWorksceneContinuationPort({
      manager: manager as never,
      protocol: protocol as never,
      workscene: {} as never,
      advancement: {
        queryActiveState: async () => undefined,
        cancelSession: vi.fn(),
      } as never,
      canRunIsolatedMain: true,
    });
    const app = new WorksceneContinuationApplication(port);
    await app.recover("remote-main");
    const support = admissions[0];
    expect(support.environment).toBeUndefined();
    sources.push({
      ...sources[0]!,
      conversationId: support.conversationId,
      runId: "support",
      ingressId: support.options!.turnContext!.turnId,
      origin: support.options?.turnContext?.turnOrigin,
      environment: undefined,
      control: undefined,
      result: "资料已核实，回原项目继续",
    });
    await app.recover(support.conversationId);
    const returned = admissions[1];
    const prepared = await anchor.prepareConversationAssignment({
      ...common,
      ...(returned.environment ? { environment: returned.environment } : {}),
    });
    expect(returned.conversationId).toBe("remote-main");
    expect(prepared.executorId).toBe(remote.executorId);
    expect(returned.environment).toEqual(environment);
    expect(prepared.environment.workspace).toEqual(
      original.environment.workspace,
    );
  } finally {
    await anchor.startupCleanup.run();
    await remote.startupCleanup.run();
  }
});
