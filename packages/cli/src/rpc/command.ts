/**
 * `zhixing rpc <method> [args]` — 一次性 RPC 调用
 *
 * 流程：
 * 1. 发现 server（PID + token）
 * 2. 连接 + auth
 * 3. 调用 method
 * 4. 特殊处理：
 *    - session.send → 流式打印 delta，等 session.complete 才退出
 *    - --watch → 不发请求，仅订阅所有通知直到 Ctrl+C
 * 5. 打印结果，退出
 *
 * 设计要点：
 * - 失败给清晰原因（"server not running" 而不是 "ECONNREFUSED"）
 * - --raw 输出适合管道（jq）
 * - 退出码：0 = 成功，1 = RPC error，2 = 客户端错误（连不上等）
 */

import chalk from "chalk";
import {
  createRpcClient,
  discoverServer,
  RpcClientError,
  ServerNotRunningError,
  type RpcClient,
} from "@zhixing/server";
import { parseRpcArgs, ArgParseError } from "./args.js";
import {
  formatResult,
  formatError,
  formatNotificationHeader,
  formatNotificationParams,
  formatStreamDelta,
} from "./format.js";

// ─── Help 文本 ───

export function printRpcHelp(): void {
  const c = chalk; // alias
  console.log(`
${c.bold("zhixing rpc")} — 连接本地 server 并调用 JSON-RPC 方法

${c.bold("用法：")}
  zhixing rpc <method> [args...]   ${c.dim("# 一次性调用")}
  zhixing rpc --watch              ${c.dim("# 仅监听通知")}

${c.bold("示例：")}
  ${c.cyan("zhixing rpc health")}
  ${c.cyan('zhixing rpc session.send "你好"')}            ${c.dim("# 位置参数")}
  ${c.cyan('zhixing rpc session.send --text="你好"')}     ${c.dim("# 键值参数")}
  ${c.cyan("zhixing rpc session.list")}
  ${c.cyan("zhixing rpc schedule.list")}
  ${c.cyan("zhixing rpc schedule.create --json '{...}'")}  ${c.dim("# 复杂参数")}
  ${c.cyan("zhixing rpc schedule.delete task_abc123")}
  ${c.cyan("zhixing rpc health --raw | jq")}              ${c.dim("# 管道")}

${c.bold("参数形式（按优先级）：")}
  --json '{...}'                    ${c.dim("完整 params JSON")}
  --key=value / --key value         ${c.dim("键值（true/false/数字自动转换）")}
  positional                        ${c.dim("部分方法支持：session.send/history/abort/delete, schedule.delete/run")}

${c.bold("选项：")}
  --watch                           ${c.dim("仅监听所有通知，Ctrl+C 退出")}
  --raw                             ${c.dim("单行 JSON 输出，适合管道")}
  --json <json>                     ${c.dim("params 的完整 JSON 字符串")}

${c.bold("退出码：")}
  0 = 成功          1 = RPC 错误          2 = 客户端错误 (连不上 / 参数错)

${c.bold("server 发现：")}
  自动读 ~/.zhixing/server.pid 和 server.token，无需手动配置。
  server 未运行 → 提示 ${c.cyan("zhixing serve")} 启动。

${c.bold("完整文档：")}
  ${c.cyan("packages/cli/README.md")}${c.dim(" — 含方法速览、事件列表、故障排查")}
`);
}

export interface RpcCommandInput {
  method: string;
  /** method 之后所有 token（args + flags） */
  rest: string[];
}

export type ExitCode = 0 | 1 | 2;

/**
 * 执行 rpc 命令。返回 exit code（不直接 process.exit，便于测试）。
 */
export async function runRpcCommand(input: RpcCommandInput): Promise<ExitCode> {
  // ─── 解析参数 ───
  let parsed;
  try {
    parsed = parseRpcArgs(input.method, input.rest);
  } catch (err) {
    if (err instanceof ArgParseError) {
      console.error(chalk.red("✗ ") + err.message);
      return 2;
    }
    throw err;
  }
  const { params, flags } = parsed;
  const raw = flags.raw === true;

  // ─── 发现 server ───
  let endpoint;
  try {
    endpoint = await discoverServer();
  } catch (err) {
    if (err instanceof ServerNotRunningError) {
      console.error(chalk.red("✗ ") + err.message);
      if (err.hint) console.error(chalk.dim("  " + err.hint));
      return 2;
    }
    throw err;
  }

  // ─── 连接 + auth ───
  const client = createRpcClient({ url: endpoint.url });
  let exitCode: ExitCode = 0;
  try {
    await client.connect();
    await client.authenticate(endpoint.token, { id: "zhixing-rpc-cli" });

    if (flags.watch) {
      exitCode = await runWatchMode(client, raw);
    } else if (input.method === "session.send") {
      exitCode = await runSessionSend(client, params, raw);
    } else {
      exitCode = await runOneShot(client, input.method, params, raw);
    }
  } catch (err) {
    if (err instanceof RpcClientError) {
      console.error(formatError(err.code, err.message, err.data));
      exitCode = 1;
    } else {
      console.error(chalk.red("✗ ") + (err instanceof Error ? err.message : String(err)));
      exitCode = 2;
    }
  } finally {
    await client.close();
  }

  return exitCode;
}

// ─── 模式：普通一次性调用 ───

async function runOneShot(
  client: RpcClient,
  method: string,
  params: unknown,
  raw: boolean,
): Promise<ExitCode> {
  const result = await client.request(method, params);
  console.log(formatResult(result, raw));
  return 0;
}

// ─── 模式：session.send 流式 ───

async function runSessionSend(
  client: RpcClient,
  params: unknown,
  raw: boolean,
): Promise<ExitCode> {
  if (!params || typeof params !== "object") {
    console.error(chalk.red("✗ ") + "session.send requires params (text or --text)");
    return 2;
  }

  let resolveDone: (code: ExitCode) => void;
  const done = new Promise<ExitCode>((r) => {
    resolveDone = r;
  });

  // 订阅通知（在发请求之前，避免 race）
  const offDelta = client.onNotification("session.delta", (notif) => {
    const n = notif as { sessionId: string; delta: unknown };
    const text = formatStreamDelta(n.delta);
    if (text !== null) process.stdout.write(text);
  });
  const offComplete = client.onNotification("session.complete", (notif) => {
    const n = notif as { sessionId: string; result?: { reason?: string } };
    const reason = n.result?.reason ?? "unknown";
    if (raw) {
      console.log("\n" + JSON.stringify(notif));
    } else {
      const colored =
        reason === "completed"
          ? chalk.green(reason)
          : reason === "error"
            ? chalk.red(reason)
            : chalk.yellow(reason);
      console.log("\n" + chalk.dim(`(session ${n.sessionId} → ${colored})`));
    }
    offDelta();
    offComplete();
    resolveDone(reason === "completed" ? 0 : 1);
  });

  const sendResult = await client.request<{ sessionId: string }>("session.send", params);
  if (!raw) {
    console.error(chalk.dim(`(sessionId: ${sendResult.sessionId})`));
  }

  return done;
}

// ─── 模式：watch（仅监听通知） ───

async function runWatchMode(client: RpcClient, raw: boolean): Promise<ExitCode> {
  console.error(chalk.dim("Watching server notifications. Ctrl+C to exit."));
  console.error("");

  client.onAnyNotification((method, params) => {
    if (raw) {
      console.log(JSON.stringify({ method, params }));
      return;
    }
    console.log(formatNotificationHeader(method));
    const formatted = formatNotificationParams(params, raw);
    if (formatted) console.log(formatted);
    console.log("");
  });

  // 永不 resolve，等待 SIGINT
  await new Promise<void>(() => {});
  return 0;
}
