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
import { configureLlmChunkDump, pruneAllLogs } from "./output/llm-chunk-dump.js";
import { configureKeypressDump } from "./security/keypress-dump.js";
import { runStartupCheck, type StartupCheckResult } from "./startup.js";
import { runOnce } from "./run-agent.js";
import { startRepl } from "./repl.js";
import { renderError } from "./render.js";
import { createStdoutWriter } from "./screen/index.js";
import { runServeCommand } from "./serve/command.js";
import { runStopCommand } from "./serve/stop.js";
import { runStatusCommand } from "./serve/status.js";
import { runLogsCommand } from "./serve/logs.js";
import { runRpcCommand, printRpcHelp } from "./rpc/command.js";

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

program
  .name("zhixing")
  .description("知行 — 智能体引擎")
  .version("0.1.0")
  .option("-p, --print <prompt>", "单次模式：执行 prompt 后退出")
  .option("-w, --workspace <path>", "指定工作区目录（安全信任边界）")
  .option("--log", "启用诊断 dump 到 ~/.zhixing/logs/（LLM raw chunk + keypress 路径） —— 排查渲染 / 上下文 / 流式 / 按键输入问题用")
  .action(async (options: {
    print?: string;
    workspace?: string;
    log?: boolean;
  }) => {
    try {
      // cli 交互模式（REPL / -p）静默 core 诊断 log（[llm] 请求 / 工具调用等），
      // 避免污染对话 UI；serve / rpc / serve sub-commands 各自独立 action 不受影响，
      // 保持默认 console.log 输出供运维与调试观察
      setDiagnosticLogger(() => {});
      // 诊断 dump 启用配置 —— 必须在 startRepl / runOnce 触发 dump 预热之前调用，
      // 否则 singleton cached 为 NOOP 后续无法激活。--log 是唯一开关（无 ENV 兜底）：
      //   - llm-chunk-dump：LLM stream 完整事件流（含 codepoint hex）
      //   - keypress-dump：SelectOperationRegion keypress 路径每节点（confirmation
      //     panel 字符输入异常调查用）
      // 两个 dump 写到不同文件，互不干扰；--log 单一开关统一启用，避免多 flag
      // 心智负担与 PowerShell env var 持久化陷阱。
      const dumpEnabled = options.log === true;
      configureLlmChunkDump(dumpEnabled);
      configureKeypressDump(dumpEnabled);
      // 启动期检查——任何模式（-p / REPL）下都先确保必要字段就绪
      const startupResult = await runStartupCheck({
        cwd: process.cwd(),
        mode: "repl",
      });
      handleStartupResult(startupResult);

      if (options.print) {
        // runOnce 内部自管 renderer / 渲染装饰,调用方仅传入业务参数。
        // turn 终止反馈由 status-bar 单点接管（runOnce 无 status-bar——用户看到 stdout
        // 流式输出 + shell prompt 即知 turn 结束，无需额外摘要行）。
        await runOnce({
          prompt: options.print,
          workspace: options.workspace,
        });
        process.exit(0);
      }

      await startRepl({
        workspace: options.workspace,
      });
    } catch (err) {
      renderError(err, stdoutWriter);
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
      renderError(err, stdoutWriter);
      process.exit(2);
    }
  });

// ─── zhixing serve（常驻服务模式） ───
const serveCmd = program
  .command("serve")
  .description("启动常驻服务（HTTP + WebSocket + 调度器）")
  .option("--port <port>", "监听端口", (v) => parseInt(v, 10))
  .option("--host <host>", "监听地址（默认 127.0.0.1，仅本地访问）")
  .option("-w, --workspace <path>", "工作区目录")
  .option("--daemon", "后台模式：脱离终端独立运行")
  .action(async (options: {
    port?: number;
    host?: string;
    workspace?: string;
    daemon?: boolean;
  }) => {
    try {
      await runServeCommand({
        port: options.port,
        host: options.host,
        workspace: options.workspace,
        daemon: options.daemon,
      });
      process.exit(0);
    } catch (err) {
      renderError(err, stdoutWriter);
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
      renderError(err, stdoutWriter);
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
      renderError(err, stdoutWriter);
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
// 全模式覆盖:本调用位于 program.parseAsync 之前,无论后续分发到 REPL / -p /
// serve / rpc 等哪个 action,都已经过守门。pruneAllLogs 内部 swallow 一切 IO
// 失败,不会影响后续主流程。
pruneAllLogs();

program.parseAsync(argv).catch((err: unknown) => {
  renderError(err, stdoutWriter);
  process.exit(1);
});
