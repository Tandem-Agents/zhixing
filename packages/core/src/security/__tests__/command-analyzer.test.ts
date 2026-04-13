/**
 * CommandAnalyzer 单元测试
 *
 * 覆盖四大块：
 *   1. Tokenizer：引号感知、转义、操作符识别
 *   2. Chain 切分：顶层 pipe/and/or/semi，尊重 subshell 深度
 *   3. 子命令分析：executable/args/subcommand/redirects/interpreter eval
 *   4. 资源提取：路径 / 主机 / env var
 *
 * 加上 CommandAnalyzerMiddleware 的单元测试。
 */

import { describe, expect, it } from "vitest";

import {
  CommandAnalyzerMiddleware,
  analyzeCommand,
} from "../command-analyzer.js";
import type {
  SecurityMiddlewareContext,
} from "../types.js";

// ─── analyzeCommand ───

describe("analyzeCommand — 基础", () => {
  it("空命令返回空分析", () => {
    const r = analyzeCommand("");
    expect(r.subcommands).toEqual([]);
    expect(r.hasChain).toBe(false);
  });

  it("单命令提取 executable 和 args", () => {
    const r = analyzeCommand("git status");
    expect(r.subcommands).toHaveLength(1);
    expect(r.subcommands[0]!.executable).toBe("git");
    expect(r.subcommands[0]!.arguments).toEqual(["status"]);
    expect(r.subcommands[0]!.subcommand).toBe("status");
    expect(r.hasChain).toBe(false);
  });

  it("绝对路径 executable 归一化为 basename 小写", () => {
    const r = analyzeCommand("/usr/bin/LS -la");
    expect(r.subcommands[0]!.executable).toBe("ls");
  });
});

describe("analyzeCommand — 引号感知", () => {
  it("双引号内的 | 不是管道", () => {
    const r = analyzeCommand('echo "hello | world"');
    expect(r.hasChain).toBe(false);
    expect(r.chainOperators).toEqual([]);
    expect(r.subcommands).toHaveLength(1);
    expect(r.subcommands[0]!.executable).toBe("echo");
  });

  it("单引号内的 | 也不是管道", () => {
    const r = analyzeCommand("echo 'a | b'");
    expect(r.hasChain).toBe(false);
  });

  it("双引号内的 > 不是重定向", () => {
    const r = analyzeCommand('echo "a > b"');
    expect(r.redirects).toEqual([]);
  });

  it("转义的 | 不是管道", () => {
    const r = analyzeCommand("echo a \\| b");
    expect(r.hasChain).toBe(false);
  });

  it("混合引号与转义", () => {
    const r = analyzeCommand(`echo "hello \\"world\\""`);
    expect(r.subcommands[0]!.executable).toBe("echo");
    expect(r.hasChain).toBe(false);
  });
});

describe("analyzeCommand — Chain 检测", () => {
  it("管道切分为多段", () => {
    const r = analyzeCommand("ls | grep foo");
    expect(r.hasChain).toBe(true);
    expect(r.chainOperators).toEqual(["|"]);
    expect(r.subcommands).toHaveLength(2);
    expect(r.subcommands[0]!.executable).toBe("ls");
    expect(r.subcommands[1]!.executable).toBe("grep");
  });

  it("&& 和 || 都被识别", () => {
    const r = analyzeCommand("echo a && echo b || echo c");
    expect(r.chainOperators).toEqual(["&&", "||"]);
    expect(r.subcommands).toHaveLength(3);
  });

  it("分号切分", () => {
    const r = analyzeCommand("cd /tmp; ls; pwd");
    expect(r.chainOperators).toEqual([";", ";"]);
    expect(r.subcommands).toHaveLength(3);
  });

  it("subshell 内的操作符不算顶层 chain", () => {
    const r = analyzeCommand("echo $(ls | wc -l)");
    // 虽然内部有 |，但只有 1 个顶层子命令
    expect(r.subcommands.length).toBeGreaterThanOrEqual(1);
    expect(r.subcommands[0]!.executable).toBe("echo");
    // 仍被标记为 hasChain（因为 command substitution）
    expect(r.hasCommandSubstitution).toBe(true);
    expect(r.hasChain).toBe(true);
  });

  it("反引号命令替换被标记", () => {
    const r = analyzeCommand("echo `whoami`");
    expect(r.hasCommandSubstitution).toBe(true);
    expect(r.hasChain).toBe(true);
  });
});

describe("analyzeCommand — 重定向", () => {
  it("输出重定向", () => {
    const r = analyzeCommand("echo hello > /tmp/out.txt");
    expect(r.redirects).toEqual([
      { operator: ">", target: "/tmp/out.txt" },
    ]);
    // 重定向目标自动加入 accessedPaths
    expect(r.accessedPaths).toContain("/tmp/out.txt");
  });

  it("追加重定向", () => {
    const r = analyzeCommand("echo hello >> /var/log/app.log");
    expect(r.redirects[0]!.operator).toBe(">>");
  });

  it("输入重定向", () => {
    const r = analyzeCommand("cat < /etc/passwd");
    expect(r.redirects[0]!.operator).toBe("<");
    expect(r.redirects[0]!.target).toBe("/etc/passwd");
  });

  it("stderr 重定向", () => {
    const r = analyzeCommand("cmd 2> /tmp/err.log");
    expect(r.redirects[0]!.operator).toBe("2>");
  });
});

describe("analyzeCommand — 路径提取", () => {
  it("绝对路径", () => {
    const r = analyzeCommand("cat /etc/passwd");
    expect(r.accessedPaths).toContain("/etc/passwd");
  });

  it("主目录路径", () => {
    const r = analyzeCommand("cat ~/.ssh/id_rsa");
    expect(r.accessedPaths).toContain("~/.ssh/id_rsa");
  });

  it("相对路径", () => {
    const r = analyzeCommand("vim ./src/index.ts");
    expect(r.accessedPaths).toContain("./src/index.ts");
  });

  it("Windows 路径（forward slashes）", () => {
    const r = analyzeCommand("type C:/Windows/System32/drivers/etc/hosts");
    expect(
      r.accessedPaths.some((p) => p.toLowerCase().includes("windows")),
    ).toBe(true);
  });

  it("双引号内的 Windows 路径保留反斜杠", () => {
    const r = analyzeCommand('type "C:\\Windows\\System32\\hosts"');
    // 双引号内 \W 不是 escape 序列，反斜杠应该被保留
    expect(
      r.accessedPaths.some((p) => p.includes("\\Windows")),
    ).toBe(true);
  });

  it("flag 和 VAR=value 不被当作路径", () => {
    const r = analyzeCommand("git log --oneline HEAD");
    expect(r.accessedPaths).toEqual([]);
  });

  it("含 / 的非 URL token 被当作路径", () => {
    const r = analyzeCommand("ls src/components");
    expect(r.accessedPaths).toContain("src/components");
  });
});

describe("analyzeCommand — 主机提取", () => {
  it("https URL 提取主机", () => {
    const r = analyzeCommand("curl https://api.github.com/users");
    expect(r.accessedHosts).toContain("api.github.com");
  });

  it("ssh URL 提取主机", () => {
    const r = analyzeCommand("ssh git@github.com:user/repo.git");
    // ssh 的 user@host:path 格式不是标准 URL，不被我们的正则捕获
    // 但 ssh://git@github.com/repo 这种形式可以
    const r2 = analyzeCommand("git clone ssh://git@github.com/user/repo");
    expect(r2.accessedHosts).toContain("github.com");
  });

  it("URL 不会被当作路径", () => {
    const r = analyzeCommand("wget https://example.com/file.tar.gz");
    expect(r.accessedHosts).toContain("example.com");
    expect(r.accessedPaths).not.toContain("https://example.com/file.tar.gz");
  });
});

describe("analyzeCommand — 环境变量", () => {
  it("前缀赋值 VAR=value", () => {
    const r = analyzeCommand("LD_PRELOAD=/evil.so ls");
    expect(r.usedEnvVars).toContain("LD_PRELOAD");
    // executable 是 ls，不是 LD_PRELOAD=
    expect(r.subcommands[0]!.executable).toBe("ls");
  });

  it("$VAR 引用", () => {
    const r = analyzeCommand('echo $HOME');
    expect(r.usedEnvVars).toContain("HOME");
  });

  it("${VAR} 引用", () => {
    const r = analyzeCommand('echo "${PATH}"');
    expect(r.usedEnvVars).toContain("PATH");
  });

  it("多个前缀赋值", () => {
    const r = analyzeCommand("FOO=1 BAR=2 env");
    expect(r.usedEnvVars).toEqual(expect.arrayContaining(["FOO", "BAR"]));
    expect(r.subcommands[0]!.executable).toBe("env");
  });
});

describe("analyzeCommand — 解释器 eval", () => {
  it("python -c 被识别", () => {
    const r = analyzeCommand('python -c "import os; print(os.getcwd())"');
    expect(r.hasInterpreterEval).toBe(true);
    expect(r.subcommands[0]!.isInterpreterEval).toBe(true);
  });

  it("python3.11 -c 带版本号也被识别", () => {
    const r = analyzeCommand('python3.11 -c "print(1)"');
    expect(r.hasInterpreterEval).toBe(true);
  });

  it("node -e 被识别", () => {
    const r = analyzeCommand('node -e "console.log(1)"');
    expect(r.hasInterpreterEval).toBe(true);
  });

  it("bash -c 被识别", () => {
    const r = analyzeCommand('bash -c "echo hi"');
    expect(r.hasInterpreterEval).toBe(true);
  });

  it("python 不带 -c 不是 eval", () => {
    const r = analyzeCommand("python script.py");
    expect(r.hasInterpreterEval).toBe(false);
  });

  it("非解释器工具不会误报", () => {
    const r = analyzeCommand("git -c user.name=foo commit");
    // git 有 -c 但不是解释器
    expect(r.hasInterpreterEval).toBe(false);
  });
});

describe("analyzeCommand — 跨段聚合", () => {
  it("多段命令的路径被合并去重", () => {
    const r = analyzeCommand("cat /etc/passwd | grep root > /tmp/out.txt");
    expect(r.accessedPaths).toEqual(
      expect.arrayContaining(["/etc/passwd", "/tmp/out.txt"]),
    );
  });

  it("多段命令的主机被合并", () => {
    const r = analyzeCommand(
      "curl https://a.com && wget https://b.com/file",
    );
    expect(r.accessedHosts).toEqual(expect.arrayContaining(["a.com", "b.com"]));
  });
});

// ─── CommandAnalyzerMiddleware ───

describe("CommandAnalyzerMiddleware", () => {
  function makeCtx(
    tool: string,
    args: Record<string, unknown>,
  ): SecurityMiddlewareContext {
    return {
      request: {
        tool,
        arguments: args,
        context: {
          cwd: "/tmp",
          workspace: null,
          sessionType: "interactive",
        },
      },
      toolName: tool,
      toolInput: args,
      workingDirectory: "/tmp",
      state: {},
    };
  }

  it("bash 工具：填充 resolvedAccess", async () => {
    const mw = new CommandAnalyzerMiddleware();
    const ctx = makeCtx("bash", { command: "cat /etc/passwd" });
    await mw.execute(ctx, async () => ({ allowed: true }));

    expect(ctx.request.resolvedAccess).toBeDefined();
    expect(ctx.request.resolvedAccess!.paths).toContain("/etc/passwd");
    expect(ctx.request.resolvedAccess!.commandAnalysis).toBeDefined();
  });

  it("非 shell 工具：不触碰 resolvedAccess", async () => {
    const mw = new CommandAnalyzerMiddleware();
    const ctx = makeCtx("read", { path: "/tmp/foo" });
    await mw.execute(ctx, async () => ({ allowed: true }));

    expect(ctx.request.resolvedAccess).toBeUndefined();
  });

  it("空命令：不填 commandAnalysis", async () => {
    const mw = new CommandAnalyzerMiddleware();
    const ctx = makeCtx("bash", { command: "" });
    await mw.execute(ctx, async () => ({ allowed: true }));

    expect(ctx.request.resolvedAccess?.commandAnalysis).toBeUndefined();
  });

  it("合并已有 resolvedAccess 而非替换", async () => {
    const mw = new CommandAnalyzerMiddleware();
    const ctx = makeCtx("bash", { command: "cat /etc/hosts" });
    ctx.request.resolvedAccess = {
      paths: ["/pre-existing"],
    };
    await mw.execute(ctx, async () => ({ allowed: true }));

    expect(ctx.request.resolvedAccess!.paths).toEqual(
      expect.arrayContaining(["/pre-existing", "/etc/hosts"]),
    );
  });

  it("shell 工具同样被处理", async () => {
    const mw = new CommandAnalyzerMiddleware();
    const ctx = makeCtx("shell", { command: "curl https://evil.com" });
    await mw.execute(ctx, async () => ({ allowed: true }));

    expect(ctx.request.resolvedAccess?.hosts).toContain("evil.com");
  });
});
