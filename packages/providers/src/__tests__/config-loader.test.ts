import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig, getGlobalConfigPath, getProjectConfigPath } from "../config-loader.js";

// 使用临时目录避免污染真实文件系统
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "zhixing-test-"));
}

function cleanDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

describe("getGlobalConfigPath", () => {
  it("默认应返回 ~/.zhixing/config.json", () => {
    const result = getGlobalConfigPath({});
    expect(result).toContain(".zhixing");
    expect(result).toContain("config.json");
  });

  it("ZHIXING_CONFIG_PATH 应覆盖默认路径", () => {
    const result = getGlobalConfigPath({
      ZHIXING_CONFIG_PATH: "/custom/path/config.json",
    });
    expect(result).toBe("/custom/path/config.json");
  });

  it("ZHIXING_CONFIG_PATH 中的 ~ 应展开为 homedir", () => {
    const result = getGlobalConfigPath({
      ZHIXING_CONFIG_PATH: "~/my-config/zhixing.json",
    });
    expect(result).toBe(path.join(os.homedir(), "my-config/zhixing.json"));
  });
});

describe("getProjectConfigPath", () => {
  it("应返回 cwd 下的 zhixing.config.json", () => {
    const result = getProjectConfigPath("/some/project");
    expect(result).toBe(path.join("/some/project", "zhixing.config.json"));
  });
});

describe("loadConfig", () => {
  let tempHome: string;
  let tempProject: string;

  beforeEach(() => {
    tempHome = createTempDir();
    tempProject = createTempDir();
  });

  afterEach(() => {
    cleanDir(tempHome);
    cleanDir(tempProject);
  });

  it("全局和项目配置都不存在时应返回空对象（noAutoCreate）", () => {
    const config = loadConfig({
      cwd: tempProject,
      env: { ZHIXING_CONFIG_PATH: path.join(tempHome, "nonexistent.json") },
      noAutoCreate: true,
    });

    expect(config).toEqual({});
  });

  it("应正确读取全局配置", () => {
    const globalDir = path.join(tempHome, ".zhixing");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, "config.json"),
      JSON.stringify({
        defaultProvider: "deepseek",
        defaultModel: "deepseek-chat",
        providers: {
          deepseek: { apiKey: "sk-global" },
        },
      }),
    );

    const config = loadConfig({
      cwd: tempProject,
      env: { ZHIXING_CONFIG_PATH: path.join(globalDir, "config.json") },
      noAutoCreate: true,
    });

    expect(config.defaultProvider).toBe("deepseek");
    expect(config.defaultModel).toBe("deepseek-chat");
    expect(config.providers?.deepseek?.apiKey).toBe("sk-global");
  });

  it("项目配置应覆盖全局配置的顶层字段", () => {
    const globalDir = path.join(tempHome, ".zhixing");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, "config.json"),
      JSON.stringify({
        defaultProvider: "deepseek",
        defaultModel: "deepseek-chat",
        providers: {
          deepseek: { apiKey: "sk-global" },
        },
      }),
    );

    fs.writeFileSync(
      path.join(tempProject, "zhixing.config.json"),
      JSON.stringify({
        defaultModel: "deepseek-reasoner",
      }),
    );

    const config = loadConfig({
      cwd: tempProject,
      env: { ZHIXING_CONFIG_PATH: path.join(globalDir, "config.json") },
      noAutoCreate: true,
    });

    expect(config.defaultProvider).toBe("deepseek");
    expect(config.defaultModel).toBe("deepseek-reasoner");
    expect(config.providers?.deepseek?.apiKey).toBe("sk-global");
  });

  it("项目配置的 providers 应按 key 合并（不是替换）", () => {
    const globalDir = path.join(tempHome, ".zhixing");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, "config.json"),
      JSON.stringify({
        providers: {
          deepseek: { apiKey: "sk-ds" },
          siliconflow: { apiKey: "sk-sf" },
        },
      }),
    );

    fs.writeFileSync(
      path.join(tempProject, "zhixing.config.json"),
      JSON.stringify({
        providers: {
          deepseek: { defaultModel: "deepseek-reasoner" },
          openai: { apiKey: "sk-oai", baseUrl: "https://api.openai.com/v1", protocol: "openai-compatible" },
        },
      }),
    );

    const config = loadConfig({
      cwd: tempProject,
      env: { ZHIXING_CONFIG_PATH: path.join(globalDir, "config.json") },
      noAutoCreate: true,
    });

    // deepseek: 全局 apiKey 保留，项目 defaultModel 合入
    expect(config.providers?.deepseek?.apiKey).toBe("sk-ds");
    expect(config.providers?.deepseek?.defaultModel).toBe("deepseek-reasoner");
    // siliconflow: 全局保留
    expect(config.providers?.siliconflow?.apiKey).toBe("sk-sf");
    // openai: 项目新增
    expect(config.providers?.openai?.apiKey).toBe("sk-oai");
  });

  it("自动创建全局配置模板", () => {
    const configPath = path.join(tempHome, ".zhixing", "config.json");

    loadConfig({
      cwd: tempProject,
      env: { ZHIXING_CONFIG_PATH: configPath },
    });

    expect(fs.existsSync(configPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(content.defaultProvider).toBe("siliconflow");
    expect(content.providers?.siliconflow).toBeDefined();
  });

  it("自动创建不应覆盖已有配置", () => {
    const configDir = path.join(tempHome, ".zhixing");
    const configPath = path.join(configDir, "config.json");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ defaultProvider: "my-custom" }),
    );

    loadConfig({
      cwd: tempProject,
      env: { ZHIXING_CONFIG_PATH: configPath },
    });

    const content = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(content.defaultProvider).toBe("my-custom");
  });

  it("JSON 语法错误的配置文件应被跳过（不报错）", () => {
    const configDir = path.join(tempHome, ".zhixing");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      "{ invalid json",
    );

    const config = loadConfig({
      cwd: tempProject,
      env: { ZHIXING_CONFIG_PATH: path.join(configDir, "config.json") },
      noAutoCreate: true,
    });

    expect(config).toEqual({});
  });
});
