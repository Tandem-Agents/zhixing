/**
 * ConfirmationTracker + suggestPatterns 单元测试
 *
 * 测试矩阵：
 *   - suggestPatterns: bash / file / 通用工具的候选生成
 *   - tracker.record + getCount 基本计数
 *   - 阈值与风险等级关联（low/medium/high/critical）
 *   - critical 永不建议
 *   - reset 单个 / 全部
 *   - 模式分组：相同 executable + first-arg 跨调用累计
 *   - record 多次后 shouldSuggest 触发
 */

import { describe, expect, it } from "vitest";

import {
  ConfirmationTracker,
  suggestPatterns,
} from "../confirmation-tracker.js";
import type { SecurityRequest } from "../types.js";

// ─── 测试辅助 ───

function bashRequest(command: string): SecurityRequest {
  return {
    tool: "bash",
    arguments: { command },
    context: {
      cwd: "/tmp",
      trust: { kind: "global" },
      sessionType: "interactive",
    },
  };
}

function writeRequest(filePath: string): SecurityRequest {
  return {
    tool: "write",
    arguments: { path: filePath },
    context: {
      cwd: "/tmp",
      trust: { kind: "global" },
      sessionType: "interactive",
    },
  };
}

function genericRequest(tool: string): SecurityRequest {
  return {
    tool,
    arguments: { to: "张三", content: "hello" },
    context: {
      cwd: "/tmp",
      trust: { kind: "global" },
      sessionType: "interactive",
    },
  };
}

// ─── suggestPatterns ───

describe("suggestPatterns", () => {
  describe("bash 命令", () => {
    it("3 段命令产生 3 级建议（精确 → middle → 通用）", () => {
      const patterns = suggestPatterns(bashRequest("npm install express"));
      expect(patterns).toHaveLength(3);
      expect(patterns[0]!.pattern.argument).toBe("npm install express");
      expect(patterns[1]!.pattern.argument).toBe("npm install *");
      expect(patterns[2]!.pattern.argument).toBe("npm *");
    });

    it("2 段命令也产生 3 级（middle 的 'first-arg *' 可能与 cmd 同形被去重）", () => {
      const patterns = suggestPatterns(bashRequest("git status"));
      // git status / git status * / git *
      expect(patterns.length).toBeGreaterThanOrEqual(2);
      expect(patterns[0]!.pattern.argument).toBe("git status");
      // 最后一个永远是最通用的
      expect(patterns[patterns.length - 1]!.pattern.argument).toBe("git *");
    });

    it("1 段命令只产生 2 级（精确 + 通用）", () => {
      const patterns = suggestPatterns(bashRequest("ls"));
      expect(patterns).toHaveLength(2);
      expect(patterns[0]!.pattern.argument).toBe("ls");
      expect(patterns[1]!.pattern.argument).toBe("ls *");
    });

    it("空命令返回空数组", () => {
      expect(suggestPatterns(bashRequest(""))).toEqual([]);
      expect(suggestPatterns(bashRequest("   "))).toEqual([]);
    });

    it("所有候选都标注 tool=bash", () => {
      const patterns = suggestPatterns(bashRequest("npm install express"));
      for (const p of patterns) {
        expect(p.pattern.tool).toBe("bash");
      }
    });
  });

  describe("文件操作", () => {
    it("write 路径产生精确 + 父目录两级", () => {
      const patterns = suggestPatterns(writeRequest("src/foo/bar.ts"));
      expect(patterns).toHaveLength(2);
      expect(patterns[0]!.pattern.argument).toBe("src/foo/bar.ts");
      expect(patterns[1]!.pattern.argument).toBe("src/foo/**");
    });

    it("根目录文件只有一级", () => {
      const patterns = suggestPatterns(writeRequest("README.md"));
      expect(patterns).toHaveLength(1);
      expect(patterns[0]!.pattern.argument).toBe("README.md");
    });

    it("空路径返回空数组", () => {
      const patterns = suggestPatterns({
        tool: "write",
        arguments: {},
        context: { cwd: "/tmp", trust: { kind: "global" }, sessionType: "interactive" },
      });
      expect(patterns).toEqual([]);
    });
  });

  describe("通用工具回退", () => {
    it("未识别的工具产生 catch-all", () => {
      const patterns = suggestPatterns(genericRequest("wechat"));
      expect(patterns).toHaveLength(1);
      expect(patterns[0]!.pattern.tool).toBe("wechat");
      expect(patterns[0]!.pattern.argument).toBe("*");
    });
  });
});

// ─── ConfirmationTracker ───

describe("ConfirmationTracker", () => {
  describe("基本计数", () => {
    it("record 后 getCount 返回累计次数", () => {
      const tracker = new ConfirmationTracker();
      tracker.record(bashRequest("npm install express"), "medium");
      tracker.record(bashRequest("npm install lodash"), "medium");
      tracker.record(bashRequest("npm install foo"), "medium");

      // 三次 npm install ... 应该被同一 key 计数
      expect(tracker.getCount(bashRequest("npm install bar"))).toBe(3);
    });

    it("不同 executable 独立计数", () => {
      const tracker = new ConfirmationTracker();
      tracker.record(bashRequest("npm install express"), "medium");
      tracker.record(bashRequest("yarn add lodash"), "medium");

      expect(tracker.getCount(bashRequest("npm install foo"))).toBe(1);
      expect(tracker.getCount(bashRequest("yarn add bar"))).toBe(1);
    });

    it("空命令不被追踪", () => {
      const tracker = new ConfirmationTracker();
      tracker.record(bashRequest(""), "medium");
      expect(tracker.getCount(bashRequest(""))).toBe(0);
    });
  });

  describe("阈值与风险等级", () => {
    it("low 风险：3 次后建议", () => {
      const tracker = new ConfirmationTracker();
      const req = bashRequest("ls foo");

      expect(tracker.shouldSuggest(req, "low").suggest).toBe(false);
      tracker.record(req, "low");
      tracker.record(req, "low");
      expect(tracker.shouldSuggest(req, "low").suggest).toBe(false);
      tracker.record(req, "low");
      expect(tracker.shouldSuggest(req, "low").suggest).toBe(true);
    });

    it("medium 风险：5 次后建议", () => {
      const tracker = new ConfirmationTracker();
      const req = bashRequest("npm install express");

      for (let i = 0; i < 4; i++) {
        tracker.record(req, "medium");
        expect(tracker.shouldSuggest(req, "medium").suggest).toBe(false);
      }
      tracker.record(req, "medium");
      expect(tracker.shouldSuggest(req, "medium").suggest).toBe(true);
    });

    it("high 风险：10 次后建议", () => {
      const tracker = new ConfirmationTracker();
      const req = bashRequest("sudo apt update");

      for (let i = 0; i < 9; i++) {
        tracker.record(req, "high");
      }
      expect(tracker.shouldSuggest(req, "high").suggest).toBe(false);

      tracker.record(req, "high");
      expect(tracker.shouldSuggest(req, "high").suggest).toBe(true);
    });

    it("critical 风险：永不建议（无论次数）", () => {
      const tracker = new ConfirmationTracker();
      const req = bashRequest("rm -rf /important");

      for (let i = 0; i < 100; i++) {
        tracker.record(req, "critical");
      }
      const status = tracker.shouldSuggest(req, "critical");
      expect(status.suggest).toBe(false);
      expect(status.threshold).toBe(-1);
    });
  });

  describe("shouldSuggest 返回结构", () => {
    it("总是返回候选模式列表（即使 suggest=false）", () => {
      const tracker = new ConfirmationTracker();
      const status = tracker.shouldSuggest(
        bashRequest("npm install express"),
        "medium",
      );
      expect(status.patterns.length).toBeGreaterThan(0);
      expect(status.count).toBe(0);
      expect(status.suggest).toBe(false);
    });

    it("达到阈值时 suggest=true 且 count >= threshold", () => {
      const tracker = new ConfirmationTracker();
      const req = bashRequest("npm install express");
      for (let i = 0; i < 5; i++) tracker.record(req, "medium");

      const status = tracker.shouldSuggest(req, "medium");
      expect(status.suggest).toBe(true);
      expect(status.count).toBeGreaterThanOrEqual(status.threshold);
    });
  });

  describe("reset", () => {
    it("reset(request) 只清除特定模式的计数", () => {
      const tracker = new ConfirmationTracker();
      tracker.record(bashRequest("npm install foo"), "medium");
      tracker.record(bashRequest("yarn add bar"), "medium");

      tracker.reset(bashRequest("npm install baz"));

      expect(tracker.getCount(bashRequest("npm install foo"))).toBe(0);
      expect(tracker.getCount(bashRequest("yarn add bar"))).toBe(1);
    });

    it("reset() 不传参清除所有计数", () => {
      const tracker = new ConfirmationTracker();
      tracker.record(bashRequest("npm install foo"), "medium");
      tracker.record(bashRequest("yarn add bar"), "medium");

      tracker.reset();

      expect(tracker.getCount(bashRequest("npm install foo"))).toBe(0);
      expect(tracker.getCount(bashRequest("yarn add bar"))).toBe(0);
    });
  });

  describe("snapshot", () => {
    it("返回所有追踪条目", () => {
      const tracker = new ConfirmationTracker();
      tracker.record(bashRequest("npm install foo"), "medium");
      tracker.record(bashRequest("npm install bar"), "medium");
      tracker.record(bashRequest("yarn add baz"), "low");

      const snapshot = tracker.snapshot();
      expect(snapshot).toHaveLength(2);
      const npmEntry = snapshot.find((e) => e.key.includes("npm install"));
      expect(npmEntry?.count).toBe(2);
    });
  });

  describe("跨工具", () => {
    it("write 工具的计数与 bash 隔离", () => {
      const tracker = new ConfirmationTracker();
      tracker.record(writeRequest("src/foo.ts"), "medium");
      tracker.record(bashRequest("ls"), "low");

      expect(tracker.getCount(writeRequest("src/bar.ts"))).toBe(1);
      expect(tracker.getCount(bashRequest("ls"))).toBe(1);
    });
  });
});
