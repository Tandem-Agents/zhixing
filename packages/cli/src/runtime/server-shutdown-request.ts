import { protocolDigest } from "@zhixing/core/protocol";
import type { ServerShutdownParams } from "@zhixing/server";

/** A retry of the same intent on the same Host must resume its durable stop. */
export function serverShutdownRequest(
  target: { pid: number; startedAt: string },
  input: Omit<ServerShutdownParams, "requestId"> = {},
): ServerShutdownParams {
  if (!Number.isSafeInteger(target.pid) || target.pid <= 0 || !target.startedAt)
    throw Error("无法确认待停止服务的身份");
  const intent = {
    reason: input.reason ?? "rpc.server.shutdown",
    strategy: input.strategy ?? "immediate",
    timeoutMs: input.timeoutMs ?? 30_000,
  };
  return { requestId: protocolDigest("CliHostStopRequest", 1, { pid: target.pid, startedAt: target.startedAt, ...intent }), ...intent };
}
