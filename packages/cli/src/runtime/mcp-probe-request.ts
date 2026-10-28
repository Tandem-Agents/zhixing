/**
 * MCP 探测 runner 的一次请求：校验请求、经注入的创建工厂建外部命令、调用原 probeServer，
 * 并在回复之前确认本次建的外部命令都已由 owner 收束。入口只做帧收发，这里可单独测试。
 */
import { probeServer, type McpServerSpec, type McpStdioProcessFactory } from "@zhixing/mcp";
import type { NetworkPolicy } from "@zhixing/network";

export interface McpProbeRunnerRequest {
  readonly v: 1;
  readonly spec: McpServerSpec;
  readonly proxy?: NetworkPolicy["proxy"];
  readonly timeoutMs: number;
}
export type McpProbeRunnerResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** probeServer 关闭传输时已按 SDK 节奏升级终止并等回执；这里再给每个外部命令有限期限，到期强杀再等一次。 */
const CHILD_CLOSE_GRACE_MS = 5_000;

export async function handleMcpProbeRequest(
  message: unknown,
  createStdioProcess: McpStdioProcessFactory,
  closeGraceMs = CHILD_CLOSE_GRACE_MS,
): Promise<McpProbeRunnerResult> {
  const request = message as Partial<McpProbeRunnerRequest> | null;
  if (!request || request.v !== 1 || !request.spec || typeof request.spec.serverId !== "string" ||
      (request.spec.transport !== "stdio" && request.spec.transport !== "http") ||
      typeof request.timeoutMs !== "number" || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
    return { ok: false, error: "MCP 验证请求无效" };
  }
  const owners: ReturnType<McpStdioProcessFactory>[] = [];
  const result = await probeServer(request.spec, {
    timeoutMs: request.timeoutMs,
    ...(request.proxy ? { proxy: request.proxy } : {}),
    createStdioProcess: (command, args, env, signal) => {
      const owner = createStdioProcess(command, args, env, signal);
      owners.push(owner);
      return owner;
    },
  });
  // 外部命令守 S 的归属合同：回执拒绝或等不到时不回成功，也不把探测结果当作已收束
  for (const owner of owners) {
    if (!await closedWithin(owner, closeGraceMs)) return { ok: false, error: "MCP 外部命令未能确认结束" };
  }
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

async function closedWithin(owner: ReturnType<McpStdioProcessFactory>, graceMs: number): Promise<boolean> {
  const receipt = owner.closed.then(() => true, () => false);
  const within = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([receipt, new Promise<"late">(resolve => { timer = setTimeout(() => resolve("late"), graceMs); })]); }
    finally { clearTimeout(timer); }
  };
  let value = await within();
  if (value === "late") { owner.child.kill("SIGKILL"); value = await within(); }
  return value === true;
}
