/**
 * 凭证 loader / writer 测试
 *
 * 关键不变量：
 *   - 文件不存在 + 默认 → 创建模板骨架（含 providers / channels 字段占位）
 *   - 文件不存在 + noAutoCreate → 返回空对象（caller 不创建文件）
 *   - JSON 损坏 → throw CredentialsSchemaError（fail-fast，不 silent）
 *   - 错误消息不泄漏密值（fuzz 含 sk-* 前缀的损坏文件）
 *   - writeCredentials 子表合并是 id 级 + 字段级（不丢任何已有字段）
 *   - version 字段不主动写入；用户已写时原样保留
 */

import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import {
  applyCredentialsPatch,
  CredentialsSchemaError,
  getCredentialsPath,
  loadCredentials,
  writeCredentials,
} from "../credentials-loader.js";
import type { ZhixingCredentials } from "../types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await createTempDir("creds");
});

describe("loadCredentials", () => {
  it("文件不存在 + 默认 → 自动创建模板骨架（含字段占位）", () => {
    const result = loadCredentials({ homeDir: tmpDir });

    // 内存返回值与磁盘内容相同：含 providers + channels 字段结构占位
    expect(result.providers).toBeDefined();
    expect(result.providers?.siliconflow).toBeDefined();
    expect(result.providers?.siliconflow?.apiKey).toBe("");
    expect(result.channels).toBeDefined();
    expect(result.channels?.feishu).toBeDefined();
    expect(result.channels?.feishu?.appId).toBe("");
    expect(result.channels?.feishu?.appSecret).toBe("");

    // 磁盘文件已创建
    const created = fs.readFileSync(getCredentialsPath(tmpDir), "utf-8");
    expect(JSON.parse(created)).toEqual(result);
  });

  it("文件不存在 + noAutoCreate → 不创建文件，返回空对象", () => {
    const result = loadCredentials({ homeDir: tmpDir, noAutoCreate: true });
    expect(result).toEqual({});
    expect(fs.existsSync(getCredentialsPath(tmpDir))).toBe(false);
  });

  it("文件合法 → 返回 parsed，providers/channels 完整保留", () => {
    const filePath = getCredentialsPath(tmpDir);
    const fixture: ZhixingCredentials = {
      providers: {
        siliconflow: { apiKey: "sk-sf" },
        openai: { apiKey: "sk-oai", baseUrl: "https://my-proxy.com" },
      },
      channels: { feishu: { appId: "cli_xxx", appSecret: "sec-1" } },
    };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(fixture), "utf-8");

    expect(loadCredentials({ homeDir: tmpDir })).toEqual(fixture);
  });

  it("用户文件含 version 字段 → 原样保留（loader 不篡改）", () => {
    const filePath = getCredentialsPath(tmpDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({ version: 2, providers: { x: { apiKey: "k" } } }),
      "utf-8",
    );

    const result = loadCredentials({ homeDir: tmpDir });
    expect(result.version).toBe(2);
  });

  it("JSON 损坏 → throw CredentialsSchemaError，message 含路径不含密值", () => {
    const filePath = getCredentialsPath(tmpDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{"providers": {bad json}', "utf-8");

    let caught: unknown;
    try {
      loadCredentials({ homeDir: tmpDir });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CredentialsSchemaError);
    const err = caught as CredentialsSchemaError;
    expect(err.filePath).toBe(filePath);
    expect(err.message).toContain(filePath);
    expect(err.message).not.toMatch(/sk-[A-Za-z0-9]/);
  });

  it("JSON 损坏 fuzz：文件半截凭证 sk-* → 错误消息不泄漏密值原文", () => {
    // 模拟用户编辑文件中途断电 / 误删括号，残留 sk- 前缀的部分凭证。
    // schema error 路径应只引文件位置 + 解析底层描述，不把损坏内容回灌到消息里。
    const filePath = getCredentialsPath(tmpDir);
    const FAKE_SECRET = "sk-fuzz0123456789ABCDEFGHIJKLMNOPqrst";
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      `{"providers":{"siliconflow":{"apiKey":"${FAKE_SECRET}`,
      "utf-8",
    );

    let caught: unknown;
    try {
      loadCredentials({ homeDir: tmpDir });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CredentialsSchemaError);
    const err = caught as CredentialsSchemaError;
    expect(err.message).not.toContain(FAKE_SECRET);
    expect(err.message).not.toMatch(/sk-[A-Za-z0-9]+/);
  });

  it("空 JSON 对象 → 返回 {} 形态", () => {
    const filePath = getCredentialsPath(tmpDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{}", "utf-8");

    const result = loadCredentials({ homeDir: tmpDir });
    expect(result).toEqual({});
  });
});

describe("applyCredentialsPatch · 合并语义", () => {
  it("空 current + 空 patch → 返回空对象（不主动写 version）", () => {
    expect(applyCredentialsPatch({}, {})).toEqual({});
  });

  it("patch 显式 version → 保留", () => {
    const result = applyCredentialsPatch(
      {},
      { version: 2 } as Partial<ZhixingCredentials>,
    );
    expect(result.version).toBe(2);
  });

  it("current 已有 version → patch 未覆盖时保留", () => {
    const result = applyCredentialsPatch({ version: 2 }, {});
    expect(result.version).toBe(2);
  });

  it("追加单 provider 不清除其它 provider", () => {
    const current: ZhixingCredentials = {
      providers: {
        siliconflow: { apiKey: "sk-sf" },
        openai: { apiKey: "sk-oai" },
      },
    };
    const result = applyCredentialsPatch(current, {
      providers: { anthropic: { apiKey: "sk-ant" } },
    });

    expect(result.providers).toEqual({
      siliconflow: { apiKey: "sk-sf" },
      openai: { apiKey: "sk-oai" },
      anthropic: { apiKey: "sk-ant" },
    });
  });

  it("修改同 provider id → 字段级合并（不丢未在 patch 提及的字段）", () => {
    const current: ZhixingCredentials = {
      providers: {
        custom: {
          apiKey: "old",
          baseUrl: "https://x",
          protocol: "openai-compatible",
        },
      },
    };
    const result = applyCredentialsPatch(current, {
      providers: { custom: { apiKey: "new" } },
    });

    expect(result.providers?.custom?.apiKey).toBe("new");
    expect(result.providers?.custom?.baseUrl).toBe("https://x");
    expect(result.providers?.custom?.protocol).toBe("openai-compatible");
  });

  it("channels 同样 id 级 + 字段级合并", () => {
    const current: ZhixingCredentials = {
      channels: {
        feishu: { appSecret: "old", botToken: "bt-1" },
        wecom: { secret: "ws-1" },
      },
    };
    const result = applyCredentialsPatch(current, {
      channels: { feishu: { appSecret: "new" } },
    });

    expect(result.channels).toEqual({
      feishu: { appSecret: "new", botToken: "bt-1" },
      wecom: { secret: "ws-1" },
    });
  });

  it("mcp 同样 id 级 + 字段级合并", () => {
    const current: ZhixingCredentials = {
      mcp: {
        github: { token: "old", apiBase: "u-1" },
        notion: { token: "n-1" },
      },
    };
    const result = applyCredentialsPatch(current, {
      mcp: { github: { token: "new" } },
    });

    expect(result.mcp).toEqual({
      github: { token: "new", apiBase: "u-1" },
      notion: { token: "n-1" },
    });
  });

  it("patch 未提到的子表保留 current", () => {
    const current: ZhixingCredentials = {
      providers: { siliconflow: { apiKey: "sk-sf" } },
      channels: { feishu: { appSecret: "sec-1" } },
    };
    const result = applyCredentialsPatch(current, {
      providers: { anthropic: { apiKey: "sk-ant" } },
    });

    expect(result.channels).toEqual({ feishu: { appSecret: "sec-1" } });
  });
});

describe("writeCredentials · 端到端持久化", () => {
  it("追加新 provider 后磁盘文件包含所有原 provider", async () => {
    const filePath = getCredentialsPath(tmpDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        providers: { siliconflow: { apiKey: "sk-sf" } },
      }),
      "utf-8",
    );

    await writeCredentials(
      { providers: { openai: { apiKey: "sk-oai" } } },
      { homeDir: tmpDir },
    );

    const persisted = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(persisted.providers).toEqual({
      siliconflow: { apiKey: "sk-sf" },
      openai: { apiKey: "sk-oai" },
    });
  });

  it("文件不存在时 writeCredentials 创建文件（仅含 patch 内容，不主动加 version）", async () => {
    await writeCredentials(
      { providers: { siliconflow: { apiKey: "sk-sf" } } },
      { homeDir: tmpDir },
    );

    const filePath = getCredentialsPath(tmpDir);
    expect(fs.existsSync(filePath)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(persisted).toEqual({
      providers: { siliconflow: { apiKey: "sk-sf" } },
    });
    expect(persisted.version).toBeUndefined();
  });

  it("写时不留临时文件", async () => {
    await writeCredentials(
      { providers: { siliconflow: { apiKey: "sk-sf" } } },
      { homeDir: tmpDir },
    );

    const entries = fs.readdirSync(tmpDir);
    const tmpFiles = entries.filter((name) => name.endsWith(".tmp"));
    expect(tmpFiles).toEqual([]);
  });
});
