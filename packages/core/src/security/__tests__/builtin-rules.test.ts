/**
 * 知行 .zhixing/ 目录的 builtin 规则匹配契约测试
 *
 * 覆盖三条规则与它们的协作语义：
 *   - bi-zhixing-credentials-block：SecretStore 文件族与旧 credentials.json 的任何
 *     access 一律 block；规则携带 message + suggestion，引导用户走专用配置流程
 *   - bi-os-credential-store：平台凭据命令一律 block，避免绕过 SecretStore 文件边界
 *   - bi-zhixing-config-write：~/.zhixing/ 写操作走 confirm；用户当面认可 AI 改公开配置
 *
 * 关键不变量：
 *   - 同 path 同时命中两规则时，block > confirm（秘密存储永远不会降级到 confirm）
 *   - bi-zhixing-config-write 仅 access: write，读 config.json 不命中
 *   - 路径形态（相对路径段 / ~/ 展开 / 绝对路径）三种都被规则吃住
 *   - 元数据契约（bypassImmune / severity / category / source / message / suggestion）
 *     —— 这些字段是 AI 行为指引的载体，被本测试 lock 住，spec 改动需同步改测试
 */

import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PolicyEngine } from "../policy-engine.js";
import type { SecurityRequest, SecurityRule } from "../types.js";

// ─── 测试 helpers ───

const TEST_CWD = "/home/user/project";

function makeRequest(overrides: Partial<SecurityRequest> = {}): SecurityRequest {
  return {
    tool: "read",
    arguments: {},
    context: {
      cwd: TEST_CWD,
      trust: { kind: "workspace", dir: TEST_CWD },
      sessionType: "interactive",
    },
    ...overrides,
  };
}

function readRequest(filePath: string): SecurityRequest {
  return makeRequest({ tool: "read", arguments: { path: filePath } });
}

function writeRequest(filePath: string): SecurityRequest {
  return makeRequest({ tool: "write", arguments: { path: filePath } });
}

function editRequest(filePath: string): SecurityRequest {
  // edit 工具用 file_path 字段，extractPaths 会兼容提取
  return makeRequest({ tool: "edit", arguments: { file_path: filePath } });
}

function getRule(engine: PolicyEngine, id: string): SecurityRule {
  const rule = engine.getActiveRules().find((r) => r.id === id);
  if (!rule) throw new Error(`Rule ${id} not loaded`);
  return rule;
}

// 跨平台凭证文件绝对路径（基于当前 OS 用户主目录）
const ABSOLUTE_CREDS_PATH = path.join(os.homedir(), ".zhixing/credentials.json");
const ABSOLUTE_CONFIG_PATH = path.join(os.homedir(), ".zhixing/config.json");

// ─── bi-zhixing-credentials-block ───

describe("bi-zhixing-credentials-block · 凭证文件完全隔离", () => {
  describe("命中 → block", () => {
    it("read 相对路径 .zhixing/credentials.json → block", () => {
      const engine = new PolicyEngine();
      const decision = engine.evaluate(readRequest(".zhixing/credentials.json"));
      expect(decision.action).toBe("block");
      expect(
        decision.matchedRules.some((r) => r.id === "bi-zhixing-credentials-block"),
      ).toBe(true);
    });

    it("write 相对路径 .zhixing/credentials.json → block", () => {
      const engine = new PolicyEngine();
      const decision = engine.evaluate(writeRequest(".zhixing/credentials.json"));
      expect(decision.action).toBe("block");
      expect(
        decision.matchedRules.some((r) => r.id === "bi-zhixing-credentials-block"),
      ).toBe(true);
    });

    it("edit 工具 file_path 字段 .zhixing/credentials.json → block", () => {
      const engine = new PolicyEngine();
      const decision = engine.evaluate(editRequest(".zhixing/credentials.json"));
      expect(decision.action).toBe("block");
      expect(
        decision.matchedRules.some((r) => r.id === "bi-zhixing-credentials-block"),
      ).toBe(true);
    });

    it("read ~/.zhixing/credentials.json（~ 展开）→ block", () => {
      const engine = new PolicyEngine();
      const decision = engine.evaluate(readRequest("~/.zhixing/credentials.json"));
      expect(decision.action).toBe("block");
    });

    it("read 绝对路径 ~/.zhixing/credentials.json（已展开）→ block", () => {
      const engine = new PolicyEngine();
      const decision = engine.evaluate(readRequest(ABSOLUTE_CREDS_PATH));
      expect(decision.action).toBe("block");
    });

    it("write 绝对路径 → block", () => {
      const engine = new PolicyEngine();
      const decision = engine.evaluate(writeRequest(ABSOLUTE_CREDS_PATH));
      expect(decision.action).toBe("block");
    });

    it.each([
      ".zhixing/secret-vault.json",
      ".zhixing/secret-vault.key",
      ".zhixing/secret-vault.json.lock",
      ".zhixing/secret-vault.json.exclusive.lock",
      ".zhixing/secret-vault.json.1234.deadbeef.tmp",
    ])("read/write SecretStore 文件族 %s → block", (filePath) => {
      const engine = new PolicyEngine();
      expect(engine.evaluate(readRequest(filePath)).action).toBe("block");
      expect(engine.evaluate(writeRequest(filePath)).action).toBe("block");
    });

    it.runIf(process.platform === "win32")(
      "Windows 大小写别名不能绕过 SecretStore 保护",
      () => {
        const engine = new PolicyEngine();
        expect(engine.evaluate(readRequest(".ZHIXING/SECRET-VAULT.JSON")).action).toBe("block");
      },
    );

    it("riskLevel = critical（携带 bypassImmune + severity）", () => {
      const engine = new PolicyEngine();
      const decision = engine.evaluate(readRequest(".zhixing/credentials.json"));
      expect(decision.riskLevel).toBe("critical");
    });

    it("decision.reason 含规则 message —— AI 看到工具失败原因", () => {
      const engine = new PolicyEngine();
      const decision = engine.evaluate(readRequest(".zhixing/credentials.json"));
      expect(decision.reason).toContain("凭据");
    });

    it("decision.suggestion 引导用户走 SecretStore 专用流程", () => {
      const engine = new PolicyEngine();
      const decision = engine.evaluate(readRequest(".zhixing/credentials.json"));
      expect(decision.suggestion).toBeDefined();
      expect(decision.suggestion).toContain("SecretStore");
      expect(decision.suggestion).toContain("`zz`");
    });
  });

  describe("不命中（边界）", () => {
    it("read .zhixing/config.json → 不被 credentials-block 命中", () => {
      const engine = new PolicyEngine();
      const decision = engine.evaluate(readRequest(".zhixing/config.json"));
      expect(
        decision.matchedRules.some((r) => r.id === "bi-zhixing-credentials-block"),
      ).toBe(false);
    });

    it("read .zhixing/server.token → 不被 credentials-block 命中", () => {
      const engine = new PolicyEngine();
      const decision = engine.evaluate(readRequest(".zhixing/server.token"));
      expect(
        decision.matchedRules.some((r) => r.id === "bi-zhixing-credentials-block"),
      ).toBe(false);
    });

    it("read 任意工作区文件 → 不命中", () => {
      const engine = new PolicyEngine();
      const decision = engine.evaluate(readRequest("src/index.ts"));
      expect(decision.action).toBe("allow");
    });
  });

  describe("规则元数据契约", () => {
    it("bypassImmune = true（防止用户规则降级到 confirm/audit）", () => {
      const rule = getRule(new PolicyEngine(), "bi-zhixing-credentials-block");
      expect(rule.bypassImmune).toBe(true);
    });

    it("severity = critical", () => {
      const rule = getRule(new PolicyEngine(), "bi-zhixing-credentials-block");
      expect(rule.severity).toBe("critical");
    });

    it("category = data_exfiltration", () => {
      const rule = getRule(new PolicyEngine(), "bi-zhixing-credentials-block");
      expect(rule.category).toBe("data_exfiltration");
    });

    it("source = builtin", () => {
      const rule = getRule(new PolicyEngine(), "bi-zhixing-credentials-block");
      expect(rule.source).toBe("builtin");
    });

    it("action = block", () => {
      const rule = getRule(new PolicyEngine(), "bi-zhixing-credentials-block");
      expect(rule.action).toBe("block");
    });

    it("match access = any（读写都拦）", () => {
      const rule = getRule(new PolicyEngine(), "bi-zhixing-credentials-block");
      expect(rule.match.type).toBe("path");
      if (rule.match.type === "path") {
        expect(rule.match.access).toBe("any");
        expect(rule.match.paths).toContain(".zhixing/credentials.json");
        expect(rule.match.paths).toContain(".zhixing/secret-vault");
      }
    });
  });
});

describe("bi-os-credential-store · 系统凭据命令完全隔离", () => {
  it.each([
    "secret-tool lookup service dev.zhixing.secret-vault",
    "/usr/bin/secret-tool store service x",
    "security find-generic-password -s dev.zhixing.secret-vault -w",
    "security -q find-generic-password -s dev.zhixing.secret-vault -w",
    '"/usr/bin/security" dump-keychain',
    "cmdkey.exe /list",
    "vaultcmd /listcreds:\\Windows Credentials",
    "keyctl show",
  ])("blocks %s", (command) => {
    const engine = new PolicyEngine();
    const decision = engine.evaluate(makeRequest({ tool: "bash", arguments: { command } }));
    expect(decision.action).toBe("block");
    expect(decision.matchedRules.some((rule) => rule.id === "bi-os-credential-store")).toBe(true);
  });

  it("does not block unrelated macOS security tooling", () => {
    const engine = new PolicyEngine();
    const decision = engine.evaluate(
      makeRequest({ tool: "bash", arguments: { command: "security verify-cert -c app.pem" } }),
    );
    expect(decision.matchedRules.some((rule) => rule.id === "bi-os-credential-store")).toBe(false);
  });
});

// ─── bi-zhixing-config-write ───

describe("bi-zhixing-config-write · 配置文件写需用户确认", () => {
  describe("命中 → confirm（仅写）", () => {
    it("write .zhixing/config.json → confirm", () => {
      const engine = new PolicyEngine();
      const decision = engine.evaluate(writeRequest(".zhixing/config.json"));
      expect(decision.action).toBe("confirm");
      expect(
        decision.matchedRules.some((r) => r.id === "bi-zhixing-config-write"),
      ).toBe(true);
    });

    it("edit .zhixing/config.json → confirm", () => {
      const engine = new PolicyEngine();
      const decision = engine.evaluate(editRequest(".zhixing/config.json"));
      expect(decision.action).toBe("confirm");
    });

    it("write 绝对路径 ~/.zhixing/config.json → confirm", () => {
      const engine = new PolicyEngine();
      const decision = engine.evaluate(writeRequest(ABSOLUTE_CONFIG_PATH));
      expect(decision.action).toBe("confirm");
    });

    it("write .zhixing/ 任意非 credentials 文件 → confirm", () => {
      const engine = new PolicyEngine();
      const decision = engine.evaluate(writeRequest(".zhixing/permissions.json"));
      expect(decision.action).toBe("confirm");
    });
  });

  describe("不命中（access: write）", () => {
    it("read .zhixing/config.json → 不命中（仅 access:write）", () => {
      const engine = new PolicyEngine();
      const decision = engine.evaluate(readRequest(".zhixing/config.json"));
      expect(
        decision.matchedRules.some((r) => r.id === "bi-zhixing-config-write"),
      ).toBe(false);
    });

    it("read .zhixing/config.json → 默认 allow（无规则命中）", () => {
      const engine = new PolicyEngine();
      const decision = engine.evaluate(readRequest(".zhixing/config.json"));
      expect(decision.action).toBe("allow");
    });
  });

  describe("规则元数据契约", () => {
    it("bypassImmune = true（用户不能把 confirm 降级为 audit/allow）", () => {
      const rule = getRule(new PolicyEngine(), "bi-zhixing-config-write");
      expect(rule.bypassImmune).toBe(true);
    });

    it("action = confirm（与 credentials-block 的 block 不同）", () => {
      const rule = getRule(new PolicyEngine(), "bi-zhixing-config-write");
      expect(rule.action).toBe("confirm");
    });

    it("match access = write（与 credentials-block 的 any 不同）", () => {
      const rule = getRule(new PolicyEngine(), "bi-zhixing-config-write");
      expect(rule.match.type).toBe("path");
      if (rule.match.type === "path") {
        expect(rule.match.access).toBe("write");
      }
    });
  });
});

// ─── 优先级协作 ───

describe("规则严格度排序：block 优先于 confirm", () => {
  it("write .zhixing/credentials.json 同时命中 credentials-block + config-write → action = block", () => {
    const engine = new PolicyEngine();
    const decision = engine.evaluate(writeRequest(".zhixing/credentials.json"));

    // 两条规则的 path 都覆盖 .zhixing/credentials.json，access 也都吃住 write
    const matchedIds = decision.matchedRules.map((r) => r.id);
    expect(matchedIds).toContain("bi-zhixing-credentials-block");
    expect(matchedIds).toContain("bi-zhixing-config-write");

    // ACTION_SEVERITY: block > confirm，credentials-block 排首位
    expect(decision.action).toBe("block");
    expect(decision.matchedRules[0]?.id).toBe("bi-zhixing-credentials-block");
  });

  it("两规则同时命中时 reason / suggestion 来自最严格的 credentials-block", () => {
    const engine = new PolicyEngine();
    const decision = engine.evaluate(writeRequest(".zhixing/credentials.json"));
    // 排序后首位规则的 message + suggestion 进 decision
    expect(decision.reason).toContain("凭据");
    expect(decision.suggestion).toContain("SecretStore");
  });
});
