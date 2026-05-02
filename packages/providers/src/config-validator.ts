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

import type { ZhixingConfig } from "./types.js";

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
 * 校验：config.providers 字段不允许存在。
 *
 * provider 资源（apiKey + baseUrl + protocol + quirks 等所有字段）属于内容层，
 * 集中在 credentials.providers.<id>。config.json 只引用 provider id（如
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
        "内容层，集中在 credentials.providers.<id>",
      fix:
        "在 config.json 中删除整个 providers 字段；" +
        "把每个 provider 的字段（apiKey + baseUrl + protocol + 等）合并到 " +
        "~/.zhixing/credentials.json 的 providers.<id> 段；" +
        "config.json 只通过 llm.main.provider 引用 provider id",
    },
  ];
};

/**
 * 校验：config.channels 字段不允许存在（旧字段名，已重命名为 messaging）。
 *
 * 旧 schema 用 channels 兼指"启用列表 + 凭证字段"。功能/内容分层后：
 *   - 启用列表 + 功能选项 → config.messaging.<id>
 *   - 凭证 + 链接字段 → credentials.channels.<id>
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
        "channels 的具体凭证与链接字段属于内容层，集中在 credentials.channels.<id>",
      fix:
        "在 config.json 中：把 channels 改名为 messaging；" +
        "每个 channel 条目只保留 type / options / defaultTarget 等功能选项，" +
        "把 credentials 字段（appId / appSecret / 等）整体搬到 " +
        "~/.zhixing/credentials.json 的 channels.<id> 段",
    },
  ];
};

/**
 * 校验：config.messaging.<id> 中不允许出现 credentials 字段。
 *
 * messaging 是功能层（启用列表 + 功能选项）；channel 的具体字段（appId / appSecret）
 * 是内容层，必须在 credentials.channels.<id>。
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
          `把这些字段整体搬到 ~/.zhixing/credentials.json 的 channels.${channelId} 段`,
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
