import { ProductApiDispatcher } from "@zhixing/core/product-api";
import {
  LogApplication,
  createLogProductApiContribution,
  LOG_PRODUCT_API_EXACT_SET,
  LogRequestError,
  type LogApplicationHost,
} from "@zhixing/core/logging/application";
import type { LogReadContext } from "@zhixing/core/logging";
import {
  LocalLogStore,
  type LogFileSystem,
} from "@zhixing/core/logging/storage";
import type { DeviceCapacityArbiterPort } from "@zhixing/core/resources";
import { LogFilesProcess } from "./files-process.js";
import { createLogWriterProbe } from "./writers.js";

/** Content versions shipped by this Host; unknown versions still expose only their public envelope. */
export const SHIPPED_LOG_SOURCES = ["runtime:1", "logging:1", "kernel:1", "provider:1", "process:1", "mcp:1", "extension:1", "product-api:1", "authority:1", "terminal-input:1", "stdio:1", "channel:1", "handoff:1", "configuration:1"] as const;

export const LOCAL_LOG_OWNER: Readonly<LogReadContext> = Object.freeze({
  subject: "local-owner",
  revision: "home-owner-v1",
  manageStorage: true,
  scopes: Object.freeze([]),
});

/** One bounded query owner, independent of the recorder, sharing the device arbiter. */
export function createLogAccess(
  home: string,
  capacity: DeviceCapacityArbiterPort,
  files: LogFileSystem = new LogFilesProcess(home),
) {
  const store = new LocalLogStore({ files, capacity, observeWriters: createLogWriterProbe(home) });
  let closed = false;
  let active: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  const host: LogApplicationHost = {
    async use<T>(
      context: () => LogReadContext,
      action: (application: LogApplication) => Promise<T>,
    ): Promise<T> {
      if (closed || active)
        throw new LogRequestError("日志查询暂忙，请稍后重试");
      // A promise boundary lets us own the operation before invoking caller code.
      const task = Promise.resolve().then(() =>
        action(new LogApplication(store, context, SHIPPED_LOG_SOURCES)),
      );
      active = task;
      try {
        return await task;
      } finally {
        active = undefined;
      }
    },
  };
  const contribution = createLogProductApiContribution(host);
  return {
    contribution,
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      const settled = active?.catch(() => {});
      closing = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          if (settled)
            await Promise.race([
              settled,
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, 1500);
              }),
            ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        // Closing the physical owner aborts pending work; still join the operation's permit cleanup.
        try {
          await store.close();
        } finally {
          await settled;
        }
      })();
      return closing;
    },
  };
}

/** Executor-only and offline composition roots each own one local directory. */
export function createLocalLogProductApi(
  access: Pick<ReturnType<typeof createLogAccess>, "contribution">,
) {
  return new ProductApiDispatcher(LOG_PRODUCT_API_EXACT_SET, [
    access.contribution,
  ]);
}
