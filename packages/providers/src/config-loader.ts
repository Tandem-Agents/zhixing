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
import { mergeIdMap, writeJsonAtomic } from "./internal/io.js";
import type { ZhixingConfig } from "./types.js";

// ─── 错误类型 ───

/**
 * 配置文件读取或解析失败错误。
 *
 * 与 CredentialsSchemaError 对偶；message 仅引文件路径与底层错误描述。
 * 仅用于 writer 路径——loader 当前保留 silent fallback 行为以兼容历史测试。
 */
export class ConfigSchemaError extends Error {
  constructor(
    message: string,
    public readonly filePath: string,
  ) {
    super(message);
    this.name = "ConfigSchemaError";
  }
}

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

/**
 * 推断 ~/.zhixing 目录。
 *
 * 优先级：
 *   1. env.ZHIXING_CONFIG_PATH 设置 → 取该路径的 dirname（让 config 与 credentials
 *      跟随同一目录，避免两份文件分裂在不同位置）
 *   2. 默认 → os.homedir()/.zhixing
 *
 * 仅 caller 需要"基于此目录加载多份 zhixing 文件"时使用——例如 cli/serve 入口
 * 同时 load config + credentials 必须保证两者目录一致。
 *
 * 与 getGlobalConfigDir 的差异：
 *   - getGlobalConfigDir() 永远返回 ~/.zhixing，不看 env
 *   - resolveHomeDir(env) 优先按 env.ZHIXING_CONFIG_PATH 推断
 */
export function resolveHomeDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return path.dirname(getGlobalConfigPath(env));
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
  /** ~/.zhixing/ 目录覆盖；优先于 env.ZHIXING_CONFIG_PATH 与默认路径 */
  homeDir?: string;
  env?: Record<string, string | undefined>;
  /** 禁止自动创建全局配置（测试用） */
  noAutoCreate?: boolean;
} = {}): ZhixingConfig {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  // 全局配置路径：homeDir 显式 → env.ZHIXING_CONFIG_PATH → 默认 ~/.zhixing/config.json
  const globalPath = options.homeDir
    ? path.join(options.homeDir, GLOBAL_CONFIG_FILENAME)
    : getGlobalConfigPath(env);
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

// ─── 配置写入 ───

/**
 * 写全局配置文件。原子写 + reader/writer 对偶合并。
 *
 * 合并行为见 applyConfigPatch 文档。
 *
 * 路径解析：传 homeDir → `<homeDir>/config.json`（测试用）；
 * 否则走 `getGlobalConfigPath` 同款解析（含 `ZHIXING_CONFIG_PATH` 环境覆盖）。
 *
 * 错误：current 文件存在但读 / 解析失败 → throw ConfigSchemaError（不静默吞）。
 * 不经任何 AI 工具体系——是程序级 file IO，wizard 与未来 update_config 流程直接调。
 */
export async function writeConfig(
  patch: Partial<ZhixingConfig>,
  options: {
    homeDir?: string;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<void> {
  const filePath = options.homeDir
    ? path.join(options.homeDir, GLOBAL_CONFIG_FILENAME)
    : getGlobalConfigPath(options.env ?? process.env);

  let current: Partial<ZhixingConfig> = {};
  if (fs.existsSync(filePath)) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch (err) {
      throw new ConfigSchemaError(
        `读取配置文件失败：${filePath}（${err instanceof Error ? err.message : String(err)}）`,
        filePath,
      );
    }
    try {
      current = JSON.parse(content) as ZhixingConfig;
    } catch (err) {
      throw new ConfigSchemaError(
        `配置文件 ${filePath} JSON 解析失败：${err instanceof Error ? err.message : String(err)}`,
        filePath,
      );
    }
  }

  const merged = applyConfigPatch(current, patch);
  await writeJsonAtomic(filePath, merged);
}

/**
 * 合并 ZhixingConfig 现状与 patch。
 *
 * 合并语义（与 reader 端 deepMergeConfig 对偶）：
 *   - 标量 / 简单字段（llm / agent / intent / workspace / network）：
 *     patch 显式提供则**整体替换**——caller 显式意图明确
 *   - id-based 子表（providers / channels）：**id 级 + 字段级合并**——
 *     修改单 id 不清空其它 id；修改单 id 内单字段不丢其它字段
 *   - patch 未提到的顶层字段：保留 current
 *
 * 这与 reader 在 providers / channels 上的 id 级合并行为对偶——writer 视角下
 * "current 文件 + patch" 等同于 reader 视角下 "全局 + 项目" 的 id 级合并。
 *
 * 显式删除单字段不在此函数语义内（patch 不包含 = 保留 current）；
 * 显式删除由未来的 removeXxx API 承载。
 *
 * 导出供测试与未来 update_config 流程复用。
 */
export function applyConfigPatch(
  current: Partial<ZhixingConfig>,
  patch: Partial<ZhixingConfig>,
): ZhixingConfig {
  const result: Partial<ZhixingConfig> = { ...current };

  if (patch.llm !== undefined) result.llm = patch.llm;
  if (patch.agent !== undefined) result.agent = patch.agent;
  if (patch.intent !== undefined) result.intent = patch.intent;
  if (patch.workspace !== undefined) result.workspace = patch.workspace;
  if (patch.network !== undefined) result.network = patch.network;

  if (patch.providers !== undefined) {
    result.providers = mergeIdMap(current.providers, patch.providers);
  }
  if (patch.channels !== undefined) {
    result.channels = mergeIdMap(current.channels, patch.channels);
  }

  return result as ZhixingConfig;
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
  "llm": {
    "main": {
      "provider": "siliconflow",
      "model": "Pro/MiniMaxAI/MiniMax-M2.5"
    }
  },
  "providers": {},
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

/**
 * 读取 JSON 配置文件。
 *   - 文件不存在：返回 undefined（loadConfig 据此触发模板创建或 fallback）
 *   - 读 / 解析失败：抛 ConfigSchemaError 让启动期 fail-fast
 *
 * 与 silent fallback 不同——配置损坏时让用户立即看到错误并修复，
 * 比默默当成空配置后下游 LLM 解析报"缺 key"更容易定位问题。
 */
function readJsonSafe(filePath: string): ZhixingConfig | undefined {
  if (!fs.existsSync(filePath)) return undefined;

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new ConfigSchemaError(
      `读取配置文件失败：${filePath}（${err instanceof Error ? err.message : String(err)}）`,
      filePath,
    );
  }

  try {
    return JSON.parse(content) as ZhixingConfig;
  } catch (err) {
    throw new ConfigSchemaError(
      `配置文件 ${filePath} JSON 解析失败：${err instanceof Error ? err.message : String(err)}`,
      filePath,
    );
  }
}

/**
 * 字段级 deep merge。
 * providers 按 key 合并（项目级覆盖全局级的同名 provider 字段）。
 *
 * `base` / `override` 是文件 JSON（readJsonSafe），用户实际可能漏配 `llm.main`；
 * 这里保持原样合并，把 fail-fast 校验留给 resolveLLMRoles，避免在加载层吞掉
 * 用户错误。返回值类型仍 ZhixingConfig —— 下游 resolve 时若 llm.main 缺失会
 * 抛带迁移提示的 ProviderConfigError。
 */
function deepMergeConfig(
  base: Partial<ZhixingConfig>,
  override: Partial<ZhixingConfig>,
): ZhixingConfig {
  const result = { ...base } as ZhixingConfig;

  if (override.llm) {
    result.llm = {
      main: override.llm.main ?? base.llm?.main!,
      secondary: override.llm.secondary ?? base.llm?.secondary,
    };
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

  // channels：与 providers 相同策略，按 key 字段级合并
  if (override.channels) {
    result.channels = { ...base.channels };
    for (const [key, value] of Object.entries(override.channels)) {
      const existing = result.channels[key];
      if (existing) {
        result.channels[key] = { ...existing, ...value };
      } else {
        result.channels[key] = value;
      }
    }
  }

  if (override.agent !== undefined) {
    result.agent = { ...base.agent, ...override.agent };
  }

  // intent：cancelKeywords 是 append 列表（项目级追加全局级，让两层都生效）
  if (override.intent !== undefined || base.intent !== undefined) {
    const baseKw = base.intent?.cancelKeywords ?? [];
    const overrideKw = override.intent?.cancelKeywords ?? [];
    const merged = [...baseKw, ...overrideKw];
    result.intent = {
      ...base.intent,
      ...override.intent,
      ...(merged.length > 0 ? { cancelKeywords: merged } : {}),
    };
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

// ─── 工作区目录保障 ───

/**
 * 工作区目录状态——描述 ensureWorkspaceDir 的执行结果。
 * - exists：目录已存在，无需操作
 * - created：首次创建（首次启动或 CLI --workspace 指定新目录）
 * - recreated：配置了路径但目录被删除/移动，重新创建
 * - skipped：cwd-fallback 或 null，无需创建
 */
export type WorkspaceDirStatus = "exists" | "created" | "recreated" | "skipped";

/**
 * 确保工作区目录存在。
 *
 * 仅在工作区来自配置或 CLI 参数时创建——cwd-fallback 已经是一个存在的目录。
 * 创建失败静默跳过（可能是权限问题），不阻止程序启动。
 */
export function ensureWorkspaceDir(
  workspace: ResolvedWorkspace,
): WorkspaceDirStatus {
  // cwd-fallback 和 null 不需要创建
  if (!workspace.path || workspace.source === "cwd-fallback" || workspace.source === "none") {
    return "skipped";
  }

  try {
    if (fs.existsSync(workspace.path)) {
      return "exists";
    }
    fs.mkdirSync(workspace.path, { recursive: true });
    // 区分首次创建 vs 重建：如果来源是 global-config，说明配置已存在但目录没了
    // 首次启动时配置模板刚生成，目录也不存在，也走 created
    return "created";
  } catch {
    // 静默失败——权限不足或路径无效，不阻止启动
    return "skipped";
  }
}
