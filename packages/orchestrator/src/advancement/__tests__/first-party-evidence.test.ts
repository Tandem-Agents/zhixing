import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import type { EvidenceRequirementSpec, RunRecordInput } from "@zhixing/core/advancement";
import {
  createFirstPartyEvidenceProvider,
  detectEvidenceCapabilities,
  type GitExecFn,
} from "../first-party-evidence.js";
import type { AdvancementEvidenceCollectionInput } from "../types.js";

function runRecord(): RunRecordInput {
  return {
    timestamp: "2026-01-01T00:02:00.000Z",
    messages: [
      { role: "user", content: [{ type: "text", text: "修测试" }] },
      { role: "assistant", content: [{ type: "text", text: "我已修复完成。" }] },
    ],
  };
}

function collectionInput(
  requirements: readonly EvidenceRequirementSpec[],
): AdvancementEvidenceCollectionInput {
  return {
    sessionId: "adv-1",
    originalUserTask: { parts: [{ type: "text", text: "把测试修到全绿" }] },
    rubric: {
      source: {
        kind: "library",
        rubricId: "rubric-1",
        rubricVersion: "v1",
      },
      title: "验收",
      description: "验收",
      content: {
        passCriteria: [{ id: "pc-1", text: "测试通过" }],
        evidenceRequirements: requirements,
        failureHandling: [{ id: "c", scenario: "未达标", reply: "继续。" }],
      },
      confirmedAt: "2026-01-01T00:01:00.000Z",
      confirmedBy: "user",
    },
    runIndex: 0,
    runRecord: runRecord(),
    requirements,
  };
}

describe("detectEvidenceCapabilities", () => {
  it("git 工作区内 file-diff 进能力集，log / artifact 恒在", async () => {
    const exec: GitExecFn = vi.fn(async () => ({ stdout: "true\n" }));
    const caps = await detectEvidenceCapabilities("/repo", exec);
    expect(caps.independentKinds).toEqual(["file-diff", "log", "artifact"]);
  });

  it("git 不可用时 file-diff 不进能力集", async () => {
    const exec: GitExecFn = vi.fn(async () => {
      throw new Error("git not found");
    });
    const caps = await detectEvidenceCapabilities("/no-repo", exec);
    expect(caps.independentKinds).toEqual(["log", "artifact"]);
  });
});

describe("createFirstPartyEvidenceProvider", () => {
  it("file-diff 经 git 只读命令产出独立证据与触碰文件", async () => {
    const workspace = await createTempDir("first-party-diff");
    const calls: string[][] = [];
    const exec: GitExecFn = async (args) => {
      calls.push([...args]);
      if (args[0] === "status") {
        return { stdout: " M src/a.ts\n?? src/b.ts\n" };
      }
      return { stdout: " src/a.ts | 4 +--\n 2 files changed\n" };
    };
    const provider = createFirstPartyEvidenceProvider({
      workspace,
      gitExec: exec,
    });

    const evidence = await provider.collect(
      collectionInput([
        {
          id: "diff",
          kind: "file-diff",
          description: "核对相关文件变更",
          required: true,
        },
      ]),
    );

    const diff = evidence.find((item) => item.kind === "file-diff");
    expect(diff).toMatchObject({
      requirementId: "diff",
      source: "independent",
      passed: true,
    });
    expect(diff?.refs).toContain("src/a.ts");
    expect(calls.some((args) => args[0] === "status")).toBe(true);
    expect(calls.every((args) => ["status", "diff"].includes(args[0]!))).toBe(
      true,
    );
  });

  it("log 按 locator 定位读取，产出存在性与尾部内容", async () => {
    const workspace = await createTempDir("first-party-log");
    await fs.mkdir(path.join(workspace, "logs"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, "logs", "export.log"),
      "line-1\nline-2\nexport ok\n",
      "utf8",
    );
    const provider = createFirstPartyEvidenceProvider({
      workspace,
      gitExec: async () => ({ stdout: "" }),
    });

    const evidence = await provider.collect(
      collectionInput([
        {
          id: "log",
          kind: "log",
          description: "查看导出日志",
          required: true,
          locator: { paths: ["logs/export.log"] },
        },
      ]),
    );

    const log = evidence.find((item) => item.kind === "log");
    expect(log).toMatchObject({
      requirementId: "log",
      source: "independent",
      passed: true,
      refs: ["logs/export.log"],
    });
    expect(log?.summary).toContain("export ok");
  });

  it("越界 locator 路径按证据缺失丢弃，不读工作区外文件", async () => {
    const outerRoot = await createTempDir("first-party-escape");
    const workspace = path.join(outerRoot, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(outerRoot, "secret.log"), "outside", "utf8");
    const provider = createFirstPartyEvidenceProvider({
      workspace,
      gitExec: async () => ({ stdout: "" }),
    });

    const evidence = await provider.collect(
      collectionInput([
        {
          id: "log",
          kind: "log",
          description: "查看日志",
          required: true,
          locator: { paths: ["../secret.log"] },
        },
      ]),
    );

    expect(evidence.filter((item) => item.kind === "log")).toEqual([]);
  });

  it("test-result 类不产出独立证据（第一级无重跑能力）", async () => {
    const workspace = await createTempDir("first-party-tests");
    const provider = createFirstPartyEvidenceProvider({
      workspace,
      gitExec: async () => ({ stdout: "" }),
    });

    const evidence = await provider.collect(
      collectionInput([
        {
          id: "tests",
          kind: "test-result",
          description: "测试需要通过",
          required: false,
        },
      ]),
    );

    expect(
      evidence.filter((item) => item.source === "independent"),
    ).toEqual([]);
    expect(evidence.some((item) => item.id === "run-final-response")).toBe(true);
  });

  it("无 commit 仓库（unborn HEAD）diff 失败不连累 status，仍产出独立证据", async () => {
    const workspace = await createTempDir("first-party-unborn");
    const exec: GitExecFn = async (args) => {
      if (args[0] === "diff") {
        throw new Error("fatal: ambiguous argument 'HEAD'");
      }
      return { stdout: "?? src/new.ts\n" };
    };
    const provider = createFirstPartyEvidenceProvider({
      workspace,
      gitExec: exec,
    });

    const evidence = await provider.collect(
      collectionInput([
        {
          id: "diff",
          kind: "file-diff",
          description: "核对变更",
          required: true,
        },
      ]),
    );

    const diff = evidence.find((item) => item.kind === "file-diff");
    expect(diff).toMatchObject({ source: "independent", passed: true });
    expect(diff?.refs).toEqual(["src/new.ts"]);
  });

  it("file-diff 的 locator 全部越界时按证据缺失处理，不降级为全工作区", async () => {
    const workspace = await createTempDir("first-party-diff-escape");
    const exec: GitExecFn = vi.fn(async () => ({ stdout: " M src/a.ts\n" }));
    const provider = createFirstPartyEvidenceProvider({
      workspace,
      gitExec: exec,
    });

    const evidence = await provider.collect(
      collectionInput([
        {
          id: "diff",
          kind: "file-diff",
          description: "核对变更",
          required: true,
          locator: { paths: ["../outside"] },
        },
      ]),
    );

    expect(evidence.filter((item) => item.kind === "file-diff")).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });

  it("file-diff 的 locator 部分越界时只按界内路径收窄取证", async () => {
    const workspace = await createTempDir("first-party-diff-partial");
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    const calls: string[][] = [];
    const exec: GitExecFn = async (args) => {
      calls.push([...args]);
      return { stdout: " M src/a.ts\n" };
    };
    const provider = createFirstPartyEvidenceProvider({
      workspace,
      gitExec: exec,
    });

    await provider.collect(
      collectionInput([
        {
          id: "diff",
          kind: "file-diff",
          description: "核对变更",
          required: true,
          locator: { paths: ["src", "../outside"] },
        },
      ]),
    );

    const statusCall = calls.find((args) => args[0] === "status");
    expect(statusCall).toContain("src");
    expect(statusCall).not.toContain("../outside");
  });

  it("file-diff 无 locator 时按执行侧本轮触碰路径收窄", async () => {
    const workspace = await createTempDir("first-party-touched");
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src", "a.ts"), "x", "utf8");
    const calls: string[][] = [];
    const exec: GitExecFn = async (args) => {
      calls.push([...args]);
      return { stdout: " M src/a.ts\n" };
    };
    const provider = createFirstPartyEvidenceProvider({
      workspace,
      gitExec: exec,
    });

    const input = collectionInput([
      {
        id: "diff",
        kind: "file-diff",
        description: "核对变更",
        required: true,
      },
    ]);
    await provider.collect({
      ...input,
      runRecord: {
        timestamp: "2026-01-01T00:02:00.000Z",
        messages: [
          { role: "user", content: [{ type: "text", text: "修一下" }] },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tool-1",
                name: "Edit",
                input: { file_path: "src/a.ts" },
              },
              {
                type: "tool_use",
                id: "tool-2",
                name: "Read",
                input: { file_path: "src/readonly.ts" },
              },
              {
                type: "tool_use",
                id: "tool-3",
                name: "Grep",
                input: { path: "src" },
              },
            ],
          },
        ],
      },
    });

    const statusCall = calls.find((args) => args[0] === "status");
    expect(statusCall).toContain("src/a.ts");
    // 只读与搜索工具的路径不代表变更位置，不得进入收窄范围
    expect(statusCall).not.toContain("src/readonly.ts");
    expect(statusCall?.filter((arg) => arg === "src")).toEqual([]);
  });

  it("artifact 按 locator 产出存在性证据、不读文件内容", async () => {
    const workspace = await createTempDir("first-party-artifact");
    await fs.mkdir(path.join(workspace, "dist"), { recursive: true });
    await fs.writeFile(path.join(workspace, "dist", "app.js"), "bundle", "utf8");
    const provider = createFirstPartyEvidenceProvider({
      workspace,
      gitExec: async () => ({ stdout: "" }),
    });

    const evidence = await provider.collect(
      collectionInput([
        {
          id: "bundle",
          kind: "artifact",
          description: "构建产物存在",
          required: true,
          locator: { paths: ["dist/app.js"] },
        },
      ]),
    );

    const artifact = evidence.find((item) => item.kind === "artifact");
    expect(artifact).toMatchObject({
      source: "independent",
      passed: true,
      refs: ["dist/app.js"],
    });
    expect(artifact?.summary).not.toContain("bundle");
  });

  it("git 读取失败时 file-diff 证据缺失而不抛错", async () => {
    const workspace = await createTempDir("first-party-git-fail");
    const provider = createFirstPartyEvidenceProvider({
      workspace,
      gitExec: async () => {
        throw new Error("boom");
      },
    });

    const evidence = await provider.collect(
      collectionInput([
        {
          id: "diff",
          kind: "file-diff",
          description: "核对变更",
          required: true,
        },
      ]),
    );

    expect(evidence.filter((item) => item.kind === "file-diff")).toEqual([]);
  });
});
