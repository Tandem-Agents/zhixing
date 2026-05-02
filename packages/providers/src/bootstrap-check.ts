/**
 * 首次启动必要字段检测——纯函数。
 *
 * 「必要字段」= 没有它就无法进入正常使用的字段：
 *   - config.llm.main.provider / config.llm.main.model
 *   - main provider 的 apiKey（credentials.json 唯一入口）
 *   - 显式 secondary 且 secondary.provider !== main.provider 时，secondary provider 的 apiKey
 *
 * 设计：
 *   - 输入两份文件状态，输出缺失字段列表；空数组表示 ready。
 *   - 复用方：CLI 启动、server 启动期自检、未来 zhixing doctor、单元测试。
 *   - 不读 fs、不抛错、不副作用——把判定与 IO/交互完全解耦。
 */

import { getPreset } from "./presets.js";
import type { ZhixingConfig, ZhixingCredentials } from "./types.js";

/** 缺失字段描述——供向导逐字段询问与 fail-fast 错误展示。 */
export interface MissingField {
  /** 字段路径，如 "credentials.providers.siliconflow.apiKey" 或 "config.llm.main.provider" */
  path: string;
  /** 人类可读说明，如 "SiliconFlow 的 API Key" */
  humanLabel: string;
  /** 缺失字段应落到哪份文件——指引向导 / 错误消息选择正确文件 */
  file: "config" | "credentials";
}

/**
 * 必要字段是否齐全？空数组 = ready 可启动；非空 = 缺哪些字段。
 *
 * 不抛错——即使 config 完全空也只是返回所有 main 相关 missing。
 */
export function checkBootstrap(
  config: ZhixingConfig,
  credentials: ZhixingCredentials,
): MissingField[] {
  const missing: MissingField[] = [];

  const mainProvider = config.llm?.main?.provider;
  const mainModel = config.llm?.main?.model;

  if (!mainProvider) {
    missing.push({
      path: "config.llm.main.provider",
      humanLabel: "主对话 LLM 的服务商 ID（如 siliconflow / deepseek / openai 等）",
      file: "config",
    });
  }

  if (!mainModel) {
    missing.push({
      path: "config.llm.main.model",
      humanLabel: "主对话 LLM 的模型 ID",
      file: "config",
    });
  }

  // provider 缺失的话讨论 apiKey 缺失没意义——下一步用户先选 provider
  if (mainProvider && !hasApiKey(mainProvider, credentials)) {
    missing.push({
      path: `credentials.providers.${mainProvider}.apiKey`,
      humanLabel: `${describeProvider(mainProvider)}的 API Key（主对话 LLM）`,
      file: "credentials",
    });
  }

  // secondary 仅在显式配置且 provider 不同于 main 时需要独立 key——
  // 否则 secondary 复用 main 实例（resolveLLMRoles 兜底逻辑）
  const secondary = config.llm?.secondary;
  if (
    secondary
    && mainProvider
    && secondary.provider !== mainProvider
    && !hasApiKey(secondary.provider, credentials)
  ) {
    missing.push({
      path: `credentials.providers.${secondary.provider}.apiKey`,
      humanLabel: `${describeProvider(secondary.provider)}的 API Key（secondary 角色，独立于 main provider）`,
      file: "credentials",
    });
  }

  return missing;
}

/** 凭证唯一入口：credentials.providers.<id>.apiKey 存在即已填，否则视为缺失。 */
function hasApiKey(
  providerId: string,
  credentials: ZhixingCredentials,
): boolean {
  return Boolean(credentials.providers?.[providerId]?.apiKey);
}

/** 用 PROVIDER_PRESETS 注册名美化 humanLabel；未知 provider 用 id 兜底 */
function describeProvider(providerId: string): string {
  const preset = getPreset(providerId);
  if (preset?.name) return `${preset.name}（${providerId}）`;
  return `${providerId}`;
}
