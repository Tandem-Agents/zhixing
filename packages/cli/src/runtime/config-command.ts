/**
 * `/config` 与 `/mcp` 命令 handler——REPL 内打开配置编辑器，保存后触发 Host 换代。
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
import type { ChannelStatus } from "@zhixing/core";
import {
  getGlobalConfigPath,
  loadConfig,
  loadCredentialSnapshot,
  resolveHomeDir,
  writeConfig,
  writeCredentials,
} from "@zhixing/providers";
import { createPlatformSecretStore } from "@zhixing/secrets";
import { canonicalize } from "@zhixing/core/protocol";
import { reconcileCurrentManagedService } from "../serve/managed-service-runtime.js";
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
import { createMcpManagementAdapter } from "./mcp-management-adapter.js";
import { layout } from "../tui/index.js";
import type { CliWriter, ScreenController } from "../screen/index.js";
import { requireChrome } from "../commands/command-visibility.js";

export interface ConfigCommandDeps {
  rl: readline.Interface;
  /**
   * 仅访问 activeTurnPromise——结构子类型避免对 ReplState 的硬依赖（防 cli/repl 与
   * cli/runtime 循环 import）。
   */
  state: { activeTurnPromise: Promise<unknown> | null };
  /**
   * 配置落盘后触发核心宿主按新配置换代(优雅退出 flush 落盘 → 重新拉起)。
   * 活跃会话窗口经启动装填从盘上事实流重建——与崩溃恢复同一路径。
   */
  requestHostReload: (options?: HostReloadOptions) => Promise<HostReloadResult | void>;
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

export interface HostReloadResult {
  channels?: readonly ChannelStatus[];
}

export interface HostReloadOptions {
  readonly launchSelectionChanged: boolean;
}

export async function reloadCoreHostAfterConfig(input: {
  readonly options?: HostReloadOptions;
  readonly requestDrainShutdown: () => Promise<void>;
  readonly reconnect: (options: { readonly beforeTurnover?: () => Promise<void> }) => Promise<void>;
  readonly prepareManagedServiceTurnover: () => Promise<void>;
  readonly refresh: () => Promise<HostReloadResult | void>;
}): Promise<HostReloadResult | void> {
  const shutdownError = await input.requestDrainShutdown()
    .then(() => undefined, (error: unknown) => error);
  const reconnectError = await input.reconnect({
    ...(input.options?.launchSelectionChanged
      ? { beforeTurnover: input.prepareManagedServiceTurnover }
      : {}),
  }).then(() => undefined, (error: unknown) => error);
  if (reconnectError !== undefined) {
    if (shutdownError !== undefined) {
      throw new AggregateError(
        [shutdownError, reconnectError],
        "核心宿主停机请求与连接换代均未确认",
      );
    }
    throw reconnectError;
  }
  const result = await input.refresh();
  if (shutdownError !== undefined) throw shutdownError;
  return result;
}

export type ConfigPostCommitEffect<T> =
  | { readonly status: "succeeded"; readonly value: T }
  | { readonly status: "failed"; readonly error: unknown };

export interface ConfigPostCommitEffects {
  readonly reload: ConfigPostCommitEffect<HostReloadResult | void>;
  readonly reconcile:
    | { readonly status: "not-required" }
    | ConfigPostCommitEffect<void>;
}

export async function settleConfigPostCommitEffects(input: {
  readonly launchSelectionChanged: boolean;
  readonly reload: (options?: HostReloadOptions) => Promise<HostReloadResult | void>;
  readonly reconcile: () => Promise<unknown>;
}): Promise<ConfigPostCommitEffects> {
  const reload = await captureConfigPostCommitEffect(() => input.reload({
    launchSelectionChanged: input.launchSelectionChanged,
  }));
  const reconcile = input.launchSelectionChanged
    ? await captureConfigPostCommitEffect(async () => {
        await input.reconcile();
      })
    : { status: "not-required" as const };
  return { reload, reconcile };
}

async function captureConfigPostCommitEffect<T>(
  effect: () => Promise<T>,
): Promise<ConfigPostCommitEffect<T>> {
  try {
    return { status: "succeeded", value: await effect() };
  } catch (error) {
    return { status: "failed", error };
  }
}

export function formatHostReloadChannelMessages(
  result: HostReloadResult | void,
): string[] {
  const channels = result?.channels ?? [];
  if (channels.length === 0) return [];

  const connected = channels.filter((s) => s.state === "connected");
  const connecting = channels.filter((s) => s.state === "connecting");
  const failed = channels.filter((s) => s.state === "error");
  const disconnected = channels.filter((s) => s.state === "disconnected");
  const lines: string[] = [];

  if (connected.length > 0) {
    lines.push(
      chalk.green(
        `${layout.contentPrefix}✓ 消息通道已连接：${connected
          .map((s) => s.channelId)
          .join("、")}`,
      ),
    );
  }
  if (connecting.length > 0) {
    lines.push(
      chalk.yellow(
        `${layout.contentPrefix}… 消息通道仍在后台连接：${connecting
          .map((s) => s.channelId)
          .join("、")}`,
      ),
    );
  }
  if (failed.length > 0) {
    lines.push(
      chalk.yellow(
        `${layout.contentPrefix}⚠ 消息通道连接失败：${failed
          .map((s) => `${s.channelId}${s.error ? `（${s.error}）` : ""}`)
          .join("、")}`,
      ),
    );
  }
  if (disconnected.length > 0) {
    lines.push(
      chalk.yellow(
        `${layout.contentPrefix}⚠ 消息通道未连接：${disconnected
          .map((s) => s.channelId)
          .join("、")}`,
      ),
    );
  }

  return lines;
}

async function runEditorCommand(
  deps: ConfigCommandDeps,
  opts: { sections: SectionId[]; title: string; runtime?: ConfigEditorRuntime },
): Promise<void> {
  const { rl, state, renderer, writer } = deps;

  // 无 chrome 终端跑不了 alt-screen 编辑器——硬打命令名会绕过 visibility 进到这里，
  // 在动手让出 stdin 之前先友好提示并早退。
  if (!requireChrome(deps.screen, writer, opts.title)) return;

  // 让出 stdin 给编辑器：先停 spinner（避免动画覆盖编辑器面板），再 pause readline
  renderer.stop();
  rl.pause();

  try {
    const homeDir = resolveHomeDir();
    const configPath = getGlobalConfigPath();
    const secretStore = createPlatformSecretStore({ homeDir });

    // 重新 load 最新——保证用户外部编辑后的一致性，不复用启动缓存
    const config = loadConfig();
    const { credentials } = await loadCredentialSnapshot({ store: secretStore });

    const editorResult = await runConfigEditor({
      initialConfig: config,
      initialCredentials: credentials,
      sections: opts.sections,
      title: opts.title,
      ...(opts.runtime ? { runtime: opts.runtime } : {}),
      header: {
        workspaceRoot: config.workspace?.root,
        configPath,
        secretStoreLabel: "设备本地 SecretStore",
      },
      writers: {
        // writeConfig / writeCredentials 即"权威完整写入"——编辑器持有完整配置，写入令文件
        // 等同它，删除某 server / channel 由"省略该 id"表达、真正落盘。
        writeConfig: (next) => writeConfig(next, { homeDir }),
        writeCredentials: (next) => writeCredentials(next, { store: secretStore }),
      },
      stdin: process.stdin,
      stdout: process.stdout,
      isTTY: Boolean(process.stdin.isTTY),
    });

    switch (editorResult.kind) {
      case "completed": {
        const launchSelectionChanged = canonicalize({
          enabledRoles: config.mesh?.enabledRoles ?? [],
          executorAutoStart: config.mesh?.executorAutoStart ?? false,
        }) !== canonicalize({
          enabledRoles: editorResult.config.mesh?.enabledRoles ?? [],
          executorAutoStart: editorResult.config.mesh?.executorAutoStart ?? false,
        });
        // 前置等待 in-flight turn——宿主换代前先到 turn 边界,进行中的回答不被截断
        if (state.activeTurnPromise) {
          await state.activeTurnPromise.catch(() => {
            // turn 自身的错误已在 turn 路径展示，此处吞掉即可
          });
        }
        const effects = await settleConfigPostCommitEffects({
          launchSelectionChanged,
          reload: deps.requestHostReload,
          reconcile: () => reconcileCurrentManagedService("local-role-config-committed"),
        });
        if (
          effects.reload.status === "succeeded" &&
          effects.reconcile.status !== "failed"
        ) {
          writer.line(
            chalk.green(
              `${layout.contentPrefix}✓ 配置已保存,核心宿主已按新配置重启。`,
            ),
          );
        } else {
          const failed = [
            effects.reload.status === "failed" ? "核心宿主重载" : undefined,
            effects.reconcile.status === "failed" ? "托管服务收敛" : undefined,
          ].filter((item): item is string => item !== undefined);
          writer.line(
            chalk.yellow(
              `${layout.contentPrefix}⚠ 配置已保存，但${failed.join("与")}未确认。新配置已落盘，请运行 \`zz status\` 检查当前状态。`,
            ),
          );
        }
        if (effects.reload.status === "succeeded") {
          for (const line of formatHostReloadChannelMessages(effects.reload.value)) {
            writer.line(line);
          }
        }
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
 * （一次性 probe，接入向导验证连接，proxy 与 hub 同源 config.network.proxy）；③ mcpResolve
 * （把输入标识解析为候选——事实驱动：查 npm 真实源 + 据源文本提取，面板不感知查源 / LLM）。
 */
export async function handleMcpCommand(
  deps: ConfigCommandDeps & {
    /** MCP 连接状态 wire（宿主快照——具体结构由 infrastructure adapter 严格解码）。 */
    readMcpStatusWire: () => Promise<unknown>;
    /** 宿主轻推理通道(llm.complete)——接入向导的源解析 / 提取 */
    llmComplete: (
      prompt: string,
      role?: "main" | "light",
      signal?: AbortSignal,
    ) => Promise<string>;
  },
): Promise<void> {
  const proxy = loadConfig().network?.proxy;
  const management = createMcpManagementAdapter({
    proxy,
    readStatusWire: deps.readMcpStatusWire,
  });

  // 接入相关的 LLM——走 main 档：搜索引导的判断 / 从 README 抽启动方式的质量
  // 直接决定接入成败，是质量敏感任务，不用 light。推理在宿主(llm.complete),
  // 面板取消（Esc）放弃等待、后台结果丢弃即可。
  const inferLlm: McpSetupLlm = (prompt, signal) =>
    deps.llmComplete(prompt, "main", signal);

  // 连接状态取进屏时刻的宿主快照——管理屏打开期间不实时刷新(编辑器 runtime
  // 期望同步读;状态权威在宿主,重开 /mcp 即最新)。
  const statusSnapshot = await management.snapshot().catch(() => []);

  const runtime: ConfigEditorRuntime = {
    mcpServerStatuses: () => statusSnapshot,
    mcpProbe: management,
    // 统一输入解析：确定性输入直接出候选，裸输入经搜索引导出 choices（onStep 回报当前步骤）
    mcpResolve: (input, signal, onStep) =>
      resolveMcpSetup(input, {
        fetchSource: (name, sig) => management.readSource(name, sig),
        search: (query, sig) => management.search(query, sig),
        isServerIdValid: management.isServerIdValid,
        llm: inferLlm,
      }, signal, onStep),
    // 阶段2：搜索引导选中真实包后，读其 README 提取启动配置（与 mcpResolve 分开）
    mcpExtract: (name, signal) => extractMcpCandidate(name, {
      fetchSource: (packageName, sig) => management.readSource(packageName, sig),
      isServerIdValid: management.isServerIdValid,
      llm: inferLlm,
    }, signal),
  };
  await runEditorCommand(deps, {
    sections: ["mcp"],
    title: "MCP 服务",
    runtime,
  });
}
