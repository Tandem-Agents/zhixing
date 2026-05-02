/**
 * 主模型 / 辅助模型 section 定义。
 *
 * L1 主面板的"对话 LLM 角色"分组——含两个入口项（主必选 / 辅建议）。
 * 进入后导航到 provider-list 选服务商。
 */

import type { ModelRole, Section, SectionEntry, WorkingState } from "../types.js";
import { readModelRole, readProviderEntry } from "../state.js";

export const modelSection: Section = {
  id: "model",
  title: "对话 LLM 角色",
  entries: (state) => [
    buildEntry(state, "main", {
      label: "主模型（必选）",
      missingStatus: "未配置",
    }),
    buildEntry(state, "secondary", {
      label: "辅助模型（建议配置，用更便宜的轻量模型）",
      missingStatus: "未配置（默认沿用主模型）",
    }),
  ],
  validate: (state) => {
    const issues: string[] = [];
    const main = readModelRole(state, "main");
    if (!main?.provider || !main?.model) {
      issues.push("主模型未配置");
    } else if (!readProviderEntry(state, main.provider)?.apiKey) {
      issues.push(`主模型 - ${main.provider} 的 API Key 未填`);
    }
    // 辅助模型：未配不算 missing（兜底用 main）
    // 但若显式配了且 provider 异于 main 且无 apiKey → 错
    const secondary = readModelRole(state, "secondary");
    if (secondary?.provider && secondary.provider !== main?.provider) {
      if (!readProviderEntry(state, secondary.provider)?.apiKey) {
        issues.push(`辅助模型 - ${secondary.provider} 的 API Key 未填`);
      }
    }
    return issues;
  },
};

function buildEntry(
  state: WorkingState,
  role: ModelRole,
  display: { label: string; missingStatus: string },
): SectionEntry {
  const config = readModelRole(state, role);
  const isConfigured = Boolean(config?.provider && config?.model);
  const hasKey = isConfigured
    ? Boolean(readProviderEntry(state, config!.provider)?.apiKey)
    : false;

  let status: string;
  if (!isConfigured) {
    status = display.missingStatus;
  } else if (!hasKey) {
    status = `${config!.provider} · ${config!.model}（缺 API Key）`;
  } else {
    status = `${config!.provider} · ${config!.model}`;
  }

  return {
    label: display.label,
    status,
    enterTarget: { kind: "provider-list", role },
  };
}
