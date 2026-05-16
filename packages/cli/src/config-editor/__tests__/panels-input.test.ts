/**
 * Input panel 状态机测试（L4a / L5）。
 *
 * 关键不变量：
 *   - 字符 / Backspace 累积或删除 inputBuffer
 *   - Enter 提交：写入 state（apply 函数）+ 清空 buffer + pop
 *   - Esc / 空 Enter 取消：丢弃 buffer + pop
 *   - Ctrl+C 退出整个编辑器
 *   - apply 路由：fieldId 形如 provider-apikey:<role>:<id> / channel-field:<channelId>:<fieldId>
 */

import { describe, expect, it } from "vitest";
import { createInitialState } from "../state.js";
import {
  handleAddModelPanelKey,
  handleInputPanelKey,
} from "../panels/input.js";
import type { PanelDescriptor } from "../types.js";

describe("handleInputPanelKey · 字符累积 / 删除", () => {
  const descriptor = {
    kind: "input",
    fieldId: "provider-apikey:main:siliconflow",
  } as Extract<PanelDescriptor, { kind: "input" }>;

  it("char 事件累积到 inputBuffer", () => {
    const state = createInitialState({}, {});
    const action = handleInputPanelKey(state, descriptor, {
      type: "char",
      ch: "a",
    });
    expect(action.type).toBe("stay");
    if (action.type === "stay") {
      expect(action.state.inputBuffer).toBe("a");
    }
  });

  it("backspace 删除 buffer 末尾字符", () => {
    const state = createInitialState({}, {});
    let cur = state;
    for (const ch of "abc") {
      const r = handleInputPanelKey(cur, descriptor, { type: "char", ch });
      if (r.type === "stay") cur = r.state;
    }
    const r = handleInputPanelKey(cur, descriptor, { type: "backspace" });
    expect(r.type).toBe("stay");
    if (r.type === "stay") {
      expect(r.state.inputBuffer).toBe("ab");
    }
  });

  it("backspace on 空 buffer 不变", () => {
    const state = createInitialState({}, {});
    const r = handleInputPanelKey(state, descriptor, { type: "backspace" });
    expect(r.type).toBe("stay");
    if (r.type === "stay") {
      expect(r.state.inputBuffer).toBe("");
    }
  });
});

describe("handleInputPanelKey · provider-apikey 字段路由", () => {
  const descriptor = {
    kind: "input",
    fieldId: "provider-apikey:main:siliconflow",
  } as Extract<PanelDescriptor, { kind: "input" }>;

  it("Enter 提交时写到 credentials.providers.<id>.apiKey + pop", () => {
    let state = createInitialState({}, {});
    state = { ...state, inputBuffer: "sk-test" };
    const action = handleInputPanelKey(state, descriptor, { type: "enter" });
    expect(action.type).toBe("pop");
    if (action.type === "pop") {
      expect(action.state.credentials.providers?.siliconflow?.apiKey).toBe(
        "sk-test",
      );
      expect(action.state.inputBuffer).toBe("");
    }
  });

  it("空 Enter + 字段无已有值 → pop（无写入）", () => {
    const state = createInitialState({}, {});
    const action = handleInputPanelKey(state, descriptor, { type: "enter" });
    expect(action.type).toBe("pop");
    if (action.type === "pop") {
      expect(action.state.credentials.providers).toBeUndefined();
    }
  });

  it("空 Enter + 字段已有值 → pop 且保留原值（不覆盖）", () => {
    // 关键回归保护：进入编辑面板看到"已暂存"提示后直接 Enter 应保留原值，不变成空
    const state = createInitialState(
      {},
      { providers: { siliconflow: { apiKey: "sk-existing" } } },
    );
    const action = handleInputPanelKey(state, descriptor, { type: "enter" });
    expect(action.type).toBe("pop");
    if (action.type === "pop") {
      expect(action.state.credentials.providers?.siliconflow?.apiKey).toBe(
        "sk-existing",
      );
    }
  });

  it("Esc 丢弃 buffer + pop", () => {
    let state = createInitialState({}, {});
    state = { ...state, inputBuffer: "abc" };
    const action = handleInputPanelKey(state, descriptor, { type: "escape" });
    expect(action.type).toBe("pop");
    if (action.type === "pop") {
      expect(action.state.credentials.providers).toBeUndefined();
      expect(action.state.inputBuffer).toBe("");
    }
  });

  it("Ctrl+C → exit cancelled", () => {
    const state = createInitialState({}, {});
    const action = handleInputPanelKey(state, descriptor, { type: "ctrl-c" });
    expect(action.type).toBe("exit");
    if (action.type === "exit") {
      expect(action.result.kind).toBe("cancelled");
    }
  });
});

describe("handleInputPanelKey · channel-field 字段路由", () => {
  it("appId 提交写到 credentials.channels.feishu.appId", () => {
    const descriptor = {
      kind: "input",
      fieldId: "channel-field:feishu:appId",
    } as Extract<PanelDescriptor, { kind: "input" }>;

    let state = createInitialState({}, {});
    state = { ...state, inputBuffer: "cli_test_id" };
    const action = handleInputPanelKey(state, descriptor, { type: "enter" });
    expect(action.type).toBe("pop");
    if (action.type === "pop") {
      expect(action.state.credentials.channels?.feishu?.appId).toBe(
        "cli_test_id",
      );
    }
  });

  it("appSecret 提交合并已有 appId 不丢字段", () => {
    const descriptor = {
      kind: "input",
      fieldId: "channel-field:feishu:appSecret",
    } as Extract<PanelDescriptor, { kind: "input" }>;

    let state = createInitialState(
      {},
      { channels: { feishu: { appId: "cli_existing" } } },
    );
    state = { ...state, inputBuffer: "secret_value" };
    const action = handleInputPanelKey(state, descriptor, { type: "enter" });
    expect(action.type).toBe("pop");
    if (action.type === "pop") {
      expect(action.state.credentials.channels?.feishu).toEqual({
        appId: "cli_existing",
        appSecret: "secret_value",
      });
    }
  });
});

describe("handleAddModelPanelKey", () => {
  const descriptor = {
    kind: "add-model",
    role: "main",
    providerId: "siliconflow",
  } as Extract<PanelDescriptor, { kind: "add-model" }>;

  it("Enter 提交：加入 models 列表 + 自动选定为 role 当前 model + pop", () => {
    let state = createInitialState(
      { llm: { main: { provider: "siliconflow", model: "Pro/Old" } } },
      { providers: { siliconflow: { apiKey: "sk-test" } } },
    );
    state = { ...state, inputBuffer: "Pro/MyCustom" };
    const action = handleAddModelPanelKey(state, descriptor, { type: "enter" });

    expect(action.type).toBe("pop");
    if (action.type === "pop") {
      // 模型加入用户自定义列表
      expect(action.state.credentials.providers?.siliconflow?.models).toEqual([
        "Pro/MyCustom",
      ]);
      // 当前 role 切换到新模型
      expect(action.state.config.llm?.main?.model).toBe("Pro/MyCustom");
      // 输入 buffer 清空
      expect(action.state.inputBuffer).toBe("");
    }
  });

  it("Esc 丢弃 buffer + pop（不动 state）", () => {
    let state = createInitialState({}, {});
    state = { ...state, inputBuffer: "Pro/Whatever" };
    const action = handleAddModelPanelKey(state, descriptor, { type: "escape" });
    expect(action.type).toBe("pop");
    if (action.type === "pop") {
      expect(action.state.credentials.providers).toBeUndefined();
      expect(action.state.inputBuffer).toBe("");
    }
  });

  it("空 Enter 视为取消", () => {
    const state = createInitialState({}, {});
    const action = handleAddModelPanelKey(state, descriptor, { type: "enter" });
    expect(action.type).toBe("pop");
    if (action.type === "pop") {
      expect(action.state.credentials.providers).toBeUndefined();
    }
  });

  // 回归保护：跨 provider 引用 bug。用户在 light 角色之前选过 X 的某模型，
  // 然后进入另一个 provider B 的 add-model 添加新模型。提交后 light 必须
  // 整体切换到 (B, 新模型)——而非保留 light.provider = X 引用 B 的新模型。
  // 详见 panels/input.ts handleAddModelPanelKey enter 分支的注释。
  it("跨 provider：descriptor.providerId 是写入 role 的 provider（非 currentRole.provider）", () => {
    let state = createInitialState(
      {
        llm: {
          main: { provider: "x-provider", model: "x-model" },
          light: { provider: "x-provider", model: "x-model-old" },
        },
      },
      { providers: { "x-provider": { apiKey: "sk-x" } } },
    );
    state = { ...state, inputBuffer: "b-new-model" };
    const otherDescriptor = {
      kind: "add-model",
      role: "light",
      providerId: "b-provider",
    } as Extract<PanelDescriptor, { kind: "add-model" }>;
    const action = handleAddModelPanelKey(state, otherDescriptor, {
      type: "enter",
    });
    expect(action.type).toBe("pop");
    if (action.type === "pop") {
      // 新模型加入 B 的 models 列表（不污染 X）
      expect(action.state.credentials.providers?.["b-provider"]?.models).toEqual(
        ["b-new-model"],
      );
      expect(action.state.credentials.providers?.["x-provider"]?.models).toBeUndefined();
      // light 完整切到 (B, b-new-model)——而不是 (X, b-new-model)
      expect(action.state.config.llm?.light?.provider).toBe("b-provider");
      expect(action.state.config.llm?.light?.model).toBe("b-new-model");
      // main 不受影响
      expect(action.state.config.llm?.main?.provider).toBe("x-provider");
      expect(action.state.config.llm?.main?.model).toBe("x-model");
    }
  });
});
