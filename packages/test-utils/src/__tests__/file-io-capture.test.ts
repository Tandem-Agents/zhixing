import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { captureFileIo } from "../file-io-capture.js";
import { createTempDir } from "../temp-dir.js";

describe("file IO capture scope", () => {
  // 同进程里并行或残留的其他夹具在别的根目录读写，它们不能计入本次计量
  it("counts only reads and writes inside its own root", async () => {
    const root = await createTempDir("io-capture-own");
    const other = await createTempDir("io-capture-other");
    await writeFile(join(root, "inside.txt"), "12345");
    await writeFile(join(other, "outside.txt"), "abcdefgh");
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(join(root, "nested", "deep.txt"), "xyz");
    const io = await captureFileIo(root);

    await readFile(join(other, "outside.txt"));
    await readFile(join(root, "..", other.split(/[\\/]/u).at(-1)!, "outside.txt"));
    const foreign = await open(join(other, "outside.txt"), "r");
    try { await foreign.read(Buffer.alloc(8), 0, 8, 0); } finally { await foreign.close(); }
    await writeFile(join(other, "written.txt"), "ignored");
    expect(io.snapshot()).toMatchObject({ readBytes: 0, reads: 0, writeBytes: 0, writes: 0 });

    await readFile(join(root, "inside.txt"));
    await readFile(pathToFileURL(join(root, "nested", "deep.txt")));
    const own = await open(join(root, "inside.txt"), "r");
    try { await own.read(Buffer.alloc(5), 0, 5, 0); } finally { await own.close(); }
    await writeFile(join(root, "written.txt"), "kept");
    expect(io.snapshot()).toMatchObject({ readBytes: 5 + 3 + 5, reads: 3, writeBytes: 4, writes: 1 });
  });

  // 捕获前打开的句柄不知道路径：读写仍可见并归到 "<unmapped>"，既不被静默排除，也不冒充根内文件
  it("keeps reads through a handle opened before capture visible as unmapped", async () => {
    const root = await createTempDir("io-capture-early-own");
    const other = await createTempDir("io-capture-early-other");
    await writeFile(join(other, "outside.txt"), "abcdefgh");
    const early = await open(join(other, "outside.txt"), "r");
    try {
      const io = await captureFileIo(root, relative => relative);
      await early.read(Buffer.alloc(8), 0, 8, 0);
      expect(io.snapshot()).toMatchObject({ readBytes: 8, reads: 1, byCategory: { "<unmapped>": { readBytes: 8, reads: 1 } } });
    } finally { await early.close(); }
  });
});
