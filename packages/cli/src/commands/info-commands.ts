/**
 * info 域命令注册 —— 只读展示类命令的模块化原子注册（范式同 registerTaskCommands）。
 *
 * 覆盖 /help /status /me /model /usage /context /journal /people /tasks。
 * 运行时信息(上下文预算 / journal / people)的权威在核心宿主——经会话与
 * 管理面 RPC 取;模型 / provider 显示取本地配置(宿主按同一配置装配)。
 * /me 读本地身份画像(纯只读展示,不构造任何记忆域写仓)。
 */

import chalk from "chalk";
import {
  loadProfile,
  getMemoryDir,
  isInternal,
  type SchedulerFacade,
  type ChannelStatus,
  type ICommandRegistry,
  type CommandDispatcher,
  type CommandHandlerContext,
  type CommandDef,
  type CommandCategory,
  type PersonEntry,
} from "@zhixing/core";
import type { ZhixingConfig } from "@zhixing/providers";
import type { ProxyDescription } from "@zhixing/network";
import { renderUsageReport, renderContextVisual } from "../render.js";
import { layout } from "../tui/style.js";
import type { CliWriter } from "../screen/index.js";
import type {
  RpcManagementFacade,
  RuntimeControlWorkItem,
  ServerActiveWork,
  ServerInfoResult,
} from "../runtime/rpc-management-facade.js";
import type { ConversationController } from "../runtime/conversation-controller.js";
import { formatRelativeTime } from "./format.js";
import type { SelectionService, SelectionOption } from "../tui/selection/index.js";
import {
  SelectionBusyError,
  SelectionUnavailableError,
} from "../tui/selection/index.js";

export interface InfoCommandsDeps {
  readonly registry: ICommandRegistry;
  readonly dispatcher: CommandDispatcher;
  readonly writer: CliWriter;
  /** 本地配置——模型 / provider 显示来源;配置热重载后由 getter 读最新快照。 */
  readonly getConfig: () => ZhixingConfig;
  /** 会话控制器——当前对话指针与上下文预算(经宿主)的入口 */
  readonly controller: ConversationController;
  /** 网络代理诊断（/status，display 字段已脱敏）。 */
  readonly getNetworkProxy: () => ProxyDescription;
  /** 调度门面（/tasks 读 scheduler.json 投影，cli 无本地 scheduler）。 */
  readonly getScheduler: () => SchedulerFacade;
  /** 管理面门面(/journal /people 经宿主只读执行体)。 */
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

function countWork(items: readonly RuntimeControlWorkItem[] | undefined): number {
  return (items ?? []).reduce((sum, item) => sum + Math.max(0, item.count), 0);
}

function formatWorkItems(items: readonly RuntimeControlWorkItem[] | undefined): string {
  const list = items ?? [];
  if (list.length === 0) return "无";
  return list.map((item) => `${item.label} x${item.count}`).join("、");
}

function liveChannels(hostInfo: ServerInfoResult | null): ChannelStatus[] {
  const fromSnapshot = hostInfo?.accessSurfaces?.liveChannels;
  if (fromSnapshot) return fromSnapshot;
  return (hostInfo?.channels ?? []).filter(
    (s) => s.state === "connected" || s.state === "connecting",
  );
}

function activeWork(hostInfo: ServerInfoResult | null): ServerActiveWork {
  return (
    hostInfo?.activeWork ?? {
      count: hostInfo?.busyConversations ?? 0,
      cancellableCount: hostInfo?.busyConversations ?? 0,
      drainOnlyCount: 0,
      cancellableWork: [],
      drainOnlyWork: [],
    }
  );
}

function otherRpcConnections(hostInfo: ServerInfoResult | null): number {
  const projected = hostInfo?.accessSurfaces?.otherRpcConnections;
  if (typeof projected === "number") return Math.max(0, projected);
  return Math.max(0, (hostInfo?.connectionCount ?? 1) - 1);
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

type StopChoice = "stop" | "wait" | "cancel-work-stop" | "cancel";

function buildStopBody(hostInfo: ServerInfoResult | null): string[] {
  if (!hostInfo) {
    return ["当前无法读取宿主状态。为避免误停，先取消并稍后重试。"];
  }
  const body: string[] = [];
  const otherRpc = otherRpcConnections(hostInfo);
  const live = liveChannels(hostInfo);
  const work = activeWork(hostInfo);
  const deferredCount = countWork(hostInfo.deferredWork);
  const keepAliveCount = countWork(hostInfo.keepAliveWork);

  if (otherRpc > 0 || live.length > 0) {
    const surfaces = [
      otherRpc > 0 ? `其他终端 ${otherRpc}` : "",
      live.length > 0 ? live.map((s) => s.channelId).join("、") : "",
    ].filter(Boolean);
    body.push(`停止后会断开其他接入面：${surfaces.join("；")}`);
  }
  if (work.count > 0) {
    body.push(
      `当前有运行中的工作：可取消 ${work.cancellableCount}，等待投递 ${work.drainOnlyCount}。`,
    );
  }
  if (deferredCount > 0) {
    body.push(`还有 ${deferredCount} 条未送达消息，会保留并在下次启动后重试。`);
  }
  if (keepAliveCount > 0) {
    body.push(`有 ${keepAliveCount} 个已启用定时任务，停止后不会继续触发。`);
  }
  if (body.length === 0) body.push("当前没有其他接入面或运行中的工作。");
  return body;
}

function buildStopOptions(
  hostInfo: ServerInfoResult | null,
): SelectionOption<StopChoice>[] {
  const work = activeWork(hostInfo);
  if (!hostInfo) {
    return [{ value: "cancel", label: "取消", hotkey: "c", tone: "primary" }];
  }
  if (work.count > 0) {
    const options: SelectionOption<StopChoice>[] = [
      {
        value: "wait",
        label: "等待完成后停止",
        description: "先 flush 可投递消息，再请求宿主退出",
        hotkey: "w",
        tone: "primary",
      },
    ];
    if (work.cancellableCount > 0) {
      options.push({
        value: "cancel-work-stop",
        label: "取消工作并停止",
        description: "中断当前对话/任务后退出宿主",
        hotkey: "x",
        tone: "danger",
      });
    }
    options.push({ value: "cancel", label: "返回", hotkey: "c", tone: "muted" });
    return options;
  }
  return [
    {
      value: "stop",
      label: "停止知行",
      description: "关闭宿主，当前终端也会退出",
      hotkey: "s",
      tone: "danger",
    },
    { value: "cancel", label: "返回", hotkey: "c", tone: "muted" },
  ];
}

function shutdownStrategyForChoice(choice: StopChoice): "immediate" | "drain" | "cancel" {
  if (choice === "wait") return "drain";
  if (choice === "cancel-work-stop") return "cancel";
  return "immediate";
}

export function registerInfoCommands(deps: InfoCommandsDeps): void {
  const { registry, dispatcher, writer } = deps;
  const getModelView = (): { modelDisplay: string; providerDisplay: string } => {
    const config = deps.getConfig();
    return {
      modelDisplay: config.llm?.main?.model ?? "(未配置)",
      providerDisplay: config.llm?.main?.provider ?? "(未配置)",
    };
  };

  // /help —— registry 的消费者：把当前命令集渲染成命令地图，按 ctx 过滤 hidden + visibility。
  registry.register({
    id: "help:repl",
    name: "help",
    description: "显示帮助信息",
    category: "info",
    execution: "local",
    tag: "builtin",
  });
  dispatcher.registerHandler("help:repl", (ctx: CommandHandlerContext) => {
    renderHelpCommands(registry.list(ctx.runtime), writer);
    return {};
  });

  registry.register({
    id: "status:repl",
    name: "status",
    description: "查看当前运行状态",
    category: "info",
    execution: "local",
    tag: "builtin",
  });
  dispatcher.registerHandler("status:repl", async () => {
    // ProxyDescription.display 已脱敏（含凭证 URL 安全显示）+ 区分四态 off / auto+null /
    // auto+url / explicit—— mode=auto+null 时 dim 灰色提示直连，其他状态正常色。
    const proxy = deps.getNetworkProxy();
    const proxyText =
      proxy.resolved === null && proxy.mode === "auto"
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
    writer.line(
      `\n  ${chalk.dim("Session:")} ${current.name}${modeText}` +
        `\n  ${chalk.dim("Model:")} ${chalk.cyan(modelDisplay)}` +
        `\n  ${chalk.dim("Provider:")} ${providerDisplay}` +
        `\n  ${chalk.dim("Network proxy:")} ${proxyText}` +
        `${channelLines}\n`,
    );
    renderRuntimeControlStatus(hostInfo, writer);
    return {};
  });

  registry.register({
    id: "stop:repl",
    name: "stop",
    description: "停止知行",
    category: "tools",
    execution: "local",
    tag: "builtin",
  });
  dispatcher.registerHandler("stop:repl", async () => {
    const selection = deps.selection;
    if (!selection) {
      writer.line(chalk.yellow("\n  当前终端不支持选择交互，未执行停止。\n"));
      return {};
    }

    const hostInfo = await deps.management.serverInfo().catch(() => null);
    try {
      const result = await selection.choose<StopChoice>({
        id: "server-stop",
        title: "停止知行",
        body: buildStopBody(hostInfo),
        options: buildStopOptions(hostInfo),
        initialValue: activeWork(hostInfo).count > 0 ? "wait" : hostInfo ? "stop" : "cancel",
        submitLabel: "确认",
        cancelLabel: "返回",
      });
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

  registry.register({
    id: "me:repl",
    name: "me",
    description: "查看身份画像",
    category: "info",
    execution: "local",
    tag: "builtin",
  });
  dispatcher.registerHandler("me:repl", async () => {
    const profile = await loadProfile();
    if (!profile) {
      const memDir = getMemoryDir();
      writer.line(
        `\n${chalk.dim("  未找到身份画像。")}` +
          `\n${chalk.dim(`  创建 ${memDir}/profile.md 来设置你的身份信息。`)}` +
          `\n\n${chalk.dim("  示例内容：")}` +
          `\n${chalk.dim("  ---")}` +
          `\n${chalk.dim("  name: 你的名字")}` +
          `\n${chalk.dim("  language: zh-CN")}` +
          `\n${chalk.dim("  ---")}` +
          `\n${chalk.dim("  ## 技术栈")}` +
          `\n${chalk.dim("  TypeScript, React, Node.js\n")}`,
      );
      return {};
    }
    writer.line(`\n${chalk.bold("  身份画像")}`);
    writer.line(`  ${chalk.dim("Name:")} ${chalk.cyan(profile.meta.name)}`);
    if (profile.meta.language) {
      writer.line(`  ${chalk.dim("Language:")} ${profile.meta.language}`);
    }
    if (profile.meta.timezone) {
      writer.line(`  ${chalk.dim("Timezone:")} ${profile.meta.timezone}`);
    }
    if (profile.content) {
      writer.line("");
      for (const line of profile.content.split("\n")) {
        writer.line(`  ${line}`);
      }
    }
    writer.line("");
    return {};
  });

  registry.register({
    id: "model:repl",
    name: "model",
    description: "显示当前模型信息",
    category: "info",
    execution: "local",
    tag: "builtin",
  });
  dispatcher.registerHandler("model:repl", () => {
    const { modelDisplay, providerDisplay } = getModelView();
    writer.line(
      `\n  ${chalk.dim("Model:")} ${chalk.cyan(modelDisplay)}` +
        `\n  ${chalk.dim("Provider:")} ${providerDisplay}\n`,
    );
    return {};
  });

  registry.register({
    id: "usage:repl",
    name: "usage",
    description: "查看 token 用量详情",
    category: "info",
    execution: "local",
    tag: "builtin",
  });
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

  registry.register({
    id: "context:repl",
    name: "context",
    description: "上下文容量可视化",
    category: "info",
    execution: "local",
    tag: "builtin",
  });
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

  registry.register({
    id: "journal:repl",
    name: "journal",
    description: "查看日志状态",
    category: "tools",
    execution: "local",
    tag: "builtin",
  });
  dispatcher.registerHandler("journal:repl", async () => {
    const view = (await deps.management.journalStats()) as {
      stats: {
        totalFiles: number;
        hotCount: number;
        warmCount: number;
        condensedCount: number;
      };
      condense: { months: number; files: number } | null;
      expiredCount: number;
    };
    const { stats } = view;

    if (stats.totalFiles === 0) {
      writer.line(
        `\n${chalk.dim("  日志为空。对话中的信息将自动记录到日志中。\n")}`,
      );
      return {};
    }

    writer.line(
      `\n${chalk.bold("  日志状态")} ${chalk.dim(`(${stats.totalFiles} 文件)`)}`,
    );
    writer.line(`  ${chalk.green("●")} 热 (≤30天): ${stats.hotCount}`);
    writer.line(`  ${chalk.yellow("●")} 温 (>30天): ${stats.warmCount}`);
    writer.line(`  ${chalk.blue("●")} 凝练: ${stats.condensedCount}`);

    if (view.expiredCount > 0) {
      writer.line(`  ${chalk.red("●")} 过期待删除: ${view.expiredCount}`);
    }
    if (view.condense) {
      writer.line(
        chalk.dim(
          `\n  💡 ${view.condense.files} 条日志（${view.condense.months} 个月）待凝练，首轮对话后自动执行`,
        ),
      );
    }
    writer.line("");
    return {};
  });

  registry.register({
    id: "people:repl",
    name: "people",
    description: "查看关系网络",
    category: "tools",
    execution: "local",
    tag: "builtin",
  });
  dispatcher.registerHandler("people:repl", async () => {
    const people = (await deps.management.peopleList()) as PersonEntry[];

    if (people.length === 0) {
      writer.line(
        `\n${chalk.dim("  关系网络为空。")}` +
          `\n${chalk.dim('  对话中说"记住小丽是我女朋友"可以添加关系人。\n')}`,
      );
      return {};
    }

    writer.line(
      `\n${chalk.bold("  关系网络")} ${chalk.dim(`(${people.length} 人)`)}`,
    );
    for (const person of people) {
      const relation = chalk.dim(` (${person.meta.relation})`);
      const birthday = person.meta.birthday
        ? chalk.dim(` 🎂 ${person.meta.birthday}`)
        : "";
      writer.line(
        `  ${chalk.cyan("•")} ${person.meta.name}${relation}${birthday}`,
      );
    }
    writer.line("");
    return {};
  });

  registry.register({
    id: "tasks:repl",
    name: "tasks",
    description: "查看定时任务",
    category: "tools",
    execution: "local",
    tag: "builtin",
  });
  dispatcher.registerHandler("tasks:repl", async () => {
    // 读 scheduler.json 从属投影（cli 无本地 scheduler）；只列外部任务。
    // 「执行中」是宿主内存瞬态，读投影拿不到，故不显示。
    const tasks = (await deps.getScheduler().list()).filter(
      (t) => !isInternal(t),
    );
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
