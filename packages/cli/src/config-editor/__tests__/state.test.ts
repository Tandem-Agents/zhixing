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
  isMessagingEnabled,
  patchChannelEntry,
  patchProviderEntry,
  readChannelEntry,
  readModelRole,
  readProviderEntry,
  setInputBuffer,
  writeModelRole,
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

  it("写 secondary 时若 main 不存在用占位空 main（保持 schema）", () => {
    const state = createInitialState({}, {});
    const next = writeModelRole(state, "secondary", "openai", "gpt-4o-mini");
    expect(next.config.llm?.main).toEqual({ provider: "", model: "" });
    expect(next.config.llm?.secondary).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
    });
  });

  it("更新 main 不影响 secondary", () => {
    const state = createInitialState(
      {
        llm: {
          main: { provider: "deepseek", model: "deepseek-chat" },
          secondary: { provider: "openai", model: "gpt-4o-mini" },
        },
      },
      {},
    );
    const next = writeModelRole(state, "main", "anthropic", "claude-sonnet");
    expect(next.config.llm?.main).toEqual({
      provider: "anthropic",
      model: "claude-sonnet",
    });
    expect(next.config.llm?.secondary).toEqual({
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
            defaultModel: "m1",
          },
        },
      },
    );
    const next = patchProviderEntry(state, "siliconflow", { apiKey: "new" });
    expect(next.credentials.providers?.siliconflow).toEqual({
      apiKey: "new",
      baseUrl: "https://x",
      defaultModel: "m1",
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

describe("不可变性回归保护", () => {
  it("所有写操作返回的 state 与输入引用不同", () => {
    const state = createInitialState({}, {});
    expect(setInputBuffer(state, "x")).not.toBe(state);
    expect(writeModelRole(state, "main", "p", "m")).not.toBe(state);
    expect(patchProviderEntry(state, "x", { apiKey: "k" })).not.toBe(state);
    expect(patchChannelEntry(state, "feishu", { appId: "x" })).not.toBe(state);
    expect(enableMessaging(state, "feishu")).not.toBe(state);
  });
});
