import type { KernelToolImplementationPort } from "@zhixing/orchestrator/runtime";
import {
  BUILTIN_TOOL_FACTORIES,
  WEB_FETCH_DEFAULT_RULES,
} from "@zhixing/tools-builtin";

/** The Host edge is the only production selector for concrete built-in tools. */
export function createHostKernelToolImplementation(): KernelToolImplementationPort {
  return Object.freeze({
    create: ((request) => {
      const tools = request.requestedToolNames.map((name) => {
        const factory = Object.hasOwn(BUILTIN_TOOL_FACTORIES, name)
          ? BUILTIN_TOOL_FACTORIES[name]
          : undefined;
        if (!factory) {
          throw new Error(`Kernel Tool implementation does not provide "${name}"`);
        }
        const tool = factory({
          proxy: request.networkProxy,
          skillCatalogLoad: request.skillCatalogLoad,
          skillCatalogSave: request.skillCatalogSave,
          skillCatalogAdmission: request.skillCatalogAdmission,
          skillMode: request.skillMode,
        });
        if (tool.name !== name) {
          throw new TypeError(
            `Kernel Tool implementation returned "${tool.name}" for "${name}"`,
          );
        }
        return tool;
      });
      return Object.freeze({
        tools: Object.freeze(tools),
        permissionRuleSets: Object.freeze([
          Object.freeze({
            namespace: "web_fetch",
            rules: Object.freeze([...WEB_FETCH_DEFAULT_RULES]),
          }),
        ]),
      });
    }) satisfies KernelToolImplementationPort["create"],
  });
}
