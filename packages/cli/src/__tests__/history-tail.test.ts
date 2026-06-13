/**
 * 历史尾巴单元测试 —— "回到工位"用户侧展示的验收锚。
 *
 * 数据来自宿主 session.history 的倒读分页(新→旧),本模块是纯投影 + 渲染:
 * 测试直接喂倒序 run 记录,清空边界由宿主倒读原语保证(/clear 后空页)。
 */

import { describe, expect, it, vi } from "vitest";
import { userMessage, type Message, type RunRecord } from "@zhixing/core";
import {
  projectHistoryTail,
  renderHistoryTailLines,
  renderHistoryTail,
  DEFAULT_TAIL_RUNS,
} from "../history-tail.js";
import { stringWidth } from "../tui/line-width.js";
import type { CliWriter } from "../screen/index.js";

function assistantMsg(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

let seq = 0;
function run(user: string, assistant?: string): RunRecord {
  const messages: Message[] = [userMessage(user)];
  if (assistant !== undefined) messages.push(assistantMsg(assistant));
  return {
    type: "run",
    runIndex: seq++,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    messages,
  } as RunRecord;
}

/** 倒序(新→旧)構造——与宿主 history 返回序一致 */
function newestFirst(...runs: RunRecord[]): RunRecord[] {
  return [...runs].reverse();
}

// ─── projectHistoryTail ───

describe("projectHistoryTail", () => {
  it("取最近 maxRuns 条、时间正序返回，latestAt 为最近一条的时刻", () => {
    const runs = [
      run("q0", "a0"),
      run("q1", "a1"),
      run("q2", "a2"),
      run("q3", "a3"),
      run("q4", "a4"),
    ];
    const tail = projectHistoryTail(newestFirst(...runs), 3);

    expect(tail.entries.map((t) => t.userText)).toEqual(["q2", "q3", "q4"]);
    expect(tail.entries.map((t) => t.assistantText)).toEqual(["a2", "a3", "a4"]);
    expect(tail.latestAt).toBe(runs[4]!.timestamp);
  });

  it("投影取 run 两端：含工具往返的 run 取末条 assistant 文本", () => {
    const record = {
      type: "run",
      runIndex: seq++,
      timestamp: new Date().toISOString(),
      messages: [
        userMessage("帮我查一下"),
        assistantMsg("我先调用工具"),
        userMessage("(tool_result 占位)"),
        assistantMsg("查到了：结论是 X"),
      ],
    } as RunRecord;

    const tail = projectHistoryTail([record]);
    expect(tail.entries).toHaveLength(1);
    expect(tail.entries[0]!.userText).toBe("帮我查一下");
    expect(tail.entries[0]!.assistantText).toBe("查到了：结论是 X");
  });

  it("run 无 assistant 文本（中断等）→ assistantText 缺省", () => {
    const tail = projectHistoryTail([run("被中断的问题")]);
    expect(tail.entries[0]!.userText).toBe("被中断的问题");
    expect(tail.entries[0]!.assistantText).toBeUndefined();
  });

  it("空页(新对话 / 刚清空)→ 空 entries 且无 latestAt", () => {
    const tail = projectHistoryTail([]);
    expect(tail.entries).toEqual([]);
    expect(tail.latestAt).toBeUndefined();
  });

  it("多行与连续空白折叠为单行", () => {
    const tail = projectHistoryTail([run("第一行\n第二行   带空白", "回\n复")]);
    expect(tail.entries[0]!.userText).toBe("第一行 第二行 带空白");
    expect(tail.entries[0]!.assistantText).toBe("回 复");
  });

  it("默认渲染条数为 DEFAULT_TAIL_RUNS", () => {
    const runs = Array.from({ length: DEFAULT_TAIL_RUNS + 2 }, (_, i) =>
      run(`q${i}`, `a${i}`),
    );
    const tail = projectHistoryTail(newestFirst(...runs));
    expect(tail.entries).toHaveLength(DEFAULT_TAIL_RUNS);
  });
});

// ─── renderHistoryTailLines ───

describe("renderHistoryTailLines", () => {
  it("空条目零输出;有条目时含标题与摘录行,逐行不超宽", () => {
    expect(renderHistoryTailLines({ entries: [] }, 80)).toEqual([]);

    const tail = projectHistoryTail(
      newestFirst(run("一个相当长的问题".repeat(10), "一个相当长的回答".repeat(10))),
    );
    const lines = renderHistoryTailLines(tail, 60);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toContain("最近对话");
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(60);
    }
  });
});

// ─── renderHistoryTail(组合入口) ───

describe("renderHistoryTail", () => {
  function makeWriter(): CliWriter & { lines: string[] } {
    const lines: string[] = [];
    return {
      lines,
      line: vi.fn((text: string) => lines.push(text)),
    } as unknown as CliWriter & { lines: string[] };
  }

  it("有历史 → 写出标题（含时间锚）与摘录行", () => {
    const writer = makeWriter();
    renderHistoryTail({
      runs: newestFirst(run("问", "答")),
      writer,
      width: 80,
    });
    expect(writer.lines.length).toBeGreaterThan(0);
    expect(writer.lines[0]).toContain("最近对话");
  });

  it("空历史零输出 —— 启动新对话 / 刚清空时不渲染任何东西", () => {
    const writer = makeWriter();
    renderHistoryTail({ runs: [], writer, width: 80 });
    expect(writer.lines).toEqual([]);
  });
});
