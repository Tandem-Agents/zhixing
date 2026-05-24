/**
 * WorkingState 操作纯函数测试。
 *
 * 关键不变量：
 *   - 每次操作返回新对象（不可变）
 *   - 字段边界：每个 helper 只动它声明的字段
 *   - 合并而非替换：patchProvider/Channel 不丢未提及字段
 *   - addProviderModel 去重保序
 */

import { describe, expect, it } from "vitest";
import {
  addProviderModel,
  clearInputBuffer,
  createInitialState,
  disableMessaging,
  enableMessaging,
  isMcpServerEnabled,
  isMessagingEnabled,
  listMcpServerIds,
  patchChannelEntry,
  patchMcpSecrets,
  patchProviderEntry,
  readChannelEntry,
  readMcpSecrets,
  readMcpServer,
  readModelRole,
  readModelThinking,
  readProviderEntry,
  removeMcpServer,
  setInputBuffer,
  setMcpServerEnabled,
  upsertMcpServer,
  writeModelRole,
  writeModelThinking,
} from "../state.js";

describe("createInitialState", () => {
  it("深拷贝输入，不持有原对象引用", () => {
    const config = { llm: { main: { provider: "x", model: "y" } } };
    const credentials = { providers: { x: { apiKey: "k" } } };
    const state = createInitialState(config, credentials);

    state.config.llm!.main.provider = "modified";
    expect(config.llm.main.provider).toBe("x"); // 原对象不变
  });

  it("inputBuffer 初始化为空字符串", () => {
    const state = createInitialState({}, {});
    expect(state.inputBuffer).toBe("");
  });
});

describe("setInputBuffer / clearInputBuffer", () => {
  it("setInputBuffer 返回新 state，buffer 已更新", () => {
    const state = createInitialState({}, {});
    const next = setInputBuffer(state, "hello");
    expect(next.inputBuffer).toBe("hello");
    expect(state.inputBuffer).toBe(""); // 原 state 不变
  });

  it("clearInputBuffer 等价于 setInputBuffer(_, '')", () => {
    const state = setInputBuffer(createInitialState({}, {}), "hello");
    expect(clearInputBuffer(state).inputBuffer).toBe("");
  });
});

describe("readModelRole / writeModelRole", () => {
  it("读取空 config 返回 undefined", () => {
    const state = createInitialState({}, {});
    expect(readModelRole(state, "main")).toBeUndefined();
  });

  it("写 main 角色到空 config", () => {
    const state = createInitialState({}, {});
    const next = writeModelRole(state, "main", "openai", "gpt-4o");
    expect(next.config.llm?.main).toEqual({ provider: "openai", model: "gpt-4o" });
  });

  it("写 light 时若 main 不存在用占位空 main（保持 schema）", () => {
    const state = createInitialState({}, {});
    const next = writeModelRole(state, "light", "openai", "gpt-4o-mini");
    expect(next.config.llm?.main).toEqual({ provider: "", model: "" });
    expect(next.config.llm?.light).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
    });
  });

  it("更新 main 不影响 light", () => {
    const state = createInitialState(
      {
        llm: {
          main: { provider: "deepseek", model: "deepseek-chat" },
          light: { provider: "openai", model: "gpt-4o-mini" },
        },
      },
      {},
    );
    const next = writeModelRole(state, "main", "anthropic", "claude-sonnet");
    expect(next.config.llm?.main).toEqual({
      provider: "anthropic",
      model: "claude-sonnet",
    });
    expect(next.config.llm?.light).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
    });
  });
});

describe("patchProviderEntry · 合并语义", () => {
  it("空 credentials 写入新 provider 创建条目", () => {
    const state = createInitialState({}, {});
    const next = patchProviderEntry(state, "siliconflow", { apiKey: "sk-test" });
    expect(next.credentials.providers?.siliconflow?.apiKey).toBe("sk-test");
  });

  it("合并而非替换——已有字段不丢", () => {
    const state = createInitialState(
      {},
      {
        providers: {
          siliconflow: {
            apiKey: "old",
            baseUrl: "https://x",
            protocol: "openai-compatible",
          },
        },
      },
    );
    const next = patchProviderEntry(state, "siliconflow", { apiKey: "new" });
    expect(next.credentials.providers?.siliconflow).toEqual({
      apiKey: "new",
      baseUrl: "https://x",
      protocol: "openai-compatible",
    });
  });

  it("追加新 provider 不影响其他 provider", () => {
    const state = createInitialState(
      {},
      { providers: { openai: { apiKey: "sk-oai" } } },
    );
    const next = patchProviderEntry(state, "siliconflow", { apiKey: "sk-sf" });
    expect(next.credentials.providers?.openai?.apiKey).toBe("sk-oai");
    expect(next.credentials.providers?.siliconflow?.apiKey).toBe("sk-sf");
  });
});

describe("addProviderModel · 自定义模型列表", () => {
  it("空列表追加新 model", () => {
    const state = createInitialState(
      {},
      { providers: { siliconflow: { apiKey: "sk-test" } } },
    );
    const next = addProviderModel(state, "siliconflow", "Pro/MyModel");
    expect(next.credentials.providers?.siliconflow?.models).toEqual(["Pro/MyModel"]);
  });

  it("已存在的 model 不重复添加", () => {
    const state = createInitialState(
      {},
      {
        providers: {
          siliconflow: { apiKey: "sk-test", models: ["Pro/M1", "Pro/M2"] },
        },
      },
    );
    const next = addProviderModel(state, "siliconflow", "Pro/M1");
    expect(next.credentials.providers?.siliconflow?.models).toEqual([
      "Pro/M1",
      "Pro/M2",
    ]);
  });

  it("追加保序——新 model 在末尾", () => {
    const state = createInitialState(
      {},
      {
        providers: {
          siliconflow: { apiKey: "sk-test", models: ["A", "B"] },
        },
      },
    );
    const next = addProviderModel(state, "siliconflow", "C");
    expect(next.credentials.providers?.siliconflow?.models).toEqual(["A", "B", "C"]);
  });

  it("provider 不存在时创建新条目（apiKey 兜底为空字符串）", () => {
    const state = createInitialState({}, {});
    const next = addProviderModel(state, "newprovider", "new-model");
    expect(next.credentials.providers?.newprovider?.apiKey).toBe("");
    expect(next.credentials.providers?.newprovider?.models).toEqual(["new-model"]);
  });
});

describe("patchChannelEntry / readChannelEntry", () => {
  it("追加 channel 字段不丢已有字段", () => {
    const state = createInitialState(
      {},
      { channels: { feishu: { appId: "cli_xxx" } } },
    );
    const next = patchChannelEntry(state, "feishu", { appSecret: "secret_yyy" });
    expect(next.credentials.channels?.feishu).toEqual({
      appId: "cli_xxx",
      appSecret: "secret_yyy",
    });
  });

  it("readChannelEntry 返回 undefined 时表示 channel 未配", () => {
    const state = createInitialState({}, {});
    expect(readChannelEntry(state, "feishu")).toBeUndefined();
  });
});

describe("enableMessaging / disableMessaging", () => {
  it("enableMessaging 添加空对象到 config.messaging", () => {
    const state = createInitialState({}, {});
    const next = enableMessaging(state, "feishu");
    expect(next.config.messaging?.feishu).toEqual({});
  });

  it("enableMessaging 已启用时幂等（不破坏已有 options）", () => {
    const state = createInitialState(
      {
        messaging: {
          feishu: { type: "feishu", options: { logLevel: "info" } },
        },
      },
      {},
    );
    const next = enableMessaging(state, "feishu");
    expect(next.config.messaging?.feishu).toEqual({
      type: "feishu",
      options: { logLevel: "info" },
    });
  });

  it("disableMessaging 移除 channel 条目", () => {
    const state = createInitialState(
      { messaging: { feishu: {}, slack: {} } },
      {},
    );
    const next = disableMessaging(state, "feishu");
    expect(next.config.messaging?.feishu).toBeUndefined();
    expect(next.config.messaging?.slack).toEqual({});
  });

  it("isMessagingEnabled 正确反映启用状态", () => {
    const state = createInitialState(
      { messaging: { feishu: {} } },
      {},
    );
    expect(isMessagingEnabled(state, "feishu")).toBe(true);
    expect(isMessagingEnabled(state, "slack")).toBe(false);
  });
});

describe("readModelThinking / writeModelThinking", () => {
  it("writeModelThinking 保留 provider+model，仅设 thinking", () => {
    let state = createInitialState({}, {});
    state = writeModelRole(state, "main", "deepseek", "deepseek-v4-pro");
    state = writeModelThinking(state, "main", { mode: "effort", effort: "max" });

    expect(state.config.llm?.main).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      thinking: { mode: "effort", effort: "max" },
    });
    expect(readModelThinking(state, "main")).toEqual({
      mode: "effort",
      effort: "max",
    });
  });

  it("writeModelRole 覆盖角色 → 丢弃旧 model 的残留 thinking", () => {
    let state = createInitialState({}, {});
    state = writeModelRole(state, "main", "deepseek", "deepseek-v4-pro");
    state = writeModelThinking(state, "main", { mode: "on" });
    // 换 model：写 provider+model 应清掉旧 thinking（形态随 model 变）
    state = writeModelRole(state, "main", "deepseek", "deepseek-v4-flash");

    expect(readModelThinking(state, "main")).toBeUndefined();
  });

  it("未配该角色时 readModelThinking 返回 undefined", () => {
    const state = createInitialState({}, {});
    expect(readModelThinking(state, "light")).toBeUndefined();
  });
});

describe("MCP server 读写原语", () => {
  it("upsertMcpServer 新增 server，listMcpServerIds 保配置顺序", () => {
    let state = createInitialState({}, {});
    state = upsertMcpServer(state, "github", {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
    });
    state = upsertMcpServer(state, "notion", { type: "http", url: "https://x" });

    expect(readMcpServer(state, "github")).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
    });
    expect(listMcpServerIds(state)).toEqual(["github", "notion"]);
  });

  it("upsertMcpServer 整体替换——切 transport 时清掉旧字段", () => {
    let state = createInitialState(
      { mcp: { servers: { x: { type: "stdio", command: "old", args: ["a"] } } } },
      {},
    );
    state = upsertMcpServer(state, "x", { type: "http", url: "https://new" });
    // 切到 http：旧的 command / args 不得残留
    expect(readMcpServer(state, "x")).toEqual({ type: "http", url: "https://new" });
  });

  it("setMcpServerEnabled 合并 enabled、保留连接字段", () => {
    let state = createInitialState(
      { mcp: { servers: { x: { type: "stdio", command: "c" } } } },
      {},
    );
    state = setMcpServerEnabled(state, "x", false);
    expect(readMcpServer(state, "x")).toEqual({
      type: "stdio",
      command: "c",
      enabled: false,
    });
    expect(isMcpServerEnabled(state, "x")).toBe(false);
  });

  it("isMcpServerEnabled 缺省视为启用，仅显式 false 才停用", () => {
    const state = createInitialState(
      { mcp: { servers: { x: { type: "stdio" } } } },
      {},
    );
    expect(isMcpServerEnabled(state, "x")).toBe(true);
  });

  it("setMcpServerEnabled 对不存在的 server 不变", () => {
    const state = createInitialState({}, {});
    expect(setMcpServerEnabled(state, "ghost", false)).toBe(state);
  });

  it("removeMcpServer 同时清 config.mcp 与 credentials.mcp 条目", () => {
    let state = createInitialState(
      { mcp: { servers: { x: { type: "stdio" }, y: { type: "http" } } } },
      { mcp: { x: { token: "secret" }, y: { token: "keep" } } },
    );
    state = removeMcpServer(state, "x");
    expect(readMcpServer(state, "x")).toBeUndefined();
    expect(readMcpSecrets(state, "x")).toBeUndefined();
    // 其余 server 不受影响
    expect(readMcpServer(state, "y")).toEqual({ type: "http" });
    expect(readMcpSecrets(state, "y")).toEqual({ token: "keep" });
  });

  it("patchMcpSecrets 合并凭证字段、不丢已有字段", () => {
    let state = createInitialState({}, { mcp: { x: { token: "old" } } });
    state = patchMcpSecrets(state, "x", { extra: "v" });
    expect(readMcpSecrets(state, "x")).toEqual({ token: "old", extra: "v" });
  });
});

describe("不可变性回归保护", () => {
  it("所有写操作返回的 state 与输入引用不同", () => {
    const state = createInitialState({}, {});
    expect(setInputBuffer(state, "x")).not.toBe(state);
    expect(writeModelRole(state, "main", "p", "m")).not.toBe(state);
    expect(
      writeModelThinking(
        writeModelRole(state, "main", "p", "m"),
        "main",
        { mode: "on" },
      ),
    ).not.toBe(state);
    expect(patchProviderEntry(state, "x", { apiKey: "k" })).not.toBe(state);
    expect(patchChannelEntry(state, "feishu", { appId: "x" })).not.toBe(state);
    expect(enableMessaging(state, "feishu")).not.toBe(state);
    expect(upsertMcpServer(state, "x", { type: "stdio" })).not.toBe(state);
    expect(patchMcpSecrets(state, "x", { token: "k" })).not.toBe(state);
  });
});
