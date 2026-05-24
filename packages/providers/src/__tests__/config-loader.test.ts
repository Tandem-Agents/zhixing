import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createTempDir } from "@zhixing/test-utils";
import {
  applyConfigPatch,
  ConfigSchemaError,
  loadConfig,
  getGlobalConfigPath,
  writeConfig,
} from "../config-loader.js";
import { ROLE_RECOMMENDATIONS } from "../role-recommendations.js";
import type { ZhixingConfig } from "../types.js";

describe("getGlobalConfigPath", () => {
  it("默认应返回 ~/.zhixing/config.jsonc", () => {
    const result = getGlobalConfigPath({});
    expect(result).toContain(".zhixing");
    expect(result).toContain("config.jsonc");
  });

  it("ZHIXING_CONFIG_PATH 应覆盖默认路径", () => {
    const result = getGlobalConfigPath({
      ZHIXING_CONFIG_PATH: "/custom/path/config.jsonc",
    });
    expect(result).toBe("/custom/path/config.jsonc");
  });

  it("ZHIXING_CONFIG_PATH 中的 ~ 应展开为 homedir", () => {
    const result = getGlobalConfigPath({
      ZHIXING_CONFIG_PATH: "~/my-config/zhixing.json",
    });
    expect(result).toBe(path.join(os.homedir(), "my-config/zhixing.json"));
  });
});

describe("loadConfig", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await createTempDir("config-home");
  });

  it("全局配置不存在时应返回空对象（noAutoCreate）", () => {
    const config = loadConfig({
      env: { ZHIXING_CONFIG_PATH: path.join(tempHome, "nonexistent.json") },
      noAutoCreate: true,
    });

    expect(config).toEqual({});
  });

  it("应正确读取全局配置（llm.main + workspace + messaging）", () => {
    const globalDir = path.join(tempHome, ".zhixing");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, "config.jsonc"),
      JSON.stringify({
        llm: {
          main: { provider: "deepseek", model: "deepseek-chat" },
        },
        workspace: { root: "/some/workspace" },
      }),
    );

    const config = loadConfig({
      env: { ZHIXING_CONFIG_PATH: path.join(globalDir, "config.jsonc") },
      noAutoCreate: true,
    });

    expect(config.llm?.main).toEqual({ provider: "deepseek", model: "deepseek-chat" });
    expect(config.workspace?.root).toBe("/some/workspace");
  });

  it("配置与运行目录无关：cwd 下的 zhixing.config.jsonc 被忽略（无项目配置层）", async () => {
    const globalDir = path.join(tempHome, ".zhixing");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, "config.jsonc"),
      JSON.stringify({
        llm: { main: { provider: "deepseek", model: "deepseek-chat" } },
      }),
    );
    // 在某工作目录放一份旧式项目配置——loadConfig 不再读 cwd，应被完全忽略
    const strayDir = await createTempDir("config-stray");
    fs.writeFileSync(
      path.join(strayDir, "zhixing.config.jsonc"),
      JSON.stringify({
        llm: { main: { provider: "SHOULD-BE-IGNORED", model: "x" } },
      }),
    );

    const prevCwd = process.cwd();
    try {
      process.chdir(strayDir);
      const config = loadConfig({
        env: { ZHIXING_CONFIG_PATH: path.join(globalDir, "config.jsonc") },
        noAutoCreate: true,
      });
      // 取全局值，cwd 下的文件零影响
      expect(config.llm?.main).toEqual({
        provider: "deepseek",
        model: "deepseek-chat",
      });
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("intent 从全局配置正常加载", () => {
    const globalDir = path.join(tempHome, ".zhixing");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, "config.jsonc"),
      JSON.stringify({ intent: { cancelKeywords: ["仅全局"] } }),
    );

    const config = loadConfig({
      env: { ZHIXING_CONFIG_PATH: path.join(globalDir, "config.jsonc") },
      noAutoCreate: true,
    });

    expect(config.intent?.cancelKeywords).toEqual(["仅全局"]);
  });

  it("自动创建全局配置模板：含 llm.main 默认 + workspace 实际路径 + messaging 空对象", () => {
    const configPath = path.join(tempHome, ".zhixing", "config.jsonc");

    const config = loadConfig({
      env: { ZHIXING_CONFIG_PATH: configPath },
    });

    expect(fs.existsSync(configPath)).toBe(true);
    // 断言"派生关系"而非"字面值"：模板从 ROLE_RECOMMENDATIONS.main 派生。
    // 未来改主推荐只需改 role-recommendations.ts 一处，本测试自动跟上 —— 既
    // 守护"单一事实源"的真值传递（loadConfig autoCreate → 写盘 → 读回），又
    // 不在本处冻结字面值（避免成为第三份事实源）。
    expect(config.llm?.main?.provider).toBe(ROLE_RECOMMENDATIONS.main?.provider);
    expect(config.llm?.main?.model).toBe(ROLE_RECOMMENDATIONS.main?.model);
    // light 同理单一事实源派生（已定义推荐 → 模板生效条目，loader 解析得出）。
    // 守护"模板不再硬编码 vendor、与推荐表零漂移"——双源回归会在此失败。
    expect(config.llm?.light?.provider).toBe(ROLE_RECOMMENDATIONS.light?.provider);
    expect(config.llm?.light?.model).toBe(ROLE_RECOMMENDATIONS.light?.model);
    // 模板不含 providers 字段（已删除——provider 资源在 credentials.json）
    expect((config as Record<string, unknown>).providers).toBeUndefined();
    // messaging 空对象（启用列表，用户用时手添）
    expect(config.messaging).toEqual({});
    // workspace.root 已写入实际路径
    expect(config.workspace?.root).toBeTruthy();
  });

  it("模板含 JSONC 注释——loader 容忍解析", () => {
    const configPath = path.join(tempHome, ".zhixing", "config.jsonc");

    loadConfig({
      env: { ZHIXING_CONFIG_PATH: configPath },
    });

    const rawContent = fs.readFileSync(configPath, "utf-8");
    expect(rawContent).toContain("//");
    expect(rawContent).toContain("main（必填）");
    expect(rawContent).toContain("light");
    expect(rawContent).toContain("workspace");
    expect(rawContent).toContain("messaging");
  });

  it("自动创建不应覆盖已有配置", () => {
    const configDir = path.join(tempHome, ".zhixing");
    const configPath = path.join(configDir, "config.jsonc");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        llm: { main: { provider: "my-custom", model: "my-model" } },
      }),
    );

    loadConfig({
      env: { ZHIXING_CONFIG_PATH: configPath },
    });

    const content = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(content.llm?.main?.provider).toBe("my-custom");
  });

  it("含注释的合法 JSONC 配置 → 正常解析", () => {
    const globalDir = path.join(tempHome, ".zhixing");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, "config.jsonc"),
      `{
  // 这是一行注释
  "llm": {
    /* 块注释 */
    "main": { "provider": "openai", "model": "gpt-4o" }
  }
}`,
    );

    const config = loadConfig({
      env: { ZHIXING_CONFIG_PATH: path.join(globalDir, "config.jsonc") },
      noAutoCreate: true,
    });

    expect(config.llm?.main).toEqual({ provider: "openai", model: "gpt-4o" });
  });

  it("JSON 语法错误的配置文件应抛 ConfigSchemaError（fail-fast）", () => {
    const configDir = path.join(tempHome, ".zhixing");
    fs.mkdirSync(configDir, { recursive: true });
    const filePath = path.join(configDir, "config.jsonc");
    fs.writeFileSync(filePath, "{ invalid json");

    let caught: unknown;
    try {
      loadConfig({
        env: { ZHIXING_CONFIG_PATH: filePath },
        noAutoCreate: true,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConfigSchemaError);
    if (caught instanceof ConfigSchemaError) {
      expect(caught.filePath).toBe(filePath);
      expect(caught.message).toContain(filePath);
    }
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

  it("messaging 子表 → id 级 + 字段级合并（不丢其它 id 与同 id 其它字段）", () => {
    const current: Partial<ZhixingConfig> = {
      messaging: {
        feishu: { type: "feishu", options: { logLevel: "info" } },
        slack: { type: "slack" },
      },
    };
    const result = applyConfigPatch(current, {
      messaging: {
        feishu: { defaultTarget: { to: "U123" } },
        wecom: {},
      },
    });

    expect(result.messaging).toEqual({
      feishu: {
        type: "feishu",
        options: { logLevel: "info" },
        defaultTarget: { to: "U123" },
      },
      slack: { type: "slack" },
      wecom: {},
    });
  });

  it("mcp.servers 子表 → server id 级 + 字段级合并", () => {
    const current: Partial<ZhixingConfig> = {
      mcp: {
        servers: {
          github: { command: "uvx", args: ["a"] },
          notion: { command: "b" },
        },
      },
    };
    const result = applyConfigPatch(current, {
      mcp: {
        servers: {
          github: { enabled: false },
          linear: { command: "c" },
        },
      },
    });

    expect(result.mcp?.servers).toEqual({
      github: { command: "uvx", args: ["a"], enabled: false },
      notion: { command: "b" },
      linear: { command: "c" },
    });
  });

  it("patch 未提到的字段保留 current", () => {
    const current: Partial<ZhixingConfig> = {
      llm: { main: { provider: "x", model: "y" } },
      messaging: { feishu: {} },
      workspace: { root: "/w" },
    };
    const result = applyConfigPatch(current, {
      messaging: { wecom: {} },
    });

    expect(result.llm).toEqual(current.llm);
    expect(result.workspace).toEqual(current.workspace);
    expect(result.messaging).toEqual({ feishu: {}, wecom: {} });
  });
});

describe("applyConfigPatch · replace 模式（编辑器权威写入，支持删除）", () => {
  it("id 子表整体替换——patch 省略的 server / channel 被删除", () => {
    const current: Partial<ZhixingConfig> = {
      mcp: { servers: { notion: { type: "stdio" }, github: { type: "http" } } },
      messaging: { feishu: {}, slack: {} },
    };
    // patch 省略 notion 与 slack（编辑器删除它们）
    const result = applyConfigPatch(
      current,
      {
        mcp: { servers: { github: { type: "http" } } },
        messaging: { feishu: {} },
      },
      "replace",
    );
    expect(result.mcp?.servers).toEqual({ github: { type: "http" } });
    expect(result.messaging).toEqual({ feishu: {} });
  });

  it("默认 merge 模式：patch 省略的 id 仍保留（契约不变）", () => {
    const current: Partial<ZhixingConfig> = {
      mcp: { servers: { notion: { type: "stdio" } } },
    };
    const result = applyConfigPatch(current, {
      mcp: { servers: { github: { type: "http" } } },
    });
    expect(result.mcp?.servers).toEqual({
      notion: { type: "stdio" },
      github: { type: "http" },
    });
  });
});

describe("writeConfig · 端到端持久化", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await createTempDir("write-config");
  });

  it("权威写入：id 子表整体替换（省略的 id 被删除）+ 未提及顶层字段保留", async () => {
    const filePath = path.join(tempHome, "config.jsonc");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        llm: { main: { provider: "deepseek", model: "deepseek-chat" } },
        messaging: { feishu: { type: "feishu" }, wecom: {} },
      }),
      "utf-8",
    );

    // 编辑器权威写入：省略 wecom（= 删除它）；不带 llm（代表"本入口不管的字段"）
    await writeConfig(
      { messaging: { feishu: { type: "feishu" } } } as ZhixingConfig,
      { homeDir: tempHome },
    );

    const persisted = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    // wecom 被删除（id 子表整体替换，删除由省略表达）
    expect(persisted.messaging).toEqual({ feishu: { type: "feishu" } });
    // 未提及的顶层 llm 保留（护未知 / 未管字段不被误删）
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

  it("config.jsonc JSON 损坏 → throw ConfigSchemaError，message 含路径", async () => {
    const filePath = path.join(tempHome, "config.jsonc");
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
