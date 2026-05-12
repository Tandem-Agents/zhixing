/**
 * 配置文件加载与合并
 *
 * 两层配置级联（优先级从高到低）：
 * 1. 项目级  <cwd>/zhixing.config.json
 * 2. 用户全局 ~/.zhixing/config.json
 *
 * 配置文件格式：JSONC（JSON with Comments）—— 支持 `//` 和 `/* *​/` 注释，
 * 让用户编辑时直接看到字段说明。读取用 jsonc-parser；写入仍用标准 JSON.stringify
 * （写入会丢注释，所以 wizard 当前流程仅写 credentials.json，不动 config.json
 * 的注释；未来需要改 config.json 时用 surgical edit 保留注释）。
 *
 * 设计决策：
 * - 缺失文件 = 跳过，不报错
 * - 字段级 deep merge，messaging 按 key 合并
 * - 首次运行自动创建全局配置模板
 * - ZHIXING_CONFIG_PATH 可覆盖全局配置路径
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  parse as parseJsonc,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";
import { mergeIdMap, writeJsonAtomic } from "./internal/io.js";
import {
  GLOBAL_CONFIG_FILENAME,
  getGlobalConfigDir,
  getGlobalConfigPath,
  getProjectConfigPath,
  resolveHomeDir,
} from "./paths.js";
import type { ZhixingConfig } from "./types.js";

export {
  getGlobalConfigDir,
  getGlobalConfigPath,
  getProjectConfigPath,
  resolveHomeDir,
};

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
    const errors: ParseError[] = [];
    const parsed = parseJsonc(content, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      const first = errors[0]!;
      const code = printParseErrorCode(first.error);
      throw new ConfigSchemaError(
        `配置文件 ${filePath} JSONC 解析失败：${code}（位置 ${first.offset}）`,
        filePath,
      );
    }
    current = (parsed ?? {}) as Partial<ZhixingConfig>;
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
 *   - id-based 子表（messaging）：**id 级 + 字段级合并**——
 *     修改单 id 不清空其它 id；修改单 id 内单字段不丢其它字段
 *   - patch 未提到的顶层字段：保留 current
 *
 * 这与 reader 在 messaging 上的 id 级合并行为对偶——writer 视角下
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

  if (patch.messaging !== undefined) {
    result.messaging = mergeIdMap(current.messaging, patch.messaging);
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

/**
 * 准备 workspace 目录：计算默认路径 → mkdir → 返回实际路径。
 *
 * mkdir 失败时（权限问题等）返回路径但目录可能不存在；下游 ensureWorkspaceDir
 * 会再次尝试，最终交给运行期防御。
 */
function prepareWorkspaceRoot(): string {
  const root = getDefaultWorkspacePath();
  try {
    if (!fs.existsSync(root)) {
      fs.mkdirSync(root, { recursive: true });
    }
  } catch {
    // 静默失败——不阻止程序启动
  }
  return root;
}

/**
 * 构造 JSONC 配置模板。
 *
 * 含字段说明注释：用户首次启动后用编辑器打开 config.json，直接看到必填 / 选填 /
 * 各字段语义。注释由 jsonc-parser 容忍解析；写入仍走 JSON.stringify（写时丢注释，
 * 但 wizard 当前流程不写 config.json，注释保留）。
 */
function buildConfigTemplate(workspaceRoot: string): string {
  // Windows 路径反斜杠在 JSON 字符串中需 escape
  const escapedRoot = workspaceRoot.replace(/\\/g, "\\\\");
  return `{
  // ─── LLM 角色 ───
  "llm": {
    // main（必填）：主对话模型，所有用户面对的输出由它产生
    "main": {
      "provider": "siliconflow",
      "model": "deepseek-ai/DeepSeek-V4-Flash"
    }

    // secondary（选填，建议配置）：用于上下文净化任务——压缩历史 / WebFetch 蒸馏 /
    // 工具结果摘要 / 子 agent 返回压缩 / 通讯通道入站分类等。
    // 缺省时用 main 兜底，仍保留调用上下文隔离价值（防 prompt injection 污染主对话），
    // 但放弃任务专门化和 cost 优化。建议配一个轻量、便宜的模型。
    // 取消下面这行注释并填入 provider/model 启用（provider 需在 credentials.providers 中存在）：
    // ,"secondary": { "provider": "siliconflow", "model": "deepseek-ai/DeepSeek-V4-Flash" }
  },

  // ─── 工作目录 ───
  // agent 自由读写的范围（安全信任边界）；目录已由首次启动自动创建。
  "workspace": { "root": "${escapedRoot}" },

  // ─── 启用的消息通道 ───
  // 列出要启用的 channel id；每个 channel 的具体字段（appId / appSecret 等）
  // 在 ~/.zhixing/credentials.json 的 channels.<id> 段。
  // 例：启用飞书 → "messaging": { "feishu": {} }
  "messaging": {}

  // ─── 模型注意力阈值（罕见手动调整，可选）───
  // 知行内置每个常见模型的建议阈值；本字段让用户**覆盖指定模型**的阈值。
  // 阈值绑模型不绑 role：切换主模型后旧覆盖因 key 不匹配自动失效。
  // key 写法不敏感：带 vendor 前缀 / 不带 / 大小写都行，系统 normalize 后命中。
  //
  // 取消注释 + 改数值生效：
  // ,"modelCapabilityOverrides": {
  //   "deepseek-ai/DeepSeek-V4-Flash": {
  //     "optimalMaxTokens": 32000,
  //     "riskMaxTokens": 64000
  //   }
  // }
}
`;
}

/**
 * 首次运行时自动创建全局配置模板。
 *
 * 流程：先准备 workspace 目录（mkdir），再用实际创建的路径写入模板的
 * workspace.root 字段。文件已存在时不覆盖。
 */
function ensureGlobalConfigTemplate(configPath: string): void {
  try {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(configPath)) {
      const workspaceRoot = prepareWorkspaceRoot();
      fs.writeFileSync(configPath, buildConfigTemplate(workspaceRoot), "utf-8");
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

  // 用 jsonc-parser 容忍注释（JSONC 格式）；纯 JSON 文件也能正常解析
  const errors: ParseError[] = [];
  const parsed = parseJsonc(content, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const first = errors[0]!;
    const code = printParseErrorCode(first.error);
    throw new ConfigSchemaError(
      `配置文件 ${filePath} JSONC 解析失败：${code}（位置 ${first.offset}）`,
      filePath,
    );
  }
  return parsed as ZhixingConfig;
}

/**
 * 字段级 deep merge。
 * messaging 按 key 合并（项目级覆盖全局级的同名 channel 字段）。
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

  // messaging：按 key 字段级合并
  if (override.messaging) {
    result.messaging = { ...base.messaging };
    for (const [key, value] of Object.entries(override.messaging)) {
      const existing = result.messaging[key];
      if (existing) {
        result.messaging[key] = { ...existing, ...value };
      } else {
        result.messaging[key] = value;
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
