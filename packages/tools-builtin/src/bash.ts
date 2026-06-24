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
 * 中断行为：interruptBehavior="grace" — timeout / abort / 输出超限都先清理命令
 * 进程树,再返回结果。工具返回后不应留下仍运行的外部命令。
 *
 * 后续安全增强点（当前不实现）：
 * - 危险命令黑名单
 * - 命令 AST 分析
 * - 进程级沙箱
 */

import { spawn } from "node:child_process";
import { gracefulKill, type ToolDefinition, type ToolResult } from "@zhixing/core";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESULT_CHARS = 30_000;
const MAX_OUTPUT_BUFFER_BYTES = 10 * 1024 * 1024;

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
    interruptBehavior: "grace",
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

        if (message.includes("OUTPUT_LIMIT")) {
          return {
            content: `Command output exceeded ${MAX_OUTPUT_BUFFER_BYTES} bytes: ${command}`,
            isError: true,
          };
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
  if (options.signal?.aborted) {
    return Promise.reject(new Error("ABORT: Command was aborted"));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let terminating = false;
    let onAbort: (() => void) | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const cleanup = (): void => {
      if (onAbort && options.signal) {
        options.signal.removeEventListener("abort", onAbort);
        onAbort = null;
      }
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    };

    const child = spawn(
      command,
      {
        cwd: options.cwd,
        shell: true,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const terminate = (message: string): void => {
      if (settled || terminating) return;
      terminating = true;
      cleanup();
      void (async () => {
        await gracefulKill(child);
        settle(() => reject(new Error(message)));
      })();
    };

    const appendChunk = (kind: "stdout" | "stderr", chunk: Buffer | string): void => {
      if (settled || terminating) return;

      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const nextTotal =
        kind === "stdout" ? stdoutBytes + buffer.length : stderrBytes + buffer.length;

      if (stdoutBytes + stderrBytes + buffer.length > MAX_OUTPUT_BUFFER_BYTES) {
        terminate(`OUTPUT_LIMIT: Command output exceeded ${MAX_OUTPUT_BUFFER_BYTES} bytes`);
        return;
      }

      if (kind === "stdout") {
        stdoutBytes = nextTotal;
        stdoutChunks.push(buffer);
      } else {
        stderrBytes = nextTotal;
        stderrChunks.push(buffer);
      }
    };

    child.stdout.on("data", (chunk: Buffer | string) => appendChunk("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer | string) => appendChunk("stderr", chunk));

    child.once("error", (err) => {
      settle(() => reject(err));
    });

    child.once("close", (code) => {
      if (terminating) return;
      settle(() => {
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
          stderr: Buffer.concat(stderrChunks).toString("utf-8"),
          exitCode: code ?? 1,
        });
      });
    });

    timeoutTimer = setTimeout(() => {
      terminate(`TIMEOUT: Command killed after ${options.timeout}ms`);
    }, options.timeout);

    if (options.signal) {
      onAbort = () => {
        terminate("ABORT: Command was aborted");
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      if (options.signal.aborted) {
        onAbort();
      }
    }
  });
}
