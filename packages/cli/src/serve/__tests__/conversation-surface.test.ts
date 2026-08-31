/**
 * conversation 接入面 × 持久层不变量 —— "分片文件在，会话就在"必须贯穿到
 * 历史装载入口：索引层事故（缺失 / 损坏）不允许让 server / channel 会话
 * 恢复时丢历史上下文。
 *
 * 用真实 ShardedTranscriptStore + SnapshotStore（临时目录）驱动
 * conversationSurface 装配出的 ConversationManager，断言装填进会话窗口的
 * 启动装填产物(窗口归 ManagedSession,工厂只发纯执行体、不感知装填)。
 */

import { describe, expect, it, onTestFinished, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import {
  extractFirstText,
  ShardedTranscriptStore,
  SnapshotStore,
} from "@zhixing/core";
import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import {
  ConversationManager,
  type RuntimeFactory,
  type SessionRuntime,
} from "@zhixing/owner-kernel";
import { createAssemblyUnits } from "../access-surfaces.js";
import type { AssemblyContext } from "../access-surface.js";
import { setupAuthorityRuntime } from "../../setup-delivery.js";
import {
  ConversationProtocolRuntime,
  DurableConversationInteractionObserver,
} from "../conversation-protocol-runtime.js";

const TEST_EXECUTOR_READINESS = {
  tools: [] as string[],
  mcpServers: [] as string[],
  credentialBindings: [],
  deviceScopedCredentialBindingIds: [] as string[],
  credentialGeneration: null,
};

const conversationSurface = createAssemblyUnits({}).find(
  (s) => s.name === "conversation",
)!;

class MemorySecretStore implements SecretStorePort {
  readonly values = new Map<string, string>();

  async put(ref: SecretRef, value: string): Promise<void> {
    this.values.set(`${ref.kind}/${ref.bindingId}`, value);
  }

  async get(ref: SecretRef): Promise<string | null> {
    return this.values.get(`${ref.kind}/${ref.bindingId}`) ?? null;
  }

  async delete(ref: SecretRef): Promise<void> {
    this.values.delete(`${ref.kind}/${ref.bindingId}`);
  }

  async list(prefix: string): Promise<SecretRef[]> {
    return [...this.values.keys()]
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

function stubRuntime(sessionId: string): SessionRuntime {
  return {
    sessionId,
    run: vi.fn(),
    abort: () => false,
    dispose: async () => {},
  } as unknown as SessionRuntime;
}

async function setupCtx() {
  const tmp = await createTempDir("conversation-surface");
  const convDir = path.join(tmp, "conversations");
  const transcript = new ShardedTranscriptStore(convDir);
  const snapshots = new SnapshotStore(convDir);
  const created: string[] = [];
  const runtimeFactory: RuntimeFactory = {
    async create(sessionId) {
      created.push(sessionId);
      return stubRuntime(sessionId);
    },
  };
  const conversationIdentityLifecycle = {
    identityExists: vi.fn(async () => false),
    createIdentity: vi.fn(async () => "created-conversation"),
    ensureShell: vi.fn(async () => {}),
    initializeRuntimeStorage: vi.fn(async (id: string) => {
      await transcript.init(id);
    }),
  };
  const secretStore = new MemorySecretStore();
  const authorityRuntime = await setupAuthorityRuntime({
    zhixingHome: tmp,
    secretStore,
    executorReadiness: TEST_EXECUTOR_READINESS,
  });
  onTestFinished(() => authorityRuntime.stopStorageMaintenance());
  const ctx = {
    zhixingHome: tmp,
    secretStore,
    authorityRuntime,
    durableInteractions: new DurableConversationInteractionObserver(),
    perspectives: { executePerspectiveWork: vi.fn() },
    sessionBroadcastRef: { current: null },
    advancementDirectory: {
      list: vi.fn(async () => []),
      exists: vi.fn(async () => false),
      readRunsReverse: vi.fn(async () => ({ runs: [], hasMore: false })),
    },
    conversationAuthorityRef: { current: null },
    transcript,
    snapshots,
    config: {},
    enabledRoles: [],
    runtimeFactory,
    confirmationHub: undefined,
    conversationIdentityLifecycle,
    lifecycleContributions: { acquire: vi.fn() },
  } as unknown as AssemblyContext;
  await conversationSurface.setup(ctx);
  return { transcript, created, ctx, convDir, conversationIdentityLifecycle };
}

describe("conversation 接入面：历史装载服从持久层不变量", { timeout: 30_000 }, () => {
  it("binds and verifies the committed-turn listener before publishing the manager", async () => {
    const bind = vi.spyOn(
      ConversationManager.prototype,
      "bindTurnCommittedListener",
    );
    const verify = vi.spyOn(
      ConversationManager.prototype,
      "assertTurnCommittedListenerBound",
    );
    const bindManager = vi.spyOn(
      ConversationProtocolRuntime.prototype,
      "bindManager",
    );
    const verifyManager = vi.spyOn(
      ConversationProtocolRuntime.prototype,
      "assertManagerBound",
    );
    const { ctx } = await setupCtx();
    try {
      expect(bind).toHaveBeenCalledOnce();
      expect(verify).toHaveBeenCalledOnce();
      expect(bindManager).toHaveBeenCalledOnce();
      expect(verifyManager).toHaveBeenCalledOnce();
      expect(bindManager.mock.invocationCallOrder[0]).toBeLessThan(
        bind.mock.invocationCallOrder[0]!,
      );
      expect(bind.mock.invocationCallOrder[0]).toBeLessThan(
        verify.mock.invocationCallOrder[0]!,
      );
      expect(() => ctx.conversations!.assertTurnCommittedListenerBound()).not.toThrow();
    } finally {
      await ctx.conversations!.disposeAll();
      bind.mockRestore();
      verify.mockRestore();
      bindManager.mockRestore();
      verifyManager.mockRestore();
    }
  });

  it("索引缺失但分片在 → 装填对含完整历史，不丢一轮（倒读自愈贯穿到入口）", async () => {
    const { transcript, created, ctx, convDir } = await setupCtx();
    await transcript.appendRunRecord("conv-x", {
      timestamp: new Date().toISOString(),
      messages: [
        { role: "user", content: [{ type: "text", text: "一" }] },
        { role: "assistant", content: [{ type: "text", text: "re:一" }] },
      ],
    });
    await transcript.appendRunRecord("conv-x", {
      timestamp: new Date().toISOString(),
      messages: [
        { role: "user", content: [{ type: "text", text: "二" }] },
        { role: "assistant", content: [{ type: "text", text: "re:二" }] },
      ],
    });
    // 模拟索引层事故：index.json 丢失（替换窗口崩溃 / 误删），分片完好
    await fs.unlink(path.join(convDir, "conv-x", "transcript", "index.json"));

    const session = await ctx.conversations!.getOrCreate("conv-x");

    expect(created).toEqual(["conv-x"]);
    // 装填进会话窗口：起始条目即启动装填对
    const history = ctx.conversations!.getHistory("conv-x")!;
    expect(history.length).toBeGreaterThan(0);
    const text = extractFirstText(history[0]!);
    expect(text.indexOf("用户：一")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("用户：一")).toBeLessThan(text.indexOf("用户：二")); // 时间正序
    expect(session.turnCount).toBe(2);

    await ctx.conversations!.disposeAll();
  });

  it("真·新对话 → 窗口为空、turnCount 0，目录 ensure 建索引", async () => {
    const { transcript, ctx, conversationIdentityLifecycle } = await setupCtx();

    const ensureSession = vi.spyOn(ctx.conversationProtocol!, "ensureSession");

    const session = await ctx.conversations!.getOrCreate("fresh");

    expect(ctx.conversations!.getHistory("fresh")).toEqual([]);
    expect(session.turnCount).toBe(0);
    expect(
      conversationIdentityLifecycle.initializeRuntimeStorage,
    ).toHaveBeenCalledWith("fresh");
    expect(ensureSession.mock.invocationCallOrder[0]).toBeLessThan(
      conversationIdentityLifecycle.initializeRuntimeStorage.mock
        .invocationCallOrder[0]!,
    );
    expect(await transcript.exists("fresh")).toBe(true);

    await ctx.conversations!.disposeAll();
  });
});
