/**
 * conversation 接入面 × 持久层不变量 —— "分片文件在，会话就在"必须贯穿到
 * 历史装载入口：索引层事故（缺失 / 损坏）不允许让 server / channel 会话
 * 恢复时丢历史上下文。
 *
 * 用真实 ShardedTranscriptStore + SnapshotStore（临时目录）驱动
 * conversationSurface 装配出的 ConversationManager，断言 factory 收到的
 * 启动装填产物（ConversationBootstrap）。
 */

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import {
  extractFirstText,
  ShardedTranscriptStore,
  SnapshotStore,
} from "@zhixing/core";
import type { ConversationBootstrap, RuntimeFactory, SessionRuntime } from "@zhixing/server";
import { ACCESS_SURFACES } from "../access-surfaces.js";
import type { AssemblyContext } from "../access-surface.js";

const conversationSurface = ACCESS_SURFACES.find(
  (s) => s.name === "conversation",
)!;

function stubRuntime(sessionId: string): SessionRuntime {
  return {
    sessionId,
    run: vi.fn(),
    getHistory: () => [],
    acceptRun: vi.fn(() => ({})),
    abort: () => false,
    dispose: async () => {},
  } as unknown as SessionRuntime;
}

async function setupCtx() {
  const tmp = await createTempDir("conversation-surface");
  const convDir = path.join(tmp, "conversations");
  const transcript = new ShardedTranscriptStore(convDir);
  const snapshots = new SnapshotStore(convDir);
  const received: Array<{
    id: string;
    bootstrap: ConversationBootstrap | undefined;
  }> = [];
  const runtimeFactory: RuntimeFactory = {
    async create(sessionId, bootstrap) {
      received.push({ id: sessionId, bootstrap });
      return stubRuntime(sessionId);
    },
  };
  const ctx = {
    transcript,
    snapshots,
    config: {},
    runtimeFactory,
    confirmationHub: undefined,
  } as unknown as AssemblyContext;
  await conversationSurface.setup(ctx);
  return { transcript, received, ctx, convDir };
}

describe("conversation 接入面：历史装载服从持久层不变量", () => {
  it("索引缺失但分片在 → 装填对含完整历史，不丢一轮（倒读自愈贯穿到入口）", async () => {
    const { transcript, received, ctx, convDir } = await setupCtx();
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

    expect(received).toHaveLength(1);
    const bootstrap = received[0]!.bootstrap!;
    expect(bootstrap.turnCount).toBe(2);
    const text = extractFirstText(bootstrap.bootstrap![0]!);
    expect(text.indexOf("用户：一")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("用户：一")).toBeLessThan(text.indexOf("用户：二")); // 时间正序
    expect(session.turnCount).toBe(2);

    await ctx.conversations!.disposeAll();
  });

  it("真·新对话 → 历史为 undefined，initTranscript 建索引", async () => {
    const { transcript, received, ctx } = await setupCtx();

    const session = await ctx.conversations!.getOrCreate("fresh");

    expect(received[0]!.bootstrap).toBeUndefined();
    expect(session.turnCount).toBe(0);
    expect(await transcript.exists("fresh")).toBe(true); // initTranscript 已建索引

    await ctx.conversations!.disposeAll();
  });
});
