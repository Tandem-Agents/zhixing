/**
 * 配置文件加载与合并
 *
 * 三层配置级联（优先级从高到低）：
 * 1. 环境变量（API Keys 等，由 resolveProvider 内部处理）
 * 2. 项目级  <cwd>/zhixing.config.json
 * 3. 用户全局 ~/.zhixing/config.json
 *
 * 设计决策（ADR-003）：
 * - 缺失文件 = 跳过，不报错
 * - 字段级 deep merge，providers 按 key 合并
 * - 首次运行自动创建全局配置模板
 * - ZHIXING_CONFIG_PATH 可覆盖全局配置路径
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ZhixingConfig } from "./types.js";

// ─── 路径解析 ───

const CONFIG_DIR_NAME = ".zhixing";
const GLOBAL_CONFIG_FILENAME = "config.json";
const PROJECT_CONFIG_FILENAME = "zhixing.config.json";

/** 全局配置目录：~/.zhixing/ */
export function getGlobalConfigDir(): string {
  // os.homedir() 获取用户主目录，如 C:\Users\lenovo
  return path.join(os.homedir(), CONFIG_DIR_NAME);
}

/** 全局配置文件路径，可被 ZHIXING_CONFIG_PATH 覆盖 */
export function getGlobalConfigPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env["ZHIXING_CONFIG_PATH"]?.trim();
  if (override) {
    return override.startsWith("~")
      ? path.join(os.homedir(), override.slice(1))
      : override;
  }
  return path.join(getGlobalConfigDir(), GLOBAL_CONFIG_FILENAME);
}

/** 项目配置文件路径 */
export function getProjectConfigPath(cwd: string = process.cwd()): string {
  return path.join(cwd, PROJECT_CONFIG_FILENAME);
}

// ─── 配置加载 ───

/**
 * 加载并合并配置。
 *
 * 顺序：全局 → 项目级覆盖（字段级 deep merge）
 * 环境变量中的 API Key 由 resolveProvider 在更下游处理，这里不涉及。
 */
export function loadConfig(options: {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** 禁止自动创建全局配置（测试用） */
  noAutoCreate?: boolean;
} = {}): ZhixingConfig {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  // 全局配置
  const globalPath = getGlobalConfigPath(env);
  let globalConfig = readJsonSafe(globalPath);

  // 全局配置不存在且允许自动创建 → 生成模板
  if (!globalConfig && !options.noAutoCreate) {
    ensureGlobalConfigTemplate(globalPath);
    globalConfig = readJsonSafe(globalPath);
  }

  // 项目配置
  const projectPath = getProjectConfigPath(cwd);
  const projectConfig = readJsonSafe(projectPath);

  // 合并：全局为底，项目覆盖
  return deepMergeConfig(globalConfig ?? {}, projectConfig ?? {});
}

// ─── 自动生成全局配置模板 ───

const CONFIG_TEMPLATE = `{
  "defaultProvider": "siliconflow",
  "defaultModel": "Pro/MiniMaxAI/MiniMax-M2.5",
  "providers": {
    "siliconflow": {
      "apiKey": "env:SILICONFLOW_API_KEY"
    }
  }
}
`;

/**
 * 首次运行时自动创建全局配置模板。
 * 只在文件不存在时创建，不会覆盖已有配置。
 */
function ensureGlobalConfigTemplate(configPath: string): void {
  try {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(configPath, CONFIG_TEMPLATE, "utf-8");
    }
  } catch {
    // 静默失败——可能是权限问题，不应阻止程序运行
  }
}

// ─── 辅助函数 ───

/** 安全读取 JSON 文件，不存在或解析失败返回 undefined */
function readJsonSafe(filePath: string): ZhixingConfig | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as ZhixingConfig;
  } catch {
    return undefined;
  }
}

/**
 * 字段级 deep merge。
 * providers 按 key 合并（项目级覆盖全局级的同名 provider 字段）。
 */
function deepMergeConfig(base: ZhixingConfig, override: ZhixingConfig): ZhixingConfig {
  const result: ZhixingConfig = { ...base };

  if (override.defaultProvider !== undefined) {
    result.defaultProvider = override.defaultProvider;
  }
  if (override.defaultModel !== undefined) {
    result.defaultModel = override.defaultModel;
  }

  if (override.providers) {
    result.providers = { ...base.providers };
    for (const [key, value] of Object.entries(override.providers)) {
      const existing = result.providers[key];
      if (existing) {
        result.providers[key] = { ...existing, ...value };
      } else {
        result.providers[key] = value;
      }
    }
  }

  return result;
}
