/**
 * 启动期 wizard 适配 facade 测试。
 *
 * 关键不变量：
 *   - 5 个分支状态全覆盖（ready / completed / cancelled / non-tty / schema-error）
 *   - completed 路径下返回的是 wizard 写盘**之后**重新 load 的内容
 *   - 损坏文件不抛错而是返回 schema-error 状态
 *   - cwd / homeDir / env / isTTY / interaction 全部可注入——facade 完全单元可测
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MissingField } from "@zhixing/providers";
import { ensureBootstrap } from "../entry.js";
import type {
  BootstrapAskRequest,
  BootstrapAskAnswer,
  BootstrapInteraction,
} from "../types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zhixing-bootstrap-entry-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ─── Mock interaction（实现 BootstrapInteraction 接口供 entry 注入） ───

function makeMockInteraction(
  answers: ReadonlyArray<string | "cancel">,
): BootstrapInteraction {
  let idx = 0;
  return {
    async printIntro() {
      /* noop */
    },
    async askField(_req: BootstrapAskRequest): Promise<BootstrapAskAnswer> {
      const next = answers[idx++];
      if (next === undefined || next === "cancel") {
        return { kind: "cancel" };
      }
      return { kind: "value", value: next };
    },
    async printSummary() {
      /* noop */
    },
    async close() {
      /* noop */
    },
  };
}

function writeConfigFile(content: object): void {
  fs.writeFileSync(
    path.join(tmpDir, "config.json"),
    JSON.stringify(content),
    "utf-8",
  );
}

function writeCredentialsFile(content: object): void {
  fs.writeFileSync(
    path.join(tmpDir, "credentials.json"),
    JSON.stringify(content),
    "utf-8",
  );
}

// ─── Tests ───

describe("ensureBootstrap · ready 分支", () => {
  it("config + credentials 齐全 → ready，返回当前 config 与 credentials", async () => {
    writeConfigFile({
      llm: { main: { provider: "deepseek", model: "deepseek-chat" } },
    });
    writeCredentialsFile({
      version: 1,
      providers: { deepseek: { apiKey: "sk-existing" } },
    });

    const result = await ensureBootstrap({ homeDir: tmpDir, isTTY: true });

    expect(result.kind).toBe("ready");
    if (result.kind === "ready") {
      expect(result.config.llm?.main?.provider).toBe("deepseek");
      expect(result.credentials.providers?.deepseek?.apiKey).toBe("sk-existing");
    }
  });

  it("ready 分支不调用 interaction（即使提供）", async () => {
    writeConfigFile({
      llm: { main: { provider: "deepseek", model: "deepseek-chat" } },
    });
    writeCredentialsFile({
      version: 1,
      providers: { deepseek: { apiKey: "sk-existing" } },
    });

    let printedIntro = false;
    const interaction: BootstrapInteraction = {
      async printIntro() {
        printedIntro = true;
      },
      async askField() {
        return { kind: "cancel" };
      },
      async printSummary() {
        /* noop */
      },
      async close() {
        /* noop */
      },
    };

    await ensureBootstrap({ homeDir: tmpDir, isTTY: true, interaction });

    expect(printedIntro).toBe(false);
  });
});

describe("ensureBootstrap · completed 分支", () => {
  it("空 config 文件 + TTY 填三字段 → completed，重新 load 拿到磁盘最新内容", async () => {
    // 预写空 config 让 loadConfig 不触发模板自动创建——模拟"配置完全空"场景，
    // wizard 会依次问 provider / model / apiKey 三字段
    writeConfigFile({});
    writeCredentialsFile({ version: 1 });

    const interaction = makeMockInteraction([
      "siliconflow",
      "Pro/MiniMaxAI/MiniMax-M2.5",
      "sk-new",
    ]);

    const result = await ensureBootstrap({
      homeDir: tmpDir,
      isTTY: true,
      interaction,
    });

    expect(result.kind).toBe("completed");
    if (result.kind === "completed") {
      // 验证返回的是 wizard 写盘后的最新内容，不是 initial 状态
      expect(result.config.llm?.main?.provider).toBe("siliconflow");
      expect(result.config.llm?.main?.model).toBe("Pro/MiniMaxAI/MiniMax-M2.5");
      expect(result.credentials.providers?.siliconflow?.apiKey).toBe("sk-new");
    }

    // 磁盘上也确实写了
    const persistedConfig = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "config.json"), "utf-8"),
    );
    expect(persistedConfig.llm?.main?.provider).toBe("siliconflow");

    const persistedCreds = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "credentials.json"), "utf-8"),
    );
    expect(persistedCreds.providers?.siliconflow?.apiKey).toBe("sk-new");
  });

  it("仅缺 apiKey + TTY 填一字段 → completed，仅 credentials 更新", async () => {
    writeConfigFile({
      llm: { main: { provider: "deepseek", model: "deepseek-chat" } },
    });
    // credentials 不写，loadCredentials 自动创建空骨架

    const interaction = makeMockInteraction(["sk-ds"]);

    const result = await ensureBootstrap({
      homeDir: tmpDir,
      isTTY: true,
      interaction,
    });

    expect(result.kind).toBe("completed");
    if (result.kind === "completed") {
      expect(result.credentials.providers?.deepseek?.apiKey).toBe("sk-ds");
    }
  });

  it("loadConfig 模板自动创建场景 → 仅 apiKey 缺失，wizard 只问一字段", async () => {
    // 不预写 config 文件——loadConfig 触发模板创建（main provider/model 默认填好）
    // 这是新用户首次启动的真实场景：wizard 只需用户提供 apiKey
    const interaction = makeMockInteraction(["sk-template-default"]);

    const result = await ensureBootstrap({
      homeDir: tmpDir,
      isTTY: true,
      interaction,
    });

    expect(result.kind).toBe("completed");
    if (result.kind === "completed") {
      // 模板默认 provider 是 siliconflow
      expect(result.config.llm?.main?.provider).toBe("siliconflow");
      expect(result.credentials.providers?.siliconflow?.apiKey).toBe(
        "sk-template-default",
      );
    }
  });
});

describe("ensureBootstrap · cancelled 分支", () => {
  it("缺字段 + TTY + 用户中途取消 → cancelled，磁盘不写", async () => {
    // 预写空 config 让 loadConfig 不触发模板创建，wizard 才会问多个字段
    writeConfigFile({});
    writeCredentialsFile({ version: 1 });

    const interaction = makeMockInteraction(["siliconflow", "cancel"]);

    const result = await ensureBootstrap({
      homeDir: tmpDir,
      isTTY: true,
      interaction,
    });

    expect(result.kind).toBe("cancelled");

    // 磁盘 config.json 应保持空（用户未提交，wizard batch 写未触发）
    const persistedConfig = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "config.json"), "utf-8"),
    );
    expect(persistedConfig.llm).toBeUndefined();

    // credentials 没被 wizard 触及
    const persistedCreds = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "credentials.json"), "utf-8"),
    );
    expect(persistedCreds.providers).toBeUndefined();
  });
});

describe("ensureBootstrap · non-tty 分支", () => {
  it("缺字段 + 非 TTY → non-tty，含 missing 列表", async () => {
    const result = await ensureBootstrap({
      homeDir: tmpDir,
      isTTY: false,
    });

    expect(result.kind).toBe("non-tty");
    if (result.kind === "non-tty") {
      expect(result.missing.length).toBeGreaterThan(0);
      // 缺 main provider apiKey 是默认空配置的典型 missing
      const paths = result.missing.map((m: MissingField) => m.path);
      expect(paths).toContain("credentials.providers.siliconflow.apiKey");
    }
  });

  it("非 TTY 不调用 interaction", async () => {
    let askCalled = false;
    const interaction: BootstrapInteraction = {
      async printIntro() {
        /* noop */
      },
      async askField() {
        askCalled = true;
        return { kind: "cancel" };
      },
      async printSummary() {
        /* noop */
      },
      async close() {
        /* noop */
      },
    };

    await ensureBootstrap({ homeDir: tmpDir, isTTY: false, interaction });

    expect(askCalled).toBe(false);
  });
});

describe("ensureBootstrap · config-semantic-error 分支", () => {
  it("config.providers.<id>.apiKey 字段存在 → config-semantic-error", async () => {
    // 老用户 config.json 残留 apiKey 字段（开发阶段或旧模板）→ 必须 fail-fast 引导手工修复
    writeConfigFile({
      llm: { main: { provider: "siliconflow", model: "Pro/MiniMaxAI/MiniMax-M2.5" } },
      providers: { siliconflow: { apiKey: "env:SILICONFLOW_API_KEY" } },
    });
    writeCredentialsFile({ version: 1 });

    const result = await ensureBootstrap({ homeDir: tmpDir, isTTY: true });

    expect(result.kind).toBe("config-semantic-error");
    if (result.kind === "config-semantic-error") {
      expect(result.filePath).toBe(path.join(tmpDir, "config.json"));
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]?.field).toBe("providers.siliconflow.apiKey");
    }
  });

  it("config.channels.<id>.credentials 含密字段 → config-semantic-error", async () => {
    writeConfigFile({
      llm: { main: { provider: "siliconflow", model: "Pro/MiniMaxAI/MiniMax-M2.5" } },
      channels: {
        feishu: {
          credentials: { appId: "cli_xxx", appSecret: "fs_secret" },
        },
      },
    });
    writeCredentialsFile({
      version: 1,
      providers: { siliconflow: { apiKey: "sk-sf" } },
    });

    const result = await ensureBootstrap({ homeDir: tmpDir, isTTY: true });

    expect(result.kind).toBe("config-semantic-error");
    if (result.kind === "config-semantic-error") {
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]?.field).toBe(
        "channels.feishu.credentials.appSecret",
      );
    }
  });

  it("多类违反一次报全（apiKey + channel secret 累计）", async () => {
    writeConfigFile({
      llm: { main: { provider: "siliconflow", model: "Pro/MiniMaxAI/MiniMax-M2.5" } },
      providers: { siliconflow: { apiKey: "sk-sf" } },
      channels: {
        feishu: {
          credentials: { appId: "cli_xxx", appSecret: "fs_secret" },
        },
      },
    });
    writeCredentialsFile({ version: 1 });

    const result = await ensureBootstrap({ homeDir: tmpDir, isTTY: true });

    expect(result.kind).toBe("config-semantic-error");
    if (result.kind === "config-semantic-error") {
      expect(result.issues).toHaveLength(2);
    }
  });

  it("非 TTY 也走 config-semantic-error（schema 违反不分会话类型）", async () => {
    writeConfigFile({
      llm: { main: { provider: "siliconflow", model: "Pro/MiniMaxAI/MiniMax-M2.5" } },
      providers: { siliconflow: { apiKey: "sk-leaked" } },
    });
    writeCredentialsFile({ version: 1 });

    const result = await ensureBootstrap({ homeDir: tmpDir, isTTY: false });

    expect(result.kind).toBe("config-semantic-error");
  });

  it("issues fix 字段不泄漏 sk-* 密值（错误消息脱敏 fuzz）", async () => {
    writeConfigFile({
      llm: { main: { provider: "siliconflow", model: "Pro/MiniMaxAI/MiniMax-M2.5" } },
      providers: {
        siliconflow: { apiKey: "sk-fuzzleak0123456789ABCDEF" },
      },
    });
    writeCredentialsFile({ version: 1 });

    const result = await ensureBootstrap({ homeDir: tmpDir, isTTY: false });

    expect(result.kind).toBe("config-semantic-error");
    if (result.kind === "config-semantic-error") {
      // issue 三段式（field/reason/fix）都不应回显具体凭证值
      for (const issue of result.issues) {
        expect(issue.field).not.toContain("sk-fuzzleak");
        expect(issue.reason).not.toContain("sk-fuzzleak");
        expect(issue.fix).not.toContain("sk-fuzzleak");
      }
    }
  });
});

describe("ensureBootstrap · schema-error 分支", () => {
  it("config.json JSON 损坏 → schema-error 状态", async () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), "{ not json", "utf-8");

    const result = await ensureBootstrap({ homeDir: tmpDir, isTTY: true });

    expect(result.kind).toBe("schema-error");
    if (result.kind === "schema-error") {
      expect(result.filePath).toBe(path.join(tmpDir, "config.json"));
      expect(result.message).toContain("config.json");
    }
  });

  it("credentials.json JSON 损坏 → schema-error 状态", async () => {
    writeConfigFile({
      llm: { main: { provider: "deepseek", model: "deepseek-chat" } },
    });
    fs.writeFileSync(
      path.join(tmpDir, "credentials.json"),
      "{ \"version\": 1, broken",
      "utf-8",
    );

    const result = await ensureBootstrap({ homeDir: tmpDir, isTTY: true });

    expect(result.kind).toBe("schema-error");
    if (result.kind === "schema-error") {
      expect(result.filePath).toBe(path.join(tmpDir, "credentials.json"));
    }
  });

  it("schema-error 时 message 不含密值（即使文件含 sk- 前缀）", async () => {
    // 损坏文件含 sk- 前缀模拟潜在凭证泄漏路径
    fs.writeFileSync(
      path.join(tmpDir, "credentials.json"),
      '{ "providers": { "x": { "apiKey": "sk-leaked-key", broken',
      "utf-8",
    );

    const result = await ensureBootstrap({ homeDir: tmpDir, isTTY: true });

    expect(result.kind).toBe("schema-error");
    if (result.kind === "schema-error") {
      // 错误消息含路径但不应巧合泄漏 sk- 凭证片段
      expect(result.message).not.toContain("sk-leaked");
    }
  });
});
