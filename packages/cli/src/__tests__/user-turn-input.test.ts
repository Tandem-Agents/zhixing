import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { InputMaterialRegistry } from "../input-material-registry.js";
import { prepareUserTurnInput } from "../user-turn-input.js";

describe("prepareUserTurnInput", () => {
  it("非空正文保留首尾空白", async () => {
    await expect(
      prepareUserTurnInput("  hello\n", { workspaceRoot: "E:/repo" }),
    ).resolves.toEqual({
      text: "  hello\n",
      input: { parts: [{ type: "text", text: "  hello\n" }] },
      resolvedFiles: [],
      errors: [],
    });
  });

  it("纯空白输入按空输入处理", async () => {
    await expect(
      prepareUserTurnInput(" \t\n ", { workspaceRoot: "E:/repo" }),
    ).resolves.toBeNull();
  });

  it("@file 引用只替换引用片段，保留周围空白", async () => {
    const resolveRefs = vi.fn(async (input: string) => ({
      text: input.replace("@file:a.txt", "<file>A</file>"),
      resolvedFiles: ["E:/repo/a.txt"],
      errors: ["warn"],
    }));

    const result = await prepareUserTurnInput("  @file:a.txt  ", {
      workspaceRoot: "E:/repo",
      resolveRefs,
    });

    expect(resolveRefs).toHaveBeenCalledWith("  @file:a.txt  ", {
      workspaceRoot: "E:/repo",
    });
    expect(result).toEqual({
      text: "  <file>A</file>  ",
      input: { parts: [{ type: "text", text: "  <file>A</file>  " }] },
      resolvedFiles: ["E:/repo/a.txt"],
      errors: ["warn"],
    });
  });

  it("@file 展开正文里的 material chip 字面量保持文本", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "zhixing-user-input-"));
    try {
      const imagePath = path.join(root, "shot.png");
      await fs.writeFile(imagePath, minimalPng(4, 5));
      const registry = new InputMaterialRegistry();
      registry.registerLocalFile({
        kind: "image",
        filePath: imagePath,
        name: "shot.png",
        mimeType: "image/png",
        byteSize: 24,
        image: { width: 4, height: 5 },
      });
      const fileText = `<file path="${path.join(root, "note.md").replace(/\\/g, "/")}">\n[Image #1 · arbitrary literal]\n</file>`;
      const resolveRefs = vi.fn(async () => ({
        text: fileText,
        resolvedFiles: [path.join(root, "note.md")],
        errors: [],
      }));

      const result = await prepareUserTurnInput("@file:note.md", {
        workspaceRoot: root,
        materialRegistry: registry,
        resolveRefs,
      });

      expect(result?.text).toBe(fileText);
      expect(result?.input.parts).toEqual([{ type: "text", text: fileText }]);
      expect(result?.resolvedFiles).toEqual([path.join(root, "note.md")]);
      expect(result?.errors).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("真实 material chip 与 @file 展开正文按来源分别处理", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "zhixing-user-input-"));
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
      const fileText = `<file path="${path.join(root, "note.md").replace(/\\/g, "/")}">\n[Image #1 · arbitrary literal]\n</file>`;
      const resolveRefs = vi.fn(async (input: string) => ({
        text: input.replace("@file:note.md", fileText),
        resolvedFiles: [path.join(root, "note.md")],
        errors: [],
      }));

      const result = await prepareUserTurnInput(`${chip} @file:note.md`, {
        workspaceRoot: root,
        materialRegistry: registry,
        resolveRefs,
      });

      expect(result?.text).toBe(`${chip} ${fileText}`);
      expect(result?.input.parts).toEqual([
        {
          type: "image",
          source: {
            type: "base64",
            mediaType: "image/png",
            data: bytes.toString("base64"),
          },
          name: "shot.png",
          mimeType: "image/png",
          size: bytes.length,
        },
        { type: "text", text: ` ${fileText}` },
      ]);
      expect(result?.resolvedFiles).toEqual([path.join(root, "note.md")]);
      expect(result?.errors).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("material chip 标签与 registry 类型不一致时保留为文本", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "zhixing-user-input-"));
    try {
      const imagePath = path.join(root, "shot.png");
      await fs.writeFile(imagePath, minimalPng(4, 5));
      const registry = new InputMaterialRegistry();
      registry.registerLocalFile({
        kind: "image",
        filePath: imagePath,
        name: "shot.png",
        mimeType: "image/png",
        byteSize: 24,
        image: { width: 4, height: 5 },
      });

      const result = await prepareUserTurnInput("[File #1 · arbitrary literal]", {
        workspaceRoot: root,
        materialRegistry: registry,
      });

      expect(result?.input.parts).toEqual([
        { type: "text", text: "[File #1 · arbitrary literal]" },
      ]);
      expect(result?.errors).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("未由 registry 格式化过的同 id chip 字面量保持文本", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "zhixing-user-input-"));
    try {
      const imagePath = path.join(root, "shot.png");
      await fs.writeFile(imagePath, minimalPng(4, 5));
      const registry = new InputMaterialRegistry();
      registry.registerLocalFile({
        kind: "image",
        filePath: imagePath,
        name: "shot.png",
        mimeType: "image/png",
        byteSize: 24,
        image: { width: 4, height: 5 },
      });

      const result = await prepareUserTurnInput(
        "[Image #1 · arbitrary literal]",
        {
          workspaceRoot: root,
          materialRegistry: registry,
        },
      );

      expect(result?.input.parts).toEqual([
        { type: "text", text: "[Image #1 · arbitrary literal]" },
      ]);
      expect(result?.errors).toEqual([]);
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
