/**
 * REPL 交互模式
 *
 * 基于 Node.js readline/promises 的多轮对话循环。
 * MVP 方案：纯 readline，不引入 Ink/React。
 *
 * 流程：
 * 1. 显示欢迎信息
 * 2. readline.question() 获取用户输入
 * 3. 如果是斜杠命令，就地处理
 * 4. 否则追加到对话历史，启动 spinner，运行 Agent Loop
 * 5. 收集新产生的消息，追加到对话历史
 * 6. 回到步骤 2
 */

import * as readline from "node:readline/promises";
import chalk from "chalk";
import { userMessage, type Message } from "@zhixing/core";
import { type AgentSession, createSession } from "./run-agent.js";
import { createRenderer, renderSummary, renderError, renderWelcome } from "./render.js";

// ─── REPL 状态 ───

interface ReplState {
  messages: Message[];
  session: AgentSession;
  running: boolean;
}

// ─── 斜杠命令 ───

const SLASH_COMMANDS: Record<string, {
  description: string;
  handler: (state: ReplState, args: string) => void;
}> = {
  "/help": {
    description: "显示帮助信息",
    handler: () => {
      console.log(`\n${chalk.bold("可用命令：")}`);
      for (const [cmd, { description }] of Object.entries(SLASH_COMMANDS)) {
        console.log(`  ${chalk.cyan(cmd.padEnd(12))} ${chalk.dim(description)}`);
      }
      console.log();
    },
  },
  "/clear": {
    description: "清空对话历史",
    handler: (state) => {
      state.messages = [];
      console.log(chalk.dim("对话历史已清空\n"));
    },
  },
  "/model": {
    description: "显示当前模型信息",
    handler: (state) => {
      console.log(
        `\n  ${chalk.dim("Model:")} ${chalk.cyan(state.session.model)}` +
        `\n  ${chalk.dim("Provider:")} ${state.session.providerId}` +
        `\n  ${chalk.dim("Turns:")} ${state.messages.filter((m) => m.role === "user").length}\n`,
      );
    },
  },
  "/status": {
    description: "显示会话状态",
    handler: (state) => {
      const userMsgs = state.messages.filter((m) => m.role === "user").length;
      const assistantMsgs = state.messages.filter((m) => m.role === "assistant").length;
      console.log(
        `\n  ${chalk.dim("Messages:")} ${state.messages.length} (${userMsgs} user, ${assistantMsgs} assistant)` +
        `\n  ${chalk.dim("Model:")} ${chalk.cyan(state.session.model)}` +
        `\n  ${chalk.dim("Provider:")} ${state.session.providerId}\n`,
      );
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

// ─── 启动 REPL ───

export async function startRepl(options: {
  model?: string;
  provider?: string;
}): Promise<void> {
  const session = createSession(options);
  const renderer = createRenderer();

  await renderWelcome({ model: session.model });

  const state: ReplState = {
    messages: [],
    session,
    running: false,
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

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
      const command = SLASH_COMMANDS[cmd!];
      if (command) {
        command.handler(state, rest.join(" "));
      } else {
        console.log(chalk.yellow(`未知命令: ${cmd}`) + chalk.dim("  输入 /help 查看帮助\n"));
      }
      continue;
    }

    // 正常对话
    state.messages.push(userMessage(trimmed));
    state.running = true;
    renderer.startThinking();

    try {
      const { agentResult, newMessages, durationMs } = await session.run({
        messages: [...state.messages],
        onYield: (e) => renderer.handleEvent(e),
      });

      renderer.stop();
      state.messages.push(...newMessages);
      renderSummary(agentResult, durationMs);
    } catch (err) {
      renderer.stop();
      renderError(err);
      state.messages.pop();
    } finally {
      state.running = false;
    }
  }
}
