/**
 * 配置语义校验层
 *
 * 在 JSON 解析之上的语义层校验：检测违反"功能层 vs 内容层分层"原则的字段。
 * loadConfig 仅做 JSON 语法校验；本层做"哪些字段允许出现在 config.json"的语义校验。
 *
 * 校验由 caller（ensureBootstrap / setupChannels）显式调用——保持加载层纯净，
 * 让校验时机与错误处理可控。
 *
 * 可插拔：每个校验器是 (config) => issue[] 的纯函数。未来 channel adapter 可
 * 注册自带的字段约束，无需修改本文件。
 */

import { validateSingleHopHeaderName } from "@zhixing-ai/network";
import { isLLMConfigV2, type ZhixingConfig } from "./types.js";

// ─── 错误结构 ───

/**
 * 单条配置语义违反描述。
 *
 * 三段式信息让用户能直接修复：
 *   - field：违反的字段路径（如 "providers" / "channels" / "messaging.feishu.credentials.appSecret"）
 *   - reason：为什么不允许
 *   - fix：精确的修复步骤（含 schema 示例）
 */
export interface ConfigSemanticIssue {
  field: string;
  reason: string;
  fix: string;
}

/**
 * 启动期 fail-fast 错误——封装一组 issue 并保留 config 文件路径。
 *
 * caller（CLI / serve 入口）捕获后逐项打印 issue，引导用户手工修复。
 * 不内嵌 AI 协助秘密迁移；用户先清理错误的公开配置，再由配置编辑器的
 * SecretStore 专用流程录入秘密。
 */
export class ConfigSemanticError extends Error {
  constructor(
    public readonly issues: readonly ConfigSemanticIssue[],
    public readonly filePath: string,
  ) {
    super(`config.json 配置语义校验失败：${issues.length} 处违反`);
    this.name = "ConfigSemanticError";
  }
}

// ─── 校验器接口 ───

/** 单个校验器 = 纯函数 (config) → issue[]。多个校验器扁平化合并所有 issue。 */
export type ConfigValidator = (config: ZhixingConfig) => ConfigSemanticIssue[];

// ─── 内置校验器 ───

/**
 * 校验：config.providers 字段不允许存在。
 *
 * provider 资源（apiKey + baseUrl + protocol + quirks 等所有字段）属于内容层，
 * 集中在设备本地 SecretStore。config.json 只引用 provider id（如
 * llm.main.provider），不存放 provider 具体定义。
 */
const validateNoConfigProviders: ConfigValidator = (config) => {
  const providers = (config as Record<string, unknown>)["providers"];
  if (providers === undefined) return [];

  return [
    {
      field: "providers",
      reason:
        "Provider 资源定义不允许出现在 config.json —— provider 的 apiKey 与技术配置都属于" +
        "秘密层，集中在设备本地 SecretStore",
      fix:
        "在 config.json 中删除整个 providers 字段；" +
        "随后运行 `zz`，通过配置向导重新录入每个 provider；" +
        "config.json 只通过 llm.main.provider 引用 provider id",
    },
  ];
};

/**
 * 校验：config.channels 字段不允许存在（旧字段名，已重命名为 messaging）。
 *
 * 旧 schema 用 channels 兼指"启用列表 + 凭证字段"。功能/内容分层后：
 *   - 启用列表 + 功能选项 → config.messaging.<id>
 *   - 凭证 + 链接字段 → 设备本地 SecretStore
 *
 * config.channels 出现一律视为旧 schema 残留，引导用户迁移。
 */
const validateNoConfigChannels: ConfigValidator = (config) => {
  const channels = (config as Record<string, unknown>)["channels"];
  if (channels === undefined) return [];

  return [
    {
      field: "channels",
      reason:
        "config.json 不再使用 channels 字段（已重命名为 messaging 并简化）—— " +
        "channels 的具体凭证与链接字段属于秘密层，集中在设备本地 SecretStore",
      fix:
        "在 config.json 中：把 channels 改名为 messaging；" +
        "每个 channel 条目只保留 type / options / defaultTarget 等功能选项，" +
        "随后运行 `zz`，通过配置向导重新录入 channel 字段",
    },
  ];
};

/**
 * 校验：config.messaging.<id> 中不允许出现 credentials 字段。
 *
 * messaging 是功能层（启用列表 + 功能选项）；channel 的具体字段（appId / appSecret）
 * 是秘密层，必须经 SecretStore 专用流程录入。
 */
const validateNoMessagingCredentials: ConfigValidator = (config) => {
  const issues: ConfigSemanticIssue[] = [];
  const messaging = config.messaging ?? {};

  for (const [channelId, entry] of Object.entries(messaging)) {
    const credentials = (entry as Record<string, unknown>)["credentials"];
    if (credentials !== undefined) {
      issues.push({
        field: `messaging.${channelId}.credentials`,
        reason:
          `Channel 的凭证与链接字段（appId / appSecret 等）属于内容层，` +
          `不允许出现在 config.json 的 messaging 条目中`,
        fix:
          `在 config.json 中删除 messaging.${channelId}.credentials；` +
          `随后运行 \`zz\`，通过配置向导重新录入 ${channelId} 的 channel 字段`,
      });
    }
  }

  return issues;
};

const FORBIDDEN_PUBLIC_SECRET_KEYS = new Set([
  "apikey",
  "api_key",
  "secret",
  "token",
  "password",
  "passwd",
  "authorization",
  "credentials",
]);

const SENSITIVE_ENDPOINT_QUERY_KEYS = new Set([
  "key",
  "api_key",
  "apikey",
  "access_token",
  "token",
  "auth",
  "authorization",
  "secret",
  "client_secret",
  "password",
  "passwd",
  "sig",
  "signature",
]);

const RESERVED_SECRET_REF_PREFIXES = ["configuration/", "credentials/"] as const;

export function hasExplicitUrlCredentialsOrQueryAuth(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username !== "" || parsed.password !== "") return true;
    for (const [key] of parsed.searchParams) {
      if (SENSITIVE_ENDPOINT_QUERY_KEYS.has(key.toLowerCase())) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function isReservedModelSecretRef(secretRef: string): boolean {
  return RESERVED_SECRET_REF_PREFIXES.some((prefix) => secretRef.startsWith(prefix));
}

/** 校验公开配置 llm v2 段不含秘密、非法 URL、保留管理凭据引用或非法认证头。 */
const validatePublicLlmV2: ConfigValidator = (config) => {
  const rawLlm = config.llm as unknown;
  if (rawLlm === undefined || !isLLMConfigV2(rawLlm)) return [];
  const issues: ConfigSemanticIssue[] = [];

  for (const [connId, conn] of Object.entries(rawLlm.connections)) {
    const connObj = conn as unknown as Record<string, unknown>;
    for (const key of Object.keys(connObj)) {
      if (FORBIDDEN_PUBLIC_SECRET_KEYS.has(key.toLowerCase())) {
        issues.push({
          field: `llm.connections.${connId}.${key}`,
          reason: "连接明文凭据必须保存在设备本地 SecretStore，禁止出现在公开 config.jsonc 中",
          fix: `删除 llm.connections.${connId}.${key}，改用 auth.secretRef 经配置入口录入凭据`,
        });
      }
    }

    if (typeof conn.endpoint === "string" && conn.endpoint.trim()) {
      try {
        const parsed = new URL(conn.endpoint);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
          issues.push({
            field: `llm.connections.${connId}.endpoint`,
            reason: `连接端点仅允许 HTTP(S) 协议，当前为 ${parsed.protocol}`,
            fix: "改填合法的 https:// 或经确认的本地/私网 http:// 地址",
          });
        }
        if (parsed.username !== "" || parsed.password !== "") {
          issues.push({
            field: `llm.connections.${connId}.endpoint`,
            reason: "公开连接端点不允许包含 URL userinfo 凭据",
            fix: "从端点 URL 移除用户名与密码，改通过设备本地 SecretStore 配置认证",
          });
        }
        for (const [queryKey] of parsed.searchParams) {
          if (SENSITIVE_ENDPOINT_QUERY_KEYS.has(queryKey.toLowerCase())) {
            issues.push({
              field: `llm.connections.${connId}.endpoint`,
              reason: `公开连接端点不允许携带敏感查询认证参数 "${queryKey}"`,
              fix: "移除端点查询参数中的密钥/令牌，改由 SecretStore 注入认证头",
            });
          }
        }
      } catch {
        issues.push({
          field: `llm.connections.${connId}.endpoint`,
          reason: "连接端点不是合法的 URL",
          fix: "填写完整的 HTTP(S) 端点地址",
        });
      }
    }

    const auth = conn.auth as unknown as Record<string, unknown> | undefined;
    if (auth && typeof auth === "object") {
      for (const key of Object.keys(auth)) {
        if (FORBIDDEN_PUBLIC_SECRET_KEYS.has(key.toLowerCase()) || key === "value") {
          issues.push({
            field: `llm.connections.${connId}.auth.${key}`,
            reason: "公开配置 auth 段只允许存逻辑引用 secretRef，禁止存明文秘密",
            fix: "移除明文字段并通过配置入口写入 SecretStore",
          });
        }
      }
      if (auth.mode === "api-key" || auth.mode === "header") {
        const ref = auth.secretRef;
        if (typeof ref !== "string" || !ref.trim() || ref.trim() !== ref || isReservedModelSecretRef(ref)) {
          issues.push({
            field: `llm.connections.${connId}.auth.secretRef`,
            reason: "逻辑凭据引用无效或指向受保护的系统管理记录路径",
            fix: "使用普通逻辑凭据标识，禁止引用 configuration/* 或 credentials/* 管理路径",
          });
        }
      }
      if (auth.mode === "header") {
        const headerErr =
          typeof auth.headerName === "string"
            ? validateSingleHopHeaderName(auth.headerName)
            : "自定义认证头名称缺失";
        if (headerErr) {
          issues.push({
            field: `llm.connections.${connId}.auth.headerName`,
            reason: headerErr,
            fix: "改用合法且非路由/非逐跳控制的认证头名称（如 X-Api-Key）",
          });
        }
      }
    }
  }

  for (const item of rawLlm.migrationPending ?? []) {
    const record = item as unknown as Record<string, unknown>;
    if (record.kind !== "unattributed-override" && record.kind !== "protected-legacy-roles") {
      issues.push({
        field: "llm.migrationPending",
        reason: "migrationPending 仅允许记录未归属的非秘密旧覆盖项或受保护旧端点的非秘密用途意图，禁止存放秘密或未确认自定义 URL",
        fix: "通过迁移修复入口处置受保护旧记录",
      });
    }
    const serialized = JSON.stringify({
      legacyFields: record.legacyFields ?? {},
      legacyRoles: record.legacyRoles ?? {},
    }).toLowerCase();
    if (
      serialized.includes('"apikey"') ||
      serialized.includes('"baseurl"') ||
      serialized.includes('"endpoint"') ||
      serialized.includes('"authorization"')
    ) {
      issues.push({
        field: "llm.migrationPending",
        reason: "migrationPending 检测到疑似敏感或未确认端点字段，禁止写入公开配置",
        fix: "保留原受保护 SecretStore 记录并经迁移修复入口确认",
      });
    }
  }

  return issues;
};

/**
 * 内置校验器集合。
 *
 * 顺序无意义——每个校验器独立产出 issue，flatMap 合并；caller 看到所有违反。
 */
export const BUILTIN_VALIDATORS: readonly ConfigValidator[] = [
  validateNoConfigProviders,
  validateNoConfigChannels,
  validateNoMessagingCredentials,
  validatePublicLlmV2,
];

// ─── 主入口 ───

/**
 * 跑配置语义校验，返回所有 issue（空数组表示通过）。
 *
 * 默认跑内置校验器集合；caller 可传自定义集合替换或扩展。
 *
 * 纯函数：不读 fs、不抛错、不副作用——把判定与 IO/错误处理完全解耦。
 */
export function validateConfigSemantics(
  config: ZhixingConfig,
  validators: readonly ConfigValidator[] = BUILTIN_VALIDATORS,
): ConfigSemanticIssue[] {
  return validators.flatMap((v) => v(config));
}
