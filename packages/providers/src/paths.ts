/**
 * Providers 包路径解析中心。
 *
 * 全 providers 包消费的用户级文件路径（config.jsonc / credentials.json）的唯一
 * 拼接点。其他模块通过本文件取路径，不自拼。
 *
 * 4 级优先级层叠（从高到低）：
 *
 *   1. caller 显式 homeDir 参数
 *   2. ZHIXING_CONFIG_PATH 环境变量（精确文件路径覆盖；其 dirname 同时充当
 *      凭证目录——保证 config 与 credentials 物理同目录，不分裂）
 *   3. ZHIXING_HOME 环境变量（来自 @zhixing/core 的 getZhixingHome）
 *   4. 默认 ~/.zhixing
 *
 * 让 ZHIXING_HOME 与 ZHIXING_CONFIG_PATH 在本层互通——以前两 env var 各被
 * core 与 providers 独立消费、互不知情，导致 ZHIXING_HOME=/foo 时 conversations
 * 走 /foo 但 credentials/config 仍打 ~/.zhixing。
 */

import path from "node:path";

import { expandUserHome, getZhixingHome } from "@zhixing/core";

/**
 * 文件名常量——内部 path 拼接 + caller 在显式 homeDir 场景拼接时用。
 * 文件名属 path 解析 domain 的事实，集中在本文件不让 config-loader / credentials-loader
 * 各自重复定义。
 */
export const GLOBAL_CONFIG_FILENAME = "config.jsonc";
export const CREDENTIALS_FILENAME = "credentials.json";

/**
 * 解析 zhixing 数据目录（不接 caller homeDir 参数；caller 显式覆盖应在上层处理）。
 *
 * 优先级：ZHIXING_CONFIG_PATH dirname > getZhixingHome()（ZHIXING_HOME 或默认）。
 */
function resolveDir(env: Record<string, string | undefined>): string {
  const override = env["ZHIXING_CONFIG_PATH"]?.trim();
  if (override) {
    return path.dirname(expandUserHome(override));
  }
  return getZhixingHome();
}

/** 全局配置目录——zhixing 数据根（含所有 user-level 配置 / 凭证文件）。 */
export function getGlobalConfigDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return resolveDir(env);
}

/**
 * 全局配置文件路径。
 *
 * ZHIXING_CONFIG_PATH 设置 → 直接当完整文件路径用（用户可指向任意 .jsonc 文件）；
 * 否则 → join(globalConfigDir, "config.jsonc")。
 */
export function getGlobalConfigPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env["ZHIXING_CONFIG_PATH"]?.trim();
  if (override) {
    return expandUserHome(override);
  }
  return path.join(getZhixingHome(), GLOBAL_CONFIG_FILENAME);
}

/**
 * 推断 ~/.zhixing 目录——caller 需要"基于此目录加载多份 zhixing 文件"时用，
 * 保证 config 与 credentials 在同目录、不分裂。
 */
export function resolveHomeDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return resolveDir(env);
}

/** 凭证文件路径——caller 显式 homeDir 优先，否则按 env 优先级解析。 */
export function getCredentialsPath(homeDir?: string): string {
  return path.join(homeDir ?? resolveDir(process.env), CREDENTIALS_FILENAME);
}
