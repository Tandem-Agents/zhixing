/**
 * L2 / L4b 列表面板：通用"选一项"交互。
 *
 * 两种 list 共用同一渲染 + 导航逻辑，items 由 descriptor.kind 决定来源：
 *   - provider-list：SUPPORTED_PROVIDERS（model role 选服务商）
 *   - model-list：preset.knownModels[].id + credentials.providers.<id>.models + [+ 添加自定义]
 *
 * 导航：↑↓ 选 / Enter 进入 / Esc pop / Ctrl+C 退出
 */

import { getPreset, ROLE_RECOMMENDATIONS } from "@zhixing/providers";
import type { ThinkingConfig, ThinkingControl } from "@zhixing/core";
import type {
  KeyEvent,
  PanelAction,
  PanelDescriptor,
  WorkingState,
} from "../types.js";
import { Renderer } from "../ui/render.js";
import {
  readModelRole,
  readModelThinking,
  readProviderEntry,
  writeModelRole,
  writeModelThinking,
} from "../state.js";
import { SUPPORTED_PROVIDERS } from "../../registries/index.js";
import {
  renderChrome,
  renderListRow,
  renderFooter,
} from "../../tui/index.js";

const FOOTER_HINTS = [
  "↑↓ 选择",
  "Enter 进入",
  "Esc 返回",
  "Ctrl+C 退出",
] as const;

interface ListItem {
  label: string;
  /**
   * 右侧辅助描述——纯展示文本（如 provider description / "预设默认"），
   * dim 渲染。**不是业务状态**——list 项无 ready/pending/disabled 概念。
   * 与 entity panel 的 row.status 区分：那是带 level 的业务状态。
   */
  description?: string;
  /** 是否是用户当前已选项（model-list 等场景用）——渲染时左侧加绿色 ● 标记 */
  current?: boolean;
  /** Enter 时执行的动作 */
  onEnter: (state: WorkingState) => PanelAction;
}

interface ListPanelMeta {
  title: string;
  /** 列表整体说明——chrome body 单行，给用户当前选择场景的上下文 */
  description: string;
  /** 列表是否有 current 概念——影响 marker 槽位是否保留 */
  hasCurrentConcept: boolean;
  items: ListItem[];
}

// ─── 三种 list 的 items 构造 ───

function buildProviderListMeta(
  _state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "provider-list" }>,
): ListPanelMeta {
  const roleLabel = descriptor.role === "main" ? "主模型" : "辅助模型";
  return {
    title: `${roleLabel} · 选择服务商`,
    description: `选择 API 服务商作为${roleLabel}来源`,
    hasCurrentConcept: false,
    items: SUPPORTED_PROVIDERS.map((p) => ({
      label: p.label,
      description: p.description,
      onEnter: (s) => ({
        type: "navigate",
        state: s,
        panel: { kind: "provider-config", role: descriptor.role, providerId: p.id },
      }),
    })),
  };
}

function buildModelListMeta(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "model-list" }>,
): ListPanelMeta {
  const provider = SUPPORTED_PROVIDERS.find((p) => p.id === descriptor.providerId);
  const preset = getPreset(descriptor.providerId);
  const userModels = readProviderEntry(state, descriptor.providerId)?.models ?? [];

  // 可选项 = preset 登记过元信息的 model（knownModels）+ 用户自定义；去重保序。
  // 物理层不再自荐 model，这里不放任何"provider 默认"。
  const seen = new Set<string>();
  const allModels: string[] = [];
  for (const m of preset?.knownModels ?? []) {
    if (!seen.has(m.id)) {
      allModels.push(m.id);
      seen.add(m.id);
    }
  }
  for (const m of userModels) {
    if (!seen.has(m)) {
      allModels.push(m);
      seen.add(m);
    }
  }

  // 档位推荐：仅当本档位有推荐、且推荐 provider 正是当前浏览的 provider 时，
  // 推荐的那个 model 标 "<档位> 推荐"。其余 model 一律平等无标签——"推荐"是
  // 档位维度的价值判断，不是 provider 内置默认。
  const roleRec = ROLE_RECOMMENDATIONS[descriptor.role];
  const recommendedModel =
    roleRec?.provider === descriptor.providerId ? roleRec.model : undefined;

  const currentRole = readModelRole(state, descriptor.role);
  // 仅当 currentRole 与本 panel 的 provider 匹配时，currentRole.model 才是"用户对本
  // provider 主动选过的模型"——否则（未配 / 选了别的 provider）不算 current
  const userSelectedModel =
    currentRole?.provider === descriptor.providerId
      ? currentRole?.model
      : undefined;
  const items: ListItem[] = allModels.map((modelId) => {
    const description =
      modelId === recommendedModel ? `${descriptor.role} 推荐` : undefined;
    return {
      label: modelId,
      description,
      current: modelId === userSelectedModel,
      onEnter: (s) => {
        const providerId = currentRole?.provider ?? descriptor.providerId;
        const next = writeModelRole(s, descriptor.role, providerId, modelId);
        // model 选定后：有可配思考形态 → 进入思考控制步骤；none/无元数据 →
        // 直接返回（writeModelRole 已丢弃旧 model 的残留 thinking）。
        const control = resolveThinkingControl(descriptor.providerId, modelId);
        if (control && control.type !== "none") {
          return {
            type: "navigate",
            state: next,
            panel: {
              kind: "thinking-config",
              role: descriptor.role,
              providerId: descriptor.providerId,
              model: modelId,
            },
          };
        }
        return { type: "pop", state: next };
      },
    };
  });

  // 末尾追加 "+ 添加自定义模型"
  items.push({
    label: "+ 添加自定义模型",
    onEnter: (s) => ({
      type: "navigate",
      state: s,
      panel: {
        kind: "add-model",
        role: descriptor.role,
        providerId: descriptor.providerId,
      },
    }),
  });

  return {
    title: `${provider?.label ?? descriptor.providerId} · 选择模型`,
    description: "选择具体使用的 model id；带 ● 的是当前已选",
    hasCurrentConcept: true,
    items,
  };
}

/**
 * 解析某 model 的思考控制元数据 —— 唯一来源是 preset per-model 声明
 * （knownModels[*].thinkingControl）。自定义 / 未声明 model 无元数据 →
 * undefined，调用方按 none 处理（不暴露思考配置步骤，与规格一致）。
 */
function resolveThinkingControl(
  providerId: string,
  modelId: string,
): ThinkingControl | undefined {
  return getPreset(providerId)?.knownModels?.find((m) => m.id === modelId)
    ?.thinkingControl;
}

/** 两个 ThinkingConfig 是否等价（用于列表 ● 当前项标记） */
function sameThinking(
  a: ThinkingConfig | undefined,
  b: ThinkingConfig,
): boolean {
  if (!a || a.mode !== b.mode) return false;
  if (a.mode === "effort" && b.mode === "effort") return a.effort === b.effort;
  if (a.mode === "budget" && b.mode === "budget") return a.budget === b.budget;
  return true;
}

function buildThinkingConfigMeta(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "thinking-config" }>,
): ListPanelMeta {
  const control = resolveThinkingControl(descriptor.providerId, descriptor.model);
  const current = readModelThinking(state, descriptor.role);

  // 选定一个固定形态 → 写入并返回 model-list（pop）
  const pick = (thinking: ThinkingConfig) => (s: WorkingState): PanelAction => ({
    type: "pop",
    state: writeModelThinking(s, descriptor.role, thinking),
  });

  const items: ListItem[] = [
    {
      label: "关闭思考",
      description: "不发送思考参数中的开启项（off）",
      current: sameThinking(current, { mode: "off" }),
      onEnter: pick({ mode: "off" }),
    },
  ];

  let description = "选择该模型的思考控制；带 ● 的是当前已选";

  if (control?.type === "toggle") {
    items.push({
      label: "开启思考",
      description: "开启模型思考（on）",
      current: sameThinking(current, { mode: "on" }),
      onEnter: pick({ mode: "on" }),
    });
  } else if (control?.type === "effort") {
    items.push({
      label: "开启（服务端默认强度）",
      current: sameThinking(current, { mode: "on" }),
      onEnter: pick({ mode: "on" }),
    });
    for (const effort of control.efforts) {
      items.push({
        label: `强度 ${effort}`,
        description: effort === control.default ? "官方默认档" : undefined,
        current: sameThinking(current, { mode: "effort", effort }),
        onEnter: pick({ mode: "effort", effort }),
      });
    }
  } else if (control?.type === "budget") {
    if (control.range) {
      description = `选择该模型的思考控制；自定义预算需在 ${control.range[0]}–${control.range[1]} token 内`;
    }
    items.push({
      label: "开启（服务端默认预算）",
      current: sameThinking(current, { mode: "on" }),
      onEnter: pick({ mode: "on" }),
    });
    items.push({
      label: "自定义预算…",
      description: "输入思考 token 预算",
      current: current?.mode === "budget",
      onEnter: (s) => ({
        type: "navigate",
        state: s,
        panel: {
          kind: "thinking-budget",
          role: descriptor.role,
          providerId: descriptor.providerId,
          model: descriptor.model,
        },
      }),
    });
  }

  return {
    title: `${descriptor.model} · 思考控制`,
    description,
    hasCurrentConcept: true,
    items,
  };
}

function resolveListMeta(
  state: WorkingState,
  descriptor: PanelDescriptor,
): ListPanelMeta | null {
  switch (descriptor.kind) {
    case "provider-list":
      return buildProviderListMeta(state, descriptor);
    case "model-list":
      return buildModelListMeta(state, descriptor);
    case "thinking-config":
      return buildThinkingConfigMeta(state, descriptor);
    default:
      return null;
  }
}

// ─── 渲染 + 处理 ───

export function renderListPanel(
  state: WorkingState,
  descriptor: PanelDescriptor,
  cursor: { index: number },
  renderer: Renderer,
): void {
  const meta = resolveListMeta(state, descriptor);
  if (!meta) return;

  renderer.clear();
  renderer.hideCursor();

  const width = renderer.terminalWidth();

  renderer.writeLines(
    renderChrome({
      title: meta.title,
      body: [meta.description],
      width,
    }),
  );
  renderer.writeLine("");

  // 列表项紧贴排列——chrome 自带顶/底 padding 已提供呼吸；
  // current 概念由整个 list 决定（model-list 有、provider-list 没有），
  // 让所有行共享 marker 槽位以保证 label 起始列对齐
  for (let i = 0; i < meta.items.length; i++) {
    const item = meta.items[i]!;
    const selected = i === cursor.index;
    renderer.writeLines(
      renderListRow({
        label: item.label,
        description: item.description,
        current: meta.hasCurrentConcept ? Boolean(item.current) : undefined,
        selected,
        width,
      }),
    );
  }

  renderer.writeLine("");
  renderer.writeLines(
    renderFooter({ width, hints: FOOTER_HINTS }),
  );
}

export interface ListPanelKeyResult {
  action: PanelAction;
  cursor: { index: number };
}

export function handleListPanelKey(
  state: WorkingState,
  descriptor: PanelDescriptor,
  cursor: { index: number },
  key: KeyEvent,
): ListPanelKeyResult {
  const meta = resolveListMeta(state, descriptor);
  if (!meta) {
    return { action: { type: "pop", state }, cursor };
  }
  const max = meta.items.length - 1;

  switch (key.type) {
    case "arrow-up":
      return {
        action: { type: "stay", state },
        cursor: { index: cursor.index > 0 ? cursor.index - 1 : max },
      };
    case "arrow-down":
      return {
        action: { type: "stay", state },
        cursor: { index: cursor.index < max ? cursor.index + 1 : 0 },
      };
    case "ctrl-c":
      return { action: { type: "exit", result: { kind: "cancelled" } }, cursor };
    case "escape":
      return { action: { type: "pop", state }, cursor };
    case "enter": {
      const item = meta.items[cursor.index];
      if (!item) return { action: { type: "stay", state }, cursor };
      return { action: item.onEnter(state), cursor };
    }
    default:
      return { action: { type: "stay", state }, cursor };
  }
}
