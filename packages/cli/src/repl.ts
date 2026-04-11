/**
 * REPL 交互模式
 *
 * 基于 Node.js readline/promises 的多轮对话循环。
 *
 * 流程：
 * 1. 初始化 SessionStore → 创建或恢复会话
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
  type SessionTurn,
  type SessionCompact,
  SessionStore,
  loadProfile,
  getMemoryDir,
  SkillsStore,
  PeopleStore,
  JournalStore,
  inferEffectiveness,
  applyEffectivenessUpdates,
} from "@zhixing/core";
import { type AgentSession, createSession } from "./run-agent.js";
import {
  createRenderer,
  renderSummary,
  renderError,
  renderWelcome,
  renderUsageReport,
  renderContextVisual,
} from "./render.js";

// ─── REPL 状态 ───

interface ReplState {
  messages: Message[];
  session: AgentSession;
  running: boolean;
  /** 持久化 */
  store: InstanceType<typeof SessionStore>;
  sessionId: string | null;
  turnCounter: number;
  /** 上一轮的工具调用完成数（用于反思触发） */
  lastToolEndCount: number;
  /** 本会话是否已提议过技能（每会话最多 1 次） */
  hasProposedSkill: boolean;
  /** 是否已执行过 Journal 自动凝练 */
  journalCondenseDone: boolean;
}

// ─── 会话恢复选项 ───

export interface ReplOptions {
  model?: string;
  provider?: string;
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
          `\n  ${chalk.dim("Model:")} ${chalk.cyan(state.session.model)}` +
            `\n  ${chalk.dim("Provider:")} ${state.session.providerId}` +
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
          `\n  ${chalk.dim("Session:")} ${state.sessionId ?? "(未保存)"}` +
            `\n  ${chalk.dim("Messages:")} ${state.messages.length} (${userMsgs} user, ${assistantMsgs} assistant)` +
            `\n  ${chalk.dim("Model:")} ${chalk.cyan(state.session.model)}` +
            `\n  ${chalk.dim("Provider:")} ${state.session.providerId}\n`,
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
            s.sessionId === state.sessionId ? chalk.green(" ← 当前") : "";
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
        if (!state.sessionId) {
          console.log(chalk.yellow("当前会话尚未保存\n"));
          return;
        }
        await state.store.rename(state.sessionId, args.trim());
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
        const budget = state.session.checkBudget(state.messages);
        if (!budget) {
          console.log(chalk.dim("\n  模型信息不可用，无法计算预算\n"));
          return;
        }
        renderUsageReport(budget, state.turnCounter, state.session.calibrationFactor);
      },
    },
    "/context": {
      description: "上下文容量可视化",
      handler: (state) => {
        const budget = state.session.checkBudget(state.messages);
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
        const tokensBefore = state.session.checkBudget(state.messages)?.currentTokens ?? 0;
        console.log(chalk.yellow("\n  ⟳ 正在压缩上下文..."));
        try {
          const result = await state.session.forceCompact(
            [...state.messages],
            state.turnCounter,
          );
          if (result.modified) {
            state.messages = result.messages;
            const tokensAfter = result.budget?.currentTokens ?? 0;
            const pct = result.budget ? Math.round(result.budget.usageRatio * 100) : "?";
            console.log(chalk.green(`  ✓ 压缩完成，当前上下文占用 ${pct}%\n`));
            // 写入 compact 行到会话文件
            if (state.sessionId) {
              const compact: SessionCompact = {
                type: "compact",
                timestamp: new Date().toISOString(),
                summary: "(manual compact)",
                turnsCompacted: state.turnCounter,
                tokensBefore,
                tokensAfter,
              };
              state.store.appendCompact(state.sessionId, compact).catch(() => {});
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
    "/exit": {
      description: "退出",
      handler: () => {
        console.log(chalk.dim("再见 👋"));
        process.exit(0);
      },
    },
  };
}

// ─── 启动 REPL ───

export async function startRepl(options: ReplOptions): Promise<void> {
  const agentSession = await createSession(options);
  const renderer = createRenderer();
  const store = new SessionStore(process.cwd());

  let messages: Message[] = [];
  let sessionId: string | null = null;
  let turnCounter = 0;

  // 处理会话恢复
  if (options.continue) {
    const latest = await store.findLatest();
    if (latest) {
      const loaded = await store.load(latest);
      messages = loaded.messages;
      sessionId = latest;
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
        sessionId = options.resume;
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
      sessionId = await interactiveSessionPicker(store);
      if (sessionId) {
        const loaded = await store.load(sessionId);
        messages = loaded.messages;
        turnCounter = loaded.turnCount;
        console.log(
          chalk.dim(
            `\n  已恢复会话 ${chalk.cyan(sessionId)}（${loaded.turnCount} 轮对话）\n`,
          ),
        );
      } else {
        console.log(chalk.dim("\n  开始新对话\n"));
      }
    }
  }

  // 新会话：创建持久化文件
  if (!sessionId) {
    const header = await store.create({
      name: options.name,
      model: agentSession.model,
      provider: agentSession.providerId,
    });
    sessionId = header.sessionId;
  }

  await renderWelcome({ model: agentSession.model });

  // 启动时检测 stale 技能，温和提醒
  await checkStaleSkills();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const state: ReplState = {
    messages,
    session: agentSession,
    running: false,
    store,
    sessionId,
    turnCounter,
    lastToolEndCount: 0,
    hasProposedSkill: false,
    journalCondenseDone: false,
  };

  const slashCommands = buildSlashCommands(rl);

  rl.on("close", () => {
    renderer.stop();
    console.log(chalk.dim("\n再见 👋"));
    process.exit(0);
  });

  // REPL 主循环
  while (true) {
    let input: string;
    try {
      input = await rl.question(chalk.green("❯ "));
    } catch {
      break;
    }

    const trimmed = input.trim();
    if (!trimmed) continue;

    // 斜杠命令
    if (trimmed.startsWith("/")) {
      const [cmd, ...rest] = trimmed.split(/\s+/);
      const command = slashCommands[cmd!];
      if (command) {
        await command.handler(state, rest.join(" "));
      } else {
        console.log(
          chalk.yellow(`未知命令: ${cmd}`) +
            chalk.dim("  输入 /help 查看帮助\n"),
        );
      }
      continue;
    }

    // 正常对话
    const userMsg = userMessage(trimmed);
    state.messages.push(userMsg);
    state.running = true;
    renderer.startThinking();

    try {
      const { agentResult, newMessages, durationMs, budget, toolEndCount, injectedSkillIds, compactInfo } =
        await agentSession.run({
          messages: [...state.messages],
          onYield: (e) => renderer.handleEvent(e),
          onBeforeEventRender: () => renderer.stop(),
          enrichOptions: {
            lastToolEndCount: state.lastToolEndCount,
            hasProposedSkill: state.hasProposedSkill,
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
      if (state.sessionId) {
        const assistantMsg = newMessages[0];
        if (assistantMsg) {
          const turn: SessionTurn = {
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
          await state.store.appendTurn(state.sessionId, turn).catch((err) => {
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
          runJournalLifecycle(state.session).catch(() => {});
        }

        // 自动压缩发生时，写入 compact 行用于会话恢复
        if (compactInfo) {
          const compact: SessionCompact = {
            type: "compact",
            timestamp: new Date().toISOString(),
            summary: compactInfo.summary,
            turnsCompacted: state.turnCounter,
            tokensBefore: compactInfo.tokensBefore,
            tokensAfter: compactInfo.tokensAfter,
          };
          state.store.appendCompact(state.sessionId, compact).catch(() => {});
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
}

// ─── 交互式会话选择器 ───

async function interactiveSessionPicker(
  store: InstanceType<typeof SessionStore>,
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
async function runJournalLifecycle(session: AgentSession): Promise<void> {
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
