import { countWork, formatWorkItems, liveChannels, activeWork, otherRpcConnections, createStopSelectionRequest, shutdownStrategyForChoice } from '../runtime/stop-selection.js';
import { BUILTIN_COMMANDS } from "./builtin-definitions.js";
/**
 * info 域命令注册 —— 只读展示类命令的模块化原子注册（范式同 registerTaskCommands）。
 *
 * 覆盖 /help /status /stop /resolve /model /usage /context /tasks。
 * 运行时信息的权威在核心宿主——经会话与管理面 RPC 取；模型 / provider
 * 显示取本地配置（宿主按同一配置装配）。
 */

import chalk from "chalk";
import { type SchedulerFacade } from "@zhixing/core/scheduler";
import { type ChannelStatus } from "@zhixing/core/channels";
import { type ICommandRegistry, type CommandDispatcher, type CommandHandlerContext, type CommandDef, type CommandCategory } from "@zhixing/core/typeahead";
import { renderUsageReport, renderContextVisual } from "../render.js";
import { layout } from "../tui/style.js";
import type { CliWriter } from "../screen/index.js";
import type {
  RpcManagementFacade,
  ServerInfoResult,
} from "../runtime/rpc-management-facade.js";
import type { ConversationController } from "../runtime/conversation-controller.js";
import type {
  RuntimeNetworkProxyDisplayProjection,
  RuntimePrimaryModelDisplayProjection,
} from "../runtime/runtime-configuration-provider.js";
import { formatRelativeTime } from "./format.js";
import type { SelectionService } from "../tui/selection/index.js";
import {
  SelectionBusyError,
  SelectionUnavailableError,
} from "../tui/selection/index.js";

export interface InfoCommandsDeps {
  readonly registry: ICommandRegistry;
  readonly dispatcher: CommandDispatcher;
  readonly writer: CliWriter;
  /** Configuration Provider 发布的有限模型显示投影。 */
  readonly getPrimaryModel: () => RuntimePrimaryModelDisplayProjection;
  /** 会话控制器——当前对话指针与上下文预算(经宿主)的入口 */
  readonly controller: ConversationController;
  /** 网络代理诊断（/status，display 字段已脱敏）。 */
  readonly getNetworkProxy: () => RuntimeNetworkProxyDisplayProjection;
  /** 调度门面（/tasks 从当前宿主 scheduler authority 读取）。 */
  readonly getScheduler: () => SchedulerFacade;
  /** 管理面门面（宿主状态等只读执行体）。 */
  readonly management: RpcManagementFacade;
  /** 通用选择服务。/stop 使用它承载交互式决策。 */
  readonly selection?: SelectionService;
  /** /stop 成功发出停机请求后关闭当前终端接入面。 */
  readonly requestExit?: () => void;
}

// /help 命令地图的分类显示顺序 + 中文标签——命令分类展示的单一来源。registry.list 已
// 剔除 hidden 与不可见命令，这里只按类聚合渲染；动态 /<name> 技能（plugin 类）数量可能
// 很多，聚合成一行汇总置末尾——/help 是命令地图、不是技能浏览器。
const HELP_CATEGORY_ORDER: readonly CommandCategory[] = [
  "session",
  "info",
  "tools",
  "config",
];

const HELP_CATEGORY_LABELS: Record<CommandCategory, string> = {
  session: "会话管理",
  info: "信息查询",
  tools: "工具",
  config: "配置",
  debug: "调试",
  plugin: "技能",
  hidden: "",
};

/**
 * 渲染 /help 命令地图。入参是 registry.list(ctx) 的结果（已按 ctx 过滤 hidden +
 * visibility），故此处不感知终端能力——no-chrome 下 alt-screen 命令早在 list 阶段被滤掉。
 */
function renderHelpCommands(
  commands: readonly CommandDef[],
  writer: CliWriter,
): void {
  writer.line(`\n${layout.contentPrefix}${chalk.bold("可用命令：")}`);

  const byCategory = new Map<CommandCategory, CommandDef[]>();
  for (const cmd of commands) {
    const bucket = byCategory.get(cmd.category) ?? [];
    bucket.push(cmd);
    byCategory.set(cmd.category, bucket);
  }

  for (const cat of HELP_CATEGORY_ORDER) {
    const items = byCategory.get(cat);
    if (!items || items.length === 0) continue;
    writer.line(`\n  ${chalk.bold(HELP_CATEGORY_LABELS[cat])}`);
    for (const cmd of items) {
      writer.line(
        `    ${chalk.cyan(`/${cmd.name}`.padEnd(14))} ${chalk.dim(cmd.description)}`,
      );
    }
  }

  writer.line(`\n  ${chalk.bold("能力入口")}`);
  writer.line(
    `    ${chalk.cyan("@".padEnd(14))} ${chalk.dim("多视角发散收敛评议")}`,
  );

  const pluginCount = byCategory.get("plugin")?.length ?? 0;
  if (pluginCount > 0) {
    writer.line(
      `\n  ${chalk.bold(HELP_CATEGORY_LABELS.plugin)} ${chalk.dim(`(${pluginCount} 个) · 输入 / 浏览全部`)}`,
    );
  }
  writer.line("");
}

function formatTaskSchedule(schedule: {
  kind: string;
  at?: string;
  everyMs?: number;
  expr?: string;
  tz?: string;
}): string {
  switch (schedule.kind) {
    case "once":
      return `一次性 ${schedule.at ? new Date(schedule.at).toLocaleString() : ""}`;
    case "interval": {
      const ms = schedule.everyMs ?? 0;
      if (ms < 60_000) return `每 ${Math.round(ms / 1000)} 秒`;
      if (ms < 3_600_000) return `每 ${Math.round(ms / 60_000)} 分钟`;
      return `每 ${Math.round(ms / 3_600_000)} 小时`;
    }
    case "cron":
      return `cron "${schedule.expr}"${schedule.tz ? ` (${schedule.tz})` : ""}`;
    default:
      return schedule.kind;
  }
}

function formatChannelStatus(status: ChannelStatus): string {
  switch (status.state) {
    case "connected":
      return `${chalk.green("●")} ${status.channelId}: 已连接`;
    case "connecting":
      return `${chalk.yellow("●")} ${status.channelId}: 连接中`;
    case "error":
      return `${chalk.yellow("●")} ${status.channelId}: 异常${status.error ? ` (${status.error})` : ""}`;
    case "disconnected":
      return `${chalk.dim("○")} ${status.channelId}: 未连接`;
  }
}

function renderRuntimeControlStatus(
  hostInfo: ServerInfoResult | null,
  writer: CliWriter,
): void {
  if (!hostInfo) {
    writer.line(chalk.yellow("  宿主状态暂不可用。"));
    return;
  }

  const live = liveChannels(hostInfo);
  const otherRpc = otherRpcConnections(hostInfo);
  const work = activeWork(hostInfo);
  const deferredCount = countWork(hostInfo.deferredWork);
  const keepAliveCount = countWork(hostInfo.keepAliveWork);
  const host = hostInfo.host ?? "127.0.0.1";
  const port = hostInfo.port ?? "?";

  writer.line(`  ${chalk.dim("运行服务:")} pid ${hostInfo.pid} · ${host}:${port}`);
  writer.line(
    `  ${chalk.dim("接入面:")} 当前终端` +
      (otherRpc > 0 ? ` · 其他终端 ${otherRpc}` : "") +
      (live.length > 0 ? ` · ${live.map((s) => s.channelId).join("、")}` : ""),
  );
  writer.line(
    `  ${chalk.dim("运行中:")} ${
      work.count > 0
        ? `可取消 ${work.cancellableCount} · 等待投递 ${work.drainOnlyCount}`
        : "无"
    }`,
  );
  if (work.count > 0) {
    writer.line(`    ${chalk.dim("可取消:")} ${formatWorkItems(work.cancellableWork)}`);
    writer.line(`    ${chalk.dim("仅等待:")} ${formatWorkItems(work.drainOnlyWork)}`);
  }
  writer.line(
    `  ${chalk.dim("未送达:")} ${deferredCount > 0 ? `${deferredCount} 条待重试` : "无"}`,
  );
  writer.line(
    `  ${chalk.dim("定时任务:")} ${keepAliveCount > 0 ? `${keepAliveCount} 个已启用` : "无"}`,
  );
  if (hostInfo.logPath) {
    writer.line(`  ${chalk.dim("日志:")} ${hostInfo.logPath}`);
  }
  writer.line(chalk.dim("  需要停止知行请输入 /stop。\n"));
}

export function registerInfoCommands(deps: InfoCommandsDeps): void {
  const { registry, dispatcher, writer } = deps;
  registry.register(BUILTIN_COMMANDS["resolve:repl"]);
  dispatcher.registerHandler("resolve:repl", async () => {
    const pending = await deps.controller.uncertainRuns();
    if (pending.length === 0) {
      writer.line("\n  当前对话没有结果待确认的运行。\n");
      return {};
    }
    if (!deps.selection) {
      writer.line("\n  当前终端不支持选择交互，未更改运行状态。请在交互终端使用 /resolve。\n");
      return {};
    }
    type Choice = "user-abandoned" | "user-verified-side-effects" | "user-retry-acknowledged" | "return";
    for (const notice of pending) {
      const choice = await deps.selection.choose<Choice>({
        id: `resolve:${notice.ref.runId}`, title: "处理结果待确认的运行",
        body: [`时间：${new Date(notice.at).toLocaleString()}`, "这次运行的最终结果尚未确认，文件修改等操作可能已经发生。", "结束运行不会撤销已有操作；重新执行可能产生重复效果。"],
        options: [
          { value: "return", label: "暂不处理", tone: "muted" },
          { value: "user-abandoned", label: "结束这次运行", description: "保留已有操作，不再执行本轮", tone: "primary" },
          { value: "user-verified-side-effects", label: "我已检查已有操作，结束本轮", description: "记录已核实的裁决，不重做操作" },
          { value: "user-retry-acknowledged", label: "接受重复风险，重新执行", description: "仅在确认可以重复操作后选择", tone: "danger" },
        ],
        initialValue: "return", submitLabel: "确认", cancelLabel: "返回",
      });
      if (choice.kind !== "selected" || choice.value === "return") return {};
      await deps.controller.resolveUncertain(notice, choice.value);
      writer.line(choice.value === "user-retry-acknowledged" ? "\n  已提交重新执行。\n" : "\n  本次运行已结束，可以继续对话。\n");
    }
    return {};
  });
  const getModelView = (): { modelDisplay: string; providerDisplay: string } => {
    const model = deps.getPrimaryModel();
    return {
      modelDisplay: model.model || "(未配置)",
      providerDisplay: model.providerId || "(未配置)",
    };
  };

  // /help —— registry 的消费者：把当前命令集渲染成命令地图，按 ctx 过滤 hidden + visibility。
  registry.register(BUILTIN_COMMANDS["help:repl"]);
  dispatcher.registerHandler("help:repl", (ctx: CommandHandlerContext) => {
    renderHelpCommands(registry.list(ctx.runtime), writer);
    return {};
  });

  registry.register(BUILTIN_COMMANDS["status:repl"]);
  dispatcher.registerHandler("status:repl", async () => {
    // ProxyDescription.display 已脱敏（含凭证 URL 安全显示）+ 区分四态 off / auto+null /
    // auto+url / explicit—— mode=auto+null 时 dim 灰色提示直连，其他状态正常色。
    const proxy = deps.getNetworkProxy();
    const proxyText =
      !proxy.hasResolvedProxy && proxy.mode === "auto"
        ? chalk.dim(proxy.display)
        : proxy.display;
    const current = deps.controller.current;
    const modeText =
      current.mode.kind === "workscene"
        ? ` ${chalk.dim(`(工作场景: ${current.mode.sceneName})`)}`
        : "";
    const { modelDisplay, providerDisplay } = getModelView();
    const hostInfo = await deps.management.serverInfo().catch(() => null);
    const channelLines =
      hostInfo?.channels && hostInfo.channels.length > 0
        ? `\n  ${chalk.dim("通道:")}\n    ${hostInfo.channels
            .map(formatChannelStatus)
            .join("\n    ")}`
        : "";
    const recoveryBackupLine = hostInfo?.recoveryBackup
      ? `\n  ${chalk.dim("恢复备份:")} ${formatRecoveryBackupState(hostInfo.recoveryBackup)}`
      : "";
    writer.line(
      `\n  ${chalk.dim("Session:")} ${current.name}${modeText}` +
        `\n  ${chalk.dim("Model:")} ${chalk.cyan(modelDisplay)}` +
        `\n  ${chalk.dim("Provider:")} ${providerDisplay}` +
        `\n  ${chalk.dim("Network proxy:")} ${proxyText}` +
        `${channelLines}${recoveryBackupLine}\n`,
    );
    renderRuntimeControlStatus(hostInfo, writer);
    return {};
  });

  registry.register(BUILTIN_COMMANDS["stop:repl"]);
  dispatcher.registerHandler("stop:repl", async () => {
    const selection = deps.selection;
    if (!selection) {
      writer.line(chalk.yellow("\n  当前终端不支持选择交互，未执行停止。\n"));
      return {};
    }

    const hostInfo = await deps.management.serverInfo().catch(() => null);
    try {
      const result = await selection.choose(createStopSelectionRequest(hostInfo));
      if (result.kind !== "selected" || result.value === "cancel") {
        writer.line(chalk.dim("\n  已取消停止。\n"));
        return {};
      }

      await deps.management.serverShutdown({
        reason: "user-stop",
        strategy: shutdownStrategyForChoice(result.value),
        timeoutMs: 30_000,
      });
      writer.line(chalk.yellow("\n  正在停止知行，当前终端将退出。\n"));
      deps.requestExit?.();
    } catch (err) {
      if (err instanceof SelectionUnavailableError || err instanceof SelectionBusyError) {
        writer.line(chalk.yellow(`\n  无法打开选择面板：${err.message}\n`));
        return {};
      }
      throw err;
    }
    return {};
  });

  registry.register(BUILTIN_COMMANDS["model:repl"]);
  dispatcher.registerHandler("model:repl", () => {
    const { modelDisplay, providerDisplay } = getModelView();
    writer.line(
      `\n  ${chalk.dim("Model:")} ${chalk.cyan(modelDisplay)}` +
        `\n  ${chalk.dim("Provider:")} ${providerDisplay}\n`,
    );
    return {};
  });

  registry.register(BUILTIN_COMMANDS["usage:repl"]);
  dispatcher.registerHandler("usage:repl", async () => {
    try {
      const view = await deps.controller.usage();
      renderUsageReport(
        view.budget,
        view.turnCount,
        view.calibrationFactor,
        view.subUsages,
        writer,
      );
    } catch (err) {
      writer.line(
        chalk.red(
          `\n  用量信息不可用: ${err instanceof Error ? err.message : String(err)}\n`,
        ),
      );
    }
    return {};
  });

  registry.register(BUILTIN_COMMANDS["context:repl"]);
  dispatcher.registerHandler("context:repl", async () => {
    try {
      const view = await deps.controller.contextBudget();
      renderContextVisual(view.budget, writer);
    } catch (err) {
      writer.line(
        chalk.red(
          `\n  上下文信息不可用: ${err instanceof Error ? err.message : String(err)}\n`,
        ),
      );
    }
    return {};
  });

  registry.register(BUILTIN_COMMANDS["tasks:repl"]);
  dispatcher.registerHandler("tasks:repl", async () => {
    // 领域应用已经裁决用户可见任务；Surface 只负责展示该投影。
    // 「执行中」是宿主内存瞬态，读投影拿不到，故不显示。
    const tasks = await deps.getScheduler().list();
    if (tasks.length === 0) {
      writer.line(
        chalk.dim(
          '\n  没有定时任务。对话中说"每天早上8点提醒我..."可以创建任务。\n',
        ),
      );
      return {};
    }
    writer.line(
      `\n${chalk.bold("  定时任务")} ${chalk.dim(`(${tasks.length} 个)`)}`,
    );
    for (const task of tasks) {
      const status = task.enabled ? chalk.green("●") : chalk.dim("○");
      const schedule = formatTaskSchedule(task.schedule);
      const lastInfo = task.state.lastRunAt
        ? chalk.dim(
            ` · 上次: ${task.state.lastStatus ?? "?"} ${formatRelativeTime(new Date(task.state.lastRunAt))}`,
          )
        : chalk.dim(" · 未执行过");
      const next = task.state.nextRunAt
        ? chalk.dim(` · 下次: ${new Date(task.state.nextRunAt).toLocaleString()}`)
        : "";
      writer.line(`  ${status} ${task.name} ${chalk.dim(`(${task.id})`)}`);
      writer.line(`    ${schedule}${lastInfo}${next}`);
    }
    writer.line("");
    return {};
  });
}

function formatRecoveryBackupState(status: NonNullable<ServerInfoResult["recoveryBackup"]>): string {
  if (status.state === "recoverable") return "可恢复";
  if (status.state === "pending-verification") return "待验证（运行 zz backup verify）";
  if (status.state === "not-configured") return "未配置（运行 zz backup setup）";
  switch (status.nextAction) {
    case "repair-backup-configuration":
      return "配置需要修复（重新运行 zz backup setup）";
    case "restore-backup-connection":
      return "连接暂不可用（恢复连接后重试）";
    case "check-backup-target":
      return "目标暂不可用（检查备份目标后重试）";
  }
}
