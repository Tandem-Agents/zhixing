import type { HandlerContext } from "../../handlers.js";
import { RPC_ERROR_CODES } from "../../protocol.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildAnchorUninstallBeginMethod,
  buildAnchorUninstallContinueMethod,
} from "../server.js";

function context(input: {
  readonly loopback: boolean;
  readonly uninstall: Record<string, ReturnType<typeof vi.fn>>;
}): HandlerContext {
  return {
    connection: { authenticated: true, loopback: input.loopback } as never,
    server: {
      config: { port: 18900, host: "127.0.0.1" },
      version: "test",
      startedAt: Date.now(),
      token: "token",
      anchorUninstall: input.uninstall,
    } as never,
  };
}

describe("anchor uninstall local lifecycle RPC", () => {
  it("rejects a non-loopback caller before invoking the coordinator", async () => {
    const begin = vi.fn();
    await expect(buildAnchorUninstallBeginMethod().handler({
      path: "recovery-backup",
      requestId: "request-uninstall",
      operationId: "uninstall-local",
    }, context({ loopback: false, uninstall: { begin } })))
      .rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
    expect(begin).not.toHaveBeenCalled();
  });

  it("passes only stable migration identity and requires explicit backup confirmation", async () => {
    const begin = vi.fn(async (input) => ({ phase: "moving-authority", ...input }));
    await expect(buildAnchorUninstallBeginMethod().handler({
      path: "migration",
      requestId: "request-uninstall",
      operationId: "uninstall-local",
      transferId: "transfer-local",
      targetName: "备用电脑",
    }, context({ loopback: true, uninstall: { begin } }))).resolves.toMatchObject({
      phase: "moving-authority",
    });
    expect(begin).toHaveBeenCalledWith({
      path: "migration",
      requestId: "request-uninstall",
      operationId: "uninstall-local",
      transferId: "transfer-local",
      targetName: "备用电脑",
    });

    const continueUninstall = vi.fn();
    await expect(buildAnchorUninstallContinueMethod().handler({
      operationId: "uninstall-local",
      confirmBackup: false,
    }, context({ loopback: true, uninstall: { continue: continueUninstall } })))
      .rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
    expect(continueUninstall).not.toHaveBeenCalled();
  });
});
