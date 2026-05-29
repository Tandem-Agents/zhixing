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
  PanelAction,
  PanelDescriptor,
  WorkingState,
} from "../types.js";
import type { McpServerStatus } from "@zhixing/mcp";
import {
  clearInputBuffer,
  isMcpServerEnabled,
  listMcpServerIds,
  patchMcpSecrets,
  readMcpServer,
  removeMcpServer,
  setInputBuffer,
  setMcpServerEnabled,
  upsertMcpServer,
} from "../state.js";
import { applyMcpSetup, validateMcpSetup } from "../mcp-setup.js";
import { maskForInput } from "../ui/mask.js";
import {
  CONTENT_INDENT,
  writeInputThenFooterAndRestoreCursor,
} from "./input.js";
import {
  tone,
  renderChrome,
  chromeContentWidth,
  renderButtonRow,
  renderFooter,
  osc8Hyperlink,
  wrapToWidth,
  Renderer,
  type KeyEvent,
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
    // 地址包成 OSC-8 可点击链接——与文档链接同款（终端默认虚线下划线），视觉一致
    bodyLines.push(`${tone.dim("地址")}        ${osc8Hyperlink(entry.url)}`);
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
  const { candidate, fieldIndex, error } = descriptor;
  const fields = candidate.secretFields;
  const field = fields[fieldIndex];

  // 段落型说明文字按 chrome 内容宽度折行（chrome 对超宽 body 行截断加 …，会丢字）；
  // split("\n") 保留显式硬换行，再逐段 wrapToWidth 软折行（wrapToWidth 不识别 ANSI，
  // 故只折无色 raw 文本——文档 / 示例行带色且短，保持单行不折）。
  const contentWidth = chromeContentWidth(width);
  const wrapProse = (text: string): string[] =>
    text.split("\n").flatMap((seg) => wrapToWidth(seg, contentWidth));

  const bodyLines: string[] = [];
  if (descriptor.description) bodyLines.push(...wrapProse(descriptor.description));

  // 推断来源的 stdio 候选：显式展示将运行的本机命令——Enter 验证即在本机 spawn 它，
  // 此展示是探测前的知情同意；预设 curated（可信），不展示。
  if (candidate.source === "inferred" && candidate.entry.type === "stdio") {
    const cmd = [candidate.entry.command, ...(candidate.entry.args ?? [])]
      .filter(Boolean)
      .join(" ");
    if (bodyLines.length > 0) bodyLines.push("");
    for (const line of wrapProse(`将在本机运行：${cmd}`)) bodyLines.push(tone.warn(line));
  }

  if (field) {
    if (bodyLines.length > 0) bodyLines.push("");
    // 多字段：标进度 + 当前字段名，让用户知道还要填几项
    if (fields.length > 1) {
      bodyLines.push(tone.dim(`密钥 ${fieldIndex + 1}/${fields.length}：${field.label}`), "");
    }
    for (const line of wrapProse(field.hint)) bodyLines.push(line);
    if (field.docUrl) {
      bodyLines.push(`${tone.dim("文档：")}${osc8Hyperlink(field.docUrl)}`);
    } else if (candidate.homepage) {
      // 源没给该密钥的获取地址——诚实兜底到真实项目主页，不臆造链接
      bodyLines.push(
        `${tone.dim("获取地址未提供，可查项目主页：")}${osc8Hyperlink(candidate.homepage)}`,
      );
    }
    // 示例仅预设字段才有（推断来源不臆造示例值）——为空则不渲染孤立的"示例："行
    if (field.example) {
      bodyLines.push("");
      bodyLines.push(tone.dim(`示例：${field.example}`));
    }
  } else {
    // 无密钥需求（如推断出的免鉴权 server）——直接 Enter 验证并接入
    if (bodyLines.length > 0) bodyLines.push("");
    bodyLines.push("此 server 无需密钥，按 Enter 验证并接入。");
  }

  renderer.writeLines(
    renderChrome({
      title: `接入 ${descriptor.label ?? candidate.serverId}`,
      body: bodyLines,
      width,
    }),
  );
  renderer.writeLine("");

  if (error) {
    renderer.writeLine(tone.error(`  ✗ ${error}`));
    renderer.writeLine("");
  }

  if (field) {
    // 密钥敏感——mask 显示当前字段输入
    writeInputThenFooterAndRestoreCursor(
      renderer,
      `${CONTENT_INDENT}> ${maskForInput(state.inputBuffer)}`,
      MCP_ADD_FOOTER_HINTS,
    );
  } else {
    // 无输入字段——隐藏光标、只渲染 footer（Enter 触发验证）
    renderer.hideCursor();
    renderer.writeLines(renderFooter({ width, hints: MCP_ADD_FOOTER_HINTS }));
  }
}

export function handleMcpAddPanelKey(
  ctx: ConfigEditorContext,
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "mcp-add" }>,
  key: KeyEvent,
): PanelAction {
  const { candidate, inputs, fieldIndex } = descriptor;
  const fields = candidate.secretFields;
  const field = fields[fieldIndex];

  switch (key.type) {
    case "ctrl-c":
      return { type: "exit", result: { kind: "cancelled" } };
    case "escape":
      return { type: "pop", state: clearInputBuffer(state) };
    case "backspace": {
      if (!field || state.inputBuffer.length === 0) return { type: "stay", state };
      const chars = Array.from(state.inputBuffer);
      chars.pop();
      return { type: "stay", state: setInputBuffer(state, chars.join("")) };
    }
    case "char":
      if (!field) return { type: "stay", state }; // 无字段时不收输入
      return {
        type: "stay",
        state: setInputBuffer(state, state.inputBuffer + key.ch),
      };
    case "enter": {
      // 有当前字段 → 收集其值并累积；非末字段则推进到下一字段
      let collected = inputs;
      if (field) {
        const value = state.inputBuffer.trim();
        if (!value) return { type: "stay", state }; // 需先输入当前密钥
        collected = { ...inputs, [field.key]: value };
        if (fieldIndex + 1 < fields.length) {
          return {
            type: "replace",
            state: clearInputBuffer(state),
            panel: {
              ...descriptor,
              inputs: collected,
              fieldIndex: fieldIndex + 1,
              error: undefined,
            },
          };
        }
      }

      // 末字段（或无字段）→ 带密钥 discovery 验证 → 落盘
      const probe = ctx.runtime?.mcpProbe;
      if (!probe) {
        // 理论上 /mcp 必注入 probe；防御性原地报错而非静默
        return {
          type: "replace",
          state,
          panel: { ...descriptor, error: "无法验证连接（未注入探测能力）" },
        };
      }

      const finalInputs = collected;
      return {
        type: "loading",
        message: `正在验证 ${descriptor.label ?? candidate.serverId} 连接…`,
        state: clearInputBuffer(state), // 取消（Esc）→ pop，丢弃输入
        run: async (signal) => {
          const result = await validateMcpSetup(candidate, finalInputs, probe, signal);
          if (result.ok) {
            const { entry, secrets } = applyMcpSetup(candidate, finalInputs);
            let next = upsertMcpServer(
              clearInputBuffer(state),
              candidate.serverId,
              entry,
            );
            next = patchMcpSecrets(next, candidate.serverId, secrets);
            return { type: "pop", state: next };
          }
          // 失败：停在当前字段、回显错误，保留外层 state（当前字段已输入值供修改重试）
          // 与前序字段的 inputs，让用户改一处即可重试，不必从头再填。
          return {
            type: "replace",
            state,
            panel: { ...descriptor, error: result.error },
          };
        },
      };
    }
    default:
      return { type: "stay", state };
  }
}

// ─── mcp-add-input：统一输入接入（输入标识 → mcpResolve 解析为候选 → 候选面板） ───

const MCP_ADD_INPUT_FOOTER_HINTS = [
  "Enter 识别并继续",
  "Esc 取消",
  "Ctrl+C 退出",
] as const;

export function renderMcpAddInputPanel(
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "mcp-add-input" }>,
  renderer: Renderer,
): void {
  renderer.clear();
  renderer.showCursor();

  const width = renderer.terminalWidth();
  const contentWidth = chromeContentWidth(width);
  const wrapProse = (text: string): string[] =>
    text.split("\n").flatMap((seg) => wrapToWidth(seg, contentWidth));

  const bodyLines: string[] = wrapProse(
    "输入 MCP server 标识——npm 包名、启动命令、远程 URL，或预设名（github / notion）。" +
      "预设、URL 与完整命令直接采用；只给包名时会查 npm 确认并读取其设置说明。",
  );
  bodyLines.push("");
  bodyLines.push(tone.dim("示例：@notionhq/notion-mcp-server"));
  bodyLines.push(tone.dim("示例：npx -y @notionhq/notion-mcp-server"));
  bodyLines.push(tone.dim("示例：https://api.example.com/mcp/"));

  renderer.writeLines(
    renderChrome({ title: "接入其他 server", body: bodyLines, width }),
  );
  renderer.writeLine("");

  if (descriptor.error) {
    renderer.writeLine(tone.error(`  ✗ ${descriptor.error}`));
    renderer.writeLine("");
  }

  // 标识非敏感——明文显示（不 mask）
  writeInputThenFooterAndRestoreCursor(
    renderer,
    `${CONTENT_INDENT}> ${state.inputBuffer}`,
    MCP_ADD_INPUT_FOOTER_HINTS,
  );
}

export function handleMcpAddInputPanelKey(
  ctx: ConfigEditorContext,
  state: WorkingState,
  _descriptor: Extract<PanelDescriptor, { kind: "mcp-add-input" }>,
  key: KeyEvent,
): PanelAction {
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
      const input = state.inputBuffer.trim();
      if (!input) return { type: "stay", state }; // 需先输入标识

      const resolve = ctx.runtime?.mcpResolve;
      if (!resolve) {
        // 理论上 /mcp 必注入 mcpResolve；防御性原地报错
        return {
          type: "replace",
          state,
          panel: { kind: "mcp-add-input", error: "无法识别（未注入解析能力）" },
        };
      }

      return {
        type: "loading",
        message: `正在识别 ${input}…`,
        state: clearInputBuffer(state),
        // report 把搜索引导的当前步骤（已是人话）更新到 loading 显示
        run: async (signal, report) => {
          const result = await resolve(input, signal, report);
          // 解析失败 / 没找到：保留输入供修改（不退回让用户手填技术字段）
          if (!result.ok) {
            return {
              type: "replace",
              state,
              panel: { kind: "mcp-add-input", error: result.error },
            };
          }
          // 裸输入经搜索引导出候选列表 → 选择面板（选中后再阶段2提取）
          if ("choices" in result) {
            return {
              type: "replace",
              state: clearInputBuffer(state),
              panel: { kind: "mcp-choices", choices: result.choices, selectedIndex: 0 },
            };
          }
          // 确定性候选（预设 / URL / 命令）→ 唯一性检查 → 填密钥面板
          const { candidate } = result;
          if (listMcpServerIds(state).includes(candidate.serverId)) {
            return {
              type: "replace",
              state,
              panel: {
                kind: "mcp-add-input",
                error: `已存在 server "${candidate.serverId}"——在其面板编辑 / 删除，或换个标识。`,
              },
            };
          }
          // 用 replace（非 navigate）切到候选面板收集密钥：这样接入成功 / 取消时单次 pop
          // 即回到 MCP 服务主列表（看到刚接入的 server），而不是停在本输入页造成"没成功"
          // 的错觉（无 label：候选面板标题用 serverId）。
          return {
            type: "replace",
            state: clearInputBuffer(state),
            panel: { kind: "mcp-add", candidate, inputs: {}, fieldIndex: 0 },
          };
        },
      };
    }
    default:
      return { type: "stay", state };
  }
}

// ─── mcp-choices：搜索引导出的候选列表（↑↓ 选一个 → 阶段2 提取 → 填密钥） ───

const MCP_CHOICES_FOOTER_HINTS = [
  "↑↓ 选择",
  "Enter 接入",
  "Esc 重新输入",
  "Ctrl+C 退出",
] as const;

export function renderMcpChoicesPanel(
  _state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "mcp-choices" }>,
  renderer: Renderer,
): void {
  renderer.clear();
  renderer.hideCursor();

  const width = renderer.terminalWidth();
  const contentWidth = chromeContentWidth(width);
  const wrapProse = (text: string): string[] =>
    text.split("\n").flatMap((seg) => wrapToWidth(seg, contentWidth));

  const bodyLines: string[] = wrapProse(
    "找到这些 MCP server，选一个接入（↑↓ 选择，Enter 确认）：",
  );
  bodyLines.push("");
  descriptor.choices.forEach((choice, i) => {
    const selected = i === descriptor.selectedIndex;
    const name = `${selected ? "❯ " : "  "}${choice.name}`;
    bodyLines.push(selected ? tone.bold(name) : name);
    const detail = choice.summary || choice.reason;
    if (detail) {
      for (const line of wrapProse(`    ${detail}`)) bodyLines.push(tone.dim(line));
    }
  });

  renderer.writeLines(
    renderChrome({ title: "选择 MCP server", body: bodyLines, width }),
  );
  renderer.writeLine("");

  if (descriptor.error) {
    renderer.writeLine(tone.error(`  ✗ ${descriptor.error}`));
    renderer.writeLine("");
  }

  renderer.writeLines(renderFooter({ width, hints: MCP_CHOICES_FOOTER_HINTS }));
}

export function handleMcpChoicesPanelKey(
  ctx: ConfigEditorContext,
  state: WorkingState,
  descriptor: Extract<PanelDescriptor, { kind: "mcp-choices" }>,
  key: KeyEvent,
): PanelAction {
  const count = descriptor.choices.length;

  switch (key.type) {
    case "ctrl-c":
      return { type: "exit", result: { kind: "cancelled" } };
    case "escape":
      // 回输入框重输关键词（choices 由 replace 而来，栈上无输入页可 pop）
      return { type: "replace", state, panel: { kind: "mcp-add-input" } };
    case "arrow-up": {
      const idx = (descriptor.selectedIndex - 1 + count) % count;
      return { type: "replace", state, panel: { ...descriptor, selectedIndex: idx, error: undefined } };
    }
    case "arrow-down": {
      const idx = (descriptor.selectedIndex + 1) % count;
      return { type: "replace", state, panel: { ...descriptor, selectedIndex: idx, error: undefined } };
    }
    case "enter": {
      const choice = descriptor.choices[descriptor.selectedIndex];
      if (!choice) return { type: "stay", state };

      const extract = ctx.runtime?.mcpExtract;
      if (!extract) {
        return { type: "replace", state, panel: { ...descriptor, error: "无法接入（未注入提取能力）" } };
      }

      return {
        type: "loading",
        message: `正在读取 ${choice.name} 的说明…`,
        state,
        run: async (signal) => {
          const result = await extract(choice.name, signal);
          // 提取失败 / 无设置说明：原地回显，留在候选列表让用户换一个
          if (!result.ok) {
            return { type: "replace", state, panel: { ...descriptor, error: result.error } };
          }
          // mcpExtract 是确定包名提取，不应返回 choices——防御
          if ("choices" in result) {
            return { type: "replace", state, panel: { ...descriptor, error: "提取结果异常，请换一个" } };
          }
          const { candidate } = result;
          if (listMcpServerIds(state).includes(candidate.serverId)) {
            return {
              type: "replace",
              state,
              panel: { ...descriptor, error: `已存在 server "${candidate.serverId}"——换一个，或去其面板编辑。` },
            };
          }
          return {
            type: "replace",
            state: clearInputBuffer(state),
            panel: { kind: "mcp-add", candidate, inputs: {}, fieldIndex: 0 },
          };
        },
      };
    }
    default:
      return { type: "stay", state };
  }
}
