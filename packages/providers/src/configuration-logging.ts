import { createHash } from "node:crypto";
import { isLLMConfigV2, type LegacyLLMConfigV1, type ZhixingConfig } from "./types.js";

/** Versioned finite selection; endpoints, arguments, options, paths and secrets are excluded. */
export function runtimeConfigurationObservation(config: Readonly<ZhixingConfig>) {
  const text = (value: unknown) => (typeof value === "string" ? value.slice(0, 256) : undefined);
  const roles = ["main", "light", "power"] as const;
  const keys = (value: object | undefined) => Object.keys(value ?? {}).sort().slice(0, 256);
  const rawLlm = config.llm as unknown;
  const v2 = isLLMConfigV2(rawLlm) ? rawLlm : undefined;
  const legacy = !v2 && rawLlm && typeof rawLlm === "object" ? (rawLlm as LegacyLLMConfigV1) : undefined;

  const projection = {
    version: v2 ? 2 : 1,
    ...(v2
      ? {
          connections: keys(v2.connections).map((id) => {
            const conn = v2.connections[id]!;
            return [text(id), text(conn.adapter), text(conn.auth.mode), text(conn.network.proxy)];
          }),
        }
      : {}),
    models: roles.map((role) => {
      if (v2) {
        const value = v2[role];
        const thinking = value?.params?.thinking;
        return {
          role,
          provider: text(value?.connectionId),
          model: text(value?.model),
          mode: text(thinking?.mode),
          effort: thinking?.mode === "effort" ? text(thinking.effort) : undefined,
          budget: thinking?.mode === "budget" ? thinking.budget : undefined,
          maxOutputPreference: value?.maxOutputPreference,
        };
      }
      const value = legacy?.[role];
      const thinking = value?.thinking;
      return {
        role,
        provider: text(value?.provider),
        model: text(value?.model),
        mode: text(thinking?.mode),
        effort: thinking?.mode === "effort" ? text(thinking.effort) : undefined,
        budget: thinking?.mode === "budget" ? thinking.budget : undefined,
      };
    }),
    proxyMode:
      config.network?.proxy === "off"
        ? "off"
        : !config.network?.proxy || config.network.proxy === "auto"
          ? "auto"
          : "configured",
    channels: keys(config.messaging).map((id) => [text(id), text(config.messaging?.[id]?.type)]),
    mcp: keys(config.mcp?.servers).map((id) => [text(id), config.mcp?.servers?.[id]?.enabled]),
    advancementBudget: config.advancement?.sessionTokenBudget,
    workspaceConfigured: !!config.workspace?.root,
  };
  return {
    selectionVersion: v2 ? "runtime-selection/2" : "runtime-selection/1",
    selectionDigest: createHash("sha256").update(JSON.stringify(projection)).digest("hex"),
    omitted: "端点、参数、选项、路径、凭据及模型能力由实际运行边界说明；列表最多256项",
  };
}
