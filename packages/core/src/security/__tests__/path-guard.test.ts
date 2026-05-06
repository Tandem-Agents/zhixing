import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { PathGuard } from "../path-guard.js";

describe("PathGuard", () => {
  const home = os.homedir();
  const cwd = path.join(home, "project");

  describe("resolve", () => {
    it("相对路径解析为绝对路径", () => {
      const resolved = PathGuard.resolve("src/index.ts", cwd);
      expect(path.isAbsolute(resolved)).toBe(true);
    });

    it("~ 展开为用户主目录", () => {
      const resolved = PathGuard.resolve("~/Documents/test.txt", cwd);
      expect(resolved.startsWith(home)).toBe(true);
      expect(resolved).toContain("Documents");
    });

    it(".. 路径遍历被规范化", () => {
      const resolved = PathGuard.resolve("../other/file.txt", cwd);
      expect(resolved).not.toContain("..");
    });

    it("绝对路径直接返回（规范化后）", () => {
      const input = path.join(home, "absolute", "path.txt");
      const resolved = PathGuard.resolve(input, cwd);
      expect(resolved).toContain("absolute");
    });
  });

  describe("isWithinWorkspace", () => {
    it("工作区内的文件返回 true", () => {
      expect(
        PathGuard.isWithinWorkspace("src/index.ts", cwd, cwd),
      ).toBe(true);
    });

    it("工作区根目录本身返回 true", () => {
      expect(PathGuard.isWithinWorkspace(".", cwd, cwd)).toBe(true);
    });

    it("工作区外的文件返回 false", () => {
      expect(
        PathGuard.isWithinWorkspace("/etc/passwd", cwd, cwd),
      ).toBe(false);
    });

    it("路径遍历到工作区外返回 false", () => {
      expect(
        PathGuard.isWithinWorkspace("../../etc/passwd", cwd, cwd),
      ).toBe(false);
    });

    it("~ 路径的工作区检查", () => {
      expect(
        PathGuard.isWithinWorkspace("~/.ssh/id_rsa", cwd, cwd),
      ).toBe(false);
    });
  });

  describe("isSystemProtected", () => {
    it("~/.ssh 是系统保护路径", () => {
      expect(PathGuard.isSystemProtected("~/.ssh/id_rsa", cwd)).toBe(true);
    });

    it("~/.ssh 目录本身是保护路径", () => {
      expect(PathGuard.isSystemProtected("~/.ssh", cwd)).toBe(true);
    });

    it("~/.gnupg 是系统保护路径", () => {
      expect(PathGuard.isSystemProtected("~/.gnupg/pubring.kbx", cwd)).toBe(
        true,
      );
    });

    it("~/.aws/credentials 是系统保护路径", () => {
      expect(
        PathGuard.isSystemProtected("~/.aws/credentials", cwd),
      ).toBe(true);
    });

    it("普通路径不是系统保护路径", () => {
      expect(PathGuard.isSystemProtected("src/index.ts", cwd)).toBe(false);
    });

    it("用户主目录本身不是系统保护路径", () => {
      expect(PathGuard.isSystemProtected("~", cwd)).toBe(false);
    });
  });

  describe("hasTraversalSequence", () => {
    it("检测 ../ 遍历序列", () => {
      expect(PathGuard.hasTraversalSequence("../../etc/passwd")).toBe(true);
    });

    it("检测 ..\\ 遍历序列（Windows）", () => {
      expect(PathGuard.hasTraversalSequence("..\\..\\Windows\\System32")).toBe(
        true,
      );
    });

    it("检测单独的 ..", () => {
      expect(PathGuard.hasTraversalSequence("..")).toBe(true);
    });

    it("正常路径不包含遍历序列", () => {
      expect(PathGuard.hasTraversalSequence("src/components/App.tsx")).toBe(
        false,
      );
    });

    it("包含 .. 但非遍历的路径不误报", () => {
      // "file..txt" 不是遍历，因为 .. 后面跟的不是 / 或 \\
      expect(PathGuard.hasTraversalSequence("file..txt")).toBe(false);
    });
  });

  describe("中间件执行", () => {
    it("提取并解析路径参数", async () => {
      const guard = new PathGuard();
      const ctx = {
        request: {
          tool: "write",
          arguments: { path: "src/test.ts" },
          context: {
            cwd,
            workspace: cwd,
            sessionType: "interactive" as const,
          },
        },
        toolName: "write",
        toolInput: { path: "src/test.ts" },
        workingDirectory: cwd,
        state: {},
      };

      const result = await guard.execute(ctx, async () => ({
        allowed: true,
      }));

      expect(result.resolvedPaths).toBeDefined();
      expect(result.resolvedPaths!.length).toBe(1);
      expect(path.isAbsolute(result.resolvedPaths![0]!)).toBe(true);
    });

    it("无路径参数时直接传递", async () => {
      const guard = new PathGuard();
      const ctx = {
        request: {
          tool: "bash",
          arguments: { command: "echo hello" },
          context: {
            cwd,
            workspace: cwd,
            sessionType: "interactive" as const,
          },
        },
        toolName: "bash",
        toolInput: { command: "echo hello" },
        workingDirectory: cwd,
        state: {},
      };

      const result = await guard.execute(ctx, async () => ({
        allowed: true,
      }));

      expect(result.resolvedPaths).toBeUndefined();
    });
  });
});
