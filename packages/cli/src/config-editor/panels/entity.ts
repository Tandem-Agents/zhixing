/**
 * L3 实体配置面板：
 *   - provider-config：服务商配置（API Key 字段 + 模型选择 + 确认/返回按钮）
 *   - channel-config：channel 配置（appId / appSecret 等字段 + 启用/取消启用按钮）
 *
 * 布局共性：
 *   - 顶部：标题
 *   - 中部：字段列表（每行 label + 已填状态）
 *   - 底部：操作按钮
 *   - ↑↓ 在字段 + 按钮间移动；Enter 进入字段编辑或触发按钮
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
  disableMessaging,
  enableMessaging,
  isMessagingEnabled,
  readChannelEntry,
  readModelRole,
  readProviderEntry,
  writeModelRole,
} from "../state.js";
import { SUPPORTED_PROVIDERS } from "../providers-registry.js";
import { SUPPORTED_CHANNELS } from "../channels-registry.js";
import { maskForDisplay } from "../ui/mask.js";

interface EntityRow {
  label: string;
  status: string;
  onEnter: (state: WorkingState) => PanelAction;
}

interface EntityButton {
  label: string;
  onEnter: (state: WorkingState) => PanelAction;
}

interface EntityMeta {
  title: string;
  rows: EntityRow[];
  buttons: EntityButton[];
}

// ─── provider-config 实体 ───

function buildProviderConfigMeta(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "provider-config" }>,
): EntityMeta {
  const provider = SUPPORTED_PROVIDERS.find((p) => p.id === descriptor.providerId);
  const providerLabel = provider?.label ?? descriptor.providerId;
  const roleLabel = descriptor.role === "main" ? "主模型" : "辅助模型";

  const apiKey = readProviderEntry(state, descriptor.providerId)?.apiKey;
  const apiKeyStatus = apiKey ? `已填 ${maskForDisplay(apiKey)}` : "未填";

  const currentRole = readModelRole(state, descriptor.role);
  const preset = getPreset(descriptor.providerId);
  const currentModel =
    currentRole?.provider === descriptor.providerId
      ? currentRole?.model
      : preset?.defaultModel;
  const modelStatus = currentModel ?? "（未选）";

  const rows: EntityRow[] = [
    {
      label: "API Key",
      status: apiKeyStatus,
      onEnter: (s) => ({
        type: "navigate",
        state: s,
        panel: {
          kind: "input",
          fieldId: `provider-apikey:${descriptor.role}:${descriptor.providerId}`,
        },
      }),
    },
    {
      label: "使用模型",
      status: modelStatus,
      onEnter: (s) => ({
        type: "navigate",
        state: s,
        panel: {
          kind: "model-list",
          role: descriptor.role,
          providerId: descriptor.providerId,
        },
      }),
    },
  ];

  const buttons: EntityButton[] = [
    {
      label: "确认使用此服务商",
      onEnter: (s) => {
        // 校验：apiKey 已填 + model 已选
        const key = readProviderEntry(s, descriptor.providerId)?.apiKey;
        const role = readModelRole(s, descriptor.role);
        const model =
          role?.provider === descriptor.providerId
            ? role?.model
            : preset?.defaultModel;
        if (!key || !model) {
          // 无效——保持当前面板（caller 可显示错误，但 PanelAction 没有 error 通道）
          return { type: "stay", state: s };
        }
        // 把当前选定 provider/model 写入 llm.<role>
        const next = writeModelRole(
          s,
          descriptor.role,
          descriptor.providerId,
          model,
        );
        return { type: "pop", state: next };
      },
    },
  ];

  return {
    title: `${roleLabel} · ${providerLabel}`,
    rows,
    buttons,
  };
}

// ─── channel-config 实体 ───

function buildChannelConfigMeta(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "channel-config" }>,
): EntityMeta {
  const channel = SUPPORTED_CHANNELS.find((c) => c.id === descriptor.channelId);
  const channelLabel = channel?.label ?? descriptor.channelId;
  const channelCreds = readChannelEntry(state, descriptor.channelId) ?? {};
  const enabled = isMessagingEnabled(state, descriptor.channelId);

  const rows: EntityRow[] =
    channel?.requiredFields.map((field) => {
      const value = channelCreds[field.id];
      let status: string;
      if (!value) {
        status = "未填";
      } else if (field.sensitive) {
        status = `已填 ${maskForDisplay(value)}`;
      } else {
        status = `已填 ${value}`;
      }
      return {
        label: field.label,
        status,
        onEnter: (s) => ({
          type: "navigate",
          state: s,
          panel: {
            kind: "input",
            fieldId: `channel-field:${descriptor.channelId}:${field.id}`,
          },
        }),
      };
    }) ?? [];

  const buttons: EntityButton[] = [
    {
      label: enabled ? "取消启用此通道" : "启用此通道",
      onEnter: (s) => {
        if (enabled) {
          const next = disableMessaging(s, descriptor.channelId);
          return { type: "pop", state: next };
        }
        // 启用：校验必填字段非空
        const allFilled = (channel?.requiredFields ?? []).every(
          (f) => channelCreds[f.id],
        );
        if (!allFilled) {
          return { type: "stay", state: s };
        }
        const next = enableMessaging(s, descriptor.channelId);
        return { type: "pop", state: next };
      },
    },
  ];

  return {
    title: `消息通道 · ${channelLabel}`,
    rows,
    buttons,
  };
}

function resolveEntityMeta(
  state: WorkingState,
  descriptor: PanelDescriptor,
): EntityMeta | null {
  switch (descriptor.kind) {
    case "provider-config":
      return buildProviderConfigMeta(state, descriptor);
    case "channel-config":
      return buildChannelConfigMeta(state, descriptor);
    default:
      return null;
  }
}

// ─── 渲染 + 处理 ───

export function renderEntityPanel(
  state: WorkingState,
  descriptor: PanelDescriptor,
  cursor: { index: number },
  renderer: Renderer,
): void {
  const meta = resolveEntityMeta(state, descriptor);
  if (!meta) return;

  renderer.clear();
  renderer.hideCursor();

  renderer.separator();
  renderer.writeLine(`  ${renderer.bold(meta.title)}`);
  renderer.separator();
  renderer.writeLine("");

  let index = 0;
  for (const row of meta.rows) {
    const selected = index === cursor.index;
    renderer.writeLine(renderer.listItem(selected, row.label, row.status));
    index++;
  }
  renderer.writeLine("");
  for (const btn of meta.buttons) {
    const selected = index === cursor.index;
    renderer.writeLine(renderer.listItem(selected, `[ ${btn.label} ]`));
    index++;
  }
  renderer.writeLine("");
  renderer.writeLine(renderer.dim("  ↑↓ 选择    Enter 进入/确认    Esc 返回    Ctrl+C 退出"));
}

export interface EntityPanelKeyResult {
  action: PanelAction;
  cursor: { index: number };
}

export function handleEntityPanelKey(
  state: WorkingState,
  descriptor: PanelDescriptor,
  cursor: { index: number },
  key: KeyEvent,
): EntityPanelKeyResult {
  const meta = resolveEntityMeta(state, descriptor);
  if (!meta) return { action: { type: "pop", state }, cursor };

  const total = meta.rows.length + meta.buttons.length;
  const max = total - 1;

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
      const idx = cursor.index;
      if (idx < meta.rows.length) {
        return { action: meta.rows[idx]!.onEnter(state), cursor };
      }
      const btnIdx = idx - meta.rows.length;
      const btn = meta.buttons[btnIdx];
      if (!btn) return { action: { type: "stay", state }, cursor };
      return { action: btn.onEnter(state), cursor };
    }
    default:
      return { action: { type: "stay", state }, cursor };
  }
}
