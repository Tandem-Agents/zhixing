import { describe, it, expect } from "vitest";
import { parseRpcArgs, ArgParseError } from "../args.js";

describe("parseRpcArgs", () => {
  // ─── 无参数 ───

  it("returns undefined params when no tokens", () => {
    expect(parseRpcArgs("health", []).params).toBeUndefined();
  });

  // ─── --json ───

  it("--json '...' parses JSON params", () => {
    const r = parseRpcArgs("schedule.create", [
      "--json",
      '{"name":"x","schedule":{"kind":"interval","everyMs":1000}}',
    ]);
    expect(r.params).toEqual({
      name: "x",
      schedule: { kind: "interval", everyMs: 1000 },
    });
  });

  it("--json='...' (= form) also works", () => {
    const r = parseRpcArgs("any", ['--json={"a":1}']);
    expect(r.params).toEqual({ a: 1 });
  });

  it("invalid JSON throws ArgParseError", () => {
    expect(() => parseRpcArgs("any", ["--json", "{bad"])).toThrow(ArgParseError);
  });

  // ─── --key value ───

  it("--key=value parses to params object", () => {
    const r = parseRpcArgs("session.send", ["--text=hello"]);
    expect(r.params).toEqual({ text: "hello" });
  });

  it("--key value (split form) also works", () => {
    const r = parseRpcArgs("session.send", ["--text", "hello"]);
    expect(r.params).toEqual({ text: "hello" });
  });

  it("scalar parsing: true/false/number", () => {
    const r = parseRpcArgs("any", [
      "--enabled=true",
      "--count=5",
      "--ratio=1.5",
      "--name=alice",
    ]);
    expect(r.params).toEqual({
      enabled: true,
      count: 5,
      ratio: 1.5,
      name: "alice",
    });
  });

  it("--key without value throws", () => {
    expect(() => parseRpcArgs("any", ["--key"])).toThrow(/requires a value/);
  });

  // ─── 位置参数 ───

  it("positional arg uses POSITIONAL_RULES mapping", () => {
    expect(parseRpcArgs("session.send", ["你好"]).params).toEqual({ text: "你好" });
    expect(parseRpcArgs("schedule.delete", ["task_xxx"]).params).toEqual({
      id: "task_xxx",
    });
  });

  it("positional on method without rule throws", () => {
    expect(() => parseRpcArgs("schedule.create", ["foo"])).toThrow(
      /no positional argument shortcut/,
    );
  });

  it("too many positional args throws", () => {
    expect(() => parseRpcArgs("session.send", ["a", "b"])).toThrow(/at most 1/);
  });

  // ─── flags ───

  it("--watch flag", () => {
    const r = parseRpcArgs("session.send", ["--watch", "hi"]);
    expect(r.flags.watch).toBe(true);
    expect(r.params).toEqual({ text: "hi" });
  });

  it("--raw flag", () => {
    const r = parseRpcArgs("health", ["--raw"]);
    expect(r.flags.raw).toBe(true);
  });

  // ─── 优先级 ───

  it("--json wins over --key=value", () => {
    const r = parseRpcArgs("any", ['--json={"x":1}', "--y=2"]);
    expect(r.params).toEqual({ x: 1 }); // y is dropped
  });

  it("--key=value wins over positional", () => {
    const r = parseRpcArgs("session.send", ["--text=A", "B"]);
    expect(r.params).toEqual({ text: "A" }); // B dropped
  });
});
