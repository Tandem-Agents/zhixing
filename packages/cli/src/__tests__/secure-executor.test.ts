/**
 * SecureExecuteTool 单元测试
 *
 * 用 mock 的 prompt 函数和真实的 SecurityPipeline 验证：
 *   - 安全操作直接放行
 *   - block 决策抛 SecurityBlockError 不调用原始 executeTool
 *   - confirm 决策弹对话框，用户选 [y] 放行 + 累计追踪
 *   - 用户选 [a] / [g] / [s] 创建对应作用域的权限规则
 *   - 用户选 [n] 抛 SecurityBlockError
 *   - 无 prompt 时 confirm 自动 block
 *   - 已创建的规则在下次调用时自动放行
 */

import { describe, expect, it, vi } from "vitest";
import {
  PermissionStore,
  SecurityPipeline,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from "@zhixing/core";
import {
  SecurityBlockError,
  createSecureExecuteTool,
  type PromptFn,
} from "../security/index.js";

// ─── 测试辅助 ───

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object" } as never,
    call: async () => ({ content: "ok", isError: false }),
  } as ToolDefinition;
}

function makeContext(cwd: string = "/tmp/ws"): ToolExecutionContext {
  return { workingDirectory: cwd };
}

function mockExecute(): {
  fn: (
    tool: ToolDefinition,
    input: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ) => Promise<ToolResult>;
  callCount: () => number;
} {
  let count = 0;
  return {
    fn: async () => {
      count++;
      return { content: "executed", isError: false };
    },
    callCount: () => count,
  };
}

/** 创建一个会按预设序列回答的 mock prompt */
function scriptedPrompt(answers: string[]): PromptFn {
  let idx = 0;
  return async () => {
    const a = answers[idx++];
    if (a === undefined) throw new Error("scriptedPrompt 用尽");
    return a;
  };
}

// ─── 测试 ───

describe("createSecureExecuteTool", () => {
  describe("放行路径", () => {
    it("observe 操作直接调用原始 executeTool", async () => {
      const pipeline = new SecurityPipeline({ workspace: "/tmp/ws" });
      const exec = mockExecute();
      const wrapped = createSecureExecuteTool({
        pipeline,
        originalExecute: exec.fn,
      });

      const result = await wrapped(
        makeTool("read"),
        { path: "src/index.ts" },
        makeContext(),
      );

      expect(result.content).toBe("executed");
      expect(exec.callCount()).toBe(1);
    });

    it("internal 操作（工作区内 write）直接放行", async () => {
      const os = await import("node:os");
      const fs = await import("node:fs");
      const path = await import("node:path");
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), "zx-secexec-"));
      try {
        const pipeline = new SecurityPipeline({ workspace: ws });
        const exec = mockExecute();
        const wrapped = createSecureExecuteTool({
          pipeline,
          originalExecute: exec.fn,
        });

        await wrapped(
          makeTool("write"),
          { path: path.join(ws, "foo.ts") },
          makeContext(ws),
        );
        expect(exec.callCount()).toBe(1);
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  describe("block 路径", () => {
    it(".git/config 写入抛 SecurityBlockError，不调用原始 executeTool", async () => {
      const pipeline = new SecurityPipeline({ workspace: "/tmp/ws" });
      const exec = mockExecute();
      const wrapped = createSecureExecuteTool({
        pipeline,
        originalExecute: exec.fn,
      });

      await expect(
        wrapped(
          makeTool("write"),
          { path: ".git/config" },
          makeContext("/tmp/ws"),
        ),
      ).rejects.toBeInstanceOf(SecurityBlockError);

      expect(exec.callCount()).toBe(0);
    });
  });

  describe("confirm + interactive", () => {
    it("用户选 [y] 一次性允许：放行 + 累计追踪", async () => {
      const pipeline = new SecurityPipeline({ workspace: "/tmp/ws" });
      const tracker = pipeline.getConfirmationTracker();
      const exec = mockExecute();
      const wrapped = createSecureExecuteTool({
        pipeline,
        originalExecute: exec.fn,
        prompt: scriptedPrompt(["y"]),
      });

      // 拦截 console.log 减少噪音
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await wrapped(
          makeTool("bash"),
          { command: "curl https://example.com" },
          makeContext("/tmp/ws"),
        );
      } finally {
        logSpy.mockRestore();
      }

      expect(exec.callCount()).toBe(1);

      // tracker 应该累积了一次记录
      const status = tracker.shouldSuggest(
        {
          tool: "bash",
          arguments: { command: "curl https://example.com" },
          context: {
            cwd: "/tmp/ws",
            workspace: "/tmp/ws",
            sessionType: "interactive",
          },
        },
        "medium",
      );
      expect(status.count).toBe(1);
    });

    it("用户选 [n] 拒绝：抛错且不调用 executeTool", async () => {
      const pipeline = new SecurityPipeline({ workspace: "/tmp/ws" });
      const exec = mockExecute();
      const wrapped = createSecureExecuteTool({
        pipeline,
        originalExecute: exec.fn,
        prompt: scriptedPrompt(["n"]),
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await expect(
          wrapped(
            makeTool("bash"),
            { command: "curl https://evil.com" },
            makeContext("/tmp/ws"),
          ),
        ).rejects.toBeInstanceOf(SecurityBlockError);
      } finally {
        logSpy.mockRestore();
      }

      expect(exec.callCount()).toBe(0);
    });

    it("用户选 [a] 创建 workspace 规则，下次自动放行", async () => {
      const store = new PermissionStore({ rootDir: null });
      const pipeline = new SecurityPipeline({
        workspace: "/tmp/ws",
        permissionStore: store,
      });
      const exec = mockExecute();
      const wrapped = createSecureExecuteTool({
        pipeline,
        originalExecute: exec.fn,
        prompt: scriptedPrompt(["a"]),
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        // 第一次：选 [a]，创建规则
        await wrapped(
          makeTool("bash"),
          { command: "curl https://api.example.com/users" },
          makeContext("/tmp/ws"),
        );

        // 第二次：相同 host，应被新规则匹配，不再触发对话框（无 prompt 答案也能通过）
        const wrapped2 = createSecureExecuteTool({
          pipeline,
          originalExecute: exec.fn,
          prompt: scriptedPrompt([]), // 用尽就会抛错——若被调用说明规则没生效
        });
        await wrapped2(
          makeTool("bash"),
          { command: "curl https://api.example.com/posts" },
          makeContext("/tmp/ws"),
        );
      } finally {
        logSpy.mockRestore();
      }

      expect(exec.callCount()).toBe(2);

      // 工作区规则被创建
      const wsId = pipeline.getWorkspaceId();
      expect(wsId).toBeTruthy();
      const rules = store.list(wsId);
      const wsRules = rules.filter((r) => r.scope === "workspace");
      expect(wsRules.length).toBe(1);
      expect(wsRules[0]!.pattern.argument).toContain("curl");
    });

    it("用户选 [g] 创建 global 规则", async () => {
      const store = new PermissionStore({ rootDir: null });
      const pipeline = new SecurityPipeline({
        workspace: "/tmp/ws",
        permissionStore: store,
      });
      const exec = mockExecute();
      const wrapped = createSecureExecuteTool({
        pipeline,
        originalExecute: exec.fn,
        prompt: scriptedPrompt(["g"]),
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await wrapped(
          makeTool("bash"),
          { command: "curl https://api.example.com" },
          makeContext("/tmp/ws"),
        );
      } finally {
        logSpy.mockRestore();
      }

      const globalRules = store
        .list(null)
        .filter((r) => r.scope === "global");
      expect(globalRules.length).toBe(1);
    });

    it("无效输入后重新提问，最终接受 [y]", async () => {
      const pipeline = new SecurityPipeline({ workspace: "/tmp/ws" });
      const exec = mockExecute();
      const wrapped = createSecureExecuteTool({
        pipeline,
        originalExecute: exec.fn,
        prompt: scriptedPrompt(["x", "wat", "y"]),
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await wrapped(
          makeTool("bash"),
          { command: "curl https://example.com" },
          makeContext("/tmp/ws"),
        );
      } finally {
        logSpy.mockRestore();
      }

      expect(exec.callCount()).toBe(1);
    });
  });

  describe("confirm + 无 prompt（CI 模式）", () => {
    it("requiresConfirmation 但无 prompt 时抛 SecurityBlockError", async () => {
      const pipeline = new SecurityPipeline({
        workspace: "/tmp/ws",
        sessionType: "interactive", // 仍是 interactive，但不传 prompt
      });
      const exec = mockExecute();
      const wrapped = createSecureExecuteTool({
        pipeline,
        originalExecute: exec.fn,
        // 不传 prompt
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await expect(
          wrapped(
            makeTool("bash"),
            { command: "curl https://example.com" },
            makeContext("/tmp/ws"),
          ),
        ).rejects.toBeInstanceOf(SecurityBlockError);
      } finally {
        logSpy.mockRestore();
      }

      expect(exec.callCount()).toBe(0);
    });
  });
});
