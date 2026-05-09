import { describe, expect, it } from "vitest";
import type {
  CompactMarker,
  RawTranscript,
  ToolExecutionContext,
  Turn,
} from "@zhixing/core";
import { createRecallHistoryTool } from "../recall-history.js";

// ─── 测试辅助 ───

function makeTurn(opts: {
  index: number;
  user?: string;
  assistant?: string;
  toolCalls?: Array<{
    /** 协议层 tool_use id；省略时模拟"老 transcript"格式（id 字段引入前的写入）*/
    id?: string;
    name: string;
    input: Record<string, unknown>;
    result: string;
    isError?: boolean;
  }>;
}): Turn {
  // assistantMessage 始终为纯文本 —— 与真实 turn-builder 一致：取 newMessages 里
  // 最后一条 assistant，多轮 tool-loop 场景下是工具链结束后的总结，不含 tool_use
  // 块。tool_use 信息通过 toolCalls[i].id 持久化，跨 turn / 跨 record 唯一定位。
  const text = opts.assistant ?? `回复 ${opts.index}`;
  return {
    type: "turn",
    turnIndex: opts.index,
    timestamp: new Date(2026, 0, 1, 0, opts.index).toISOString(),
    userMessage: {
      role: "user",
      content: [{ type: "text", text: opts.user ?? `提问 ${opts.index}` }],
    },
    assistantMessage: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
    toolCalls: opts.toolCalls?.map((tc) => ({
      id: tc.id,
      name: tc.name,
      input: tc.input,
      result: tc.result,
      isError: tc.isError,
    })),
    usage: { inputTokens: 100, outputTokens: 50 },
  };
}

function makeRaw(opts: {
  turns?: Turn[];
  compact?: CompactMarker | null;
}): RawTranscript {
  return {
    header: {
      type: "header",
      version: 1,
      conversationId: "test-conv",
      name: null,
      projectPath: "/x",
      createdAt: new Date(2026, 0, 1).toISOString(),
      model: "m",
      provider: "p",
    },
    turns: opts.turns ?? [],
    compactBefore: opts.compact ?? null,
  };
}

function makeDeps(
  raw: RawTranscript,
  opts: { conversationId?: string | null } = {},
) {
  // null 哨兵代表"显式无 conversation"，与"未指定（默认 test-conv）"区分
  const id = "conversationId" in opts ? opts.conversationId : "test-conv";
  return {
    loadRaw: async () => raw,
    getConversationId: () => (id == null ? undefined : id),
  };
}

const ctx: ToolExecutionContext = { workingDirectory: "/tmp" };

// ─── 输入校验 ───

describe("recall_history · 输入校验", () => {
  it("缺少 turnRange 与 toolUseId → 错", async () => {
    const tool = createRecallHistoryTool(makeDeps(makeRaw({})));
    const r = await tool.call({}, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/either.*turnRange.*or.*toolUseId/);
  });

  it("同时传 turnRange 与 toolUseId → 错", async () => {
    const tool = createRecallHistoryTool(makeDeps(makeRaw({})));
    const r = await tool.call(
      { turnRange: { start: 1, end: 1 }, toolUseId: "u1" },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/exactly one of/);
  });

  it("turnRange.start < 1 → 错", async () => {
    const tool = createRecallHistoryTool(makeDeps(makeRaw({})));
    const r = await tool.call({ turnRange: { start: 0, end: 2 } }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/1-based/);
  });

  it("turnRange.end < start → 错", async () => {
    const tool = createRecallHistoryTool(makeDeps(makeRaw({})));
    const r = await tool.call({ turnRange: { start: 5, end: 2 } }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/end.*>=.*start/);
  });

  it("turnRange 字段类型错 → 错", async () => {
    const tool = createRecallHistoryTool(makeDeps(makeRaw({})));
    const r = await tool.call(
      { turnRange: { start: "1", end: 2 } } as unknown as Record<string, unknown>,
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/must.*be.*numbers/);
  });
});

// ─── 无 conversation ───

describe("recall_history · 非对话场景", () => {
  it("getConversationId 返 undefined → 友好错误", async () => {
    const tool = createRecallHistoryTool(
      makeDeps(makeRaw({}), { conversationId: null }),
    );
    const r = await tool.call({ turnRange: { start: 1, end: 1 } }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/no conversation id/);
  });
});

// ─── turnRange 模式 ───

describe("recall_history · turnRange", () => {
  it("命中区间 → 返回区间内所有 turn", async () => {
    const raw = makeRaw({
      turns: [
        makeTurn({ index: 1, user: "Q1", assistant: "A1" }),
        makeTurn({ index: 2, user: "Q2", assistant: "A2" }),
        makeTurn({ index: 3, user: "Q3", assistant: "A3" }),
      ],
    });
    const tool = createRecallHistoryTool(makeDeps(raw));
    const r = await tool.call({ turnRange: { start: 2, end: 3 } }, ctx);

    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("Turn 2");
    expect(r.content).toContain("Q2");
    expect(r.content).toContain("A2");
    expect(r.content).toContain("Turn 3");
    expect(r.content).toContain("Q3");
    expect(r.content).not.toContain("Q1"); // 区间外不返
  });

  it("含 toolCalls → 列出工具调用与 result 预览", async () => {
    const raw = makeRaw({
      turns: [
        makeTurn({
          index: 1,
          toolCalls: [
            {
              id: "u1",
              name: "read",
              input: { path: "foo.ts" },
              result: "line1\nline2",
            },
          ],
        }),
      ],
    });
    const tool = createRecallHistoryTool(makeDeps(raw));
    const r = await tool.call({ turnRange: { start: 1, end: 1 } }, ctx);

    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("read");
    expect(r.content).toContain('"path":"foo.ts"');
    expect(r.content).toContain("line1");
  });

  it("范围完全在 frontier 之前 → isError + 提示 frontier summary", async () => {
    const compact: CompactMarker = {
      type: "compact",
      timestamp: new Date(2026, 0, 1).toISOString(),
      summary: "（frontier 摘要内容）",
      turnsCompacted: 5,
      tokensBefore: 8000,
      tokensAfter: 1500,
    };
    const raw = makeRaw({
      compact,
      turns: [makeTurn({ index: 6 }), makeTurn({ index: 7 })],
    });
    const tool = createRecallHistoryTool(makeDeps(raw));
    const r = await tool.call({ turnRange: { start: 1, end: 3 } }, ctx);

    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/before the first persisted turn/);
    expect(r.content).toContain("（frontier 摘要内容）");
  });

  it("范围跨 frontier → 头部带 compact summary header + 后续 raw turns", async () => {
    const compact: CompactMarker = {
      type: "compact",
      timestamp: new Date(2026, 0, 1).toISOString(),
      summary: "前期摘要",
      turnsCompacted: 5,
      tokensBefore: 8000,
      tokensAfter: 1500,
    };
    const raw = makeRaw({
      compact,
      turns: [makeTurn({ index: 6, user: "Q6" })],
    });
    const tool = createRecallHistoryTool(makeDeps(raw));
    const r = await tool.call({ turnRange: { start: 4, end: 6 } }, ctx);

    expect(r.isError).toBeUndefined();
    expect(r.content).toMatch(/Turns 4-5 \(compacted/);
    expect(r.content).toContain("前期摘要");
    expect(r.content).toContain("Turn 6");
    expect(r.content).toContain("Q6");
  });

  it("范围超出最后 turn → isError + 边界信息", async () => {
    const raw = makeRaw({
      turns: [makeTurn({ index: 1 }), makeTurn({ index: 2 })],
    });
    const tool = createRecallHistoryTool(makeDeps(raw));
    const r = await tool.call({ turnRange: { start: 5, end: 7 } }, ctx);

    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/beyond the last persisted turn/);
    expect(r.content).toContain("1-2");
  });

  it("空 transcript → 友好提示", async () => {
    const raw = makeRaw({});
    const tool = createRecallHistoryTool(makeDeps(raw));
    const r = await tool.call({ turnRange: { start: 1, end: 3 } }, ctx);
    // 空 transcript 不算错（用户问的就是查询），content 解释清楚即可
    expect(r.content).toMatch(/no turns yet/);
  });
});

// ─── toolUseId 模式 ───

describe("recall_history · toolUseId", () => {
  it("命中 → 返回 tool 调用记录（name / input / result）", async () => {
    const raw = makeRaw({
      turns: [
        makeTurn({
          index: 1,
          toolCalls: [
            {
              id: "u1",
              name: "read",
              input: { path: "a.ts" },
              result: "aa\nbb\ncc",
            },
            {
              id: "u2",
              name: "bash",
              input: { command: "ls" },
              result: "file1\nfile2",
            },
          ],
        }),
      ],
    });
    const tool = createRecallHistoryTool(makeDeps(raw));
    const r = await tool.call({ toolUseId: "u2" }, ctx);

    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("turn 1");
    expect(r.content).toContain("u2");
    expect(r.content).toContain("bash");
    expect(r.content).toContain('"command":"ls"');
    expect(r.content).toContain("file1");
    expect(r.content).toContain("file2");
  });

  it("失败工具调用 → 标识 error 状态", async () => {
    const raw = makeRaw({
      turns: [
        makeTurn({
          index: 1,
          toolCalls: [
            {
              id: "u1",
              name: "read",
              input: { path: "missing.ts" },
              result: "ENOENT",
              isError: true,
            },
          ],
        }),
      ],
    });
    const tool = createRecallHistoryTool(makeDeps(raw));
    const r = await tool.call({ toolUseId: "u1" }, ctx);

    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("error");
    expect(r.content).toContain("ENOENT");
  });

  it("未找到（含 frontier）→ isError + 提示已被 compact", async () => {
    const compact: CompactMarker = {
      type: "compact",
      timestamp: new Date(2026, 0, 1).toISOString(),
      summary: "...",
      turnsCompacted: 3,
      tokensBefore: 5000,
      tokensAfter: 1000,
    };
    const raw = makeRaw({
      compact,
      turns: [
        makeTurn({
          index: 4,
          toolCalls: [
            { id: "u-current", name: "read", input: { path: "x" }, result: "x" },
          ],
        }),
      ],
    });
    const tool = createRecallHistoryTool(makeDeps(raw));
    const r = await tool.call({ toolUseId: "u-old" }, ctx);

    expect(r.isError).toBe(true);
    expect(r.content).toContain("not found");
    expect(r.content).toMatch(/3 earlier turn\(s\) were compacted/);
  });

  it("未找到（无 frontier）→ isError + 不带 compact 提示", async () => {
    const raw = makeRaw({
      turns: [
        makeTurn({
          index: 1,
          toolCalls: [
            { id: "u1", name: "read", input: { path: "x" }, result: "ok" },
          ],
        }),
      ],
    });
    const tool = createRecallHistoryTool(makeDeps(raw));
    const r = await tool.call({ toolUseId: "u-missing" }, ctx);

    expect(r.isError).toBe(true);
    expect(r.content).toContain("not found");
    expect(r.content).not.toMatch(/compacted/);
  });

  it("跨 turn 查找：第二个 turn 的 toolCall 也能命中", async () => {
    const raw = makeRaw({
      turns: [
        makeTurn({
          index: 1,
          toolCalls: [
            { id: "u1", name: "read", input: { path: "a" }, result: "a" },
          ],
        }),
        makeTurn({
          index: 2,
          toolCalls: [
            { id: "u2", name: "read", input: { path: "b" }, result: "b-data" },
          ],
        }),
      ],
    });
    const tool = createRecallHistoryTool(makeDeps(raw));
    const r = await tool.call({ toolUseId: "u2" }, ctx);

    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("turn 2");
    expect(r.content).toContain("b-data");
  });

  it("同 (name, input) 并行多次调用：按 record.id 正确区分（同参不同 id 各自命中）", async () => {
    // 边界场景：assistant 一次性发 read({path:"foo.ts"}) × 2（u1, u2 协议允许同参）。
    // 持久化 record.id 直接是 tool_use.id，无需任何位置 / 内容反推。
    const raw = makeRaw({
      turns: [
        makeTurn({
          index: 1,
          toolCalls: [
            { id: "u1", name: "read", input: { path: "foo.ts" }, result: "first-call-content" },
            { id: "u2", name: "read", input: { path: "foo.ts" }, result: "second-call-content" },
          ],
        }),
      ],
    });
    const tool = createRecallHistoryTool(makeDeps(raw));

    const r1 = await tool.call({ toolUseId: "u1" }, ctx);
    expect(r1.isError).toBeUndefined();
    expect(r1.content).toContain("first-call-content");
    expect(r1.content).not.toContain("second-call-content");

    const r2 = await tool.call({ toolUseId: "u2" }, ctx);
    expect(r2.isError).toBeUndefined();
    expect(r2.content).toContain("second-call-content");
    expect(r2.content).not.toContain("first-call-content");
  });

  it("真实多轮 tool-loop 形态：assistantMessage 是纯文本总结，toolCalls 跨多个中间 assistant", async () => {
    // 真实持久化形态：单 turn 内 LLM 多次 call → newMessages 含
    //   [ass1(tool_use u1), user(toolResult u1), ass2(tool_use u2), user(toolResult u2), ass3("done")]
    // turn-builder.findLastAssistant 取 ass3（纯文本），toolCalls 跨 ass1+ass2。
    // record.id 持久化保证按 toolUseId 仍能命中任一 record。
    const raw = makeRaw({
      turns: [
        makeTurn({
          index: 1,
          assistant: "已完成两步操作", // 最后一条 assistant 是纯文本总结
          toolCalls: [
            { id: "u1", name: "read", input: { path: "a.ts" }, result: "alpha" },
            { id: "u2", name: "bash", input: { command: "ls" }, result: "beta" },
          ],
        }),
      ],
    });
    const tool = createRecallHistoryTool(makeDeps(raw));

    // 中间 tool_use（u1）能命中 —— 即便 assistantMessage 不含 tool_use 块
    const r1 = await tool.call({ toolUseId: "u1" }, ctx);
    expect(r1.isError).toBeUndefined();
    expect(r1.content).toContain("alpha");
    expect(r1.content).toContain("read");

    // 后段 tool_use（u2）也能命中
    const r2 = await tool.call({ toolUseId: "u2" }, ctx);
    expect(r2.isError).toBeUndefined();
    expect(r2.content).toContain("beta");
    expect(r2.content).toContain("bash");
  });

  it("老 transcript 兼容：record.id 字段缺失（id 引入前写入）→ 任意 toolUseId 查找返 not found", async () => {
    // 老格式：record 只有 (name, input, result, isError)，没 id。直接 record.id ===
    // toolUseId 比较时 undefined !== "u1" 自动返 false → not found。这是与
    // "已 compact 不可达"对等的"持久化层信息已丢失"语义，不应通过派生伪 id 伪造可达性。
    const raw = makeRaw({
      turns: [
        makeTurn({
          index: 1,
          toolCalls: [
            // 注意：此处不传 id，模拟老 transcript 的 record 形态
            { name: "read", input: { path: "x.ts" }, result: "legacy-content" },
          ],
        }),
      ],
    });
    const tool = createRecallHistoryTool(makeDeps(raw));

    const r = await tool.call({ toolUseId: "u-anything" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("not found");
  });
});

// ─── loadRaw 抛错 ───

describe("recall_history · loadRaw 错误传递", () => {
  it("loadRaw throws → 友好错误", async () => {
    const tool = createRecallHistoryTool({
      loadRaw: async () => {
        throw new Error("disk failure");
      },
      getConversationId: () => "test-conv",
    });
    const r = await tool.call({ turnRange: { start: 1, end: 1 } }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("disk failure");
  });
});
