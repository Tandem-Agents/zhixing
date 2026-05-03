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
 *
 * 行/按钮统一接口：两者 `onEnter` 都返回 `OnEnterResult`，由 nav/pop/stay 组合子构造。
 * 这层统一让"按钮校验失败"和未来"行进入前 precondition 失败"用同一机制，无需扩接口。
 */

import { getPreset } from "@zhixing/providers";
import type {
  KeyEvent,
  PanelAction,
  PanelDescriptor,
  Status,
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
import { checkModel } from "../checks/model.js";
import { checkMessaging } from "../checks/messaging.js";

/**
 * 行/按钮 onEnter 的统一返回类型。
 *
 * - action：派发给 runner 的状态机动作（stay / navigate / pop / exit）
 * - errorMessage：可选，校验失败时上抛，runner 写到 PanelFrame.errorMessage
 *   下次 render 时显示在面板底部红字区。
 */
export interface OnEnterResult {
  action: PanelAction;
  errorMessage?: string;
}

// ─── onEnter 组合子（避免每个 row/button 手写嵌套对象） ───

const nav = (state: WorkingState, panel: PanelDescriptor): OnEnterResult => ({
  action: { type: "navigate", state, panel },
});

const pop = (state: WorkingState): OnEnterResult => ({
  action: { type: "pop", state },
});

const stay = (state: WorkingState, errorMessage?: string): OnEnterResult => ({
  action: { type: "stay", state },
  errorMessage,
});

interface EntityRow {
  label: string;
  status: Status;
  onEnter: (state: WorkingState) => OnEnterResult;
}

interface EntityButton {
  label: string;
  onEnter: (state: WorkingState) => OnEnterResult;
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
  const currentRole = readModelRole(state, descriptor.role);
  const preset = getPreset(descriptor.providerId);
  const currentModel =
    currentRole?.provider === descriptor.providerId
      ? currentRole?.model
      : preset?.defaultModel;

  const rows: EntityRow[] = [
    {
      label: "API Key",
      status: apiKey
        ? { level: "ready", text: maskForDisplay(apiKey) }
        : { level: "pending", text: "待填" },
      onEnter: (s) =>
        nav(s, {
          kind: "input",
          fieldId: `provider-apikey:${descriptor.role}:${descriptor.providerId}`,
        }),
    },
    {
      label: "使用模型",
      status: currentModel
        ? { level: "ready", text: currentModel }
        : { level: "pending", text: "待选" },
      onEnter: (s) =>
        nav(s, {
          kind: "model-list",
          role: descriptor.role,
          providerId: descriptor.providerId,
        }),
    },
  ];

  const buttons: EntityButton[] = [
    {
      label: "完成此服务商配置",
      onEnter: (s) => {
        // Preview pattern：虚拟写入候选 provider/model 后跑 checkModel——
        // 复用单一规则源（vs 旧版 inline 校验与 checks 双源漂移）。
        // model 取 currentRole（同 provider）或 preset 兜底；为空时写空串触发
        // checkModel "模型缺失" issue。
        const currentRole = readModelRole(s, descriptor.role);
        const model =
          currentRole?.provider === descriptor.providerId
            ? currentRole?.model
            : preset?.defaultModel;
        const previewState = writeModelRole(
          s,
          descriptor.role,
          descriptor.providerId,
          model ?? "",
        );
        const myIssues = checkModel(
          previewState.config,
          previewState.credentials,
        ).filter((i) => i.role === descriptor.role);
        if (myIssues.length > 0) {
          // 短消息：用 fieldLabel（"API Key" / "模型"）；entity panel 已在
          // 标题携带服务商上下文，无需重复 "主模型 - X" 前缀。
          return stay(
            s,
            `请先填${myIssues.map((i) => i.fieldLabel).join(" 和 ")}`,
          );
        }
        return pop(previewState);
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
      const status: Status = !value
        ? { level: "pending", text: "待填" }
        : { level: "ready", text: field.sensitive ? maskForDisplay(value) : value };
      return {
        label: field.label,
        status,
        onEnter: (s) =>
          nav(s, {
            kind: "input",
            fieldId: `channel-field:${descriptor.channelId}:${field.id}`,
          }),
      };
    }) ?? [];

  const buttons: EntityButton[] = [
    {
      label: enabled ? "禁用此通道" : "启用此通道",
      onEnter: (s) => {
        if (enabled) {
          return pop(disableMessaging(s, descriptor.channelId));
        }
        // Preview pattern：虚拟启用后跑 checkMessaging——复用单一规则源。
        // 启用后凭证字段缺失会被 check 捕获，stay 旧 state 不真启用。
        const previewState = enableMessaging(s, descriptor.channelId);
        const myIssues = checkMessaging(
          previewState.config,
          previewState.credentials,
        ).filter((i) => i.channelId === descriptor.channelId);
        if (myIssues.length > 0) {
          return stay(
            s,
            `请先填${myIssues.map((i) => i.fieldLabel).join(" 和 ")}`,
          );
        }
        return pop(previewState);
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
  errorMessage?: string,
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
  if (errorMessage) {
    renderer.writeLine(renderer.red("  " + errorMessage));
    renderer.writeLine("");
  }
  renderer.writeLine(renderer.dim("  ↑↓ 选择    Enter 进入/确认    Esc 返回    Ctrl+C 退出"));
}

export interface EntityPanelKeyResult {
  action: PanelAction;
  cursor: { index: number };
  /** 校验失败时的错误信息——由 runner.ts 存到 PanelFrame 在下次 render 时显示 */
  errorMessage?: string;
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
      const elem =
        idx < meta.rows.length
          ? meta.rows[idx]!
          : meta.buttons[idx - meta.rows.length];
      if (!elem) return { action: { type: "stay", state }, cursor };
      const result = elem.onEnter(state);
      return {
        action: result.action,
        cursor,
        errorMessage: result.errorMessage,
      };
    }
    default:
      return { action: { type: "stay", state }, cursor };
  }
}
