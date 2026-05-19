/**
 * 模型角色【阻断性】配置缺失检测——纯函数。**单一规则源**。
 *
 * 范围只覆盖 required 角色（main）。这是刻意的单一权威：可选角色
 * （light/power）【永不阻断流程】——它们缺配时回退 main（resolve.ts 记录
 * 降级 + 边缘层可见告警），不产生 blocking issue。可选角色配置是否完善是
 * **咨询性**信息，由 section 层就地按 provider key 真值派生显示（暗色），
 * 不进本检测。把可选角色塞进阻断清单会让一个选填项卡住启动 / 完成。
 *
 * 「必要字段」= 没有它 main 就无法启动 LLM 调用：
 *   - config.llm.main.provider / .model
 *   - credentials.providers[main.provider].apiKey
 *
 * 输出 `ModelIssue[]` 同时服务三类 caller：
 *   - boot 阶段（startup.ts）：用 path 做 non-tty fail-fast 报错；用 label 做用户提示
 *   - editor section（sections/model.ts）：按 role 过滤后产出 SectionEntry blocked.issues
 *   - editor entity 按钮（panels/entity.ts）：preview 校验，用 fieldLabel 做短消息
 *
 * 这样"缺什么字段"只在此处定义一次——避免 sections/entity/checks 三处漂移。
 */

import type { ZhixingConfig, ZhixingCredentials } from "@zhixing/providers";
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

  // 可选角色（light/power）不进阻断清单——它们永不阻断流程，缺配时回退
  // main（见 resolve.ts 降级记录 + 边缘层告警）。其配置完善度是咨询性信息，
  // 由 section 层就地派生暗色显示，不在此产出 issue。

  return issues;
}

/**
 * 某 provider 是否已有 API Key —— "该 provider 能否真正发起请求"的**单一真值
 * 谓词**。checkModel（生成可执行 issue 清单，对同 provider 去重）与 sections
 * 的每行就绪态派生共用此谓词，杜绝两处各自判断 key 而漂移。
 */
export function hasApiKey(
  credentials: ZhixingCredentials,
  providerId: string,
): boolean {
  return Boolean(credentials.providers?.[providerId]?.apiKey);
}
