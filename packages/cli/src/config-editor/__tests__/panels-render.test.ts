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

import { Renderer, stripAnsi } from "../../tui/index.js";
import {
  renderMainPanel,
  initialMainCursor,
} from "../panels/main.js";
import { renderListPanel } from "../panels/list.js";
import { renderEntityPanel } from "../panels/entity.js";
import { renderInputPanel, renderAddModelPanel } from "../panels/input.js";
import {
  renderMcpServerPanel,
  renderMcpAddPanel,
  renderMcpAddInputPanel,
  renderMcpChoicesPanel,
} from "../panels/mcp.js";
import { presetToCandidate, type McpSetupCandidate } from "../mcp-setup.js";
import { findMcpPreset } from "../../registries/index.js";
import { renderLoadingFrame } from "../loading.js";
import {
  createInitialState,
  writeModelRole,
  patchProviderEntry,
  patchChannelEntry,
  addProviderModel,
  setInputBuffer,
  upsertMcpServer,
} from "../state.js";
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

          主模型必填；辅助角色（轻量 / 强力）可选，未配则沿用主模型

      ░░▸ 主模型（必填 · 主对话）░░░░░░░░░░░░░⚠ 待配置░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
        › 轻量模型（可选 · 系统侧后台辅助任务）· 未启用（默认沿用主模型）
        › 强力模型（可选 · 进入工作场景时使用）· 未启用（默认沿用主模型）

       ▎ 消息通道

          用于接收外部消息触发 agent（如飞书）

        › 飞书                                · 未启用

       ▎ 操作   ⚠ 待补充 2 项

        ┌────────┐
        │  完成  │   (请先补全必填项)   Ctrl+S
        └────────┘
        ┌────────┐
        │  取消  │   (退出)   Esc
        └────────┘

      ────────────────────────────────────────────────────────────────────────────────
        ↑↓ 选择 · Enter 进入/确认 · Ctrl+S 完成 · Esc / Ctrl+C 退出
      "
    `);
  });

  it("main panel · 全可选编辑器（仅 mcp）不显示就绪 pill", () => {
    const out = renderAndCapture((renderer, stdout) => {
      const ctx: ConfigEditorContext = {
        ...makeContext(stdout),
        sections: ["mcp"],
        title: "MCP 服务",
      };
      renderMainPanel(ctx, emptyState(), initialMainCursor(), renderer);
    });
    // "操作"区仍在，mcp 条目正常渲染——但无完成门槛，故不出现就绪裁决
    expect(out).toContain("操作");
    expect(out).toContain("添加 GitHub");
    expect(out).not.toContain("全部就绪");
    expect(out).not.toContain("待补充");
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

          主模型必填；辅助角色（轻量 / 强力）可选，未配则沿用主模型

        › 主模型（必填 · 主对话）             ✓ siliconflow · DeepSeek-V3
      ░░▸ 轻量模型（可选 · 系统侧后台辅助任务）· 未启用（默认沿用主模型）░░░░░░░░░░░░░
        › 强力模型（可选 · 进入工作场景时使用）· 未启用（默认沿用主模型）

       ▎ 消息通道

          用于接收外部消息触发 agent（如飞书）

        › 飞书                                · 未启用

       ▎ 操作   ✓ 全部就绪

        ┌────────┐
        │  完成  │   (保存并启动)   Ctrl+S
        └────────┘
        ┌────────┐
        │  取消  │   (退出)   Esc
        └────────┘

      ────────────────────────────────────────────────────────────────────────────────
        ↑↓ 选择 · Enter 进入/确认 · Ctrl+S 完成 · Esc / Ctrl+C 退出
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
        › DeepSeek 官方                       OpenAI 兼容协议 · 官方直连

      ────────────────────────────────────────────────────────────────────────────────
        ↑↓ 选择 · Enter 进入 · Esc 返回 · Ctrl+C 退出
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
        ↑↓ 选择 · Enter 进入/确认 · Esc 返回 · Ctrl+C 退出
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
        Enter 保存 · Esc 取消 · Ctrl+C 退出
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
        ↑↓ 选择 · Enter 进入/确认 · Esc 返回 · Ctrl+C 退出
      "
    `);
  });

  // ─── list panel · model-list 分支 ───
  // 此快照守护：
  //   - 列表渲染顺序：preset.knownModels（保序）→ 用户自定义 → "+ 添加自定义"
  //   - 档位推荐标签 "<role> 推荐" 仅出现在"该档位推荐的 provider 命中当前
  //     浏览 provider"那一行；此处浏览 siliconflow 而 main 推荐指向 deepseek，
  //     故全列表无推荐标签（物理层不自荐 model）
  //   - ● current 标记仅出现在用户实际选过的行
  //   - 选中态高亮覆盖整行
  // 增删 preset.knownModels 或改 ROLE_RECOMMENDATIONS 时本快照应失败 —— 这是
  // 快照守护期望行为。
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

        ›   deepseek-ai/DeepSeek-V4-Flash
      ░░▸░░░Pro/MiniMaxAI/MiniMax-M2.5░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
        › ● custom-model-x
        ›   + 添加自定义模型

      ────────────────────────────────────────────────────────────────────────────────
        ↑↓ 选择 · Enter 进入 · Esc 返回 · Ctrl+C 退出
      "
    `);
  });

  // 此快照守护档位推荐标签的**正分支**：浏览的 provider 正是某档位推荐指向的
  // provider 时，被推荐的那个 model 行显示 "<role> 推荐"，其余行无标签。
  // ROLE_RECOMMENDATIONS.main 指向 (deepseek, deepseek-v4-pro)，故 deepseek
  // model-list 在 role=main 下，deepseek-v4-pro 行带 "main 推荐"。
  // 改 ROLE_RECOMMENDATIONS.main 或 deepseek.knownModels 时本快照应失败。
  it("list panel · model-list（档位推荐命中：deepseek + main → v4-pro 标 main 推荐）", () => {
    const out = renderAndCapture((renderer, _stdout) => {
      const state = emptyState();
      const descriptor: PanelDescriptor = {
        kind: "model-list",
        role: "main",
        providerId: "deepseek",
      };
      renderListPanel(state, descriptor, { index: 0 }, renderer);
    });
    expect(out).toMatchInlineSnapshot(`
      "╭ DeepSeek 官方 · 选择模型 ────────────────────────────────────────────────────╮
      │                                                                              │
      │   选择具体使用的 model id；带 ● 的是当前已选                                 │
      │                                                                              │
      ╰──────────────────────────────────────────────────────────────────────────────╯

      ░░▸░░░deepseek-v4-pro░░░░░░░░░░░░░░░░░░░main 推荐░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
        ›   deepseek-v4-flash
        ›   + 添加自定义模型

      ────────────────────────────────────────────────────────────────────────────────
        ↑↓ 选择 · Enter 进入 · Esc 返回 · Ctrl+C 退出
      "
    `);
  });

  // 此快照守护 entity panel 的推荐**正分支**：用户未选 model 但该档位对当前
  // provider 有推荐时，"使用模型"行以 disabled 级别显示 "(main 推荐) <model>"
  // 作引导（非"已选"），preview 以该推荐 model 喂 checkModel。
  it("entity panel · provider-config（档位推荐命中：deepseek + main → 引导显示推荐 model）", () => {
    const out = renderAndCapture((renderer, _stdout) => {
      const state = emptyState();
      const descriptor: PanelDescriptor = {
        kind: "provider-config",
        role: "main",
        providerId: "deepseek",
      };
      renderEntityPanel(state, descriptor, { index: 0 }, renderer);
    });
    expect(out).toMatchInlineSnapshot(`
      "╭ 主模型 · DeepSeek 官方 ──────────────────────────────────────────────────────╮
      │                                                                              │
      │   配置 DeepSeek 官方 的 API Key 与使用的模型                                 │
      │                                                                              │
      ╰──────────────────────────────────────────────────────────────────────────────╯

      ░░▸ API Key░░░░░░░░░░░░░░░░░░░░░░░░░░░░░⚠ 待填░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
        › 使用模型                            · (main 推荐) deepseek-v4-pro

        ┌────────┐
        │  完成  │   (请先补全必填项)
        └────────┘

      ────────────────────────────────────────────────────────────────────────────────
        ↑↓ 选择 · Enter 进入/确认 · Esc 返回 · Ctrl+C 退出
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
      │   示例：deepseek-ai/DeepSeek-V4-Flash                                        │
      │                                                                              │
      ╰──────────────────────────────────────────────────────────────────────────────╯

        > deepseek-ai/DeepSeek-Coder

      ────────────────────────────────────────────────────────────────────────────────
        Enter 添加 · Esc 取消 · Ctrl+C 退出
      "
    `);
  });
});

// ─── mcp-server 详情面板 + loading 态：冒烟（渲染不抛 + 含关键文案） ───
// 用内容断言而非精确快照——只守护"不崩 + 关键信息在场"，不锁死布局细节。
describe("mcp 面板渲染冒烟", () => {
  it("mcp-server panel · 含 server 信息、连接状态与启停/删除按钮", () => {
    const out = renderAndCapture((renderer) => {
      const state = upsertMcpServer(emptyState(), "github", {
        type: "http",
        url: "https://api.githubcopilot.com/mcp/",
      });
      renderMcpServerPanel(
        state,
        { kind: "mcp-server", serverId: "github" },
        { index: 0 },
        renderer,
        {
          mcpServerStatuses: () => [
            { serverId: "github", transport: "http", status: "connected", toolCount: 14 },
          ],
        },
      );
    });
    expect(out).toContain("github");
    expect(out).toContain("已连接 · 14 工具");
    expect(out).toContain("停用");
    expect(out).toContain("删除");
  });

  it("mcp-server panel · 无 runtime 时只显示配置态、不抛", () => {
    const out = renderAndCapture((renderer) => {
      const state = upsertMcpServer(emptyState(), "x", { type: "stdio", command: "c" });
      renderMcpServerPanel(
        state,
        { kind: "mcp-server", serverId: "x" },
        { index: 1 },
        renderer,
      );
    });
    expect(out).toContain("x");
    expect(out).toContain("已启用（暂无连接信息）");
  });

  it("loading frame · 含提示与取消脚注", () => {
    const out = renderAndCapture((renderer) =>
      renderLoadingFrame(renderer, "正在验证连接…"),
    );
    expect(out).toContain("正在验证连接…");
    expect(out).toContain("Esc 取消");
  });

  it("mcp-add panel · 预设候选：说明、密钥提示与错误回显", () => {
    const github = findMcpPreset("github")!;
    const out = renderAndCapture((renderer) => {
      const state = setInputBuffer(emptyState(), "ghp_secret");
      renderMcpAddPanel(
        state,
        {
          kind: "mcp-add",
          candidate: presetToCandidate(github),
          label: github.label,
          description: github.description,
          inputs: {},
          fieldIndex: 0,
          error: "401 bad token",
        },
        renderer,
      );
    });
    expect(out).toContain("接入 GitHub");
    expect(out).toContain("401 bad token");
    expect(out).toContain("Enter 验证并接入");
    // 密钥 mask 显示，不泄漏明文
    expect(out).not.toContain("ghp_secret");
    // 长说明按内容宽度折行而非截断——80 列下 GitHub 提示远超单行预算，旧的"交给
    // chrome 截断加 …"会丢字；折行后输出不应出现截断省略号。
    expect(out).not.toContain("…");
  });

  it("mcp-add panel · 多字段候选：显示进度与当前字段，标题用 serverId 兜底", () => {
    const candidate: McpSetupCandidate = {
      serverId: "custom-x",
      entry: { type: "stdio", command: "npx", args: ["-y", "x"] },
      secretFields: [
        { key: "TOKEN_A", label: "令牌 A", hint: "获取 A 的方式", example: "a_xxx" },
        { key: "TOKEN_B", label: "令牌 B", hint: "获取 B 的方式", example: "b_xxx" },
      ],
      source: "inferred",
    };
    const out = renderAndCapture((renderer) => {
      renderMcpAddPanel(
        emptyState(),
        { kind: "mcp-add", candidate, inputs: {}, fieldIndex: 0 },
        renderer,
      );
    });
    // 无 label → 标题用 serverId 兜底
    expect(out).toContain("接入 custom-x");
    // 多字段 → 显示进度与当前字段名 / 提示
    expect(out).toContain("密钥 1/2");
    expect(out).toContain("令牌 A");
    expect(out).toContain("获取 A 的方式");
  });

  it("mcp-add panel · 推断字段 example 为空 → 不渲染孤立的'示例：'行", () => {
    const candidate: McpSetupCandidate = {
      serverId: "custom-x",
      entry: { type: "stdio", command: "npx", args: ["-y", "x"] },
      secretFields: [{ key: "FOO_TOKEN", label: "Foo Token", hint: "在后台获取", example: "" }],
      source: "inferred",
    };
    const out = renderAndCapture((renderer) => {
      renderMcpAddPanel(
        emptyState(),
        { kind: "mcp-add", candidate, inputs: {}, fieldIndex: 0 },
        renderer,
      );
    });
    expect(out).toContain("在后台获取");
    expect(out).not.toContain("示例：");
  });

  it("mcp-add panel · 密钥字段无 docUrl 但有主页 → 诚实兜底到项目主页", () => {
    const candidate: McpSetupCandidate = {
      serverId: "bar",
      entry: { type: "stdio", command: "npx", args: ["-y", "@foo/bar"] },
      secretFields: [{ key: "FOO_TOKEN", label: "Foo Token", hint: "需要令牌", example: "" }],
      source: "inferred",
      homepage: "https://bar.dev",
    };
    const out = renderAndCapture((renderer) => {
      renderMcpAddPanel(
        emptyState(),
        { kind: "mcp-add", candidate, inputs: {}, fieldIndex: 0 },
        renderer,
      );
    });
    expect(out).toContain("可查项目主页");
    expect(out).toContain("bar.dev");
  });

  it("mcp-add panel · 推断 stdio 候选显示'将运行'命令（探测前知情同意）", () => {
    const candidate: McpSetupCandidate = {
      serverId: "linear",
      entry: { type: "stdio", command: "npx", args: ["-y", "linear-mcp"] },
      secretFields: [],
      source: "inferred",
    };
    const out = renderAndCapture((renderer) => {
      renderMcpAddPanel(
        emptyState(),
        { kind: "mcp-add", candidate, inputs: {}, fieldIndex: 0 },
        renderer,
      );
    });
    expect(out).toContain("将在本机运行");
    expect(out).toContain("npx -y linear-mcp");
    // 无密钥 → 提示直接 Enter
    expect(out).toContain("无需密钥");
  });

  it("mcp-add panel · 预设来源不显示'将运行'命令（curated 可信）", () => {
    const candidate: McpSetupCandidate = {
      serverId: "x",
      entry: { type: "stdio", command: "npx", args: ["y"] },
      secretFields: [{ key: "K", label: "K", hint: "", example: "" }],
      source: "preset",
    };
    const out = renderAndCapture((renderer) => {
      renderMcpAddPanel(
        emptyState(),
        { kind: "mcp-add", candidate, label: "X", inputs: {}, fieldIndex: 0 },
        renderer,
      );
    });
    expect(out).not.toContain("将在本机运行");
  });

  it("mcp-add-input panel · 提示输入标识 + 错误回显（标识明文不 mask）", () => {
    const out = renderAndCapture((renderer) => {
      renderMcpAddInputPanel(
        setInputBuffer(emptyState(), "@org/x"),
        { kind: "mcp-add-input", error: "推断失败" },
        renderer,
      );
    });
    expect(out).toContain("接入其他 server");
    expect(out).toContain("推断失败");
    expect(out).toContain("@org/x");
  });

  it("mcp-choices panel · 列出候选 + 高亮选中项 + 错误回显", () => {
    const out = renderAndCapture((renderer) => {
      renderMcpChoicesPanel(
        emptyState(),
        {
          kind: "mcp-choices",
          choices: [
            { name: "@upstash/context7-mcp", summary: "MCP server for Context7", reason: "下载最高" },
            { name: "ctx7", summary: "CLI", reason: "次之" },
          ],
          selectedIndex: 0,
          error: "提取失败",
        },
        renderer,
      );
    });
    expect(out).toContain("选择 MCP server");
    expect(out).toContain("@upstash/context7-mcp");
    expect(out).toContain("MCP server for Context7");
    expect(out).toContain("ctx7");
    expect(out).toContain("❯"); // 高亮标记
    expect(out).toContain("提取失败");
  });
});
