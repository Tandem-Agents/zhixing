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

  it("提示用户用知行 + 取消方式（不暴露内部架构语）", () => {
    const lines = buildIntroLines(FAKE_PATHS);
    const joined = lines.join("\n");

    // 简洁告知用户在做什么
    expect(joined).toContain("知行");
    // 不应包含内部架构语（AI 访问规则等是给开发者看的，不该暴露给最终用户）
    expect(joined).not.toContain("AI 可读");
    expect(joined).not.toContain("AI 不可读");
    expect(joined).not.toContain("写需用户确认");
  });

  it("workspaceRoot 提供时展示已创建路径", () => {
    const lines = buildIntroLines({
      ...FAKE_PATHS,
      workspaceRoot: "D:\\ZhixingWorkspace",
    });
    const joined = lines.join("\n");

    expect(joined).toContain("D:\\ZhixingWorkspace");
    expect(joined).toContain("已创建");
  });

  it("workspaceRoot 缺失时不展示工作目录行", () => {
    const lines = buildIntroLines(FAKE_PATHS);
    const joined = lines.join("\n");

    expect(joined).not.toContain("工作目录");
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
