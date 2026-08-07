/**
 * RpcConfirmationBroker —— 确认链路渲染端适配器。
 *
 * 锁住:
 *   - pending 推送(含完整 request 投影)还原为 onRequest 通知
 *   - refresh 恢复连接建立前错过的、只属于当前接入面的 pending
 *   - 无完整投影的 pending 不进面板(非可信投影防御)
 *   - resolve 走 confirmation.resolve RPC 回程;失败经 onResolveError 上报
 *   - dispose 退订且迟到 resolve 本地拒绝、不连宿主
 */

import { describe, it, expect, vi } from "vitest";
import type { ConfirmationRequest } from "@zhixing/core";
import { RpcClientClosedError } from "@zhixing/server";
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

  it("refresh 恢复错过的 pending 且不重复展示已可见请求", async () => {
    const fake = makeFakeHostLink();
    const request = makeRequest("r-missed");
    fake.setResponder((method) => method === "confirmation.list"
      ? { items: [{ requestId: request.id, request }] }
      : { ok: true });
    const broker = new RpcConfirmationBroker({ link: fake.link });
    const received: string[] = [];
    broker.onRequest((entry) => received.push(entry.id));

    await broker.refresh();
    await broker.refresh();

    expect(received).toEqual(["r-missed"]);
    expect(fake.requests).toEqual([
      { method: "confirmation.list", params: undefined },
      { method: "confirmation.list", params: undefined },
    ]);
    broker.dispose();
  });

  it("决定失败后重新拉取仍耐久 pending", async () => {
    const fake = makeFakeHostLink();
    const request = makeRequest("r-requeued");
    const errors: unknown[] = [];
    fake.setResponder((method) => {
      if (method === "confirmation.resolve") throw new Error("暂时未生效");
      if (method === "confirmation.list") {
        return { items: [{ requestId: request.id, request }] };
      }
      return {};
    });
    const broker = new RpcConfirmationBroker({
      link: fake.link,
      onResolveError: (error) => errors.push(error),
    });
    const received: string[] = [];
    broker.onRequest((entry) => received.push(entry.id));
    fake.notify("confirmation.pending", { request });

    broker.resolve(request.id, { kind: "allow-once" });

    await vi.waitFor(() => expect(received).toEqual([request.id, request.id]));
    expect(errors).toHaveLength(1);
    broker.dispose();
  });

  it("断线以同一 requestId+decision 重放,直至宿主受理;非断线错误不重试", async () => {
    const fake = makeFakeHostLink();
    const errors: unknown[] = [];
    const broker = new RpcConfirmationBroker({
      link: fake.link,
      onResolveError: (err) => errors.push(err),
    });
    let attempt = 0;
    fake.setResponder(() => {
      attempt += 1;
      if (attempt <= 2) throw new RpcClientClosedError("response lost");
      return { ok: true };
    });

    expect(broker.resolve("r-retry", { kind: "allow-once" })).toBe(true);
    await vi.waitFor(() => {
      expect(fake.requests).toHaveLength(3);
    });
    expect(fake.requests[1]).toEqual(fake.requests[0]);
    expect(fake.requests[2]).toEqual(fake.requests[0]);
    expect(errors).toEqual([]);

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
