import type { RunningServer } from "@zhixing/server";

interface ExecutorRoleSignalSource {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface ExecutorRoleTerminalInput {
  readonly server: Pick<RunningServer, "shutdown" | "waitForShutdown">;
  readonly deviceRemoved: Promise<void>;
  readonly prepareSignalStop: () => Promise<void>;
  readonly signalSource?: ExecutorRoleSignalSource;
}

/**
 * Joins every executor-only termination source at the real Server terminal.
 * The caller owns role cleanup after this promise resolves.
 */
export function waitForExecutorRoleTerminal(
  input: ExecutorRoleTerminalInput,
): Promise<void> {
  const signalSource = input.signalSource ?? process;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let roleStop: Promise<void> | undefined;

    const cleanup = () => {
      signalSource.off("SIGINT", stopFromSignal);
      signalSource.off("SIGTERM", stopFromSignal);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const stopFromRole = (reason: string, prepare?: () => Promise<void>) => {
      roleStop ??= (async () => {
        await prepare?.();
        await input.server.shutdown(reason);
        await input.server.waitForShutdown();
      })();
      void roleStop.then(finish, fail);
    };
    function stopFromSignal() {
      stopFromRole("executor-signal", input.prepareSignalStop);
    }

    signalSource.once("SIGINT", stopFromSignal);
    signalSource.once("SIGTERM", stopFromSignal);
    void input.deviceRemoved.then(
      () => stopFromRole("executor-device-removed"),
      fail,
    );
    void input.server.waitForShutdown().then(finish, fail);
  });
}
