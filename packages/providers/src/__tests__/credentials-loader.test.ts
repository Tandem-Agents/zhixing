/**
 * 凭证 loader / writer 测试
 *
 * 关键不变量：
 *   - version 字段原样保留（reserved-for-future-migration，不篡改）
 *   - JSON 损坏 → throw CredentialsSchemaError（fail-fast，不 silent）
 *   - writeCredentials 子表合并是 id 级 + 字段级（不丢任何已有字段）
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyCredentialsPatch,
  CredentialsSchemaError,
  getCredentialsPath,
  loadCredentials,
  writeCredentials,
} from "../credentials-loader.js";
import type { ZhixingCredentials } from "../types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zhixing-creds-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("loadCredentials", () => {
  it("文件不存在 + 默认 → 自动创建空骨架", () => {
    const result = loadCredentials({ homeDir: tmpDir });
    expect(result).toEqual({ version: 1 });

    const created = fs.readFileSync(getCredentialsPath(tmpDir), "utf-8");
    expect(JSON.parse(created)).toEqual({ version: 1 });
  });

  it("文件不存在 + noAutoCreate → 不创建文件，返回空骨架副本", () => {
    const result = loadCredentials({ homeDir: tmpDir, noAutoCreate: true });
    expect(result).toEqual({ version: 1 });
    expect(fs.existsSync(getCredentialsPath(tmpDir))).toBe(false);
  });

  it("文件合法 → 返回 parsed，providers/channels 完整", () => {
    const filePath = getCredentialsPath(tmpDir);
    const fixture: ZhixingCredentials = {
      version: 1,
      providers: {
        siliconflow: { apiKey: "sk-sf" },
        openai: { apiKey: "sk-oai" },
      },
      channels: { feishu: { appSecret: "sec-1" } },
    };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(fixture), "utf-8");

    expect(loadCredentials({ homeDir: tmpDir })).toEqual(fixture);
  });

  it("version 字段原样保留（reserved，不被 loader 篡改）", () => {
    // 模拟未来 v2 文件（用 cast 绕过 literal type）
    const filePath = getCredentialsPath(tmpDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({ version: 2, providers: { x: { apiKey: "k" } } }),
      "utf-8",
    );

    const result = loadCredentials({ homeDir: tmpDir }) as ZhixingCredentials & {
      version: number;
    };
    expect(result.version).toBe(2);
  });

  it("JSON 损坏 → throw CredentialsSchemaError，message 含路径不含密值", () => {
    const filePath = getCredentialsPath(tmpDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{"version": 1, "providers": {bad json}', "utf-8");

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
    // sanity check：错误消息不应"巧合"包含明显凭证 prefix（这里没有真凭证可泄漏）
    expect(err.message).not.toMatch(/sk-[A-Za-z0-9]/);
  });

  it("空 JSON 对象 → 返回 {} 形态（version 缺失，不补默认到 parsed）", () => {
    const filePath = getCredentialsPath(tmpDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{}", "utf-8");

    const result = loadCredentials({ homeDir: tmpDir });
    // 用户文件原样返回——loader 不补 version；下游 applyCredentialsPatch / 测试
    // 视需要兜底
    expect(result).toEqual({});
  });
});

describe("applyCredentialsPatch · 合并语义", () => {
  it("空 current + 空 patch → version 兜底为 1", () => {
    expect(applyCredentialsPatch({} as ZhixingCredentials, {})).toEqual({
      version: 1,
    });
  });

  it("patch 显式 version 优先于 current", () => {
    const result = applyCredentialsPatch(
      { version: 1 },
      { version: 1 } as Partial<ZhixingCredentials>,
    );
    expect(result.version).toBe(1);
  });

  it("追加单 provider 不清除其它 provider", () => {
    const current: ZhixingCredentials = {
      version: 1,
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
    // 模拟未来 ProviderCredentials 多字段场景：cast 注入额外字段
    const current = {
      version: 1,
      providers: {
        custom: { apiKey: "old", refreshToken: "rt-1", expiresAt: 1000 },
      },
    } as unknown as ZhixingCredentials;
    const result = applyCredentialsPatch(current, {
      providers: { custom: { apiKey: "new" } },
    }) as unknown as {
      providers: {
        custom: { apiKey: string; refreshToken: string; expiresAt: number };
      };
    };

    expect(result.providers.custom.apiKey).toBe("new");
    expect(result.providers.custom.refreshToken).toBe("rt-1");
    expect(result.providers.custom.expiresAt).toBe(1000);
  });

  it("channels 同样 id 级 + 字段级合并", () => {
    const current: ZhixingCredentials = {
      version: 1,
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

  it("patch 未提到的子表保留 current", () => {
    const current: ZhixingCredentials = {
      version: 1,
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
        version: 1,
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

  it("文件不存在时 writeCredentials 创建文件", async () => {
    await writeCredentials(
      { providers: { siliconflow: { apiKey: "sk-sf" } } },
      { homeDir: tmpDir },
    );

    const filePath = getCredentialsPath(tmpDir);
    expect(fs.existsSync(filePath)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(persisted).toEqual({
      version: 1,
      providers: { siliconflow: { apiKey: "sk-sf" } },
    });
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
