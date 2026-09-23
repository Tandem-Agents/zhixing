import { createLogQueryTools } from "@zhixing/core/logging/application";
import type { ProductApiDispatcher } from "@zhixing/core/product-api";
import { runContextStorage } from "@zhixing/orchestrator/runtime";

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
