import { describe, expect, it } from "vitest";
import type { Key } from "node:readline";
import { mapKey } from "../key-handler.js";

const k = (overrides: Partial<Key>): Key => ({
  sequence: undefined,
  name: undefined,
  ctrl: false,
  meta: false,
  shift: false,
  ...overrides,
});

describe("mapKey", () => {
  it("up → move -1", () => {
    expect(mapKey(k({ name: "up" }))).toEqual({ kind: "move", delta: -1 });
  });

  it("down → move +1", () => {
    expect(mapKey(k({ name: "down" }))).toEqual({ kind: "move", delta: 1 });
  });

  it("d → request-delete", () => {
    expect(mapKey(k({ name: "d" }))).toEqual({ kind: "request-delete" });
  });

  it("escape → exit", () => {
    expect(mapKey(k({ name: "escape" }))).toEqual({ kind: "exit" });
  });

  it("Ctrl+C → exit", () => {
    expect(mapKey(k({ name: "c", ctrl: true }))).toEqual({ kind: "exit" });
  });

  it("Ctrl+D 不撤销（双击协议用字符 d，不与 typeahead 的 Ctrl+D 输入态行为撞）", () => {
    expect(mapKey(k({ name: "d", ctrl: true }))).toBeNull();
  });

  it("其他字母键返回 null", () => {
    expect(mapKey(k({ name: "a" }))).toBeNull();
    expect(mapKey(k({ name: "x" }))).toBeNull();
  });

  it("ctrl 其他键返回 null（避免误触系统快捷键）", () => {
    expect(mapKey(k({ name: "a", ctrl: true }))).toBeNull();
    expect(mapKey(k({ name: "u", ctrl: true }))).toBeNull();
  });

  it("undefined key → null", () => {
    expect(mapKey(undefined)).toBeNull();
  });

  it("无 name 的 key（裸字符）→ null", () => {
    expect(mapKey(k({}))).toBeNull();
  });
});
