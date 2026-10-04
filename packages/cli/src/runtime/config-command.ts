/** 旧终端配置/MCP 适配器：拥有输入让位、编辑器与 ANSI 反馈。 */
import type * as readline from "node:readline/promises";
import chalk from "chalk";
import { BASE_CONFIG_SECTION_IDS, runConfigEditor, type ConfigEditorRuntime, type SectionId } from "../config-editor/index.js";
import { layout } from "../tui/index.js";
import type { CliWriter, ScreenController } from "../screen/index.js";
import { requireChrome } from "../commands/command-visibility.js";
import { editRuntimeConfiguration, prepareMcpConfiguration, type ConfigurationApplicationDeps, type ConfigurationInteractionOptions, type HostReloadResult, type McpConfigurationDeps } from "./configuration-application.js";
export { reloadCoreHostAfterConfig, settleConfigPostCommitEffects, type HostReloadResult, type HostReloadOptions, type ConfigPostCommitEffects, type ConfigPostCommitEffect } from "./configuration-application.js";

export interface ConfigCommandDeps extends ConfigurationApplicationDeps {
  rl: readline.Interface;
  renderer: { stop(): void };
  writer: CliWriter;
  screen: ScreenController | null;
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

async function runEditorCommand(deps: ConfigCommandDeps, opts: {
  kind: "config" | "mcp"; sections: SectionId[]; title: string;
  runtime?: ConfigEditorRuntime;
  mcpApplication?: ConfigurationInteractionOptions["mcpApplication"];
}): Promise<void> {
  const { rl, renderer, writer } = deps;
  if (!requireChrome(deps.screen, writer, opts.title)) return;
  renderer.stop(); rl.pause();
  try {
    const result = await editRuntimeConfiguration(deps, {
      kind: opts.kind, mcpApplication: opts.mcpApplication,
      edit: session => runConfigEditor({
        ...session, sections: opts.sections, title: opts.title,
        ...(opts.runtime ? { runtime: opts.runtime } : {}),
        header: { workspaceRoot: session.initialConfig.workspace?.root, configPath: deps.configPath, secretStoreLabel: "设备本地 SecretStore" },
        stdin: process.stdin, stdout: process.stdout, isTTY: Boolean(process.stdin.isTTY),
      }),
    });
    if (result.kind === "mcp") {
      writer.line((result.result.status === "active" ? chalk.green : chalk.yellow)(layout.contentPrefix + result.result.message));
    } else if (result.kind === "saved-pending") {
      writer.line(chalk.yellow(layout.contentPrefix + "配置已保存，但消息通道尚未确认应用；重新打开配置可重试。"));
    } else if (result.kind === "local-applied") {
      writer.line(chalk.green(layout.contentPrefix + "配置已保存，连接按需局部刷新；其他任务不受影响。"));
    } else if (result.kind === "reloaded") {
      const { effects } = result;
      if (result.pendingChannels) {
        writer.line(chalk.yellow(layout.contentPrefix + "消息通道尚未确认应用；重新打开配置可重试。"));
      }
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
    }
  } catch (err) {
    writer.line(chalk.red(layout.contentPrefix + "⚠ 配置编辑器异常：" + (err instanceof Error ? err.message : String(err))));
  } finally {
    rl.resume();
    deps.screen?.reassertCursorHidden();
  }
}

export async function handleConfigCommand(deps: ConfigCommandDeps): Promise<void> {
  await runEditorCommand(deps, { kind: "config", sections: BASE_CONFIG_SECTION_IDS.slice(), title: "基础配置" });
}

export async function handleMcpCommand(deps: ConfigCommandDeps & McpConfigurationDeps): Promise<void> {
  const management = await prepareMcpConfiguration(deps);
  await runEditorCommand(deps, { kind: "mcp", sections: ["mcp"], title: "MCP 服务", ...management });
}
