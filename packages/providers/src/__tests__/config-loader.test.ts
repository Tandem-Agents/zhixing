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
  getProjectConfigPath,
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

describe("getProjectConfigPath", () => {
  it("应返回 cwd 下的 zhixing.config.jsonc", () => {
    const result = getProjectConfigPath("/some/project");
    expect(result).toBe(path.join("/some/project", "zhixing.config.jsonc"));
  });
});

describe("loadConfig", () => {
  let tempHome: string;
  let tempProject: string;

  beforeEach(async () => {
    tempHome = await createTempDir("config-home");
    tempProject = await createTempDir("config-project");
  });

  it("全局和项目配置都不存在时应返回空对象（noAutoCreate）", () => {
    const config = loadConfig({
      cwd: tempProject,
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
      cwd: tempProject,
      env: { ZHIXING_CONFIG_PATH: path.join(globalDir, "config.jsonc") },
      noAutoCreate: true,
    });

    expect(config.llm?.main).toEqual({ provider: "deepseek", model: "deepseek-chat" });
    expect(config.workspace?.root).toBe("/some/workspace");
  });

  it("项目配置的 llm 应覆盖全局配置（main 整体替换、light 字段级）", () => {
    const globalDir = path.join(tempHome, ".zhixing");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, "config.jsonc"),
      JSON.stringify({
        llm: {
          main: { provider: "deepseek", model: "deepseek-chat" },
          light: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
        },
      }),
    );

    fs.writeFileSync(
      path.join(tempProject, "zhixing.config.jsonc"),
      JSON.stringify({
        llm: {
          main: { provider: "deepseek", model: "deepseek-reasoner" },
        },
      }),
    );

    const config = loadConfig({
      cwd: tempProject,
      env: { ZHIXING_CONFIG_PATH: path.join(globalDir, "config.jsonc") },
      noAutoCreate: true,
    });

    expect(config.llm?.main).toEqual({ provider: "deepseek", model: "deepseek-reasoner" });
    // 项目级仅覆盖 main，light 从全局保留
    expect(config.llm?.light).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
    });
  });

  it("项目配置的 messaging 应按 key 合并（不是替换）", () => {
    const globalDir = path.join(tempHome, ".zhixing");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, "config.jsonc"),
      JSON.stringify({
        messaging: {
          feishu: { type: "feishu", options: { logLevel: "info" } },
          slack: {},
        },
      }),
    );

    fs.writeFileSync(
      path.join(tempProject, "zhixing.config.jsonc"),
      JSON.stringify({
        messaging: {
          feishu: { defaultTarget: { to: "C12345" } },
          wecom: {},
        },
      }),
    );

    const config = loadConfig({
      cwd: tempProject,
      env: { ZHIXING_CONFIG_PATH: path.join(globalDir, "config.jsonc") },
      noAutoCreate: true,
    });

    // feishu: 全局 type/options 保留，项目 defaultTarget 合入
    expect(config.messaging?.feishu).toEqual({
      type: "feishu",
      options: { logLevel: "info" },
      defaultTarget: { to: "C12345" },
    });
    // slack: 全局保留
    expect(config.messaging?.slack).toEqual({});
    // wecom: 项目新增
    expect(config.messaging?.wecom).toEqual({});
  });

  it("intent.cancelKeywords 是 append 合并：全局 + 项目都生效", () => {
    const globalDir = path.join(tempHome, ".zhixing");
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalDir, "config.jsonc"),
      JSON.stringify({
        intent: { cancelKeywords: ["全局词1", "全局词2"] },
      }),
    );

    fs.writeFileSync(
      path.join(tempProject, "zhixing.config.jsonc"),
      JSON.stringify({
        intent: { cancelKeywords: ["项目词"] },
      }),
    );

    const config = loadConfig({
      cwd: tempProject,
      env: { ZHIXING_CONFIG_PATH: path.join(globalDir, "config.jsonc") },
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
      path.join(globalDir, "config.jsonc"),
      JSON.stringify({ intent: { cancelKeywords: ["仅全局"] } }),
    );

    const config = loadConfig({
      cwd: tempProject,
      env: { ZHIXING_CONFIG_PATH: path.join(globalDir, "config.jsonc") },
      noAutoCreate: true,
    });

    expect(config.intent?.cancelKeywords).toEqual(["仅全局"]);
  });

  it("自动创建全局配置模板：含 llm.main 默认 + workspace 实际路径 + messaging 空对象", () => {
    const configPath = path.join(tempHome, ".zhixing", "config.jsonc");

    const config = loadConfig({
      cwd: tempProject,
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
      cwd: tempProject,
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
      cwd: tempProject,
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
      cwd: tempProject,
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
        cwd: tempProject,
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

describe("writeConfig · 端到端持久化", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await createTempDir("write-config");
  });

  it("追加新 messaging 后磁盘文件包含所有原 messaging", async () => {
    const filePath = path.join(tempHome, "config.jsonc");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        llm: { main: { provider: "deepseek", model: "deepseek-chat" } },
        messaging: { feishu: { type: "feishu" } },
      }),
      "utf-8",
    );

    await writeConfig(
      { messaging: { wecom: {} } },
      { homeDir: tempHome },
    );

    const persisted = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(persisted.messaging).toEqual({
      feishu: { type: "feishu" },
      wecom: {},
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
