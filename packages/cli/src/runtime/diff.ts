/**
 * 配置变更检测——RuntimeSession.reload 决定哪些域需要重建。
 *
 * 设计为纯函数（无副作用，不读 fs）：单测覆盖各字段独立变更触发对应 domain，
 * 算法升级（如基于 JSON Patch 的细粒度变更）替换实现不影响 session.ts。
 *
 * 域划分：
 * - `channels`：messaging 配置或 channels 凭证变化 → 重建 channels + delivery + scheduler
 *   （Scheduler 公共 API 无 setDelivery，必须重建拿新 delivery ref）
 * - `agent`：主对话相关字段变化 → 重建 agentRuntime（不重建 scheduler——
 *   scheduler 内部 runAgentTurn 是 closure 读 this.agentRuntime，自动响应 swap）
 *
 * 对比用稳定序列化避免 key 顺序敏感性（JSON.stringify 在不同字段插入顺序下产出不同字符串）。
 */

import type { ZhixingConfig, ZhixingCredentials } from "@zhixing/providers";

export interface DiffResult {
  kind: "no-change" | "changed";
  channelsChanged: boolean;
  agentChanged: boolean;
  changedDomains: ReadonlyArray<"channels" | "agent">;
}

export function computeDiff(
  oldConfig: ZhixingConfig,
  oldCredentials: ZhixingCredentials,
  newConfig: ZhixingConfig,
  newCredentials: ZhixingCredentials,
): DiffResult {
  const channelsChanged =
    !stableEqual(oldConfig.messaging, newConfig.messaging) ||
    !stableEqual(oldCredentials.channels, newCredentials.channels);

  const agentChanged =
    oldConfig.llm?.main?.provider !== newConfig.llm?.main?.provider ||
    oldConfig.llm?.main?.model !== newConfig.llm?.main?.model ||
    !stableEqual(oldConfig.llm?.secondary, newConfig.llm?.secondary) ||
    // providers 资源池在 credentials.json（apiKey / baseUrl / protocol / models 等）
    !stableEqual(oldCredentials.providers, newCredentials.providers) ||
    !stableEqual(oldConfig.workspace, newConfig.workspace) ||
    !stableEqual(oldConfig.network, newConfig.network) ||
    !stableEqual(oldConfig.agent, newConfig.agent) ||
    !stableEqual(oldConfig.intent, newConfig.intent);

  if (!channelsChanged && !agentChanged) {
    return {
      kind: "no-change",
      channelsChanged: false,
      agentChanged: false,
      changedDomains: [],
    };
  }

  const changedDomains: Array<"channels" | "agent"> = [];
  if (channelsChanged) changedDomains.push("channels");
  if (agentChanged) changedDomains.push("agent");

  return {
    kind: "changed",
    channelsChanged,
    agentChanged,
    changedDomains,
  };
}

/**
 * Stable deep equality — 按 key 排序序列化避免对象 key 顺序敏感性。
 * `undefined` 与缺失字段、`null` 三者都视为"等价缺省"。
 */
function stableEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(v: unknown): string {
  if (v === undefined || v === null) return "null";
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) {
    return `[${v.map(stableStringify).join(",")}]`;
  }
  const entries = v as Record<string, unknown>;
  const keys = Object.keys(entries).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify(entries[k])}`,
  );
  return `{${parts.join(",")}}`;
}
