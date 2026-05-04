/**
 * Panel 整屏渲染快照——集成层守护。
 *
 * tui primitive 的单测（chrome.test.ts 等）覆盖底层语义；此文件守护
 * "panel 把多个 primitive 拼起来后**整屏长这样**"。
 *
 * 目的：在以下场景下提早发现退化
 *   - chrome / button / pill 等 primitive 的内部实现微调
 *   - layout / contentIndent 等 token 的值变化
 *   - panel 自身的拼装逻辑误改
 *
 * 用 inline snapshot：快照内嵌测试代码、diff 直接可见、改动需明确意图（绝不
 * 让"快照漂移"自动通过）。stripAnsi 后做断言——只看视觉结构、不看具体颜色。
 *
 * 终端宽度固定 80：保证跨环境一致；过宽过窄都不利快照可读性。
 */

import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";

import { Renderer } from "../ui/render.js";
import {
  renderMainPanel,
  initialMainCursor,
} from "../panels/main.js";
import { renderListPanel } from "../panels/list.js";
import { renderEntityPanel } from "../panels/entity.js";
import { renderInputPanel, renderAddModelPanel } from "../panels/input.js";
import {
  createInitialState,
  writeModelRole,
  patchProviderEntry,
  patchChannelEntry,
  addProviderModel,
  setInputBuffer,
} from "../state.js";
import { stripAnsi } from "../../tui/index.js";
import type {
  ConfigEditorContext,
  PanelDescriptor,
  WorkingState,
} from "../types.js";
import type { ZhixingConfig, ZhixingCredentials } from "@zhixing/providers";

// ─── 测试基础设施 ───

class FakeStdout extends Writable {
  output = "";
  columns: number;
  constructor(columns: number) {
    super();
    this.columns = columns;
  }
  override _write(chunk: Buffer, _enc: string, cb: () => void): void {
    this.output += chunk.toString("utf8");
    cb();
  }
  visible(): string {
    return stripAnsi(this.output);
  }
}

const COLUMNS = 80;

function makeContext(stdout: FakeStdout): ConfigEditorContext {
  return {
    initialConfig: {} as ZhixingConfig,
    initialCredentials: {} as ZhixingCredentials,
    writers: {
      writeConfig: async () => {},
      writeCredentials: async () => {},
    },
    sections: ["model", "messaging"],
    title: "初始配置",
    welcomeText: "欢迎使用知行",
    header: {
      workspaceRoot: "/test/ws",
      configPath: "/test/config.toml",
      credentialsPath: "/test/cred.toml",
    },
    stdin: {} as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WritableStream,
    isTTY: true,
  };
}

function emptyState(): WorkingState {
  return createInitialState(
    {} as ZhixingConfig,
    {} as ZhixingCredentials,
  );
}

/** 渲染 + flush + 返回 stripAnsi 后的可视字符串 */
function renderAndCapture(
  fn: (renderer: Renderer, stdout: FakeStdout) => void,
): string {
  const stdout = new FakeStdout(COLUMNS);
  const renderer = new Renderer(stdout as unknown as NodeJS.WritableStream);
  fn(renderer, stdout);
  renderer.flush();
  return stdout.visible();
}

// ─── Snapshots ───

describe("config-editor panel 整屏快照", () => {
  it("main panel · 全空配置态（待补充 1 项）", () => {
    const out = renderAndCapture((renderer, stdout) => {
      const ctx = makeContext(stdout);
      const state = emptyState();
      renderMainPanel(ctx, state, initialMainCursor(), renderer);
    });
    expect(out).toMatchInlineSnapshot(`
      "╭──── ╲ ───────────────────────────────────────────────────────────────────────╮
      │    ▄▄▄    知行                                                               │
      │   ▌●●▐    初始配置                                                           │
      │    ▀▀     欢迎使用知行                                                       │
      │                                                                              │
      │   工作目录    /test/ws                                                       │
      │   配置        /test/config.toml                                              │
      │   凭证        /test/cred.toml                                                │
      │                                                                              │
      ╰──────────────────────────────────────────────────────────────────────────────╯

       ▎ 对话模型

          主模型必填，辅助模型可选——预留给后续轻量子任务用，未配则沿用主模型

      ░░▸ 主模型░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░⚠ 待配置░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
        › 辅助模型                            · 未启用（默认沿用主模型）

       ▎ 消息通道

          用于接收外部消息触发 agent（如飞书）

        › 飞书                                · 未启用

       ▎ 操作   ⚠ 待补充 2 项

        ┌────────┐
        │  完成  │   (请先补全必填项)
        └────────┘
        ┌────────┐
        │  取消  │   (退出)
        └────────┘

      ────────────────────────────────────────────────────────────────────────────────
        ↑↓ 选择   ·   Enter 进入/确认   ·   Ctrl+C 退出
      "
    `);
  });

  it("main panel · 主模型已配齐 + 选中第二个 entry（辅助模型）", () => {
    const out = renderAndCapture((renderer, stdout) => {
      const ctx = makeContext(stdout);
      let state = emptyState();
      state = writeModelRole(state, "main", "siliconflow", "DeepSeek-V3");
      state = patchProviderEntry(state, "siliconflow", { apiKey: "sk-xxx" });
      renderMainPanel(ctx, state, { index: 1 }, renderer);
    });
    expect(out).toMatchInlineSnapshot(`
      "╭──── ╲ ───────────────────────────────────────────────────────────────────────╮
      │    ▄▄▄    知行                                                               │
      │   ▌●●▐    初始配置                                                           │
      │    ▀▀     欢迎使用知行                                                       │
      │                                                                              │
      │   工作目录    /test/ws                                                       │
      │   配置        /test/config.toml                                              │
      │   凭证        /test/cred.toml                                                │
      │                                                                              │
      ╰──────────────────────────────────────────────────────────────────────────────╯

       ▎ 对话模型

          主模型必填，辅助模型可选——预留给后续轻量子任务用，未配则沿用主模型

        › 主模型                              ✓ siliconflow · DeepSeek-V3
      ░░▸ 辅助模型░░░░░░░░░░░░░░░░░░░░░░░░░░░░· 未启用（默认沿用主模型）░░░░░░░░░░░░░░

       ▎ 消息通道

          用于接收外部消息触发 agent（如飞书）

        › 飞书                                · 未启用

       ▎ 操作   ✓ 全部就绪

        ┌────────┐
        │  完成  │   (保存并启动)
        └────────┘
        ┌────────┐
        │  取消  │   (退出)
        └────────┘

      ────────────────────────────────────────────────────────────────────────────────
        ↑↓ 选择   ·   Enter 进入/确认   ·   Ctrl+C 退出
      "
    `);
  });

  it("provider-list panel · 选中第一个 provider", () => {
    const out = renderAndCapture((renderer, _stdout) => {
      const state = emptyState();
      const descriptor: PanelDescriptor = {
        kind: "provider-list",
        role: "main",
      };
      renderListPanel(state, descriptor, { index: 0 }, renderer);
    });
    expect(out).toMatchInlineSnapshot(`
      "╭ 主模型 · 选择服务商 ─────────────────────────────────────────────────────────╮
      │                                                                              │
      │   选择 API 服务商作为主模型来源                                              │
      │                                                                              │
      ╰──────────────────────────────────────────────────────────────────────────────╯

      ░░▸ 硅基流动░░░░░░░░░░░░░░░░░░░░░░░░░░░░OpenAI 兼容协议 · 国内可用░░░░░░░░░░░░░░

      ────────────────────────────────────────────────────────────────────────────────
        ↑↓ 选择   ·   Enter 进入   ·   Esc 返回   ·   Ctrl+C 退出
      "
    `);
  });

  it("provider-config panel · API Key 已填、待选模型，选中 API Key 行", () => {
    const out = renderAndCapture((renderer, _stdout) => {
      let state = emptyState();
      state = patchProviderEntry(state, "siliconflow", {
        apiKey: "sk-1234567890abcdef",
      });
      const descriptor: PanelDescriptor = {
        kind: "provider-config",
        role: "main",
        providerId: "siliconflow",
      };
      renderEntityPanel(state, descriptor, { index: 0 }, renderer);
    });
    expect(out).toMatchInlineSnapshot(`
      "╭ 主模型 · 硅基流动 ───────────────────────────────────────────────────────────╮
      │                                                                              │
      │   配置 硅基流动 的 API Key 与使用的模型                                      │
      │                                                                              │
      ╰──────────────────────────────────────────────────────────────────────────────╯

      ░░▸ API Key░░░░░░░░░░░░░░░░░░░░░░░░░░░░░✓ sk-1****cdef░░░░░░░░░░░░░░░░░░░░░░░░░░
        › 使用模型                            ⚠ 待选

        ┌────────┐
        │  完成  │   (请先补全必填项)
        └────────┘

      ────────────────────────────────────────────────────────────────────────────────
        ↑↓ 选择   ·   Enter 进入/确认   ·   Esc 返回   ·   Ctrl+C 退出
      "
    `);
  });

  it("input panel · 编辑 API Key，buffer 含字符（敏感字段，mask 显示）", () => {
    const out = renderAndCapture((renderer, _stdout) => {
      let state = emptyState();
      state = setInputBuffer(state, "sk-newkey123");
      const descriptor: PanelDescriptor = {
        kind: "input",
        fieldId: "provider-apikey:main:siliconflow",
      };
      renderInputPanel(state, descriptor, renderer);
    });
    expect(out).toMatchInlineSnapshot(`
      "╭ 硅基流动 · API Key ──────────────────────────────────────────────────────────╮
      │                                                                              │
      │   用于调用硅基流动的对话 API。                                               │
      │   文档：https://cloud.siliconflow.cn/account/ak                              │
      │                                                                              │
      │   示例：sk-xxxxxxxxxxxxxxxx                                                  │
      │                                                                              │
      ╰──────────────────────────────────────────────────────────────────────────────╯

        > ************

      ────────────────────────────────────────────────────────────────────────────────
        Enter 保存   ·   Esc 取消   ·   Ctrl+C 退出
      "
    `);
  });

  // ─── entity panel · channel-config 分支 ───
  // 演示场景：飞书 channel，appId 已填明文显示、appSecret 待填，cursor 在缺项行；
  // 按钮 "启用" 因缺字段为非 primary，hint = "请先补全必填项"。
  it("entity panel · channel-config（飞书 appId 已填、appSecret 待填）", () => {
    const out = renderAndCapture((renderer, _stdout) => {
      let state = emptyState();
      state = patchChannelEntry(state, "feishu", { appId: "cli_test123" });
      const descriptor: PanelDescriptor = {
        kind: "channel-config",
        channelId: "feishu",
      };
      renderEntityPanel(state, descriptor, { index: 1 }, renderer);
    });
    expect(out).toMatchInlineSnapshot(`
      "╭ 消息通道 · 飞书 ─────────────────────────────────────────────────────────────╮
      │                                                                              │
      │   配置 飞书 的连接凭证                                                       │
      │                                                                              │
      ╰──────────────────────────────────────────────────────────────────────────────╯

        › App ID                              ✓ cli_test123
      ░░▸ App Secret░░░░░░░░░░░░░░░░░░░░░░░░░░⚠ 待填░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░

        ┌────────┐
        │  启用  │   (请先补全必填项)
        └────────┘

      ────────────────────────────────────────────────────────────────────────────────
        ↑↓ 选择   ·   Enter 进入/确认   ·   Esc 返回   ·   Ctrl+C 退出
      "
    `);
  });

  // ─── list panel · model-list 分支 ───
  // 演示场景：用户已添加自定义模型并选中它（● 标记）；cursor 移到末尾的 "+ 添加自定义模型"。
  // 此快照守护：● current 标记位置正确、"+ 添加自定义" 末尾项作为可选项呈现、选中态高亮覆盖整行。
  // 注：硅基流动 preset 当前未设 defaultModel → 列表无 "预设默认" 行；待 preset
  // 引入 defaultModel 后，本快照应失败并新增"预设默认"行——这正是快照守护期望行为。
  it("list panel · model-list（用户自定义模型已选 + ● 标记 + 末尾添加项被选中）", () => {
    const out = renderAndCapture((renderer, _stdout) => {
      let state = emptyState();
      state = addProviderModel(state, "siliconflow", "custom-model-x");
      state = writeModelRole(state, "main", "siliconflow", "custom-model-x");
      const descriptor: PanelDescriptor = {
        kind: "model-list",
        role: "main",
        providerId: "siliconflow",
      };
      renderListPanel(state, descriptor, { index: 1 }, renderer);
    });
    expect(out).toMatchInlineSnapshot(`
      "╭ 硅基流动 · 选择模型 ─────────────────────────────────────────────────────────╮
      │                                                                              │
      │   选择具体使用的 model id；带 ● 的是当前已选                                 │
      │                                                                              │
      ╰──────────────────────────────────────────────────────────────────────────────╯

        › ● custom-model-x
      ░░▸░░░+ 添加自定义模型░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░

      ────────────────────────────────────────────────────────────────────────────────
        ↑↓ 选择   ·   Enter 进入   ·   Esc 返回   ·   Ctrl+C 退出
      "
    `);
  });

  // ─── add-model panel ───
  // 演示场景：用户为 siliconflow 添加自定义模型，buffer 含部分输入；
  // 与普通 input panel 区分：title 是 "<provider> · 添加模型"，footer hints 用 "Enter 添加"。
  it("add-model panel · buffer 含 model id", () => {
    const out = renderAndCapture((renderer, _stdout) => {
      let state = emptyState();
      state = setInputBuffer(state, "deepseek-ai/DeepSeek-Coder");
      const descriptor: PanelDescriptor = {
        kind: "add-model",
        role: "main",
        providerId: "siliconflow",
      };
      renderAddModelPanel(state, descriptor, renderer);
    });
    expect(out).toMatchInlineSnapshot(`
      "╭ 硅基流动 · 添加模型 ─────────────────────────────────────────────────────────╮
      │                                                                              │
      │   输入 model id（按硅基流动文档命名）                                        │
      │   文档：https://cloud.siliconflow.cn/models                                  │
      │                                                                              │
      │   示例：deepseek-ai/DeepSeek-V3                                              │
      │                                                                              │
      ╰──────────────────────────────────────────────────────────────────────────────╯

        > deepseek-ai/DeepSeek-Coder

      ────────────────────────────────────────────────────────────────────────────────
        Enter 添加   ·   Esc 取消   ·   Ctrl+C 退出
      "
    `);
  });
});
