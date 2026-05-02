/**
 * 主/辅模型角色基础配置缺失检测——纯函数。
 *
 * 「必要字段」= 没有它就无法启动 LLM 调用：
 *   - config.llm.main.provider / .model
 *   - credentials.providers[main.provider].apiKey
 *   - 显式配 secondary 且 provider 不同时：credentials.providers[secondary.provider].apiKey
 */

import type { ZhixingConfig, ZhixingCredentials } from "@zhixing/providers";

export interface BootModelMissing {
  /** 字段路径（用于错误消息） */
  path: string;
  /** 人类可读的字段说明 */
  label: string;
}

export function checkBootModel(
  config: ZhixingConfig,
  credentials: ZhixingCredentials,
): BootModelMissing[] {
  const missing: BootModelMissing[] = [];

  const mainProvider = config.llm?.main?.provider;
  const mainModel = config.llm?.main?.model;

  if (!mainProvider) {
    missing.push({
      path: "config.llm.main.provider",
      label: "主模型 - 服务商",
    });
  }
  if (!mainModel) {
    missing.push({
      path: "config.llm.main.model",
      label: "主模型 - 模型 ID",
    });
  }

  // mainProvider 缺失时不查 apiKey——不知道该查哪个 provider
  if (mainProvider && !hasApiKey(credentials, mainProvider)) {
    missing.push({
      path: `credentials.providers.${mainProvider}.apiKey`,
      label: `主模型 - ${mainProvider} 的 API Key`,
    });
  }

  // 显式 secondary 且 provider 不同于 main 时需要独立 key
  const secondary = config.llm?.secondary;
  if (
    secondary
    && mainProvider
    && secondary.provider !== mainProvider
    && !hasApiKey(credentials, secondary.provider)
  ) {
    missing.push({
      path: `credentials.providers.${secondary.provider}.apiKey`,
      label: `辅助模型 - ${secondary.provider} 的 API Key`,
    });
  }

  return missing;
}

function hasApiKey(credentials: ZhixingCredentials, providerId: string): boolean {
  return Boolean(credentials.providers?.[providerId]?.apiKey);
}
