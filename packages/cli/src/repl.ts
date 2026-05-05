/**
 * REPL 交互模式
 *
 * 基于 Node.js readline/promises 的多轮对话循环。
 *
 * 流程：
 * 1. 初始化 TranscriptStore → 创建或恢复会话
 * 2. readline.question() 获取用户输入
 * 3. 如果是斜杠命令，就地处理
 * 4. 否则追加到对话历史，启动 spinner，运行 Agent Loop
 * 5. Turn 完成后持久化到 JSONL
 * 6. 回到步骤 2
 */

import * as readline from "node:readline/promises";
import path from "node:path";
import chalk from "chalk";
import {
  userMessage,
  type Message,
  TranscriptStore,
  getProjectId,
  getZhixingHome,
  ConversationRepository,
  type Conversation,
  type ConversationScope,
  loadProfile,
  getMemoryDir,
  SkillsStore,
  PeopleStore,
  JournalStore,
  inferEffectiveness,
  applyEffectivenessUpdates,
  CommandProvider,
  FileProvider,
  ArgumentProvider,
  DefaultCommandRegistry,
  DefaultTypeaheadBroker,
  UsageTracker,
  type CommandHandlerContext,
  type RuntimeContext,
  type ArgChoiceProvider,
  type ArgQueryContext,
  type ArgChoice,
  type ArgSchema,
  Scheduler,
  createEventBus,
  type SchedulerEventMap,
} from "@zhixing/core";
import { describeProxy, type ProxyDescription } from "@zhixing/network";
import { loadConfig, loadCredentials, resolveHomeDir } from "@zhixing/providers";
import { CommandDispatcher } from "./command-dispatcher.js";
import { readInputLine, type InputLineResult } from "./typeahead-input.js";
import { resolveFileRefs } from "./resolve-file-refs.js";
import {
  type AgentRuntime,
  type RunResult,
} from "@zhixing/orchestrator/runtime";
import {
  createRenderer,
  renderSummary,
  renderError,
  renderUsageReport,
  renderContextVisual,
  type Renderer,
} from "./render.js";
import { renderHomeWelcome, renderStartupAdvisories } from "./workbench/index.js";
import { RuntimeSession } from "./runtime/session.js";
import { handleConfigCommand } from "./runtime/config-command.js";
import { parseTaskUsageFromMessages } from "./parse-task-usage.js";
import {
  handleTrustCommand,
  handleSecurityCommand,
  renderBlockedMessage,
  renderUserDeniedMessage,
  TerminalConfirmationRenderer,
} from "./security/index.js";
import { createReplInterruptRuntime } from "./interrupt/repl-runtime.js";

// ─── REPL 状态 ───

interface ReplState {
  messages: Message[];
  agent: AgentRuntime;
  running: boolean;
  /** 持久化 */
  store: TranscriptStore;
  convRepo: ConversationRepository;
  conversationId: string | null;
  turnCounter: number;
  /** 上一轮的工具调用完成数（用于反思触发） */
  lastToolEndCount: number;
  /** 本会话是否已提议过技能（每会话最多 1 次） */
  hasProposedSkill: boolean;
  /** 是否已执行过 Journal 自动凝练 */
  journalCondenseDone: boolean;
  /** Scheduler 实例（S1: CLI 进程内运行） */
  scheduler: Scheduler | null;
  /**
   * 启动时计算的代理诊断（mode + resolved + display 三元组）。用于 /status
   * 展示——区分 off / auto+null / auto+url / explicit 四态，display 字段
   * 永远脱敏（凭证不会泄露到终端 / 日志录屏）。
   */
  networkProxy: ProxyDescription;
  /**
   * 当前 in-flight turn promise——turn idle 时为 null。
   *
   * RuntimeSession.reload 流程在 swap 之前必须 await 此 promise，避免在 turn
   * 跑中替换 agentRuntime 导致状态错乱。turn 启动时设置、完成（resolve / reject）
   * 时由 finally 块清空。
   */
  activeTurnPromise: Promise<RunResult> | null;
}

// ─── 会话恢复选项 ───

export interface ReplOptions {
  model?: string;
  provider?: string;
  workspace?: string;
  continue?: boolean;
  resume?: string | true;
  name?: string;
}

// ─── 斜杠命令 ───

function buildSlashCommands(
  rl: readline.Interface,
  session: RuntimeSession,
  renderer: Renderer,
): Record<
  string,
  {
    description: string;
    handler: (state: ReplState, args: string) => Promise<void> | void;
  }
> {
  return {
    "/help": {
      description: "显示帮助信息",
      handler: (_state) => {
        const commands = buildSlashCommands(rl, session, renderer);
        console.log(`\n${chalk.bold("可用命令：")}`);
        for (const [cmd, { description }] of Object.entries(commands)) {
          console.log(
            `  ${chalk.cyan(cmd.padEnd(14))} ${chalk.dim(description)}`,
          );
        }
        console.log();
      },
    },
    "/clear": {
      description: "清空对话历史",
      handler: (state) => {
        state.messages = [];
        state.turnCounter = 0;
        console.log(chalk.dim("对话历史已清空\n"));
      },
    },
    "/model": {
      description: "显示当前模型信息",
      handler: (state) => {
        console.log(
          `\n  ${chalk.dim("Model:")} ${chalk.cyan(state.agent.model)}` +
            `\n  ${chalk.dim("Provider:")} ${state.agent.providerId}` +
            `\n  ${chalk.dim("Turns:")} ${state.turnCounter}\n`,
        );
      },
    },
    "/status": {
      description: "显示会话状态",
      handler: (state) => {
        const userMsgs = state.messages.filter(
          (m) => m.role === "user",
        ).length;
        const assistantMsgs = state.messages.filter(
          (m) => m.role === "assistant",
        ).length;
        // ProxyDescription.display 已脱敏（含凭证 URL 安全显示）+ 区分四态
        // off / auto+null / auto+url / explicit—— mode=auto+null 时 dim 灰色
        // 提示直连，其他状态正常色
        const proxyText =
          state.networkProxy.resolved === null && state.networkProxy.mode === "auto"
            ? chalk.dim(state.networkProxy.display)
            : state.networkProxy.display;
        console.log(
          `\n  ${chalk.dim("Session:")} ${state.conversationId ?? "(未保存)"}` +
            `\n  ${chalk.dim("Messages:")} ${state.messages.length} (${userMsgs} user, ${assistantMsgs} assistant)` +
            `\n  ${chalk.dim("Model:")} ${chalk.cyan(state.agent.model)}` +
            `\n  ${chalk.dim("Provider:")} ${state.agent.providerId}` +
            `\n  ${chalk.dim("Network proxy:")} ${proxyText}\n`,
        );
      },
    },
    "/conversations": {
      description: "列出当前项目的对话",
      handler: async (state) => {
        const conversations = await state.convRepo.list();
        if (conversations.length === 0) {
          console.log(chalk.dim("\n  没有保存的对话\n"));
          return;
        }
        console.log(`\n${chalk.bold("  保存的对话：")}`);
        for (const c of conversations.slice(0, 15)) {
          const label = c.name ? chalk.white(c.name) : chalk.dim("(未命名)");
          const time = formatRelativeTime(new Date(c.lastActiveAt));
          const turnCount = await state.store.countTurns(c.id);
          const current =
            c.id === state.conversationId ? chalk.green(" ← 当前") : "";
          console.log(
            `  ${chalk.cyan(c.id)} ${label} ${chalk.dim(`(${time}, ${turnCount} 轮)`)}${current}`,
          );
        }
        console.log();
      },
    },
    "/new": {
      description: "创建新对话",
      handler: async (state, args) => {
        const name = args.trim() || undefined;
        try {
          const conversation = await state.convRepo.create({
            name,
            preferredModel: state.agent.model,
            preferredProvider: state.agent.providerId,
          });
          await state.store.init(conversation.id, {
            model: state.agent.model,
            provider: state.agent.providerId,
          });
          state.messages = [];
          state.conversationId = conversation.id;
          state.turnCounter = 0;
          state.lastToolEndCount = 0;
          state.convRepo.touch(state.conversationId).catch(() => {});
          console.log(
            chalk.dim(`\n  已创建新对话 ${chalk.cyan(conversation.name)}\n`),
          );
        } catch (err) {
          console.log(
            chalk.red(
              `\n  创建对话失败: ${err instanceof Error ? err.message : String(err)}\n`,
            ),
          );
        }
      },
    },
    "/switch": {
      description: "切换到其他对话",
      handler: async (state, args) => {
        const input = args.trim();
        if (!input) {
          const conversations = await state.convRepo.list();
          if (conversations.length === 0) {
            console.log(chalk.dim("\n  没有可切换的对话\n"));
            return;
          }
          console.log(`\n${chalk.bold("  可用对话：")}`);
          for (let i = 0; i < Math.min(conversations.length, 15); i++) {
            const c = conversations[i]!;
            const label = c.name ? chalk.white(c.name) : chalk.dim("(未命名)");
            const time = formatRelativeTime(new Date(c.lastActiveAt));
            const turnCount = await state.store.countTurns(c.id);
            const current =
              c.id === state.conversationId ? chalk.green(" ← 当前") : "";
            console.log(
              `  ${chalk.yellow(`[${i + 1}]`)} ${label} ${chalk.dim(`(${time}, ${turnCount} 轮)`)}${current}`,
            );
          }
          console.log(chalk.dim(`\n  使用 /switch <序号> 或 /switch <名称> 切换\n`));
          return;
        }
        if (input === state.conversationId) {
          console.log(chalk.dim("\n  已在当前对话中\n"));
          return;
        }

        const conversations = await state.convRepo.list();

        // 按序号选择
        const num = Number(input);
        let target: { id: string; name: string } | null = null;
        if (Number.isInteger(num) && num >= 1 && num <= conversations.length) {
          const c = conversations[num - 1]!;
          target = { id: c.id, name: c.name };
        }

        // 按 ID 精确匹配
        if (!target) {
          const conv = await state.convRepo.get(input);
          if (conv) target = { id: conv.id, name: conv.name };
        }

        // 按名称模糊匹配
        if (!target) {
          const lowerInput = input.toLowerCase();
          const matches = conversations.filter(
            (c) => c.name.toLowerCase().includes(lowerInput),
          );
          if (matches.length === 1) {
            target = { id: matches[0]!.id, name: matches[0]!.name };
          } else if (matches.length > 1) {
            console.log(`\n${chalk.bold("  多个匹配：")}`);
            for (let i = 0; i < Math.min(matches.length, 10); i++) {
              const c = matches[i]!;
              const time = formatRelativeTime(new Date(c.lastActiveAt));
              console.log(
                `  ${chalk.yellow(`[${i + 1}]`)} ${chalk.white(c.name)} ${chalk.dim(`(${time})`)}`,
              );
            }
            console.log(chalk.dim(`\n  请使用更精确的名称或 /switch <序号>\n`));
            return;
          }
        }

        if (!target) {
          console.log(chalk.red(`\n  对话 "${input}" 不存在\n`));
          return;
        }
        if (target.id === state.conversationId) {
          console.log(chalk.dim("\n  已在当前对话中\n"));
          return;
        }

        try {
          const loaded = await state.store.load(target.id);
          state.messages = loaded.messages;
          state.conversationId = target.id;
          state.turnCounter = loaded.turnCount;
          state.lastToolEndCount = 0;
          state.convRepo.touch(state.conversationId).catch(() => {});
          console.log(
            chalk.dim(
              `\n  已切换到 ${chalk.cyan(target.name)}（${loaded.turnCount} 轮对话）\n`,
            ),
          );
        } catch (err) {
          console.log(
            chalk.red(
              `\n  加载对话失败: ${err instanceof Error ? err.message : String(err)}\n`,
            ),
          );
        }
      },
    },
    "/name": {
      description: "为当前会话命名",
      handler: async (state, args) => {
        if (!args.trim()) {
          console.log(chalk.yellow("用法: /name <名称>\n"));
          return;
        }
        if (!state.conversationId) {
          console.log(chalk.yellow("当前会话尚未保存\n"));
          return;
        }
        await state.convRepo.rename(state.conversationId, args.trim());
        console.log(chalk.dim(`会话已命名为: ${args.trim()}\n`));
      },
    },
    "/me": {
      description: "查看身份画像",
      handler: async () => {
        const profile = await loadProfile();
        if (!profile) {
          const memDir = getMemoryDir();
          console.log(
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
          return;
        }
        console.log(`\n${chalk.bold("  身份画像")}`);
        console.log(`  ${chalk.dim("Name:")} ${chalk.cyan(profile.meta.name)}`);
        if (profile.meta.language) {
          console.log(`  ${chalk.dim("Language:")} ${profile.meta.language}`);
        }
        if (profile.meta.timezone) {
          console.log(`  ${chalk.dim("Timezone:")} ${profile.meta.timezone}`);
        }
        if (profile.content) {
          console.log();
          for (const line of profile.content.split("\n")) {
            console.log(`  ${line}`);
          }
        }
        console.log();
      },
    },
    "/skills": {
      description: "查看技能库 (audit: 健康审查, archive/restore/delete <id>)",
      handler: async (_state, args) => {
        const store = new SkillsStore();
        const subcommand = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
        const subArgs = args.trim().split(/\s+/).slice(1).join(" ");

        if (subcommand === "audit") {
          await renderSkillsAudit(store);
          return;
        }

        if (subcommand === "archive" && subArgs) {
          const ok = await store.archive(subArgs);
          console.log(ok
            ? chalk.green(`\n  ✓ 已归档: ${subArgs}\n`)
            : chalk.red(`\n  ✗ 未找到: ${subArgs}\n`));
          return;
        }

        if (subcommand === "restore" && subArgs) {
          const ok = await store.restore(subArgs);
          console.log(ok
            ? chalk.green(`\n  ✓ 已恢复: ${subArgs}\n`)
            : chalk.red(`\n  ✗ 未找到归档: ${subArgs}\n`));
          return;
        }

        if (subcommand === "delete" && subArgs) {
          const ok = await store.delete(subArgs);
          console.log(ok
            ? chalk.green(`\n  ✓ 已删除: ${subArgs}\n`)
            : chalk.red(`\n  ✗ 未找到: ${subArgs}\n`));
          return;
        }

        // 默认：列出所有技能
        const skills = await store.listAll();

        if (skills.length === 0) {
          console.log(
            `\n${chalk.dim("  技能库为空。")}` +
              `\n${chalk.dim('  对话中说"存为技能"可以保存方法论。\n')}`,
          );
          return;
        }

        console.log(`\n${chalk.bold("  技能库")} ${chalk.dim(`(${skills.length} 个)`)}`);
        for (const skill of skills) {
          const status = store.getStatus(skill);
          const statusBadge = status === "active"
            ? chalk.green("●")
            : status === "stale"
              ? chalk.yellow("○")
              : chalk.dim("◌");
          const tags = skill.meta.tags.length > 0
            ? chalk.dim(` [${skill.meta.tags.join(", ")}]`)
            : "";
          const usage = chalk.dim(` (v${skill.meta.version} · ${skill.meta.useCount}次)`);
          console.log(
            `  ${statusBadge} ${skill.meta.title}${tags}${usage}`,
          );
        }
        console.log(chalk.dim("\n  提示: /skills audit 查看健康报告\n"));
      },
    },
    "/journal": {
      description: "查看日志状态",
      handler: async () => {
        const jStore = new JournalStore();
        const plan = await jStore.scan();
        const { stats, condensePlan, expiredFiles } = plan;

        if (stats.totalFiles === 0) {
          console.log(
            `\n${chalk.dim("  日志为空。对话中的信息将自动记录到日志中。\n")}`,
          );
          return;
        }

        console.log(`\n${chalk.bold("  日志状态")} ${chalk.dim(`(${stats.totalFiles} 文件)`)}`);
        console.log(`  ${chalk.green("●")} 热 (≤30天): ${stats.hotCount}`);
        console.log(`  ${chalk.yellow("●")} 温 (>30天): ${stats.warmCount}`);
        console.log(`  ${chalk.blue("●")} 凝练: ${stats.condensedCount}`);

        if (expiredFiles.length > 0) {
          console.log(`  ${chalk.red("●")} 过期待删除: ${expiredFiles.length}`);
        }
        if (condensePlan) {
          const monthCount = condensePlan.months.length;
          const fileCount = condensePlan.months.reduce((sum: number, m: { files: string[] }) => sum + m.files.length, 0);
          console.log(
            chalk.dim(`\n  💡 ${fileCount} 条日志（${monthCount} 个月）待凝练，首轮对话后自动执行`),
          );
        }
        console.log();
      },
    },
    "/people": {
      description: "查看关系网络",
      handler: async () => {
        const store = new PeopleStore();
        const people = await store.listAll();

        if (people.length === 0) {
          console.log(
            `\n${chalk.dim("  关系网络为空。")}` +
              `\n${chalk.dim('  对话中说"记住小丽是我女朋友"可以添加关系人。\n')}`,
          );
          return;
        }

        console.log(`\n${chalk.bold("  关系网络")} ${chalk.dim(`(${people.length} 人)`)}`);
        for (const person of people) {
          const relation = chalk.dim(` (${person.meta.relation})`);
          const birthday = person.meta.birthday ? chalk.dim(` 🎂 ${person.meta.birthday}`) : "";
          console.log(
            `  ${chalk.cyan("•")} ${person.meta.name}${relation}${birthday}`,
          );
        }
        console.log();
      },
    },
    "/usage": {
      description: "查看 token 用量详情",
      handler: (state) => {
        const budget = state.agent.checkBudget(state.messages);
        // 解析 transcript 中所有 Task 工具的 <usage> trailer —— 没有 Task 调用时
        // parseTaskUsageFromMessages 返回空数组,renderUsageReport 自动跳过子段
        const subUsages = parseTaskUsageFromMessages(state.messages);
        renderUsageReport(
          budget,
          state.turnCounter,
          state.agent.calibrationFactor,
          subUsages,
        );
      },
    },
    "/context": {
      description: "上下文容量可视化",
      handler: (state) => {
        const budget = state.agent.checkBudget(state.messages);
        renderContextVisual(budget);
      },
    },
    "/compact": {
      description: "手动触发上下文压缩",
      handler: async (state) => {
        if (state.messages.length < 4) {
          console.log(chalk.dim("\n  对话历史过短，无需压缩\n"));
          return;
        }
        console.log(chalk.yellow("\n  ⟳ 正在压缩上下文..."));
        try {
          const result = await state.agent.forceCompact(
            [...state.messages],
            state.turnCounter,
          );
          if (result.modified) {
            const pct = Math.round(result.budget.usageRatio * 100);
            console.log(chalk.green(`  ✓ 压缩完成，当前上下文占用 ${pct}%\n`));
            // 走 commitTurn({compactBefore}) 统一持久化入口：
            //   - 仅在事务产生真 summary 时写 marker（避免 "(manual compact)" 假摘要）
            //   - commitTurn 内部原子重写：header + compactBefore + retained turns
            //   - 返回 canonical → state.messages 整体替换，内存与磁盘严格一致
            //   - 无会话 ID 或无真 summary 时降级为纯内存更新（不持久化）
            if (state.conversationId && result.compactBefore) {
              try {
                state.messages = await state.store.commitTurn(state.conversationId, {
                  compactBefore: result.compactBefore,
                });
              } catch (err) {
                // 持久化失败：降级用 forceCompact 返回的内存版 messages
                state.messages = result.messages;
                console.log(
                  chalk.dim(
                    `  [持久化警告] ${err instanceof Error ? err.message : String(err)}`,
                  ),
                );
              }
            } else {
              // 无真 summary（非摘要型策略）或无会话 ID → 仅更新内存
              state.messages = result.messages;
            }
          } else {
            console.log(chalk.dim("  已无可压缩内容\n"));
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(chalk.red(`  ✗ 压缩失败: ${msg}\n`));
        }
      },
    },
    "/trust": {
      description: "权限规则管理 (list/revoke/reset)",
      handler: async (state, args) => {
        await handleTrustCommand(args, {
          pipeline: state.agent.securityPipeline,
          rl,
        });
      },
    },
    "/security": {
      description: "安全状态概览 (rules: 列出策略规则)",
      handler: (state, args) => {
        handleSecurityCommand(args, state.agent.securityPipeline);
      },
    },
    "/tasks": {
      description: "查看定时任务",
      handler: (state) => {
        if (!state.scheduler) {
          console.log(chalk.dim("\n  调度器未初始化\n"));
          return;
        }
        const tasks = state.scheduler.listTasks();
        if (tasks.length === 0) {
          console.log(chalk.dim("\n  没有定时任务。对话中说\"每天早上8点提醒我...\"可以创建任务。\n"));
          return;
        }
        console.log(`\n${chalk.bold("  定时任务")} ${chalk.dim(`(${tasks.length} 个, ${state.scheduler.activeTaskCount} 个执行中)`)}`);
        for (const task of tasks) {
          const status = task.enabled ? chalk.green("●") : chalk.dim("○");
          const schedule = formatTaskSchedule(task.schedule);
          const lastInfo = task.state.lastRunAt
            ? chalk.dim(` · 上次: ${task.state.lastStatus ?? "?"} ${formatRelativeTime(new Date(task.state.lastRunAt))}`)
            : chalk.dim(" · 未执行过");
          const next = task.state.nextRunAt
            ? chalk.dim(` · 下次: ${new Date(task.state.nextRunAt).toLocaleString()}`)
            : "";
          console.log(`  ${status} ${task.name} ${chalk.dim(`(${task.id})`)}`);
          console.log(`    ${schedule}${lastInfo}${next}`);
        }
        console.log();
      },
    },
    "/exit": {
      description: "退出",
      handler: async () => {
        // 走 rl.close() 让 close 监听器统一执行完整 cleanup
        // (scheduler / deliveryStack / channels / renderer / confirmation)
        rl.close();
      },
    },
    "/config": {
      description: "修改基础配置（服务商 / 模型 / API Key / 消息通道等）",
      handler: async (state) => {
        await handleConfigCommand({ rl, state, session, renderer });
      },
    },
  };
}

// ─── 启动 REPL ───

export async function startRepl(options: ReplOptions): Promise<void> {
  // renderer 借给 RuntimeSession——session 内部装配 agent 时通过 closure 注入，
  // 让 retry / compact / interrupt 渲染前能驱动 spinner.stop() 避免动画覆盖事件
  const renderer = createRenderer();

  // schedulerEventBus 由调用方持有——稳定的"事件集线器"，跨 reload 持久。
  // REPL 在后续订阅 task-completed 等事件；session 内部即使重建 scheduler，
  // 新 scheduler 仍发送到同一 eventBus，外部 listener 不丢
  const schedulerEventBus = createEventBus<SchedulerEventMap>();

  const zhixingHome = getZhixingHome();
  const config = loadConfig({ cwd: process.cwd() });
  const credentials = loadCredentials({ homeDir: resolveHomeDir() });

  const session = await RuntimeSession.create({
    config,
    credentials,
    cliWorkspace: options.workspace,
    cliModel: options.model,
    cliProvider: options.provider,
    renderer,
    zhixingHome,
    schedulerEventBus,
    onSecurityBlocked: renderBlockedMessage,
    onUserDenied: renderUserDeniedMessage,
  });

  const cwd = process.cwd();
  const projectId = getProjectId(cwd);
  const scope: ConversationScope = { kind: "project", projectId, projectPath: cwd };
  const convRepo = new ConversationRepository(scope);
  const convDir = path.join(zhixingHome, "projects", projectId, "conversations");
  const store = new TranscriptStore(convDir, cwd);

  let messages: Message[] = [];
  let conversationId: string | null = null;
  let turnCounter = 0;
  // 当前 REPL 接续的对话名称——三个恢复入口（显式 ID / interactive picker /
  // 默认最近）共同写入此变量，最终喂给 welcome chrome 内的锚 row2 inline 渲染，
  // 替代分散在三处的 console.log("已恢复对话...") 噪音。新会话保持 null →
  // 锚 row2 退化为仅 glyph。
  let resumedConversationName: string | null = null;

  if (options.resume !== undefined) {
    if (typeof options.resume === "string") {
      const conv = await convRepo.get(options.resume);
      if (!conv) {
        console.log(chalk.red(`\n  对话 "${options.resume}" 不存在\n`));
        return;
      }
      try {
        const loaded = await store.load(options.resume);
        messages = loaded.messages;
        conversationId = options.resume;
        turnCounter = loaded.turnCount;
        resumedConversationName = conv.name;
      } catch (err) {
        console.log(
          chalk.red(
            `\n  无法恢复对话 ${options.resume}: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        return;
      }
    } else {
      const picked = await interactiveConversationPicker(convRepo);
      if (picked) {
        conversationId = picked.id;
        const loaded = await store.load(picked.id);
        messages = loaded.messages;
        turnCounter = loaded.turnCount;
        resumedConversationName = picked.name;
      }
    }
  } else {
    const latest = await convRepo.findLatest();
    if (latest) {
      try {
        const loaded = await store.load(latest);
        messages = loaded.messages;
        conversationId = latest;
        turnCounter = loaded.turnCount;
        const conv = await convRepo.get(latest);
        resumedConversationName = conv?.name ?? latest;
      } catch {
        // transcript 加载失败 → 降级到创建新对话
      }
    }
  }

  // 新会话：先创建 Conversation（meta.json），再创建 Transcript（transcript.jsonl）
  if (!conversationId) {
    const conversation = await convRepo.create({
      name: options.name,
      preferredModel: session.runtime.model,
      preferredProvider: session.runtime.providerId,
    });
    await store.init(conversation.id, {
      model: session.runtime.model,
      provider: session.runtime.providerId,
    });
    conversationId = conversation.id;
  }

  // 启动告警先于 chrome——异常状态需立即吸引注意；无告警时返回空数组，
  // 视觉序列退化为"shell prompt → chrome"无空行干扰
  const advisoryLines = renderStartupAdvisories({
    workspaceDirStatus: session.runtime.workspaceDirStatus,
    workspacePath: session.runtime.resolvedWorkspace.path,
    workspaceSource: session.runtime.resolvedWorkspace.source,
  });
  for (const line of advisoryLines) console.log(line);
  if (advisoryLines.length > 0) console.log();

  for (const line of renderHomeWelcome({
    providerId: session.runtime.providerId,
    model: session.runtime.model,
    workspaceRoot: session.runtime.resolvedWorkspace.path ?? undefined,
    resumedConversationName: resumedConversationName ?? undefined,
  })) {
    console.log(line);
  }
  console.log();

  // 启动时检测 stale 技能，温和提醒
  await checkStaleSkills();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  // 挂载终端确认渲染器到会话 broker。
  //
  // 共存 rl：selectWithInput 会进入 stdin raw mode 并独占 keypress 事件，
  // 与 readline 的行缓冲冲突。通过 beforeShow/afterShow 两个 hook，渲染器
  // 在显示面板前 pause rl（停止消费 stdin），结束后 resume rl（恢复主循环）。
  //
  // 渲染器生命周期绑到 REPL 退出：rl.on("close") 里 detach。
  const confirmationRenderer = new TerminalConfirmationRenderer({
    beforeShow: () => {
      renderer.stop(); // 暂停 spinner，避免动画覆盖面板
      rl.pause();
    },
    afterShow: () => {
      rl.resume();
    },
  });
  // session 持有 renderer 与 broker 的绑定，dispose 时自动 detach
  session.attachConfirmationRenderer(confirmationRenderer);

  const state: ReplState = {
    messages,
    agent: session.runtime,
    running: false,
    store,
    convRepo,
    conversationId,
    turnCounter,
    lastToolEndCount: 0,
    hasProposedSkill: false,
    journalCondenseDone: false,
    scheduler: session.scheduler,
    networkProxy: describeProxy(config.network?.proxy),
    activeTurnPromise: null,
  };

  const slashCommands = buildSlashCommands(rl, session, renderer);

  // ── Typeahead 路径接入（Phase 1 Step 5） ──
  //
  // Feature flag：`ZHIXING_INPUT_TYPEAHEAD`。默认 "on"；显式 "legacy" 回退到
  // `rl.question` 的行编辑路径。
  //
  // 单源真相设计（v2，2026-04-16）：不再调 `registerBuiltinCommands` 注册
  // 设计层面的 builtin 集合，而是**从 legacy `slashCommands` 派生** typeahead
  // registry —— 有什么 legacy 命令，panel 里就显示什么，零幽灵命令。
  //
  // 所有命令 execution = "local"：
  //   1. 不把 info 查询泄露给 agent loop（否则 agent 会瞎编 "Claude 3.5 Sonnet"
  //      这类幻觉，因为它不知道真正的 runtime 状态）
  //   2. 不产生多余的 agent turn 和 token 消耗
  //   3. `/new` 清历史后 agent 自然从空白开始，不需要 system message 提醒
  const typeaheadMode = (process.env.ZHIXING_INPUT_TYPEAHEAD ?? "on").toLowerCase();
  const useTypeahead = typeaheadMode !== "legacy" && typeaheadMode !== "off";

  let typeaheadBroker: DefaultTypeaheadBroker | null = null;
  let typeaheadDispatcher: CommandDispatcher | null = null;
  if (useTypeahead) {
    const tRegistry = new DefaultCommandRegistry();
    const usageTracker = new UsageTracker({ rootDir: null });
    typeaheadBroker = new DefaultTypeaheadBroker({
      now: () => Date.now(),
    });
    typeaheadBroker.register(
      new CommandProvider({ registry: tRegistry, usageTracker }),
    );
    typeaheadBroker.register(
      new ArgumentProvider({ registry: tRegistry }),
    );
    typeaheadBroker.register(
      new FileProvider({
        root: session.runtime.resolvedWorkspace.path ?? process.cwd(),
      }),
    );
    typeaheadDispatcher = new CommandDispatcher({ registry: tRegistry });

    // ── ConversationArgProvider: /switch 的 async-enum 参数补全 ──
    //
    // 实现 ArgChoiceProvider 接口，查询 convRepo.list() 生成对话候选。
    // 通过闭包捕获 state（convRepo + store），无需额外依赖注入。
    const conversationArgProvider: ArgChoiceProvider = {
      async list(
        ctx: ArgQueryContext,
        signal: AbortSignal,
      ): Promise<readonly ArgChoice[]> {
        const conversations = await state.convRepo.list();
        if (signal.aborted) return [];

        const query = ctx.query.toLowerCase();
        const choices: ArgChoice[] = [];
        for (const c of conversations.slice(0, 15)) {
          if (query && !c.name.toLowerCase().includes(query) && !c.id.toLowerCase().includes(query)) {
            continue;
          }
          const time = formatRelativeTime(new Date(c.lastActiveAt));
          const turnCount = await state.store.countTurns(c.id);
          const current = c.id === state.conversationId ? " ← 当前" : "";
          choices.push({
            value: c.id,
            label: c.name || c.id,
            description: `${time}, ${turnCount} 轮${current}`,
          });
        }
        return choices;
      },
    };

    const switchArgSchema: ArgSchema = {
      kind: "async-enum",
      name: "conversation",
      description: "目标对话名称或 ID",
      required: true,
      provider: conversationArgProvider,
    };

    // ── REPL 命令目录：typeahead panel 的单源真相 ──
    //
    // 每一条对应一个 legacy `slashCommands` 的 key，跑 local execution，
    // handler 就是 legacy 闭包的原样包装。新增命令只需要在这里加一行。
    const REPL_COMMANDS: ReadonlyArray<{
      readonly name: string;
      readonly aliases?: readonly string[];
      readonly description: string;
      readonly category: "session" | "info" | "tools" | "config";
      readonly legacyKey: string;
      readonly args?: readonly ArgSchema[];
      readonly hidden?: boolean;
    }> = [
      // ─ session ─
      { name: "new", description: "创建新对话", category: "session", legacyKey: "/new" },
      { name: "clear", description: "清空对话历史", category: "session", legacyKey: "/clear" },
      { name: "conversations", aliases: ["sessions"], description: "列出当前项目的对话", category: "session", legacyKey: "/conversations", hidden: true },
      { name: "switch", description: "切换到其他对话", category: "session", legacyKey: "/switch", args: [switchArgSchema] },
      { name: "name", description: "为当前会话命名", category: "session", legacyKey: "/name" },
      { name: "exit", aliases: ["quit"], description: "退出知行", category: "session", legacyKey: "/exit" },
      // ─ info ─
      { name: "help", description: "显示帮助信息", category: "info", legacyKey: "/help" },
      { name: "status", description: "显示会话状态", category: "info", legacyKey: "/status" },
      { name: "me", description: "查看身份画像", category: "info", legacyKey: "/me" },
      { name: "model", description: "显示当前模型信息", category: "info", legacyKey: "/model" },
      { name: "usage", description: "查看 token 用量详情", category: "info", legacyKey: "/usage" },
      { name: "context", description: "上下文容量可视化", category: "info", legacyKey: "/context" },
      // ─ tools ─
      { name: "skills", description: "查看技能库", category: "tools", legacyKey: "/skills" },
      { name: "journal", description: "查看日志状态", category: "tools", legacyKey: "/journal" },
      { name: "people", description: "查看关系网络", category: "tools", legacyKey: "/people" },
      { name: "compact", description: "手动触发上下文压缩", category: "tools", legacyKey: "/compact" },
      { name: "tasks", description: "查看定时任务", category: "tools", legacyKey: "/tasks" },
      // ─ config ─
      { name: "config", description: "修改基础配置（服务商 / 模型 / API Key / 消息通道等）", category: "config", legacyKey: "/config" },
      { name: "trust", description: "权限规则管理", category: "config", legacyKey: "/trust" },
      { name: "security", description: "安全状态概览", category: "config", legacyKey: "/security" },
    ];

    for (const cmd of REPL_COMMANDS) {
      const legacy = slashCommands[cmd.legacyKey];
      if (!legacy) continue; // 防御式跳过，防止 legacyKey 和 slashCommands 不一致
      const id = `${cmd.name}:repl`;
      tRegistry.register({
        id,
        name: cmd.name,
        aliases: cmd.aliases ? [...cmd.aliases] : undefined,
        description: cmd.description,
        category: cmd.category,
        execution: "local",
        tag: "builtin",
        args: cmd.args ? [...cmd.args] : undefined,
        hidden: cmd.hidden,
      });
      typeaheadDispatcher.registerHandler(id, async (ctx: CommandHandlerContext) => {
        const rest =
          typeof ctx.args._rest === "string" ? ctx.args._rest : "";
        await legacy.handler(state, rest);
        return {};
      });
    }
  }

  const getRuntime = (): RuntimeContext => ({
    sessionBusy: state.running,
    workspaceId: session.runtime.resolvedWorkspace.path,
    cwd: process.cwd(),
    target: "cli",
    features: {},
    now: Date.now(),
  });

  // close 监听器 + 主循环的协作信号：
  //
  // 异步 cleanup 监听器（下方）会跑 dispose / "再见 👋" / process.exit，含 await
  // 可能挂起多个 tick；期间 /exit 等命令的 handler 已 resolve，主循环若 continue
  // 进入下一轮 readInputLine 会渲染新 box，与"再见 👋"输出视觉重叠。
  //
  // 同步监听器立即设 flag，主循环顶部检查 flag 直接 break——不渲染新 box；
  // 异步 cleanup 沿原 timeline 跑完，最终 process.exit。两个监听器按注册顺序
  // 同步触发（同步部分），共同表达"REPL 正在关闭"的协作语义。
  let replShuttingDown = false;
  rl.on("close", () => {
    replShuttingDown = true;
  });

  rl.on("close", async () => {
    renderer.stop();
    // session.dispose 内部 detach renderer + stop scheduler/delivery + dispose channels
    await session.dispose().catch((err) =>
      console.error("[session.dispose]", err),
    );
    console.log(chalk.dim("\n再见 👋"));
    process.exit(0);
  });

  // ── Scheduler 事件 → 终端渲染 ──
  //
  // 任务结果通过 EventBus 通知 REPL，在当前 readline prompt 之上插入通知行。
  // 与已有的 retry/budget 事件渲染方式一致。
  const restorePrompt = () => {
    if (!state.running) {
      process.stdout.write(chalk.green("❯ "));
    }
  };
  schedulerEventBus.on("scheduler:task-completed", (info) => {
    renderer.stop();
    console.log(
      chalk.green(`\n  ✓ 任务完成: ${info.name}`) +
      chalk.dim(` (${Math.round(info.durationMs / 1000)}s)`) +
      (info.summary ? `\n  ${chalk.dim(info.summary.slice(0, 120))}` : "") +
      "\n",
    );
    restorePrompt();
  });
  schedulerEventBus.on("scheduler:task-failed", (info) => {
    renderer.stop();
    console.log(
      chalk.red(`\n  ✗ 任务失败: ${info.name}`) +
      chalk.dim(` (连续 ${info.consecutiveErrors} 次)`) +
      `\n  ${chalk.dim(info.error.slice(0, 120))}` +
      (info.nextRunAt ? chalk.dim(`\n  下次重试: ${new Date(info.nextRunAt).toLocaleTimeString()}`) : "") +
      "\n",
    );
    restorePrompt();
  });
  schedulerEventBus.on("scheduler:task-disabled", (info) => {
    renderer.stop();
    console.log(
      chalk.red(`\n  ⊘ 任务已自动停用: ${info.name}`) +
      chalk.dim(`\n  原因: ${info.reason}`) +
      (info.lastError ? chalk.dim(`\n  最后错误: ${info.lastError.slice(0, 120)}`) : "") +
      "\n",
    );
    restorePrompt();
  });

  // ── 旧/新路径都要处理的"命令 fallthrough 到 legacy slashCommands"助手 ──
  const runLegacyCommand = async (rawDraft: string): Promise<boolean> => {
    const trimmed = rawDraft.trim();
    if (!trimmed.startsWith("/")) return false;
    const [cmd, ...rest] = trimmed.split(/\s+/);
    const legacy = slashCommands[cmd!];
    if (!legacy) {
      console.log(
        chalk.yellow(`未知命令: ${cmd}`) +
          chalk.dim("  输入 /help 查看帮助\n"),
      );
      return true;
    }
    await legacy.handler(state, rest.join(" "));
    return true;
  };

  // REPL 主循环
  while (true) {
    // 检查 close 监听器的同步协作信号——/exit / 双击 Ctrl+C / 终端关闭等任何
    // 退出路径触发 rl.close() 后立即设此 flag，主循环 break 不再进入下一轮
    // readInputLine，避免在 cleanup 异步流程跑完前渲染新 box 与"再见 👋"重叠
    if (replShuttingDown) break;

    let input: string;

    if (useTypeahead && typeaheadBroker && typeaheadDispatcher) {
      // ── Typeahead 路径 ──
      rl.pause(); // 让出 stdin 所有权给 readInputLine
      let result: InputLineResult;
      try {
        result = await readInputLine({
          broker: typeaheadBroker,
          dispatcher: typeaheadDispatcher,
          getRuntime,
          placeholder: "输入消息或 / 查看命令",
        });
      } finally {
        rl.resume();
      }

      if (result.kind === "cancelled") {
        if (result.cause === "ctrl-c" || result.cause === "ctrl-d") break;
        continue;
      }

      if (result.kind === "command-dispatched") {
        const d = result.dispatchResult;
        if (d.kind === "local-handled") {
          continue;
        }
        if (d.kind === "unknown" || d.kind === "missing-handler") {
          // Fallthrough 到 legacy（未桥接的 /skills /trust /people 等）
          await runLegacyCommand(result.text);
          continue;
        }
        if (d.kind === "error") {
          console.log(chalk.red(`命令执行失败: ${d.error.message}\n`));
          continue;
        }
        if (d.kind === "hybrid") {
          // 已执行本地副作用；把 systemMessage 作为 user turn 发给 agent
          input = d.systemMessage;
        } else {
          // agent-message
          input = d.text;
        }
      } else {
        // kind === "text"
        if (!result.text) continue;
        input = result.text;
      }
    } else {
      // ── Legacy 路径 ──
      try {
        input = await rl.question(chalk.green("❯ "));
      } catch {
        break;
      }

      const trimmed = input.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith("/")) {
        await runLegacyCommand(trimmed);
        continue;
      }
    }

    // ── 解析 @file: 引用 ──
    let resolvedInput = input.trim();
    if (resolvedInput.includes("@file:")) {
      const refResult = await resolveFileRefs(resolvedInput, {
        workspaceRoot: session.runtime.resolvedWorkspace.path ?? process.cwd(),
      });
      resolvedInput = refResult.text;
      if (refResult.errors.length > 0) {
        for (const err of refResult.errors) {
          console.log(chalk.yellow(`  ⚠ ${err}`));
        }
      }
    }

    // 正常对话
    const userMsg = userMessage(resolvedInput);
    state.messages.push(userMsg);
    state.running = true;
    renderer.startThinking();

    // Per-turn 装载中断协调:KeyboardSource 拦截 Esc/Ctrl+C(raw mode) +
    // SignalSource 兜底 SIGINT/SIGTERM(cooked mode / non-TTY)。
    // controller.signal 透传给 session.runtime.run 让用户中断真正生效。
    // 每个 turn 独立 controller 实例,turn 结束 detach 释放 stdin 与 listener。
    //
    // exitRequested flag 协调双击退出:
    //   - 第一次 Ctrl+C 由 KeyboardSource 触发 abort, agent-loop 进入 unwinding
    //   - 第二次 Ctrl+C (800ms 内) 触发 onDoublePress, **只设 flag 不立即 close**
    //   - finally 块 detach 后判 flag 调 rl.close —— 此时 agent-loop 已因第一次 abort
    //     unwind 完成 (finalizeRun 完整 emit fired+run_end + tool 进程 cleanup +
    //     transcript commit),rl.close 触发现有 close handler 走 scheduler.stop /
    //     channels.dispose / process.exit 完整退出路径
    // 直接在 onDoublePress 内 rl.close 会让 process.exit(0) 杀掉 in-flight agent run,
    // 跳过 finalizeRun 的 emit + 资源清理 → 违反"已 emit 的 fired 必有对应 run_end"。
    let exitRequested = false;
    const interruptRuntime = createReplInterruptRuntime({
      onDoublePress: () => {
        exitRequested = true;
      },
    });

    try {
      const runPromise = session.runtime.run({
        messages: [...state.messages],
        turnIndex: state.turnCounter,
        abortSignal: interruptRuntime.controller.signal,
        onYield: (e) => renderer.handleEvent(e),
        enrichOptions: {
          lastToolEndCount: state.lastToolEndCount,
          hasProposedSkill: state.hasProposedSkill,
        },
      });
      // 暴露给 RuntimeSession.reload 流程——reload 在 swap 之前 await 此 promise
      state.activeTurnPromise = runPromise;
      const runResult = await runPromise;
      const { agentResult, newMessages, durationMs, budget, toolEndCount, injectedSkillIds } = runResult;

      renderer.stop();
      state.lastToolEndCount = toolEndCount;
      renderSummary(agentResult, durationMs, budget);

      // 检测 Agent 是否在本轮回复中提议了技能保存/更新
      if (!state.hasProposedSkill) {
        const assistantText = newMessages
          .filter((m) => m.role === "assistant")
          .flatMap((m) => m.content)
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (assistantText.includes("存为技能") || assistantText.includes("保存为技能") || assistantText.includes("SKILL_CANDIDATE") || /💡.*技能/.test(assistantText)) {
          state.hasProposedSkill = true;
        }
      }

      // 效果推断：根据对话信号更新本轮注入的技能 effectiveness
      if (injectedSkillIds.length > 0) {
        const thisRoundMessages = [userMsg, ...newMessages];
        inferEffectiveness(
          { injectedSkillIds, turnMessages: thisRoundMessages },
          new SkillsStore(),
        ).then((result) => {
          if (result.updates.length > 0) {
            applyEffectivenessUpdates(result, new SkillsStore()).catch(() => {});
          }
        }).catch(() => {});
      }

      // 单一事实源持久化：
      //   commitTurn 一次原子写入 turn + compactBefore，返回 canonical messages。
      //   state.messages = canonical 整体替换，不再分两步 "push newMessages + appendTurn"。
      //   canonical 自带压缩效果（compactBefore 截断后的末尾 turns + summaryPair），
      //   下次 run 直接用 state.messages 作为 LLM 输入，跨 run 状态与磁盘严格一致。
      if (state.conversationId) {
        try {
          const canonical = await state.store.commitTurn(state.conversationId, {
            turn: runResult.turn,
            compactBefore: runResult.compactBefore,
          });
          state.messages = canonical;
          state.turnCounter++;
          state.convRepo.touch(state.conversationId).catch(() => {});
        } catch (err) {
          // 持久化失败降级：state.messages 按未压缩形态 append newMessages
          //
          // 已知代价：runResult.compactBefore 若非空，此降级不应用 compact 截断 ——
          // 内存 state.messages 会多出一些本应被截断的老 turns，与磁盘不一致。
          //
          // 自愈机制：下一轮 run 的 pre-flight contextManager 会重新评估并触发
          // 新一轮 compact（因为内存超过阈值），恢复状态一致性。
          // 若进程崩溃并重启，磁盘还是老状态（本次 commitTurn 失败 = 无写入），
          // load → rebuildCanonicalMessages 直接从磁盘恢复，内存 drift 自然清零。
          //
          // 为什么不做复杂的"内存等价 rebuild"：
          //   a. 持久化失败是罕见事件（磁盘满 / 权限 / EIO），过度设计 ROI 低
          //   b. 简单 append 保证本轮对话对用户完整展示
          //   c. 自愈路径已经覆盖长期状态一致性
          state.messages.push(...newMessages);
          console.log(
            chalk.dim(
              `  [持久化警告] ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        }

        // 首轮对话后异步执行 Journal 生命周期维护
        if (!state.journalCondenseDone) {
          state.journalCondenseDone = true;
          runJournalLifecycle(state.agent).catch(() => {});
        }
      } else {
        // 无会话 ID（无持久化）：降级为内存 append，保持对话语义
        state.messages.push(...newMessages);
      }
    } catch (err) {
      renderer.stop();
      renderError(err);
      state.messages.pop();
    } finally {
      // 释放 stdin keypress ownership + 卸 SIGINT/SIGTERM listener;
      // 恢复 attach 前的 raw mode 状态,让下一轮 typeahead-input / readline 正常工作。
      interruptRuntime.detach();
      state.running = false;
      state.activeTurnPromise = null;
      // 双击 Ctrl+C 退出: 此时 agent-loop 已因第一次 abort unwind 完成
      // (run() 已 resolve / reject),安全调 rl.close 触发现有 cleanup 路径
      // (scheduler.stop / channels.dispose / process.exit)。
      // detach 之后 close 让 stdin 状态先归还再关闭 readline。
      if (exitRequested) {
        rl.close();
      }
    }
  }

  // 循环退出（Ctrl+C / Ctrl+D / readline 异常）→ 关闭 readline 触发 exit。
  //
  // 为什么需要：typeahead 路径的 Ctrl+C 由 readInputLine 捕获并 resolve，
  // 不经过 readline 内部的 close 流程。break 跳出循环后如果不显式 rl.close()，
  // readline 还持有 stdin → event loop 不空 → 进程不退出 → 用户陷入无 prompt
  // 的"僵尸态"。rl.close() 触发 rl.on("close") → process.exit(0)。
  //
  // Legacy 路径不受影响：readline 内部 Ctrl+C 已经 close 了，这里的 rl.close()
  // 是幂等的 no-op。
  rl.close();
}

// ─── 交互式会话选择器 ───

/**
 * 交互式会话选择器——展示最近 10 个对话让用户选号恢复。
 *
 * 返回完整 Conversation 而非 id：picker 内部 list() 已持有完整对象，
 * 让 caller 直接拿 name / lastActiveAt 等字段，避免被迫二次 convRepo.get(id)
 * 重读磁盘（ConversationRepository 无缓存层）。
 */
async function interactiveConversationPicker(
  convRepo: ConversationRepository,
): Promise<Conversation | null> {
  const conversations = await convRepo.list();
  if (conversations.length === 0) {
    return null;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  console.log(`\n${chalk.bold("选择要恢复的会话：")}`);
  const displayed = conversations.slice(0, 10);
  for (let i = 0; i < displayed.length; i++) {
    const c = displayed[i]!;
    const label = c.name ? chalk.white(c.name) : chalk.dim("(未命名)");
    const time = formatRelativeTime(new Date(c.lastActiveAt));
    console.log(
      `  ${chalk.cyan(String(i + 1).padStart(2))}. [${c.id}] ${label} ${chalk.dim(`(${time})`)}`,
    );
  }
  console.log(`  ${chalk.dim(" 0. 新建会话")}`);

  try {
    const answer = await rl.question(chalk.green("\n选择 (1-10, 0=新建): "));
    rl.close();

    const num = parseInt(answer.trim(), 10);
    if (num > 0 && num <= displayed.length) {
      return displayed[num - 1]!;
    }
    return null;
  } catch {
    rl.close();
    return null;
  }
}

// ─── /skills audit ───

async function renderSkillsAudit(store: SkillsStore): Promise<void> {
  const [active, archived] = await Promise.all([
    store.listAll(),
    store.listArchived(),
  ]);

  if (active.length === 0 && archived.length === 0) {
    console.log(chalk.dim("\n  技能库为空，无需审查。\n"));
    return;
  }

  const activeList = active.filter((s) => store.getStatus(s) === "active");
  const staleList = active.filter((s) => store.getStatus(s) === "stale");
  const needsUpdate = active.filter((s) => s.meta.effectiveness === "needs-update");

  console.log(`\n${chalk.bold("  📊 技能库健康报告")}\n`);
  console.log(`  ${chalk.green("●")} 活跃 (Active):  ${activeList.length} 个`);
  console.log(`  ${chalk.yellow("○")} 沉寂 (Stale):   ${staleList.length} 个`);
  console.log(`  ${chalk.dim("◌")} 归档 (Archived): ${archived.length} 个`);

  if (needsUpdate.length > 0) {
    console.log(`  ${chalk.red("!")} 待更新:          ${needsUpdate.length} 个`);
  }

  if (staleList.length > 0) {
    console.log(chalk.yellow(`\n  沉寂技能（超过 90 天未使用）：`));
    for (const skill of staleList) {
      const lastUsed = skill.meta.lastUsedAt ?? skill.meta.created;
      const daysSince = Math.floor(
        (Date.now() - new Date(lastUsed).getTime()) / 86400000,
      );
      console.log(
        `  ${chalk.yellow("○")} ${skill.meta.title}` +
          chalk.dim(` (${skill.id})`) +
          chalk.dim(` · 使用 ${skill.meta.useCount} 次 · ${daysSince} 天前`),
      );
    }
    console.log(chalk.dim(`\n  操作: /skills archive <id>  归档`));
    console.log(chalk.dim(`        /skills delete <id>   删除`));
  }

  if (needsUpdate.length > 0) {
    console.log(chalk.red(`\n  效果存疑（用户反馈过时或有误）：`));
    for (const skill of needsUpdate) {
      console.log(
        `  ${chalk.red("!")} ${skill.meta.title}` +
          chalk.dim(` (${skill.id})`) +
          chalk.dim(` · v${skill.meta.version} · 使用 ${skill.meta.useCount} 次`),
      );
    }
    console.log(chalk.dim(`\n  提示: 对话中提到该技能场景，AI 会自动提议更新`));
  }

  if (archived.length > 0) {
    console.log(chalk.dim(`\n  归档技能：`));
    for (const skill of archived) {
      console.log(
        chalk.dim(`  ◌ ${skill.meta.title} (${skill.id})`),
      );
    }
    console.log(chalk.dim(`\n  操作: /skills restore <id>  恢复`));
  }

  if (staleList.length === 0 && needsUpdate.length === 0) {
    console.log(chalk.green(`\n  ✓ 所有技能状态健康`));
  }

  console.log();
}

// ─── 工具函数 ───

async function checkStaleSkills(): Promise<void> {
  try {
    const skillsStore = new SkillsStore();
    const all = await skillsStore.listAll();
    if (all.length === 0) return;

    const staleSkills = all.filter((s) => skillsStore.getStatus(s) === "stale");
    const needsUpdateSkills = all.filter((s) => s.meta.effectiveness === "needs-update");

    const issues: string[] = [];
    if (staleSkills.length > 0) {
      issues.push(`${staleSkills.length} 个技能超过 90 天未使用`);
    }
    if (needsUpdateSkills.length > 0) {
      issues.push(`${needsUpdateSkills.length} 个技能需要更新`);
    }

    if (issues.length > 0) {
      console.log(
        chalk.dim(`  💡 ${issues.join("，")}。输入 /skills audit 查看详情\n`),
      );
    }
  } catch {
    // 静默——启动提醒不应阻塞 REPL
  }
}

/**
 * 异步执行 Journal 生命周期维护。
 * 首轮对话后触发：删除过期文件 + 凝练温日志。
 * 静默执行，失败不影响用户对话。
 */
async function runJournalLifecycle(session: AgentRuntime): Promise<void> {
  const jStore = new JournalStore();

  // 先删除过期凝练文件（纯文件操作，极快）
  await jStore.expireOld();

  // 扫描是否需要凝练
  const plan = await jStore.scan();
  if (!plan.condensePlan) return;

  await jStore.condense(plan.condensePlan, {
    async condense(dailyContents: string): Promise<string> {
      return session.callText(
        `请将以下日志内容凝练为简洁的月度摘要，保留关键事实和决策，去掉冗余细节。如果发现可复用的方法论，用 [SKILL_CANDIDATE] 标记。\n\n${dailyContents}`,
      );
    },
  });
}

function formatTaskSchedule(schedule: { kind: string; at?: string; everyMs?: number; expr?: string; tz?: string }): string {
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

function formatRelativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "昨天";
  return `${days} 天前`;
}
