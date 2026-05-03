/**
 * 主模型 / 辅助模型 section 定义。
 *
 * L1 主面板的"对话模型"分组——含两个入口项（主必选 / 辅建议）。
 * 进入后由 pickModelEnterTarget 决定走 provider-list 还是直进 provider-config。
 *
 * 字段级 issues 直接复用 `checkModel`——**单一规则源**。
 * EntryState 用 discriminated union 三态（ready/disabled/blocked）— issues 仅
 * blocked 态可声明，类型层面强制 caller 不能写矛盾。
 */

import type {
  EntryState,
  ModelRole,
  PanelDescriptor,
  Section,
  SectionEntry,
  WorkingState,
} from "../types.js";
import { readModelRole } from "../state.js";
import { SUPPORTED_PROVIDERS } from "../providers-registry.js";
import { checkModel, type ModelIssue } from "../checks/model.js";

export const modelSection: Section = {
  id: "model",
  title: "对话模型",
  entries: (state) => {
    // 一次 audit，按 role 分发——避免 buildEntry 内重复遍历
    const allIssues = checkModel(state.config, state.credentials);
    return [
      buildEntry(state, "main", allIssues, {
        label: "主模型",
        missingStatusText: "待配置",
        isOptional: false,
      }),
      buildEntry(state, "secondary", allIssues, {
        label: "辅助模型",
        missingStatusText: "未启用（默认沿用主模型）",
        isOptional: true,
      }),
    ];
  },
};

function buildEntry(
  state: WorkingState,
  role: ModelRole,
  allIssues: ModelIssue[],
  display: { label: string; missingStatusText: string; isOptional: boolean },
): SectionEntry {
  const config = readModelRole(state, role);
  const isConfigured = Boolean(config?.provider && config?.model);
  const myIssues = allIssues.filter((i) => i.role === role);

  return {
    label: display.label,
    state: buildEntryState(config, isConfigured, myIssues, display),
    enterTarget: pickModelEnterTarget(role),
  };
}

/**
 * 把 (config, issues, display) 折叠成 EntryState 三态——本地决策"该 entry 处于
 * 哪种状态"，把状态意图与 statusText 内容一同声明。
 *
 * 命名约定 + 为何"故意不抽公共"详见 entry.ts 顶部文档。
 *
 * statusText 中"待补 X / Y"的字段名取自 issue.fieldLabel——sections 不再硬编码
 * 字段名（如旧版的"待填 API Key"），未来 ModelIssue 加新字段时此处自动跟上。
 */
function buildEntryState(
  config: ReturnType<typeof readModelRole>,
  isConfigured: boolean,
  myIssues: ModelIssue[],
  display: { missingStatusText: string; isOptional: boolean },
): EntryState {
  // 未配置 + 可选 → disabled（fallback 到 main，不阻塞完成）
  if (!isConfigured && display.isOptional) {
    return { kind: "disabled", statusText: display.missingStatusText };
  }
  // 未配置 + 必填 → blocked（issues 来自 checkModel）
  if (!isConfigured) {
    return {
      kind: "blocked",
      statusText: display.missingStatusText,
      issues: myIssues.map((i) => i.label),
    };
  }
  // 已配置但仍有 issues（典型：apiKey 未填）→ blocked，statusText 含字段名提示
  if (myIssues.length > 0) {
    const fields = myIssues.map((i) => i.fieldLabel).join(" / ");
    return {
      kind: "blocked",
      statusText: `${config!.provider} · ${config!.model}（待补 ${fields}）`,
      issues: myIssues.map((i) => i.label),
    };
  }
  // 全配齐 → ready
  return {
    kind: "ready",
    statusText: `${config!.provider} · ${config!.model}`,
  };
}

/**
 * 决定从 main 进入"主/辅模型"时的目标 panel。
 *
 * 单一 supported provider 时跳过 provider-list 一层——减少多余按键。
 * 多 provider 时进 list 让用户选；list 内若选定后再进入 provider-config 是正常路径。
 *
 * 故意**不**根据 "已配置过 provider" 直跳——多 provider 阶段那会让用户失去切换入口
 * （entity panel 没有"换 provider"按钮，Esc 只能 pop 回 main）。等真到多 provider
 * 时另外加切换按钮，而不是在这里埋逻辑分支。
 */
function pickModelEnterTarget(role: ModelRole): PanelDescriptor {
  if (SUPPORTED_PROVIDERS.length === 1) {
    return { kind: "provider-config", role, providerId: SUPPORTED_PROVIDERS[0]!.id };
  }
  return { kind: "provider-list", role };
}
