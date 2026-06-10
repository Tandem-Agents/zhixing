/**
 * 窗口 × 持久化的分层契约 —— 回归护栏。
 *
 * 契约：持久化是 append-only 原文（只增不减，压缩与清空都不销毁数据）；
 * 注意力窗口是唯一的压缩视图（折叠只发生在内存）。无压缩时两者同形，
 * 发生压缩后**有意分叉**——磁盘保留全量、窗口持有蒸馏。
 *
 * 用真实分片 store（临时目录）驱动接受协议（先盘后窗），机械检查：
 *   - 磁盘 run 数单调不减、倒读回的原文完整
 *   - 窗口折叠形态正确、覆盖锚点（runIndex）经接受协议落进配对元数据
 *   - 清空是事件：读边界生效、物理仍在
 *   - 重启重建（倒读 + restore + 保尾护栏）端到端
 */

import { beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { ShardedTranscriptStore } from "../../../transcript/shard/store.js";
import { countRuns, readRunsReverse } from "../../../transcript/shard/reader.js";
import type { RunRecord } from "../../../transcript/shard/types.js";
import type { Message } from "../../../types/messages.js";
import { extractFirstText } from "../../../types/messages.js";
import { buildCompactSummaryPair } from "../../system-meta.js";
import type { AttentionWindowState, WindowCompact } from "../types.js";
import {
  createAttentionWindow,
  restoreAttentionWindowFromRecords,
} from "../attention-window.js";

// ─── 辅助 ───

let clock = Date.now();
function runMessages(text: string): Message[] {
  return [
    { role: "user", content: [{ type: "text", text }] },
    { role: "assistant", content: [{ type: "text", text: `re:${text}` }] },
  ];
}

function compact(pairsCompacted: number, summary: string): WindowCompact {
  return {
    summary,
    pairsCompacted,
    tokensBefore: 10_000,
    tokensAfter: 1_000,
  };
}

/** 接受协议：先追加原始 run record，后以返回的 runIndex 推进窗口 */
async function acceptViaProtocol(
  store: ShardedTranscriptStore,
  window: AttentionWindowState,
  conversationId: string,
  messages: Message[],
  windowCompact?: WindowCompact,
) {
  clock += 1000;
  const { runIndex } = await store.appendRunRecord(conversationId, {
    timestamp: new Date(clock).toISOString(),
    messages,
  });
  window.acceptRun({ runMessages: messages, runIndex, windowCompact });
  return runIndex;
}

async function collectRecords(
  store: ShardedTranscriptStore,
  id: string,
): Promise<RunRecord[]> {
  const out: RunRecord[] = [];
  for await (const { record } of readRunsReverse(store, id)) {
    out.push(record);
  }
  return out.reverse(); // 倒读 → 时间正序
}

let store: ShardedTranscriptStore;

beforeEach(async () => {
  const tmpDir = await createTempDir("window-persistence");
  store = new ShardedTranscriptStore(path.join(tmpDir, "conversations"), {
    platform: "linux",
  });
});

// ─── 契约 ───

describe("窗口 × 持久化分层契约", () => {
  it("无压缩：窗口与持久化原文派生的配对同形", async () => {
    const window = createAttentionWindow({ conversationId: "c1" });
    for (const t of ["一", "二", "三"]) {
      await acceptViaProtocol(store, window, "c1", runMessages(t));
    }
    const records = await collectRecords(store, "c1");
    expect(window.getMessages()).toEqual(records.flatMap((r) => r.messages));
    expect(await countRuns(store, "c1")).toBe(3);
  });

  it("窗口折叠后：磁盘保留全部原文（只增不减），窗口持有蒸馏形", async () => {
    const window = createAttentionWindow({ conversationId: "c2" });
    await acceptViaProtocol(store, window, "c2", runMessages("零"));
    await acceptViaProtocol(store, window, "c2", runMessages("一"));
    // 第三个 run 携窗口折叠指令（摘掉前 2 个配对）
    await acceptViaProtocol(
      store,
      window,
      "c2",
      runMessages("二"),
      compact(2, "前两轮的摘要"),
    );

    // 磁盘：3 条原始 run 完好，序列含完整消息
    const records = await collectRecords(store, "c2");
    expect(records.map((r) => r.runIndex)).toEqual([0, 1, 2]);
    expect(records[0]!.messages).toEqual(runMessages("零"));

    // 窗口：摘要对 + 新配对（蒸馏视图，与磁盘有意分叉）
    expect(window.getMessages()).toEqual([
      ...buildCompactSummaryPair("前两轮的摘要"),
      ...runMessages("二"),
    ]);

    // 折叠的覆盖锚点：再折一次,被折最后配对(runIndex=2)经返回值交出
    const outcome = window.applyCompact(compact(1, "再折"));
    expect(outcome.coveredThroughRunIndex).toBe(2);
  });

  it("清空是事件：读边界生效、原文物理仍在、对话照常继续", async () => {
    let window = createAttentionWindow({ conversationId: "c3" });
    await acceptViaProtocol(store, window, "c3", runMessages("清空前"));
    await store.appendClear("c3");
    window.reset("clear");

    expect(window.getMessages()).toEqual([]);
    expect(await countRuns(store, "c3")).toBe(0);
    expect(await collectRecords(store, "c3")).toEqual([]); // 读边界

    // 物理仍在（append-only：清空不销毁）
    const index = await store.readIndex("c3");
    const lines = await store.readShardLines("c3", index!.shards[0]!);
    expect(lines.filter((l) => l.type === "run")).toHaveLength(1);

    // 清空后继续对话，runIndex 连续
    const idx = await acceptViaProtocol(store, window, "c3", runMessages("清空后"));
    expect(idx).toBe(1);
    expect(await countRuns(store, "c3")).toBe(1);

    // 重启重建只见清空后内容
    window = restoreAttentionWindowFromRecords(await collectRecords(store, "c3"));
    expect(window.getMessages()).toEqual(runMessages("清空后"));
  });

  it("重启重建：倒读 + restore 带 runIndex 锚点，保尾护栏截到预算内", async () => {
    const w1 = createAttentionWindow({ conversationId: "c4" });
    // 会话期发生过折叠——磁盘仍全量
    for (const [i, t] of ["零", "一", "二", "三"].entries()) {
      await acceptViaProtocol(
        store,
        w1,
        "c4",
        runMessages(t),
        i === 1 ? compact(1, "摘") : undefined,
      );
    }

    const records = await collectRecords(store, "c4");
    expect(records).toHaveLength(4); // 折叠不影响磁盘

    // 护栏：每条消息计 10，预算 45 → 保最新 2 个配对
    const w2 = restoreAttentionWindowFromRecords(records, {
      conversationId: "c4",
      tailGuard: {
        maxTokens: 45,
        estimateMessages: (m) => m.length * 10,
      },
    });
    const texts = w2.getMessages().map((m) => extractFirstText(m));
    expect(texts).toEqual(["二", "re:二", "三", "re:三"]);

    // 重建配对携 runIndex —— 折叠覆盖锚点在恢复路径同样成立
    const outcome = w2.applyCompact(compact(1, "重启后的摘要"));
    expect(outcome.coveredThroughRunIndex).toBe(2);
  });
});
