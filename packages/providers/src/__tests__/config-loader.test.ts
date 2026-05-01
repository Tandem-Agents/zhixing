import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  applyConfigPatch,
  ConfigSchemaError,
  loadConfig,
  getGlobalConfigPath,
  getProjectConfigPath,
  writeConfig,
} from "../config-loader.js";
import type { ZhixingConfig } from "../types.js";

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

  it("应正确读取全局配置（llm.main + providers）", () => {
    const globalDir = path.join(tempHome, ".zhixing");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, "config.json"),
      JSON.stringify({
        llm: {
          main: { provider: "deepseek", model: "deepseek-chat" },
        },
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

    expect(config.llm?.main).toEqual({ provider: "deepseek", model: "deepseek-chat" });
    expect(config.providers?.deepseek?.apiKey).toBe("sk-global");
  });

  it("项目配置的 llm 应覆盖全局配置（main 整体替换、secondary 字段级）", () => {
    const globalDir = path.join(tempHome, ".zhixing");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, "config.json"),
      JSON.stringify({
        llm: {
          main: { provider: "deepseek", model: "deepseek-chat" },
          secondary: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
        },
        providers: {
          deepseek: { apiKey: "sk-global" },
          anthropic: { apiKey: "sk-ant" },
        },
      }),
    );

    fs.writeFileSync(
      path.join(tempProject, "zhixing.config.json"),
      JSON.stringify({
        llm: {
          main: { provider: "deepseek", model: "deepseek-reasoner" },
        },
      }),
    );

    const config = loadConfig({
      cwd: tempProject,
      env: { ZHIXING_CONFIG_PATH: path.join(globalDir, "config.json") },
      noAutoCreate: true,
    });

    expect(config.llm?.main).toEqual({ provider: "deepseek", model: "deepseek-reasoner" });
    // 项目级仅覆盖 main，secondary 从全局保留
    expect(config.llm?.secondary).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
    });
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

  it("intent.cancelKeywords 是 append 合并：全局 + 项目都生效", () => {
    const globalDir = path.join(tempHome, ".zhixing");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, "config.json"),
      JSON.stringify({
        intent: { cancelKeywords: ["全局词1", "全局词2"] },
      }),
    );

    fs.writeFileSync(
      path.join(tempProject, "zhixing.config.json"),
      JSON.stringify({
        intent: { cancelKeywords: ["项目词"] },
      }),
    );

    const config = loadConfig({
      cwd: tempProject,
      env: { ZHIXING_CONFIG_PATH: path.join(globalDir, "config.json") },
      noAutoCreate: true,
    });

    expect(config.intent?.cancelKeywords).toEqual([
      "全局词1",
      "全局词2",
      "项目词",
    ]);
  });

  it("intent 仅全局配置 → 透传", () => {
    const globalDir = path.join(tempHome, ".zhixing");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, "config.json"),
      JSON.stringify({ intent: { cancelKeywords: ["仅全局"] } }),
    );

    const config = loadConfig({
      cwd: tempProject,
      env: { ZHIXING_CONFIG_PATH: path.join(globalDir, "config.json") },
      noAutoCreate: true,
    });

    expect(config.intent?.cancelKeywords).toEqual(["仅全局"]);
  });

  it("自动创建全局配置模板（含 llm.main 嵌套，providers 留空骨架）", () => {
    const configPath = path.join(tempHome, ".zhixing", "config.json");

    loadConfig({
      cwd: tempProject,
      env: { ZHIXING_CONFIG_PATH: configPath },
    });

    expect(fs.existsSync(configPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(content.llm?.main?.provider).toBe("siliconflow");
    expect(content.llm?.main?.model).toBe("Pro/MiniMaxAI/MiniMax-M2.5");
    // 模板不再预填 apiKey: "env:..." 占位——凭证经 ~/.zhixing/credentials.json
    // 加载，CI / vault 用户可显式在 providers.<id>.apiKey 写 env:/helper:/明文
    expect(content.providers).toEqual({});
  });

  it("自动创建不应覆盖已有配置", () => {
    const configDir = path.join(tempHome, ".zhixing");
    const configPath = path.join(configDir, "config.json");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        llm: { main: { provider: "my-custom", model: "my-model" } },
      }),
    );

    loadConfig({
      cwd: tempProject,
      env: { ZHIXING_CONFIG_PATH: configPath },
    });

    const content = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(content.llm?.main?.provider).toBe("my-custom");
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

describe("applyConfigPatch · 合并语义", () => {
  it("空 current + 空 patch → 空对象", () => {
    expect(applyConfigPatch({}, {})).toEqual({});
  });

  it("顶层标量字段 patch 显式 → 整体替换", () => {
    const current: Partial<ZhixingConfig> = {
      llm: { main: { provider: "deepseek", model: "deepseek-chat" } },
      workspace: { root: "/old" },
    };
    const result = applyConfigPatch(current, {
      llm: { main: { provider: "openai", model: "gpt-4o" } },
    });

    expect(result.llm).toEqual({ main: { provider: "openai", model: "gpt-4o" } });
    expect(result.workspace).toEqual({ root: "/old" });
  });

  it("providers 子表 → id 级 + 字段级合并（不丢其它 id 与同 id 其它字段）", () => {
    const current: Partial<ZhixingConfig> = {
      providers: {
        siliconflow: {
          apiKey: "env:SF_KEY",
          baseUrl: "https://siliconflow.example.com",
        },
        openai: { apiKey: "env:OAI_KEY" },
      },
    };
    const result = applyConfigPatch(current, {
      providers: {
        siliconflow: { defaultModel: "Pro/MiniMax/M2.5" },
        anthropic: { apiKey: "env:ANT_KEY" },
      },
    });

    expect(result.providers).toEqual({
      siliconflow: {
        apiKey: "env:SF_KEY",
        baseUrl: "https://siliconflow.example.com",
        defaultModel: "Pro/MiniMax/M2.5",
      },
      openai: { apiKey: "env:OAI_KEY" },
      anthropic: { apiKey: "env:ANT_KEY" },
    });
  });

  it("channels 子表同样 id 级 + 字段级合并", () => {
    const current: Partial<ZhixingConfig> = {
      channels: {
        feishu: {
          credentials: { appId: "old-app" },
          options: { receiveMode: "long-poll" },
        },
      },
    };
    const result = applyConfigPatch(current, {
      channels: {
        feishu: { credentials: { appId: "new-app" } },
      },
    });

    expect(result.channels?.feishu.credentials).toEqual({ appId: "new-app" });
    expect(result.channels?.feishu.options).toEqual({ receiveMode: "long-poll" });
  });

  it("patch 未提到的字段保留 current", () => {
    const current: Partial<ZhixingConfig> = {
      llm: { main: { provider: "x", model: "y" } },
      providers: { x: { apiKey: "k" } },
      workspace: { root: "/w" },
    };
    const result = applyConfigPatch(current, {
      providers: { z: { apiKey: "kz" } },
    });

    expect(result.llm).toEqual(current.llm);
    expect(result.workspace).toEqual(current.workspace);
    expect(result.providers).toEqual({
      x: { apiKey: "k" },
      z: { apiKey: "kz" },
    });
  });
});

describe("writeConfig · 端到端持久化", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = createTempDir();
  });

  afterEach(() => cleanDir(tempHome));

  it("追加新 provider 后磁盘文件包含所有原 provider", async () => {
    const filePath = path.join(tempHome, "config.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        llm: { main: { provider: "deepseek", model: "deepseek-chat" } },
        providers: { deepseek: { apiKey: "env:DS" } },
      }),
      "utf-8",
    );

    await writeConfig(
      { providers: { openai: { apiKey: "env:OAI" } } },
      { homeDir: tempHome },
    );

    const persisted = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(persisted.providers).toEqual({
      deepseek: { apiKey: "env:DS" },
      openai: { apiKey: "env:OAI" },
    });
    // 顶层 llm 字段应保留
    expect(persisted.llm).toEqual({
      main: { provider: "deepseek", model: "deepseek-chat" },
    });
  });

  it("写时不留临时文件", async () => {
    await writeConfig(
      { llm: { main: { provider: "deepseek", model: "deepseek-chat" } } },
      { homeDir: tempHome },
    );

    const entries = fs.readdirSync(tempHome);
    expect(entries.filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("config.json JSON 损坏 → throw ConfigSchemaError，message 含路径", async () => {
    const filePath = path.join(tempHome, "config.json");
    fs.writeFileSync(filePath, "{ not json", "utf-8");

    let caught: unknown;
    try {
      await writeConfig({ llm: { main: { provider: "x", model: "y" } } }, {
        homeDir: tempHome,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConfigSchemaError);
    const err = caught as ConfigSchemaError;
    expect(err.filePath).toBe(filePath);
    expect(err.message).toContain(filePath);
  });
});
