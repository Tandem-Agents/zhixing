/**
 * 主/辅模型角色基础配置缺失检测——纯函数。**单一规则源**。
 *
 * 「必要字段」= 没有它就无法启动 LLM 调用：
 *   - config.llm.main.provider / .model
 *   - credentials.providers[main.provider].apiKey
 *   - 显式配辅助角色（light/power）且 provider 不同时：credentials.providers[<aux>.provider].apiKey
 *
 * 输出 `ModelIssue[]` 同时服务三类 caller：
 *   - boot 阶段（startup.ts）：用 path 做 non-tty fail-fast 报错；用 label 做用户提示
 *   - editor section（sections/model.ts）：按 role 过滤后产出 SectionEntry blocked.issues
 *   - editor entity 按钮（panels/entity.ts）：preview 校验，用 fieldLabel 做短消息
 *
 * 这样"缺什么字段"只在此处定义一次——避免 sections/entity/checks 三处漂移。
 */

import { AUX_ROLE_SPECS, type ZhixingConfig, type ZhixingCredentials } from "@zhixing/providers";
import type { ModelRole } from "../types.js";

/**
 * 模型字段缺失记录——field-based discriminated union。
 *
 * - apiKey 缺失时 `providerId` **类型层面强制存在**（vs 之前 optional 字段）
 * - field 不变量永远与该 variant 携带的字段集合保持一致
 *
 * 公共字段：
 * - role：哪个角色（main / light / power）缺；sections 按此过滤
 * - path：字段路径（boot 错误消息）
 * - label：完整人类可读（"主模型 - X 的 API Key"，用于 boot 提示 / main panel 错误）
 * - fieldLabel：简短字段名（"API Key"，用于 entity 按钮短消息 / entry statusText）
 */
export type ModelIssue =
  | {
      role: ModelRole;
      field: "provider";
      path: string;
      label: string;
      fieldLabel: string;
    }
  | {
      role: ModelRole;
      field: "model";
      path: string;
      label: string;
      fieldLabel: string;
    }
  | {
      role: ModelRole;
      field: "apiKey";
      providerId: string;
      path: string;
      label: string;
      fieldLabel: string;
    };

export function checkModel(
  config: ZhixingConfig,
  credentials: ZhixingCredentials,
): ModelIssue[] {
  const issues: ModelIssue[] = [];

  const mainProvider = config.llm?.main?.provider;
  const mainModel = config.llm?.main?.model;

  if (!mainProvider) {
    issues.push({
      role: "main",
      field: "provider",
      path: "config.llm.main.provider",
      label: "主模型 - 服务商",
      fieldLabel: "服务商",
    });
  }
  if (!mainModel) {
    issues.push({
      role: "main",
      field: "model",
      path: "config.llm.main.model",
      label: "主模型 - 模型",
      fieldLabel: "模型",
    });
  }

  // mainProvider 缺失时不查 apiKey——不知道该查哪个 provider
  if (mainProvider && !hasApiKey(credentials, mainProvider)) {
    issues.push({
      role: "main",
      field: "apiKey",
      providerId: mainProvider,
      path: `credentials.providers.${mainProvider}.apiKey`,
      label: `主模型 - ${mainProvider} 的 API Key`,
      fieldLabel: "API Key",
    });
  }

  // 显式配置的辅助角色（light/power）且 provider 不同于 main 时需要独立 key。
  // 遍历 ROLE_SPECS 中的辅助角色——新增角色零改动；未配置/同 main provider/
  // 已有 key 的角色不报。
  for (const spec of AUX_ROLE_SPECS) {
    const aux = config.llm?.[spec.id];
    if (
      aux
      && mainProvider
      && aux.provider !== mainProvider
      && !hasApiKey(credentials, aux.provider)
    ) {
      issues.push({
        role: spec.id,
        field: "apiKey",
        providerId: aux.provider,
        path: `credentials.providers.${aux.provider}.apiKey`,
        label: `${spec.labelZh} - ${aux.provider} 的 API Key`,
        fieldLabel: "API Key",
      });
    }
  }

  return issues;
}

function hasApiKey(credentials: ZhixingCredentials, providerId: string): boolean {
  return Boolean(credentials.providers?.[providerId]?.apiKey);
}
