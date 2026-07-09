import { describe, expect, it } from "vitest";
import path from "node:path";

import {
  DEFAULT_GUIDANCE_SCOPES,
  loadLayeredGuidance,
  type GuidanceWarningInput,
  type ReadGuidanceFileInput,
} from "../layered-guidance.js";

describe("loadLayeredGuidance", () => {
  it("按全局到工作场景的顺序渲染裸 payload", async () => {
    const globalPath = path.join("/home", "ZHIXING.md");
    const workscenePath = path.join("/work", "ZHIXING.md");
    const contentByPath = new Map([
      [globalPath, "全局内容"],
      [workscenePath, "场景内容"],
    ]);

    const payload = await loadLayeredGuidance({
      roots: { homeDir: "/home", workdir: "/work" },
      readGuidanceFile: async ({ path }) => contentByPath.get(path) ?? null,
      reportWarning: () => {},
    });

    expect(payload).toBe(
      [
        "# 全局约定",
        "scope: global",
        "source: ZHIXING_HOME/ZHIXING.md",
        "全局内容",
        "",
        "# 工作场景约定",
        "scope: workscene",
        "source: workdir/ZHIXING.md",
        "场景内容",
      ].join("\n"),
    );
  });

  it("缺文件、空文件与缺 workdir 均跳过，全部为空时返回 null", async () => {
    await expect(
      loadLayeredGuidance({
        roots: { homeDir: "/home" },
        readGuidanceFile: async () => null,
        reportWarning: () => {},
      }),
    ).resolves.toBeNull();

    await expect(
      loadLayeredGuidance({
        roots: { homeDir: "/home", workdir: "/work" },
        readGuidanceFile: async ({ path }) =>
          path === pathJoin("/home", "ZHIXING.md") ? "  \n\t" : null,
        reportWarning: () => {},
      }),
    ).resolves.toBeNull();
  });

  it("读取失败按层降级并上报诊断", async () => {
    const warnings: GuidanceWarningInput[] = [];

    const payload = await loadLayeredGuidance({
      roots: { homeDir: "/home", workdir: "/work" },
      readGuidanceFile: async ({ path }) => {
        if (path === pathJoin("/home", "ZHIXING.md")) {
          throw new Error("permission denied");
        }
        return "场景内容";
      },
      reportWarning: (event) => warnings.push(event),
    });

    expect(payload).toContain("场景内容");
    expect(payload).not.toContain("全局内容");
    expect(warnings).toEqual([{ message: "全局约定读取失败：permission denied" }]);
  });

  it("读取边界上报的 warning 会带上 scope label，便于定位降级来源", async () => {
    const warnings: GuidanceWarningInput[] = [];

    const payload = await loadLayeredGuidance({
      roots: { homeDir: "/home", workdir: "/work" },
      readGuidanceFile: async ({ path, reportWarning }) => {
        if (path === pathJoin("/home", "ZHIXING.md")) {
          reportWarning({ message: "permission denied at /safe/home/ZHIXING.md" });
          return null;
        }
        return "场景内容";
      },
      reportWarning: (event) => warnings.push(event),
    });

    expect(payload).toContain("场景内容");
    expect(warnings).toEqual([
      { message: "全局约定：permission denied at /safe/home/ZHIXING.md" },
    ]);
  });

  it("不截断非空内容，且发送 payload 不包含物理路径", async () => {
    const longContent = "规则\n".repeat(2_000);
    const physicalPath = "C:\\Users\\me\\.zhixing\\ZHIXING.md";

    const payload = await loadLayeredGuidance({
      roots: { homeDir: "C:\\Users\\me\\.zhixing" },
      readGuidanceFile: async () => longContent,
      reportWarning: () => {},
    });

    expect(payload).toContain(longContent);
    expect(payload).not.toContain(physicalPath);
    expect(payload).toContain("source: ZHIXING_HOME/ZHIXING.md");
  });

  it("把 scopeRoot 与 path 原样交给注入式读取边界", async () => {
    const calls: ReadGuidanceFileInput[] = [];

    await loadLayeredGuidance({
      roots: { homeDir: "/home", workdir: "/work" },
      readGuidanceFile: async (input) => {
        calls.push(input);
        return null;
      },
      reportWarning: () => {},
    });

    expect(
      calls.map((call) => ({ scopeRoot: call.scopeRoot, path: call.path })),
    ).toEqual([
      { scopeRoot: "/home", path: pathJoin("/home", "ZHIXING.md") },
      { scopeRoot: "/work", path: pathJoin("/work", "ZHIXING.md") },
    ]);
  });

  it("默认 scope 链只声明逻辑 source，不暴露绝对路径", () => {
    expect(DEFAULT_GUIDANCE_SCOPES.map((scope) => scope.source)).toEqual([
      "ZHIXING_HOME/ZHIXING.md",
      "workdir/ZHIXING.md",
    ]);
  });
});

function pathJoin(...parts: string[]): string {
  return path.join(...parts);
}
