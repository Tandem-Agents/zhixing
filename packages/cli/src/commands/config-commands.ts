/**
 * config 域命令注册 —— 配置 / 权限 / 安全类命令的模块化原子注册（范式同
 * registerInfoCommands）。覆盖 /config /mcp /trust /security。
 *
 * /config·/mcp 是 alt-screen 编辑器(本地 TTY 交互、写盘本地)：保存后经
 * requestHostReload 触发宿主按新配置换代生效。/trust 执行体在核心宿主
 * (trust.list / revoke RPC,语境随当前对话派生);/security 同样经宿主
 * session.security 读取当前对话的安全状态。
 */

import type * as readline from "node:readline/promises";
import {
  type ICommandRegistry,
  type CommandDispatcher,
  type CommandHandlerContext,
  type ArgSchema,
} from "@zhixing/core";
import type { McpServerStatus } from "@zhixing/mcp";
import type { CliWriter, ScreenController } from "../screen/index.js";
import {
  handleConfigCommand,
  handleMcpCommand,
} from "../runtime/config-command.js";
import { handleSecurityCommand, handleTrustCommand } from "../security/index.js";
import { createTrustRuleArgProvider } from "../security/trust-rule-arg-provider.js";
import type { RpcManagementFacade } from "../runtime/rpc-management-facade.js";
import { chromeOnlyVisibility } from "./command-visibility.js";

export interface ConfigCommandsDeps {
  readonly registry: ICommandRegistry;
  readonly dispatcher: CommandDispatcher;
  readonly writer: CliWriter;
  readonly rl: readline.Interface;
  /** 仅 stop —— 进编辑屏前停 spinner。 */
  readonly renderer: { stop: () => void };
  /** chrome 屏幕控制器（无 chrome 为 null）—— config/mcp 编辑器退屏后重申光标隐藏。 */
  readonly screen: ScreenController | null;
  /** 当前 in-flight turn promise —— config/mcp reload 前先 await 到 turn 边界。 */
  readonly getActiveTurnPromise: () => Promise<unknown> | null;
  /** 管理面门面(/trust 执行体、/mcp 的宿主侧数据面)。 */
  readonly management: RpcManagementFacade;
  /** 当前对话 id —— /trust 的语境派生入参(场景对话见场景上下文规则)。 */
  readonly getConversationId: () => string;
  /** 配置落盘后触发核心宿主按新配置换代。 */
  readonly requestHostReload: () => Promise<void>;
}

export function registerConfigCommands(deps: ConfigCommandsDeps): void {
  const { registry, dispatcher, writer } = deps;

  // config/mcp handler 需要的 ConfigCommandDeps —— state.activeTurnPromise 以 getter-属性
  // 注入，handleConfigCommand 在编辑屏退出后读取当时最新值。
  const editorDeps = () => ({
    rl: deps.rl,
    state: {
      get activeTurnPromise(): Promise<unknown> | null {
        return deps.getActiveTurnPromise();
      },
    },
    requestHostReload: deps.requestHostReload,
    renderer: deps.renderer,
    writer,
    screen: deps.screen,
  });

  // ── /config ──
  registry.register({
    id: "config:repl",
    name: "config",
    description: "修改基础配置（服务商 / 模型 / API Key / 消息通道等）",
    category: "config",
    execution: "local",
    tag: "builtin",
    visibility: chromeOnlyVisibility,
  });
  dispatcher.registerHandler("config:repl", async () => {
    await handleConfigCommand(editorDeps());
    return {};
  });

  // ── /mcp ──
  registry.register({
    id: "mcp:repl",
    name: "mcp",
    description: "管理 MCP 服务（接入外部工具 / 启停 / 查看连接）",
    category: "config",
    execution: "local",
    tag: "builtin",
    visibility: chromeOnlyVisibility,
  });
  dispatcher.registerHandler("mcp:repl", async () => {
    await handleMcpCommand({
      ...editorDeps(),
      mcpStatuses: async () =>
        (await deps.management.serverInfo()).mcpServers as McpServerStatus[],
      llmComplete: (prompt, role) => deps.management.llmComplete(prompt, role),
    });
    return {};
  });

  // ── /trust ──
  // 命令行为（列表 / 撤销）走 handleTrustCommand、target 无关、所有模式可达。typeahead 下
  // 额外挂 args dropdown 面板增强（↑↓ 浏览 + Ctrl+D 双击撤销 + ESC 退出）；面板的物理撤销由
  // 交互层 onCandidateDelete 的 trust 分支经 RPC 撤销，与命令行撤销同一宿主执行体。
  const trustRuleArgSchema: ArgSchema = {
    kind: "async-enum",
    name: "rule",
    description: "已沉淀的信任规则",
    required: true,
    provider: createTrustRuleArgProvider(() =>
      deps.management.trustList(deps.getConversationId()),
    ),
  };
  registry.register({
    id: "trust:repl",
    name: "trust",
    description: "权限规则管理",
    category: "config",
    execution: "local",
    tag: "builtin",
    args: [trustRuleArgSchema],
  });
  dispatcher.registerHandler(
    "trust:repl",
    async (ctx: CommandHandlerContext) => {
      const args = typeof ctx.args._rest === "string" ? ctx.args._rest : "";
      await handleTrustCommand(args, {
        listRules: () => deps.management.trustList(deps.getConversationId()),
        revokeRule: (id) =>
          deps.management.trustRevoke(id, deps.getConversationId()),
        writer,
      });
      return {};
    },
  );

  // ── /security ──
  registry.register({
    id: "security:repl",
    name: "security",
    description: "安全状态概览",
    category: "config",
    execution: "local",
    tag: "builtin",
  });
  dispatcher.registerHandler("security:repl", async (ctx: CommandHandlerContext) => {
    const args = typeof ctx.args._rest === "string" ? ctx.args._rest : "";
    await handleSecurityCommand(args, {
      status: () => deps.management.securityStatus(deps.getConversationId()),
      writer,
    });
    return {};
  });
}
