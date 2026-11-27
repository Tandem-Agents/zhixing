import {
  conversationLogScope,
  createLogQueryTools,
} from "@zhixing-ai/core/logging/application";
import type { ProductApiDispatcher } from "@zhixing-ai/core/product-api";
import { runContextStorage } from "@zhixing-ai/orchestrator/runtime";
import { isChannelRuntimeTurn } from "../serve/session-surface-kind.js";

/** Home-owned runtime assembly grants the current runtime its owner access, never tool input. */
export function createRuntimeLogTools(
  getApi: () => Pick<ProductApiDispatcher, "query">,
) {
  // Assembly can precede catalog sealing; invocation always uses the Host's one catalog.
  return createLogQueryTools(
    { query: (operation, input) => getApi().query(operation, input) },
    () => {
      const run = runContextStorage.getStore();
      if (!run) throw Error("日志工具需要真实运行上下文");
      if (isChannelRuntimeTurn(run)) {
        return {
          subject: `runtime:${run.conversationId ?? "channel"}:${run.lineage}`,
          revision: "home-runtime-owner-v1",
          manageStorage: false,
          managePolicy: false,
          scopes: run.conversationId ? [conversationLogScope(run.conversationId)] : [],
        };
      }
      return {
        subject: `runtime:${run.conversationId ?? "ephemeral"}:${run.lineage}`,
        revision: "home-runtime-owner-v1",
        manageStorage: true,
        managePolicy: false,
        scopes: [],
      };
    },
  );
}
