/**
 * config 域命令注册 —— 配置 / 权限 / 安全类命令的模块化原子注册（范式同
 * registerInfoCommands）。覆盖 /config /mcp /trust /security。
 *
 * /config·/mcp 是 alt-screen 编辑器：挂 chromeOnlyVisibility（无 chrome 终端补全与 /help
 * 不列出），执行期 requireChrome 兜底已在 handleConfigCommand 内。/trust 全部交互在 typeahead
 * args dropdown 完成、handler 为 noop；其 ArgChoiceProvider 在本模块构造，securityPipeline
 * 以 getter 注入（随 reload / 模式切换 swap，按调用时读，不在构造期 capture 快照）。
 */

import type * as readline from "node:readline/promises";
import {
  type ICommandRegistry,
  type CommandDispatcher,
  type CommandHandlerContext,
  type ArgSchema,
} from "@zhixing/core";
import type { McpHub } from "@zhixing/mcp";
import type { CliWriter, ScreenController } from "../screen/index.js";
import type { RuntimeSession } from "../runtime/session.js";
import {
  handleConfigCommand,
  handleMcpCommand,
} from "../runtime/config-command.js";
import { handleSecurityCommand } from "../security/index.js";
import { createTrustRuleArgProvider } from "../security/trust-rule-arg-provider.js";
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
  /** session —— config/mcp 编辑器保存后走 session.reload()，且读 session.runtime。 */
  readonly session: RuntimeSession;
  /** 当前 in-flight turn promise —— config/mcp reload 前先 await 到 turn 边界。 */
  readonly getActiveTurnPromise: () => Promise<unknown> | null;
  readonly mcpHub: McpHub;
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
    session: deps.session,
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
    await handleMcpCommand({ ...editorDeps(), hub: deps.mcpHub });
    return {};
  });

  // ── /trust ──
  // 全部交互在 typeahead args dropdown 完成（↑↓ 浏览 + Ctrl+D 双击撤销 + ESC 退出）；
  // "选中规则"无业务动作，accept 候选后 handler noop。物理撤销由交互层 onCandidateDelete
  // 的 trust 分支调 store.revoke。
  const trustRuleArgSchema: ArgSchema = {
    kind: "async-enum",
    name: "rule",
    description: "已沉淀的信任规则",
    required: true,
    provider: createTrustRuleArgProvider(
      () => deps.session.runtime.securityPipeline,
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
  dispatcher.registerHandler("trust:repl", () => {
    return {};
  });

  // ── /security ──
  registry.register({
    id: "security:repl",
    name: "security",
    description: "安全状态概览",
    category: "config",
    execution: "local",
    tag: "builtin",
  });
  dispatcher.registerHandler("security:repl", (ctx: CommandHandlerContext) => {
    const args = typeof ctx.args._rest === "string" ? ctx.args._rest : "";
    handleSecurityCommand(args, {
      pipeline: deps.session.runtime.securityPipeline,
      writer,
    });
    return {};
  });
}
