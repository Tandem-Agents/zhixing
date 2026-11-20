/**
 * 单元 4 完整终端管理体验集成与单元测试（设计 §3.1–§3.4、§7）。
 *
 * 覆盖：
 * 1. 统一生效模型投影（ReplLocalView / /status / terminalEnvironment / 文本 /model 同源，含 v2、工作场景、本会话覆盖、不可用当前项保留）
 * 2. 交互式 /model 完整闭环（总览、搜索与分页、刷新保态、本会话切模 vs 显式设用途默认、恢复跟随、原位调参、换模不兼容重建、宿主拒绝保原选、隐藏与已隐藏型号恢复）
 * 3. /config 模型页完整三块与管理闭环（模型资料与更新状态/刷新/自动检查、预设更新并排对比与采纳/忽略、自定义型号增改删、规格覆盖编辑与删前上游恢复预览、隐藏/恢复、免密/填钥自动发现、动态目录接入与编辑器全栈流转）
 */

import { describe, expect, it, vi } from "vitest";
import type { SessionModelSelection } from "@zhixing-ai/core";
import {
  BUILTIN_CURATED_CATALOG,
  createModelCatalogPortFromBundle,
  resolveConnection,
  resolveLLMRoles,
  type CatalogManagerStatus,
  type CuratedCatalogBundle,
  type ZhixingConfig,
  type ZhixingCredentials,
} from "@zhixing-ai/providers/configuration";
import {
  projectEffectiveModelDisplay,
} from "../runtime/model-display-projection.js";
import { createRuntimeConfigurationProvider } from "../runtime/runtime-configuration-provider.js";
import { ReplLocalView } from "../runtime/repl-local-view.js";
import { serverStatusSummary } from "../runtime/server-status-presentation.js";
import { informationModelLines } from "../terminal/information-presentation.js";
import { terminalEnvironment } from "../terminal/environment-presentation.js";
import {
  TerminalModelCommand,
  isThinkingCompatible,
} from "../terminal/model-command.js";
import type { TerminalSelectionPage, TerminalSelectionPort } from "../terminal/selection.js";
import { modelSection } from "../config-editor/sections/model.js";
import {
  adoptPresetUpdateSuggestion,
  createInitialState,
  ignorePresetUpdateSuggestion,
  previewModelOverrideRestore,
  readConnection,
  readModelMaxOutputPreference,
  readModelRole,
  readModelThinking,
  recordDraftDiscoveryResult,
  renameCustomModel,
  setInputBuffer,
  upsertModelOverride,
  writeModelRole,
  writeModelThinking,
} from "../config-editor/state.js";
import {
  buildConnectionAddMeta,
  buildConnectionCustomModelsMeta,
  buildConnectionHiddenModelsMeta,
  buildConnectionHidePickerMeta,
  buildConnectionListMeta,
  buildModelListMeta,
  buildPresetUpdateListMeta,
  buildProviderListMeta,
  buildThinkingConfigMeta,
  resolveThinkingControl,
} from "../config-editor/model/list.js";
import {
  buildCatalogConfigMeta,
  buildChannelConfigMeta,
  buildConnectionConfigMeta,
  buildConnectionCustomModelDetailMeta,
  buildConnectionDeleteMeta,
  buildMigrationRepairProviderMeta,
  buildModelOverrideDeleteConfirmMeta,
  buildModelOverrideEditMeta,
  buildModelVerifyConfirmMeta,
  buildPresetUpdateReviewMeta,
  buildProviderConfigMeta,
} from "../config-editor/model/entity.js";
import { handleInputPanelKey } from "../config-editor/model/input.js";
import { TerminalConfigurationEditor } from "../terminal/configuration-editor.js";
import type { ConfigEditorRuntime } from "../config-editor/types.js";

function sampleV2Config(): ZhixingConfig {
  return {
    llm: {
      schemaVersion: 2,
      connections: {
        deepseek: {
          name: "DeepSeek 官方",
          presetId: "deepseek",
          presetRevision: "2026.05.01",
          adapter: "openai-compatible",
          endpoint: "https://api.deepseek.com/v1",
          auth: { mode: "api-key", secretRef: "deepseek" },
          network: { proxy: "inherit" },
        },
        anthropic: {
          name: "Anthropic",
          presetId: "anthropic",
          presetRevision: "2026.05.01",
          adapter: "anthropic-messages",
          endpoint: "https://api.anthropic.com",
          auth: { mode: "api-key", secretRef: "anthropic" },
          network: { proxy: "inherit" },
        },
      },
      main: {
        connectionId: "deepseek",
        model: "deepseek-v4-pro",
        params: { thinking: { mode: "effort", effort: "high" } },
      },
      power: {
        connectionId: "anthropic",
        model: "claude-opus-4-7",
      },
    },
  };
}

function sampleV2Credentials(): ZhixingCredentials {
  return {
    version: 2,
    modelSecrets: {
      deepseek: { v: 2, kind: "api-key", value: "sk-ds-unit4-test" },
      anthropic: { v: 2, kind: "api-key", value: "sk-ant-unit4-test" },
    },
  };
}

describe("单元 4A · 统一生效模型投影与多表面同源", () => {
  it("v2 配置在 readReplSurface、ReplLocalView、/status、terminalEnvironment 与文本 /model 保持完全同源", async () => {
    const config = sampleV2Config();
    const creds = sampleV2Credentials();
    const provider = createRuntimeConfigurationProvider(() => config);

    // 1. 修复原 v2 main.provider 为空的回归
    expect(provider.readReplSurface().primaryModel).toEqual({
      providerId: "deepseek",
      model: "deepseek-v4-pro",
    });

    // 2. 普通对话跟随 main → 切换工作场景跟随 power → 本会话覆盖立即同步所有表面
    let mode: "normal" | "workscene" = "normal";
    let selection: SessionModelSelection = { mode: "follow-default" };

    const localView = new ReplLocalView({
      management: { serverDescription: async () => ({ workspace: "/work" }) },
      configuration: provider,
      currentConversationId: () => "conv-1",
      currentSessionMode: () => mode,
      resolveSessionModelSelection: async () => selection,
      readModelCredentials: async () => creds,
    });

    await localView.refresh();
    expect(localView.primaryModel.providerId).toBe("deepseek");
    expect(localView.primaryModel.connectionName).toBe("DeepSeek 官方");
    expect(localView.primaryModel.model).toBe("deepseek-v4-pro");
    expect(localView.primaryModel.sourceLabel).toBe("跟随 main");
    expect(localView.primaryModel.paramsSummary).toContain("强度 high");
    expect(localView.primaryModel.roles?.light.followsMain).toBe(true);
    expect(localView.primaryModel.roles?.power.model).toBe("claude-opus-4-7");

    // 切入工作场景
    mode = "workscene";
    await localView.refresh();
    expect(localView.primaryModel.providerId).toBe("anthropic");
    expect(localView.primaryModel.model).toBe("claude-opus-4-7");
    expect(localView.primaryModel.sourceLabel).toBe("跟随工作场景 power");
    expect(terminalEnvironment(localView).model).toBe("claude-opus-4-7");
    expect(terminalEnvironment(localView).provider).toBe("Anthropic");

    // 本会话覆盖
    selection = {
      mode: "override",
      connectionId: "deepseek",
      model: "deepseek-v4-flash",
      params: { thinking: { mode: "off" } },
    };
    await localView.refresh();
    expect(localView.primaryModel.sourceLabel).toBe("本会话覆盖");
    expect(localView.primaryModel.model).toBe("deepseek-v4-flash");
    expect(localView.primaryModel.paramsSummary).toBe("思考：关闭");

    const textLines = informationModelLines(localView.primaryModel);
    expect(textLines.join("\n")).toContain("模型：deepseek-v4-flash");
    expect(textLines.join("\n")).toContain("生效来源：本会话覆盖");
    expect(textLines.join("\n")).toContain("主模型（main）：DeepSeek 官方 · deepseek-v4-pro");
    expect(textLines.join("\n")).toContain("轻量模型（light）：DeepSeek 官方 · deepseek-v4-pro（沿用 main");
    expect(textLines.join("\n")).toContain("强力模型（power）：Anthropic · claude-opus-4-7");

    const statusPages = serverStatusSummary(
      "工作场景",
      localView.primaryModel,
      localView.networkProxy,
      null,
    );
    const statusText = JSON.stringify(statusPages);
    expect(statusText).toContain("本会话覆盖");
    expect(statusText).toContain("deepseek-v4-flash");
    expect(statusText).toContain("claude-opus-4-7");
  });

  it("不可用当前项（封禁凭据/已停供/连接缺失）始终保留可见并说明原因", () => {
    const config = sampleV2Config();
    const compromisedCreds: ZhixingCredentials = {
      version: 2,
      compromisedModelSecretTokens: { deepseek: "opaque-token" },
    };
    const projected = projectEffectiveModelDisplay({
      config,
      credentials: compromisedCreds,
      sessionMode: "normal",
    });
    expect(projected.model).toBe("deepseek-v4-pro");
    expect(projected.available).toBe(false);
    expect(projected.unavailableReason).toContain("已封禁");
    expect(informationModelLines(projected).join("\n")).toContain("状态警示");
  });
});

describe("单元 4B · 交互式 /model 完整体验", () => {
  function createScriptedChooser(
    steps: ReadonlyArray<
      (page: TerminalSelectionPage) => {
        itemId: string;
        input?: string;
        cancelCause?: "escape" | "ctrl-c" | "ctrl-d" | "aborted";
      }
    >,
    options?: { scriptBusy?: boolean },
  ): {
    choose: TerminalSelectionPort;
    pages: TerminalSelectionPage[];
  } {
    const pages: TerminalSelectionPage[] = [];
    let idx = 0;
    const choose: TerminalSelectionPort = async (page, signalOrOptions) => {
      pages.push(page);
      const signal =
        signalOrOptions && "aborted" in signalOrOptions
          ? signalOrOptions
          : signalOrOptions?.signal;
      if (page.busy && signal && !options?.scriptBusy) {
        if (signal.aborted) return { itemId: "cancelled", cancelCause: "aborted" };
        return await new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve({ itemId: "cancelled", cancelCause: "aborted" }),
            { once: true },
          );
        });
      }
      const handler = steps[idx++];
      if (!handler) return { itemId: "option:action:close" };
      return handler(page);
    };
    return { choose, pages };
  }

  it("支持搜索、刷新目录保搜索词、本会话切模不改全局默认、恢复跟随默认", async () => {
    let config = sampleV2Config();
    let creds = sampleV2Credentials();
    let selection: SessionModelSelection = { mode: "follow-default" };
    const onChanged = vi.fn(async () => {});
    const refreshCatalog = vi.fn(async () => ({
      status: "up-to-date",
      changed: false,
      activeRevision: "2026.11.20-rev2",
    }));

    const { choose, pages } = createScriptedChooser([
      // 1. 首页点击搜索
      (page) => {
        expect(page.message).toContain("跟随 main");
        expect(page.message).toContain("main=");
        expect(page.message).toContain("light=");
        expect(page.message).toContain("power=");
        return { itemId: "option:action:search" };
      },
      // 2. 输入搜索词 "flash"
      () => ({ itemId: "submit", input: "flash" }),
      // 3. 验证筛选生效，点击刷新目录（必须保留搜索词 "flash"！）
      (page) => {
        expect(page.message).toContain("搜索筛选：“flash”");
        return { itemId: "option:action:refresh-catalog" };
      },
      // 4. 刷新后搜索词仍在，选中 deepseek-v4-flash
      (page) => {
        expect(page.message).toContain("搜索筛选：“flash”");
        expect(page.message).toContain("2026.11.20-rev2");
        const flashChoice = page.choices?.find((c) => c.label.includes("deepseek-v4-flash"));
        expect(flashChoice).toBeDefined();
        return { itemId: flashChoice!.id };
      },
      // 5. 模型动作页：点击“仅本会话使用”
      () => ({ itemId: "option:use-session" }),
      // 6. 旧参数 effort=high 与 deepseek-v4-flash 不兼容 → 重建控件页，选“采用默认”
      (page) => {
        expect(page.message).toContain("不兼容");
        return { itemId: "option:default" };
      },
      // 7. 回到首页：验证已切为“本会话覆盖”，且出现“恢复跟随默认”→ 点击恢复
      (page) => {
        expect(page.message).toContain("本会话覆盖");
        expect(page.choices?.some((c) => c.id === "option:action:follow-default")).toBe(true);
        return { itemId: "option:action:follow-default" };
      },
      // 8. 返回输入
      () => ({ itemId: "option:action:close" }),
    ]);

    const controller = { current: { conversationId: "conv-1", mode: { kind: "normal" as const } } };
    const cmd = new TerminalModelCommand({
      controller: () => controller,
      conversation: {
        getModelSelection: async () => ({ modelSelection: selection }),
        setModelSelection: async (_id, next) => {
          selection = next;
          return { modelSelection: selection };
        },
      },
      readConfiguration: async () => ({ config, credentials: creds }),
      saveModelConfiguration: async (mutate) => {
        config = mutate(config);
        return { kind: "local-applied" };
      },
      readCatalog: async () => createModelCatalogPortFromBundle(BUILTIN_CURATED_CATALOG),
      refreshCatalog,
      choose,
      publishNotice: async () => {},
      onChanged,
      signal: new AbortController().signal,
    });

    await cmd.run();
    expect(refreshCatalog).toHaveBeenCalledTimes(1);
    expect(selection).toEqual({ mode: "follow-default" });
    // 全局 main 保持原样未被本会话切换改写
    expect(config.llm?.main?.model).toBe("deepseek-v4-pro");
    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(pages.length).toBeGreaterThanOrEqual(8);
  });

  it("支持不换模型原位调参（可选仅本会话或写入用途默认）与工作场景默认聚焦 power", async () => {
    let config = sampleV2Config();
    let creds = sampleV2Credentials();
    let selection: SessionModelSelection = { mode: "follow-default" };

    const { choose } = createScriptedChooser([
      // 1. 首页点击“调整当前模型参数（原位调参）”
      () => ({ itemId: "option:action:tune" }),
      // 2. deepseek-v4-pro 为 effort 形态，选择“思考强度：max”
      (page) => {
        const maxOpt = page.choices?.find((c) => c.id === "option:effort:max");
        expect(maxOpt).toBeDefined();
        return { itemId: maxOpt!.id };
      },
      // 3. 作用域选择页：选择“写入主模型默认（main）”
      () => ({ itemId: "option:main" }),
      // 4. 退出
      () => ({ itemId: "option:action:close" }),
    ]);

    const controller = { current: { conversationId: "conv-1", mode: { kind: "normal" as const } } };
    const cmd = new TerminalModelCommand({
      controller: () => controller,
      conversation: {
        getModelSelection: async () => ({ modelSelection: selection }),
        setModelSelection: async (_id, next) => {
          selection = next;
          return { modelSelection: selection };
        },
      },
      readConfiguration: async () => ({ config, credentials: creds }),
      saveModelConfiguration: async (mutate) => {
        config = mutate(config);
        return { kind: "local-applied" };
      },
      readCatalog: async () => createModelCatalogPortFromBundle(BUILTIN_CURATED_CATALOG),
      refreshCatalog: async () => ({ status: "up-to-date", changed: false, activeRevision: "v1" }),
      choose,
      publishNotice: async () => {},
      onChanged: async () => {},
      signal: new AbortController().signal,
    });

    await cmd.run();
    expect(config.llm?.main?.params?.thinking).toEqual({ mode: "effort", effort: "max" });
    // 本会话仍保持 follow-default（因为写到了 main 默认）
    expect(selection).toEqual({ mode: "follow-default" });
  });

  it("隐藏供应方型号写入 hiddenModels（刷新不复活），并可从“已隐藏型号（N）”一键恢复显示", async () => {
    let config = sampleV2Config();
    let creds = sampleV2Credentials();
    let selection: SessionModelSelection = { mode: "follow-default" };

    const { choose } = createScriptedChooser([
      // 1. 选中 deepseek-v4-flash
      (page) => {
        const target = page.choices?.find((c) => c.label.includes("deepseek-v4-flash"));
        expect(target).toBeDefined();
        return { itemId: target!.id };
      },
      // 2. 点击“隐藏此型号”
      () => ({ itemId: "option:hide-model" }),
      // 3. 回到首页：deepseek-v4-flash 已消失，底部出现“已隐藏型号（1）”→ 点击展开
      (page) => {
        expect(page.choices?.some((c) => c.label.includes("deepseek-v4-flash"))).toBe(false);
        const hiddenOpt = page.choices?.find((c) => c.id === "option:action:hidden");
        expect(hiddenOpt?.label).toBe("已隐藏型号（1）");
        return { itemId: hiddenOpt!.id };
      },
      // 4. 在已隐藏子页点击恢复显示
      (page) => {
        const unhideOpt = page.choices?.find((c) => c.label.includes("deepseek-v4-flash"));
        expect(unhideOpt).toBeDefined();
        return { itemId: unhideOpt!.id };
      },
      // 5. 回到首页验证已恢复，退出
      (page) => {
        expect(page.choices?.some((c) => c.label.includes("deepseek-v4-flash"))).toBe(true);
        expect(page.choices?.some((c) => c.id === "option:action:hidden")).toBe(false);
        return { itemId: "option:action:close" };
      },
    ]);

    const controller = { current: { conversationId: "conv-1", mode: { kind: "normal" as const } } };
    const cmd = new TerminalModelCommand({
      controller: () => controller,
      conversation: {
        getModelSelection: async () => ({ modelSelection: selection }),
        setModelSelection: async (_id, next) => {
          selection = next;
          return { modelSelection: selection };
        },
      },
      readConfiguration: async () => ({ config, credentials: creds }),
      saveModelConfiguration: async (mutate) => {
        config = mutate(config);
        return { kind: "local-applied" };
      },
      readCatalog: async () => createModelCatalogPortFromBundle(BUILTIN_CURATED_CATALOG),
      refreshCatalog: async () => ({ status: "up-to-date", changed: false, activeRevision: "v1" }),
      choose,
      publishNotice: async () => {},
      onChanged: async () => {},
      signal: new AbortController().signal,
    });

    await cmd.run();
    expect(config.llm?.connections.deepseek?.hiddenModels).toBeUndefined();
  });

  it("大目录自动安全分页（单页选项永远不超过 32 上限）且宿主拒绝切模时保留原选择", async () => {
    const config = sampleV2Config();
    const creds = sampleV2Credentials();
    const manyDiscovered = Array.from({ length: 45 }, (_, i) => ({
      id: `discovered-model-${i + 1}`,
    }));
    const selection: SessionModelSelection = { mode: "follow-default" };

    const { choose, pages } = createScriptedChooser([
      // 首页验证分页且选项数 <= 32 → 点击下一页
      (page) => {
        expect((page.choices ?? []).length).toBeLessThanOrEqual(32);
        expect(page.choices?.some((c) => c.id === "option:page:next")).toBe(true);
        return { itemId: "option:page:next" };
      },
      // 第 2 页选中一个模型
      (page) => {
        expect((page.choices ?? []).length).toBeLessThanOrEqual(32);
        const m = page.choices?.find((c) => c.label.includes("discovered-model-"));
        expect(m).toBeDefined();
        return { itemId: m!.id };
      },
      // 尝试本会话使用
      () => ({ itemId: "option:use-session" }),
      // 旧参数 effort=high 与无思考控件的 discovered-model 不兼容 → 先在重建页选默认
      (page) => {
        expect(page.message).toContain("不兼容");
        return { itemId: "option:default" };
      },
      // 回到首页验证宿主拒绝错误提示并保留原选择
      (page) => {
        expect(page.message).toContain("历史含图片材料");
        expect(page.message).toContain("跟随 main");
        return { itemId: "option:action:close" };
      },
    ]);

    const controller = { current: { conversationId: "conv-1", mode: { kind: "normal" as const } } };
    const cmd = new TerminalModelCommand({
      controller: () => controller,
      conversation: {
        getModelSelection: async () => ({ modelSelection: selection }),
        setModelSelection: async () => {
          throw new Error("目标模型不支持当前会话历史含图片材料，请改选支持视觉的模型或使用 /new 开启新对话");
        },
      },
      readConfiguration: async () => ({ config, credentials: creds }),
      saveModelConfiguration: async () => ({ kind: "local-applied" }),
      readCatalog: async () => createModelCatalogPortFromBundle(BUILTIN_CURATED_CATALOG),
      refreshCatalog: async () => ({ status: "up-to-date", changed: false, activeRevision: "v1" }),
      readDiscoveryRecords: async (connId) =>
        connId === "deepseek"
          ? { models: manyDiscovered, authoritativeNativeFacts: false }
          : undefined,
      choose,
      publishNotice: async () => {},
      onChanged: async () => {},
      signal: new AbortController().signal,
    });

    await cmd.run();
    expect(pages.length).toBe(5);
    expect(isThinkingCompatible({ type: "budget", range: [1024, 32000] }, { mode: "budget", budget: 64000 }).compatible).toBe(false);
  });

  it("工作场景下「设为用途默认」默认聚焦 power，写入后仅更新 power 不改 main", async () => {
    let config = sampleV2Config();
    let creds = sampleV2Credentials();
    const selection: SessionModelSelection = { mode: "follow-default" };
    const controller = {
      current: {
        conversationId: "conv-ws",
        mode: { kind: "workscene" as const, sceneName: "架构评审" },
      },
    };
    const { choose } = createScriptedChooser([
      // 1. 选中 claude-sonnet-4-7
      (page) => {
        expect(page.message).toContain("跟随工作场景 power");
        const target = page.choices?.find((c) => c.label.includes("claude-sonnet-4-7"));
        expect(target).toBeDefined();
        return { itemId: target!.id };
      },
      // 2. 点击“设为用途默认”
      () => ({ itemId: "option:set-role-default" }),
      // 3. 验证默认焦点在 power，确认写入 power
      (page) => {
        expect(page.initialItemId).toBe("option:power");
        return { itemId: "option:power" };
      },
      // 4. 退出
      () => ({ itemId: "option:action:close" }),
    ]);

    const cmd = new TerminalModelCommand({
      controller: () => controller,
      conversation: {
        getModelSelection: async () => ({ modelSelection: selection }),
        setModelSelection: async (_id, next) => ({ modelSelection: next }),
      },
      readConfiguration: async () => ({ config, credentials: creds }),
      saveModelConfiguration: async (mutate) => {
        config = mutate(config);
        return { kind: "local-applied" };
      },
      readCatalog: async () => createModelCatalogPortFromBundle(BUILTIN_CURATED_CATALOG),
      refreshCatalog: async () => ({ status: "up-to-date", changed: false, activeRevision: "v1" }),
      choose,
      publishNotice: async () => {},
      onChanged: async () => {},
      signal: new AbortController().signal,
    });

    await cmd.run();
    expect(config.llm?.power?.model).toBe("claude-sonnet-4-7");
    expect(config.llm?.main?.model).toBe("deepseek-v4-pro");
  });
});

describe("单元 4C · /config 模型页三块、预设建议、自定义 CRUD、覆盖恢复预览与隐藏恢复", () => {
  it("模型资料与更新块展示来源/修订/状态、支持立即刷新与自动检查开关", async () => {
    let status: CatalogManagerStatus = {
      source: "trusted-remote",
      activeRevision: "2026.11.20-r1",
      publishedAt: "2026-11-20T00:00:00.000Z",
      autoCheckEnabled: true,
      repositoryConfigured: true,
      lastCheckedAt: "2026-11-20T10:00:00.000Z",
      lastStatus: "up-to-date",
    };

    const runtime: ConfigEditorRuntime = {
      modelCatalog: () => createModelCatalogPortFromBundle(BUILTIN_CURATED_CATALOG),
      catalogStatus: () => status,
      setCatalogAutoCheck: async (enabled) => {
        status = { ...status, autoCheckEnabled: enabled, lastStatus: enabled ? "idle" : "disabled" };
        return status;
      },
      refreshModelCatalog: async () => {
        status = { ...status, activeRevision: "2026.11.20-r2", lastStatus: "updated" };
        return {
          status: "updated",
          changed: true,
          activeRevision: "2026.11.20-r2",
          port: createModelCatalogPortFromBundle(BUILTIN_CURATED_CATALOG),
          message: "已更新",
        };
      },
    };

    const state = createInitialState(sampleV2Config(), sampleV2Credentials());
    const entries = modelSection.entries(state, runtime);
    const catalogEntry = entries.find((e) => e.label === "模型资料与更新");
    expect(catalogEntry).toBeDefined();
    expect(catalogEntry!.state.statusText).toContain("官方可信目录");
    expect(catalogEntry!.state.statusText).toContain("2026.11.20-r1");
    expect(catalogEntry!.enterTarget).toEqual({ kind: "catalog-config" });

    // 进入 catalog-config：切换自动检查 + 立即刷新
    const meta = buildCatalogConfigMeta(state, { kind: "catalog-config" }, runtime);
    const toggleRow = meta.rows.find((r) => r.label === "后台自动检查更新")!;
    const toggleAction = toggleRow.onEnter(state).action;
    expect(toggleAction.type).toBe("loading");
    if (toggleAction.type === "loading") {
      const next = await toggleAction.run(new AbortController().signal, () => {});
      expect(next.type).toBe("replace");
      expect(status.autoCheckEnabled).toBe(false);
    }

    const refreshBtn = meta.buttons.find((b) => b.label === "刷新")!;
    const refreshAction = refreshBtn.onEnter(state).action;
    expect(refreshAction.type).toBe("loading");
    if (refreshAction.type === "loading") {
      const next = await refreshAction.run(new AbortController().signal, () => {});
      expect(next.type).toBe("replace");
      expect(status.activeRevision).toBe("2026.11.20-r2");
    }
  });

  it("预设更新建议并排对比：支持忽略此修订（不改端点）或采纳并重新发现", async () => {
    const updatedBundle: CuratedCatalogBundle = {
      ...BUILTIN_CURATED_CATALOG,
      catalogRevision: "2026.12.01-next",
      presets: BUILTIN_CURATED_CATALOG.presets.map((p) =>
        p.id === "deepseek"
          ? {
              ...p,
              presetRevision: "2026.12.01",
              baseUrl: "https://api-v2.deepseek.com/v1",
            }
          : p,
      ),
    };
    const updatedCatalog = createModelCatalogPortFromBundle(updatedBundle);
    const discoverSpy = vi.fn(async () => ({
      status: "discovered" as const,
      connectionId: "deepseek",
      endpoint: "https://api-v2.deepseek.com/v1",
      adapter: "openai-compatible" as const,
      models: [{ id: "deepseek-v4-pro" }],
      checkedAt: new Date().toISOString(),
      userMessage: "发现 1 项",
      authoritativeNativeFacts: true,
    }));
    const runtime: ConfigEditorRuntime = {
      modelCatalog: () => updatedCatalog,
      discoverModels: discoverSpy,
    };

    const state = createInitialState(sampleV2Config(), sampleV2Credentials());
    // 顶部模型页 + 连接列表 + 连接详情都出现建议标记
    expect(modelSection.entries(state, runtime).some((e) => e.label === "预设更新建议")).toBe(true);
    expect(
      buildConnectionListMeta(state, runtime).items.some((i) =>
        i.description?.includes("有预设更新建议"),
      ),
    ).toBe(true);
    expect(
      buildConnectionConfigMeta(state, { kind: "connection-config", connectionId: "deepseek" }, runtime)
        .rows.some((r) => r.label === "预设更新建议"),
    ).toBe(true);
    expect(buildPresetUpdateListMeta(state, runtime).items[0]!.label).toContain("DeepSeek");

    // 并排对比页
    const review = buildPresetUpdateReviewMeta(
      state,
      { kind: "preset-update-review", connectionId: "deepseek" },
      runtime,
    );
    const endpointRow = review.rows.find((r) => r.label === "接口端点对比")!;
    expect(endpointRow.status.text).toContain("https://api.deepseek.com/v1");
    expect(endpointRow.status.text).toContain("https://api-v2.deepseek.com/v1");

    // 分支 1：忽略此修订 → 端点不变且建议消失
    const ignoredState = ignorePresetUpdateSuggestion(state, "deepseek", "2026.12.01");
    expect(readConnection(ignoredState, "deepseek")?.endpoint).toBe("https://api.deepseek.com/v1");
    expect(modelSection.entries(ignoredState, runtime).some((e) => e.label === "预设更新建议")).toBe(false);

    // 分支 2：采纳并重新发现 → 更新端点与修订并触发 discoverModels
    const adoptBtn = review.buttons.find((b) => b.label === "采纳")!;
    const adoptAction = adoptBtn.onEnter(state).action;
    expect(adoptAction.type).toBe("loading");
    if (adoptAction.type === "loading") {
      const done = await adoptAction.run(new AbortController().signal, () => {});
      expect(done.type).toBe("pop");
      if (done.type === "pop") {
        expect(readConnection(done.state, "deepseek")?.endpoint).toBe("https://api-v2.deepseek.com/v1");
        expect(readConnection(done.state, "deepseek")?.presetRevision).toBe("2026.12.01");
        expect(done.state.draftDiscoveryByConnection?.deepseek?.status).toBe("discovered");
      }
    }
    expect(discoverSpy).toHaveBeenCalledTimes(1);

    // 直接调用 pure helper 也同步清除 ignoredPresetRevision
    const directAdopted = adoptPresetUpdateSuggestion(
      ignoredState,
      "deepseek",
      updatedCatalog.getPresetUpdateSuggestion("deepseek", readConnection(state, "deepseek")!)!,
    );
    expect(readConnection(directAdopted, "deepseek")?.ignoredPresetRevision).toBeUndefined();
  });

  it("自定义型号增改删、规格覆盖删除前上游恢复预览、隐藏与恢复显示完整闭环", () => {
    let state = createInitialState(sampleV2Config(), sampleV2Credentials());

    // 1. 新增自定义型号
    const addRes = handleInputPanelKey(
      setInputBuffer(state, "my-custom-v1"),
      { kind: "input", fieldId: "conn-custom-add:deepseek" },
      { type: "enter" },
    );
    expect(addRes.type).toBe("pop");
    if (addRes.type === "pop") state = addRes.state;
    expect(readConnection(state, "deepseek")?.customModels).toEqual(["my-custom-v1"]);

    // 设置覆盖与用途绑定，然后重命名自定义型号 → 自动迁移覆盖与用途绑定
    state = upsertModelOverride(state, "deepseek", "my-custom-v1", {
      contextWindow: 64_000,
      supportsImages: true,
    });
    state = writeModelRole(state, "light", "deepseek", "my-custom-v1");
    state = renameCustomModel(state, "deepseek", "my-custom-v1", "my-custom-v2");
    expect(readConnection(state, "deepseek")?.customModels).toEqual(["my-custom-v2"]);
    expect(readConnection(state, "deepseek")?.modelOverrides?.["my-custom-v2"]?.contextWindow).toBe(64_000);
    expect(readConnection(state, "deepseek")?.modelOverrides?.["my-custom-v1"]).toBeUndefined();
    expect(readModelRole(state, "light")?.model).toBe("my-custom-v2");

    // 自定义列表与详情删除
    expect(
      buildConnectionCustomModelsMeta(state, { kind: "connection-custom-models", connectionId: "deepseek" })
        .items.some((i) => i.label === "my-custom-v2"),
    ).toBe(true);
    const customDetail = buildConnectionCustomModelDetailMeta(state, {
      kind: "connection-custom-model-detail",
      connectionId: "deepseek",
      modelId: "my-custom-v2",
    });
    const delCustomAction = customDetail.buttons.find((b) => b.label === "删除")!.onEnter(state).action;
    if (delCustomAction.type === "pop") state = delCustomAction.state;
    expect(readConnection(state, "deepseek")?.customModels).toBeUndefined();

    // 2. 对目录收录型号 deepseek-v4-pro 设规格覆盖 → 删前恢复预览明示官方策展目录上游值与来源
    state = upsertModelOverride(state, "deepseek", "deepseek-v4-pro", {
      contextWindow: 65_536,
      supportsImages: true,
    });
    const preview = previewModelOverrideRestore(state, "deepseek", "deepseek-v4-pro");
    const ctxRow = preview.find((r) => r.field === "contextWindow")!;
    expect(ctxRow.currentValue).toBe("65536 tokens");
    expect(ctxRow.restoredValue).not.toBe("未知");
    expect(ctxRow.restoredSource).toBe("官方策展目录");

    const confirmMeta = buildModelOverrideDeleteConfirmMeta(state, {
      kind: "model-override-delete-confirm",
      connectionId: "deepseek",
      modelId: "deepseek-v4-pro",
    });
    expect(confirmMeta.rows.some((r) => r.status.text.includes("恢复为") && r.status.text.includes("官方策展目录"))).toBe(true);

    // 确认删除覆盖 → 仅删覆盖，不删 deepseek-v4-pro 目录条目
    const confirmDelAction = confirmMeta.buttons.find((b) => b.label === "确认删")!.onEnter(state).action;
    if (confirmDelAction.type === "pop") state = confirmDelAction.state;
    expect(readConnection(state, "deepseek")?.modelOverrides?.["deepseek-v4-pro"]).toBeUndefined();
    expect(
      buildModelListMeta(state, { kind: "model-list", role: "main", providerId: "deepseek" })
        .items.some((i) => i.label === "deepseek-v4-pro"),
    ).toBe(true);

    // 规格覆盖编辑页切换布尔覆盖 + 数值覆盖与输入 0 清除
    const overrideAddAction = handleInputPanelKey(
      setInputBuffer(state, "deepseek-v4-pro"),
      { kind: "input", fieldId: "conn-override-add:deepseek" },
      { type: "enter" },
    );
    expect(overrideAddAction).toEqual({
      type: "replace",
      state: setInputBuffer(state, ""),
      panel: { kind: "model-override-edit", connectionId: "deepseek", modelId: "deepseek-v4-pro" },
    });
    const ctxSetAction = handleInputPanelKey(
      setInputBuffer(state, "160000"),
      { kind: "input", fieldId: "conn-override-ctx:deepseek:deepseek-v4-pro" },
      { type: "enter" },
    );
    if (ctxSetAction.type === "pop") {
      expect(readConnection(ctxSetAction.state, "deepseek")?.modelOverrides?.["deepseek-v4-pro"]?.contextWindow).toBe(160_000);
      const ctxClearAction = handleInputPanelKey(
        setInputBuffer(ctxSetAction.state, "0"),
        { kind: "input", fieldId: "conn-override-ctx:deepseek:deepseek-v4-pro" },
        { type: "enter" },
      );
      if (ctxClearAction.type === "pop") {
        expect(readConnection(ctxClearAction.state, "deepseek")?.modelOverrides?.["deepseek-v4-pro"]).toBeUndefined();
        expect(readConnection(ctxClearAction.state, "deepseek")?.modelOverrides?.["my-custom-v2"]).toEqual({
          contextWindow: 64_000,
          supportsImages: true,
        });
      }
    }
    const editMeta = buildModelOverrideEditMeta(state, {
      kind: "model-override-edit",
      connectionId: "deepseek",
      modelId: "deepseek-v4-pro",
    });
    const imgAction = editMeta.rows.find((r) => r.label.includes("图片输入"))!.onEnter(state).action;
    if (imgAction.type === "stay") {
      expect(readConnection(imgAction.state, "deepseek")?.modelOverrides?.["deepseek-v4-pro"]?.supportsImages).toBe(true);
    }

    // 3. 隐藏供应方型号 + 一键恢复
    const hidePicker = buildConnectionHidePickerMeta(state, {
      kind: "connection-hide-picker",
      connectionId: "deepseek",
    });
    const flashHide = hidePicker.items.find((i) => i.label === "deepseek-v4-flash")!;
    const hideAction = flashHide.onEnter(state);
    if (hideAction.type === "pop") state = hideAction.state;
    expect(readConnection(state, "deepseek")?.hiddenModels).toEqual(["deepseek-v4-flash"]);

    const hiddenList = buildConnectionHiddenModelsMeta(state, {
      kind: "connection-hidden-models",
      connectionId: "deepseek",
    });
    const restoreAction = hiddenList.items.find((i) => i.label.includes("deepseek-v4-flash"))!.onEnter(state);
    if (restoreAction.type === "stay") state = restoreAction.state;
    expect(readConnection(state, "deepseek")?.hiddenModels).toBeUndefined();
  });

  it("免密本地预设 Ollama 与填写凭据后自动触发本地只读发现，且换模不兼容时重建思考控件", async () => {
    const discoverSpy = vi.fn(async () => ({
      status: "discovered" as const,
      connectionId: "ollama",
      endpoint: "http://127.0.0.1:11434/v1",
      adapter: "openai-compatible" as const,
      models: [{ id: "qwen2.5:14b" }],
      checkedAt: new Date().toISOString(),
      userMessage: "发现 1 项",
      authoritativeNativeFacts: true,
    }));
    const runtime: ConfigEditorRuntime = {
      modelCatalog: () => createModelCatalogPortFromBundle(BUILTIN_CURATED_CATALOG),
      discoverModels: discoverSpy,
    };

    // 1. 选择免密预设 Ollama → 自动触发只读发现 loading
    const emptyState = createInitialState({}, {});
    const addMeta = buildConnectionAddMeta(emptyState, runtime);
    const ollamaItem = addMeta.items.find((i) => i.label.includes("Ollama"))!;
    const addAction = ollamaItem.onEnter(emptyState);
    expect(addAction.type).toBe("loading");
    if (addAction.type === "loading") {
      const resolved = await addAction.run(new AbortController().signal, () => {});
      expect(resolved.type).toBe("replace");
      if (resolved.type === "replace" && resolved.panel.kind === "connection-config") {
        expect(resolved.panel.initialModel).toBe("qwen2.5:14b");
        expect(resolved.state.draftDiscoveryByConnection?.ollama?.status).toBe("discovered");
      }
    }
    expect(discoverSpy).toHaveBeenCalledTimes(1);

    // 2. 填写有效连接密钥后自动触发本地只读发现
    const secretState = createInitialState(sampleV2Config(), sampleV2Credentials());
    const secretAction = handleInputPanelKey(
      setInputBuffer(secretState, "sk-ds-rotated-key"),
      { kind: "input", fieldId: "conn-secret:deepseek" },
      { type: "enter" },
      runtime,
    );
    expect(secretAction.type).toBe("loading");
    if (secretAction.type === "loading") {
      const done = await secretAction.run(new AbortController().signal, () => {});
      expect(done.type).toBe("pop");
    }
    expect(discoverSpy).toHaveBeenCalledTimes(2);

    // 3. 换模不兼容思考参数（effort: high → anthropic budget 形态 claude-sonnet-4-5-20250929）→ 重建控件并提示原因
    let state = createInitialState(sampleV2Config(), sampleV2Credentials());
    state = writeModelThinking(state, "main", { mode: "effort", effort: "high" });
    const anthropicModels = buildModelListMeta(
      state,
      { kind: "model-list", role: "main", providerId: "anthropic" },
      runtime,
    );
    const sonnetBudgetItem = anthropicModels.items.find(
      (i) => i.label === "claude-sonnet-4-5-20250929",
    )!;
    const switchAction = sonnetBudgetItem.onEnter(state);
    expect(switchAction.type).toBe("navigate");
    if (switchAction.type === "navigate" && switchAction.panel.kind === "thinking-config") {
      expect(switchAction.panel.notice).toContain("不兼容");
      const thinkingMeta = buildThinkingConfigMeta(switchAction.state, switchAction.panel, runtime);
      expect(thinkingMeta.description).toContain("不兼容");
      expect(readModelThinking(switchAction.state, "main")).toBeUndefined();
    }
  });

  it("TerminalConfigurationEditor 端到端导航新面板无异常且严禁泄漏密钥", async () => {
    const published: Array<{ title: string; choices?: ReadonlyArray<{ id: string; label: string; detail?: string }> }> = [];
    const editor = new TerminalConfigurationEditor({
      session: {
        initialConfig: sampleV2Config(),
        initialCredentials: sampleV2Credentials(),
        writers: { save: async () => {} },
      },
      title: "配置",
      sections: ["model"],
      purpose: "edit",
      runtime: {
        modelCatalog: () => createModelCatalogPortFromBundle(BUILTIN_CURATED_CATALOG),
        catalogStatus: () => ({
          source: "bundled",
          activeRevision: BUILTIN_CURATED_CATALOG.catalogRevision,
          publishedAt: BUILTIN_CURATED_CATALOG.publishedAt,
          autoCheckEnabled: true,
          repositoryConfigured: true,
          lastStatus: "idle",
        }),
      },
      publish: async (view) => {
        // 断言任何推送给 U 的帧绝不含明文 API Key
        const serialized = JSON.stringify(view);
        expect(serialized).not.toContain("sk-ds-unit4-test");
        expect(serialized).not.toContain("sk-ant-unit4-test");
        published.push(view);
      },
    });

    const runPromise = editor.run();
    await Promise.resolve();

    const mainView = published.at(-1)!;
    const catChoice = mainView.choices!.find((c) => c.label === "模型资料与更新")!;
    expect(catChoice).toBeDefined();

    // 进入“模型资料与更新”面板
    await editor.act({ kind: "configuration-action", editId: editor.editId, action: catChoice.id });
    expect(published.at(-1)!.title).toBe("模型资料与更新");

    // 返回主面板并取消
    await editor.act({ kind: "configuration-action", editId: editor.editId, action: "back" });
    await editor.act({ kind: "configuration-action", editId: editor.editId, action: "cancel" });

    const result = await runPromise;
    expect(result.kind).toBe("cancelled");
  });
});

describe("单元 4 R2 回归 · F1 可选用途回退投影 / F2 输出偏好显示、保留与控件 / F3 能力覆盖贯通运行", () => {
  it("F1：工作场景 power 连接缺凭据时与真实 resolveLLMRoles 同源回退 main，保留原配置意图与警示", async () => {
    const good = {
      name: "Local main",
      adapter: "openai-compatible" as const,
      endpoint: "http://127.0.0.1:11434/v1",
      auth: { mode: "none" as const },
      network: { proxy: "direct" as const, allowPrivateOrigin: true },
      customModels: ["local-model"],
    };
    const config: ZhixingConfig = {
      llm: {
        schemaVersion: 2,
        connections: {
          good,
          bad: {
            ...good,
            name: "Unavailable power",
            auth: { mode: "api-key", secretRef: "missing-key" },
          },
        },
        main: { connectionId: "good", model: "local-model", maxOutputPreference: 128 },
        power: { connectionId: "bad", model: "power-model" },
      },
    };

    const actual = resolveLLMRoles(config, {});
    const shown = projectEffectiveModelDisplay({
      config,
      credentials: {},
      sessionMode: "workscene",
      sessionSelection: { mode: "follow-default" },
    });

    expect(shown.connectionId).toBe(actual.power.resolved.connectionId);
    expect(shown.model).toBe(actual.power.model);
    expect(shown.maxOutputPreference).toBe(128);
    expect(shown.available).toBe(true);
    expect(shown.sourceLabel).toContain("回退 main");
    expect(shown.warning).toContain("power-model");
    expect(shown.warning).toContain("local-model");
    expect(shown.degradedFrom).toMatchObject({
      role: "power",
      connectionId: "bad",
      model: "power-model",
    });
    expect(shown.roles?.power.degradedToMain).toBe(true);
    expect(shown.roles?.power.configuredModel).toBe("power-model");

    // 验证所有同源表面（ReplLocalView / 文本 /model / /status / terminalEnvironment）一致反映回退与警示
    const localView = new ReplLocalView({
      management: { serverDescription: async () => ({ workspace: "/work" }) },
      configuration: createRuntimeConfigurationProvider(() => config),
      currentConversationId: () => "conv-ws",
      currentSessionMode: () => "workscene",
      resolveSessionModelSelection: async () => ({ mode: "follow-default" }),
      readModelCredentials: async () => ({}),
    });
    await localView.refresh();
    expect(localView.primaryModel.connectionId).toBe("good");
    expect(localView.primaryModel.model).toBe("local-model");
    expect(terminalEnvironment(localView)).toMatchObject({
      provider: "Local main",
      model: "local-model",
    });

    const textLines = informationModelLines(localView.primaryModel).join("\n");
    expect(textLines).toContain("模型：local-model");
    expect(textLines).toContain("回退警示");
    expect(textLines).toContain("power-model");
    expect(textLines).toContain("输出偏好：128 tokens");

    const statusPages = serverStatusSummary(
      "工作场景",
      localView.primaryModel,
      localView.networkProxy,
      null,
    );
    const modelRow = statusPages[0]!.sections[0]!.rows[0]!;
    expect(modelRow.value).toBe("local-model");
    expect(modelRow.tone).toBe("warn");
    expect(modelRow.note).toContain("power-model");
  });

  it("F2：本会话输出偏好完整显示、仅调思考保留主/会话输出偏好、并在 /model 与 /config 完整支持合法输出偏好编辑与清除", async () => {
    const good = {
      name: "DeepSeek Local",
      presetId: "deepseek",
      adapter: "openai-compatible" as const,
      endpoint: "http://127.0.0.1:11434/v1",
      auth: { mode: "none" as const },
      network: { proxy: "direct" as const, allowPrivateOrigin: true },
    };
    const baseConfig: ZhixingConfig = {
      llm: {
        schemaVersion: 2,
        connections: { good },
        main: {
          connectionId: "good",
          model: "deepseek-v4-pro",
          maxOutputPreference: 512,
        },
      },
    };

    // 1. 本会话 override 的 maxOutputPreference 在投影、文本 /model、/status 均完整显示
    const overridden: SessionModelSelection = {
      mode: "override",
      connectionId: "good",
      model: "deepseek-v4-pro",
      maxOutputPreference: 256,
    };
    const overrideShown = projectEffectiveModelDisplay({
      config: baseConfig,
      credentials: {},
      sessionMode: "normal",
      sessionSelection: overridden,
    });
    expect(overrideShown.maxOutputPreference).toBe(256);
    expect(overrideShown.paramsSummary).toContain("256 tokens");
    expect(informationModelLines(overrideShown).join("\n")).toContain("输出偏好：256 tokens");

    const runScript = async (
      initialCfg: ZhixingConfig,
      initialSel: SessionModelSelection,
      steps: Array<{ itemId: string; input?: string }>,
    ) => {
      let currentCfg = structuredClone(initialCfg);
      let currentSel = structuredClone(initialSel);
      let idx = 0;
      const pages: TerminalSelectionPage[] = [];
      const controller = { current: { conversationId: "conv-f2", mode: { kind: "normal" as const } } };
      const cmd = new TerminalModelCommand({
        controller: () => controller,
        conversation: {
          getModelSelection: async () => ({ modelSelection: currentSel }),
          setModelSelection: async (_id, next) => {
            currentSel = next;
            return { modelSelection: next };
          },
        },
        readConfiguration: async () => ({ config: currentCfg, credentials: {} }),
        saveModelConfiguration: async (mutate) => {
          currentCfg = mutate(currentCfg);
          return { kind: "local-applied" as const };
        },
        readCatalog: async () => createModelCatalogPortFromBundle(BUILTIN_CURATED_CATALOG),
        refreshCatalog: async () => ({
          status: "up-to-date",
          changed: false,
          activeRevision: BUILTIN_CURATED_CATALOG.catalogRevision,
        }),
        choose: async (page) => {
          pages.push(page);
          return steps[idx++];
        },
        publishNotice: async () => {},
        onChanged: async () => {},
        signal: new AbortController().signal,
      });
      await cmd.run();
      cmd.dispose();
      return { currentCfg, currentSel, pages };
    };

    // 2. 原位仅关闭思考写 main → 完整保留原 512 输出偏好
    const mainTune = await runScript(baseConfig, { mode: "follow-default" }, [
      { itemId: "option:action:tune" },
      { itemId: "option:off" },
      { itemId: "option:main" },
      { itemId: "option:action:close" },
    ]);
    expect(mainTune.currentCfg.llm?.main?.params?.thinking).toEqual({ mode: "off" });
    expect(mainTune.currentCfg.llm?.main?.maxOutputPreference).toBe(512);

    // 3. 原位仅关闭思考写 session → 完整保留本会话 256 输出偏好
    const sessionTune = await runScript(baseConfig, overridden, [
      { itemId: "option:action:tune" },
      { itemId: "option:off" },
      { itemId: "option:session" },
      { itemId: "option:action:close" },
    ]);
    expect(sessionTune.currentSel.mode).toBe("override");
    if (sessionTune.currentSel.mode === "override") {
      expect(sessionTune.currentSel.params?.thinking).toEqual({ mode: "off" });
      expect(sessionTune.currentSel.maxOutputPreference).toBe(256);
    }

    // 4. 在 /model 调整输出偏好：超物理上限（999999 > 384000）被拒并留页提示，合法值 384 写入 session 且保留原思考参数，再支持清除
    const sessionWithThinking: SessionModelSelection = {
      mode: "override",
      connectionId: "good",
      model: "deepseek-v4-pro",
      params: { thinking: { mode: "off" } },
      maxOutputPreference: 256,
    };
    const outputEdit = await runScript(baseConfig, sessionWithThinking, [
      { itemId: "option:action:tune" },
      { itemId: "option:output:set" },
      { itemId: "submit", input: "999999" },
      { itemId: "option:output:set" },
      { itemId: "submit", input: "384" },
      { itemId: "option:session" },
      { itemId: "option:action:tune" },
      { itemId: "option:output:clear" },
      { itemId: "option:main" },
      { itemId: "option:action:close" },
    ]);
    expect(outputEdit.pages[3]!.message).toContain("超出该模型物理最大输出上限");
    if (outputEdit.currentSel.mode === "override") {
      expect(outputEdit.currentSel.maxOutputPreference).toBe(384);
      expect(outputEdit.currentSel.params?.thinking).toEqual({ mode: "off" });
    }
    expect(outputEdit.currentCfg.llm?.main?.maxOutputPreference).toBeUndefined();

    // 5. /config 用途页（provider-list & provider-config）暴露 output.maxTokensPreference 控件，校验范围、保留 thinking 且支持清除
    let cfgState = createInitialState(baseConfig, {});
    cfgState = writeModelThinking(cfgState, "main", { mode: "off" });
    const providerList = buildProviderListMeta(cfgState, { kind: "provider-list", role: "main" });
    expect(providerList.items.some((i) => i.label.includes("输出偏好"))).toBe(true);
    const providerCfg = buildProviderConfigMeta(cfgState, {
      kind: "provider-config",
      role: "main",
      providerId: "good",
    });
    // Button 0 仍为“完成”，Button 1 为“调输出”（详细说明在 hint，满足 ChoiceView 8 列宽不截断）
    expect(providerCfg.buttons[0]!.label).toBe("完成");
    expect(providerCfg.buttons[1]!.label).toBe("调输出");
    expect(providerCfg.buttons[1]!.hint).toContain("输出偏好");

    // 超过物理上限 65536 → 留页报错（不 pop、不丢输入、不写入），保持原 512
    const rejectOut = handleInputPanelKey(
      setInputBuffer(cfgState, "999999"),
      { kind: "input", fieldId: "role-max-output:main:good" },
      { type: "enter" },
    );
    expect(rejectOut.type).toBe("stay");
    if (rejectOut.type === "stay") {
      expect(rejectOut.errorMessage).toContain("超出该模型物理最大输出上限");
      expect(rejectOut.state.inputBuffer).toBe("999999");
      expect(readModelMaxOutputPreference(rejectOut.state, "main")).toBe(512);
    }

    // 合法值 1024 → 写入且保留 thinking={mode:off}
    const setOut = handleInputPanelKey(
      setInputBuffer(cfgState, "1024"),
      { kind: "input", fieldId: "role-max-output:main:good" },
      { type: "enter" },
    );
    if (setOut.type === "pop") {
      cfgState = setOut.state;
      expect(readModelMaxOutputPreference(cfgState, "main")).toBe(1024);
      expect(readModelThinking(cfgState, "main")).toEqual({ mode: "off" });
      expect(
        modelSection.entries(cfgState).find((e) => e.label.startsWith("主模型"))?.state.statusText,
      ).toContain("输出偏好 1024");
    }

    // 输入 0 清除输出偏好，仍保留 thinking={mode:off}
    const clearOut = handleInputPanelKey(
      setInputBuffer(cfgState, "0"),
      { kind: "input", fieldId: "role-max-output:main:good" },
      { type: "enter" },
    );
    if (clearOut.type === "pop") {
      expect(readModelMaxOutputPreference(clearOut.state, "main")).toBeUndefined();
      expect(readModelThinking(clearOut.state, "main")).toEqual({ mode: "off" });
    }
  });

  it("F3：/config 规格覆盖把 supportsTools / supportsThinking 设为 false 后，resolveConnection 与 resolveThinkingControl 均生效且恢复预览准确", () => {
    const conn = {
      name: "Review",
      presetId: "deepseek",
      adapter: "openai-compatible" as const,
      endpoint: "http://127.0.0.1:11434/v1",
      auth: { mode: "none" as const },
      network: { proxy: "direct" as const, allowPrivateOrigin: true },
    };
    let state = createInitialState(
      {
        llm: {
          schemaVersion: 2,
          connections: { local: conn },
          main: { connectionId: "local", model: "deepseek-v4-pro" },
        },
      },
      {},
    );

    for (const labelPrefix of ["工具调用", "思考能力"]) {
      for (let step = 0; step < 2; step++) {
        const meta = buildModelOverrideEditMeta(state, {
          kind: "model-override-edit",
          connectionId: "local",
          modelId: "deepseek-v4-pro",
        });
        const row = meta.rows.find((r) => r.label.startsWith(labelPrefix))!;
        const action = row.onEnter(state).action;
        if (action.type === "stay") state = action.state;
      }
    }

    const updatedConn = readConnection(state, "local")!;
    expect(updatedConn.modelOverrides?.["deepseek-v4-pro"]?.supportsTools).toBe(false);
    expect(updatedConn.modelOverrides?.["deepseek-v4-pro"]?.supportsThinking).toBe(false);

    const resolved = resolveConnection("local", updatedConn, {});
    const resolvedModel = resolved.declaredModels.find((m) => m.id === "deepseek-v4-pro")!;
    expect(resolvedModel.supportsTools).toBe(false);
    expect(resolvedModel.supportsThinking).toBe(false);
    expect(resolvedModel.thinkingControl).toEqual({ type: "none" });
    expect(resolveThinkingControl("local", "deepseek-v4-pro", state)).toEqual({ type: "none" });

    // 删除覆盖前恢复预览准确呈现将恢复为上游 true
    const preview = previewModelOverrideRestore(state, "local", "deepseek-v4-pro");
    expect(preview.find((p) => p.field === "supportsTools")?.restoredValue).toBe("支持 (true)");
    expect(preview.find((p) => p.field === "supportsThinking")?.restoredValue).toBe("支持 (true)");
  });
});

describe("单元 4 R3 回归 · F4 /model 刷新等待即时可退 / F5 按钮 8 列不截断 / F6 输入校验留页报错", () => {
  function displayColumns(text: string): number {
    let cols = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0) ?? 0;
      const isWide =
        (cp >= 0x1100 && cp <= 0x115f) ||
        (cp >= 0x2e80 && cp <= 0xa4cf) ||
        (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe10 && cp <= 0xfe6f) ||
        (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6);
      cols += isWide ? 2 : 1;
    }
    return cols;
  }

  it("F4a（连宿主）：/model 刷新模型目录挂起时立即展示可操作等待页，按 Esc 立刻退回可用列表保搜索词，宿主继续后台完成且不重复发起请求", async () => {
    let config = sampleV2Config();
    const creds = sampleV2Credentials();
    const selection: SessionModelSelection = { mode: "follow-default" };
    const onChanged = vi.fn(async () => {});
    const notices: string[] = [];

    let resolveRefresh!: (receipt: {
      status: string;
      changed: boolean;
      activeRevision: string;
      message?: string;
    }) => void;
    let receivedOfflineSignal: AbortSignal | undefined;
    const refreshCatalog = vi.fn(
      (offlineSignal?: AbortSignal) =>
        new Promise<{
          status: string;
          changed: boolean;
          activeRevision: string;
          message?: string;
        }>((resolve) => {
          receivedOfflineSignal = offlineSignal;
          resolveRefresh = resolve;
        }),
    );

    let step = 0;
    let secondWaitSignalAborted = false;
    const seenPages: TerminalSelectionPage[] = [];
    const choose: TerminalSelectionPort = async (page, signalOrOptions) => {
      const signal =
        signalOrOptions && "aborted" in signalOrOptions
          ? signalOrOptions
          : signalOrOptions?.signal;
      seenPages.push(page);
      step++;
      // 1. 首页进入搜索
      if (step === 1) return { itemId: "option:action:search" };
      // 2. 输入搜索词 "flash"
      if (step === 2) return { itemId: "submit", input: "flash" };
      // 3. 在筛选状态下点击“刷新模型目录”
      if (step === 3) {
        expect(page.message).toContain("搜索筛选：“flash”");
        return { itemId: "option:action:refresh-catalog" };
      }
      // 4. 立即出现 busy=true 等待页，按 Esc 立即返回列表（不卡死、不报 expired）
      if (step === 4) {
        expect(page.busy).toBe(true);
        expect(page.title).toBe("刷新模型目录");
        expect(page.choices?.some((c) => c.id === "back-list")).toBe(true);
        expect(page.choices?.some((c) => c.id === "exit-model")).toBe(true);
        return { itemId: "cancelled", cancelCause: "escape" };
      }
      // 5. 已立即回到可用 /model 列表：保留搜索词 "flash"、提示后台进行中、入口文案变为“查看目录刷新进度”（独立 action:refresh-progress），再次进入复用同一刷新而非重发
      if (step === 5) {
        expect(page.busy).not.toBe(true);
        expect(page.message).toContain("搜索筛选：“flash”");
        expect(page.message).toContain("后台进行中");
        expect(
          page.choices?.some(
            (c) => c.id === "option:action:refresh-progress" && c.label === "查看目录刷新进度",
          ),
        ).toBe(true);
        return { itemId: "option:action:refresh-progress" };
      }
      // 6. 复挂到同一进行中等待页 → 此时模拟宿主后台刷新完成，验证 waitAbort.signal 被正确中止
      if (step === 6) {
        expect(page.busy).toBe(true);
        expect(refreshCatalog).toHaveBeenCalledTimes(1);
        return await new Promise((resolve) => {
          signal?.addEventListener(
            "abort",
            () => {
              secondWaitSignalAborted = true;
              resolve({ itemId: "cancelled", cancelCause: "aborted" });
            },
            { once: true },
          );
          queueMicrotask(() => {
            resolveRefresh({
              status: "updated",
              changed: true,
              activeRevision: "2026.11.20-rev3",
              message: "宿主后台刷新完成",
            });
          });
        });
      }
      // 7. 刷新完成后自动切回列表，展示新修订且仍保留搜索词 "flash"
      if (step === 7) {
        expect(page.message).toContain("搜索筛选：“flash”");
        expect(page.message).toContain("2026.11.20-rev3");
        return { itemId: "option:action:close" };
      }
      return { itemId: "option:action:close" };
    };

    const controller = { current: { conversationId: "conv-r3-host", mode: { kind: "normal" as const } } };
    const cmd = new TerminalModelCommand({
      controller: () => controller,
      conversation: {
        getModelSelection: async () => ({ modelSelection: selection }),
        setModelSelection: async () => ({ modelSelection: selection }),
      },
      readConfiguration: async () => ({ config, credentials: creds }),
      saveModelConfiguration: async (mutate) => {
        config = mutate(config);
        return { kind: "local-applied" };
      },
      readCatalog: async () => createModelCatalogPortFromBundle(BUILTIN_CURATED_CATALOG),
      isHostConnected: () => true,
      refreshCatalog,
      choose,
      publishNotice: async (message) => {
        notices.push(message);
      },
      onChanged,
      signal: new AbortController().signal,
    });

    await cmd.run();
    expect(refreshCatalog).toHaveBeenCalledTimes(1);
    expect(receivedOfflineSignal).toBeUndefined();
    expect(secondWaitSignalAborted).toBe(true);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(seenPages.length).toBe(7);
    expect(notices.some((n) => n.includes("expired") || n.includes("操作未完成"))).toBe(false);
  });

  it("F4b（离线）：/model 刷新等待时按 Esc 或选返回对话输入，立即中止本地刷新 signal 并返回", async () => {
    let config = sampleV2Config();
    const creds = sampleV2Credentials();
    const selection: SessionModelSelection = { mode: "follow-default" };
    const notices: string[] = [];
    const signals: Array<AbortSignal | undefined> = [];

    const refreshCatalog = vi.fn(
      (offlineSignal?: AbortSignal) =>
        new Promise<{ status: string; changed: boolean; activeRevision: string }>((resolve) => {
          signals.push(offlineSignal);
          offlineSignal?.addEventListener(
            "abort",
            () => resolve({ status: "offline", changed: false, activeRevision: "2026.11.20-r1" }),
            { once: true },
          );
        }),
    );

    let step = 0;
    const choose: TerminalSelectionPort = async (page) => {
      step++;
      // 1. 触发刷新
      if (step === 1) return { itemId: "option:action:refresh-catalog" };
      // 2. 等待页按 Esc → 立即取消离线刷新并回到列表
      if (step === 2) {
        expect(page.busy).toBe(true);
        expect(page.message).toContain("取消本次本地刷新");
        return { itemId: "cancelled", cancelCause: "escape" };
      }
      // 3. 回到列表后确认已取消提示，再次触发刷新
      if (step === 3) {
        expect(page.message).toContain("已取消本次模型目录刷新");
        return { itemId: "option:action:refresh-catalog" };
      }
      // 4. 第二次等待页直接选“返回对话输入”退出 /model
      return { itemId: "exit-model" };
    };

    const controller = { current: { conversationId: "conv-r3-offline", mode: { kind: "normal" as const } } };
    const cmd = new TerminalModelCommand({
      controller: () => controller,
      conversation: {
        getModelSelection: async () => ({ modelSelection: selection }),
        setModelSelection: async () => ({ modelSelection: selection }),
      },
      readConfiguration: async () => ({ config, credentials: creds }),
      saveModelConfiguration: async (mutate) => {
        config = mutate(config);
        return { kind: "local-applied" };
      },
      readCatalog: async () => createModelCatalogPortFromBundle(BUILTIN_CURATED_CATALOG),
      isHostConnected: () => false,
      refreshCatalog,
      choose,
      publishNotice: async (message) => {
        notices.push(message);
      },
      onChanged: async () => {},
      signal: new AbortController().signal,
    });

    await cmd.run();
    expect(refreshCatalog).toHaveBeenCalledTimes(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(true);
    expect(notices.some((n) => n.includes("已取消本次模型目录刷新"))).toBe(true);
  });

  it("F5：所有 EntityMeta 按钮标签显示宽度均 <= 6 列（适配 ChoiceView width={8} 零截断且保留 2 列间距）", () => {
    const baseState = createInitialState(sampleV2Config(), {
      ...sampleV2Credentials(),
      protectedLegacyProviders: {
        legacy: { apiKey: "sk-legacy-only-test", baseUrl: "https://user:pass@legacy.example.com/v1" },
      },
    });
    const state401 = recordDraftDiscoveryResult(baseState, "deepseek", {
      status: "auth-rejected",
      draftRevision: baseState.draftRevision,
      checkedAt: "2026-11-20T00:00:00Z",
      sanitizedEndpoint: "https://api.deepseek.com/v1",
      proxyRoute: "inherit",
      modeUsed: "native",
      authoritativeNativeFacts: false,
      models: [],
      httpStatus: 401,
      errorSubcode: "auth_invalid_credentials",
      userMessage: "401 rejected",
    });
    const stateWithCustomAndOverride = upsertModelOverride(
      {
        ...baseState,
        config: {
          ...baseState.config,
          llm: {
            ...(baseState.config.llm as NonNullable<ZhixingConfig["llm"]>),
            connections: {
              ...(baseState.config.llm as Extract<NonNullable<ZhixingConfig["llm"]>, { schemaVersion: 2 }>).connections,
              deepseek: {
                ...(baseState.config.llm as Extract<NonNullable<ZhixingConfig["llm"]>, { schemaVersion: 2 }>).connections.deepseek!,
                customModels: ["my-custom-v1"],
              },
            },
          },
        },
      },
      "deepseek",
      "deepseek-v4-pro",
      { contextWindow: 65_536 },
    );

    const updatedBundle: CuratedCatalogBundle = {
      ...BUILTIN_CURATED_CATALOG,
      catalogRevision: "2026.12.01-next",
      presets: BUILTIN_CURATED_CATALOG.presets.map((p) =>
        p.id === "deepseek"
          ? { ...p, presetRevision: "2026.12.01", baseUrl: "https://api-v2.deepseek.com/v1" }
          : p,
      ),
    };
    const runtime: ConfigEditorRuntime = {
      modelCatalog: () => createModelCatalogPortFromBundle(updatedBundle),
      catalogStatus: () => ({
        source: "bundled",
        activeRevision: updatedBundle.catalogRevision,
        publishedAt: updatedBundle.publishedAt,
        autoCheckEnabled: true,
        repositoryConfigured: true,
        lastStatus: "idle",
      }),
    };

    const allMetas = [
      { name: "provider-config", meta: buildProviderConfigMeta(baseState, { kind: "provider-config", role: "main", providerId: "deepseek" }, runtime) },
      { name: "connection-config(401)", meta: buildConnectionConfigMeta(state401, { kind: "connection-config", connectionId: "deepseek" }, runtime) },
      { name: "connection-delete", meta: buildConnectionDeleteMeta(baseState, { kind: "connection-delete", connectionId: "deepseek" }) },
      { name: "migration-repair-provider", meta: buildMigrationRepairProviderMeta(baseState, { kind: "migration-repair-provider", providerId: "legacy" }) },
      { name: "channel-config", meta: buildChannelConfigMeta(baseState, { kind: "channel-config", channelId: "feishu" }) },
      { name: "model-verify-confirm", meta: buildModelVerifyConfirmMeta(baseState, { kind: "model-verify-confirm", connectionId: "deepseek" }, runtime) },
      { name: "catalog-config", meta: buildCatalogConfigMeta(baseState, { kind: "catalog-config" }, runtime) },
      { name: "preset-update-review", meta: buildPresetUpdateReviewMeta(baseState, { kind: "preset-update-review", connectionId: "deepseek" }, runtime) },
      { name: "connection-custom-model-detail", meta: buildConnectionCustomModelDetailMeta(stateWithCustomAndOverride, { kind: "connection-custom-model-detail", connectionId: "deepseek", modelId: "my-custom-v1" }) },
      { name: "model-override-edit", meta: buildModelOverrideEditMeta(stateWithCustomAndOverride, { kind: "model-override-edit", connectionId: "deepseek", modelId: "deepseek-v4-pro" }, runtime) },
      { name: "model-override-delete-confirm", meta: buildModelOverrideDeleteConfirmMeta(stateWithCustomAndOverride, { kind: "model-override-delete-confirm", connectionId: "deepseek", modelId: "deepseek-v4-pro" }, runtime) },
    ];

    for (const { name, meta } of allMetas) {
      expect(meta.buttons.length, `${name} 应至少包含 1 个按钮`).toBeGreaterThan(0);
      for (const btn of meta.buttons) {
        const cols = displayColumns(btn.label);
        expect(
          cols,
          `${name} 按钮「${btn.label}」显示宽度 ${cols} 超出 6 列安全预算（ChoiceView width={8} 会截断或紧贴 hint）`,
        ).toBeLessThanOrEqual(6);
      }
    }
  });

  it("F6：TerminalConfigurationEditor 端到端输入校验——非法输出偏好/规格覆盖留页报错、保留草稿不静默 pop，合法值正常提交", async () => {
    const baseConfig: ZhixingConfig = {
      llm: {
        schemaVersion: 2,
        connections: {
          good: {
            name: "DeepSeek Local",
            presetId: "deepseek",
            adapter: "openai-compatible",
            endpoint: "http://127.0.0.1:11434/v1",
            auth: { mode: "none" },
            network: { proxy: "direct", allowPrivateOrigin: true },
          },
        },
        main: {
          connectionId: "good",
          model: "deepseek-v4-pro",
          maxOutputPreference: 512,
        },
      },
    };

    const views: Array<{
      title: string;
      message?: string;
      field?: { id: string; value?: string };
      choices?: ReadonlyArray<{ id: string; label: string; detail?: string }>;
    }> = [];

    const editor = new TerminalConfigurationEditor({
      session: {
        initialConfig: baseConfig,
        initialCredentials: {},
        writers: { save: async () => {} },
      },
      title: "配置",
      sections: ["model"],
      purpose: "edit",
      runtime: {
        modelCatalog: () => createModelCatalogPortFromBundle(BUILTIN_CURATED_CATALOG),
      },
      publish: async (view) => {
        views.push(view);
      },
    });

    const runPromise = editor.run();
    await Promise.resolve();

    const pickByLabelContains = async (text: string) => {
      const latest = views.at(-1)!;
      const choice = latest.choices?.find((c) => c.label.includes(text));
      expect(choice, `未在「${latest.title}」找到包含「${text}」的选项`).toBeDefined();
      await editor.act({ kind: "configuration-action", editId: editor.editId, action: choice!.id });
    };

    // 主界面 → 主模型 → 选择当前连接 → 点击“调输出”进入 role-max-output 输入页
    await pickByLabelContains("主模型");
    await pickByLabelContains("● DeepSeek Local");
    await pickByLabelContains("调输出");

    const inputPage = views.at(-1)!;
    expect(inputPage.title).toContain("请求输出偏好");
    expect(inputPage.field).toBeDefined();

    // 1. 提交 "-1" → 必须留在输入页，不 pop，保留 "-1"，展示 ⚠ 错误提示
    await editor.act({ kind: "configuration-action", editId: editor.editId, action: "field", value: "-1" });
    const afterNeg = views.at(-1)!;
    expect(afterNeg.title).toContain("请求输出偏好");
    expect(afterNeg.field?.value).toBe("-1");
    expect(afterNeg.message).toContain("⚠");
    expect(afterNeg.message).toContain("正整数");

    // 2. 提交超过物理上限 "999999" → 仍留在输入页，保留 "999999"，展示物理上限错误提示
    await editor.act({ kind: "configuration-action", editId: editor.editId, action: "field", value: "999999" });
    const afterHuge = views.at(-1)!;
    expect(afterHuge.title).toContain("请求输出偏好");
    expect(afterHuge.field?.value).toBe("999999");
    expect(afterHuge.message).toContain("⚠");
    expect(afterHuge.message).toContain("超出该模型物理最大输出上限");

    // 3. 提交合法值 "1024" → 正常 pop 回用途配置页，清错且显示 1024
    await editor.act({ kind: "configuration-action", editId: editor.editId, action: "field", value: "1024" });
    const afterValid = views.at(-1)!;
    expect(afterValid.field).toBeUndefined();
    expect(afterValid.message ?? "").not.toContain("⚠");
    expect(afterValid.choices?.some((c) => c.detail?.includes("1024"))).toBe(true);

    // 4. 同理校验 conn-override-ctx / conn-override-out 非法输入返回 stay + errorMessage 并保留草稿
    const cfgState = createInitialState(baseConfig, {});
    const badCtx = handleInputPanelKey(
      setInputBuffer(cfgState, "-5"),
      { kind: "input", fieldId: "conn-override-ctx:good:deepseek-v4-pro" },
      { type: "enter" },
    );
    expect(badCtx.type).toBe("stay");
    if (badCtx.type === "stay") {
      expect(badCtx.errorMessage).toContain("⚠");
      expect(badCtx.state.inputBuffer).toBe("-5");
    }

    const badOut = handleInputPanelKey(
      setInputBuffer(cfgState, "abc"),
      { kind: "input", fieldId: "conn-override-out:good:deepseek-v4-pro" },
      { type: "enter" },
    );
    expect(badOut.type).toBe("stay");
    if (badOut.type === "stay") {
      expect(badOut.errorMessage).toContain("⚠");
      expect(badOut.state.inputBuffer).toBe("abc");
    }

    await editor.act({ kind: "configuration-action", editId: editor.editId, action: "cancel" });
    expect((await runPromise).kind).toBe("cancelled");
  });
});

describe("单元 4 R4 回归 · F4 后台刷新完成后当前 /model 列表原地收口（保搜索/页码/选择/实时焦点，不暗中重发）", () => {
  /** 复刻 TerminalApplication.#choosePage + root.tsx 同 requestId 焦点保持语义的测试夹具。 */
  function createLiveSelectionHarness() {
    let reqSeq = 0;
    let current:
      | {
          readonly requestId: string;
          page: TerminalSelectionPage;
          focusedId: string | undefined;
          active: boolean;
          resolve: (res: { itemId: string; input?: string; cancelCause?: "escape" | "ctrl-c" | "ctrl-d" | "aborted" }) => void;
        }
      | undefined;
    const frames: Array<{ readonly requestId: string; readonly kind: "open" | "live-update"; readonly page: TerminalSelectionPage; readonly focusedId: string | undefined }> = [];
    let onFrameWaiter: (() => void) | undefined;

    const resolveFocus = (page: TerminalSelectionPage, previousId?: string): string | undefined => {
      const choices = page.choices ?? [];
      for (const id of [previousId, page.initialItemId]) {
        if (id && choices.some((c) => c.id === id && !c.disabled)) return id;
      }
      return choices.find((c) => !c.disabled)?.id;
    };

    const notifyFrame = () => {
      const waiter = onFrameWaiter;
      onFrameWaiter = undefined;
      waiter?.();
    };

    const choose: TerminalSelectionPort = async (page, signalOrOptions) => {
      const opts =
        signalOrOptions && "aborted" in signalOrOptions
          ? { signal: signalOrOptions }
          : signalOrOptions;
      if (opts?.signal?.aborted) return { itemId: "cancelled", cancelCause: "aborted" };
      const requestId = `req-${++reqSeq}`;
      return await new Promise((resolve) => {
        const entry = {
          requestId,
          page,
          focusedId: resolveFocus(page, undefined),
          active: true,
          resolve: (res: { itemId: string; input?: string; cancelCause?: "escape" | "ctrl-c" | "ctrl-d" | "aborted" }) => {
            if (!entry.active) return;
            entry.active = false;
            if (current === entry) current = undefined;
            resolve(res);
          },
        };
        current = entry;
        frames.push({ requestId, kind: "open", page, focusedId: entry.focusedId });
        notifyFrame();

        opts?.signal?.addEventListener(
          "abort",
          () => entry.resolve({ itemId: "cancelled", cancelCause: "aborted" }),
          { once: true },
        );

        opts?.onActive?.({
          isActive: () => entry.active && current === entry,
          update: async (nextPage) => {
            if (!entry.active || current !== entry) return false;
            // 同 requestId 保持用户已移动的实时焦点（与 terminal-ui surface-layout.ts#initialChoiceIndex 完全一致）
            entry.focusedId = resolveFocus(nextPage, entry.focusedId);
            entry.page = nextPage;
            frames.push({ requestId, kind: "live-update", page: nextPage, focusedId: entry.focusedId });
            notifyFrame();
            return entry.active && current === entry;
          },
        });
      });
    };

    const waitForFrame = async (predicate: () => boolean) => {
      for (let i = 0; i < 40; i++) {
        if (predicate()) return;
        await new Promise<void>((resolve) => {
          onFrameWaiter = resolve;
          setTimeout(resolve, 15);
        });
      }
      expect(predicate(), "等待预期帧更新超时").toBe(true);
    };

    return {
      choose,
      frames,
      get current() {
        return current;
      },
      moveFocus(itemId: string) {
        expect(current?.page.choices?.some((c) => c.id === itemId && !c.disabled)).toBe(true);
        current!.focusedId = itemId;
      },
      respond(res: { itemId: string; input?: string; cancelCause?: "escape" | "ctrl-c" | "ctrl-d" | "aborted" }) {
        expect(current).toBeDefined();
        current!.resolve(res);
      },
      waitForFrame,
    };
  }

  it("F4-R4a（updated）：Esc 回到列表并移动焦点后，后台完成原地收口到最新修订与新模型，保持同一 requestId、搜索词与实时焦点，且不重发请求", async () => {
    let config = sampleV2Config();
    const creds = sampleV2Credentials();
    const selection: SessionModelSelection = { mode: "follow-default" };
    const onChanged = vi.fn(async () => {});

    let activeCatalogBundle: CuratedCatalogBundle = BUILTIN_CURATED_CATALOG;
    let resolveRefresh!: (receipt: {
      status: string;
      changed: boolean;
      activeRevision: string;
      message?: string;
    }) => void;
    const refreshCatalog = vi.fn(
      () =>
        new Promise<{
          status: string;
          changed: boolean;
          activeRevision: string;
          message?: string;
        }>((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    const harness = createLiveSelectionHarness();
    const controller = { current: { conversationId: "conv-r4-live", mode: { kind: "normal" as const } } };
    const cmd = new TerminalModelCommand({
      controller: () => controller,
      conversation: {
        getModelSelection: async () => ({ modelSelection: selection }),
        setModelSelection: async () => ({ modelSelection: selection }),
      },
      readConfiguration: async () => ({ config, credentials: creds }),
      saveModelConfiguration: async (mutate) => {
        config = mutate(config);
        return { kind: "local-applied" };
      },
      readCatalog: async () => createModelCatalogPortFromBundle(activeCatalogBundle),
      isHostConnected: () => true,
      refreshCatalog,
      choose: harness.choose,
      publishNotice: async () => {},
      onChanged,
      signal: new AbortController().signal,
    });

    const runPromise = cmd.run("flash");

    // 1. 列表首帧：确认初始筛选 "flash"，触发刷新模型目录
    await harness.waitForFrame(() => harness.current?.page.title === "模型管理（/model）");
    expect(harness.current!.page.message).toContain("搜索筛选：“flash”");
    harness.respond({ itemId: "option:action:refresh-catalog" });

    // 2. 等待页：立即按 Esc 返回列表
    await harness.waitForFrame(() => harness.current?.page.busy === true);
    harness.respond({ itemId: "cancelled", cancelCause: "escape" });

    // 3. 返回列表：处于后台进行中，记录当前 requestId，并模拟用户将焦点移到 deepseek-v4-flash 后不再操作
    await harness.waitForFrame(
      () =>
        harness.current?.page.title === "模型管理（/model）" &&
        (harness.current.page.message?.includes("后台进行中") ?? false),
    );
    const listRequestId = harness.current!.requestId;
    expect(
      harness.current!.page.choices?.some(
        (c) => c.id === "option:action:refresh-progress" && c.label === "查看目录刷新进度",
      ),
    ).toBe(true);
    const flashChoice = harness.current!.page.choices!.find((c) => c.label.includes("deepseek-v4-flash"));
    expect(flashChoice).toBeDefined();
    const flashId = flashChoice!.id;
    harness.moveFocus(flashId);
    expect(harness.current!.focusedId).toBe(flashId);

    // 4. 后台宿主刷新完成并落盘新目录（含修订 ui-review-catalog-1 与新模型 deepseek-v4-flash-turbo）
    const baseDeepseekEntry = BUILTIN_CURATED_CATALOG.models.find((m) => m.presetId === "deepseek")!;
    activeCatalogBundle = {
      ...BUILTIN_CURATED_CATALOG,
      catalogRevision: "ui-review-catalog-1",
      models: [
        ...BUILTIN_CURATED_CATALOG.models,
        {
          ...baseDeepseekEntry,
          id: "deepseek-v4-flash-turbo",
          name: "DeepSeek V4 Flash Turbo",
          contextWindow: 128_000,
          maxOutputTokens: 16_384,
          supportsImages: false,
          supportsTools: true,
          supportsThinking: false,
        },
      ],
    };
    resolveRefresh({
      status: "updated",
      changed: true,
      activeRevision: "ui-review-catalog-1",
    });

    // 5. 用户完全未按键，当前列表页原地收到 live-update 收口！
    await harness.waitForFrame(
      () =>
        harness.frames.some(
          (f) => f.kind === "live-update" && f.page.message?.includes("ui-review-catalog-1"),
        ),
    );
    expect(harness.current!.requestId).toBe(listRequestId); // 未关页重开！
    expect(harness.current!.focusedId).toBe(flashId); // 用户移动的实时焦点丝毫未丢！
    expect(harness.current!.page.message).toContain("搜索筛选：“flash”");
    expect(harness.current!.page.message).toContain("✓ 目录已更新至修订 ui-review-catalog-1");
    expect(harness.current!.page.message).not.toContain("后台进行中");
    expect(harness.current!.page.choices?.some((c) => c.id === "option:action:refresh-progress")).toBe(false);
    const refreshOpt = harness.current!.page.choices?.find((c) => c.id === "option:action:refresh-catalog");
    expect(refreshOpt?.label).toBe("刷新模型目录");
    expect(refreshOpt?.detail).toContain("ui-review-catalog-1");
    const newModelOpt = harness.current!.page.choices?.find(
      (c) => c.label.includes("deepseek-v4-flash-turbo"),
    );
    expect(newModelOpt).toBeDefined();

    // 6. 直接点选原地刷新出来的新模型，能正常进入动作页（证明 currentRequest 与 view 均已原子同步）
    harness.respond({ itemId: newModelOpt!.id });
    await harness.waitForFrame(() => harness.current?.page.title.includes("deepseek-v4-flash-turbo") ?? false);
    harness.respond({ itemId: "cancelled", cancelCause: "escape" });

    // 7. 回到列表后退出，验证全流程只发起过 1 次刷新
    await harness.waitForFrame(() => harness.current?.page.title === "模型管理（/model）");
    harness.respond({ itemId: "option:action:close" });
    await runPromise;

    expect(refreshCatalog).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "up-to-date（无需更新）",
      settle: (resolve: (r: any) => void) =>
        resolve({ status: "up-to-date", changed: false, activeRevision: "2026.11.20-same" }),
      expectedText: "✓ 模型目录已是最新（修订 2026.11.20-same）",
    },
    {
      name: "error（网络或验签失败）",
      settle: (_resolve: (r: any) => void, reject: (e: Error) => void) =>
        reject(new Error("timestamp 签名校验失败")),
      expectedText: "⚠ 目录刷新失败（已保留当前目录）：timestamp 签名校验失败",
    },
  ])("F4-R4b（$name）：后台刷新结束时原地收口状态并恢复“刷新模型目录”动作", async ({ settle, expectedText }) => {
    let config = sampleV2Config();
    const creds = sampleV2Credentials();
    const selection: SessionModelSelection = { mode: "follow-default" };
    let resolveRefresh!: (r: any) => void;
    let rejectRefresh!: (e: Error) => void;
    const refreshCatalog = vi.fn(
      () =>
        new Promise<any>((resolve, reject) => {
          resolveRefresh = resolve;
          rejectRefresh = reject;
        }),
    );

    const harness = createLiveSelectionHarness();
    const controller = { current: { conversationId: "conv-r4-outcomes", mode: { kind: "normal" as const } } };
    const cmd = new TerminalModelCommand({
      controller: () => controller,
      conversation: {
        getModelSelection: async () => ({ modelSelection: selection }),
        setModelSelection: async () => ({ modelSelection: selection }),
      },
      readConfiguration: async () => ({ config, credentials: creds }),
      saveModelConfiguration: async (mutate) => {
        config = mutate(config);
        return { kind: "local-applied" };
      },
      readCatalog: async () => createModelCatalogPortFromBundle(BUILTIN_CURATED_CATALOG),
      isHostConnected: () => true,
      refreshCatalog,
      choose: harness.choose,
      publishNotice: async () => {},
      onChanged: async () => {},
      signal: new AbortController().signal,
    });

    const runPromise = cmd.run("deepseek");
    await harness.waitForFrame(() => harness.current?.page.title === "模型管理（/model）");
    harness.respond({ itemId: "option:action:refresh-catalog" });
    await harness.waitForFrame(() => harness.current?.page.busy === true);
    harness.respond({ itemId: "cancelled", cancelCause: "escape" });
    await harness.waitForFrame(
      () => harness.current?.page.choices?.some((c) => c.id === "option:action:refresh-progress") ?? false,
    );
    const listReqId = harness.current!.requestId;
    // 光标停留在“查看目录刷新进度”上，收口后应平稳落在同行的“刷新模型目录”而非跳走
    harness.moveFocus("option:action:refresh-progress");

    settle(resolveRefresh, rejectRefresh);

    await harness.waitForFrame(
      () => harness.frames.some((f) => f.kind === "live-update" && f.page.message?.includes(expectedText)),
    );
    expect(harness.current!.requestId).toBe(listReqId);
    expect(harness.current!.page.message).toContain(expectedText);
    expect(harness.current!.page.message).toContain("搜索筛选：“deepseek”");
    expect(harness.current!.page.message).not.toContain("后台进行中");
    expect(harness.current!.page.choices?.some((c) => c.id === "option:action:refresh-progress")).toBe(false);
    expect(harness.current!.page.choices?.some((c) => c.id === "option:action:refresh-catalog")).toBe(true);
    expect(harness.current!.focusedId).toBe("option:action:refresh-catalog");

    harness.respond({ itemId: "option:action:close" });
    await runPromise;
    expect(refreshCatalog).toHaveBeenCalledTimes(1);
  });

  it("F4-R4c（防重发兜底）：即使在非实时选择器下后台已完成后点击遗留“查看目录刷新进度”，也绝不暗中再次发起刷新", async () => {
    let config = sampleV2Config();
    const creds = sampleV2Credentials();
    const selection: SessionModelSelection = { mode: "follow-default" };
    let resolveRefresh!: (r: any) => void;
    const refreshCatalog = vi.fn(
      () =>
        new Promise<any>((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    let step = 0;
    const choose: TerminalSelectionPort = async (page) => {
      step++;
      if (step === 1) return { itemId: "option:action:refresh-catalog" };
      if (step === 2) return { itemId: "cancelled", cancelCause: "escape" };
      if (step === 3) {
        // 模拟在用户点击“查看目录刷新进度”之前后台第一轮刷新早已完成
        resolveRefresh({ status: "updated", changed: true, activeRevision: "ui-review-catalog-1" });
        await new Promise((r) => setTimeout(r, 10));
        expect(page.choices?.some((c) => c.id === "option:action:refresh-progress")).toBe(true);
        return { itemId: "option:action:refresh-progress" };
      }
      // 第 4 步必须直接展示已完成结果并切回“刷新模型目录”，绝未重发第二次刷新
      expect(page.message).toContain("✓ 目录已更新至修订 ui-review-catalog-1");
      expect(page.choices?.some((c) => c.id === "option:action:refresh-catalog")).toBe(true);
      expect(page.choices?.some((c) => c.id === "option:action:refresh-progress")).toBe(false);
      return { itemId: "option:action:close" };
    };

    const controller = { current: { conversationId: "conv-r4-noretrigger", mode: { kind: "normal" as const } } };
    const cmd = new TerminalModelCommand({
      controller: () => controller,
      conversation: {
        getModelSelection: async () => ({ modelSelection: selection }),
        setModelSelection: async () => ({ modelSelection: selection }),
      },
      readConfiguration: async () => ({ config, credentials: creds }),
      saveModelConfiguration: async (mutate) => {
        config = mutate(config);
        return { kind: "local-applied" };
      },
      readCatalog: async () => createModelCatalogPortFromBundle(BUILTIN_CURATED_CATALOG),
      isHostConnected: () => true,
      refreshCatalog,
      choose,
      publishNotice: async () => {},
      onChanged: async () => {},
      signal: new AbortController().signal,
    });

    await cmd.run();
    expect(refreshCatalog).toHaveBeenCalledTimes(1);
  });
});
