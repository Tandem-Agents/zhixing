/**
 * 知行 CLI 入口
 *
 * 两种运行模式：
 * - 单次模式：zhixing -p "prompt" → 流式输出 → 退出
 * - 交互模式：zhixing → REPL 多轮对话
 */

import chalk from "chalk";
import { Command } from "commander";
import { setDiagnosticLogger } from "@zhixing/core";
import { runStartupCheck, type StartupCheckResult } from "./startup.js";
import { runOnce } from "./run-agent.js";
import { startRepl } from "./repl.js";
import { renderSummary, renderError } from "./render.js";
import { runServeCommand } from "./serve/command.js";
import { runStopCommand } from "./serve/stop.js";
import { runStatusCommand } from "./serve/status.js";
import { runLogsCommand } from "./serve/logs.js";
import { runRpcCommand, printRpcHelp } from "./rpc/command.js";

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

program
  .name("zhixing")
  .description("知行 — 智能体引擎")
  .version("0.1.0")
  .option("-p, --print <prompt>", "单次模式：执行 prompt 后退出")
  .option("-m, --model <model>", "指定模型")
  .option("--provider <provider>", "指定 Provider ID")
  .option("-w, --workspace <path>", "指定工作区目录（安全信任边界）")
  .option("-c, --continue", "继续当前项目最近的会话")
  .option("-r, --resume [id]", "恢复指定会话（不带 ID 则交互选择）")
  .option("-n, --name <name>", "为会话命名")
  .action(async (options: {
    print?: string;
    model?: string;
    provider?: string;
    workspace?: string;
    continue?: boolean;
    resume?: string | true;
    name?: string;
  }) => {
    try {
      // cli 交互模式（REPL / -p）静默 core 诊断 log（[llm] 请求 / 工具调用等），
      // 避免污染对话 UI；serve / rpc / serve sub-commands 各自独立 action 不受影响，
      // 保持默认 console.log 输出供运维与调试观察
      setDiagnosticLogger(() => {});
      // 启动期检查——任何模式（-p / REPL）下都先确保必要字段就绪
      const startupResult = await runStartupCheck({
        cwd: process.cwd(),
        mode: "repl",
      });
      handleStartupResult(startupResult);

      if (options.print) {
        // runOnce 内部自管 renderer / spinner / 渲染装饰,调用方仅传入业务参数。
        const { agentResult, durationMs } = await runOnce({
          prompt: options.print,
          model: options.model,
          provider: options.provider,
          workspace: options.workspace,
        });
        renderSummary(agentResult, durationMs);
        process.exit(0);
      }

      await startRepl({
        model: options.model,
        provider: options.provider,
        workspace: options.workspace,
        continue: options.continue,
        resume: options.resume,
        name: options.name,
      });
    } catch (err) {
      renderError(err);
      process.exit(1);
    }
  });

// ─── zhixing rpc <method> [args]（连接 server 的 RPC 客户端） ───
//
// 设计：commander 把 method 之后的所有 token（含 --flag）原样收到 rest，
// 由 rpc/args.ts 自己解析——避免 commander 对未知 flag 报错。
program
  .command("rpc [method] [args...]")
  .description("调用本地 server 的 RPC 方法（自动发现 + auth）。--watch 模式无需 method")
  .allowUnknownOption(true)
  .helpOption(false)
  .action(async (rawMethod: string | undefined, _args: string[], _opts, cmd) => {
    // 用 allowUnknownOption + [method] 时，commander 会把 --flag 错误地塞进 method。
    // 解决：从 process.argv 重新提取真实的 method 和 token 列表。
    const argv = process.argv;
    const cmdIdx = argv.indexOf(cmd.name());
    const allTokens = cmdIdx >= 0 ? argv.slice(cmdIdx + 1) : [];

    // 第一个非 -- 开头的 token 是真正的 method（可能没有）
    let method: string | undefined;
    const tokens: string[] = [];
    let methodPicked = false;
    for (const t of allTokens) {
      if (!methodPicked && !t.startsWith("--")) {
        method = t;
        methodPicked = true;
      } else {
        tokens.push(t);
      }
    }
    void rawMethod; // commander 解析的值不再使用

    // --help / -h 拦截：打印自定义 help 文本
    if (tokens.includes("--help") || tokens.includes("-h") || method === "help") {
      printRpcHelp();
      process.exit(0);
    }

    const isWatch = tokens.includes("--watch");
    if (!method && !isWatch) {
      printRpcHelp();
      process.exit(2);
    }

    try {
      const exitCode = await runRpcCommand({
        method: method ?? "__watch__",
        rest: tokens,
      });
      process.exit(exitCode);
    } catch (err) {
      renderError(err);
      process.exit(2);
    }
  });

// ─── zhixing serve（常驻服务模式） ───
const serveCmd = program
  .command("serve")
  .description("启动常驻服务（HTTP + WebSocket + 调度器）")
  .option("--port <port>", "监听端口", (v) => parseInt(v, 10))
  .option("--host <host>", "监听地址（默认 127.0.0.1，仅本地访问）")
  .option("-m, --model <model>", "默认模型（每个会话可覆盖）")
  .option("--provider <provider>", "Provider ID")
  .option("-w, --workspace <path>", "工作区目录")
  .option("--daemon", "后台模式：脱离终端独立运行")
  .action(async (options: {
    port?: number;
    host?: string;
    model?: string;
    provider?: string;
    workspace?: string;
    daemon?: boolean;
  }) => {
    try {
      await runServeCommand({
        port: options.port,
        host: options.host,
        model: options.model,
        provider: options.provider,
        workspace: options.workspace,
        daemon: options.daemon,
      });
      process.exit(0);
    } catch (err) {
      renderError(err);
      process.exit(1);
    }
  });

// zhixing serve stop —— 停止后台 daemon
serveCmd
  .command("stop")
  .description("停止后台运行的 server（SIGTERM，30s 超时 SIGKILL 兜底）")
  .option("--timeout <ms>", "优雅停机超时（ms）", (v) => parseInt(v, 10))
  .action(async (options: { timeout?: number }) => {
    try {
      const result = await runStopCommand({ timeoutMs: options.timeout });
      const exitCode = result.status === "error" ? 1 : 0;
      process.exit(exitCode);
    } catch (err) {
      renderError(err);
      process.exit(1);
    }
  });

// zhixing serve logs —— 查看日志（默认尾部 50 行；--tail 持续跟踪）
serveCmd
  .command("logs")
  .description("查看后台 daemon 日志")
  .option("--tail", "持续跟踪（类 tail -f）")
  .option("--lines <n>", "显示行数（默认 50）", (v) => parseInt(v, 10))
  .action(async (options: { tail?: boolean; lines?: number }) => {
    try {
      await runLogsCommand({ tail: options.tail, lines: options.lines });
      process.exit(0);
    } catch (err) {
      renderError(err);
      process.exit(1);
    }
  });

// zhixing serve status —— 查询后台 daemon 状态
serveCmd
  .command("status")
  .description("查询 server 运行状态（running / running-unhealthy / stopped / stale）")
  .option("--json", "输出 JSON（便于脚本解析）")
  .action(async (options: { json?: boolean }) => {
    try {
      const report = await runStatusCommand({ json: options.json });
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
      renderError(err);
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

program.parseAsync(argv).catch((err: unknown) => {
  renderError(err);
  process.exit(1);
});
