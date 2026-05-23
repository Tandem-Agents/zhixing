import { describe, expect, it } from "vitest";
import { filterSpawnEnv } from "../env-filter.js";

describe("filterSpawnEnv", () => {
  it("剔除解释器注入型危险变量、保留正常变量", () => {
    const out = filterSpawnEnv({
      PATH: "/usr/bin",
      HOME: "/home/u",
      NODE_OPTIONS: "--require evil",
      PYTHONPATH: "/evil",
      PYTHONSTARTUP: "/evil.py",
      LD_PRELOAD: "/evil.so",
      LD_LIBRARY_PATH: "/evil",
    });
    expect(out).toEqual({ PATH: "/usr/bin", HOME: "/home/u" });
  });

  it("DYLD_ 前缀整族剔除", () => {
    const out = filterSpawnEnv({
      DYLD_INSERT_LIBRARIES: "/evil.dylib",
      DYLD_LIBRARY_PATH: "/evil",
      DYLD_FRAMEWORK_PATH: "/evil",
      KEEP: "y",
    });
    expect(out).toEqual({ KEEP: "y" });
  });

  it("丢弃 undefined 值（process.env 的空槽）", () => {
    const out = filterSpawnEnv({ A: "1", B: undefined });
    expect(out).toEqual({ A: "1" });
  });
});
