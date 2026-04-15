/**
 * fuzzy-index.ts 单元测试
 *
 * 覆盖：
 *   - 同一 commands 数组引用多次调用返回同一 Fuse 实例（缓存命中）
 *   - 不同 commands 数组返回不同 Fuse 实例
 *   - Fuse 权重 + threshold 的行为 —— 基础 smoke
 *   - CommandIndexItem 的 nameParts / descriptionKey 构造正确
 *   - 别名被 Fuse 索引到
 */

import { describe, expect, it } from "vitest";
import { getCommandFuse } from "../fuzzy-index.js";
import type { CommandDef } from "../types.js";

function makeCmd(partial: Partial<CommandDef> & Pick<CommandDef, "id" | "name">): CommandDef {
  return {
    description: partial.description ?? "test",
    category: partial.category ?? "info",
    execution: partial.execution ?? "local",
    ...partial,
  };
}

describe("getCommandFuse — 缓存", () => {
  it("同一数组引用多次调用返回同一对象", () => {
    const commands: readonly CommandDef[] = [
      makeCmd({ id: "a:b", name: "a" }),
      makeCmd({ id: "b:b", name: "b" }),
    ];
    const first = getCommandFuse(commands);
    const second = getCommandFuse(commands);
    expect(second).toBe(first);
    expect(second.fuse).toBe(first.fuse);
    expect(second.items).toBe(first.items);
  });

  it("不同数组返回不同对象", () => {
    const commandsA: readonly CommandDef[] = [
      makeCmd({ id: "a:b", name: "a" }),
    ];
    const commandsB: readonly CommandDef[] = [
      makeCmd({ id: "a:b", name: "a" }),
    ];
    const first = getCommandFuse(commandsA);
    const second = getCommandFuse(commandsB);
    expect(second).not.toBe(first);
  });
});

describe("getCommandFuse — 索引项构造", () => {
  it("nameParts 按 [:_-] 切分（仅多段时填充）", () => {
    const commands: readonly CommandDef[] = [
      makeCmd({ id: "single:b", name: "single" }),
      makeCmd({ id: "add-dir:b", name: "add-dir" }),
      makeCmd({ id: "ab_cd_ef:b", name: "ab_cd_ef" }),
      makeCmd({ id: "name:part:b", name: "name:part" }),
    ];
    const { items } = getCommandFuse(commands);
    expect(items[0]!.nameParts).toEqual([]); // 单段
    expect(items[1]!.nameParts).toEqual(["add", "dir"]);
    expect(items[2]!.nameParts).toEqual(["ab", "cd", "ef"]);
    expect(items[3]!.nameParts).toEqual(["name", "part"]);
  });

  it("descriptionKey 拆词 + 清洗", () => {
    const commands: readonly CommandDef[] = [
      makeCmd({
        id: "test:b",
        name: "test",
        description: "Start a new session (clear context!)",
      }),
    ];
    const { items } = getCommandFuse(commands);
    expect(items[0]!.descriptionKey).toEqual([
      "start",
      "a",
      "new",
      "session",
      "clear",
      "context",
    ]);
  });

  it("aliasKey 保留原始 aliases", () => {
    const commands: readonly CommandDef[] = [
      makeCmd({
        id: "new:b",
        name: "new",
        aliases: ["reset", "fresh"],
      }),
    ];
    const { items } = getCommandFuse(commands);
    expect(items[0]!.aliasKey).toEqual(["reset", "fresh"]);
  });

  it("无 aliases 时 aliasKey 是空数组（不是 undefined）", () => {
    const commands: readonly CommandDef[] = [
      makeCmd({ id: "a:b", name: "a" }),
    ];
    const { items } = getCommandFuse(commands);
    expect(items[0]!.aliasKey).toEqual([]);
  });
});

describe("getCommandFuse — Fuse 搜索语义", () => {
  const commands: readonly CommandDef[] = [
    makeCmd({ id: "new:b", name: "new", description: "start a new session" }),
    makeCmd({
      id: "model:b",
      name: "model",
      description: "switch model",
    }),
    makeCmd({
      id: "elevated:b",
      name: "elevated",
      aliases: ["elev"],
      description: "toggle elevated mode",
    }),
    makeCmd({
      id: "add-dir:b",
      name: "add-dir",
      description: "add a directory",
    }),
  ];

  it("精确 name 命中", () => {
    const { fuse } = getCommandFuse(commands);
    const results = fuse.search("model");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.item.commandName).toBe("model");
  });

  it("alias 命中", () => {
    const { fuse } = getCommandFuse(commands);
    const results = fuse.search("elev");
    const first = results[0]!;
    expect(first.item.commandName).toBe("elevated");
  });

  it("nameParts 子词命中（`dir` 命中 `add-dir`）", () => {
    const { fuse } = getCommandFuse(commands);
    const results = fuse.search("dir");
    const names = results.map((r) => r.item.commandName);
    expect(names).toContain("add-dir");
  });

  it("description 关键词命中但权重最低", () => {
    const { fuse } = getCommandFuse(commands);
    // "toggle" 只在 elevated 的 description 里
    const results = fuse.search("toggle");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.item.commandName).toBe("elevated");
  });

  it("完全无关的 query 返回空", () => {
    const { fuse } = getCommandFuse(commands);
    const results = fuse.search("xyzqqqqnonsense");
    expect(results).toHaveLength(0);
  });
});
