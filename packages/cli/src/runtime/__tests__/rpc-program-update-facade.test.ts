import { describe, expect, it, vi } from "vitest";
import type { CoreHostRpcLink } from "../core-host-connection.js";
import { RpcProgramUpdateSurfaceFacade } from "../rpc-program-update-facade.js";

describe("RpcProgramUpdateSurfaceFacade", () => {
  it("uses the current connection for status and relays only the narrow changed signal", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "server.update.status") return { visible: false };
      throw new Error(`unexpected method ${method}`);
    });
    let notification: (() => void) | undefined;
    const remove = vi.fn();
    const connection = {
      getClient: async () => ({ request }),
      onNotification(method: string, handler: () => void) {
        expect(method).toBe("server.update.changed");
        notification = handler;
        return remove;
      },
    } as unknown as CoreHostRpcLink;
    const changed = vi.fn();
    const facade = new RpcProgramUpdateSurfaceFacade(connection);
    const off = facade.onChanged(changed);

    await expect(facade.status()).resolves.toEqual({ visible: false });
    notification?.();
    expect(changed).toHaveBeenCalledOnce();
    off();
    expect(remove).toHaveBeenCalledOnce();
  });
});
