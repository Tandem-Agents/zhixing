/**
 * 启动期 wizard 适配 facade。
 *
 * 把"loadConfig / loadCredentials → checkBootstrap → runBootstrap → reload"
 * 整条流程封装成单一入口，让 CLI 入口（repl / serve）只 switch 状态，
 * 不需要重复 IO 与状态机细节。
 *
 * 错误统一转状态（schema-error）而非 throw——caller 用 discriminated union
 * 一次 switch 处理所有分支，不必在多处散落 try/catch。
 */

import path from "node:path";
import {
  checkBootstrap,
  ConfigSchemaError,
  CredentialsSchemaError,
  getCredentialsPath,
  getGlobalConfigPath,
  loadConfig,
  loadCredentials,
  resolveHomeDir,
  writeConfig,
  writeCredentials,
  type MissingField,
  type ZhixingConfig,
  type ZhixingCredentials,
} from "@zhixing/providers";
import { runBootstrap, type BootstrapWriters } from "./runner.js";
import { TerminalBootstrapInteraction } from "./terminal-interaction.js";
import type { BootstrapInteraction } from "./types.js";

/**
 * 启动期检查结果——caller 据此决定继续启动 / 报错退出。
 *
 * - ready：必要字段齐全，config + credentials 已加载，直接用
 * - completed：wizard 跑完，文件已更新，config + credentials 是最新磁盘状态
 * - cancelled：用户在 wizard 中取消，caller 应正常退出（退出码 0）
 * - non-tty：缺字段且非交互终端，caller 应报错并指引用户去 TTY（退出码 2）
 * - schema-error：现有文件 JSON 损坏，caller 应报错并指引用户修复（退出码 2）
 */
export type BootstrapEntryResult =
  | { kind: "ready"; config: ZhixingConfig; credentials: ZhixingCredentials }
  | { kind: "completed"; config: ZhixingConfig; credentials: ZhixingCredentials }
  | { kind: "cancelled" }
  | { kind: "non-tty"; missing: MissingField[] }
  | { kind: "schema-error"; filePath: string; message: string };

export interface EnsureBootstrapOptions {
  /** 项目级配置查找目录，默认 process.cwd() */
  cwd?: string;
  /** ~/.zhixing/ 目录覆盖，仅测试用 */
  homeDir?: string;
  /** 环境变量来源，默认 process.env */
  env?: Record<string, string | undefined>;
  /** 是否为交互终端，默认按 process.stdin.isTTY 判定 */
  isTTY?: boolean;
  /** 交互实现注入，缺省走 TerminalBootstrapInteraction */
  interaction?: BootstrapInteraction;
}

/**
 * 启动期检查入口。
 *
 * 流程：
 *   1. load 现有 config + credentials（损坏 → schema-error 状态）
 *   2. checkBootstrap 算 missing
 *   3. missing 为空 → ready 状态返回 config + credentials
 *   4. 缺字段 + 非 TTY → non-tty 状态
 *   5. 缺字段 + TTY → 跑 wizard
 *      a. cancelled → cancelled 状态
 *      b. completed → 重新 load 后 completed 状态返回最新磁盘内容
 */
export async function ensureBootstrap(
  options: EnsureBootstrapOptions = {},
): Promise<BootstrapEntryResult> {
  const env = options.env ?? process.env;
  const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY);

  // 路径推断分两层：
  //   - explicitHomeDir：caller 显式传（仅测试用）。传给 loadConfig / writeConfig
  //     时会覆盖 env.ZHIXING_CONFIG_PATH 行为
  //   - credentialsHomeDir：loadCredentials / writeCredentials 没有 env override 概念，
  //     必须 caller 显式传——按 explicit 优先 → resolveHomeDir(env) 推断的顺序，
  //     保证 credentials 与 config 跟随同一目录
  //
  // 生产 caller 不传 explicitHomeDir → loadConfig 走 env override 真实路径，
  //   credentials 跟随推断的 ~/.zhixing 或 ZHIXING_CONFIG_PATH 的 dirname
  const explicitHomeDir = options.homeDir;
  const credentialsHomeDir = explicitHomeDir ?? resolveHomeDir(env);

  // wizard 显示给用户的路径——与 loadConfig 实际读取行为对偶
  const configPath = explicitHomeDir
    ? path.join(explicitHomeDir, "config.json")
    : getGlobalConfigPath(env);
  const credentialsPath = getCredentialsPath(credentialsHomeDir);

  let config: ZhixingConfig;
  let credentials: ZhixingCredentials;
  try {
    config = loadConfig({ cwd: options.cwd, homeDir: explicitHomeDir, env });
    credentials = loadCredentials({ homeDir: credentialsHomeDir });
  } catch (err) {
    const schemaResult = toSchemaErrorResult(err);
    if (schemaResult) return schemaResult;
    throw err;
  }

  const missing = checkBootstrap(config, credentials);

  if (missing.length === 0) {
    return { kind: "ready", config, credentials };
  }

  if (!isTTY) {
    return { kind: "non-tty", missing };
  }

  const interaction =
    options.interaction ?? new TerminalBootstrapInteraction();

  const writers: BootstrapWriters = {
    writeConfig: (patch) =>
      writeConfig(patch, { homeDir: explicitHomeDir, env }),
    writeCredentials: (patch) =>
      writeCredentials(patch, { homeDir: credentialsHomeDir }),
  };

  let wizardResult;
  try {
    wizardResult = await runBootstrap({
      initialConfig: config,
      initialCredentials: credentials,
      configPath,
      credentialsPath,
      interaction,
      writers,
    });
  } catch (err) {
    const schemaResult = toSchemaErrorResult(err);
    if (schemaResult) return schemaResult;
    throw err;
  }

  if (wizardResult === "cancelled") {
    return { kind: "cancelled" };
  }

  // 重新 load 拿到 wizard 写盘后的最新状态——working state 是内存累积，
  // 不一定与磁盘内容字字对应（writer 内部走 mergeIdMap 等合并逻辑）。
  const updatedConfig = loadConfig({
    cwd: options.cwd,
    homeDir: explicitHomeDir,
    env,
  });
  const updatedCredentials = loadCredentials({ homeDir: credentialsHomeDir });

  return {
    kind: "completed",
    config: updatedConfig,
    credentials: updatedCredentials,
  };
}

/** 把 schema 错误转成 result 状态——其它错误返回 null 让 caller 继续抛 */
function toSchemaErrorResult(
  err: unknown,
): { kind: "schema-error"; filePath: string; message: string } | null {
  if (
    err instanceof CredentialsSchemaError
    || err instanceof ConfigSchemaError
  ) {
    return {
      kind: "schema-error",
      filePath: err.filePath,
      message: err.message,
    };
  }
  return null;
}
