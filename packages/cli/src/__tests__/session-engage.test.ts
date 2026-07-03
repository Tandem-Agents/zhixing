import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InputMaterialRegistry } from "../input-material-registry.js";
import {
  parseSessionSendEngageInput,
  prepareSessionSendEngage,
} from "../session-engage.js";

describe("session.send engage parsing", () => {
  it.each([
    ["@ 审查方案", "审查方案"],
    ["  @ 审查方案", "审查方案"],
    ["请 @ 审查方案", "请 审查方案"],
    ["请 @   审查方案", "请 审查方案"],
    ["先看背景\n@ 审查方案", "先看背景\n审查方案"],
    [
      "关键背景：只能使用方案 A\n@ 审查方案",
      "关键背景：只能使用方案 A\n审查方案",
    ],
  ])("识别有效多视角触发并保留完整问题：%s", (input, question) => {
    expect(parseSessionSendEngageInput(input)).toEqual({
      inputWithoutTrigger: question,
    });
  });

  it.each([
    "@",
    "@   ",
    "前文 @   ",
    "@file:note.md",
    "  @file:note.md",
    "@架构师 审查方案",
    "email@x.com",
    "请@ 审查方案",
    "请 @审查方案",
  ])("拒绝非多视角触发：%s", (input) => {
    expect(parseSessionSendEngageInput(input)).toBeUndefined();
  });

  it("同一消息内的文件引用先解析，再作为多视角问题进入协议", async () => {
    const resolveRefs = vi.fn(async (input: string) => ({
      text: input.replace("@file:note.md", "<file>关键背景</file>"),
      resolvedFiles: ["E:/repo/note.md"],
      errors: [],
    }));

    const result = await prepareSessionSendEngage(
      "@file:note.md\n@ 审查这份文件",
      {
        workspaceRoot: "E:/repo",
        resolveRefs,
      },
    );

    expect(resolveRefs).toHaveBeenCalledWith("@file:note.md\n审查这份文件", {
      workspaceRoot: "E:/repo",
    });
    expect(result?.kind).toBe("ready");
    if (result?.kind !== "ready") throw new Error("expected ready engage");
    expect(result?.engage).toEqual({
      kind: "perspectives",
      question: "<file>关键背景</file>\n审查这份文件",
    });
    expect(result?.preparedQuestion.resolvedFiles).toEqual([
      "E:/repo/note.md",
    ]);
    expect(result?.preparedQuestion.errors).toEqual([]);
  });

  it("文件展开内容里的 @ 文本不会被当作新的触发语法", async () => {
    const resolveRefs = vi.fn(async (input: string) => ({
      text: input.replace("@file:note.md", "<file>\n@ 保持为材料正文\n</file>"),
      resolvedFiles: ["E:/repo/note.md"],
      errors: [],
    }));

    const result = await prepareSessionSendEngage(
      "@file:note.md\n@ 审查材料",
      {
        workspaceRoot: "E:/repo",
        resolveRefs,
      },
    );

    expect(result?.kind).toBe("ready");
    if (result?.kind !== "ready") throw new Error("expected ready engage");
    expect(result?.engage.question).toBe(
      "<file>\n@ 保持为材料正文\n</file>\n审查材料",
    );
  });

  it("文本 File material chip 解析为真实文件内容后进入多视角问题", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "zhixing-engage-"));
    try {
      const filePath = path.join(root, "note.txt");
      const content = "材料正文";
      await fs.writeFile(filePath, content, "utf-8");
      const registry = new InputMaterialRegistry();
      const id = registry.registerLocalFile({
        kind: "file",
        filePath,
        name: "note.txt",
        mimeType: "text/plain",
        byteSize: Buffer.byteLength(content),
      });
      const chip = registry.format(id);

      const result = await prepareSessionSendEngage(`${chip}\n@ 审查这个文件`, {
        workspaceRoot: root,
        materialRegistry: registry,
      });

      expect(result?.kind).toBe("ready");
      if (result?.kind !== "ready") throw new Error("expected ready engage");
      expect(result.engage.question).toBe(
        `<file path="${filePath.replace(/\\/g, "/")}">\n${content}\n</file>\n审查这个文件`,
      );
      expect(result.preparedQuestion.text).toBe(`${chip}\n审查这个文件`);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("非文本材料触发多视角时 fail-closed，避免静默丢失材料", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "zhixing-engage-"));
    try {
      const imagePath = path.join(root, "shot.png");
      const bytes = minimalPng(4, 5);
      await fs.writeFile(imagePath, bytes);
      const registry = new InputMaterialRegistry();
      const id = registry.registerLocalFile({
        kind: "image",
        filePath: imagePath,
        name: "shot.png",
        mimeType: "image/png",
        byteSize: bytes.length,
        image: { width: 4, height: 5 },
      });
      const chip = registry.format(id);

      const result = await prepareSessionSendEngage(`${chip}\n@ 审查这张图`, {
        workspaceRoot: root,
        materialRegistry: registry,
      });

      expect(result).toEqual({
        kind: "invalid",
        question: "审查这张图",
        preparedQuestion: expect.objectContaining({
          text: `${chip}\n审查这张图`,
        }),
        errors: [
          "多视角评议目前只支持文本内容；请将图片转成文字说明，或移除图片后再触发 @。",
        ],
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

function minimalPng(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
