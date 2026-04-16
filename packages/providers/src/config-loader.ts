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

/** 获取平台默认工作区路径。Windows 优先使用 D: 盘（避免 C 盘空间不足）。 */
export function getDefaultWorkspacePath(): string {
  const WORKSPACE_DIR_NAME = "ZhixingWorkspace";
  if (process.platform === "win32") {
    if (fs.existsSync("D:\\")) {
      return path.join("D:\\", WORKSPACE_DIR_NAME);
    }
    return path.join(os.homedir(), WORKSPACE_DIR_NAME);
  }
  return path.join(os.homedir(), WORKSPACE_DIR_NAME);
}

const CONFIG_TEMPLATE = `{
  "defaultProvider": "siliconflow",
  "defaultModel": "Pro/MiniMaxAI/MiniMax-M2.5",
  "providers": {
    "siliconflow": {
      "apiKey": "env:SILICONFLOW_API_KEY"
    }
  },
  "workspace": {
    "root": "${getDefaultWorkspacePath().replace(/\\/g, "\\\\")}"
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

  // workspace：目录级配置整体覆盖全局配置（不做字段级 merge，
  // 因为目录级 workspace 含义是"在此目录下工作区换成这个"）
  if (override.workspace !== undefined) {
    result.workspace = override.workspace;
  }

  return result;
}

// ─── 工作区解析 ───

/**
 * 工作区来源——标记当前生效的工作区是从哪个配置层级得到的。
 * 智能体可据此向用户说明"你的工作区来自 XX 配置"。
 */
export type WorkspaceSource =
  | "cli"              // CLI --workspace 参数
  | "directory-config" // 目录级 zhixing.config.json
  | "global-config"    // 全局 ~/.zhixing/config.json
  | "cwd-fallback"     // 无配置时回退到当前工作目录
  | "none";            // 非交互模式且无配置

export interface ResolvedWorkspace {
  /** 解析后的绝对路径，null 表示无工作区上下文 */
  path: string | null;
  /** 工作区来源 */
  source: WorkspaceSource;
}

/**
 * 按优先级链解析工作区：CLI --workspace > 目录级配置 > 全局配置 > cwd 兜底。
 *
 * @param config 合并后的配置（loadConfig 返回值）
 * @param options 解析选项
 */
export function resolveWorkspace(
  config: ZhixingConfig,
  options: {
    /** CLI --workspace 参数值 */
    cliWorkspace?: string;
    /** 配置来源：合并后的 workspace 字段来自哪层（由 loadConfig 判断） */
    configSource?: "directory-config" | "global-config";
    /** 目录级配置文件所在目录（用于解析相对路径） */
    configDir?: string;
    /** 会话类型 */
    sessionType?: "interactive" | "ci";
  } = {},
): ResolvedWorkspace {
  // 优先级 1：CLI --workspace
  if (options.cliWorkspace) {
    return { path: path.resolve(options.cliWorkspace), source: "cli" };
  }

  // 优先级 2/3：配置文件中的 workspace.root
  if (config.workspace?.root) {
    const root = config.workspace.root;
    const resolved = path.isAbsolute(root)
      ? root
      : path.resolve(options.configDir ?? process.cwd(), root);
    const source = options.configSource ?? "global-config";
    return { path: resolved, source };
  }

  // 优先级 4：交互模式回退到 cwd
  if ((options.sessionType ?? "interactive") === "interactive") {
    return { path: process.cwd(), source: "cwd-fallback" };
  }

  // 非交互模式且无配置 → 无工作区
  return { path: null, source: "none" };
}
