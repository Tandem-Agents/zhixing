import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderReadOnlyConversationBrowser } from "../read-only-conversation-browser.js";
import { CoreHostUnavailableError } from "../core-host-connection.js";
import { listReadOnlyConversations, queryReadOnlyConversationHistory } from "../read-only-conversation-query.js";
import type { CliWriter } from "../../screen/index.js";
import { createReadOnlyConversationStorage } from "../../serve/conversation-storage-infrastructure.js";

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
  it.each(["pending", "read-failed", "projection-failed"])("后项%s仍保留已显示的前项历史", async scenario => {
    await writeConversation("first", "首个对话", "2026-01-03T00:00:00.000Z", [run("已读问题", "已读回复", 0)]);
    await writeConversation("second", "后续对话", "2026-01-02T00:00:00.000Z", []);
    const storage = createReadOnlyConversationStorage(home);
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof storage.readHistory>>>();
    const readHistory = vi.fn((id: string, options: Parameters<typeof storage.readHistory>[1]) =>
      id === "second" ? pending.promise : storage.readHistory(id, options));
    const { writer, lines } = makeWriter();
    const outcome = renderReadOnlyConversationBrowser({
      writer, error: "offline", storage: { list: () => storage.list(), readHistory }, width: 100,
    }).then(result => ({ result }), error => ({ error }));
    await vi.waitFor(() => expect(readHistory).toHaveBeenCalledWith("second", { limit: 1 }));
    expect(lines.join("\n")).toContain("已读问题");
    expect(lines.join("\n")).toContain("已读回复");
    expect(lines.join("\n")).toContain("后续对话 (second)");
    if (scenario === "read-failed") pending.reject(new Error("synthetic read failure"));
    else pending.resolve(scenario === "pending" ? { runs: [], hasMore: false } : {
      runs: [{ shardId: "000001", record: { ...run("unused", "unused", 0), messages: [] } }], hasMore: false,
    } as Awaited<ReturnType<typeof storage.readHistory>>);
    expect(await outcome).toHaveProperty(scenario === "pending" ? "result" : "error");
    expect(lines.join("\n")).toContain("已读回复");
  });

  it("shows only the public startup summary and a direct evidence command", async () => {
    const { writer, lines } = makeWriter();
    await renderReadOnlyConversationBrowser({
      writer, error: new CoreHostUnavailableError("private failure detail", "本机服务启动失败。"),
      storage: createReadOnlyConversationStorage(home),
    });
    expect(lines.join("\n")).toContain("本机服务启动失败。");
    expect(lines.join("\n")).toContain("zz logs search --source runtime");
    expect(lines.join("\n")).not.toContain("private failure detail");
  });
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
      storage: createReadOnlyConversationStorage(home),
      maxConversations: 1,
      width: 100,
    });

    expect(result).toEqual({ conversations: 1, renderedRuns: 1 });
    expect(lines.join("\n")).toContain("知行暂时无法启动");
    expect(lines.join("\n")).not.toContain("host down");
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
      storage: createReadOnlyConversationStorage(home),
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
      storage: createReadOnlyConversationStorage(home),
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
      storage: createReadOnlyConversationStorage(home),
      maxConversations: 1,
      width: 100,
    });

    expect(result).toEqual({ conversations: 1, renderedRuns: 1 });
    expect(lines.join("\n")).toContain("坏索引也能读");
    expect(lines.join("\n")).toContain("仍走分片");
  });

  it("保持旧只读入口对缺 createdAt meta 的宽松接受", async () => {
    await writeConversation("chat-legacy", "旧元数据", "2026-01-02T00:00:00.000Z", [
      run("仍可浏览", "兼容回复", 0),
    ]);
    const metaPath = path.join(home, "conversations", "chat-legacy", "meta.json");
    const meta = JSON.parse(await fs.readFile(metaPath, "utf8")) as Record<
      string,
      unknown
    >;
    delete meta.createdAt;
    await fs.writeFile(metaPath, JSON.stringify(meta));

    const { writer, lines } = makeWriter();
    await expect(
      renderReadOnlyConversationBrowser({
        writer,
        error: "offline",
        storage: createReadOnlyConversationStorage(home),
        maxConversations: 1,
        width: 100,
      }),
    ).resolves.toEqual({ conversations: 1, renderedRuns: 1 });
    expect(lines.join("\n")).toContain("旧元数据 (chat-legacy)");
    expect(lines.join("\n")).toContain("仍可浏览");
  });
});

it("只读查询继续消费 owner 的归档过滤与 limit/before 倒读页", async () => {
  await writeConversation("archived", "已归档", "2026-01-04T00:00:00.000Z", [run("不显示", "归档回复", 0)]);
  const archivedPath = path.join(home, "conversations", "archived", "meta.json");
  const meta = JSON.parse(await fs.readFile(archivedPath, "utf8"));
  await fs.writeFile(archivedPath, JSON.stringify({ ...meta, archived: true }));
  await writeConversation("paged", "分页", "2026-01-03T00:00:00.000Z", [run("较旧", "旧回复", 0), run("最新", "新回复", 1)]);
  const storage = createReadOnlyConversationStorage(home);
  const entries = await listReadOnlyConversations(storage, 5);
  expect(entries.map(item => item.conversationId)).toEqual(["paged"]);
  const result = await queryReadOnlyConversationHistory(storage, "paged", 1);
  expect(result.history.entries[0]?.userText).toBe("最新");
  expect(JSON.stringify(result)).not.toContain("\u001b");
  const first = await storage.readHistory("paged", { limit: 1 });
  const cursor = first.runs[0]!;
  const next = await storage.readHistory("paged", { limit: 1, before: { shardId: cursor.shardId, runIndex: cursor.record.runIndex } });
  expect(next.runs[0]?.record.messages[0]?.content).toEqual([{ type: "text", text: "较旧" }]);
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
