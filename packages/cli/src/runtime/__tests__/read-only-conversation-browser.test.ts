import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listReadOnlyConversations, queryReadOnlyConversationHistory } from "../read-only-conversation-query.js";
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

describe("read-only conversation query", () => {
  it("lists the most recent conversation and reads its committed history without a Host", async () => {
    await writeConversation("old", "旧对话", "2026-01-01T00:00:00.000Z", [run("旧问题", "旧回复", 0)]);
    await writeConversation("recent", "最近对话", "2026-01-02T00:00:00.000Z", [run("用户问题", "AI 回复", 0)]);
    const storage = createReadOnlyConversationStorage(home);
    expect((await listReadOnlyConversations(storage, 1)).map(item => item.conversationId)).toEqual(["recent"]);
    const result = await queryReadOnlyConversationHistory(storage, "recent", 1);
    expect(result.renderedRuns).toBe(1);
    expect(result.history.entries[0]).toMatchObject({ userText: "用户问题", assistantText: "AI 回复" });
  });
  it("does not cross a clear boundary", async () => {
    await writeConversation("cleared", "清空过", "2026-01-02T00:00:00.000Z", [
      run("旧问题", "旧回复", 0), { type: "clear", timestamp: "2026-01-02T00:00:00.000Z" },
    ]);
    const result = await queryReadOnlyConversationHistory(createReadOnlyConversationStorage(home), "cleared", 1);
    expect(result).toEqual({ history: { entries: [] }, renderedRuns: 0 });
  });
  it.each(["missing", "corrupt"] as const)("reconstructs a %s index from the read-only shards", async condition => {
    await writeConversation("rebuild", "重建", "2026-01-02T00:00:00.000Z", [run("仍可读取", "分片回复", 0)]);
    const index = path.join(home, "conversations", "rebuild", "transcript", "index.json");
    if (condition === "missing") await fs.unlink(index);
    else await fs.writeFile(index, JSON.stringify({ shards: null }));
    const result = await queryReadOnlyConversationHistory(createReadOnlyConversationStorage(home), "rebuild", 1);
    expect(result.renderedRuns).toBe(1);
    expect(result.history.entries[0]).toMatchObject({ userText: "仍可读取", assistantText: "分片回复" });
  });
  it("accepts historical metadata without createdAt", async () => {
    await writeConversation("legacy", "旧元数据", "2026-01-02T00:00:00.000Z", [run("仍可浏览", "兼容回复", 0)]);
    const file = path.join(home, "conversations", "legacy", "meta.json");
    const metadata = JSON.parse(await fs.readFile(file, "utf8")); delete metadata.createdAt;
    await fs.writeFile(file, JSON.stringify(metadata));
    const storage = createReadOnlyConversationStorage(home);
    expect((await listReadOnlyConversations(storage, 1))[0]?.conversationId).toBe("legacy");
    expect((await queryReadOnlyConversationHistory(storage, "legacy", 1)).history.entries[0]?.userText).toBe("仍可浏览");
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
