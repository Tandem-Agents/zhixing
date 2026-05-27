/**
 * OperationClassifier 单元测试
 *
 * 覆盖四类分类器的独立行为 + 组合与工厂的分发逻辑。
 * 所有测试都是纯函数——不触碰真实文件系统之外的 I/O，
 * 文件系统只用 os.tmpdir() 下的测试目录。
 */

import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createDescribeTempDir } from "@zhixing/test-utils";
import {
  BoundaryImpactClassifier,
  CompositeClassifier,
  EMPTY_BOUNDARY_REGISTRY,
  FileSystemClassifier,
  ShellClassifier,
  createDefaultClassifier,
} from "../classifier.js";
import type {
  BoundaryCrossing,
  SecurityRequest,
  ToolBoundaryRegistry,
} from "../types.js";

// ─── 测试辅助 ───

function makeRequest(
  overrides: Partial<SecurityRequest> & { tool: string },
): SecurityRequest {
  return {
    tool: overrides.tool,
    arguments: overrides.arguments ?? {},
    context: {
      cwd: overrides.context?.cwd ?? process.cwd(),
      trust: overrides.context?.trust ?? { kind: "global" },
      sessionType: overrides.context?.sessionType ?? "interactive",
    },
    resolvedAccess: overrides.resolvedAccess,
  };
}

function bashRequest(
  command: string,
  overrides?: Partial<SecurityRequest>,
): SecurityRequest {
  return makeRequest({
    tool: "bash",
    arguments: { command },
    ...overrides,
  });
}

// ─── FileSystemClassifier ───

describe("FileSystemClassifier", () => {
  const classifier = new FileSystemClassifier();

  const workspaceDir = createDescribeTempDir("classifier-ws");

  it("read 工具始终分类为 observe", () => {
    const req = makeRequest({
      tool: "read",
      arguments: { path: "/anywhere/secret.txt" },
    });
    expect(classifier.classify(req)).toBe("observe");
  });

  it("glob 和 grep 归类为 observe", () => {
    expect(
      classifier.classify(makeRequest({ tool: "glob", arguments: { pattern: "**/*.ts" } })),
    ).toBe("observe");
    expect(
      classifier.classify(makeRequest({ tool: "grep", arguments: { pattern: "TODO" } })),
    ).toBe("observe");
  });

  it("写入操作一律 external（影响与位置无关）", () => {
    const workspace = workspaceDir.getDir();
    const req = makeRequest({
      tool: "write",
      arguments: { path: path.join(workspace, "src", "foo.ts") },
      context: { cwd: workspace, trust: { kind: "workspace", dir: workspace }, sessionType: "interactive" },
    });
    expect(classifier.classify(req)).toBe("external");
  });

  it("无路径参数的写入 → external", () => {
    const req = makeRequest({ tool: "write", arguments: {} });
    expect(classifier.classify(req)).toBe("external");
  });

  it("未知文件系统工具分类为 external", () => {
    const req = makeRequest({ tool: "unknown_fs_tool" });
    expect(classifier.classify(req)).toBe("external");
  });
});

// ─── ShellClassifier ───

describe("ShellClassifier", () => {
  const classifier = new ShellClassifier();

  it("安全只读命令归类为 observe", () => {
    for (const cmd of ["ls", "pwd", "whoami", "cat /etc/hostname", "stat /tmp"]) {
      expect(classifier.classify(bashRequest(cmd))).toBe("observe");
    }
  });

  it("归一化绝对路径可执行文件", () => {
    expect(classifier.classify(bashRequest("/usr/bin/ls -la"))).toBe("observe");
  });

  it("echo 不在安全命令列表（规格决策）", () => {
    expect(classifier.classify(bashRequest("echo hello"))).toBe("external");
  });

  it("git 只读子命令归类为 observe", () => {
    for (const cmd of [
      "git status",
      "git log --oneline",
      "git diff HEAD",
      "git branch",
      "git show HEAD",
      "git remote -v",
    ]) {
      expect(classifier.classify(bashRequest(cmd))).toBe("observe");
    }
  });

  it("git 写命令不是 observe", () => {
    expect(classifier.classify(bashRequest("git push origin main"))).not.toBe("observe");
    expect(classifier.classify(bashRequest("git commit -m foo"))).not.toBe("observe");
  });

  it("破坏性命令归类为 critical（优先于链式检测）", () => {
    expect(classifier.classify(bashRequest("rm -rf /tmp/junk"))).toBe("critical");
    expect(classifier.classify(bashRequest("rm --recursive /tmp"))).toBe("critical");
    expect(classifier.classify(bashRequest("mkfs.ext4 /dev/sda1"))).toBe("critical");
    expect(classifier.classify(bashRequest("dd if=/dev/zero of=/dev/sda"))).toBe("critical");
    expect(classifier.classify(bashRequest("shred /tmp/secret"))).toBe("critical");
  });

  it("破坏性命令即使含管道也是 critical", () => {
    expect(classifier.classify(bashRequest("ls | rm -rf /tmp/junk"))).toBe("critical");
  });

  it("含管道/重定向/链式操作符 → external（非破坏性）", () => {
    const cases = [
      "ls | grep foo",
      "cat file.txt > out.txt",
      "echo hello && ls",
      "true || false",
      "ls; pwd",
      "echo `whoami`",
      "echo $(whoami)",
    ];
    for (const cmd of cases) {
      expect(classifier.classify(bashRequest(cmd))).toBe("external");
    }
  });

  it("包管理 / 构建 / 测试命令无特殊处理 → external", () => {
    for (const cmd of [
      "npm install express",
      "pnpm build",
      "cargo build --release",
      "tsc --noEmit",
      "vitest run",
    ]) {
      expect(classifier.classify(bashRequest(cmd))).toBe("external");
    }
  });

  it("未知命令 → external", () => {
    expect(classifier.classify(bashRequest("curl https://evil.com"))).toBe("external");
    expect(classifier.classify(bashRequest("ssh user@host"))).toBe("external");
    expect(classifier.classify(bashRequest("some-unknown-binary --flag"))).toBe("external");
  });

  it("空命令或缺失 command 参数 → external", () => {
    expect(classifier.classify(bashRequest(""))).toBe("external");
    expect(classifier.classify(makeRequest({ tool: "bash", arguments: {} }))).toBe(
      "external",
    );
  });

  it("从 resolvedAccess.commands 提取命令", () => {
    const req = makeRequest({
      tool: "bash",
      arguments: {},
      resolvedAccess: { commands: ["git status"] },
    });
    expect(classifier.classify(req)).toBe("observe");
  });

  it("可执行名大小写不敏感", () => {
    expect(classifier.classify(bashRequest("LS -la"))).toBe("observe");
    expect(classifier.classify(bashRequest("GIT status"))).toBe("observe");
  });
});

// ─── BoundaryImpactClassifier ───

describe("BoundaryImpactClassifier", () => {
  function registry(
    map: Record<string, BoundaryCrossing[]>,
  ): ToolBoundaryRegistry {
    return {
      getBoundaries: (name) => map[name],
    };
  }

  it("未注册工具 → critical（fail-to-confirm）", () => {
    const classifier = new BoundaryImpactClassifier(EMPTY_BOUNDARY_REGISTRY);
    expect(classifier.classify(makeRequest({ tool: "mcp_unknown" }))).toBe(
      "critical",
    );
  });

  it("空边界声明 → critical", () => {
    const classifier = new BoundaryImpactClassifier(registry({ empty_tool: [] }));
    expect(classifier.classify(makeRequest({ tool: "empty_tool" }))).toBe(
      "critical",
    );
  });

  it("只读边界 → observe", () => {
    const classifier = new BoundaryImpactClassifier(
      registry({
        wechat_read: [
          { boundaryType: "messaging", access: "read", dynamic: false },
        ],
        api_query: [
          { boundaryType: "external-service", access: "query", dynamic: false },
        ],
      }),
    );
    expect(classifier.classify(makeRequest({ tool: "wechat_read" }))).toBe("observe");
    expect(classifier.classify(makeRequest({ tool: "api_query" }))).toBe("observe");
  });

  it("消息发送 → external", () => {
    const classifier = new BoundaryImpactClassifier(
      registry({
        wechat: [
          { boundaryType: "messaging", access: "read", dynamic: false },
          { boundaryType: "messaging", access: "send", dynamic: true },
        ],
      }),
    );
    expect(classifier.classify(makeRequest({ tool: "wechat" }))).toBe("external");
  });

  it("财务操作 → critical", () => {
    const classifier = new BoundaryImpactClassifier(
      registry({
        bank: [{ boundaryType: "financial", access: "transfer", dynamic: true }],
      }),
    );
    expect(classifier.classify(makeRequest({ tool: "bank" }))).toBe("critical");
  });

  it("secrets 和 system 边界一律 critical", () => {
    const classifier = new BoundaryImpactClassifier(
      registry({
        vault: [{ boundaryType: "secrets", access: "write", dynamic: false }],
        sysconf: [{ boundaryType: "system", access: "modify", dynamic: false }],
      }),
    );
    expect(classifier.classify(makeRequest({ tool: "vault" }))).toBe("critical");
    expect(classifier.classify(makeRequest({ tool: "sysconf" }))).toBe("critical");
  });

  it("agent-context 切换 → external (新 BoundaryType: workmode enter/exit 等切换 agent 自身运行态的工具锚点)", () => {
    const classifier = new BoundaryImpactClassifier(
      registry({
        workmode_enter: [
          { boundaryType: "agent-context", access: "switch", dynamic: false },
        ],
        workmode_exit: [
          { boundaryType: "agent-context", access: "switch", dynamic: false },
        ],
      }),
    );
    expect(classifier.classify(makeRequest({ tool: "workmode_enter" }))).toBe(
      "external",
    );
    expect(classifier.classify(makeRequest({ tool: "workmode_exit" }))).toBe(
      "external",
    );
  });

  it("agent-context 只读 access → observe (read-class 走 BOUNDARY_READ_ACCESS 早路径,不到 write 映射)", () => {
    const classifier = new BoundaryImpactClassifier(
      registry({
        peek_mode: [
          { boundaryType: "agent-context", access: "describe", dynamic: false },
        ],
      }),
    );
    expect(classifier.classify(makeRequest({ tool: "peek_mode" }))).toBe(
      "observe",
    );
  });

  it("多个边界跨越取最高影响等级", () => {
    const classifier = new BoundaryImpactClassifier(
      registry({
        multi: [
          { boundaryType: "filesystem", access: "read", dynamic: false },
          { boundaryType: "network", access: "egress", dynamic: true },
          { boundaryType: "financial", access: "query", dynamic: false },
        ],
      }),
    );
    // network.egress 是 external, financial.query 是 observe, filesystem.read 是 observe
    expect(classifier.classify(makeRequest({ tool: "multi" }))).toBe("external");
  });

  it("access 大小写不敏感", () => {
    const classifier = new BoundaryImpactClassifier(
      registry({
        api: [{ boundaryType: "external-service", access: "READ", dynamic: false }],
      }),
    );
    expect(classifier.classify(makeRequest({ tool: "api" }))).toBe("observe");
  });
});

// ─── CompositeClassifier ───

describe("CompositeClassifier", () => {
  it("注册的上下文分类器优先", () => {
    const fs = new FileSystemClassifier();
    const composite = new CompositeClassifier();
    composite.registerContext("read", fs);

    const req = makeRequest({ tool: "read", arguments: { path: "/tmp/foo" } });
    expect(composite.classify(req)).toBe("observe");
  });

  it("未注册的工具走边界分类器", () => {
    const composite = new CompositeClassifier();
    composite.setBoundaryClassifier({
      classify: () => "external" as const,
    });

    expect(composite.classify(makeRequest({ tool: "mystery" }))).toBe("external");
  });

  it("无边界分类器且未注册 → critical（最保守）", () => {
    const composite = new CompositeClassifier();
    expect(composite.classify(makeRequest({ tool: "anything" }))).toBe("critical");
  });

  it("工具名大小写不敏感", () => {
    const composite = new CompositeClassifier();
    composite.registerContext("bash", new ShellClassifier());
    expect(composite.classify(bashRequest("ls"))).toBe("observe");
    expect(
      composite.classify(makeRequest({ tool: "BASH", arguments: { command: "ls" } })),
    ).toBe("observe");
  });
});

// ─── createDefaultClassifier 工厂 ───

describe("createDefaultClassifier", () => {
  it("默认配置下：文件读取 observe，Shell 分类生效", () => {
    const classifier = createDefaultClassifier();

    expect(
      classifier.classify(makeRequest({ tool: "read", arguments: { path: "/tmp/x" } })),
    ).toBe("observe");
    expect(classifier.classify(bashRequest("git status"))).toBe("observe");
    expect(classifier.classify(bashRequest("npm install"))).toBe("external");
    expect(classifier.classify(bashRequest("rm -rf /tmp/x"))).toBe("critical");
  });

  it("默认配置下未注册的工具 → critical（空注册表）", () => {
    const classifier = createDefaultClassifier();
    expect(classifier.classify(makeRequest({ tool: "mcp_random" }))).toBe(
      "critical",
    );
  });

  it("注入边界注册表后，已声明的工具按边界分类", () => {
    const classifier = createDefaultClassifier({
      registry: {
        getBoundaries: (name) =>
          name === "wechat"
            ? [{ boundaryType: "messaging", access: "send", dynamic: true }]
            : undefined,
      },
    });
    expect(classifier.classify(makeRequest({ tool: "wechat" }))).toBe("external");
    expect(classifier.classify(makeRequest({ tool: "unknown_tool" }))).toBe(
      "critical",
    );
  });

  it("声明 app-state 边界的工具 → internal（memory / schedule 由硬编码改为声明式的路径）", () => {
    const classifier = createDefaultClassifier({
      registry: {
        getBoundaries: (name) =>
          name === "memory"
            ? [{ boundaryType: "app-state", access: "write", dynamic: false }]
            : undefined,
      },
    });
    expect(classifier.classify(makeRequest({ tool: "memory" }))).toBe("internal");
  });
});
