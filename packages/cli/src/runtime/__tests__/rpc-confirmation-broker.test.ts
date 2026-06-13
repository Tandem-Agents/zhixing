/**
 * RpcConfirmationBroker —— 确认链路渲染端适配器。
 *
 * 锁住:
 *   - pending 推送(含完整 request 投影)还原为 onRequest 通知
 *   - 无完整投影的 pending 不进面板(非可信投影防御)
 *   - resolve 走 confirmation.resolve RPC 回程;失败经 onResolveError 上报
 *   - dispose 退订且迟到 resolve 本地拒绝、不连宿主
 */

import { describe, it, expect, vi } from "vitest";
import type { ConfirmationRequest } from "@zhixing/core";
import { RpcConfirmationBroker } from "../rpc-confirmation-broker.js";
import { makeFakeHostLink } from "./fake-host-link.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeRequest(id: string): ConfirmationRequest {
  const now = Date.now();
  return {
    id,
    tool: "bash",
    toolInput: { command: "ls" },
    workingDirectory: "/tmp",
    display: {
      title: "Bash 命令",
      body: { kind: "bash", command: "ls", commandPreview: "ls" },
      cwd: "/tmp",
    },
    options: [{ kind: "allow-once", label: "允许一次" }],
    sessionType: "interactive",
    contextId: { kind: "main" },
    createdAt: now,
    expiresAt: now + 60_000,
  } as ConfirmationRequest;
}

describe("RpcConfirmationBroker", () => {
  it("pending 推送(含完整 request)还原为 onRequest;无 request 投影忽略", () => {
    const fake = makeFakeHostLink();
    const broker = new RpcConfirmationBroker({ link: fake.link });

    const received: ConfirmationRequest[] = [];
    broker.onRequest((req) => received.push(req));

    fake.notify("confirmation.pending", {
      requestId: "r1",
      operationSummary: "Bash 命令",
      request: makeRequest("r1"),
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe("r1");
    expect(received[0]?.options).toHaveLength(1);

    // 非可信投影(无完整 request)——不进面板
    fake.notify("confirmation.pending", {
      requestId: "r2",
      operationSummary: "仅摘要",
    });
    expect(received).toHaveLength(1);

    broker.dispose();
  });

  it("resolve 走 RPC 回程;失败经 onResolveError 上报", async () => {
    const fake = makeFakeHostLink();
    const errors: Array<{ requestId: string }> = [];
    const broker = new RpcConfirmationBroker({
      link: fake.link,
      onResolveError: (_err, requestId) => errors.push({ requestId }),
    });

    expect(broker.resolve("r1", { kind: "allow-once" })).toBe(true);
    await flush();
    expect(fake.requests).toEqual([
      {
        method: "confirmation.resolve",
        params: { requestId: "r1", decision: { kind: "allow-once" } },
      },
    ]);

    fake.setResponder(() => {
      throw new Error("宿主拒绝");
    });
    broker.resolve("r2", { kind: "deny" });
    await flush();
    expect(errors).toEqual([{ requestId: "r2" }]);

    broker.dispose();
  });

  it("dispose 退订:后续推送不再分发,迟到 resolve 不连宿主", async () => {
    const fake = makeFakeHostLink();
    const broker = new RpcConfirmationBroker({ link: fake.link });
    const received: unknown[] = [];
    broker.onRequest((req) => received.push(req));

    broker.dispose();
    expect(fake.handlerCount("confirmation.pending")).toBe(0);
    fake.notify("confirmation.pending", { request: makeRequest("r9") });
    expect(received).toEqual([]);
    expect(broker.resolve("r9", { kind: "deny" })).toBe(false);
    await flush();
    expect(fake.requests).toEqual([]);
  });
});
