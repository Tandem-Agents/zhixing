/**
 * L3 (mcp)：已接入 server 详情面板——查看连接信息 + 启停 / 删除。
 *
 * 全同步：启停 / 删除都是 WorkingState 事务变更（启停经 `setMcpServerEnabled`、删除经
 * `removeMcpServer` 同清 config + 凭证），随编辑器 [完成] 一次落盘 → Host drain/replacement。
 * 连接状态只读展示（来自注入的 runtime）。接入新 server 的引导向导是另一条路径（异步），
 * 不在此面板。
 */
import type { ConfigEditorRuntime, PanelDescriptor, WorkingState } from "../types.js";
import { isMcpServerEnabled, readMcpServer } from "../state.js";
import { maskForInput } from "../ui/mask.js";
import { CONTENT_INDENT, writeInputThenFooterAndRestoreCursor } from "./input.js";
import { tone, renderChrome, chromeContentWidth, renderButtonRow, renderFooter, osc8Hyperlink, wrapToWidth, Renderer } from "../../tui/index.js";
import { findStatus, describeStatus } from '../model/mcp.js';
export { type McpServerPanelKeyResult, handleMcpServerPanelKey, handleMcpAddPanelKey, handleMcpAddInputPanelKey, handleMcpChoicesPanelKey } from '../model/mcp.js';



const FOOTER_HINTS = ["↑↓ 选择", "Enter 确认", "Esc 返回", "Ctrl+C 退出"] as const;


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

  // 所有候选都展示实际作用目标；来源标签不是授权。
  if (candidate.entry.type !== "http") {
    const cmd = [candidate.entry.command, ...(candidate.entry.args ?? [])]
      .filter(Boolean)
      .join(" ");
    if (bodyLines.length > 0) bodyLines.push("");
    for (const line of wrapProse(`将在本机运行：${cmd}`)) bodyLines.push(tone.warn(line));
  } else {
    for (const line of wrapProse(`将连接：${candidate.entry.url}`)) bodyLines.push(tone.warn(line));
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
