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

import {
  hasExplicitUrlCredentialsOrQueryAuth,
  isAdapterImplemented,
  isLLMConfigV2,
  type ModelConnectionConfig,
  type ProviderCredentialProjection,
  type RoleId as ModelRole,
  type ZhixingConfig,
} from "@zhixing-ai/providers";

export type ConnectionCredentialStatus =
  | "none"
  | "ready"
  | "missing"
  | "revoked"
  | "compromised";

/**
 * 判定单条 v2 连接的凭据就绪态（唯一规则源）：
 * - auth.mode === "none" → "none"（免密连接天然就绪，永不要求 API Key）；
 * - compromisedModelSecretTokens 命中 → "compromised"（已封禁，存在但不可读取，需替换）；
 * - revokedModelSecretRefs 命中 → "revoked"（已撤销，需重新录入）；
 * - modelSecrets[secretRef] 非空且类型匹配 → "ready"；否则 "missing"。
 */
export function connectionCredentialStatus(
  connection: ModelConnectionConfig,
  credentials: ProviderCredentialProjection,
): ConnectionCredentialStatus {
  if (connection.auth.mode === "none") return "none";
  const secretRef = connection.auth.secretRef;
  if (credentials.compromisedModelSecretTokens?.[secretRef]) return "compromised";
  if (credentials.revokedModelSecretRefs?.includes(secretRef)) return "revoked";
  const entry = credentials.modelSecrets?.[secretRef];
  if (entry && entry.kind === connection.auth.mode && entry.value.trim().length > 0) {
    return "ready";
  }
  return "missing";
}

export function isConnectionReady(
  connection: ModelConnectionConfig,
  credentials: ProviderCredentialProjection,
): boolean {
  if (!isAdapterImplemented(connection.adapter)) return false;
  const status = connectionCredentialStatus(connection, credentials);
  return status === "none" || status === "ready";
}

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
  credentials: ProviderCredentialProjection,
): ModelIssue[] {
  const issues: ModelIssue[] = [];
  const rawLlm = config.llm as unknown;

  if (isLLMConfigV2(rawLlm)) {
    const main = rawLlm.main;
    const connectionId = main?.connectionId;
    const model = main?.model;

    if (!connectionId) {
      issues.push({
        role: "main",
        field: "provider",
        path: "config.llm.main.connectionId",
        label: "主模型 - 服务商连接",
        fieldLabel: "服务商连接",
      });
    }
    if (!model) {
      issues.push({
        role: "main",
        field: "model",
        path: "config.llm.main.model",
        label: "主模型 - 模型",
        fieldLabel: "模型",
      });
    }
    if (connectionId) {
      const conn = rawLlm.connections[connectionId];
      if (!conn) {
        issues.push({
          role: "main",
          field: "provider",
          path: `config.llm.connections.${connectionId}`,
          label: `主模型 - 服务商连接（${connectionId} 不存在）`,
          fieldLabel: "服务商连接",
        });
      } else if (!isAdapterImplemented(conn.adapter)) {
        issues.push({
          role: "main",
          field: "provider",
          path: `config.llm.connections.${connectionId}.adapter`,
          label: `主模型 - ${conn.name} 所用协议（${conn.adapter}）暂不支持`,
          fieldLabel: "受控协议",
        });
      } else if (conn.auth.mode !== "none") {
        const status = connectionCredentialStatus(conn, credentials);
        const secretLabel = conn.auth.mode === "header" ? "认证头凭据" : "API Key";
        if (status === "compromised") {
          issues.push({
            role: "main",
            field: "apiKey",
            providerId: connectionId,
            path: `credentials.modelSecrets.${conn.auth.secretRef}`,
            label: `主模型 - ${conn.name} 的凭据已封禁（需替换）`,
            fieldLabel: "替换凭据",
          });
        } else if (status === "revoked") {
          issues.push({
            role: "main",
            field: "apiKey",
            providerId: connectionId,
            path: `credentials.modelSecrets.${conn.auth.secretRef}`,
            label: `主模型 - ${conn.name} 的凭据已撤销（需重填）`,
            fieldLabel: secretLabel,
          });
        } else if (status === "missing") {
          issues.push({
            role: "main",
            field: "apiKey",
            providerId: connectionId,
            path: `credentials.modelSecrets.${conn.auth.secretRef}`,
            label: `主模型 - ${conn.name} 的 ${secretLabel}`,
            fieldLabel: secretLabel,
          });
        }
      }
    }
    return issues;
  }

  // Legacy v1 兼容检测
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

  // 旧配置含 URL 内嵌凭据或敏感查询参数被自动迁移阻断时，必须经迁移修复替换后再启动
  for (const [providerId, entry] of Object.entries(credentials.providers ?? {})) {
    if (entry.baseUrl !== undefined && hasExplicitUrlCredentialsOrQueryAuth(entry.baseUrl)) {
      issues.push({
        role: "main",
        field: "provider",
        path: `credentials.providers.${providerId}.baseUrl`,
        label: `旧服务商 ${providerId} 的自定义端点含内嵌凭据或敏感查询参数（需迁移修复）`,
        fieldLabel: "迁移修复端点",
      });
    }
  }

  return issues;
}

/**
 * 某服务商/逻辑凭据引用是否已有可用密钥（兼容 v2 modelSecrets 与 v1 providers）。
 */
export function hasApiKey(
  credentials: ProviderCredentialProjection,
  providerOrSecretId: string,
): boolean {
  if (
    credentials.revokedModelSecretRefs?.includes(providerOrSecretId) ||
    Boolean(credentials.compromisedModelSecretTokens?.[providerOrSecretId])
  ) {
    return false;
  }
  const v2Entry = credentials.modelSecrets?.[providerOrSecretId];
  if (v2Entry && v2Entry.value.trim().length > 0) return true;
  return Boolean(credentials.providers?.[providerOrSecretId]?.apiKey);
}
