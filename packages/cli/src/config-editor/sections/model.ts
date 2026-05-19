/**
 * 主模型 / 辅助模型 section 定义。
 *
 * L1 主面板的"对话模型"分组——含两个入口项（主必选 / 辅建议）。
 * 进入后统一走 provider-list 让用户选服务商——保留"选服务商"上下文。
 *
 * 字段级 issues 直接复用 `checkModel`——**单一规则源**。
 * EntryState 用 discriminated union 三态（ready/disabled/blocked）— issues 仅
 * blocked 态可声明，类型层面强制 caller 不能写矛盾。
 */

import type {
  EntryState,
  ModelRole,
  Section,
  SectionEntry,
  WorkingState,
} from "../types.js";
import { ROLE_SPECS } from "@zhixing/providers";
import { readModelRole } from "../state.js";
import { checkModel, hasApiKey, type ModelIssue } from "../checks/model.js";

export const modelSection: Section = {
  id: "model",
  title: "对话模型",
  description: "主模型必填；辅助角色（轻量 / 强力）可选，未配则沿用主模型",
  entries: (state) => {
    // 一次 audit，按 role 分发——避免 buildEntry 内重复遍历
    const allIssues = checkModel(state.config, state.credentials);
    // 遍历 ROLE_SPECS（角色集单一事实源）生成入口——新增角色零改动。
    // 标签后带中文括号说明（spec.parenZh：必填/轻量/更强等），让首次用户
    // 一眼看懂每个角色干嘛。
    return ROLE_SPECS.map((spec) =>
      buildEntry(state, spec.id, allIssues, {
        label: `${spec.labelZh}（${spec.parenZh}）`,
        missingStatusText: spec.missingStatusZh,
        isOptional: !spec.required,
      }),
    );
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
  // 该角色 provider 是否真有 key —— 就绪态的真值依据。可选角色永不进
  // checkModel 阻断清单（选填不阻断），其"是否就绪"只能由此真值谓词判定，
  // 不能用"myIssues 为空"代替（可选角色 myIssues 恒空 ≠ 就绪）。
  const providerHasKey = config?.provider
    ? hasApiKey(state.credentials, config.provider)
    : false;
  // main 的 provider —— 用于区分"与主模型同 provider（补 main 那把 key 即
  // 一并就绪）"与"独立 provider（缺则运行时回退 main）"两种引导文案。
  const mainProvider = state.config.llm?.main?.provider;

  return {
    label: display.label,
    state: buildEntryState(
      config,
      isConfigured,
      myIssues,
      providerHasKey,
      mainProvider,
      display,
    ),
    // 始终走 provider-list——即使当前只有一家 provider，也保留"选服务商"上下文。
    // 一致的导航路径 > 节省 1 次按键；多 provider 阶段无需重新设计跳转逻辑。
    enterTarget: { kind: "provider-list", role },
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
  providerHasKey: boolean,
  mainProvider: string | undefined,
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
  // 已配置 + 本行有可执行 issue（自己 provider 的 key 未填，或必填 main 缺项）
  // → blocked，statusText 含字段名提示，计入"待补充 N 项"。
  if (myIssues.length > 0) {
    const fields = myIssues.map((i) => i.fieldLabel).join(" / ");
    return {
      kind: "blocked",
      statusText: `${config!.provider} · ${config!.model}（待补 ${fields}）`,
      issues: myIssues.map((i) => i.label),
    };
  }
  // 已配置、无阻断 issue，但该 provider 没有 key。只有可选角色会走到这——
  // required(main) 缺 key 必有 checkModel issue，上面已 blocked。可选角色
  // 【永不阻断流程】→ 归 disabled（暗色、不计 issue、不卡完成/启动），仅按
  // "是否与 main 同 provider"给两种引导文案：
  //   - 同 provider：补 main 那把 key 即一并就绪
  //   - 异 provider：该 provider 自己的 key，运行时缺则回退主模型（咨询）
  if (!providerHasKey) {
    const sameAsMain = config!.provider === mainProvider;
    return {
      kind: "disabled",
      statusText: sameAsMain
        ? `${config!.provider} · ${config!.model}（随主模型补 API Key）`
        : `${config!.provider} · ${config!.model}（待补 API Key，缺则回退主模型）`,
    };
  }
  // 全配齐且 provider 有 key → ready
  return {
    kind: "ready",
    statusText: `${config!.provider} · ${config!.model}`,
  };
}

