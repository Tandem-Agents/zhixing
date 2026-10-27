import { expect, it } from "vitest";
import type { GlobalControlCallContext } from "@zhixing/core/contracts";
import { AnchorWorksceneGlobalStateAdapter } from "@zhixing/core/workscene";
import { createTempDir } from "@zhixing/test-utils";
import { setupAuthorityRuntime } from "../../setup-delivery.js";

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
  // 写者打开日志前原子取得缓存完整性密钥：仅缺失时创建，已有值从不覆盖。
  async getOrCreate(ref: { kind: string; bindingId: string }, create: () => string) {
    const key = `${ref.kind}/${ref.bindingId}`;
    if (!this.entries.has(key)) this.entries.set(key, create());
    return this.entries.get(key)!;
  }
  async getExisting(ref: { kind: string; bindingId: string }) {
    return this.entries.get(`${ref.kind}/${ref.bindingId}`) ?? null;
  }
  async list() {
    return [];
  }
  async unlockState() {
    return "unlocked" as const;
  }
}

const context = (requestId: string, expectedRevision?: number) => ({
  principal: { kind: "host" as const, component: "workscene-dispatch-fence-test" },
  requestId,
  authority: { domain: "global" as const, anchorEpoch: 1 },
  deadlineAt: "2999-01-01T00:00:00.000Z",
  ...(expectedRevision === undefined ? {} : { expectedRevision }),
}) as GlobalControlCallContext;

it("does not dispatch a workscene conversation whose scene was deleted, and leaves never-created scenes alone", async () => {
  const anchor = await setupAuthorityRuntime({
    zhixingHome: await createTempDir("workscene-dispatch-fence"),
    secretStore: new MemorySecrets(),
    executorId: "anchor",
    executorReadiness: () => ({
      tools: [],
      mcpServers: [],
      credentialBindings: [],
      deviceScopedCredentialBindingIds: [],
      credentialGeneration: null,
    }),
  });
  // 同一权威日志上的场景注册表：建一个场景再删除；清理只确认完成、不写会话墓碑，留下删除窗口
  const workscenes = new AnchorWorksceneGlobalStateAdapter({
    log: anchor.authorityLog!, anchorEpoch: 1, removeScene: async () => {}, sceneIdFactory: () => "scene-gone",
  });
  const prepare = (conversationId: string) => anchor.prepareConversationAssignment({
    conversationId,
    executionProfile: { tools: [], mcpServers: [], providerIds: [] },
    permissionRules: [],
    targets: [],
  }).then(() => "prepared", (error: Error) => error.message);
  try {
    const created = await workscenes.mutate({ kind: "workscene-create", name: "Gone" }, context("create"));
    if (created.kind !== "workscene-applied") throw new Error("unexpected workscene result");
    await workscenes.mutate(
      { kind: "workscene-delete", sceneId: "scene-gone", expectedRevision: created.scene.revision },
      context("delete", created.scene.revision),
    );
    // 场景已删而会话墓碑仍待后台清理写入的窗口：派发准备按删除 tombstone 精确读拒绝
    expect(await prepare("ws:scene-gone:conversation-1")).toBe("Conversation workscene has been durably deleted");
    // 注册表里从未有过的场景没有删除约束可继承，不按删除拒绝
    expect(await prepare("ws:scene-never:conversation-1")).not.toContain("durably deleted");
  } finally {
    await workscenes.stop();
    await anchor.startupCleanup.run();
  }
}, 60_000);
