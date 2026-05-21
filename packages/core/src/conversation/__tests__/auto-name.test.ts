import { describe, expect, it, vi } from "vitest";
import {
  buildConversationNamerPrompt,
  maybeAutoNameFirstTurn,
  sanitizeConversationName,
  type InferConversationName,
} from "../auto-name.js";
import type { Conversation, IConversationRepository } from "../types.js";
import type { Message } from "../../types/messages.js";
import { userMessage } from "../../types/messages.js";

// ─── Helpers ───

function makeConv(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "chat-0001",
    name: "chat-0001",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-01-01T00:00:00.000Z",
    isDefault: false,
    archived: false,
    scope: { kind: "user" },
    ...overrides,
  };
}

interface StubRepo extends IConversationRepository {
  _getCalls: string[];
  _renameCalls: Array<{ id: string; name: string }>;
}

function makeStubRepo(opts: {
  initial: Conversation | null;
  /** 第二次 get 返回（默认与 initial 同源） */
  secondGet?: Conversation | null;
  getThrowsOn?: "first" | "second";
  renameThrows?: boolean;
}): StubRepo {
  const repo: any = {
    _getCalls: [] as string[],
    _renameCalls: [] as Array<{ id: string; name: string }>,
    list: vi.fn(),
    archive: vi.fn(),
    delete: vi.fn(),
    ensureDefault: vi.fn(),
    findLatest: vi.fn(),
    touch: vi.fn(),
    clearViewLayerState: vi.fn(),
    updateTaskListState: vi.fn(),
    appendSegmentMeta: vi.fn(),
    create: vi.fn(),
  };
  repo.get = vi.fn(async (id: string) => {
    repo._getCalls.push(id);
    const callIdx = repo._getCalls.length;
    if (opts.getThrowsOn === "first" && callIdx === 1) {
      throw new Error("disk read failed");
    }
    if (opts.getThrowsOn === "second" && callIdx === 2) {
      throw new Error("disk read failed");
    }
    if (callIdx === 1) return opts.initial;
    return opts.secondGet === undefined ? opts.initial : opts.secondGet;
  });
  repo.rename = vi.fn(async (id: string, name: string) => {
    repo._renameCalls.push({ id, name });
    if (opts.renameThrows) throw new Error("disk write failed");
    return { ...(opts.initial ?? makeConv()), id, name };
  });
  return repo as StubRepo;
}

const FIRST_USER_MSG: Message = userMessage("帮我设计一个登录页面");

// ─── maybeAutoNameFirstTurn:触发判定 ───

describe("maybeAutoNameFirstTurn — 触发判定", () => {
  it("turnCounter !== 1 同步 short-circuit,不读盘不调 inferer", async () => {
    const repo = makeStubRepo({ initial: makeConv() });
    const inferName = vi.fn() as unknown as InferConversationName;

    await maybeAutoNameFirstTurn({
      conversationId: "chat-0001",
      turnCounter: 2,
      userMessage: FIRST_USER_MSG,
      inferName,
      convRepo: repo,
    });

    expect(repo.get).not.toHaveBeenCalled();
    expect(inferName).not.toHaveBeenCalled();
    expect(repo.rename).not.toHaveBeenCalled();
  });

  it("turnCounter === 0(commitTurn 之前误调)同步 short-circuit", async () => {
    const repo = makeStubRepo({ initial: makeConv() });
    const inferName = vi.fn() as unknown as InferConversationName;

    await maybeAutoNameFirstTurn({
      conversationId: "chat-0001",
      turnCounter: 0,
      userMessage: FIRST_USER_MSG,
      inferName,
      convRepo: repo,
    });

    expect(repo.get).not.toHaveBeenCalled();
  });

  it("对话不存在(get 返回 null)直接跳过,不调 inferer", async () => {
    const repo = makeStubRepo({ initial: null });
    const inferName = vi.fn() as unknown as InferConversationName;

    await maybeAutoNameFirstTurn({
      conversationId: "chat-0001",
      turnCounter: 1,
      userMessage: FIRST_USER_MSG,
      inferName,
      convRepo: repo,
    });

    expect(repo.get).toHaveBeenCalledTimes(1);
    expect(inferName).not.toHaveBeenCalled();
    expect(repo.rename).not.toHaveBeenCalled();
  });

  it("name !== id(已命名)跳过,不调 inferer", async () => {
    const repo = makeStubRepo({
      initial: makeConv({ id: "chat-0001", name: "用户已起的名字" }),
    });
    const inferName = vi.fn() as unknown as InferConversationName;

    await maybeAutoNameFirstTurn({
      conversationId: "chat-0001",
      turnCounter: 1,
      userMessage: FIRST_USER_MSG,
      inferName,
      convRepo: repo,
    });

    expect(repo.get).toHaveBeenCalledTimes(1);
    expect(inferName).not.toHaveBeenCalled();
    expect(repo.rename).not.toHaveBeenCalled();
  });
});

// ─── maybeAutoNameFirstTurn:inferer 行为 ───

describe("maybeAutoNameFirstTurn — inferer 行为", () => {
  it("inferer 返回 null → 不重命名", async () => {
    const repo = makeStubRepo({ initial: makeConv() });
    const inferName: InferConversationName = vi.fn(async () => null);

    await maybeAutoNameFirstTurn({
      conversationId: "chat-0001",
      turnCounter: 1,
      userMessage: FIRST_USER_MSG,
      inferName,
      convRepo: repo,
    });

    expect(inferName).toHaveBeenCalledWith(FIRST_USER_MSG);
    expect(repo.rename).not.toHaveBeenCalled();
  });

  it("inferer 抛错 → catch swallow,不重命名,不抛出", async () => {
    const repo = makeStubRepo({ initial: makeConv() });
    const inferName: InferConversationName = vi.fn(async () => {
      throw new Error("LLM 调用失败");
    });

    await expect(
      maybeAutoNameFirstTurn({
        conversationId: "chat-0001",
        turnCounter: 1,
        userMessage: FIRST_USER_MSG,
        inferName,
        convRepo: repo,
      }),
    ).resolves.toBeUndefined();

    expect(repo.rename).not.toHaveBeenCalled();
  });

  it("成功路径:get → infer → 二次 get → rename", async () => {
    const repo = makeStubRepo({ initial: makeConv() });
    const inferName: InferConversationName = vi.fn(async () => "登录页面设计");

    await maybeAutoNameFirstTurn({
      conversationId: "chat-0001",
      turnCounter: 1,
      userMessage: FIRST_USER_MSG,
      inferName,
      convRepo: repo,
    });

    expect(repo._getCalls).toEqual(["chat-0001", "chat-0001"]);
    expect(inferName).toHaveBeenCalledWith(FIRST_USER_MSG);
    expect(repo._renameCalls).toEqual([
      { id: "chat-0001", name: "登录页面设计" },
    ]);
  });
});

// ─── maybeAutoNameFirstTurn:二次门控 ───

describe("maybeAutoNameFirstTurn — 二次门控", () => {
  it("inferer inflight 期间用户 `/name`(二次 get 看到 name !== id)→ 跳过覆盖", async () => {
    const repo = makeStubRepo({
      initial: makeConv({ id: "chat-0001", name: "chat-0001" }),
      secondGet: makeConv({ id: "chat-0001", name: "用户期间命名" }),
    });
    const inferName: InferConversationName = vi.fn(async () => "自动推断名");

    await maybeAutoNameFirstTurn({
      conversationId: "chat-0001",
      turnCounter: 1,
      userMessage: FIRST_USER_MSG,
      inferName,
      convRepo: repo,
    });

    expect(inferName).toHaveBeenCalled();
    expect(repo.rename).not.toHaveBeenCalled();
  });

  it("二次 get 返回 null(对话期间被删)→ 跳过", async () => {
    const repo = makeStubRepo({
      initial: makeConv(),
      secondGet: null,
    });
    const inferName: InferConversationName = vi.fn(async () => "自动推断名");

    await maybeAutoNameFirstTurn({
      conversationId: "chat-0001",
      turnCounter: 1,
      userMessage: FIRST_USER_MSG,
      inferName,
      convRepo: repo,
    });

    expect(repo.rename).not.toHaveBeenCalled();
  });
});

// ─── maybeAutoNameFirstTurn:错误吞噬 ───

describe("maybeAutoNameFirstTurn — 错误吞噬", () => {
  it("repo.get 抛错 → 静默,不抛出", async () => {
    const repo = makeStubRepo({
      initial: makeConv(),
      getThrowsOn: "first",
    });
    const inferName: InferConversationName = vi.fn(async () => "x");

    await expect(
      maybeAutoNameFirstTurn({
        conversationId: "chat-0001",
        turnCounter: 1,
        userMessage: FIRST_USER_MSG,
        inferName,
        convRepo: repo,
      }),
    ).resolves.toBeUndefined();

    expect(repo.rename).not.toHaveBeenCalled();
  });

  it("repo.rename 抛错 → 静默,不抛出", async () => {
    const repo = makeStubRepo({
      initial: makeConv(),
      renameThrows: true,
    });
    const inferName: InferConversationName = vi.fn(async () => "短名");

    await expect(
      maybeAutoNameFirstTurn({
        conversationId: "chat-0001",
        turnCounter: 1,
        userMessage: FIRST_USER_MSG,
        inferName,
        convRepo: repo,
      }),
    ).resolves.toBeUndefined();
  });
});

// ─── sanitizeConversationName ───

describe("sanitizeConversationName", () => {
  it("普通字符串原样返回", () => {
    expect(sanitizeConversationName("登录页面设计")).toBe("登录页面设计");
  });

  it("trim 首尾空白", () => {
    expect(sanitizeConversationName("  hello  ")).toBe("hello");
  });

  it("仅空白 → null", () => {
    expect(sanitizeConversationName("   ")).toBeNull();
    expect(sanitizeConversationName("")).toBeNull();
    expect(sanitizeConversationName("\n\t  \n")).toBeNull();
  });

  it("剥离成对英文双引号", () => {
    expect(sanitizeConversationName('"hello"')).toBe("hello");
  });

  it("剥离成对中文双引号", () => {
    expect(sanitizeConversationName("“登录”")).toBe("登录");
  });

  it("剥离成对中文书名号", () => {
    expect(sanitizeConversationName("《标题》")).toBe("标题");
  });

  it("剥离成对中文单引号", () => {
    expect(sanitizeConversationName("‘短名’")).toBe("短名");
  });

  it("折叠多空白为单空格", () => {
    expect(sanitizeConversationName("hello   world\n\nfoo")).toBe(
      "hello world foo",
    );
  });

  it("超长按 code point 截断", () => {
    const longName = "一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯";
    const out = sanitizeConversationName(longName, 10);
    expect(out).toBe("一二三四五六七八九十");
    expect(Array.from(out!).length).toBe(10);
  });

  it("emoji 等多字节字符按 code point 截断,不切碎 surrogate pair", () => {
    const name = "🚀🚀🚀🚀🚀🚀";
    const out = sanitizeConversationName(name, 3);
    expect(out).toBe("🚀🚀🚀");
    expect(Array.from(out!).length).toBe(3);
  });

  it("默认 maxLength 为 20", () => {
    const twentyOne = "a".repeat(21);
    expect(sanitizeConversationName(twentyOne)).toBe("a".repeat(20));
  });

  it("非字符串入参 → null", () => {
    expect(sanitizeConversationName(null as unknown as string)).toBeNull();
    expect(sanitizeConversationName(undefined as unknown as string)).toBeNull();
  });
});

// ─── buildConversationNamerPrompt ───

describe("buildConversationNamerPrompt", () => {
  it("把 user text 完整嵌入 prompt", () => {
    const prompt = buildConversationNamerPrompt("帮我设计登录页面");
    expect(prompt).toContain("帮我设计登录页面");
  });

  it("包含长度与格式约束", () => {
    const prompt = buildConversationNamerPrompt("test");
    expect(prompt).toContain("5-15");
    expect(prompt).toContain("不带任何标点");
  });

  it("以 主题: 行收尾,便于 LLM 续写", () => {
    const prompt = buildConversationNamerPrompt("test");
    expect(prompt.trimEnd().endsWith("主题：")).toBe(true);
  });
});
