/**
 * 引导文案与字段元数据纯函数测试。
 *
 * 关键不变量：
 *   - 敏感字段判定依据 file === "credentials"——决定是否屏蔽终端 echo，
 *     错判会导致 apiKey 在终端可见
 *   - schema 示例对每种字段路径返回有意义的 hint，未识别字段路径走 apiKey 兜底
 *   - intro 文案包含两份文件的绝对路径——用户后续手动编辑时不用猜路径
 */

import { describe, expect, it } from "vitest";
import type { MissingField } from "@zhixing/providers";
import {
  buildIntroLines,
  getSchemaExample,
  isSensitiveField,
} from "../prompts.js";

const credentialsField: MissingField = {
  path: "credentials.providers.siliconflow.apiKey",
  humanLabel: "硅基流动（siliconflow）的 API Key",
  file: "credentials",
};

const configProviderField: MissingField = {
  path: "config.llm.main.provider",
  humanLabel: "主对话 LLM 的服务商 ID",
  file: "config",
};

const configModelField: MissingField = {
  path: "config.llm.main.model",
  humanLabel: "主对话 LLM 的模型 ID",
  file: "config",
};

describe("isSensitiveField", () => {
  it("file === 'credentials' 视为敏感（屏蔽 echo）", () => {
    expect(isSensitiveField(credentialsField)).toBe(true);
  });

  it("file === 'config' 不敏感（明文显示）", () => {
    expect(isSensitiveField(configProviderField)).toBe(false);
    expect(isSensitiveField(configModelField)).toBe(false);
  });
});

describe("getSchemaExample", () => {
  it("provider 字段示例包含内置预设 ID 列表", () => {
    const example = getSchemaExample(configProviderField);
    expect(example).toContain("siliconflow");
    expect(example).toContain("deepseek");
    expect(example).toContain("openai");
    expect(example).toContain("anthropic");
  });

  it("model 字段示例包含具体 model ID 形态", () => {
    const example = getSchemaExample(configModelField);
    // 至少要有一种被普遍认知的模型示例
    expect(example.length).toBeGreaterThan(0);
    expect(example).toMatch(/deepseek-chat|gpt-4o|MiniMax/);
  });

  it("apiKey 字段示例提示敏感字段输入不会显示", () => {
    const example = getSchemaExample(credentialsField);
    expect(example).toMatch(/不会显示|敏感/);
  });

  it("未识别字段路径走 apiKey 兜底（保守提示静默）", () => {
    const unknown: MissingField = {
      path: "credentials.providers.unknown-id.apiKey",
      humanLabel: "...",
      file: "credentials",
    };
    const example = getSchemaExample(unknown);
    // 兜底分支等同于 apiKey 提示，含静默提示
    expect(example).toMatch(/不会显示|敏感/);
  });
});

describe("buildIntroLines", () => {
  const FAKE_PATHS = {
    configPath: "C:\\Users\\test\\.zhixing\\config.json",
    credentialsPath: "C:\\Users\\test\\.zhixing\\credentials.json",
  };

  it("文案中包含两份文件的绝对路径", () => {
    const lines = buildIntroLines(FAKE_PATHS);
    const joined = lines.join("\n");

    expect(joined).toContain(FAKE_PATHS.configPath);
    expect(joined).toContain(FAKE_PATHS.credentialsPath);
  });

  it("提示用户公私文件的隔离语义", () => {
    const lines = buildIntroLines(FAKE_PATHS);
    const joined = lines.join("\n");

    // 公开配置必须明确"AI 可读"语义
    expect(joined).toContain("AI 可读");
    // 凭证文件必须明确"AI 不可读"语义
    expect(joined).toMatch(/AI 不可读|不可读、不可写|不可读 ?、不可写/);
  });

  it("提供取消方式（Ctrl+C 或空输入）", () => {
    const lines = buildIntroLines(FAKE_PATHS);
    const joined = lines.join("\n");

    expect(joined).toContain("Ctrl+C");
    expect(joined).toMatch(/空输入|空值|回车/);
  });

  it("返回行数组——每行不含 \\n（由 caller 自行拼接）", () => {
    const lines = buildIntroLines(FAKE_PATHS);
    expect(Array.isArray(lines)).toBe(true);
    for (const line of lines) {
      expect(line).not.toContain("\n");
    }
  });
});
