/**
 * request-builder 单元测试
 *
 * 覆盖：
 *   - sanitizeCommandPreview: ANSI 剥离 + 控制字符剥离
 *   - buildDisplayBody: 按工具名分派到正确的 DisplayBody.kind
 *   - buildPanelTitle: 友好标题
 *   - buildConfirmationOptions: 含 pattern 的选项集
 *   - buildConfirmationRequest: 完整装配
 *
 * 测试原则：纯单元测试，不依赖 broker、TUI 或 SecurityPipeline 的复杂状态。
 */

import { describe, expect, it } from "vitest";
import type { SecurityMiddlewareResult } from "@zhixing/core";
import {
  buildConfirmationOptions,
  buildConfirmationRequest,
  buildDisplayBody,
  buildPanelTitle,
  sanitizeCommandPreview,
} from "../request-builder.js";

// ─── sanitizeCommandPreview ───

describe("sanitizeCommandPreview", () => {
  it("剥离 ANSI 色彩序列", () => {
    expect(sanitizeCommandPreview("\x1b[31mrm -rf /\x1b[0m")).toBe("rm -rf /");
  });

  it("剥离隐藏光标等私有 CSI 序列", () => {
    expect(sanitizeCommandPreview("a\x1b[?25lb")).toBe("ab");
  });

  it("剥离 BEL / BS / ESC 等控制字符", () => {
    expect(sanitizeCommandPreview("rm\x07\x08 -f")).toBe("rm -f");
  });

  it("保留 LF 和 TAB（用于多行命令/格式化）", () => {
    expect(sanitizeCommandPreview("line1\nline2\tfoo")).toBe(
      "line1\nline2\tfoo",
    );
  });

  it("无控制字符时原样返回", () => {
    expect(sanitizeCommandPreview("npm install express")).toBe(
      "npm install express",
    );
  });
});

// ─── buildDisplayBody ───

describe("buildDisplayBody", () => {
  it("bash 工具 → kind: bash，含 commandPreview", () => {
    const body = buildDisplayBody("bash", { command: "\x1b[31mls\x1b[0m" });
    expect(body.kind).toBe("bash");
    if (body.kind === "bash") {
      expect(body.command).toBe("\x1b[31mls\x1b[0m");
      expect(body.commandPreview).toBe("ls"); // sanitized
    }
  });

  it("shell 是 bash 的别名", () => {
    const body = buildDisplayBody("shell", { command: "echo hi" });
    expect(body.kind).toBe("bash");
  });

  it("write 工具 → kind: file-write，含 preview", () => {
    const body = buildDisplayBody("write", {
      path: "/tmp/x.ts",
      content: "export const x = 1;",
    });
    expect(body.kind).toBe("file-write");
    if (body.kind === "file-write") {
      expect(body.path).toBe("/tmp/x.ts");
      expect(body.preview).toBe("export const x = 1;");
    }
  });

  it("edit 工具 → kind: file-edit", () => {
    const body = buildDisplayBody("edit", { path: "/tmp/x.ts" });
    expect(body.kind).toBe("file-edit");
  });

  it("read 工具 → kind: file-read", () => {
    const body = buildDisplayBody("read", { file_path: "/tmp/x.ts" });
    expect(body.kind).toBe("file-read");
    if (body.kind === "file-read") {
      expect(body.path).toBe("/tmp/x.ts");
    }
  });

  it("未知工具 → kind: generic", () => {
    const body = buildDisplayBody("wechat_send", {
      to: "张三",
      content: "hello",
    });
    expect(body.kind).toBe("generic");
    if (body.kind === "generic") {
      expect(body.summary).toContain("wechat_send");
    }
  });

  it("generic summary 超长时截断", () => {
    const longInput = { data: "x".repeat(500) };
    const body = buildDisplayBody("unknown", longInput);
    if (body.kind === "generic") {
      expect(body.summary.length).toBeLessThanOrEqual(200);
    }
  });
});

// ─── buildPanelTitle ───

describe("buildPanelTitle", () => {
  it("bash → 'Bash 命令'", () => {
    expect(buildPanelTitle("bash")).toBe("Bash 命令");
  });

  it("write → '写入文件'", () => {
    expect(buildPanelTitle("write")).toBe("写入文件");
  });

  it("edit → '编辑文件'", () => {
    expect(buildPanelTitle("edit")).toBe("编辑文件");
  });

  it("read → '读取文件'", () => {
    expect(buildPanelTitle("read")).toBe("读取文件");
  });

  it("未知工具原样返回", () => {
    expect(buildPanelTitle("wechat_send")).toBe("wechat_send");
  });
});

// ─── buildConfirmationOptions ───

describe("buildConfirmationOptions", () => {
  // ─── 必选项 + 顺序 + 数量（3 项设计 v2026-04-16） ───

  it("包含 allow-once / allow-workspace / deny-with-reason 三个必选项", () => {
    const opts = buildConfirmationOptions(
      "bash",
      { command: "npm install express" },
      "ws-1",
      "interactive",
    );
    const kinds = opts.map((o) => o.kind);
    expect(kinds).toContain("allow-once");
    expect(kinds).toContain("allow-workspace");
    expect(kinds).toContain("deny-with-reason");
  });

  it("有 workspaceId 时正好生成 3 项，顺序固定 once → workspace → deny", () => {
    const opts = buildConfirmationOptions(
      "bash",
      { command: "npm install express" },
      "ws-1",
      "interactive",
    );
    expect(opts.length).toBe(3);
    expect(opts[0]!.kind).toBe("allow-once");
    expect(opts[1]!.kind).toBe("allow-workspace");
    expect(opts[2]!.kind).toBe("deny-with-reason");
  });

  it("无 workspaceId 时只生成 2 项（allow-once + deny-with-reason），无 workspace 选项", () => {
    const opts = buildConfirmationOptions(
      "bash",
      { command: "npm install" },
      null,
      "interactive",
    );
    expect(opts.length).toBe(2);
    expect(opts[0]!.kind).toBe("allow-once");
    expect(opts[1]!.kind).toBe("deny-with-reason");
    expect(opts.some((o) => o.kind === "allow-workspace")).toBe(false);
  });

  it("不生成 allow-with-note / allow-global / allow-session（broker 仍支持，但 CLI 不暴露）", () => {
    const opts = buildConfirmationOptions(
      "bash",
      { command: "npm install express" },
      "ws-1",
      "interactive",
    );
    const kinds = opts.map((o) => o.kind);
    expect(kinds).not.toContain("allow-with-note");
    expect(kinds).not.toContain("allow-global");
    expect(kinds).not.toContain("allow-session");
  });

  // ─── pickWorkspacePattern：避免 exact-command bug ───

  it("子命令型命令使用 subcommand wildcard：npm install foo → 'npm install *'", () => {
    const opts = buildConfirmationOptions(
      "bash",
      { command: "npm install express" },
      "ws-1",
      "interactive",
    );
    const ws = opts.find((o) => o.kind === "allow-workspace");
    expect(ws).toBeDefined();
    if (ws && ws.kind === "allow-workspace") {
      expect(ws.pattern.pattern.argument).toBe("npm install *");
    }
  });

  it("子命令型命令同样：git push origin main → 'git push *'", () => {
    const opts = buildConfirmationOptions(
      "bash",
      { command: "git push origin main" },
      "ws-1",
      "interactive",
    );
    const ws = opts.find((o) => o.kind === "allow-workspace");
    if (ws && ws.kind === "allow-workspace") {
      expect(ws.pattern.pattern.argument).toBe("git push *");
    }
  });

  it("复合命令落到 executable wildcard：echo \"...\" && pwd && ls → 'echo *'（回归护栏，2026-04-15 用户 bug）", () => {
    // 这条测试的 bug 现场：原代码 `mid = patterns.length >= 3 ? patterns[1] : patterns[0]`
    // 在 patterns.length===2 时回退到最精确的整条命令，导致面板显示
    // `始终允许 "echo "Hello from bash" && pwd && ls"（本工作区）` —— 几乎不可能
    // 再次命中。修复后应得到 `echo *`。
    const opts = buildConfirmationOptions(
      "bash",
      { command: 'echo "Hello from bash" && pwd && ls' },
      "ws-1",
      "interactive",
    );
    const ws = opts.find((o) => o.kind === "allow-workspace");
    expect(ws).toBeDefined();
    if (ws && ws.kind === "allow-workspace") {
      // 关键断言：pattern 不应包含原始命令的引号或 &&
      expect(ws.pattern.pattern.argument).toBe("echo *");
      expect(ws.pattern.pattern.argument).not.toContain("&&");
      expect(ws.pattern.pattern.argument).not.toContain('"Hello');
    }
  });

  it("单字命令也能产生 executable wildcard：ls → 'ls *'", () => {
    const opts = buildConfirmationOptions(
      "bash",
      { command: "ls" },
      "ws-1",
      "interactive",
    );
    const ws = opts.find((o) => o.kind === "allow-workspace");
    if (ws && ws.kind === "allow-workspace") {
      expect(ws.pattern.pattern.argument).toBe("ls *");
    }
  });

  // ─── placeholder ───

  it("deny-with-reason 的 placeholder 里出现当前 agent displayName（默认 '知行'）", () => {
    const opts = buildConfirmationOptions(
      "bash",
      { command: "ls" },
      "ws-1",
      "interactive",
    );
    const denyReason = opts.find((o) => o.kind === "deny-with-reason");
    expect(
      denyReason && "placeholder" in denyReason && denyReason.placeholder,
    ).toContain("知行");
  });
});

// ─── buildConfirmationRequest ───

describe("buildConfirmationRequest", () => {
  function minimalResult(): SecurityMiddlewareResult {
    return {
      allowed: true,
      requiresConfirmation: true,
      operationClass: "external",
      decision: {
        action: "confirm",
        matchedRules: [],
        reason: "需要确认",
        riskLevel: "medium",
      },
    };
  }

  it("生成完整的 ConfirmationRequest 结构", () => {
    const req = buildConfirmationRequest({
      toolName: "bash",
      input: { command: "npm install express" },
      workingDirectory: "/tmp/ws",
      result: minimalResult(),
      workspaceId: "ws-1",
      sessionType: "interactive",
      now: 1_700_000_000_000,
    });

    expect(req.id).toBeDefined();
    expect(req.tool).toBe("bash");
    expect(req.toolInput).toEqual({ command: "npm install express" });
    expect(req.workingDirectory).toBe("/tmp/ws");
    expect(req.sessionType).toBe("interactive");
    expect(req.workspaceId).toBe("ws-1");
    expect(req.createdAt).toBe(1_700_000_000_000);
    expect(req.expiresAt).toBe(1_700_000_000_000 + 30 * 60 * 1000);
    expect(req.display.body.kind).toBe("bash");
    expect(req.display.title).toBe("Bash 命令");
    expect(req.display.cwd).toBe("/tmp/ws");
    expect(req.options.length).toBeGreaterThan(0);
  });

  it("可覆盖 id 和 timeoutMs（测试模式）", () => {
    const req = buildConfirmationRequest({
      toolName: "bash",
      input: { command: "ls" },
      workingDirectory: "/tmp",
      result: minimalResult(),
      workspaceId: null,
      sessionType: "ci",
      id: "fixed-id",
      now: 0,
      timeoutMs: 1000,
    });
    expect(req.id).toBe("fixed-id");
    expect(req.expiresAt).toBe(1000);
  });

  it("传入 operationClass / decision 时透传到 request", () => {
    const result: SecurityMiddlewareResult = {
      allowed: true,
      requiresConfirmation: true,
      operationClass: "critical",
      decision: {
        action: "confirm",
        matchedRules: [],
        reason: "critical op",
        riskLevel: "high",
      },
    };
    const req = buildConfirmationRequest({
      toolName: "bash",
      input: { command: "rm -rf /" },
      workingDirectory: "/tmp",
      result,
      workspaceId: "ws-1",
      sessionType: "interactive",
    });
    expect(req.operationClass).toBe("critical");
    expect(req.decision?.riskLevel).toBe("high");
  });

  it("commandPreview 独立于 commandFull（bash 工具）", () => {
    const req = buildConfirmationRequest({
      toolName: "bash",
      input: { command: "\x1b[31mrm -rf /\x1b[0m" },
      workingDirectory: "/tmp",
      result: minimalResult(),
      workspaceId: "ws-1",
      sessionType: "interactive",
    });
    expect(req.display.commandPreview).toBe("rm -rf /");
    expect(req.display.commandFull).toBe("\x1b[31mrm -rf /\x1b[0m");
  });
});
