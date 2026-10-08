import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfirmationRequest } from "@zhixing/core/confirmation";
import type { HomeTrustRecord } from "@zhixing/core/contracts";
import { RpcClientClosedError, ServerNotRunningError } from "@zhixing/server";
import { CoreHostConnection } from "../core-host-connection.js";
import { RpcConfirmationBroker } from "../rpc-confirmation-broker.js";
import { CurrentAnchorSurfaceRpcClient } from "../surface-core-host-link.js";

interface Command {
  op: "dispatch" | "poll" | "close";
  method?: string;
  params?: unknown;
  surface: { surfacePrincipal: string; generation: number; connectionId: string };
}
type Reply = { result?: unknown; notifications?: { method: string; params: unknown }[] };
type Respond = (deviceId: string, command: Command, signal?: AbortSignal) => Promise<Reply>;

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

function request(id: string): ConfirmationRequest {
  return {
    id, tool: "read", toolInput: {}, workingDirectory: "/synthetic",
    display: { title: "读取合成文件", body: { kind: "text", text: "synthetic" }, cwd: "/synthetic" },
    options: [{ kind: "allow-once", label: "允许一次" }], sessionType: "interactive",
    contextId: { kind: "main" }, createdAt: Date.now(), expiresAt: Date.now() + 60_000,
  } as ConfirmationRequest;
}

function trust(owner: string, epoch: number): HomeTrustRecord {
  return {
    v: 1, schemaId: "HomeTrustRecord", homeId: "home:synthetic", trustEpoch: epoch,
    chainHead: { seq: epoch, eventDigest: `sha256:${String(epoch).repeat(64).slice(0, 64)}` },
    issuer: { deviceId: owner, issuerKeyId: owner }, members: [],
    signature: { alg: "Ed25519", keyId: owner, sig: "synthetic" },
  };
}

async function fixture() {
  let record = trust("device:a", 1);
  const calls: { deviceId: string; command: Command }[] = [];
  const defaultReply: Respond = async (_device, command, signal) => {
    if (command.op === "poll") {
      await new Promise<void>(resolve => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return {};
    }
    if (command.method === "session.list") return {
      result: { items: [] },
      notifications: [{ method: "confirmation.pending", params: { conversationId: "conversation:original", request: request(`request:${record.trustEpoch}`) } }],
    };
    return { result: command.method === "confirmation.list" ? { items: [] } : { ok: true } };
  };
  let respond = defaultReply;
  const surface = new CurrentAnchorSurfaceRpcClient("device:surface", {
    start: vi.fn(), stop: vi.fn(), currentTrust: () => record,
    connections: { client: (deviceId: string) => ({ request: async (_service: string, payload: Uint8Array, signal?: AbortSignal) => {
      const command = JSON.parse(Buffer.from(payload).toString("utf8")) as Command;
      calls.push({ deviceId, command });
      const reply = await respond(deviceId, command, signal);
      return Buffer.from(JSON.stringify({ v: 1, ok: true, notifications: [], ...reply }));
    } }) },
  } as never, { stopStorageMaintenance: vi.fn() });
  const link = new CoreHostConnection({
    discover: async () => { throw new ServerNotRunningError("synthetic"); },
    spawn: async () => ({ ok: true, mode: "none" }),
    createClient: () => { throw new Error("No local transport in this fixture"); },
    createSurfaceClient: async () => surface,
  });
  const errors = vi.fn();
  const broker = new RpcConfirmationBroker({ link, onResolveError: errors });
  const received = vi.fn();
  const invalidated = vi.fn();
  const disconnected = vi.fn();
  const lifecycle = vi.fn();
  broker.onRequest(received);
  broker.onInvalidated(invalidated);
  link.onDisconnect(disconnected);
  link.onLifecycleNotice(lifecycle);
  await link.ensure();
  cleanup.push(async () => { broker.dispose(); await link.dispose(); });
  return {
    surface, link, broker, errors, received, invalidated, disconnected, lifecycle, calls, defaultReply,
    setRespond: (value: Respond) => { respond = value; },
    change: (owner: string, epoch: number) => { record = trust(owner, epoch); return record; },
    show: () => surface.request("session.list", {}),
    resolves: () => calls.filter(call => call.command.method === "confirmation.resolve"),
  };
}

describe("current-anchor confirmation lifecycle through the real link and relay", () => {
  it.each(["same-owner", "new-owner", "lazy-owner"])("%s retires displayed requests and keeps subsequent generations usable", async mode => {
    const f = await fixture();
    await f.show();
    expect(f.received).toHaveBeenCalledOnce();
    const next = f.change(mode === "same-owner" ? "device:a" : "device:b", 2);
    if (mode === "lazy-owner") await f.surface.request("confirmation.list", {});
    else await f.surface.reconcileOwner(next);
    expect(f.disconnected).toHaveBeenCalledOnce();
    expect(f.invalidated).toHaveBeenCalledExactlyOnceWith("request:1");
    expect(f.broker.resolve("request:1", { kind: "allow-once" })).toBe(false);
    expect(f.resolves()).toEqual([]);
    await f.show();
    expect(f.received.mock.calls.map(([value]) => value.id)).toEqual(["request:1", "request:2"]);
    await f.surface.reconcileOwner(f.change("device:c", 3));
    expect(f.disconnected).toHaveBeenCalledTimes(2);
    expect(f.invalidated).toHaveBeenLastCalledWith("request:2");
    expect(f.lifecycle).toHaveBeenCalledWith({ kind: "reconnected", reason: "connection-closed" });
    await f.show();
    expect(f.broker.resolve("request:3", { kind: "deny" })).toBe(true);
    await vi.waitFor(() => expect(f.resolves()).toHaveLength(1));
    expect(f.resolves()[0]?.deviceId).toBe("device:c");
    const surfaces = f.calls.filter(call => call.command.method === "session.list").map(call => call.command.surface);
    expect(surfaces.map(value => value.generation)).toEqual([1, 2, 3]);
    expect(new Set(surfaces.map(value => value.surfacePrincipal)).size).toBe(1);
  });

  it.each(["dispatch", "poll"])("drops a late %s response even when transport ignores abort", async operation => {
    const f = await fixture();
    const late = Promise.withResolvers<Reply>();
    f.setRespond((device, command, signal) => device === "device:a" && command.op === operation
      ? late.promise : f.defaultReply(device, command, signal));
    const old = f.surface.request("confirmation.list", {}).then(value => ({ value }), error => ({ error }));
    await vi.waitFor(() => expect(f.calls.some(call => call.command.op === operation)).toBe(true));
    await f.surface.reconcileOwner(f.change("device:b", 2));
    late.resolve({ result: { items: [] }, notifications: [{ method: "confirmation.pending", params: { request: request("stale") } }] });
    const result = await old;
    if (operation === "dispatch") expect(result).toMatchObject({ error: expect.any(RpcClientClosedError) });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.received).not.toHaveBeenCalled();
    expect(f.broker.resolve("stale", { kind: "allow-once" })).toBe(false);
    await f.show();
    expect(f.received).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "request:2" }));
  });

  it.each(["queued", "dispatched"])("preserves the selected decision across turnover while %s", async stage => {
    const f = await fixture();
    await f.show();
    f.setRespond(async (device, command, signal) => {
      if (device === "device:a" && command.method === "confirmation.resolve") {
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) return reject(new Error("retired transport"));
          signal?.addEventListener("abort", () => reject(new Error("retired transport")), { once: true });
        });
      }
      return f.defaultReply(device, command, signal);
    });
    const decision = { kind: "deny" as const, reason: "original selected decision" };
    expect(f.broker.resolve("request:1", decision)).toBe(true);
    decision.reason = "later mutation";
    if (stage === "dispatched") await vi.waitFor(() => expect(f.resolves()).toHaveLength(1));
    await f.surface.reconcileOwner(f.change("device:b", 2));
    await vi.waitFor(() => expect(f.resolves().at(-1)?.deviceId).toBe("device:b"));
    expect(f.resolves()).toHaveLength(stage === "dispatched" ? 2 : 1);
    for (const { command } of f.resolves()) expect(command.params).toEqual({
      requestId: "request:1", conversationId: "conversation:original",
      decision: { kind: "deny", reason: "original selected decision" },
    });
    expect(f.errors).not.toHaveBeenCalled();
    expect(f.received).toHaveBeenCalledOnce();
  });

  it("explicit close invalidates once and blocks late requests", async () => {
    const f = await fixture();
    await f.show();
    await Promise.all([f.surface.close(), f.surface.close()]);
    expect(f.disconnected).toHaveBeenCalledOnce();
    expect(f.invalidated).toHaveBeenCalledExactlyOnceWith("request:1");
    expect(f.broker.resolve("request:1", { kind: "allow-once" })).toBe(false);
    const lateClose = vi.fn();
    f.surface.onClose(lateClose);
    expect(lateClose).toHaveBeenCalledOnce();
    expect(f.resolves()).toEqual([]);
  });

  it("refreshes pending confirmations through the no-argument public RPC call", async () => {
    const f = await fixture();
    f.setRespond((device, command, signal) => command.method === "confirmation.list"
      ? Promise.resolve({ result: { items: [{ request: request("refreshed") }] } })
      : f.defaultReply(device, command, signal));
    await f.broker.refresh();
    expect(f.received).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "refreshed" }));
  });
});
