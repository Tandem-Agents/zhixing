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
import chalk from "chalk";
import {
  userMessage,
  type Message,
  type Turn,
  type CompactMarker,
  TranscriptStore,
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
  Scheduler,
  JsonTaskStore,
  createEventBus,
  type SchedulerEventMap,
  type AgentTurnResult,
} from "@zhixing/core";
import { createScheduleTool } from "@zhixing/tools-builtin";
import { CommandDispatcher } from "./command-dispatcher.js";
import { readInputLine, type InputLineResult } from "./typeahead-input.js";
import { resolveFileRefs } from "./resolve-file-refs.js";
import { type AgentRuntime, createAgentRuntime } from "./run-agent.js";
import {
  createRenderer,
  renderSummary,
  renderError,
  renderWelcome,
  renderUsageReport,
  renderContextVisual,
} from "./render.js";
import {
  handleTrustCommand,
  handleSecurityCommand,
  TerminalConfirmationRenderer,
} from "./security/index.js";

// ─── REPL 状态 ───

interface ReplState {
  messages: Message[];
  agent: AgentRuntime;
  running: boolean;
  /** 持久化 */
  store: InstanceType<typeof TranscriptStore>;
  transcriptId: string | null;
  turnCounter: number;
  /** 上一轮的工具调用完成数（用于反思触发） */
  lastToolEndCount: number;
  /** 本会话是否已提议过技能（每会话最多 1 次） */
  hasProposedSkill: boolean;
  /** 是否已执行过 Journal 自动凝练 */
  journalCondenseDone: boolean;
  /** Scheduler 实例（S1: CLI 进程内运行） */
  scheduler: Scheduler | null;
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

function buildSlashCommands(rl: readline.Interface): Record<
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
        const commands = buildSlashCommands(rl);
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
        console.log(
          `\n  ${chalk.dim("Session:")} ${state.transcriptId ?? "(未保存)"}` +
            `\n  ${chalk.dim("Messages:")} ${state.messages.length} (${userMsgs} user, ${assistantMsgs} assistant)` +
            `\n  ${chalk.dim("Model:")} ${chalk.cyan(state.agent.model)}` +
            `\n  ${chalk.dim("Provider:")} ${state.agent.providerId}\n`,
        );
      },
    },
    "/sessions": {
      description: "列出当前项目的会话",
      handler: async (state) => {
        const sessions = await state.store.list();
        if (sessions.length === 0) {
          console.log(chalk.dim("\n  没有保存的会话\n"));
          return;
        }
        console.log(`\n${chalk.bold("  保存的会话：")}`);
        for (const s of sessions.slice(0, 15)) {
          const label = s.name ? chalk.white(s.name) : chalk.dim("(未命名)");
          const time = formatRelativeTime(s.lastAccessedAt);
          const current =
            s.sessionId === state.transcriptId ? chalk.green(" ← 当前") : "";
          console.log(
            `  ${chalk.cyan(s.sessionId)} ${label} ${chalk.dim(`(${time}, ${s.turnCount} 轮, ${s.model})`)}${current}`,
          );
        }
        console.log();
      },
    },
    "/name": {
      description: "为当前会话命名",
      handler: async (state, args) => {
        if (!args.trim()) {
          console.log(chalk.yellow("用法: /name <名称>\n"));
          return;
        }
        if (!state.transcriptId) {
          console.log(chalk.yellow("当前会话尚未保存\n"));
          return;
        }
        await state.store.rename(state.transcriptId, args.trim());
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
        if (!budget) {
          console.log(chalk.dim("\n  模型信息不可用，无法计算预算\n"));
          return;
        }
        renderUsageReport(budget, state.turnCounter, state.agent.calibrationFactor);
      },
    },
    "/context": {
      description: "上下文容量可视化",
      handler: (state) => {
        const budget = state.agent.checkBudget(state.messages);
        if (!budget) {
          console.log(chalk.dim("\n  模型信息不可用，无法计算预算\n"));
          return;
        }
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
        const tokensBefore = state.agent.checkBudget(state.messages)?.currentTokens ?? 0;
        console.log(chalk.yellow("\n  ⟳ 正在压缩上下文..."));
        try {
          const result = await state.agent.forceCompact(
            [...state.messages],
            state.turnCounter,
          );
          if (result.modified) {
            state.messages = result.messages;
            const tokensAfter = result.budget?.currentTokens ?? 0;
            const pct = result.budget ? Math.round(result.budget.usageRatio * 100) : "?";
            console.log(chalk.green(`  ✓ 压缩完成，当前上下文占用 ${pct}%\n`));
            // 写入 compact 行到会话文件
            if (state.transcriptId) {
              const compact: CompactMarker = {
                type: "compact",
                timestamp: new Date().toISOString(),
                summary: "(manual compact)",
                turnsCompacted: state.turnCounter,
                tokensBefore,
                tokensAfter,
              };
              state.store.appendCompact(state.transcriptId, compact).catch(() => {});
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
      handler: async (state) => {
        if (state.scheduler) {
          await state.scheduler.stop();
        }
        console.log(chalk.dim("再见 👋"));
        process.exit(0);
      },
    },
  };
}

// ─── 启动 REPL ───

export async function startRepl(options: ReplOptions): Promise<void> {
  // ── Scheduler 初始化（S1: CLI 进程内运行） ──
  //
  // 初始化顺序解决循环依赖：
  // 1. 创建 schedule 工具（捕获 scheduler getter）
  // 2. 创建 session（包含 schedule 工具）
  // 3. 创建 scheduler（注入 session.run 作为 runAgentTurn）
  // 4. 启动 scheduler
  let schedulerInstance: Scheduler | null = null;
  const schedulerEventBus = createEventBus<SchedulerEventMap>();
  const scheduleTool = createScheduleTool(() => {
    if (!schedulerInstance) throw new Error("Scheduler not initialized yet");
    return schedulerInstance;
  });

  const agentRuntime = await createAgentRuntime({
    model: options.model,
    provider: options.provider,
    workspace: options.workspace,
    extraTools: [scheduleTool],
  });

  // 构造 runAgentTurn：将 Scheduler 的任务执行桥接到 session.run
  const runAgentTurn = async (params: {
    prompt: string;
    model?: string;
    tools?: string[];
    abortSignal?: AbortSignal;
  }): Promise<AgentTurnResult> => {
    const startTime = Date.now();
    try {
      const result = await agentRuntime.run({
        messages: [userMessage(params.prompt)],
        // 任务执行不渲染到前台（S1 通过 EventBus 通知）
      });
      // 提取文本输出
      const output = result.newMessages
        .filter((m) => m.role === "assistant")
        .flatMap((m) => m.content)
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n");

      return {
        status: result.agentResult.reason === "completed" ? "ok" : "error",
        output: output || undefined,
        error: result.agentResult.reason === "error"
          ? result.agentResult.error.message
          : undefined,
        durationMs: result.durationMs,
      };
    } catch (err: unknown) {
      return {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  };

  schedulerInstance = new Scheduler({
    store: new JsonTaskStore(),
    runAgentTurn,
    eventBus: schedulerEventBus,
    logger: {
      info: (msg, data) => console.log(chalk.dim(`  [scheduler] ${msg}`), data ? chalk.dim(JSON.stringify(data)) : ""),
      warn: (msg, data) => console.log(chalk.yellow(`  [scheduler] ${msg}`), data ? chalk.dim(JSON.stringify(data)) : ""),
      error: (msg, data) => console.log(chalk.red(`  [scheduler] ${msg}`), data ? chalk.dim(JSON.stringify(data)) : ""),
      debug: () => {},
    },
  });

  // 启动 scheduler（加载任务 + 启动 timer loop）
  await schedulerInstance.start();

  const renderer = createRenderer();
  const store = new TranscriptStore(process.cwd());

  let messages: Message[] = [];
  let transcriptId: string | null = null;
  let turnCounter = 0;

  // 处理会话恢复
  if (options.continue) {
    const latest = await store.findLatest();
    if (latest) {
      const loaded = await store.load(latest);
      messages = loaded.messages;
      transcriptId = latest;
      turnCounter = loaded.turnCount;
      console.log(
        chalk.dim(
          `\n  已恢复会话 ${chalk.cyan(latest)}（${loaded.turnCount} 轮对话）\n`,
        ),
      );
    } else {
      console.log(chalk.dim("\n  没有找到可恢复的会话，开始新对话\n"));
    }
  } else if (options.resume !== undefined) {
    if (typeof options.resume === "string") {
      try {
        const loaded = await store.load(options.resume);
        messages = loaded.messages;
        transcriptId = options.resume;
        turnCounter = loaded.turnCount;
        console.log(
          chalk.dim(
            `\n  已恢复会话 ${chalk.cyan(options.resume)}（${loaded.turnCount} 轮对话）\n`,
          ),
        );
      } catch (err) {
        console.log(
          chalk.red(
            `\n  无法恢复会话 ${options.resume}: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        return;
      }
    } else {
      // --resume 不带 ID → 交互式选择
      transcriptId = await interactiveSessionPicker(store);
      if (transcriptId) {
        const loaded = await store.load(transcriptId);
        messages = loaded.messages;
        turnCounter = loaded.turnCount;
        console.log(
          chalk.dim(
            `\n  已恢复会话 ${chalk.cyan(transcriptId)}（${loaded.turnCount} 轮对话）\n`,
          ),
        );
      } else {
        console.log(chalk.dim("\n  开始新对话\n"));
      }
    }
  }

  // 新会话：创建持久化文件
  if (!transcriptId) {
    const header = await store.create({
      name: options.name,
      model: agentRuntime.model,
      provider: agentRuntime.providerId,
    });
    transcriptId = header.sessionId;
  }

  await renderWelcome({
    model: agentRuntime.model,
    workspace: agentRuntime.resolvedWorkspace,
    workspaceDirStatus: agentRuntime.workspaceDirStatus,
  });

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
  const detachConfirmationRenderer = confirmationRenderer.attach(
    agentRuntime.confirmationBroker,
  );

  const state: ReplState = {
    messages,
    agent: agentRuntime,
    running: false,
    store,
    transcriptId,
    turnCounter,
    lastToolEndCount: 0,
    hasProposedSkill: false,
    journalCondenseDone: false,
    scheduler: schedulerInstance,
  };

  const slashCommands = buildSlashCommands(rl);

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
        root: agentRuntime.resolvedWorkspace.path ?? process.cwd(),
      }),
    );
    typeaheadDispatcher = new CommandDispatcher({ registry: tRegistry });

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
    }> = [
      // ─ session ─
      { name: "new", aliases: ["reset"], description: "开始新会话（清空历史）", category: "session", legacyKey: "/clear" },
      { name: "clear", description: "清空对话历史", category: "session", legacyKey: "/clear" },
      { name: "sessions", description: "列出当前项目的会话", category: "session", legacyKey: "/sessions" },
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
    workspaceId: agentRuntime.resolvedWorkspace.path,
    cwd: process.cwd(),
    target: "cli",
    features: {},
    now: Date.now(),
  });

  rl.on("close", async () => {
    renderer.stop();
    detachConfirmationRenderer();
    // 优雅停止 Scheduler：等待活跃任务完成 → 保存状态
    if (schedulerInstance) {
      await schedulerInstance.stop();
    }
    console.log(chalk.dim("\n再见 👋"));
    process.exit(0);
  });

  // ── Scheduler 事件 → 终端渲染 ──
  //
  // 任务结果通过 EventBus 通知 REPL，在当前 readline prompt 之上插入通知行。
  // 与已有的 retry/budget 事件渲染方式一致。
  schedulerEventBus.on("scheduler:task-completed", (info) => {
    renderer.stop();
    console.log(
      chalk.green(`\n  ✓ 任务完成: ${info.name}`) +
      chalk.dim(` (${Math.round(info.durationMs / 1000)}s)`) +
      (info.summary ? `\n  ${chalk.dim(info.summary.slice(0, 120))}` : "") +
      "\n",
    );
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
  });
  schedulerEventBus.on("scheduler:task-disabled", (info) => {
    renderer.stop();
    console.log(
      chalk.red(`\n  ⊘ 任务已自动停用: ${info.name}`) +
      chalk.dim(`\n  原因: ${info.reason}`) +
      (info.lastError ? chalk.dim(`\n  最后错误: ${info.lastError.slice(0, 120)}`) : "") +
      "\n",
    );
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
        workspaceRoot: agentRuntime.resolvedWorkspace.path ?? process.cwd(),
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

    try {
      const { agentResult, newMessages, durationMs, budget, toolEndCount, injectedSkillIds, compactInfo } =
        await agentRuntime.run({
          messages: [...state.messages],
          onYield: (e) => renderer.handleEvent(e),
          onBeforeEventRender: () => renderer.stop(),
          enrichOptions: {
            lastToolEndCount: state.lastToolEndCount,
            hasProposedSkill: state.hasProposedSkill,
          },
          // 安全确认对话框走 readline 的 question——pause 渲染避免 spinner 覆盖
          securityPrompt: async (text) => {
            renderer.stop();
            return rl.question(text);
          },
        });

      renderer.stop();
      state.messages.push(...newMessages);
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

      // 持久化本轮对话
      if (state.transcriptId) {
        const assistantMsg = newMessages[0];
        if (assistantMsg) {
          const turn: Turn = {
            type: "turn",
            turnIndex: state.turnCounter,
            timestamp: new Date().toISOString(),
            userMessage: userMsg,
            assistantMessage: assistantMsg,
            usage: agentResult.usage
              ? {
                  inputTokens: agentResult.usage.inputTokens,
                  outputTokens: agentResult.usage.outputTokens,
                }
              : undefined,
          };
          await state.store.appendTurn(state.transcriptId, turn).catch((err) => {
            console.log(
              chalk.dim(
                `  [持久化警告] ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
          });
          state.turnCounter++;
        }

        // 首轮对话后异步执行 Journal 生命周期维护
        if (!state.journalCondenseDone) {
          state.journalCondenseDone = true;
          runJournalLifecycle(state.agent).catch(() => {});
        }

        // 自动压缩发生时，写入 compact 行用于会话恢复
        if (compactInfo) {
          const compact: CompactMarker = {
            type: "compact",
            timestamp: new Date().toISOString(),
            summary: compactInfo.summary,
            turnsCompacted: state.turnCounter,
            tokensBefore: compactInfo.tokensBefore,
            tokensAfter: compactInfo.tokensAfter,
          };
          state.store.appendCompact(state.transcriptId, compact).catch(() => {});
        }
      }
    } catch (err) {
      renderer.stop();
      renderError(err);
      state.messages.pop();
    } finally {
      state.running = false;
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

async function interactiveSessionPicker(
  store: InstanceType<typeof TranscriptStore>,
): Promise<string | null> {
  const sessions = await store.list();
  if (sessions.length === 0) {
    return null;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  console.log(`\n${chalk.bold("选择要恢复的会话：")}`);
  const displayed = sessions.slice(0, 10);
  for (let i = 0; i < displayed.length; i++) {
    const s = displayed[i]!;
    const label = s.name ? chalk.white(s.name) : chalk.dim("(未命名)");
    const time = formatRelativeTime(s.lastAccessedAt);
    console.log(
      `  ${chalk.cyan(String(i + 1).padStart(2))}. [${s.sessionId}] ${label} ${chalk.dim(`(${time}, ${s.model})`)}`,
    );
  }
  console.log(`  ${chalk.dim(" 0. 新建会话")}`);

  try {
    const answer = await rl.question(chalk.green("\n选择 (1-10, 0=新建): "));
    rl.close();

    const num = parseInt(answer.trim(), 10);
    if (num > 0 && num <= displayed.length) {
      return displayed[num - 1]!.sessionId;
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
