import { describe, expect, it, vi } from "vitest";
import type { RpcConnection } from "../connection.js";
import {
  RpcSurfaceRegistry,
  requireRpcSurfacePrincipal,
} from "../surface-identity.js";

function connection(id: number): RpcConnection & { close: ReturnType<typeof vi.fn> } {
  let closed = false;
  const close = vi.fn(() => {
    closed = true;
  });
  return {
    id,
    authenticated: true,
    loopback: true,
    sendSuccess() {},
    sendError() {},
    notify() {},
    close,
    get closed() {
      return closed;
    },
    onClose() {
      return () => {};
    },
  };
}

describe("RpcSurfaceRegistry", () => {
  it("isolates distinct first-party client instances", () => {
    const registry = new RpcSurfaceRegistry();
    const first = connection(1);
    const second = connection(2);

    expect(registry.bind(first, "cli-a")).toMatchObject({
      surfacePrincipal: "rpc:cli-a",
      generation: 1,
    });
    expect(registry.bind(second, "cli-b")).toMatchObject({
      surfacePrincipal: "rpc:cli-b",
      generation: 1,
    });
    expect(first.close).not.toHaveBeenCalled();
    expect(second.close).not.toHaveBeenCalled();
    expect(registry.current("rpc:cli-a")?.connection).toBe(first);
    expect(registry.current("rpc:cli-b")?.connection).toBe(second);
  });

  it("advances generation and fences the prior connection on reconnect", () => {
    const registry = new RpcSurfaceRegistry();
    const first = connection(1);
    const second = connection(2);
    registry.bind(first, "cli-a");

    expect(registry.bind(second, "cli-a")).toMatchObject({
      surfacePrincipal: "rpc:cli-a",
      generation: 2,
    });
    expect(first.close).toHaveBeenCalledWith(4001, "First-party surface reconnected");
    expect(registry.current("rpc:cli-a")?.connection).toBe(second);

    registry.unbind(first);
    expect(registry.current("rpc:cli-a")?.connection).toBe(second);
    registry.unbind(second);
    expect(registry.current("rpc:cli-a")).toBeUndefined();
  });

  it("fails closed for an absent or malformed stable identity", () => {
    const registry = new RpcSurfaceRegistry();
    expect(() => registry.bind(connection(1), "x")).toThrow(
      "First-party RPC client id is invalid",
    );
    expect(() => requireRpcSurfacePrincipal(connection(2))).toThrow(
      "stable first-party surface identity",
    );
  });
});
