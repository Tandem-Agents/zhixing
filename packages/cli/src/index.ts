/**
 * 知行 CLI 入口
 *
 * 两种运行模式：
 * - 单次模式：zhixing -p "prompt" → 流式输出 → 退出
 * - 交互模式：zhixing → REPL 多轮对话
 *
 * 配置加载顺序（由 @zhixing/providers 处理）：
 * - 环境变量 → 项目 zhixing.config.json → 全局 ~/.zhixing/config.json
 */

import { Command } from "commander";
import { runOnce } from "./run-agent.js";
import { startRepl } from "./repl.js";
import { createRenderer, renderSummary, renderError } from "./render.js";
import { runServeCommand } from "./serve/command.js";
import { runRpcCommand, printRpcHelp } from "./rpc/command.js";

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
      if (options.print) {
        const renderer = createRenderer();
        renderer.startThinking();

        const { agentResult, durationMs } = await runOnce({
          prompt: options.print,
          model: options.model,
          provider: options.provider,
          workspace: options.workspace,
          onYield: (e) => renderer.handleEvent(e),
        });

        renderer.stop();
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
program
  .command("serve")
  .description("启动常驻服务（HTTP + WebSocket + 调度器）")
  .option("--port <port>", "监听端口", (v) => parseInt(v, 10))
  .option("--host <host>", "监听地址（默认 127.0.0.1，仅本地访问）")
  .option("-m, --model <model>", "默认模型（每个会话可覆盖）")
  .option("--provider <provider>", "Provider ID")
  .option("-w, --workspace <path>", "工作区目录")
  .action(async (options: {
    port?: number;
    host?: string;
    model?: string;
    provider?: string;
    workspace?: string;
  }) => {
    try {
      await runServeCommand({
        port: options.port,
        host: options.host,
        model: options.model,
        provider: options.provider,
        workspace: options.workspace,
      });
      process.exit(0);
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
