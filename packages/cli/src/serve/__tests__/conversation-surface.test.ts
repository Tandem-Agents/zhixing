/**
 * conversation 接入面 × 持久层不变量 —— "分片文件在，会话就在"必须贯穿到
 * 历史装载入口：索引层事故（缺失 / 损坏）不允许让 server / channel 会话
 * 恢复时丢历史上下文。
 *
 * 用真实 ShardedTranscriptStore（临时目录）驱动 conversationSurface 装配出的
 * ConversationManager，断言 factory 收到的 initialRecords。
 */

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { ShardedTranscriptStore, type RunRecord } from "@zhixing/core";
import type { RuntimeFactory, SessionRuntime } from "@zhixing/server";
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
    acceptRun: vi.fn(),
    abort: () => false,
    dispose: async () => {},
  } as unknown as SessionRuntime;
}

async function setupCtx() {
  const tmp = await createTempDir("conversation-surface");
  const transcript = new ShardedTranscriptStore(path.join(tmp, "conversations"));
  const received: Array<{ id: string; records: RunRecord[] | undefined }> = [];
  const runtimeFactory: RuntimeFactory = {
    async create(sessionId, initialRecords) {
      received.push({ id: sessionId, records: initialRecords });
      return stubRuntime(sessionId);
    },
  };
  const ctx = {
    transcript,
    runtimeFactory,
    confirmationHub: undefined,
  } as unknown as AssemblyContext;
  await conversationSurface.setup(ctx);
  return { transcript, received, ctx };
}

describe("conversation 接入面：历史装载服从持久层不变量", () => {
  it("索引缺失但分片在 → 恢复完整历史，不丢一轮（倒读自愈贯穿到入口）", async () => {
    const { transcript, received, ctx } = await setupCtx();
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
    const dir = (transcript as unknown as { conversationsDir: string })
      .conversationsDir;
    await fs.unlink(path.join(dir, "conv-x", "transcript", "index.json"));

    const session = await ctx.conversations!.getOrCreate("conv-x");

    expect(received).toHaveLength(1);
    const records = received[0]!.records!;
    expect(records.map((r) => r.runIndex)).toEqual([0, 1]);
    expect(records[0]!.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "一" }],
    });
    expect(session.turnCount).toBe(2);

    await ctx.conversations!.disposeAll();
  });

  it("真·新对话 → 历史为 undefined，initTranscript 建索引", async () => {
    const { transcript, received, ctx } = await setupCtx();

    const session = await ctx.conversations!.getOrCreate("fresh");

    expect(received[0]!.records).toBeUndefined();
    expect(session.turnCount).toBe(0);
    expect(await transcript.exists("fresh")).toBe(true); // initTranscript 已建索引

    await ctx.conversations!.disposeAll();
  });
});
