import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { ConversationRepository } from "../repository.js";
import { toSafePathSegment } from "../../paths.js";
import {
  DEFAULT_CONVERSATION_ID,
  DEFAULT_CONVERSATION_NAME,
  type ConversationScope,
} from "../types.js";

// ─── 临时目录 & 环境变量 ───

let tmpDir: string;
let originalHome: string | undefined;

beforeEach(async () => {
  tmpDir = await createTempDir("conv");
  originalHome = process.env.ZHIXING_HOME;
  process.env.ZHIXING_HOME = tmpDir;
});

afterEach(async () => {
  if (originalHome === undefined) {
    delete process.env.ZHIXING_HOME;
  } else {
    process.env.ZHIXING_HOME = originalHome;
  }
});

// ─── Helpers ───

const USER_SCOPE: ConversationScope = { kind: "user" };

function createRepo(scope: ConversationScope = USER_SCOPE) {
  return new ConversationRepository(scope);
}

// ─── ensureDefault ───

describe("ensureDefault", () => {
  it("首次调用创建 default 对话", async () => {
    const repo = createRepo();
    const conv = await repo.ensureDefault();

    expect(conv.id).toBe(DEFAULT_CONVERSATION_ID);
    expect(conv.name).toBe(DEFAULT_CONVERSATION_NAME);
    expect(conv.isDefault).toBe(true);
    expect(conv.archived).toBe(false);
  });

  it("重复调用返回同一个 default", async () => {
    const repo = createRepo();
    const first = await repo.ensureDefault();
    const second = await repo.ensureDefault();

    expect(first.id).toBe(second.id);
    expect(first.createdAt).toBe(second.createdAt);
  });

  it("meta.json 写入磁盘", async () => {
    const repo = createRepo();
    await repo.ensureDefault();

    const metaFile = path.join(tmpDir, "conversations", "default", "meta.json");
    const content = JSON.parse(await fs.readFile(metaFile, "utf-8"));
    expect(content.id).toBe("default");
    expect(content.isDefault).toBe(true);
  });
});

// ─── create ───

describe("create", () => {
  it("无名称时生成 chat-YYYYMMDD-xxxx 格式 ID", async () => {
    const repo = createRepo();
    const conv = await repo.create({});

    expect(conv.id).toMatch(/^chat-\d{8}-[0-9a-f]{4}$/);
    expect(conv.name).toBe(conv.id);
    expect(conv.isDefault).toBe(false);
  });

  it("有名称时 slugify 为 ID", async () => {
    const repo = createRepo();
    const conv = await repo.create({ name: "工作日志" });

    expect(conv.name).toBe("工作日志");
    expect(conv.id).toBeTruthy();
    expect(conv.id).not.toBe("default");
  });

  it("保留 preferredModel 和 preferredProvider", async () => {
    const repo = createRepo();
    const conv = await repo.create({
      name: "test",
      preferredModel: "claude-opus-4-6",
      preferredProvider: "anthropic",
    });

    expect(conv.preferredModel).toBe("claude-opus-4-6");
    expect(conv.preferredProvider).toBe("anthropic");
  });

  it("create → get 一致", async () => {
    const repo = createRepo();
    const created = await repo.create({ name: "test" });
    const got = await repo.get(created.id);

    expect(got).toEqual(created);
  });

  it("名称冲突时自动追加序号", async () => {
    const repo = createRepo();
    const first = await repo.create({ name: "work" });
    const second = await repo.create({ name: "work" });

    expect(first.id).not.toBe(second.id);
    expect(second.id).toMatch(/^work-\d+$/);
  });
});

// ─── ensure ───

describe("ensure", () => {
  it("按显式 id 创建 meta，已存在时幂等返回原 meta", async () => {
    const repo = createRepo();
    const first = await repo.ensure("dm:feishu:ou_xxx");

    expect(first.id).toBe("dm:feishu:ou_xxx");
    expect(first.name).toBe("dm:feishu:ou_xxx");
    expect(first.scope).toEqual({ kind: "user" });

    const second = await repo.ensure("dm:feishu:ou_xxx", { name: "ignored" });
    expect(second).toEqual(first);
    expect(await repo.list()).toHaveLength(1);
  });

  it("显式 id 的目录段无碰撞，路径分隔符不进入目录层级", async () => {
    const repo = createRepo();
    const ids = ["dm:ch:u", "dm--ch--u", "dm:ch:u/nested\\tail"];

    for (const id of ids) {
      await repo.ensure(id);
      expect(await repo.get(id)).toMatchObject({ id });
    }

    expect((await repo.list()).map((c) => c.id).sort()).toEqual([...ids].sort());

    const unsafeSegment = toSafePathSegment(ids[2]!);
    expect(unsafeSegment.includes("/") || unsafeSegment.includes("\\")).toBe(false);
    expect(await fs.readdir(path.join(tmpDir, "conversations"))).toEqual(
      expect.arrayContaining(ids.map(toSafePathSegment)),
    );
  });

  it("default id 仍保持默认对话身份语义", async () => {
    const repo = createRepo();
    const conv = await repo.ensure("default");

    expect(conv.isDefault).toBe(true);
    expect(conv.name).toBe("默认对话");
  });
});

// ─── get ───

describe("get", () => {
  it("不存在的 ID 返回 null", async () => {
    const repo = createRepo();
    const result = await repo.get("nonexistent");
    expect(result).toBeNull();
  });
});

// ─── list ───

describe("list", () => {
  it("空仓库返回空数组", async () => {
    const repo = createRepo();
    const list = await repo.list();
    expect(list).toEqual([]);
  });

  it("按 lastActiveAt 倒序排列", async () => {
    const repo = createRepo();
    const a = await repo.create({ name: "a" });
    const b = await repo.create({ name: "b" });
    // touch b 使其更新
    await repo.touch(b.id);

    const list = await repo.list();
    expect(list.length).toBe(2);
    expect(list[0]!.id).toBe(b.id);
  });

  it("默认不返回已归档对话", async () => {
    const repo = createRepo();
    const conv = await repo.create({ name: "archived-test" });
    await repo.archive(conv.id, true);

    const list = await repo.list();
    expect(list.find((c) => c.id === conv.id)).toBeUndefined();
  });

  it("includeArchived 返回归档对话", async () => {
    const repo = createRepo();
    const conv = await repo.create({ name: "archived-test" });
    await repo.archive(conv.id, true);

    const list = await repo.list({ includeArchived: true });
    expect(list.find((c) => c.id === conv.id)).toBeDefined();
  });

  it("list 按 scope 隔离 (user vs workscene 路径独立)", async () => {
    const userRepo = createRepo({ kind: "user" });
    const worksceneRepo = createRepo({ kind: "workscene", sceneId: "scene-x" });

    await userRepo.create({ name: "user-conv" });
    await worksceneRepo.create({ name: "workscene-conv" });

    const userList = await userRepo.list();
    const worksceneList = await worksceneRepo.list();

    expect(userList).toHaveLength(1);
    expect(userList[0]!.name).toBe("user-conv");
    expect(worksceneList).toHaveLength(1);
    expect(worksceneList[0]!.name).toBe("workscene-conv");
  });
});

// ─── rename ───

describe("rename", () => {
  it("更新名称并持久化", async () => {
    const repo = createRepo();
    const conv = await repo.create({ name: "old" });
    const renamed = await repo.rename(conv.id, "new-name");

    expect(renamed.name).toBe("new-name");
    expect(renamed.id).toBe(conv.id);

    const reloaded = await repo.get(conv.id);
    expect(reloaded!.name).toBe("new-name");
  });

  it("不存在的 ID 抛错", async () => {
    const repo = createRepo();
    await expect(repo.rename("ghost", "x")).rejects.toThrow(/不存在/);
  });
});

// ─── archive ───

describe("archive", () => {
  it("归档后 list 不返回", async () => {
    const repo = createRepo();
    const conv = await repo.create({ name: "test" });
    await repo.archive(conv.id, true);

    const list = await repo.list();
    expect(list.find((c) => c.id === conv.id)).toBeUndefined();
  });

  it("取消归档后重新出现", async () => {
    const repo = createRepo();
    const conv = await repo.create({ name: "test" });
    await repo.archive(conv.id, true);
    await repo.archive(conv.id, false);

    const list = await repo.list();
    expect(list.find((c) => c.id === conv.id)).toBeDefined();
  });

  it("默认对话不可归档", async () => {
    const repo = createRepo();
    await repo.ensureDefault();
    await expect(
      repo.archive(DEFAULT_CONVERSATION_ID, true),
    ).rejects.toThrow(/默认对话/);
  });
});

// ─── delete ───

describe("delete", () => {
  it("删除后 get 返回 null", async () => {
    const repo = createRepo();
    const conv = await repo.create({ name: "to-delete" });
    await repo.delete(conv.id);

    const result = await repo.get(conv.id);
    expect(result).toBeNull();
  });

  it("物理删除目录(不残留 trash)", async () => {
    const repo = createRepo();
    const conv = await repo.create({ name: "physical-delete-test" });
    const convPath = path.join(tmpDir, "conversations", conv.id);
    expect(
      await fs
        .stat(convPath)
        .then(() => true)
        .catch(() => false),
    ).toBe(true);

    await repo.delete(conv.id);

    expect(
      await fs
        .stat(convPath)
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
    // trash 目录不应被创建
    await expect(fs.stat(path.join(tmpDir, "trash"))).rejects.toThrow();
  });

  it("默认对话也可删除(isDefault 守卫已释放)", async () => {
    const repo = createRepo();
    await repo.ensureDefault();
    await expect(repo.delete(DEFAULT_CONVERSATION_ID)).resolves.toBeUndefined();
    expect(await repo.get(DEFAULT_CONVERSATION_ID)).toBeNull();
  });

  it("删除不存在的 ID 不抛错(force:true)", async () => {
    const repo = createRepo();
    await expect(repo.delete("ghost")).resolves.toBeUndefined();
  });
});

// ─── touch ───

describe("touch", () => {
  it("更新 lastActiveAt", async () => {
    const repo = createRepo();
    const conv = await repo.create({ name: "touch-test" });
    const before = conv.lastActiveAt;

    await new Promise((r) => setTimeout(r, 10));
    await repo.touch(conv.id);

    const after = await repo.get(conv.id);
    expect(new Date(after!.lastActiveAt).getTime()).toBeGreaterThan(
      new Date(before).getTime(),
    );
  });
});

// ─── 原子写 + per-id 锁 ───

describe("writeMeta atomic + per-id lock", () => {
  it("同 id 多次并发 writeMeta 串行化（最后一次写为最终结果）", async () => {
    const repo = createRepo();
    const conv = await repo.create({ name: "lock-test" });

    // 并发触发多次 touch（每次改 lastActiveAt 后 writeMeta），期望全部完成且无 race
    const ops = Array.from({ length: 20 }, () => repo.touch(conv.id));
    await Promise.all(ops);

    // 文件存在且 JSON 完整可解析（atomic write 保证）
    const after = await repo.get(conv.id);
    expect(after).not.toBeNull();
    expect(after!.id).toBe(conv.id);
    expect(after!.name).toBe("lock-test");
  });

  it("不同 id 并发 writeMeta 不互斥", async () => {
    const repo = createRepo();
    const a = await repo.create({ name: "alpha" });
    const b = await repo.create({ name: "beta" });

    // 跨 id 并发 touch，应能完成
    await Promise.all([repo.touch(a.id), repo.touch(b.id), repo.touch(a.id)]);

    expect((await repo.get(a.id))?.name).toBe("alpha");
    expect((await repo.get(b.id))?.name).toBe("beta");
  });

  it("写入过程中无残留 .tmp 文件（atomic write 完成后 tmp 被 rename）", async () => {
    const repo = createRepo();
    const conv = await repo.create({ name: "atomic-test" });
    await repo.touch(conv.id);

    const dir = path.join(tmpDir, "conversations", conv.id);
    const entries = await fs.readdir(dir);
    expect(entries).toContain("meta.json");
    // 仅有 meta.json，无 .tmp 残留
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
  });

  it("crash 模拟：手动留下 .tmp 后再写不影响最终结果", async () => {
    const repo = createRepo();
    const conv = await repo.create({ name: "crash-sim" });

    const dir = path.join(tmpDir, "conversations", conv.id);
    // 手动放一个孤立 .tmp（模拟上次 crash 留下的）
    const orphanTmp = path.join(dir, "meta.json.orphan.tmp");
    await fs.writeFile(orphanTmp, "stale", "utf-8");

    // 后续写入正常完成
    await repo.touch(conv.id);

    const got = await repo.get(conv.id);
    expect(got).not.toBeNull();
    expect(got!.name).toBe("crash-sim");
    // meta.json 是有效 JSON
    const content = await fs.readFile(
      path.join(dir, "meta.json"),
      "utf-8",
    );
    expect(() => JSON.parse(content)).not.toThrow();
  });
});

// ─── 视图层状态字段持久化 + 清理 ───

describe("视图层状态字段（taskListState / segmentMetadata）", () => {
  /**
   * 写入视图层字段的辅助函数 —— 模拟 task_list / SegmentManager 未来直接写
   * conversation meta 的场景（PR-B3 内尚未有消费方）。
   */
  async function writeRawMeta(
    repo: ConversationRepository,
    id: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    const existing = await repo.get(id);
    if (!existing) throw new Error(`conversation "${id}" 不存在`);
    const merged = { ...existing, ...extra };
    const dir = path.join(tmpDir, "conversations", id);
    await fs.writeFile(
      path.join(dir, "meta.json"),
      JSON.stringify(merged, null, 2),
      "utf-8",
    );
  }

  it("taskListState 字段持久化往返", async () => {
    const repo = createRepo();
    const conv = await repo.create({ name: "task-list-test" });

    await writeRawMeta(repo, conv.id, {
      taskListState: {
        items: [
          { id: "t1", content: "调研 module X", status: "in_progress" },
          { id: "t2", content: "写测试", status: "pending" },
        ],
      },
    });

    const reloaded = await repo.get(conv.id);
    expect(reloaded?.taskListState).toBeDefined();
    expect(reloaded?.taskListState?.items).toHaveLength(2);
    expect(reloaded?.taskListState?.items[0]?.status).toBe("in_progress");
  });

  it("segmentMetadata 字段持久化往返", async () => {
    const repo = createRepo();
    const conv = await repo.create({ name: "segment-test" });

    await writeRawMeta(repo, conv.id, {
      segmentMetadata: {
        currentSegmentId: "seg-2",
        segments: [
          {
            segmentId: "seg-1",
            timestamp: "2026-05-11T10:00:00Z",
            tokensBefore: 130_000,
            tokensAfter: 800,
          },
          {
            segmentId: "seg-2",
            timestamp: "2026-05-11T12:00:00Z",
            tokensBefore: 140_000,
            tokensAfter: 900,
          },
        ],
      },
    });

    const reloaded = await repo.get(conv.id);
    expect(reloaded?.segmentMetadata?.currentSegmentId).toBe("seg-2");
    expect(reloaded?.segmentMetadata?.segments).toHaveLength(2);
  });

  it("clearViewLayerState 清空两个字段；身份字段保留", async () => {
    const repo = createRepo();
    const conv = await repo.create({
      name: "clear-test",
      preferredModel: "deepseek-v4-pro",
    });

    await writeRawMeta(repo, conv.id, {
      taskListState: { items: [{ id: "x", content: "y", status: "pending" }] },
      segmentMetadata: {
        currentSegmentId: "s1",
        segments: [],
      },
    });

    await repo.clearViewLayerState(conv.id);

    const reloaded = await repo.get(conv.id);
    expect(reloaded).not.toBeNull();
    // 视图层字段清空
    expect(reloaded?.taskListState).toBeUndefined();
    expect(reloaded?.segmentMetadata).toBeUndefined();
    // 身份字段保留
    expect(reloaded?.name).toBe("clear-test");
    expect(reloaded?.preferredModel).toBe("deepseek-v4-pro");
    expect(reloaded?.id).toBe(conv.id);
  });

  it("clearViewLayerState 对不存在的 conversation 是 no-op", async () => {
    const repo = createRepo();
    await expect(repo.clearViewLayerState("nonexistent")).resolves.toBeUndefined();
  });

  it("clearViewLayerState 同时清理历史 phantom 字段 capabilityState", async () => {
    const repo = createRepo();
    const conv = await repo.create({ name: "legacy-field-test" });

    // 模拟磁盘上的老 meta 仍残留 capabilityState
    await writeRawMeta(repo, conv.id, {
      capabilityState: { hotTools: ["read"] },
      taskListState: { items: [] },
    });

    await repo.clearViewLayerState(conv.id);

    const dir = path.join(tmpDir, "conversations", conv.id);
    const content = await fs.readFile(path.join(dir, "meta.json"), "utf-8");
    const raw = JSON.parse(content) as Record<string, unknown>;
    expect(raw.capabilityState).toBeUndefined();
    expect(raw.taskListState).toBeUndefined();
  });

  // ─── updateTaskListState ───

  it("updateTaskListState 写入新 state → 后续 get 拉到", async () => {
    const repo = createRepo();
    const conv = await repo.create({ name: "update-test" });

    await repo.updateTaskListState(conv.id, {
      items: [
        { id: "t1", content: "新任务", status: "in_progress" },
      ],
    });

    const reloaded = await repo.get(conv.id);
    expect(reloaded?.taskListState?.items).toHaveLength(1);
    expect(reloaded?.taskListState?.items[0]?.id).toBe("t1");
    expect(reloaded?.taskListState?.items[0]?.status).toBe("in_progress");
  });

  it("updateTaskListState 二次写入覆盖前次（替换语义）", async () => {
    const repo = createRepo();
    const conv = await repo.create({ name: "overwrite-test" });

    await repo.updateTaskListState(conv.id, {
      items: [{ id: "a", content: "first", status: "pending" }],
    });
    await repo.updateTaskListState(conv.id, {
      items: [{ id: "b", content: "second", status: "completed" }],
    });

    const reloaded = await repo.get(conv.id);
    expect(reloaded?.taskListState?.items).toHaveLength(1);
    expect(reloaded?.taskListState?.items[0]?.id).toBe("b");
  });

  it("updateTaskListState 身份字段保留（id / name / preferredModel 等）", async () => {
    const repo = createRepo();
    const conv = await repo.create({
      name: "identity-test",
      preferredModel: "deepseek-v4-pro",
    });

    await repo.updateTaskListState(conv.id, {
      items: [{ id: "x", content: "y", status: "pending" }],
    });

    const reloaded = await repo.get(conv.id);
    expect(reloaded?.id).toBe(conv.id);
    expect(reloaded?.name).toBe("identity-test");
    expect(reloaded?.preferredModel).toBe("deepseek-v4-pro");
  });

  it("updateTaskListState(id, undefined) 删除字段", async () => {
    const repo = createRepo();
    const conv = await repo.create({ name: "remove-test" });

    await repo.updateTaskListState(conv.id, {
      items: [{ id: "z", content: "tmp", status: "pending" }],
    });
    await repo.updateTaskListState(conv.id, undefined);

    const dir = path.join(tmpDir, "conversations", conv.id);
    const content = await fs.readFile(path.join(dir, "meta.json"), "utf-8");
    const raw = JSON.parse(content) as Record<string, unknown>;
    expect(raw.taskListState).toBeUndefined();
  });

  it("updateTaskListState 对不存在的 conversation 是 no-op（不抛错）", async () => {
    const repo = createRepo();
    await expect(
      repo.updateTaskListState("never-existed", {
        items: [{ id: "x", content: "y", status: "pending" }],
      }),
    ).resolves.toBeUndefined();
  });

  it("updateTaskListState 不影响 segmentMetadata 字段", async () => {
    const repo = createRepo();
    const conv = await repo.create({ name: "isolation-test" });

    await writeRawMeta(repo, conv.id, {
      segmentMetadata: {
        currentSegmentId: "seg-A",
        segments: [
          {
            segmentId: "seg-A",
            timestamp: "2026-05-11T10:00:00Z",
            tokensBefore: 1000,
            tokensAfter: 500,
          },
        ],
      },
    });

    await repo.updateTaskListState(conv.id, {
      items: [{ id: "t", content: "x", status: "pending" }],
    });

    const reloaded = await repo.get(conv.id);
    expect(reloaded?.taskListState?.items).toHaveLength(1);
    expect(reloaded?.segmentMetadata?.currentSegmentId).toBe("seg-A");
  });

  // ─── appendSegmentMeta ───

  it("appendSegmentMeta 首次调用初始化 segmentMetadata 结构", async () => {
    const repo = createRepo();
    const conv = await repo.create({ name: "first-segment" });

    await repo.appendSegmentMeta(conv.id, {
      segmentId: "seg-1",
      timestamp: "2026-05-11T10:00:00Z",
      tokensBefore: 150_000,
      tokensAfter: 4_000,
    });

    const reloaded = await repo.get(conv.id);
    expect(reloaded?.segmentMetadata).toEqual({
      currentSegmentId: "seg-1",
      segments: [
        {
          segmentId: "seg-1",
          timestamp: "2026-05-11T10:00:00Z",
          tokensBefore: 150_000,
          tokensAfter: 4_000,
        },
      ],
    });
  });

  it("appendSegmentMeta 二次调用追加到 segments[] 并更新 currentSegmentId", async () => {
    const repo = createRepo();
    const conv = await repo.create({ name: "multi-segment" });

    await repo.appendSegmentMeta(conv.id, {
      segmentId: "seg-1",
      timestamp: "2026-05-11T10:00:00Z",
      tokensBefore: 150_000,
      tokensAfter: 4_000,
    });
    await repo.appendSegmentMeta(conv.id, {
      segmentId: "seg-2",
      timestamp: "2026-05-11T11:00:00Z",
      tokensBefore: 200_000,
      tokensAfter: 5_000,
    });

    const reloaded = await repo.get(conv.id);
    expect(reloaded?.segmentMetadata?.currentSegmentId).toBe("seg-2");
    expect(reloaded?.segmentMetadata?.segments).toHaveLength(2);
    expect(reloaded?.segmentMetadata?.segments[0]?.segmentId).toBe("seg-1");
    expect(reloaded?.segmentMetadata?.segments[1]?.segmentId).toBe("seg-2");
  });

  it("appendSegmentMeta 身份字段保留（id / name / preferredModel 等）", async () => {
    const repo = createRepo();
    const conv = await repo.create({
      name: "identity-segment",
      preferredModel: "deepseek-v4-pro",
    });

    await repo.appendSegmentMeta(conv.id, {
      segmentId: "seg-x",
      timestamp: "2026-05-11T10:00:00Z",
      tokensBefore: 1000,
      tokensAfter: 100,
    });

    const reloaded = await repo.get(conv.id);
    expect(reloaded?.id).toBe(conv.id);
    expect(reloaded?.name).toBe("identity-segment");
    expect(reloaded?.preferredModel).toBe("deepseek-v4-pro");
  });

  it("appendSegmentMeta 不影响 taskListState 字段", async () => {
    const repo = createRepo();
    const conv = await repo.create({ name: "isolate-task" });

    await repo.updateTaskListState(conv.id, {
      items: [{ id: "t1", content: "task", status: "in_progress" }],
    });
    await repo.appendSegmentMeta(conv.id, {
      segmentId: "seg-1",
      timestamp: "2026-05-11T10:00:00Z",
      tokensBefore: 1000,
      tokensAfter: 100,
    });

    const reloaded = await repo.get(conv.id);
    expect(reloaded?.taskListState?.items).toHaveLength(1);
    expect(reloaded?.taskListState?.items[0]?.id).toBe("t1");
    expect(reloaded?.segmentMetadata?.currentSegmentId).toBe("seg-1");
  });

  it("appendSegmentMeta 对不存在的 conversation 是 no-op（不抛错）", async () => {
    const repo = createRepo();
    await expect(
      repo.appendSegmentMeta("never-existed", {
        segmentId: "seg-1",
        timestamp: "2026-05-11T10:00:00Z",
        tokensBefore: 1000,
        tokensAfter: 100,
      }),
    ).resolves.toBeUndefined();
  });

  it("appendSegmentMeta 与 clearViewLayerState 配合 —— clear 会清空段历史", async () => {
    const repo = createRepo();
    const conv = await repo.create({ name: "clear-test" });

    await repo.appendSegmentMeta(conv.id, {
      segmentId: "seg-1",
      timestamp: "2026-05-11T10:00:00Z",
      tokensBefore: 1000,
      tokensAfter: 100,
    });
    await repo.clearViewLayerState(conv.id);

    const reloaded = await repo.get(conv.id);
    expect(reloaded?.segmentMetadata).toBeUndefined();
  });
});
