/**
 * info 域命令注册 —— 只读展示类命令的模块化原子注册（范式同 registerTaskCommands）。
 *
 * 覆盖 /help /status /me /model /usage /context /journal /people /tasks。代码模块按
 * "只读展示"语义内聚，与各命令的 `CommandDef.category`（/help 分组字段，沿用现值）正交：
 * journal/people/tasks 的 category 仍是 "tools"，只是注册代码归在 info 模块。
 *
 * deps 注入契约：reload / 模式切换会替换 `session.runtime` 与 `state.conv`，故对它们的
 * 访问一律以 getter 注入、handler 在调用时读取最新值（值捕获会与 getter 分叉）；registry /
 * dispatcher / writer 是稳定单例，直接注入。
 */

import chalk from "chalk";
import {
  loadProfile,
  getMemoryDir,
  JournalStore,
  PeopleStore,
  isInternal,
  type Message,
  type SchedulerFacade,
  type ICommandRegistry,
  type CommandDispatcher,
  type CommandHandlerContext,
  type CommandDef,
  type CommandCategory,
} from "@zhixing/core";
import type { AgentRuntime } from "@zhixing/orchestrator/runtime";
import type { ProxyDescription } from "@zhixing/network";
import { renderUsageReport, renderContextVisual } from "../render.js";
import { parseTaskUsageFromMessages } from "../parse-task-usage.js";
import { layout } from "../tui/style.js";
import type { CliWriter } from "../screen/index.js";
import { formatRelativeTime } from "./format.js";

export interface InfoCommandsDeps {
  readonly registry: ICommandRegistry;
  readonly dispatcher: CommandDispatcher;
  readonly writer: CliWriter;
  /** session.runtime —— reload / 模式切换会 swap，以 getter 注入按调用时读最新实例。 */
  readonly getRuntime: () => AgentRuntime;
  /** 当前对话消息（/status·/usage·/context；对话切换 / turn 会变）。 */
  readonly getMessages: () => readonly Message[];
  /** 当前对话 id（/status）。 */
  readonly getConversationId: () => string | null;
  /** 当前 turn 计数（/model·/usage）。 */
  readonly getTurnCounter: () => number;
  /** 网络代理诊断（/status，display 字段已脱敏）。 */
  readonly getNetworkProxy: () => ProxyDescription;
  /** 调度门面（/tasks 读 scheduler.json 投影，cli 无本地 scheduler）。 */
  readonly getScheduler: () => SchedulerFacade;
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

export function registerInfoCommands(deps: InfoCommandsDeps): void {
  const { registry, dispatcher, writer } = deps;

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
    description: "显示会话状态",
    category: "info",
    execution: "local",
    tag: "builtin",
  });
  dispatcher.registerHandler("status:repl", () => {
    const messages = deps.getMessages();
    const userMsgs = messages.filter((m) => m.role === "user").length;
    const assistantMsgs = messages.filter((m) => m.role === "assistant").length;
    // ProxyDescription.display 已脱敏（含凭证 URL 安全显示）+ 区分四态 off / auto+null /
    // auto+url / explicit—— mode=auto+null 时 dim 灰色提示直连，其他状态正常色。
    const proxy = deps.getNetworkProxy();
    const proxyText =
      proxy.resolved === null && proxy.mode === "auto"
        ? chalk.dim(proxy.display)
        : proxy.display;
    const runtime = deps.getRuntime();
    writer.line(
      `\n  ${chalk.dim("Session:")} ${deps.getConversationId() ?? "(未保存)"}` +
        `\n  ${chalk.dim("Messages:")} ${messages.length} (${userMsgs} user, ${assistantMsgs} assistant)` +
        `\n  ${chalk.dim("Model:")} ${chalk.cyan(runtime.model)}` +
        `\n  ${chalk.dim("Provider:")} ${runtime.providerId}` +
        `\n  ${chalk.dim("Network proxy:")} ${proxyText}\n`,
    );
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
    const runtime = deps.getRuntime();
    writer.line(
      `\n  ${chalk.dim("Model:")} ${chalk.cyan(runtime.model)}` +
        `\n  ${chalk.dim("Provider:")} ${runtime.providerId}` +
        `\n  ${chalk.dim("Turns:")} ${deps.getTurnCounter()}\n`,
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
  dispatcher.registerHandler("usage:repl", () => {
    const runtime = deps.getRuntime();
    const messages = deps.getMessages();
    const budget = runtime.checkBudget(messages);
    // 解析 transcript 中所有 Task 工具的 <usage> trailer —— 没有 Task 调用时
    // parseTaskUsageFromMessages 返回空数组，renderUsageReport 自动跳过子段。
    const subUsages = parseTaskUsageFromMessages(messages);
    renderUsageReport(
      budget,
      deps.getTurnCounter(),
      runtime.calibrationFactor,
      subUsages,
      writer,
    );
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
  dispatcher.registerHandler("context:repl", () => {
    const budget = deps.getRuntime().checkBudget(deps.getMessages());
    renderContextVisual(budget, writer);
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
    const jStore = new JournalStore();
    const plan = await jStore.scan();
    const { stats, condensePlan, expiredFiles } = plan;

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

    if (expiredFiles.length > 0) {
      writer.line(`  ${chalk.red("●")} 过期待删除: ${expiredFiles.length}`);
    }
    if (condensePlan) {
      const monthCount = condensePlan.months.length;
      const fileCount = condensePlan.months.reduce(
        (sum: number, m: { files: string[] }) => sum + m.files.length,
        0,
      );
      writer.line(
        chalk.dim(
          `\n  💡 ${fileCount} 条日志（${monthCount} 个月）待凝练，首轮对话后自动执行`,
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
    const store = new PeopleStore();
    const people = await store.listAll();

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
