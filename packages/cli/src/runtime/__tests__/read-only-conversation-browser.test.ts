import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderReadOnlyConversationBrowser } from "../read-only-conversation-browser.js";
import type { CliWriter } from "../../screen/index.js";

let oldHome: string | undefined;
let home: string;

beforeEach(async () => {
  oldHome = process.env.ZHIXING_HOME;
  home = await fs.mkdtemp(path.join(process.cwd(), ".tmp-readonly-browser-"));
  process.env.ZHIXING_HOME = home;
});

afterEach(async () => {
  if (oldHome === undefined) {
    delete process.env.ZHIXING_HOME;
  } else {
    process.env.ZHIXING_HOME = oldHome;
  }
  await fs.rm(home, { recursive: true, force: true });
});

describe("read-only conversation browser", () => {
  it("只读渲染最近对话与最近 run，不需要宿主连接", async () => {
    await writeConversation("chat-a", "旧对话", "2026-01-01T00:00:00.000Z", [
      run("早一点", "旧回复", 0),
    ]);
    await writeConversation("chat-b", "最近对话", "2026-01-02T00:00:00.000Z", [
      run("用户问题", "AI 回复", 0),
    ]);

    const { writer, lines } = makeWriter();
    const result = await renderReadOnlyConversationBrowser({
      writer,
      error: new Error("host down"),
      maxConversations: 1,
      width: 100,
    });

    expect(result).toEqual({ conversations: 1, renderedRuns: 1 });
    expect(lines.join("\n")).toContain("核心宿主不可用");
    expect(lines.join("\n")).toContain("最近对话 (chat-b)");
    expect(lines.join("\n")).toContain("用户问题");
    expect(lines.join("\n")).toContain("AI 回复");
    expect(lines.join("\n")).not.toContain("旧对话");
  });

  it("遇到 clear 边界时不读穿旧历史", async () => {
    await writeConversation("chat-clear", "清空过", "2026-01-02T00:00:00.000Z", [
      run("旧问题", "旧回复", 0),
      { type: "clear", timestamp: "2026-01-02T00:00:00.000Z" },
    ]);

    const { writer, lines } = makeWriter();
    const result = await renderReadOnlyConversationBrowser({
      writer,
      error: "offline",
      maxConversations: 1,
      width: 100,
    });

    expect(result).toEqual({ conversations: 1, renderedRuns: 0 });
    expect(lines.join("\n")).toContain("暂无可显示的最近轮次");
    expect(lines.join("\n")).not.toContain("旧问题");
  });

  it("index 缺失时仍从分片只读重建投影并渲染最近 run", async () => {
    await writeConversation("chat-rebuild", "索引缺失", "2026-01-02T00:00:00.000Z", [
      run("仍可读取", "分片回复", 0),
    ]);
    await fs.unlink(
      path.join(home, "conversations", "chat-rebuild", "transcript", "index.json"),
    );

    const { writer, lines } = makeWriter();
    const result = await renderReadOnlyConversationBrowser({
      writer,
      error: "offline",
      maxConversations: 1,
      width: 100,
    });

    expect(result).toEqual({ conversations: 1, renderedRuns: 1 });
    expect(lines.join("\n")).toContain("仍可读取");
    expect(lines.join("\n")).toContain("分片回复");
  });

  it("index 结构损坏时仍从分片只读重建投影并渲染最近 run", async () => {
    await writeConversation("chat-bad-index", "索引损坏", "2026-01-02T00:00:00.000Z", [
      run("坏索引也能读", "仍走分片", 0),
    ]);
    await fs.writeFile(
      path.join(home, "conversations", "chat-bad-index", "transcript", "index.json"),
      JSON.stringify({ shards: null }),
    );

    const { writer, lines } = makeWriter();
    const result = await renderReadOnlyConversationBrowser({
      writer,
      error: "offline",
      maxConversations: 1,
      width: 100,
    });

    expect(result).toEqual({ conversations: 1, renderedRuns: 1 });
    expect(lines.join("\n")).toContain("坏索引也能读");
    expect(lines.join("\n")).toContain("仍走分片");
  });
});

async function writeConversation(
  id: string,
  name: string,
  lastActiveAt: string,
  records: unknown[],
): Promise<void> {
  const dir = path.join(home, "conversations", id);
  const transcript = path.join(dir, "transcript");
  await fs.mkdir(transcript, { recursive: true });
  await fs.writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify({
      id,
      name,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActiveAt,
      archived: false,
      isDefault: false,
      scope: { kind: "user" },
    }),
  );
  await fs.writeFile(
    path.join(transcript, "index.json"),
    JSON.stringify({
      version: 1,
      conversationId: id,
      activeShardId: "000001",
      shards: [
        {
          id: "000001",
          file: "000001.jsonl",
          createdAt: "2026-01-01T00:00:00.000Z",
          isActive: true,
        },
      ],
    }),
  );
  await fs.writeFile(
    path.join(transcript, "000001.jsonl"),
    [
      JSON.stringify({
        type: "header",
        version: 1,
        conversationId: id,
        shardId: "000001",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      ...records.map((record) => JSON.stringify(record)),
      "",
    ].join("\n"),
  );
}

function makeWriter(): { writer: CliWriter; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    writer: {
      line: (s) => lines.push(s),
      appendInline: (s) => lines.push(s),
      notify: (s) => lines.push(s),
      ensureSegmentBreak: () => {},
    },
  };
}

function run(user: string, assistant: string, runIndex: number) {
  return {
    type: "run",
    runIndex,
    timestamp: "2026-01-01T00:00:00.000Z",
    messages: [
      { role: "user", content: [{ type: "text", text: user }] },
      { role: "assistant", content: [{ type: "text", text: assistant }] },
    ],
    source: { kind: "interactive" },
  };
}
