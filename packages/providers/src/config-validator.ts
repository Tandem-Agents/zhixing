/**
 * 配置语义校验层
 *
 * 在 JSON 解析之上的语义层校验：检测违反"凭证唯一入口"原则的字段。
 * loadConfig 仅做 JSON 语法校验；本层做"哪些字段允许出现在 config.json"的语义校验。
 *
 * 校验由 caller（ensureBootstrap / setupChannels）显式调用——保持加载层纯净，
 * 让校验时机与错误处理可控。
 *
 * 可插拔：每个校验器是 (config) => issue[] 的纯函数。未来 channel adapter 可
 * 注册自带的字段约束，无需修改本文件。
 */

import type { ZhixingConfig } from "./types.js";

// ─── 错误结构 ───

/**
 * 单条配置语义违反描述。
 *
 * 三段式信息让用户能直接修复：
 *   - field：违反的字段路径（如 "providers.siliconflow.apiKey"）
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
 * 不内嵌 AI 协助迁移——AI 不能写 credentials.json（被 builtin 规则 block），
 * 也不应该自动改用户文件；让用户用编辑器自改是清晰、安全、尊重主权的路径。
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
 * 校验：config.providers.<id>.apiKey 字段不允许存在。
 *
 * 凭证唯一入口是 ~/.zhixing/credentials.json。任何形态的 apiKey
 * （明文 / env:VAR / helper:CMD）出现在 config.json 都是架构违反。
 */
const validateNoApiKeyInConfig: ConfigValidator = (config) => {
  const issues: ConfigSemanticIssue[] = [];
  const providers = config.providers ?? {};

  for (const [id, providerConfig] of Object.entries(providers)) {
    // 用 runtime 检查访问字段——type 已删除 apiKey，但用户旧文件 JSON.parse 后仍可能有
    const apiKey = (providerConfig as Record<string, unknown>)["apiKey"];
    if (apiKey !== undefined) {
      issues.push({
        field: `providers.${id}.apiKey`,
        reason:
          "凭证字段不允许出现在 config.json —— 凭证唯一入口是 ~/.zhixing/credentials.json，" +
          "config.json 是 AI 可读的公开配置文件",
        fix:
          `在 config.json 中删除 providers.${id}.apiKey 字段；` +
          `在 ~/.zhixing/credentials.json 中写入凭证：` +
          `{ "version": 1, "providers": { "${id}": { "apiKey": "<your-key>" } } }；` +
          `首次配置可在 TTY 终端跑 \`zhixing\` 让向导自动写入凭证文件`,
      });
    }
  }

  return issues;
};

/**
 * 校验：config.channels.<id>.credentials.<name> 不允许含敏感字段名。
 *
 * 命名约定（lowercase 子串匹配）：secret / token / password / apikey
 * 命中即视为密字段——必须迁出到 credentials.channels.<id>。
 *
 * 命名规则不是 over-engineering 的 allow-list——非密字段（appId / clientId 等）
 * 不会触发匹配，只有真正的密字段名会命中。未来 channel adapter 想精确声明
 * 字段语义，注册自定义校验器即可。
 */
const SECRET_NAME_PATTERN = /secret|token|password|apikey/i;

const validateNoChannelSecrets: ConfigValidator = (config) => {
  const issues: ConfigSemanticIssue[] = [];
  const channels = config.channels ?? {};

  for (const [channelId, entry] of Object.entries(channels)) {
    const credentials = entry.credentials ?? {};
    for (const fieldName of Object.keys(credentials)) {
      if (SECRET_NAME_PATTERN.test(fieldName)) {
        issues.push({
          field: `channels.${channelId}.credentials.${fieldName}`,
          reason:
            `敏感字段不允许出现在 config.json —— AI 可读 config.json，` +
            `密字段（含 secret/token/password/apiKey 等命名）必须放在 ~/.zhixing/credentials.json 才能受 AI 隔离规则保护`,
          fix:
            `在 config.json 中删除 channels.${channelId}.credentials.${fieldName} 字段；` +
            `在 ~/.zhixing/credentials.json 中写入：` +
            `{ "version": 1, "channels": { "${channelId}": { "${fieldName}": "<your-secret>" } } }；` +
            `非密字段（如 appId / clientId）保留在 config.json 即可`,
        });
      }
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
  validateNoApiKeyInConfig,
  validateNoChannelSecrets,
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
