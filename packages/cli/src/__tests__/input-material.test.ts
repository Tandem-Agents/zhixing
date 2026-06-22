import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ingestPastedMaterials } from "../input-material-ingest.js";
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

    const token = ingestMaterialToken(imagePath, registry, {
      workspaceRoot: root,
    });

    expect(token).toContain("[Image #1 · shot.png · 2x3 ·");
    expect(registry.size).toBe(1);
  });

  it("普通文本不被误识别为材料路径", () => {
    const registry = new InputMaterialRegistry();
    expect(
      ingestPastedMaterials("hello world", registry, {
        workspaceRoot: "E:/repo",
      }),
    ).toEqual({ kind: "not-material" });
    expect(registry.size).toBe(0);
  });

  it("普通 URL 不被误识别为失败材料路径", () => {
    const registry = new InputMaterialRegistry();
    const result = ingestPastedMaterials("https://example.com/shot.png", registry, {
      workspaceRoot: "E:/repo",
    });

    expect(result).toEqual({ kind: "not-material" });
    expect(registry.size).toBe(0);
  });

  it("普通引用文本不因引号被误识别为失败材料路径", () => {
    const registry = new InputMaterialRegistry();
    const result = ingestPastedMaterials('"hello world"', registry, {
      workspaceRoot: "E:/repo",
    });

    expect(result).toEqual({ kind: "not-material" });
    expect(registry.size).toBe(0);
  });

  it("含斜杠的普通代码和文本不被材料采集吞行", () => {
    const registry = new InputMaterialRegistry();
    const code = [
      "function f() {",
      "  return a / b;",
      "}",
      "// see src/main.ts",
      "const x = 1;",
    ].join("\n");

    expect(
      ingestPastedMaterials(code, registry, {
        workspaceRoot: "E:/repo",
      }),
    ).toEqual({ kind: "not-material" });
    expect(
      ingestPastedMaterials("hello\nfoo/bar\nbye", registry, {
        workspaceRoot: "E:/repo",
      }),
    ).toEqual({ kind: "not-material" });
    expect(registry.size).toBe(0);
  });

  it("import、日期和 URL 等普通斜杠文本不触发材料模式", () => {
    const registry = new InputMaterialRegistry();
    for (const content of [
      'import x from "./foo/bar";',
      "2026/06/22",
      "https://example.com/shot.png",
      "file:///tmp/shot.png",
    ]) {
      expect(
        ingestPastedMaterials(content, registry, {
          workspaceRoot: "E:/repo",
        }),
      ).toEqual({ kind: "not-material" });
    }
    expect(registry.size).toBe(0);
  });

  it("强路径与弱候选混排时整体按普通文本保留", async () => {
    const root = await makeTempDir();
    const imagePath = path.join(root, "shot.png");
    const missingInput = "missing.png";
    await fs.writeFile(imagePath, minimalPng(2, 3));
    const registry = new InputMaterialRegistry();

    const result = ingestPastedMaterials(`${imagePath}\n${missingInput}`, registry, {
      workspaceRoot: root,
    });

    expect(result).toEqual({ kind: "not-material" });
    expect(registry.size).toBe(0);
  });

  it("强路径与普通斜杠文本混排时整体按普通文本保留", async () => {
    const root = await makeTempDir();
    const imagePath = path.join(root, "shot.png");
    await fs.writeFile(imagePath, minimalPng(2, 3));
    const registry = new InputMaterialRegistry();

    const result = ingestPastedMaterials(
      `${imagePath}\nTODO/FIXME\nconfig.json\nbye`,
      registry,
      { workspaceRoot: root },
    );

    expect(result).toEqual({ kind: "not-material" });
    expect(registry.size).toBe(0);
  });

  it("批量材料强路径部分失败时保留成功材料并返回诊断", async () => {
    const root = await makeTempDir();
    const imagePath = path.join(root, "shot.png");
    const missingInput = "./missing.png";
    await fs.writeFile(imagePath, minimalPng(2, 3));
    const registry = new InputMaterialRegistry();

    const result = ingestPastedMaterials(`${imagePath}\n${missingInput}`, registry, {
      workspaceRoot: root,
    });

    expect(result.kind).toBe("ingested");
    if (result.kind === "ingested") {
      expect(result.insertText).toContain("[Image #1 · shot.png · 2x3 ·");
      expect(result.insertText).toContain(missingInput);
      expect(result.diagnostics).toEqual([
        {
          input: missingInput,
          filePath: path.join(root, "missing.png"),
          reason: "unreadable",
          message: "未添加为材料，原文已保留：文件不存在或不可读取",
        },
      ]);
    }
    expect(registry.size).toBe(1);
  });

  it("无显式前缀的缺失文件名按普通文本保留", async () => {
    const root = await makeTempDir();
    const registry = new InputMaterialRegistry();

    const result = ingestPastedMaterials("missing.png", registry, {
      workspaceRoot: root,
    });

    expect(result).toEqual({ kind: "not-material" });
    expect(registry.size).toBe(0);
  });

  it("无显式前缀的已存在文件名按普通文本保留", async () => {
    const root = await makeTempDir();
    await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf-8");
    await fs.writeFile(path.join(root, "tsconfig.json"), "{}\n", "utf-8");
    const registry = new InputMaterialRegistry();

    const result = ingestPastedMaterials("package.json\ntsconfig.json", registry, {
      workspaceRoot: root,
    });

    expect(result).toEqual({ kind: "not-material" });
    expect(registry.size).toBe(0);
  });

  it("普通笔记里的已存在裸文件名不被静默采集", async () => {
    const root = await makeTempDir();
    await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf-8");
    const registry = new InputMaterialRegistry();

    const result = ingestPastedMaterials(
      "本周计划\npackage.json\n记得测试",
      registry,
      { workspaceRoot: root },
    );

    expect(result).toEqual({ kind: "not-material" });
    expect(registry.size).toBe(0);
  });

  it("无显式前缀的已存在相对片段按普通文本保留", async () => {
    const root = await makeTempDir();
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "main.ts"), "export {};\n", "utf-8");
    const registry = new InputMaterialRegistry();

    const result = ingestPastedMaterials("src/main.ts", registry, {
      workspaceRoot: root,
    });

    expect(result).toEqual({ kind: "not-material" });
    expect(registry.size).toBe(0);
  });

  it("明确路径全部失败时保留原文并返回诊断", async () => {
    const root = await makeTempDir();
    const registry = new InputMaterialRegistry();

    const result = ingestPastedMaterials("./missing.png", registry, {
      workspaceRoot: root,
    });

    expect(result.kind).toBe("ingested");
    if (result.kind === "ingested") {
      expect(result.insertText).toBe("./missing.png");
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]).toMatchObject({
        input: "./missing.png",
        filePath: path.join(root, "missing.png"),
        reason: "unreadable",
        message: "未添加为材料，原文已保留：文件不存在或不可读取",
      });
    }
    expect(registry.size).toBe(0);
  });

  it("明确相对路径成功时仍生成文件材料", async () => {
    const root = await makeTempDir();
    await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf-8");
    const registry = new InputMaterialRegistry();

    const result = ingestPastedMaterials("./package.json", registry, {
      workspaceRoot: root,
    });

    expect(result.kind).toBe("ingested");
    if (result.kind === "ingested") {
      expect(result.insertText).toContain("[File #1 · package.json ·");
      expect(result.diagnostics).toEqual([]);
    }
    expect(registry.size).toBe(1);
  });

  it("纯路径批次支持多个材料按顺序生成 chip", async () => {
    const root = await makeTempDir();
    await fs.writeFile(path.join(root, "shot.png"), minimalPng(2, 3));
    await fs.writeFile(path.join(root, "note.txt"), "hello\n", "utf-8");
    const registry = new InputMaterialRegistry();

    const result = ingestPastedMaterials("./shot.png\n./note.txt", registry, {
      workspaceRoot: root,
    });

    expect(result.kind).toBe("ingested");
    if (result.kind === "ingested") {
      expect(result.insertText).toMatch(
        /^\[Image #1 · shot\.png · 2x3 · .+\]\n\[File #2 · note\.txt · .+\]$/,
      );
      expect(result.diagnostics).toEqual([]);
    }
    expect(registry.size).toBe(2);
  });

  it("纯路径批次部分失败时保留失败原文并返回诊断", async () => {
    const root = await makeTempDir();
    await fs.writeFile(path.join(root, "shot.png"), minimalPng(2, 3));
    const registry = new InputMaterialRegistry();

    const result = ingestPastedMaterials("./shot.png\n./missing.png", registry, {
      workspaceRoot: root,
    });

    expect(result.kind).toBe("ingested");
    if (result.kind === "ingested") {
      expect(result.insertText).toContain("[Image #1 · shot.png · 2x3 ·");
      expect(result.insertText).toContain("./missing.png");
      expect(result.diagnostics).toEqual([
        {
          input: "./missing.png",
          filePath: path.join(root, "missing.png"),
          reason: "unreadable",
          message: "未添加为材料，原文已保留：文件不存在或不可读取",
        },
      ]);
    }
    expect(registry.size).toBe(1);
  });

  it("源码位置按普通文本保留", async () => {
    const root = await makeTempDir();
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "main.ts"), "export {};\n", "utf-8");
    const absoluteLocation = `${path.join(root, "src", "main.ts")}:12:3`;

    for (const content of [
      "./src/main.ts:12",
      "./src/main.ts:12:3",
      '"./src/main.ts:12:3"',
      absoluteLocation,
      `"${absoluteLocation}"`,
      "src/main.ts:12:3",
      '"src/main.ts:12:3"',
      "src/main.ts(12,3)",
      '"src/main.ts(12,3)"',
    ]) {
      const registry = new InputMaterialRegistry();
      expect(
        ingestPastedMaterials(content, registry, { workspaceRoot: root }),
      ).toEqual({ kind: "not-material" });
      expect(registry.size).toBe(0);
    }
  });

  it("未加引号的含空白强路径按命令文本保留", async () => {
    const root = await makeTempDir();
    await fs.writeFile(path.join(root, "build.sh"), "echo build\n", "utf-8");
    const registry = new InputMaterialRegistry();

    const result = ingestPastedMaterials("./build.sh --prod", registry, {
      workspaceRoot: root,
    });

    expect(result).toEqual({ kind: "not-material" });
    expect(registry.size).toBe(0);
  });

  it("带空格路径整行加引号时仍生成文件材料", async () => {
    const root = await makeTempDir();
    await fs.writeFile(path.join(root, "a b.txt"), "hello", "utf-8");
    const registry = new InputMaterialRegistry();

    const result = ingestPastedMaterials('"./a b.txt"', registry, {
      workspaceRoot: root,
    });

    expect(result.kind).toBe("ingested");
    if (result.kind === "ingested") {
      expect(result.insertText).toContain("[File #1 · a b.txt ·");
      expect(result.diagnostics).toEqual([]);
    }
    expect(registry.size).toBe(1);
  });

  it("POSIX 风格转义空格路径生成文件材料", async () => {
    const root = await makeTempDir();
    await fs.writeFile(path.join(root, "a b.txt"), "hello", "utf-8");
    const registry = new InputMaterialRegistry();

    const result = ingestPastedMaterials("./a\\ b.txt", registry, {
      workspaceRoot: root,
    });

    expect(result.kind).toBe("ingested");
    if (result.kind === "ingested") {
      expect(result.insertText).toContain("[File #1 · a b.txt ·");
      expect(result.diagnostics).toEqual([]);
    }
    expect(registry.size).toBe(1);
  });

  it("POSIX shell 转义路径生成文件材料", async () => {
    const root = await makeTempDir();
    const cases = [
      { input: "./a\\ \\(1\\).txt", name: "a (1).txt" },
      { input: "./a\\&b.txt", name: "a&b.txt" },
      { input: "./a\\#b.txt", name: "a#b.txt" },
      { input: "./a\\;b.txt", name: "a;b.txt" },
      { input: "./a\\ b\\&c.txt", name: "a b&c.txt" },
    ];
    for (const item of cases) {
      await fs.writeFile(path.join(root, item.name), "hello", "utf-8");
      const registry = new InputMaterialRegistry();

      const result = ingestPastedMaterials(item.input, registry, {
        workspaceRoot: root,
      });

      expect(result.kind).toBe("ingested");
      if (result.kind === "ingested") {
        expect(result.insertText).toContain(`[File #1 · ${item.name} ·`);
        expect(result.diagnostics).toEqual([]);
      }
      expect(registry.size).toBe(1);
    }
  });

  it("同一行多个 POSIX 风格转义空格路径生成有序材料 chip", async () => {
    const root = await makeTempDir();
    await fs.writeFile(path.join(root, "a b.txt"), "hello", "utf-8");
    await fs.writeFile(path.join(root, "c d.txt"), "world", "utf-8");
    const registry = new InputMaterialRegistry();

    const result = ingestPastedMaterials("./a\\ b.txt ./c\\ d.txt", registry, {
      workspaceRoot: root,
    });

    expect(result.kind).toBe("ingested");
    if (result.kind === "ingested") {
      expect(result.insertText).toMatch(
        /^\[File #1 · a b\.txt · .+\]\n\[File #2 · c d\.txt · .+\]$/,
      );
      expect(result.diagnostics).toEqual([]);
    }
    expect(registry.size).toBe(2);
  });

  it("同一行多个 POSIX shell 转义路径生成有序材料 chip", async () => {
    const root = await makeTempDir();
    await fs.writeFile(path.join(root, "a&b.txt"), "hello", "utf-8");
    await fs.writeFile(path.join(root, "c#d.txt"), "world", "utf-8");
    const registry = new InputMaterialRegistry();

    const result = ingestPastedMaterials("./a\\&b.txt ./c\\#d.txt", registry, {
      workspaceRoot: root,
    });

    expect(result.kind).toBe("ingested");
    if (result.kind === "ingested") {
      expect(result.insertText).toMatch(
        /^\[File #1 · a&b\.txt · .+\]\n\[File #2 · c#d\.txt · .+\]$/,
      );
      expect(result.diagnostics).toEqual([]);
    }
    expect(registry.size).toBe(2);
  });

  it("同一行转义空格路径与 quoted path 混排时生成有序材料 chip", async () => {
    const root = await makeTempDir();
    await fs.writeFile(path.join(root, "a b.txt"), "hello", "utf-8");
    await fs.writeFile(path.join(root, "c d.txt"), "world", "utf-8");
    const registry = new InputMaterialRegistry();

    const result = ingestPastedMaterials('./a\\ b.txt "./c d.txt"', registry, {
      workspaceRoot: root,
    });

    expect(result.kind).toBe("ingested");
    if (result.kind === "ingested") {
      expect(result.insertText).toMatch(
        /^\[File #1 · a b\.txt · .+\]\n\[File #2 · c d\.txt · .+\]$/,
      );
      expect(result.diagnostics).toEqual([]);
    }
    expect(registry.size).toBe(2);
  });

  it("同一行多个 quoted path 生成有序材料 chip", async () => {
    const root = await makeTempDir();
    const firstPath = path.join(root, "shot.png");
    const secondPath = path.join(root, "note.txt");
    await fs.writeFile(firstPath, minimalPng(2, 3));
    await fs.writeFile(secondPath, "hello\n", "utf-8");
    const registry = new InputMaterialRegistry();

    const result = ingestPastedMaterials(`"${firstPath}" "${secondPath}"`, registry, {
      workspaceRoot: root,
    });

    expect(result.kind).toBe("ingested");
    if (result.kind === "ingested") {
      expect(result.insertText).toMatch(
        /^\[Image #1 · shot\.png · 2x3 · .+\]\n\[File #2 · note\.txt · .+\]$/,
      );
      expect(result.diagnostics).toEqual([]);
    }
    expect(registry.size).toBe(2);
  });

  it("同一行 quoted path 部分失败时保留失败 token 并返回诊断", async () => {
    const root = await makeTempDir();
    const imagePath = path.join(root, "shot.png");
    await fs.writeFile(imagePath, minimalPng(2, 3));
    const registry = new InputMaterialRegistry();

    const result = ingestPastedMaterials(`"${imagePath}" "./missing.png"`, registry, {
      workspaceRoot: root,
    });

    expect(result.kind).toBe("ingested");
    if (result.kind === "ingested") {
      expect(result.insertText).toContain("[Image #1 · shot.png · 2x3 ·");
      expect(result.insertText).toContain('"./missing.png"');
      expect(result.diagnostics).toEqual([
        {
          input: "./missing.png",
          filePath: path.join(root, "missing.png"),
          reason: "unreadable",
          message: "未添加为材料，原文已保留：文件不存在或不可读取",
        },
      ]);
    }
    expect(registry.size).toBe(1);
  });

  it("同一行多个未加引号裸路径按普通文本保留", async () => {
    const root = await makeTempDir();
    await fs.writeFile(path.join(root, "shot.png"), minimalPng(2, 3));
    await fs.writeFile(path.join(root, "note.txt"), "hello\n", "utf-8");
    const registry = new InputMaterialRegistry();

    const result = ingestPastedMaterials("./shot.png ./note.txt", registry, {
      workspaceRoot: root,
    });

    expect(result).toEqual({ kind: "not-material" });
    expect(registry.size).toBe(0);
  });

  it("命令里的 POSIX 转义路径按普通文本保留", async () => {
    const root = await makeTempDir();
    await fs.writeFile(path.join(root, "a b.txt"), "hello", "utf-8");
    await fs.writeFile(path.join(root, "a&b.txt"), "hello", "utf-8");

    for (const content of ["echo ./a\\ b.txt", "echo ./a\\&b.txt"]) {
      const registry = new InputMaterialRegistry();
      const result = ingestPastedMaterials(content, registry, {
        workspaceRoot: root,
      });

      expect(result).toEqual({ kind: "not-material" });
      expect(registry.size).toBe(0);
    }
  });

  it("Windows 反斜杠路径不被 POSIX shell 转义改写", () => {
    const registry = new InputMaterialRegistry();
    const input = "C:\\Users\\me\\a\\&b.txt";

    const result = ingestPastedMaterials(input, registry, {
      workspaceRoot: "E:/repo",
    });

    expect(result.kind).toBe("ingested");
    if (result.kind === "ingested") {
      expect(result.insertText).toBe(input);
      expect(result.diagnostics[0]?.input).toBe(input);
    }
    expect(registry.size).toBe(0);
  });

  it("未加引号 Windows 风格带空格路径按普通文本保留", async () => {
    const registry = new InputMaterialRegistry();

    const result = ingestPastedMaterials("C:\\Users\\me\\a b.txt", registry, {
      workspaceRoot: "E:/repo",
    });

    expect(result).toEqual({ kind: "not-material" });
    expect(registry.size).toBe(0);
  });

  it("强路径材料与裸候选文件名混排时整体按普通文本保留", async () => {
    const root = await makeTempDir();
    await fs.writeFile(path.join(root, "package.json"), "{}\n", "utf-8");
    await fs.writeFile(path.join(root, "README.md"), "# demo\n", "utf-8");
    const registry = new InputMaterialRegistry();

    const result = ingestPastedMaterials(
      "./package.json\nREADME.md\nbye",
      registry,
      { workspaceRoot: root },
    );

    expect(result).toEqual({ kind: "not-material" });
    expect(registry.size).toBe(0);
  });

  it("同一次粘贴里的说明文字与强路径整体按普通文本保留", async () => {
    const root = await makeTempDir();
    const imagePath = path.join(root, "shot.png");
    await fs.writeFile(imagePath, minimalPng(2, 3));
    const registry = new InputMaterialRegistry();

    const result = ingestPastedMaterials(
      `请看这张图\n${imagePath}\n谢谢`,
      registry,
      { workspaceRoot: root },
    );

    expect(result).toEqual({ kind: "not-material" });
    expect(registry.size).toBe(0);
  });

  it("目录路径作为明确材料失败返回诊断", async () => {
    const root = await makeTempDir();
    const dirPath = path.join(root, "assets");
    await fs.mkdir(dirPath);
    const registry = new InputMaterialRegistry();

    const result = ingestPastedMaterials(dirPath, registry, {
      workspaceRoot: root,
    });

    expect(result.kind).toBe("ingested");
    if (result.kind === "ingested") {
      expect(result.insertText).toBe(dirPath);
      expect(result.diagnostics).toEqual([
        {
          input: dirPath,
          filePath: dirPath,
          reason: "not-file",
          message: "未添加为材料，原文已保留：不是普通文件",
        },
      ]);
    }
    expect(registry.size).toBe(0);
  });

  it("图片 chip 解析为结构化 image part", async () => {
    const root = await makeTempDir();
    const imagePath = path.join(root, "shot.png");
    const bytes = minimalPng(1, 1);
    await fs.writeFile(imagePath, bytes);
    const registry = new InputMaterialRegistry();
    const token = ingestMaterialToken(imagePath, registry, {
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

    const token = ingestMaterialToken(fakeImagePath, registry, {
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
    const token = ingestMaterialToken(imagePath, registry, {
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
    const token = ingestMaterialToken(filePath, registry, {
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
    const token = ingestMaterialToken(filePath, registry, {
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
    const token = ingestMaterialToken(imagePath, registry, {
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

function ingestMaterialToken(
  content: string,
  registry: InputMaterialRegistry,
  options: Parameters<typeof ingestPastedMaterials>[2],
): string {
  const result = ingestPastedMaterials(content, registry, options);
  expect(result.kind).toBe("ingested");
  if (result.kind !== "ingested") return "";
  expect(result.diagnostics).toEqual([]);
  return result.insertText;
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
