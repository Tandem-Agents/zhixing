/**
 * 用户级凭证文件 ~/.zhixing/credentials.json 的读写
 *
 * 与 config-loader.ts 对偶——读使用同款"文件不存在则创建空骨架"模式；
 * 写采用原子写（temp + rename）防止半截损坏的私密文件。
 *
 * 错误契约：
 *   - 文件不存在 + 允许自动创建 → 创建空骨架 + 返回
 *   - 文件不存在 + noAutoCreate → 返回空骨架副本
 *   - 文件存在但读 / 解析失败 → throw CredentialsSchemaError，message 仅含
 *     路径不含密值，由 CLI 启动期捕获指引用户修复
 *
 * 凭证不参与三层配置级联：用户级单一来源，避免项目级配置文件泄漏到 git。
 */

import fs from "node:fs";
import path from "node:path";
import { mergeIdMap, writeJsonAtomic } from "./internal/io.js";
import { getCredentialsPath } from "./paths.js";
import type { ZhixingCredentials } from "./types.js";

export { getCredentialsPath };

const EMPTY_CREDENTIALS: ZhixingCredentials = {};

/**
 * 凭证文件骨架模板——包含当前阶段支持的资源占位字段（apiKey 与 channel 凭证）。
 *
 * 字段结构系统给好，用户**只需填值**——不研究 schema、不操心字段名拼写。
 *
 * 渐进式扩展：未来支持新 provider / channel 时，把对应占位字段加到这里即可；
 * 用户拉新版 zhixing 后第一次启动会看到新字段（已存在的字段保留原值）。
 */
const TEMPLATE_CREDENTIALS: ZhixingCredentials = {
  providers: {
    siliconflow: { apiKey: "" },
  },
  channels: {
    feishu: { appId: "", appSecret: "" },
  },
};

/**
 * 凭证文件读取或解析失败错误。
 *
 * message 仅引文件路径与底层错误描述——不包含任何已读到的密值，
 * 避免凭证经错误链路泄漏到 logs / telemetry / stderr / 用户屏幕。
 */
export class CredentialsSchemaError extends Error {
  constructor(
    message: string,
    public readonly filePath: string,
  ) {
    super(message);
    this.name = "CredentialsSchemaError";
  }
}

/**
 * 加载凭证。
 *
 * 行为表：
 *   | 文件状态 | noAutoCreate=true | noAutoCreate=false |
 *   |----------|-------------------|--------------------|
 *   | 不存在   | 返回空骨架副本    | 创建模板骨架 + 返回 |
 *   | 读失败   | throw             | throw              |
 *   | 解析失败 | throw             | throw              |
 *   | 合法     | 返回 parsed       | 返回 parsed        |
 *
 * 自动创建时写入 TEMPLATE_CREDENTIALS（含所有支持的 provider / channel 字段
 * 占位空字符串）；用户填值即可，不需要研究 schema 字段名。
 *
 * version 字段当前不主动写入——schema 演进时按"无字段=v1，version=2=v2"探测。
 */
export function loadCredentials(
  options: { homeDir?: string; noAutoCreate?: boolean } = {},
): ZhixingCredentials {
  const filePath = getCredentialsPath(options.homeDir);

  if (!fs.existsSync(filePath)) {
    if (options.noAutoCreate) {
      return { ...EMPTY_CREDENTIALS };
    }
    ensureSkeleton(filePath);
    return structuredClone(TEMPLATE_CREDENTIALS);
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new CredentialsSchemaError(
      `读取凭证文件失败：${filePath}（${err instanceof Error ? err.message : String(err)}）`,
      filePath,
    );
  }

  try {
    return JSON.parse(content) as ZhixingCredentials;
  } catch (err) {
    throw new CredentialsSchemaError(
      `凭证文件 ${filePath} JSON 解析失败：${err instanceof Error ? err.message : String(err)}。` +
        `请检查文件格式或删除文件让程序重新创建空骨架。`,
      filePath,
    );
  }
}

function ensureSkeleton(filePath: string): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(
        filePath,
        JSON.stringify(TEMPLATE_CREDENTIALS, null, 2) + "\n",
        "utf-8",
      );
    }
  } catch {
    // 静默失败——权限问题等不阻止程序运行；下游 resolve 会因缺凭证抛带引导提示的错
  }
}

/**
 * 写凭证。原子写 + 子表 id 级 + 字段级合并。
 *
 * 合并行为见 applyCredentialsPatch 文档。
 *
 * 不经任何 AI 工具体系——是程序级 file IO，wizard 与未来 update_credentials 流程
 * 直接调用；与 builtin 安全规则无关（规则约束的是 AI 工具，不是程序级写）。
 */
export async function writeCredentials(
  patch: Partial<ZhixingCredentials>,
  options: { homeDir?: string } = {},
): Promise<void> {
  const filePath = getCredentialsPath(options.homeDir);
  const current = loadCredentials({
    homeDir: options.homeDir,
    noAutoCreate: true,
  });
  const merged = applyCredentialsPatch(current, patch);
  await writeJsonAtomic(filePath, merged);
}

/**
 * 合并 ZhixingCredentials 现状与 patch。
 *
 * 与 applyConfigPatch 镜像对称：spread current 起点 + 显式覆盖 / mergeIdMap。
 *
 * 合并语义：
 *   - id-based 子表（providers / channels）：**id 级 + 字段级合并**——
 *     修改单 id 不清空其它 id；修改单 id 内单字段不丢其它字段
 *   - patch 未提到的子表：保留 current
 *   - version：patch 显式提供则保留，否则不主动写入（schema 演进时按
 *     "无字段=v1" 探测）
 *
 * 导出供测试与未来 update_credentials 流程复用。
 */
export function applyCredentialsPatch(
  current: ZhixingCredentials,
  patch: Partial<ZhixingCredentials>,
): ZhixingCredentials {
  const result: ZhixingCredentials = { ...current };
  if (patch.version !== undefined) result.version = patch.version;

  if (patch.providers !== undefined) {
    result.providers = mergeIdMap(current.providers, patch.providers);
  }
  if (patch.channels !== undefined) {
    result.channels = mergeIdMap(current.channels, patch.channels);
  }

  return result;
}
