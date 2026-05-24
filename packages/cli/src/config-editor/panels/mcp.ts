/**
 * L3 (mcp)：已接入 server 详情面板——查看连接信息 + 启停 / 删除。
 *
 * 全同步：启停 / 删除都是 WorkingState 事务变更（启停经 `setMcpServerEnabled`、删除经
 * `removeMcpServer` 同清 config + 凭证），随编辑器 [完成] 一次落盘 → reload → applyConfig。
 * 连接状态只读展示（来自注入的 runtime）。接入新 server 的引导向导是另一条路径（异步），
 * 不在此面板。
 */

import type {
  ConfigEditorContext,
  ConfigEditorRuntime,
  KeyEvent,
  PanelAction,
  PanelDescriptor,
  WorkingState,
} from "../types.js";
import type { McpServerStatus } from "@zhixing/mcp";
import { Renderer } from "../ui/render.js";
import {
  clearInputBuffer,
  isMcpServerEnabled,
  patchMcpSecrets,
  readMcpServer,
  removeMcpServer,
  setInputBuffer,
  setMcpServerEnabled,
  upsertMcpServer,
} from "../state.js";
import {
  applyMcpSetup,
  presetToCandidate,
  validateMcpSetup,
} from "../mcp-setup.js";
import { findMcpPreset } from "../../registries/index.js";
import { maskForInput } from "../ui/mask.js";
import {
  CONTENT_INDENT,
  writeInputThenFooterAndRestoreCursor,
} from "./input.js";
import {
  tone,
  renderChrome,
  renderButtonRow,
  renderFooter,
  osc8Hyperlink,
} from "../../tui/index.js";

const FOOTER_HINTS = ["↑↓ 选择", "Enter 确认", "Esc 返回", "Ctrl+C 退出"] as const;

/** 面板动作：0 = 启停，1 = 删除。 */
const ACTION_TOGGLE = 0;
const ACTION_REMOVE = 1;
const ACTION_COUNT = 2;

function findStatus(
  serverId: string,
  runtime?: ConfigEditorRuntime,
): McpServerStatus | undefined {
  return runtime?.mcpServerStatuses?.().find((s) => s.serverId === serverId);
}

function describeStatus(
  enabled: boolean,
  status: McpServerStatus | undefined,
): string {
  if (!enabled) return "已停用";
  if (!status) return "已启用（暂无连接信息）";
  if (status.status === "connected") return `已连接 · ${status.toolCount} 工具`;
  return status.error ? `连接中 · ${status.error}` : "连接中";
}

export function renderMcpServerPanel(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "mcp-server" }>,
  cursor: { index: number },
  renderer: Renderer,
  runtime?: ConfigEditorRuntime,
): void {
  renderer.clear();
  renderer.hideCursor();

  const width = renderer.terminalWidth();
  const serverId = descriptor.serverId;
  const entry = readMcpServer(state, serverId);
  const enabled = isMcpServerEnabled(state, serverId);
  const status = findStatus(serverId, runtime);

  const bodyLines: string[] = [];
  bodyLines.push(`${tone.dim("传输方式")}    ${entry?.type ?? "stdio"}`);
  if (entry?.command) {
    const args = (entry.args ?? []).join(" ");
    bodyLines.push(`${tone.dim("命令")}        ${entry.command}${args ? ` ${args}` : ""}`);
  }
  if (entry?.url) {
    bodyLines.push(`${tone.dim("地址")}        ${entry.url}`);
  }
  bodyLines.push("");
  bodyLines.push(`${tone.dim("状态")}        ${describeStatus(enabled, status)}`);

  renderer.writeLines(
    renderChrome({ title: `MCP · ${serverId}`, body: bodyLines, width }),
  );
  renderer.writeLine("");

  const buttons = [
    {
      label: enabled ? "停用" : "启用",
      hint: enabled ? "停用后其工具从会话移除" : "启用并在下次生效时连接",
    },
    { label: "删除", hint: "从配置移除该 server（含其凭证）" },
  ];
  buttons.forEach((button, index) => {
    renderer.writeLines(
      renderButtonRow({
        label: button.label,
        hint: button.hint,
        primary: false,
        selected: cursor.index === index,
      }),
    );
  });

  renderer.writeLine("");
  renderer.writeLines(renderFooter({ width, hints: FOOTER_HINTS }));
}

export interface McpServerPanelKeyResult {
  action: PanelAction;
  cursor: { index: number };
}

export function handleMcpServerPanelKey(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "mcp-server" }>,
  cursor: { index: number },
  key: KeyEvent,
): McpServerPanelKeyResult {
  const max = ACTION_COUNT - 1;
  switch (key.type) {
    case "ctrl-c":
      return { action: { type: "exit", result: { kind: "cancelled" } }, cursor };
    case "escape":
      return { action: { type: "pop", state }, cursor };
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
    case "enter": {
      if (cursor.index === ACTION_TOGGLE) {
        const enabled = isMcpServerEnabled(state, descriptor.serverId);
        return {
          action: {
            type: "stay",
            state: setMcpServerEnabled(state, descriptor.serverId, !enabled),
          },
          cursor,
        };
      }
      if (cursor.index === ACTION_REMOVE) {
        // 删除后该 server 不复存在——pop 回列表
        return {
          action: { type: "pop", state: removeMcpServer(state, descriptor.serverId) },
          cursor,
        };
      }
      return { action: { type: "stay", state }, cursor };
    }
    default:
      return { action: { type: "stay", state }, cursor };
  }
}

// ─── mcp-add：按预设接入新 server（输入密钥 → 带密钥 discovery 验证） ───

const MCP_ADD_FOOTER_HINTS = [
  "Enter 验证并接入",
  "Esc 取消",
  "Ctrl+C 退出",
] as const;

export function renderMcpAddPanel(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "mcp-add" }>,
  renderer: Renderer,
): void {
  renderer.clear();
  renderer.showCursor();

  const width = renderer.terminalWidth();
  const preset = findMcpPreset(descriptor.presetId);
  if (!preset) {
    renderer.writeLine(tone.error(`未知预设：${descriptor.presetId}`));
    return;
  }

  // 当前预设均为单密钥；多密钥预设需把此处扩展为逐字段收集（见接入引导设计）。
  const field = preset.secretFields[0];
  const bodyLines: string[] = [`接入 ${preset.label}：${preset.description}`];
  if (field) {
    bodyLines.push("");
    for (const line of field.hint.split("\n")) bodyLines.push(line);
    if (field.docUrl) {
      bodyLines.push(`${tone.dim("文档：")}${osc8Hyperlink(field.docUrl)}`);
    }
    bodyLines.push("");
    bodyLines.push(tone.dim(`示例：${field.example}`));
  }

  renderer.writeLines(
    renderChrome({ title: `接入 ${preset.label}`, body: bodyLines, width }),
  );
  renderer.writeLine("");

  if (descriptor.error) {
    renderer.writeLine(tone.error(`  ✗ ${descriptor.error}`));
    renderer.writeLine("");
  }

  // 密钥是敏感字段——mask 显示
  writeInputThenFooterAndRestoreCursor(
    renderer,
    `${CONTENT_INDENT}> ${maskForInput(state.inputBuffer)}`,
    MCP_ADD_FOOTER_HINTS,
  );
}

export function handleMcpAddPanelKey(
  ctx: ConfigEditorContext,
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "mcp-add" }>,
  key: KeyEvent,
): PanelAction {
  const preset = findMcpPreset(descriptor.presetId);
  if (!preset) return { type: "pop", state: clearInputBuffer(state) };

  switch (key.type) {
    case "ctrl-c":
      return { type: "exit", result: { kind: "cancelled" } };
    case "escape":
      return { type: "pop", state: clearInputBuffer(state) };
    case "backspace": {
      if (state.inputBuffer.length === 0) return { type: "stay", state };
      const chars = Array.from(state.inputBuffer);
      chars.pop();
      return { type: "stay", state: setInputBuffer(state, chars.join("")) };
    }
    case "char":
      return {
        type: "stay",
        state: setInputBuffer(state, state.inputBuffer + key.ch),
      };
    case "enter": {
      const value = state.inputBuffer.trim();
      if (!value) return { type: "stay", state }; // 需先输入密钥

      const probe = ctx.runtime?.mcpProbe;
      if (!probe) {
        // 理论上 /mcp 必注入 probe；防御性原地报错而非静默
        return {
          type: "replace",
          state,
          panel: {
            kind: "mcp-add",
            presetId: descriptor.presetId,
            error: "无法验证连接（未注入探测能力）",
          },
        };
      }

      const candidate = presetToCandidate(preset);
      const field = preset.secretFields[0];
      const inputs: Record<string, string> = field ? { [field.key]: value } : {};

      return {
        type: "loading",
        message: `正在验证 ${preset.label} 连接…`,
        state: clearInputBuffer(state), // 取消（Esc）→ pop，丢弃输入
        run: async (signal) => {
          const result = await validateMcpSetup(candidate, inputs, probe, signal);
          if (result.ok) {
            const { entry, secrets } = applyMcpSetup(candidate, inputs);
            let next = upsertMcpServer(
              clearInputBuffer(state),
              candidate.serverId,
              entry,
            );
            next = patchMcpSecrets(next, candidate.serverId, secrets);
            return { type: "pop", state: next };
          }
          // 失败：保留已输入密钥，原地回显错误供修改重试
          return {
            type: "replace",
            state,
            panel: {
              kind: "mcp-add",
              presetId: descriptor.presetId,
              error: result.error,
            },
          };
        },
      };
    }
    default:
      return { type: "stay", state };
  }
}
