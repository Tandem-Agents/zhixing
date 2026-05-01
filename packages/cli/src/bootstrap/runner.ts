/**
 * 首次引导流程编排——纯逻辑层。
 *
 * 职责：
 *   1. 拿初始 config / credentials 作 working state
 *   2. 循环：checkBootstrap 算缺失 → 询问首个缺失字段 → 累积到 working state
 *   3. 用户取消 → 不写盘，返回 "cancelled"
 *   4. 全部填齐 → batch 写 config / credentials → 返回 "completed"
 *
 * 不感知：readline、stdin、tty、文件系统。所有 IO 经接口注入（interaction / writers）。
 *
 * 设计要点：
 *   - 动态判定：每填一个字段后重算 missing，处理"先填 provider 再判 apiKey 缺哪个"
 *     的依赖关系
 *   - 批量提交：中途取消不留半截写入；磁盘要么完整更新要么完全不动
 *   - 字段域追踪：用 boolean 标记哪类文件被触摸，仅写真正变化的部分
 */

import {
  checkBootstrap,
  type MissingField,
  type ZhixingConfig,
  type ZhixingCredentials,
} from "@zhixing/providers";
import {
  getSchemaExample,
  isSensitiveField,
  NEXT_STEP_HINT,
} from "./prompts.js";
import type {
  BootstrapInteraction,
  BootstrapResult,
} from "./types.js";

/**
 * 写盘接口——runner 只通过它持久化，不直接调 fs / providers loader。
 *
 * 让 caller 决定写到哪（生产用 @zhixing/providers 的 writeConfig / writeCredentials；
 * 测试用 in-memory mock）。
 */
export interface BootstrapWriters {
  writeConfig(patch: Partial<ZhixingConfig>): Promise<void>;
  writeCredentials(patch: Partial<ZhixingCredentials>): Promise<void>;
}

export interface RunBootstrapArgs {
  /** 当前 config 文件内容（已加载） */
  initialConfig: ZhixingConfig;
  /** 当前 credentials 文件内容（已加载） */
  initialCredentials: ZhixingCredentials;
  /** config.json 绝对路径，仅用于向用户展示 */
  configPath: string;
  /** credentials.json 绝对路径，仅用于向用户展示 */
  credentialsPath: string;
  interaction: BootstrapInteraction;
  writers: BootstrapWriters;
}

export async function runBootstrap(
  args: RunBootstrapArgs,
): Promise<BootstrapResult> {
  const workingConfig = structuredClone(args.initialConfig);
  const workingCredentials = structuredClone(args.initialCredentials);

  let configTouched = false;
  let credentialsTouched = false;

  const initialMissing = checkBootstrap(workingConfig, workingCredentials);

  try {
    await args.interaction.printIntro({
      configPath: args.configPath,
      credentialsPath: args.credentialsPath,
      missing: initialMissing,
    });

    if (initialMissing.length === 0) {
      await args.interaction.printSummary({
        written: { config: false, credentials: false },
        nextStepHint: NEXT_STEP_HINT,
      });
      return "completed";
    }

    while (true) {
      const missing = checkBootstrap(workingConfig, workingCredentials);
      if (missing.length === 0) break;

      const field = missing[0]!;
      const answer = await args.interaction.askField({
        field,
        schemaExample: getSchemaExample(field),
        silent: isSensitiveField(field),
      });

      if (answer.kind === "cancel") {
        return "cancelled";
      }

      applyField(workingConfig, workingCredentials, field, answer.value);

      if (field.file === "config") configTouched = true;
      if (field.file === "credentials") credentialsTouched = true;
    }

    if (configTouched) {
      await args.writers.writeConfig({ llm: workingConfig.llm });
    }
    if (credentialsTouched) {
      await args.writers.writeCredentials({
        providers: workingCredentials.providers,
      });
    }

    await args.interaction.printSummary({
      written: {
        config: configTouched,
        credentials: credentialsTouched,
      },
      nextStepHint: NEXT_STEP_HINT,
    });

    return "completed";
  } finally {
    await args.interaction.close();
  }
}

/**
 * 把用户输入应用到 working state。
 *
 * field.path 形如：
 *   - "config.llm.main.provider"
 *   - "config.llm.main.model"
 *   - "credentials.providers.<id>.apiKey"
 */
function applyField(
  config: ZhixingConfig,
  credentials: ZhixingCredentials,
  field: MissingField,
  value: string,
): void {
  switch (field.path) {
    case "config.llm.main.provider":
      ensureMain(config).provider = value;
      return;
    case "config.llm.main.model":
      ensureMain(config).model = value;
      return;
    default: {
      const match = field.path.match(/^credentials\.providers\.(.+)\.apiKey$/);
      if (!match) {
        throw new Error(`未知的缺失字段路径：${field.path}`);
      }
      const providerId = match[1]!;
      if (!credentials.providers) credentials.providers = {};
      credentials.providers[providerId] = {
        ...credentials.providers[providerId],
        apiKey: value,
      };
    }
  }
}

/** 保证 config.llm.main 存在（占位空字符串，由后续字段询问填实） */
function ensureMain(config: ZhixingConfig): { provider: string; model: string } {
  if (!config.llm) {
    config.llm = { main: { provider: "", model: "" } };
  } else if (!config.llm.main) {
    config.llm.main = { provider: "", model: "" };
  }
  return config.llm.main;
}
