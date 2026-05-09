/**
 * L2 / L4b 列表面板：通用"选一项"交互。
 *
 * 两种 list 共用同一渲染 + 导航逻辑，items 由 descriptor.kind 决定来源：
 *   - provider-list：SUPPORTED_PROVIDERS（model role 选服务商）
 *   - model-list：preset.defaultModel + preset.knownModels[].id + credentials.providers.<id>.models + [+ 添加自定义]
 *
 * 导航：↑↓ 选 / Enter 进入 / Esc pop / Ctrl+C 退出
 */

import { getPreset } from "@zhixing/providers";
import type {
  KeyEvent,
  PanelAction,
  PanelDescriptor,
  WorkingState,
} from "../types.js";
import { Renderer } from "../ui/render.js";
import {
  readModelRole,
  readProviderEntry,
  writeModelRole,
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

  // 合并：preset 默认 + preset.knownModels + 用户自定义；去重保序
  // 顺序：defaultModel 居首（标"预设默认"）→ 其它 preset.knownModels（标"推荐"）→ 用户自定义
  const seen = new Set<string>();
  const knownIds = new Set<string>();
  const allModels: string[] = [];
  if (preset?.defaultModel) {
    allModels.push(preset.defaultModel);
    seen.add(preset.defaultModel);
    knownIds.add(preset.defaultModel);
  }
  for (const m of preset?.knownModels ?? []) {
    knownIds.add(m.id);
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

  const currentRole = readModelRole(state, descriptor.role);
  // 仅当 currentRole 与本 panel 的 provider 匹配时，currentRole.model 才是"用户对本
  // provider 主动选过的模型"——否则（未配 / 选了别的 provider）不算 current
  const userSelectedModel =
    currentRole?.provider === descriptor.providerId
      ? currentRole?.model
      : undefined;
  const items: ListItem[] = allModels.map((modelId) => {
    let description: string | undefined;
    if (modelId === preset?.defaultModel) description = "预设默认";
    else if (knownIds.has(modelId)) description = "预设可选";
    return {
      label: modelId,
      description,
      current: modelId === userSelectedModel,
      onEnter: (s) => {
        const next = writeModelRole(
          s,
          descriptor.role,
          currentRole?.provider ?? descriptor.providerId,
          modelId,
        );
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

function resolveListMeta(
  state: WorkingState,
  descriptor: PanelDescriptor,
): ListPanelMeta | null {
  switch (descriptor.kind) {
    case "provider-list":
      return buildProviderListMeta(state, descriptor);
    case "model-list":
      return buildModelListMeta(state, descriptor);
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
