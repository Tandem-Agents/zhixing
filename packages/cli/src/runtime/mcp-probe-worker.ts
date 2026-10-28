/**
 * 一次性 MCP 探测 runner：终端经受管辅助进程创建它，MCP SDK 与传输的加载、建链、列工具都在这里，
 * 终端应用进程的事件循环不被这些同步加载卡住。只经私有帧收一份请求、回一份结果后退出；
 * stdio 的外部 MCP 命令仍经 S 登记创建（本进程是只能创建外部命令的嵌套创建所有者），回复前确认它们已收束。
 */
import { LogWorkerChannel } from "../logging/terminal-worker.js";
import { createTerminalOwnedProcessFactory } from "../terminal/host-launch.js";
import { handleMcpProbeRequest } from "./mcp-probe-request.js";

export type { McpProbeRunnerRequest, McpProbeRunnerResult } from "./mcp-probe-request.js";

const mode = process.env.ZHIXING_MCP_PROBE_STDIO;
delete process.env.ZHIXING_MCP_PROBE_STDIO;
if (mode !== "1") throw Error("mcp-probe-channel-mode");
const channel = new LogWorkerChannel(process.stdin, process.stdout);
let handled = false;
channel.on("message", (message: unknown) => {
  if (handled) return;
  handled = true;
  const createStdioProcess = (command: string, args: readonly string[], env: NodeJS.ProcessEnv, signal?: AbortSignal) =>
    createTerminalOwnedProcessFactory("mcp-probe")(command, args, { env, ...(signal ? { signal } : {}), deadline: Date.now() + 5000 });
  void handleMcpProbeRequest(message, createStdioProcess).then(
    (result) => channel.send(result, () => process.exit(0)),
    (error: unknown) => channel.send({ ok: false, error: error instanceof Error ? error.message : String(error) }, () => process.exit(0)),
  );
});
// 父端断开（取消、终端退出）即结束；外部命令由 S 按创建所有者回收
channel.once("disconnect", () => process.exit(0));
channel.on("error", () => process.exit(1));
