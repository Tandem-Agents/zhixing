/**
 * 知行 CLI 入口
 *
 * 运行模式：
 * - 交互模式：zhixing → REPL 多轮对话
 * - 运行控制：zhixing status / zhixing stop → 查看或停止知行
 * - 宿主启动：zhixing serve → 核心宿主（由交互入口按需拉起，保留给内部与诊断）
 */

import chalk from "chalk";
import { Command } from "commander";
import { setDiagnosticLogger } from "@zhixing/core";
import { configureLlmChunkDump, pruneAllLogs } from "./output/llm-chunk-dump.js";
import { configureKeypressDump } from "./security/keypress-dump.js";
import { runStartupCheck, type StartupCheckResult } from "./startup.js";
import { startRepl } from "./repl.js";
import { renderError } from "./render.js";
import { createStdoutWriter } from "./screen/index.js";
import { runServeCommand } from "./serve/command.js";
import { runStopCommand } from "./serve/stop.js";
import { runStatusCommand } from "./serve/status.js";
import { runLogsCommand } from "./serve/logs.js";
import { ZHIXING_CLI_VERSION } from "./version.js";
import { findUnknownCommandPath } from "./command-gate.js";

/**
 * 顶层 stdout writer——cli 入口的错误路径 / 启动期渲染没有 ScreenController（chrome
 * 未创建），用 stdout writer 直写。各子命令进入交互模式时各自创建 ScreenWriter。
 */
const stdoutWriter = createStdoutWriter();

/**
 * 处理 ensureBootstrap 非 ready 状态：报错退出或 cancel 退出。
 * ready / completed 状态下返回，让 caller 继续主流程。
 */
function handleStartupResult(result: StartupCheckResult): void {
  if (result.kind === "ready") return;

  if (result.kind === "schema-error") {
    console.error(chalk.red(`[配置错误] ${result.message}`));
    console.error(chalk.dim(`请修复或删除文件后重试：${result.filePath}`));
    process.exit(2);
  }
  if (result.kind === "semantic-error") {
    console.error(
      chalk.red(`[配置错误] ${result.filePath} 含 ${result.issues.length} 处废弃字段：`),
    );
    console.error("");
    for (const [index, issue] of result.issues.entries()) {
      console.error(chalk.yellow(`${index + 1}. 字段：${issue.field}`));
      console.error(chalk.dim(`   原因：${issue.reason}`));
      console.error(chalk.dim(`   修复：${issue.fix}`));
      console.error("");
    }
    console.error(chalk.dim("修复后重新运行 `zhixing` 验证。"));
    process.exit(2);
  }
  if (result.kind === "non-tty") {
    console.error(chalk.red("缺少必要配置，且当前环境非交互终端。"));
    console.error(chalk.dim("请在 TTY 终端中运行 `zhixing` 完成配置。缺失项："));
    for (const label of result.missingLabels) {
      console.error(chalk.dim(`  - ${label}`));
    }
    process.exit(2);
  }
  if (result.kind === "cancelled") {
    console.log(chalk.dim("已取消配置。"));
    process.exit(0);
  }
}

const program = new Command();

function rejectUnknownCommandPath(argv: string[], command: Command): void {
  const unknownCommand = findUnknownCommandPath(argv, command);
  if (!unknownCommand) return;

  console.error(chalk.red(`error: unknown command '${unknownCommand}'`));
  console.error(chalk.dim("Run `zz --help` to see available commands."));
  process.exit(1);
}

async function handleStopAction(): Promise<void> {
  try {
    const result = await runStopCommand();
    const exitCode =
      result.status === "error" || result.status === "refused" ? 1 : 0;
    process.exit(exitCode);
  } catch (err) {
    renderError(err, stdoutWriter);
    process.exit(1);
  }
}

async function handleStatusAction(): Promise<void> {
  try {
    const report = await runStatusCommand();
    // exit code: 0 running, 1 running-unhealthy, 2 stopped, 3 stale
    const exitCode =
      report.status === "running"
        ? 0
        : report.status === "running-unhealthy"
          ? 1
          : report.status === "stopped"
            ? 2
            : 3;
    process.exit(exitCode);
  } catch (err) {
    renderError(err, stdoutWriter);
    process.exit(1);
  }
}

program
  .name("zhixing")
  .description("知行 — 智能体引擎")
  .version(ZHIXING_CLI_VERSION)
  .option("--log", "启用诊断 dump 到 ~/.zhixing/logs/（LLM raw chunk + keypress 路径） —— 排查渲染 / 上下文 / 流式 / 按键输入问题用")
  .action(async (options: {
    log?: boolean;
  }) => {
    try {
      // cli 交互模式（REPL）静默 core 诊断 log（[llm] 请求 / 工具调用等），
      // 避免污染对话 UI；serve 及其子命令各自独立 action 不受影响，
      // 保持默认 console.log 输出供运维与调试观察
      setDiagnosticLogger(() => {});
      // 诊断 dump 启用配置 —— 必须在 startRepl 触发 dump 预热之前调用，
      // 否则 singleton cached 为 NOOP 后续无法激活。--log 是唯一开关（无 ENV 兜底）：
      //   - llm-chunk-dump：LLM stream 完整事件流（含 codepoint hex）
      //   - keypress-dump：SelectOperationRegion keypress 路径每节点（confirmation
      //     panel 字符输入异常调查用）
      // 两个 dump 写到不同文件，互不干扰；--log 单一开关统一启用，避免多 flag
      // 心智负担与 PowerShell env var 持久化陷阱。
      const dumpEnabled = options.log === true;
      configureLlmChunkDump(dumpEnabled);
      configureKeypressDump(dumpEnabled);
      // 启动期检查——先确保必要字段就绪
      const startupResult = await runStartupCheck({
        mode: "repl",
      });
      handleStartupResult(startupResult);

      await startRepl();
    } catch (err) {
      renderError(err, stdoutWriter);
      process.exit(1);
    }
  });

// ─── zhixing status / stop（用户运行控制入口） ───
program
  .command("status")
  .description("查看知行运行状态")
  .action(handleStatusAction);

program
  .command("stop")
  .description("停止知行")
  .action(handleStopAction);

// ─── zhixing serve（常驻服务模式） ───
const serveCmd = program
  .command("serve")
  .description("启动常驻服务（HTTP + WebSocket + 调度器）")
  .option("--port <port>", "监听端口", (v) => parseInt(v, 10))
  .option("--host <host>", "监听地址（默认 127.0.0.1，仅本地访问）")
  .action(async (options: {
    port?: number;
    host?: string;
  }) => {
    try {
      await runServeCommand({
        port: options.port,
        host: options.host,
      });
      process.exit(0);
    } catch (err) {
      renderError(err, stdoutWriter);
      process.exit(1);
    }
  });

// zhixing serve logs —— 查看日志（默认尾部 50 行；--tail 持续跟踪）
serveCmd
  .command("logs")
  .description("查看后台宿主日志")
  .option("--tail", "持续跟踪（类 tail -f）")
  .option("--lines <n>", "显示行数（默认 50）", (v) => parseInt(v, 10))
  .action(async (options: { tail?: boolean; lines?: number }) => {
    try {
      await runLogsCommand({ tail: options.tail, lines: options.lines });
      process.exit(0);
    } catch (err) {
      renderError(err, stdoutWriter);
      process.exit(1);
    }
  });

// pnpm run 会将 `--` 原样传递给脚本，导致 Commander 将后续选项误认为位置参数。
// 移除 argv 中首个独立的 `--`，使 `-p` 等选项正常解析。
const argv = [...process.argv];
const dashIdx = argv.indexOf("--", 2);
if (dashIdx !== -1) {
  argv.splice(dashIdx, 1);
}

// ─── 启动期日志守门 ───
//
// 在任何子命令分发之前巡检一次 ~/.zhixing/logs/ 子目录,把每个目录裁剪到上限。
// 与 llm-chunk-dump 内部写盘内联的 prune 形成双 trigger 互补:启动巡检覆盖
// 进程间累积 + 用户从此不再写盘的冷目录;写盘内联覆盖单进程内累积。两者
// 覆盖区间不重叠,缺任何一边都会留下"日志无限增长"的真实漏洞。
//
// 全模式覆盖:本调用位于 program.parseAsync 之前,无论后续分发到 REPL /
// serve 等哪个 action,都已经过守门。pruneAllLogs 内部 swallow 一切 IO
// 失败,不会影响后续主流程。
rejectUnknownCommandPath(argv, program);
pruneAllLogs();

program.parseAsync(argv).catch((err: unknown) => {
  renderError(err, stdoutWriter);
  process.exit(1);
});
