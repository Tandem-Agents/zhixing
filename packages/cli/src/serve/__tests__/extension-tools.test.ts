import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileAuthorityCommitLog, FileArtifactStore } from "@zhixing/core/authority";
import { ExtensionApplication } from "@zhixing/core/extensions/application";
import { createExtensionTools } from "../extension-tools.js";
import { createExtensionContinuation } from "../extension-continuation.js";
import { runContextStorage } from "@zhixing/orchestrator/runtime";
import type { ExtensionOperation } from "@zhixing/core/extensions/contracts";
import { buildExtensionMethods } from "../../../../server/src/rpc/methods/extensions.js";

describe("extension product bindings", { timeout: 20_000 }, () => {
  it("admits the tool-generated operation identity through the real Authority application", async () => {
    const root = await mkdtemp(join(tmpdir(), "extension-tool-"));
    try {
      const application = new ExtensionApplication({ log: () => new FileAuthorityCommitLog(join(root, "authority"), new FileArtifactStore(join(root, "facts"))), assertOwner() {} });
      const [tool] = createExtensionTools({ invoke: async request => {
        if (request.action !== "prepare") throw new Error("unexpected command");
        await application.prepare(request.id, request.instanceId, request.source);
        return { snapshot: await application.list(), targetDeviceId: "local" };
      } });
      await runContextStorage.run({ conversationId: "scene", lineage: "main" } as never, async () => {
        const result = await tool!.call({ action: "prepare", instanceId: "my-app" }, { workingDirectory: root, turnId: "turn", toolCallId: "call", userIntent: "接入 APP",
          turnOrigin: { channel: "original", triggeredBy: "owner", target: { channelId: "original", to: "owner", threadId: undefined } } });
        expect(result.isError).not.toBe(true);
        expect(JSON.parse(result.content)).toMatchObject({ snapshot: { operations: [{ phase: "preparing", source: { request: "接入 APP" } }] } });
        expect((await application.list()).operations![0]!.source.returnAddress).toEqual({ channel: "original", triggeredBy: "owner", target: { channelId: "original", to: "owner" } });
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("uses trusted operation identity and original request in main, work and nested lineages", async () => {
    const invoke = vi.fn(async () => ({ snapshot: { instances: [] }, targetDeviceId: "target" }));
    const [tool, connect] = createExtensionTools({ invoke });
    expect(connect!.requiresExplicitConfirmation).toBe(true);
    for (const lineage of ["main", "work", "main/subtask"]) {
      await runContextStorage.run({ conversationId: "scene", lineage } as never, async () => {
        const result = await tool!.call({ action: "prepare", instanceId: "my-app" }, { workingDirectory: process.cwd(), turnId: "turn", toolCallId: "call",
          userIntent: "用户原始请求", turnOrigin: { channel: "rpc" } });
        expect(result.isError).not.toBe(true);
      });
    }
    expect(invoke).toHaveBeenCalledTimes(3);
    const requests = invoke.mock.calls.map(call => (call as unknown[])[0] as { id: string; source: { request: string; conversationId: string } });
    expect(new Set(requests.map(request => request.id)).size).toBe(3);
    expect(requests.every(request => request.source.request === "用户原始请求" && request.source.conversationId === "scene")).toBe(true);
  });

  it("rejects self-reported source, missing context and unconfirmed inline candidates", async () => {
    const invoke = vi.fn(); const tools = createExtensionTools({ invoke });
    expect((await tools[0]!.call({ action: "prepare", instanceId: "app", source: "forged" }, { workingDirectory: "." })).isError).toBe(true);
    expect((await tools[0]!.call({ action: "prepare", instanceId: "app" }, { workingDirectory: "." })).isError).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("retains original delivery origin, stable admission id and durable preparation receipt", async () => {
    const admit = vi.fn(async () => ({ shouldEnqueue: true, onDeferred: deferred }));
    const deferred = vi.fn();
    const manager = { admitDurableTurn: admit, findDurableRunByIngress: vi.fn(async () => ({ state: "succeeded" })) };
    const continuation = createExtensionContinuation({ manager: manager as never, communication: { invoke: vi.fn() }, deviceId: "target" });
    const operation: ExtensionOperation = { id: "op", instanceId: "app", revision: 1, phase: "preparing", source: { conversationId: "workscene-fixture", request: "接入 APP",
      returnAddress: { channel: "original-app", target: { channelId: "original-app", to: "user" }, triggeredBy: "user" } } };
    const receipt = await continuation.notify(operation);
    expect(deferred).toHaveBeenCalledOnce();
    expect(admit.mock.calls[0]?.[0]).toMatchObject({ conversationId: "workscene-fixture", options: { turnContext: { turnId: "extension:op:1",
      emissionTarget: { channelId: "original-app", to: "user" } } } });
    expect(await continuation.preparationClosed({ ...operation, continuation: receipt })).toBe(true);
  });

  it("keeps account verification instructions off remote RPC and out of model management tools", async () => {
    const method = buildExtensionMethods().find(method => method.name === "extensions.local-setup")!;
    await expect(method.handler({}, { connection: { loopback: false }, server: {} } as never)).rejects.toThrow("目标设备");
    expect(createExtensionTools({ invoke: vi.fn() }).map(tool => tool.name)).toEqual(["extension", "extension_connect"]);
  });
});
