import { createHash } from "node:crypto";
import type { ZhixingConfig } from "./types.js";

/** Versioned finite selection; endpoints, arguments, options, paths and secrets are excluded. */
export function runtimeConfigurationObservation(config: Readonly<ZhixingConfig>) {
  const text = (value: unknown) => typeof value === "string" ? value.slice(0, 256) : undefined;
  const roles = ["main", "light", "power"] as const;
  const keys = (value: object | undefined) => Object.keys(value ?? {}).sort().slice(0, 256);
  const projection = {
    version: 1,
    models: roles.map((role) => {
      const value = config.llm?.[role];
      const thinking = value?.thinking;
      return { role, provider: text(value?.provider), model: text(value?.model), mode: text(thinking?.mode),
        effort: thinking?.mode === "effort" ? text(thinking.effort) : undefined,
        budget: thinking?.mode === "budget" ? thinking.budget : undefined };
    }),
    proxyMode: config.network?.proxy === "off" ? "off" : !config.network?.proxy || config.network.proxy === "auto" ? "auto" : "configured",
    channels: keys(config.messaging).map((id) => [text(id), text(config.messaging?.[id]?.type)]),
    mcp: keys(config.mcp?.servers).map((id) => [text(id), config.mcp?.servers?.[id]?.enabled]),
    advancementBudget: config.advancement?.sessionTokenBudget,
    workspaceConfigured: !!config.workspace?.root,
  };
  return { selectionVersion: "runtime-selection/1", selectionDigest: createHash("sha256").update(JSON.stringify(projection)).digest("hex"), omitted: "端点、参数、选项、路径、凭据及模型能力由实际运行边界说明；列表最多256项" };
}
