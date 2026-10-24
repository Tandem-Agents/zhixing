import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createReadOnlyConversationStorage } from "../conversation-storage-infrastructure.js";
import { extractFirstText } from "@zhixing/core";
import { toSafePathSegment } from "@zhixing/core/paths";
import { worksceneConversationId } from "@zhixing/core/conversation";
import { createTempDir } from "@zhixing/test-utils";
import { createConversationStorageInfrastructure } from "../conversation-storage-infrastructure.js";
import { createWorksceneStorageCleanupInfrastructure } from "../workscene-storage-cleanup.js";
import { TranscriptByteReader } from "@zhixing/core/transcript";

let previousHome: string | undefined;

beforeEach(async () => {
  previousHome = process.env.ZHIXING_HOME;
  process.env.ZHIXING_HOME = await createTempDir("conversation-storage");
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.ZHIXING_HOME;
  else process.env.ZHIXING_HOME = previousHome;
});

describe("conversation storage infrastructure", () => {
  it("uses the owner count without traversing old context and preserves bootstrap/snapshot/clear semantics", async () => {
    const root = await createTempDir("bootstrap-owner-count");
    const storage = createConversationStorageInfrastructure({
      zhixingHome: root, optimalMaxTokens: 4_000,
      worksceneConversationStorageRemoval: createWorksceneStorageCleanupInfrastructure({ zhixingHome: root }).conversations,
    });
    const { conversationId } = await storage.directory.create();
    for (let i = 0; i < 30; i++) {
      await storage.runtime.appendCommittedRun(conversationId, run(`row-${i}:` + "x".repeat(3000), i));
    }
    await storage.runtime.writeSnapshot(conversationId, {
      coveredThroughRunIndex: 10,
      structuredSummary: { facts: "PRESERVED-EARLIER-FACT", state: "", active: "" },
      tokensBefore: 100, tokensAfter: 10,
    });
    const expected = await storage.runtime.loadHistory(conversationId);
    const records = TranscriptByteReader.prototype.records;
    let visited = 0;
    const spy = vi.spyOn(TranscriptByteReader.prototype, "records").mockImplementation(async function* (this: TranscriptByteReader, ...args) {
      for await (const record of records.apply(this, args)) { visited++; yield record; }
    });
    const actual = await storage.runtime.loadHistory(conversationId, 30);
    expect(actual).toEqual(expected);
    expect(visited).toBeLessThanOrEqual(2);
    expect(JSON.stringify(actual?.bootstrap)).toContain("PRESERVED-EARLIER-FACT");
    expect(JSON.stringify(actual?.bootstrap)).toContain("row-29");
    spy.mockRestore();
    await storage.directory.clearStoredView(conversationId);
    expect(await storage.runtime.loadHistory(conversationId, 0)).toBeUndefined();
    await storage.runtime.appendCommittedRun(conversationId, run("AFTER-CLEAR", 30));
    const after = await storage.runtime.loadHistory(conversationId, 1);
    expect(after?.turnCount).toBe(1);
    expect(JSON.stringify(after?.bootstrap)).toContain("AFTER-CLEAR");
    expect(JSON.stringify(after?.bootstrap)).not.toContain("PRESERVED-EARLIER-FACT");
  }, 30_000);

  it("counts a transcript-only conversation and its clear boundary from one published view without enumerating records", async () => {
    const root = await createTempDir("bootstrap-view-count");
    const storage = createConversationStorageInfrastructure({
      zhixingHome: root, optimalMaxTokens: 4_000,
      worksceneConversationStorageRemoval: createWorksceneStorageCleanupInfrastructure({ zhixingHome: root }).conversations,
    });
    const { conversationId } = await storage.directory.create();
    for (let i = 0; i < 30; i++) {
      await storage.runtime.appendCommittedRun(conversationId, run(`row-${i}:` + "x".repeat(3000), i));
    }
    await storage.runtime.writeSnapshot(conversationId, {
      coveredThroughRunIndex: 10,
      structuredSummary: { facts: "FACT-BEFORE-CLEAR", state: "", active: "" },
      tokensBefore: 100, tokensAfter: 10,
    });
    const records = TranscriptByteReader.prototype.records;
    let visited = 0;
    vi.spyOn(TranscriptByteReader.prototype, "records").mockImplementation(async function* (this: TranscriptByteReader, ...args) {
      for await (const record of records.apply(this, args)) { visited++; yield record; }
    });
    const loaded = await storage.runtime.loadHistory(conversationId);
    expect(loaded?.turnCount).toBe(30);
    expect(visited).toBeLessThanOrEqual(2);
    expect(JSON.stringify(loaded?.bootstrap)).toContain("FACT-BEFORE-CLEAR");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await storage.directory.clearStoredView(conversationId);
    expect(await storage.runtime.loadHistory(conversationId)).toBeUndefined();
    await storage.runtime.appendCommittedRun(conversationId, run("AFTER-CLEAR", 30));
    const after = await storage.runtime.loadHistory(conversationId);
    expect(after?.turnCount).toBe(1);
    expect(JSON.stringify(after?.bootstrap)).toContain("AFTER-CLEAR");
    expect(JSON.stringify(after?.bootstrap)).not.toContain("FACT-BEFORE-CLEAR");
  }, 30_000);

  it("opening a transcript-only conversation reads the same records and lists no directory at 8 / 32 / 128 runs", async () => {
    const root = await createTempDir("bootstrap-view-scale");
    const storage = createConversationStorageInfrastructure({
      zhixingHome: root, optimalMaxTokens: 4_000,
      worksceneConversationStorageRemoval: createWorksceneStorageCleanupInfrastructure({ zhixingHome: root }).conversations,
    });
    const rows: Array<{ n: number; visited: number; readdir: number }> = [];
    for (const n of [8, 32, 128]) {
      const { conversationId } = await storage.directory.create();
      for (let i = 0; i < n; i++) await storage.runtime.appendCommittedRun(conversationId, run(`row-${i}:` + "x".repeat(3000), i));
      await storage.runtime.writeSnapshot(conversationId, {
        coveredThroughRunIndex: n - 4,
        structuredSummary: { facts: "EARLIER", state: "", active: "" },
        tokensBefore: 100, tokensAfter: 10,
      });
      const records = TranscriptByteReader.prototype.records;
      let visited = 0;
      const recordsSpy = vi.spyOn(TranscriptByteReader.prototype, "records").mockImplementation(async function* (this: TranscriptByteReader, ...args) {
        for await (const record of records.apply(this, args)) { visited++; yield record; }
      });
      const readdir = vi.spyOn(fs, "readdir");
      try {
        expect((await storage.runtime.loadHistory(conversationId))?.turnCount).toBe(n);
        rows.push({ n, visited, readdir: readdir.mock.calls.length });
      } finally { recordsSpy.mockRestore(); readdir.mockRestore(); }
    }
    for (const row of rows) {
      expect(row.visited).toBe(rows[0]!.visited);
      expect(row.readdir).toBe(0);
    }
  }, 60_000);

  describe("opening a conversation treats the summary cache as optional", () => {
    async function fixture() {
      const root = await createTempDir("bootstrap-snapshot-cache");
      const storage = createConversationStorageInfrastructure({
        zhixingHome: root, optimalMaxTokens: 160,
        worksceneConversationStorageRemoval: createWorksceneStorageCleanupInfrastructure({ zhixingHome: root }).conversations,
      });
      const { conversationId } = await storage.directory.create();
      for (let i = 0; i < 6; i++) await storage.runtime.appendCommittedRun(conversationId, run(`USER-${i}-` + "-".repeat(500), i));
      await storage.runtime.writeSnapshot(conversationId, {
        coveredThroughRunIndex: 0,
        structuredSummary: { facts: "SUMMARY-0", state: "", active: "" },
        tokensBefore: 100, tokensAfter: 10,
      });
      const conversationDir = path.join(root, "conversations", toSafePathSegment(conversationId));
      const snapshots = path.join(conversationDir, "snapshots");
      return { storage, conversationId, conversationDir, snapshots, index: path.join(snapshots, "index.bin") };
    }

    it("uses the summary when the cache is healthy", async () => {
      const f = await fixture();
      const history = await f.storage.runtime.loadHistory(f.conversationId);
      expect(history?.turnCount).toBe(6);
      expect(JSON.stringify(history?.bootstrap)).toContain("SUMMARY-0");
    });

    it("opens from the transcript when reading the snapshot index fails", async () => {
      const f = await fixture();
      const open = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation((async (file: Parameters<typeof fs.open>[0], flags?: string, mode?: number) => {
        if (path.resolve(String(file)) === path.resolve(f.index)) throw Object.assign(new Error("injected snapshot index EIO"), { code: "EIO" });
        return open(file, flags, mode);
      }) as typeof fs.open);
      const history = await f.storage.runtime.loadHistory(f.conversationId);
      expect(history?.turnCount).toBe(6);
      expect(JSON.stringify(history?.bootstrap)).not.toContain("SUMMARY-0");
    });

    it("opens while an unfinished snapshot registration cannot be cleaned up", async () => {
      const f = await fixture();
      await new Promise((resolve) => setTimeout(resolve, 5)); // 新快照的 createdAt 必须晚于已登记的那份
      const open = fs.open.bind(fs), unlink = fs.unlink.bind(fs);
      const publish = vi.spyOn(fs, "open").mockImplementation((async (file: Parameters<typeof fs.open>[0], flags?: string, mode?: number) => {
        if (path.resolve(String(file)) === path.resolve(f.index) && flags === "r+") throw Object.assign(new Error("injected index publish error"), { code: "EIO" });
        return open(file, flags, mode);
      }) as typeof fs.open);
      vi.spyOn(fs, "unlink").mockImplementation((async (file: Parameters<typeof fs.unlink>[0]) => {
        if (path.dirname(path.resolve(String(file))) === path.resolve(f.snapshots) && String(file).endsWith(".json")) {
          throw Object.assign(new Error("injected pending snapshot EBUSY"), { code: "EBUSY" });
        }
        return unlink(file);
      }) as typeof fs.unlink);
      await expect(f.storage.runtime.writeSnapshot(f.conversationId, {
        coveredThroughRunIndex: 2, structuredSummary: { facts: "SUMMARY-2", state: "", active: "" }, tokensBefore: 100, tokensAfter: 10,
      })).rejects.toThrow();
      publish.mockRestore();
      const history = await f.storage.runtime.loadHistory(f.conversationId);
      expect(history?.turnCount).toBe(6);
      expect(JSON.stringify(history?.bootstrap)).toContain("SUMMARY-0");
      expect(JSON.stringify(history?.bootstrap)).not.toContain("SUMMARY-2");
    });

    it.each([null, ["facts"], { facts: "f", state: 1, active: "" }])("skips a summary body whose structure is not renderable (%j)", async (summary) => {
      const f = await fixture();
      const [name] = (await fs.readdir(f.snapshots)).filter((entry) => entry.endsWith(".json"));
      const file = path.join(f.snapshots, name!);
      const body = JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, unknown>;
      await fs.writeFile(file, JSON.stringify({ ...body, structuredSummary: summary }));
      const history = await f.storage.runtime.loadHistory(f.conversationId);
      expect(history?.turnCount).toBe(6);
      expect(JSON.stringify(history?.bootstrap)).not.toContain("SUMMARY-0");
    });

    it("degrades when both halves of the snapshot index root are damaged", async () => {
      const f = await fixture();
      await fs.writeFile(f.index, Buffer.alloc(1024));
      const history = await f.storage.runtime.loadHistory(f.conversationId);
      expect(history?.turnCount).toBe(6);
      expect(JSON.stringify(history?.bootstrap)).not.toContain("SUMMARY-0");
    });

    it("still fails the open when the transcript itself is damaged", async () => {
      const f = await fixture();
      const shard = path.join(f.conversationDir, "transcript", "000001.jsonl");
      await fs.truncate(shard, (await fs.stat(shard)).size - 10);
      await expect(f.storage.runtime.loadHistory(f.conversationId)).rejects.toThrow();
    });
  });

  it.each(['ENOENT', 'EACCES'])('classifies a read-only history directory failure without pretending unreadable data is absent (%s)', async code => {
    const root = await createTempDir('readonly-history-error');
    const failure = Object.assign(new Error('synthetic directory failure'), { code });
    vi.spyOn(fs, 'stat').mockRejectedValueOnce(failure);
    const read = createReadOnlyConversationStorage(root).list();
    if (code === 'ENOENT') expect(await read).toEqual([]);
    else await expect(read).rejects.toBe(failure);
  });

  it("keeps metadata, content, lazy scenes, naming and maintenance on the explicit home", async () => {
    const root = await createTempDir("storage-owner-root");
    const other = await createTempDir("storage-other-root");
    process.env.ZHIXING_HOME = other;
    const storage = createConversationStorageInfrastructure({
      zhixingHome: root, optimalMaxTokens: 20_000,
      worksceneConversationStorageRemoval: createWorksceneStorageCleanupInfrastructure({ zhixingHome: root }).conversations,
    });
    process.env.ZHIXING_HOME = await createTempDir("storage-later-root");
    const user = await storage.directory.create();
    const scene = worksceneConversationId("late-scene", "late-conversation");
    const tasks = { items: [{ id: "one", content: "retained", status: "pending" as const }] };
    for (const id of [user.conversationId, scene]) {
      await storage.directory.ensure(id);
      await storage.runtime.appendCommittedRun(id, run(id, 0));
      await storage.committedViews.persistTaskList(id, tasks);
      expect(await storage.taskLists.load(id)).toEqual(tasks);
      expect((await storage.runtime.loadHistory(id))?.turnCount).toBe(1);
      expect(await storage.maintenance.isConversationDataAlive(toSafePathSegment(id))).toBe(true);
    }
    await storage.runtime.writeSnapshot(user.conversationId, {
      coveredThroughRunIndex: 0, structuredSummary: { facts: "facts", state: "state", active: "active" },
      tokensBefore: 20, tokensAfter: 5,
    });
    expect((await fs.readdir(path.join(root, "conversations", toSafePathSegment(user.conversationId), "snapshots")))
      .filter((name) => name.endsWith(".json"))).toHaveLength(1);
    await storage.naming.rename(user.conversationId, "Owner root");
    expect((await storage.naming.get(user.conversationId))?.name).toBe("Owner root");
    await storage.maintenance.runRetentionSweep();
    const reader = createReadOnlyConversationStorage(root);
    expect((await reader.list()).some((entry) => entry.conversationId === user.conversationId)).toBe(true);
    expect((await reader.readHistory(user.conversationId, { limit: 1 })).runs).toHaveLength(1);
    await expect(fs.stat(path.join(other, "conversations"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(process.env.ZHIXING_HOME!, "workscenes"))).rejects.toMatchObject({ code: "ENOENT" });
    await storage.directory.deleteStoredConversation(scene);
    expect(await storage.maintenance.isConversationDataAlive(toSafePathSegment(scene))).toBe(false);
  });

  it("routes user and Workscene through one finite runtime/directory contract", async () => {
    const storage = createConversationStorageInfrastructure({
      zhixingHome: process.env.ZHIXING_HOME!,
      optimalMaxTokens: 20_000,
      worksceneConversationStorageRemoval:
        createWorksceneStorageCleanupInfrastructure({
          zhixingHome: process.env.ZHIXING_HOME!,
        }).conversations,
    });
    const user = await storage.directory.create();
    const workscene = worksceneConversationId("scene-storage", "conversation-1");
    await storage.directory.ensure(workscene);

    await storage.runtime.appendCommittedRun(user.conversationId, run("user", 0));
    await storage.runtime.appendCommittedRun(workscene, run("scene", 0));

    const userPage = await storage.directory.readHistory(user.conversationId, {
      limit: 1,
    });
    const scenePage = await storage.directory.readHistory(workscene, { limit: 1 });
    expect(extractFirstText(userPage.runs[0]!.record.messages[0]!)).toBe("user");
    expect(extractFirstText(scenePage.runs[0]!.record.messages[0]!)).toBe("scene");
    await expect(storage.runtime.loadHistory(user.conversationId)).resolves.toMatchObject({
      turnCount: 1,
    });
    await expect(storage.runtime.loadHistory(workscene)).resolves.toMatchObject({
      turnCount: 1,
    });
  });

  it("shares committed views, clear/delete, and maintenance routing without exposing stores", async () => {
    const storage = createConversationStorageInfrastructure({
      zhixingHome: process.env.ZHIXING_HOME!,
      optimalMaxTokens: 20_000,
      worksceneConversationStorageRemoval:
        createWorksceneStorageCleanupInfrastructure({
          zhixingHome: process.env.ZHIXING_HOME!,
        }).conversations,
    });
    const conversationId = worksceneConversationId("scene-storage", "conversation-2");
    await storage.directory.ensure(conversationId);
    await storage.runtime.appendCommittedRun(conversationId, run("before-clear", 0));

    const taskList = {
      items: [{ id: "task-1", content: "verify", status: "pending" as const }],
    };
    await storage.committedViews.persistTaskList(conversationId, taskList);
    await expect(storage.taskLists.load(conversationId)).resolves.toEqual(taskList);

    await expect(storage.directory.clearStoredView(conversationId)).resolves.toBe(true);
    await expect(storage.taskLists.load(conversationId)).resolves.toBeUndefined();
    await expect(storage.directory.readHistory(conversationId, { limit: 1 })).resolves.toEqual({
      runs: [],
      hasMore: false,
    });

    const encoded = toSafePathSegment(conversationId);
    await expect(storage.maintenance.isConversationDataAlive(encoded)).resolves.toBe(true);
    await expect(storage.directory.deleteStoredConversation(conversationId)).resolves.toBe(true);
    await expect(storage.maintenance.isConversationDataAlive(encoded)).resolves.toBe(false);
  });
});

function run(text: string, runIndex: number) {
  return {
    type: "run" as const,
    runId: `run-${runIndex}`,
    runIndex,
    timestamp: "2026-09-01T00:00:00.000Z",
    messages: [
      { role: "user" as const, content: [{ type: "text" as const, text }] },
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: `reply:${text}` }],
      },
    ],
  };
}
