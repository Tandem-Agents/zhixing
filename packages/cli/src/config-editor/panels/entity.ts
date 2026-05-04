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
import { tone, layout, icon } from "../../tui/style.js";
import { renderChrome } from "../../tui/chrome.js";
import { renderEntryRow } from "../../tui/section.js";
import { renderButton } from "../../tui/button.js";
import { renderFooter } from "../../tui/footer.js";

const CONTENT_INDENT = " ".repeat(layout.contentIndent);
const FOOTER_HINTS = [
  "↑↓ 选择",
  "Enter 进入/确认",
  "Esc 返回",
  "Ctrl+C 退出",
] as const;
const BUTTON_HINT_GAP = "   ";

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
  /** 按钮右侧的 dim 说明文本（不含括号——渲染时自动加） */
  hint?: string;
  /** 主按钮：success 色边框 + label，视觉作为"建议动作"突出 */
  primary?: boolean;
  onEnter: (state: WorkingState) => OnEnterResult;
}

interface EntityMeta {
  title: string;
  /** chrome body 内的简短描述——给用户当前实体的上下文 */
  description: string;
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
  // 区分"用户主动选过"与"系统兜底默认"：currentRole.provider 与本 panel 一致 = 主动选；
  // 否则 fallback 到 preset.defaultModel = 兜底（视觉应弱化，避免误以为"已选"）
  const userSelectedModel =
    currentRole?.provider === descriptor.providerId
      ? currentRole?.model
      : undefined;
  const fallbackModel = preset?.defaultModel;
  const displayModel = userSelectedModel ?? fallbackModel;

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
      status: !displayModel
        ? { level: "pending", text: "待选" }
        : userSelectedModel
          ? { level: "ready", text: userSelectedModel }
          : { level: "disabled", text: `(默认) ${fallbackModel}` },
      onEnter: (s) =>
        nav(s, {
          kind: "model-list",
          role: descriptor.role,
          providerId: descriptor.providerId,
        }),
    },
  ];

  // Preview 校验：虚拟写入候选 provider/model 后跑 checkModel，决定按钮的 primary
  // 与 hint。复用单一规则源（vs 旧版 inline 校验与 checks 双源漂移）。
  // 渲染态与点击态共用同一 state → 视觉提示与点击响应永远一致，不会"看着可以但点了不行"。
  const previewModel =
    userSelectedModel ?? fallbackModel ?? "";
  const previewState = writeModelRole(
    state,
    descriptor.role,
    descriptor.providerId,
    previewModel,
  );
  const myIssues = checkModel(
    previewState.config,
    previewState.credentials,
  ).filter((i) => i.role === descriptor.role);
  const canProceed = myIssues.length === 0;

  const buttons: EntityButton[] = [
    {
      label: "完成",
      hint: canProceed ? "保存此服务商配置" : "请先补全必填项",
      primary: canProceed,
      onEnter: (s) => {
        // 点击态再算一次 preview——defensive：跳到 input 编辑后回来 state 已变
        const currentRole = readModelRole(s, descriptor.role);
        const model =
          currentRole?.provider === descriptor.providerId
            ? currentRole?.model
            : preset?.defaultModel;
        const next = writeModelRole(
          s,
          descriptor.role,
          descriptor.providerId,
          model ?? "",
        );
        const issues = checkModel(next.config, next.credentials).filter(
          (i) => i.role === descriptor.role,
        );
        if (issues.length > 0) {
          // 短消息：用 fieldLabel（"API Key" / "模型"）；entity panel 已在
          // 标题携带服务商上下文，无需重复 "主模型 - X" 前缀。
          return stay(
            s,
            `请先填${issues.map((i) => i.fieldLabel).join(" 和 ")}`,
          );
        }
        return pop(next);
      },
    },
  ];

  return {
    title: `${roleLabel} · ${providerLabel}`,
    description: `配置 ${providerLabel} 的 API Key 与使用的模型`,
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

  // Preview 校验：未启用态——虚拟启用后跑 checkMessaging，决定 primary 与 hint
  // 已启用态：禁用是破坏性动作，永不 primary
  let canEnable = false;
  if (!enabled) {
    const previewState = enableMessaging(state, descriptor.channelId);
    const myIssues = checkMessaging(
      previewState.config,
      previewState.credentials,
    ).filter((i) => i.channelId === descriptor.channelId);
    canEnable = myIssues.length === 0;
  }

  const buttons: EntityButton[] = [
    {
      label: enabled ? "禁用" : "启用",
      hint: enabled
        ? "停止接收外部消息"
        : canEnable
          ? "开始接收外部消息"
          : "请先补全必填项",
      // 启用按钮：仅凭证齐全时 primary（建议动作）；禁用按钮：始终非 primary（破坏性）
      primary: !enabled && canEnable,
      onEnter: (s) => {
        if (enabled) {
          return pop(disableMessaging(s, descriptor.channelId));
        }
        // 点击态再算一次 preview——defensive
        const next = enableMessaging(s, descriptor.channelId);
        const issues = checkMessaging(next.config, next.credentials).filter(
          (i) => i.channelId === descriptor.channelId,
        );
        if (issues.length > 0) {
          return stay(
            s,
            `请先填${issues.map((i) => i.fieldLabel).join(" 和 ")}`,
          );
        }
        return pop(next);
      },
    },
  ];

  return {
    title: `消息通道 · ${channelLabel}`,
    description: `配置 ${channelLabel} 的连接凭证`,
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

  const width = renderer.terminalWidth();

  renderer.writeLines(
    renderChrome({
      title: meta.title,
      body: [meta.description],
      width,
    }),
  );
  renderer.writeLine("");

  let index = 0;
  for (const row of meta.rows) {
    const selected = index === cursor.index;
    renderer.writeLines(
      renderEntryRow({
        label: row.label,
        status: { kind: row.status.level, text: row.status.text },
        selected,
        width,
      }),
    );
    index++;
  }
  renderer.writeLine("");

  // 按钮：cursor 外置在 middle 行左侧，与 main 面板同款
  for (const btn of meta.buttons) {
    const selected = index === cursor.index;
    const lines = renderButton({
      label: btn.label,
      selected,
      primary: btn.primary,
    });
    if (btn.hint) {
      lines[1] = lines[1] + BUTTON_HINT_GAP + tone.dim(`(${btn.hint})`);
    }
    const cursorMark = selected ? tone.brand(icon.cursor) : " ";
    renderer.writeLine(CONTENT_INDENT + lines[0]!);
    renderer.writeLine(cursorMark + " " + lines[1]!);
    renderer.writeLine(CONTENT_INDENT + lines[2]!);
    index++;
  }

  renderer.writeLine("");
  if (errorMessage) {
    renderer.writeLine(tone.error("  " + errorMessage));
    renderer.writeLine("");
  }
  renderer.writeLines(renderFooter({ width, hints: FOOTER_HINTS }));
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
