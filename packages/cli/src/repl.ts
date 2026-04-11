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
  SessionStore,
  loadProfile,
  getMemoryDir,
  SkillsStore,
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
      description: "查看技能库",
      handler: async () => {
        const store = new SkillsStore();
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
          const tags = skill.meta.tags.length > 0
            ? chalk.dim(` [${skill.meta.tags.join(", ")}]`)
            : "";
          const usage = chalk.dim(` (使用 ${skill.meta.useCount} 次)`);
          console.log(
            `  ${chalk.cyan("•")} ${skill.meta.title}${tags}${usage}`,
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
      const { agentResult, newMessages, durationMs, budget } =
        await agentSession.run({
          messages: [...state.messages],
          onYield: (e) => renderer.handleEvent(e),
          onBeforeEventRender: () => renderer.stop(),
        });

      renderer.stop();
      state.messages.push(...newMessages);
      renderSummary(agentResult, durationMs, budget);

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

// ─── 工具函数 ───

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
