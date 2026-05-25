import { describe, expect, it } from "vitest";
import { filterDangerousEnv, isDangerousEnvName } from "../env-security.js";

describe("isDangerousEnvName", () => {
  it("精确名命中：解释器 / shell 启动型变量", () => {
    for (const name of [
      "NODE_OPTIONS",
      "PYTHONPATH",
      "PERL5OPT",
      "RUBYOPT",
      "SHELLOPTS",
      "BASH_ENV",
      "PS4",
      "LUA_INIT",
      "GIT_SSH_COMMAND",
    ]) {
      expect(isDangerousEnvName(name)).toBe(true);
    }
  });

  it("前缀族命中：动态链接器与 bash 导出函数", () => {
    expect(isDangerousEnvName("LD_PRELOAD")).toBe(true);
    expect(isDangerousEnvName("LD_LIBRARY_PATH")).toBe(true);
    expect(isDangerousEnvName("DYLD_INSERT_LIBRARIES")).toBe(true);
    expect(isDangerousEnvName("BASH_FUNC_foo%%")).toBe(true);
  });

  it("大小写不敏感", () => {
    expect(isDangerousEnvName("node_options")).toBe(true);
    expect(isDangerousEnvName("ld_preload")).toBe(true);
  });

  it("普通配置变量放行", () => {
    for (const name of [
      "NOTION_TOKEN",
      "GITHUB_API_URL",
      "MY_SERVER_FLAG",
      "PATH",
      "HOME",
      "API_BASE",
    ]) {
      expect(isDangerousEnvName(name)).toBe(false);
    }
  });
});

describe("filterDangerousEnv", () => {
  it("剔除危险变量、保留其余，并回报剔除清单", () => {
    const { safe, removed } = filterDangerousEnv({
      NOTION_TOKEN: "ntn_x",
      NODE_OPTIONS: "--require /tmp/evil.js",
      LD_PRELOAD: "/tmp/evil.so",
      API_BASE: "https://example.com",
      DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
    });

    expect(safe).toEqual({
      NOTION_TOKEN: "ntn_x",
      API_BASE: "https://example.com",
    });
    expect(removed.sort()).toEqual(
      ["DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "NODE_OPTIONS"].sort(),
    );
  });

  it("全安全变量 → 原样保留、removed 为空", () => {
    const env = { NOTION_TOKEN: "ntn_x", API_BASE: "https://example.com" };
    const { safe, removed } = filterDangerousEnv(env);
    expect(safe).toEqual(env);
    expect(removed).toEqual([]);
  });

  it("空 env → 空结果", () => {
    expect(filterDangerousEnv({})).toEqual({ safe: {}, removed: [] });
  });
});
