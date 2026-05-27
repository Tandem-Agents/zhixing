import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PathGuard } from "../path-guard.js";

describe("PathGuard", () => {
  let root: string; // 真实存在的根（已 realpath，规避 tmpdir 自身的 symlink，如 macOS /var→/private/var）
  let ws: string;
  let symlinkOk = false;

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pg-")));
    ws = path.join(root, "ws");
    fs.mkdirSync(path.join(ws, "src"), { recursive: true });
    fs.writeFileSync(path.join(ws, "src", "index.ts"), "x");
    fs.writeFileSync(path.join(root, "secret.txt"), "s");
    fs.mkdirSync(path.join(root, "outside"), { recursive: true });
    try {
      // workspace 内指向 workspace 外文件的 symlink
      fs.symlinkSync(path.join(root, "secret.txt"), path.join(ws, "link-to-secret"));
      // workspace 内指向 workspace 外目录的 symlink
      fs.symlinkSync(path.join(root, "outside"), path.join(ws, "link-dir"));
      symlinkOk = true;
    } catch {
      symlinkOk = false; // Windows 无开发者模式 / 无权限时跳过 symlink 用例
    }
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe("resolve", () => {
    it("相对路径解析为绝对路径", () => {
      const r = PathGuard.resolve("ws/src/index.ts", root);
      expect(r).toBe(path.join(ws, "src", "index.ts"));
    });

    it(".. 被规范化、无残留", () => {
      const r = PathGuard.resolve("ws/../ws/src/index.ts", root);
      expect(r).not.toContain("..");
      expect(r).toBe(path.join(ws, "src", "index.ts"));
    });

    it("不存在的新建路径：存在的父目录被 realpath、拼接剩余段", () => {
      const r = PathGuard.resolve("ws/src/new-file.ts", root);
      expect(r).toBe(path.join(ws, "src", "new-file.ts"));
    });

    it("symlink 被解析到真实目标", () => {
      if (!symlinkOk) return;
      expect(PathGuard.resolve("ws/link-to-secret", root)).toBe(
        path.join(root, "secret.txt"),
      );
    });

    it("经 symlink 目录的新建文件：父 symlink 被解析（堵绕过残留）", () => {
      if (!symlinkOk) return;
      // 父目录 ws/link-dir 是 symlink → outside；newfile 不存在 → 祖先解析应穿透 symlink
      expect(PathGuard.resolve("ws/link-dir/newfile.txt", root)).toBe(
        path.join(root, "outside", "newfile.txt"),
      );
    });
  });

  describe("isWithinWorkspace", () => {
    it("工作区内文件 → true", () => {
      expect(PathGuard.isWithinWorkspace("ws/src/index.ts", ws, root)).toBe(true);
    });

    it("工作区根本身 → true", () => {
      expect(PathGuard.isWithinWorkspace(ws, ws, root)).toBe(true);
    });

    it("工作区外文件 → false", () => {
      expect(PathGuard.isWithinWorkspace(path.join(root, "secret.txt"), ws, root)).toBe(false);
    });

    it(".. 逃逸到工作区外 → false", () => {
      expect(PathGuard.isWithinWorkspace("../secret.txt", ws, ws)).toBe(false);
    });

    it("工作区内 symlink 指向工作区外 → false（防 symlink 逃逸）", () => {
      if (!symlinkOk) return;
      expect(PathGuard.isWithinWorkspace("link-to-secret", ws, ws)).toBe(false);
    });
  });
});
