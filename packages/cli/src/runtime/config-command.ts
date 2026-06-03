/**
 * `/config` 与 `/mcp` 命令 handler——REPL 内打开配置编辑器，保存后触发 hot reload。
 *
 * 流程：
 * 0. requireChrome 门禁——编辑器是 alt-screen，无 chrome 终端（非 TTY / 管道）跑不了；
 *    硬打命令名会绕过 visibility 进到这里，在此友好提示并早退
 * 1. 暂停 readline + 停 spinner，让出 stdin 给编辑器接管 alt screen
 * 2. 重新 load 最新 config/credentials——不复用启动缓存（保证用户外部编辑后的一致性）
 * 3. 调 runConfigEditor——与 startup-check 共用接口、不同 caller，差异由 ctx 注入
 * 4. 处理 ConfigEditorResult：completed → await in-flight turn → session.reload() → 透明性
 *    反馈；cancelled → 静默回 REPL（非 TTY 已被步骤 0 拦在前面，editor 不会返回 non-tty）
 * 5. 恢复 readline 主循环
 *
 * activeTurnPromise 的 await 是**调用方语义**——session.reload() 自身不读 REPL state，
 * 由 handler 在调 reload 之前先等当前 turn 完成（避免 swap agentRuntime 在 turn 跑中）。
 */

import * as readline from "node:readline/promises";
import chalk from "chalk";
import {
  getCredentialsPath,
  getGlobalConfigPath,
  loadConfig,
  loadCredentials,
  resolveHomeDir,
  writeConfig,
  writeCredentials,
} from "@zhixing/providers";
import {
  BASE_CONFIG_SECTION_IDS,
  extractMcpCandidate,
  resolveMcpSetup,
  runConfigEditor,
} from "../config-editor/index.js";
import type {
  ConfigEditorRuntime,
  McpSetupLlm,
  SectionId,
} from "../config-editor/index.js";
import {
  fetchMcpServerSource,
  probeServer,
  searchMcpServers,
  type McpHub,
} from "@zhixing/mcp";
import { layout } from "../tui/index.js";
import type { CliWriter, ScreenController } from "../screen/index.js";
import { requireChrome } from "../commands/command-visibility.js";
import type { RuntimeSession } from "./session.js";
import type { ReloadResult } from "./types.js";

export interface ConfigCommandDeps {
  rl: readline.Interface;
  /**
   * 仅访问 activeTurnPromise——结构子类型避免对 ReplState 的硬依赖（防 cli/repl 与
   * cli/runtime 循环 import）。
   */
  state: { activeTurnPromise: Promise<unknown> | null };
  session: RuntimeSession;
  /** 仅 stop 接口——结构子类型，与 cli/render 的 Renderer 实现兼容 */
  renderer: { stop: () => void };
  /** 写屏 sink——所有反馈（成功 / 失败 / 防御性提示）经此协调，避免推走 chrome */
  writer: CliWriter;
  /**
   * chrome 屏幕控制器（无 chrome 终端为 null）——编辑器是自管 alt-screen + 光标的全屏
   * modal，退出回到 chrome 后由它重申"硬件光标隐藏"不变量（光标可见性的单一来源）。
   */
  screen: ScreenController | null;
}

async function runEditorCommand(
  deps: ConfigCommandDeps,
  opts: { sections: SectionId[]; title: string; runtime?: ConfigEditorRuntime },
): Promise<void> {
  const { rl, state, session, renderer, writer } = deps;

  // 无 chrome 终端跑不了 alt-screen 编辑器——硬打命令名会绕过 visibility 进到这里，
  // 在动手让出 stdin 之前先友好提示并早退。
  if (!requireChrome(deps.screen, writer, opts.title)) return;

  // 让出 stdin 给编辑器：先停 spinner（避免动画覆盖编辑器面板），再 pause readline
  renderer.stop();
  rl.pause();

  try {
    const homeDir = resolveHomeDir();
    const configPath = getGlobalConfigPath();
    const credentialsPath = getCredentialsPath(homeDir);

    // 重新 load 最新——保证用户外部编辑后的一致性，不复用启动缓存
    const config = loadConfig();
    const credentials = loadCredentials({ homeDir });

    const editorResult = await runConfigEditor({
      initialConfig: config,
      initialCredentials: credentials,
      sections: opts.sections,
      title: opts.title,
      ...(opts.runtime ? { runtime: opts.runtime } : {}),
      header: {
        workspaceRoot: config.workspace?.root,
        configPath,
        credentialsPath,
      },
      writers: {
        // writeConfig / writeCredentials 即"权威完整写入"——编辑器持有完整配置，写入令文件
        // 等同它，删除某 server / channel 由"省略该 id"表达、真正落盘。
        writeConfig: (next) => writeConfig(next, { homeDir }),
        writeCredentials: (next) => writeCredentials(next, { homeDir }),
      },
      stdin: process.stdin,
      stdout: process.stdout,
      isTTY: Boolean(process.stdin.isTTY),
    });

    switch (editorResult.kind) {
      case "completed": {
        // 前置等待 in-flight turn——session.reload() 不读 REPL state，由 caller 守护
        if (state.activeTurnPromise) {
          await state.activeTurnPromise.catch(() => {
            // turn 自身的错误已在 turn 路径展示，此处吞掉即可
          });
        }
        const reloadResult = await session.reload();
        renderReloadFeedback(reloadResult);
        break;
      }
      case "cancelled":
        // 静默回 REPL——用户主动取消，无副作用
        break;
      case "non-tty":
        // requireChrome 已在入口拦下无 chrome 终端，functioning REPL 不会到达此分支；
        // editor 类型仍保留 non-tty（startup 等非 REPL caller 复用），这里不再单独提示。
        break;
    }
  } catch (err) {
    // /config 处理本身异常（罕见——alt screen 切换 / TTY 异常）
    writer.line(
      chalk.red(
        `${layout.contentPrefix}⚠ 配置编辑器异常：${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    );
  } finally {
    rl.resume();
    // 编辑器（自管 alt-screen + 光标的全屏 modal）退出后重申 chrome 的硬件光标隐藏
    // 不变量——modal 内为输入显示过光标，退出 alt-screen 时其可见性 implementation-
    // defined，不重申会残留一个随流式输出闪烁的硬件光标。
    deps.screen?.reassertCursorHidden();
  }

  function renderReloadFeedback(result: ReloadResult): void {
    switch (result.kind) {
      case "no-change":
        writer.line(chalk.dim(`${layout.contentPrefix}(无变更)`));
        break;
      case "applied": {
        const domains = result.changedDomains.join(" + ");
        writer.line(
          chalk.green(
            `${layout.contentPrefix}✓ 配置已保存。下条消息使用新配置（${domains}）。`,
          ),
        );
        break;
      }
      case "failed":
        writer.line(
          chalk.yellow(
            `${layout.contentPrefix}⚠ 配置已保存但应用失败：${result.error.message}。下次启动生效。`,
          ),
        );
        break;
    }
  }
}

/** `/config`——基础配置（服务商 / 模型 / 消息通道）。 */
export async function handleConfigCommand(deps: ConfigCommandDeps): Promise<void> {
  await runEditorCommand(deps, {
    sections: BASE_CONFIG_SECTION_IDS.slice(),
    title: "基础配置",
  });
}

/**
 * `/mcp`——MCP 服务管理 + 接入引导（用户唯一入口）。
 *
 * 注入三件运行态：① serverStatuses（让 section 显示连接状态）；② discovery 探测
 * （probeServer，接入向导验证连接，proxy 与 hub 同源 config.network.proxy）；③ mcpResolve
 * （把输入标识解析为候选——事实驱动：查 npm 真实源 + 据源文本提取，面板不感知查源 / LLM）。
 */
export async function handleMcpCommand(
  deps: ConfigCommandDeps & { hub: McpHub },
): Promise<void> {
  const proxy = loadConfig().network?.proxy;

  // 接入相关的 LLM——走 main 档（callText 的 "main" 通道）：搜索引导的判断 / 从 README 抽
  // 启动方式的质量直接决定接入成败，是质量敏感任务，不用 light。callText 不收 signal：面板
  // 取消（Esc）放弃等待、后台结果丢弃即可，无需中断底层调用。
  const inferLlm: McpSetupLlm = (prompt) =>
    deps.session.runtime.callText(prompt, "main");

  // 查源 / 搜索都走 SSRF-safe fetch，proxy 与 hub / probe 同源 config.network.proxy
  const fetchSource = (name: string, sig?: AbortSignal) =>
    fetchMcpServerSource(name, { proxy, ...(sig ? { signal: sig } : {}) });
  const search = (query: string, sig?: AbortSignal) =>
    searchMcpServers(query, { proxy, ...(sig ? { signal: sig } : {}) });

  const runtime: ConfigEditorRuntime = {
    mcpServerStatuses: () => deps.hub.serverStatuses(),
    mcpProbe: (spec, signal) => probeServer(spec, { signal, proxy }),
    // 统一输入解析：确定性输入直接出候选，裸输入经搜索引导出 choices（onStep 回报当前步骤）
    mcpResolve: (input, signal, onStep) =>
      resolveMcpSetup(input, { fetchSource, search, llm: inferLlm }, signal, onStep),
    // 阶段2：搜索引导选中真实包后，读其 README 提取启动配置（与 mcpResolve 分开）
    mcpExtract: (name, signal) => extractMcpCandidate(name, { fetchSource, llm: inferLlm }, signal),
  };
  await runEditorCommand(deps, {
    sections: ["mcp"],
    title: "MCP 服务",
    runtime,
  });
}
