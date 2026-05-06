import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { ConversationRepository } from "../repository.js";
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
const PROJECT_SCOPE: ConversationScope = {
  kind: "project",
  projectId: "abc123",
  projectPath: "/home/user/project",
};

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

  it("list 按 scope 隔离", async () => {
    const userRepo = createRepo(USER_SCOPE);
    const projectRepo = createRepo(PROJECT_SCOPE);

    await userRepo.create({ name: "user-conv" });
    await projectRepo.create({ name: "project-conv" });

    const userList = await userRepo.list();
    const projectList = await projectRepo.list();

    expect(userList).toHaveLength(1);
    expect(userList[0]!.name).toBe("user-conv");
    expect(projectList).toHaveLength(1);
    expect(projectList[0]!.name).toBe("project-conv");
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

  it("删除移入 trash 目录", async () => {
    const repo = createRepo();
    const conv = await repo.create({ name: "trash-test" });
    await repo.delete(conv.id);

    const trashEntries = await fs.readdir(path.join(tmpDir, "trash"));
    expect(trashEntries.some((e) => e.startsWith(conv.id))).toBe(true);
  });

  it("默认对话不可删除", async () => {
    const repo = createRepo();
    await repo.ensureDefault();
    await expect(
      repo.delete(DEFAULT_CONVERSATION_ID),
    ).rejects.toThrow(/默认对话/);
  });

  it("不存在的 ID 抛错", async () => {
    const repo = createRepo();
    await expect(repo.delete("ghost")).rejects.toThrow(/不存在/);
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
