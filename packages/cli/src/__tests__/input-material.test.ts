import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { materialTokensFromPastedPaths } from "../input-material-ingest.js";
import {
  InputMaterialRegistry,
  MATERIAL_TOKEN_PATTERN,
} from "../input-material-registry.js";
import { resolveInputMaterials } from "../input-material-resolve.js";
import { stringWidth } from "../tui/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("input materials", () => {
  it("把粘贴的图片路径转换为图片 chip", async () => {
    const root = await makeTempDir();
    const imagePath = path.join(root, "shot.png");
    await fs.writeFile(imagePath, minimalPng(2, 3));
    const registry = new InputMaterialRegistry();

    const token = materialTokensFromPastedPaths(imagePath, registry, {
      workspaceRoot: root,
    });

    expect(token).toContain("[Image #1 · shot.png · 2x3 ·");
    expect(registry.size).toBe(1);
  });

  it("普通文本不被误识别为材料路径", () => {
    const registry = new InputMaterialRegistry();
    expect(
      materialTokensFromPastedPaths("hello world", registry, {
        workspaceRoot: "E:/repo",
      }),
    ).toBeNull();
    expect(registry.size).toBe(0);
  });

  it("图片 chip 解析为结构化 image part", async () => {
    const root = await makeTempDir();
    const imagePath = path.join(root, "shot.png");
    const bytes = minimalPng(1, 1);
    await fs.writeFile(imagePath, bytes);
    const registry = new InputMaterialRegistry();
    const token = materialTokensFromPastedPaths(imagePath, registry, {
      workspaceRoot: root,
    })!;

    const result = await resolveInputMaterials(`看图 ${token}`, registry);

    expect(result.errors).toEqual([]);
    expect(result.input.parts).toHaveLength(2);
    expect(result.input.parts[0]).toEqual({ type: "text", text: "看图 " });
    expect(result.input.parts[1]).toEqual({
      type: "image",
      source: {
        type: "base64",
        mediaType: "image/png",
        data: bytes.toString("base64"),
      },
      name: "shot.png",
      mimeType: "image/png",
      size: bytes.length,
    });
  });

  it("图片扩展名不会绕过文件头嗅探", async () => {
    const root = await makeTempDir();
    const fakeImagePath = path.join(root, "fake.png");
    await fs.writeFile(fakeImagePath, "not an image", "utf-8");
    const registry = new InputMaterialRegistry();

    const token = materialTokensFromPastedPaths(fakeImagePath, registry, {
      workspaceRoot: root,
    });

    expect(token).toContain("[File #1 · fake.png ·");
    const result = await resolveInputMaterials(token!, registry);
    expect(result.input.parts).toEqual([]);
    expect(result.errors[0]).toContain("当前版本尚不能直接发送");
  });

  it("材料源文件提交前消失时返回可恢复错误", async () => {
    const root = await makeTempDir();
    const imagePath = path.join(root, "shot.png");
    await fs.writeFile(imagePath, minimalPng(1, 1));
    const registry = new InputMaterialRegistry();
    const token = materialTokensFromPastedPaths(imagePath, registry, {
      workspaceRoot: root,
    })!;
    await fs.rm(imagePath);

    const result = await resolveInputMaterials(token, registry);

    expect(result.input.parts).toEqual([]);
    expect(result.errors[0]).toContain("文件不可读取");
  });

  it("文本文件 chip 解析为带来源的 text part", async () => {
    const root = await makeTempDir();
    const filePath = path.join(root, "notes.txt");
    await fs.writeFile(filePath, "alpha\nbeta", "utf-8");
    const registry = new InputMaterialRegistry();
    const token = materialTokensFromPastedPaths(filePath, registry, {
      workspaceRoot: root,
    })!;

    const result = await resolveInputMaterials(token, registry);

    expect(result.errors).toEqual([]);
    expect(result.input.parts).toEqual([
      {
        type: "text",
        text: `<file path="${filePath.replace(/\\/g, "/")}">\nalpha\nbeta\n</file>`,
      },
    ]);
  });

  it("非文本普通文件不静默塞进 prompt", async () => {
    const root = await makeTempDir();
    const filePath = path.join(root, "archive.bin");
    await fs.writeFile(filePath, Buffer.from([0, 1, 2, 3]));
    const registry = new InputMaterialRegistry();
    const token = materialTokensFromPastedPaths(filePath, registry, {
      workspaceRoot: root,
    })!;

    const result = await resolveInputMaterials(token, registry);

    expect(result.input.parts).toEqual([]);
    expect(result.errors[0]).toContain("当前版本尚不能直接发送");
  });

  it("长材料 chip 按宽度预算压缩且仍按 id 解析", async () => {
    const root = await makeTempDir();
    const longName = `screen-capture-${"abcdef".repeat(8)}.png`;
    const imagePath = path.join(root, longName);
    const bytes = minimalPng(12, 8);
    await fs.writeFile(imagePath, bytes);
    const registry = new InputMaterialRegistry();
    const token = materialTokensFromPastedPaths(imagePath, registry, {
      workspaceRoot: root,
      tokenMaxWidth: 42,
    })!;

    expect(stringWidth(token)).toBeLessThanOrEqual(42);
    expect(token).toContain("…");
    expect(token).toContain(".png");
    MATERIAL_TOKEN_PATTERN.lastIndex = 0;
    expect(MATERIAL_TOKEN_PATTERN.test(token)).toBe(true);

    const result = await resolveInputMaterials(token, registry);
    expect(result.errors).toEqual([]);
    expect(result.input.parts[0]).toMatchObject({
      type: "image",
      name: longName,
      mimeType: "image/png",
      size: bytes.length,
    });
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zhixing-material-"));
  tempDirs.push(dir);
  return dir;
}

function minimalPng(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
