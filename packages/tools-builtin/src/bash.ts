/**
 * Bash 工具 — 执行 Shell 命令
 *
 * 智能体最强大的单一能力：通过命令行能做几乎一切。
 *
 * 设计要点：
 * - 跨平台：Windows 用 cmd/PowerShell，Unix 用 /bin/sh
 * - 超时保护：默认 30 秒，防止命令卡住
 * - stdout + stderr 合并输出，附加退出码
 * - needsPermission: true — 命令执行默认需要确认
 * - 输出大小限制：防止 cat 大文件撑爆上下文
 *
 * Phase 2+ 安全增强点（当前不实现）：
 * - 危险命令黑名单
 * - 命令 AST 分析
 * - 进程级沙箱
 */

import { exec } from "node:child_process";
import type { ToolDefinition, ToolResult } from "@zhixing/core";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESULT_CHARS = 30_000;

export function createBashTool(): ToolDefinition {
  return {
    name: "bash",
    description:
      "Execute a shell command and return its output (stdout + stderr). " +
      "Commands run in the working directory. " +
      "Use for: running scripts, installing packages, git operations, " +
      "listing files, searching code, and any other system operation. " +
      "Long-running commands have a 30-second timeout by default.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute",
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds. Default: 30000 (30 seconds)",
        },
      },
      required: ["command"],
    },

    isReadOnly: false,
    isParallelSafe: false,
    needsPermission: true,
    permissionArgumentKey: "command",
    maxResultChars: MAX_RESULT_CHARS,

    async call(input, context): Promise<ToolResult> {
      const command = input.command as string;
      const timeout = typeof input.timeout === "number" ? input.timeout : DEFAULT_TIMEOUT_MS;

      if (!command || typeof command !== "string") {
        return { content: 'Parameter "command" must be a non-empty string.', isError: true };
      }

      try {
        const { stdout, stderr, exitCode } = await execCommand(command, {
          cwd: context.workingDirectory,
          timeout,
          signal: context.abortSignal,
        });

        const parts: string[] = [];

        if (stdout) parts.push(stdout);
        if (stderr) parts.push(stderr ? `[stderr]\n${stderr}` : "");
        if (parts.length === 0) parts.push("(no output)");

        parts.push(`\n[exit code: ${exitCode}]`);

        return {
          content: parts.filter(Boolean).join("\n"),
          isError: exitCode !== 0,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        if (message.includes("TIMEOUT") || message.includes("timed out")) {
          return {
            content: `Command timed out after ${timeout}ms: ${command}`,
            isError: true,
          };
        }

        if (message.includes("ABORT") || message.includes("abort")) {
          return { content: "Command was aborted.", isError: true };
        }

        return { content: `Command execution failed: ${message}`, isError: true };
      }
    },
  };
}

// ─── 内部实现 ───

interface ExecOptions {
  cwd: string;
  timeout: number;
  signal?: AbortSignal;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function execCommand(command: string, options: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = exec(
      command,
      {
        cwd: options.cwd,
        timeout: options.timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error && error.killed) {
          reject(new Error(`TIMEOUT: Command killed after ${options.timeout}ms`));
          return;
        }

        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: error?.code ?? 0,
        });
      },
    );

    if (options.signal) {
      const onAbort = () => {
        child.kill();
        reject(new Error("ABORT: Command was aborted"));
      };
      if (options.signal.aborted) {
        child.kill();
        reject(new Error("ABORT: Command was aborted"));
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });
}
