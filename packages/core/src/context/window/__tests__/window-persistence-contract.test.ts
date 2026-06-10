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
 *   - 重启重建（摘要快照 + 预算化倒读的启动装填）端到端
 */

import { beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { ShardedTranscriptStore } from "../../../transcript/shard/store.js";
import { countRuns, readRunsReverse } from "../../../transcript/shard/reader.js";
import { SnapshotStore } from "../../../transcript/snapshot/store.js";
import type { RunRecord } from "../../../transcript/shard/types.js";
import type { Message } from "../../../types/messages.js";
import { extractFirstText } from "../../../types/messages.js";
import { buildCompactSummaryPair } from "../../system-meta.js";
import { buildStartupBootstrap } from "../../bootstrap/build-startup-bootstrap.js";
import type { AttentionWindowState, WindowCompact } from "../types.js";
import { createAttentionWindow } from "../attention-window.js";

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
let snapshots: SnapshotStore;

beforeEach(async () => {
  const tmpDir = await createTempDir("window-persistence");
  const convDir = path.join(tmpDir, "conversations");
  store = new ShardedTranscriptStore(convDir, { platform: "linux" });
  snapshots = new SnapshotStore(convDir, { platform: "linux" });
});

/** 重启装填（owner 协议）：装填器建装填对 → 作为新窗起始条目 */
async function reopenWindow(
  conversationId: string,
  optimalMaxTokens = 400_000,
): Promise<AttentionWindowState> {
  const bootstrap = await buildStartupBootstrap({
    conversationId,
    store,
    snapshots,
    capability: { optimalMaxTokens },
    estimator: { estimateMessages: (m) => m.length * 10 },
  });
  return createAttentionWindow({
    conversationId,
    bootstrap: bootstrap ?? undefined,
  });
}

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

    // 重启装填只见清空后内容
    window = await reopenWindow("c3");
    const text = extractFirstText(window.getMessages()[0]!);
    expect(text).toContain("清空后");
    expect(text).not.toContain("清空前");
  });

  it("重启装填：摘要快照 + 预算化倒读的最近原文进装填对，窗口以其起步", async () => {
    const w1 = createAttentionWindow({ conversationId: "c4" });
    // 会话期发生折叠，owner 按协议落快照（覆盖锚来自折叠交出）
    for (const [i, t] of ["零", "一", "二", "三"].entries()) {
      clock += 1000;
      const { runIndex } = await store.appendRunRecord("c4", {
        timestamp: new Date(clock).toISOString(),
        messages: runMessages(t),
      });
      const outcome = w1.acceptRun({
        runMessages: runMessages(t),
        runIndex,
        windowCompact: i === 2 ? compact(2, "前两轮摘要") : undefined,
      });
      if (outcome.coveredThroughRunIndex !== undefined) {
        await snapshots.write("c4", {
          coveredThroughRunIndex: outcome.coveredThroughRunIndex,
          structuredSummary: { facts: "前两轮事实", state: "", active: "" },
          tokensBefore: 10_000,
          tokensAfter: 1_000,
        });
      }
    }
    expect(await collectRecords(store, "c4")).toHaveLength(4); // 折叠不影响磁盘

    // 重启：预算（含摘要预留 400）只够最近 2 组原文 → 摘要补足更早脉络
    //（optimal=1760 → budget=440：2 组×20 + 预留 400）
    const w2 = await reopenWindow("c4", 1760);
    const messages = w2.getMessages();
    expect(messages).toHaveLength(2); // 装填对是唯一起始条目
    const text = extractFirstText(messages[0]!);
    expect(text).toContain("前两轮事实"); // 快照摘要（covered=1 < earliest=2）
    expect(text).toContain("用户：二");
    expect(text).toContain("用户：三");
    expect(text).not.toContain("用户：一"); // 预算外原文由摘要承接
    // 装填对跨 run 存续：接受新 run 后仍在
    w2.acceptRun({ runMessages: runMessages("新"), runIndex: 4 });
    expect(extractFirstText(w2.getMessages()[0]!)).toContain("前两轮事实");
    // 折叠时装填对被摘要对取代（单 frontier）
    w2.applyCompact(compact(1, "新摘要"));
    expect(extractFirstText(w2.getMessages()[0]!)).toContain("新摘要");
    expect(extractFirstText(w2.getMessages()[0]!)).not.toContain("前两轮事实");
  });
});
