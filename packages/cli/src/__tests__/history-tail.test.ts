/**
 * 历史尾巴单元测试 —— "回到工位"用户侧展示的验收锚。
 *
 * 数据侧用真实 ShardedTranscriptStore（tmp 目录）：尾巴的读取契约就是
 * 倒读原语（含清空边界），不 mock 持久层。
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ShardedTranscriptStore,
  userMessage,
  type Message,
} from "@zhixing/core";
import {
  loadHistoryTail,
  renderHistoryTailLines,
  renderHistoryTail,
  DEFAULT_TAIL_RUNS,
} from "../history-tail.js";
import { stringWidth } from "../tui/line-width.js";
import type { CliWriter } from "../screen/index.js";

const CONV = "conv-tail";

let tmpDir: string;
let store: ShardedTranscriptStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "history-tail-"));
  store = new ShardedTranscriptStore(tmpDir);
  await store.init(CONV);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function assistantMsg(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

async function appendRun(user: string, assistant?: string): Promise<void> {
  const messages: Message[] = [userMessage(user)];
  if (assistant !== undefined) messages.push(assistantMsg(assistant));
  await store.appendRunRecord(CONV, {
    messages,
    timestamp: new Date().toISOString(),
  });
}

// ─── loadHistoryTail ───

describe("loadHistoryTail", () => {
  it("取最近 maxRuns 条、时间正序返回，latestAt 为最近一条的时刻", async () => {
    for (let i = 0; i < 5; i++) await appendRun(`q${i}`, `a${i}`);

    const tail = await loadHistoryTail(store, CONV, 3);

    expect(tail.entries.map((t) => t.userText)).toEqual(["q2", "q3", "q4"]);
    expect(tail.entries.map((t) => t.assistantText)).toEqual([
      "a2",
      "a3",
      "a4",
    ]);
    expect(tail.latestAt).toBeDefined();
    expect(Number.isNaN(new Date(tail.latestAt!).getTime())).toBe(false);
  });

  it("投影取 run 两端：含工具往返的 run 取末条 assistant 文本", async () => {
    await store.appendRunRecord(CONV, {
      timestamp: new Date().toISOString(),
      messages: [
        userMessage("帮我查一下"),
        assistantMsg("我先调用工具"),
        userMessage("(tool_result 占位)"),
        assistantMsg("查到了：结论是 X"),
      ],
    });

    const tail = await loadHistoryTail(store, CONV);

    expect(tail.entries).toHaveLength(1);
    expect(tail.entries[0]!.userText).toBe("帮我查一下");
    expect(tail.entries[0]!.assistantText).toBe("查到了：结论是 X");
  });

  it("run 无 assistant 文本（中断等）→ assistantText 缺省", async () => {
    await store.appendRunRecord(CONV, {
      timestamp: new Date().toISOString(),
      messages: [userMessage("被中断的问题")],
    });

    const tail = await loadHistoryTail(store, CONV);

    expect(tail.entries).toEqual([{ userText: "被中断的问题" }]);
  });

  it("清空边界：appendClear 之后尾巴为空（/clear 后不见）", async () => {
    await appendRun("clear 前的问题", "clear 前的回答");
    await store.appendClear(CONV);

    expect((await loadHistoryTail(store, CONV)).entries).toEqual([]);

    // clear 后新对话内容恢复可见
    await appendRun("clear 后的问题", "clear 后的回答");
    const tail = await loadHistoryTail(store, CONV);
    expect(tail.entries.map((t) => t.userText)).toEqual(["clear 后的问题"]);
  });

  it("空对话 / 不存在的对话 → 空 entries 且无 latestAt（不抛）", async () => {
    expect(await loadHistoryTail(store, CONV)).toEqual({ entries: [] });
    expect(await loadHistoryTail(store, "no-such-conv")).toEqual({
      entries: [],
    });
  });

  it("多行与连续空白折叠为单行", async () => {
    await appendRun("第一行\n  第二行\t第三行", "回答\n\n带空行");

    const tail = await loadHistoryTail(store, CONV);

    expect(tail.entries[0]!.userText).toBe("第一行 第二行 第三行");
    expect(tail.entries[0]!.assistantText).toBe("回答 带空行");
  });

  it("默认条数为 3", () => {
    expect(DEFAULT_TAIL_RUNS).toBe(3);
  });
});

// ─── renderHistoryTailLines ───

describe("renderHistoryTailLines", () => {
  it("空条目 → 空数组（无标题无占位）", () => {
    expect(renderHistoryTailLines({ entries: [] }, 80)).toEqual([]);
  });

  it("标题 + 用户/AI 锚行 + 尾空行", () => {
    const lines = renderHistoryTailLines(
      {
        entries: [{ userText: "问题一", assistantText: "回答一" }],
      },
      80,
    );

    expect(lines[0]).toContain("最近对话");
    expect(lines[1]).toContain("❯ 问题一");
    expect(lines[2]).toContain("◆ 回答一");
    expect(lines[3]).toBe("");
    expect(lines).toHaveLength(4);
  });

  it("中断 run 渲染占位行——不留白让用户误以为提问被无视", () => {
    const lines = renderHistoryTailLines(
      { entries: [{ userText: "被中断的问题" }] },
      80,
    );

    expect(lines[1]).toContain("❯ 被中断的问题");
    expect(lines[2]).toContain("(此轮未生成回复)");
    expect(lines[2]).not.toContain("◆");
  });

  it("标题携最近一轮的相对时间锚；latestAt 无效则省略", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const withTime = renderHistoryTailLines(
      { entries: [{ userText: "q" }], latestAt: threeDaysAgo },
      80,
    );
    expect(withTime[0]).toContain("最近对话 · 3 天前");

    const invalid = renderHistoryTailLines(
      { entries: [{ userText: "q" }], latestAt: "not-a-date" },
      80,
    );
    expect(invalid[0]).toContain("最近对话");
    expect(invalid[0]).not.toContain("·");
  });

  it("超宽内容按可见宽度截断（中文安全、行宽合约，占位行同守）", () => {
    const lines = renderHistoryTailLines(
      {
        entries: [
          { userText: "中文内容".repeat(40), assistantText: "回答".repeat(60) },
          { userText: "中断的问题" }, // 占位行在极窄终端下同样不得溢出
        ],
        latestAt: new Date().toISOString(), // 带时间锚的标题行同守行宽
      },
      16,
    );

    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(15);
    }
    expect(lines[1]).toContain("…");
  });
});

// ─── 组合入口 ───

describe("renderHistoryTail", () => {
  function collectWriter(): { writer: CliWriter; lines: string[] } {
    const lines: string[] = [];
    const writer = { line: (s: string) => lines.push(s) } as CliWriter;
    return { writer, lines };
  }

  it("有历史 → 写出标题（含时间锚）与摘录行", async () => {
    await appendRun("最近的问题", "最近的回答");
    const { writer, lines } = collectWriter();

    await renderHistoryTail({ store, conversationId: CONV, writer, width: 80 });

    expect(lines.some((l) => l.includes("最近对话 · 刚刚"))).toBe(true);
    expect(lines.some((l) => l.includes("最近的问题"))).toBe(true);
    expect(lines.some((l) => l.includes("最近的回答"))).toBe(true);
  });

  it("空历史零输出 —— 启动新对话 / 刚清空时不渲染任何东西", async () => {
    const { writer, lines } = collectWriter();

    await renderHistoryTail({ store, conversationId: CONV, writer, width: 80 });

    expect(lines).toEqual([]);
  });
});
