import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";

import { expandUserHome, getZhixingHome } from "../paths.js";

describe("expandUserHome", () => {
  const home = os.homedir();

  it("展开 ~ 到 homedir", () => {
    expect(expandUserHome("~")).toBe(home);
  });

  it("展开 ~/foo 到 homedir/foo", () => {
    expect(expandUserHome("~/foo")).toBe(path.join(home, "foo"));
  });

  it("展开 ~/a/b/c 到 homedir/a/b/c", () => {
    expect(expandUserHome("~/a/b/c")).toBe(path.join(home, "a", "b", "c"));
  });

  it("展开 ~\\foo （Windows 反斜杠）到 homedir/foo", () => {
    expect(expandUserHome("~\\foo")).toBe(path.join(home, "foo"));
  });

  it("绝对路径原样透传", () => {
    const abs = path.resolve("/abs/path");
    expect(expandUserHome(abs)).toBe(abs);
  });

  it("相对路径原样透传", () => {
    expect(expandUserHome("relative/path")).toBe("relative/path");
  });

  it("空字符串原样透传", () => {
    expect(expandUserHome("")).toBe("");
  });

  it("~user 形式不展开，原样透传（不支持跨用户家目录）", () => {
    expect(expandUserHome("~mike/config")).toBe("~mike/config");
    expect(expandUserHome("~something")).toBe("~something");
  });

  it("中间含 ~ 不展开（仅识别前缀）", () => {
    expect(expandUserHome("./~/foo")).toBe("./~/foo");
    expect(expandUserHome("/abs/~/path")).toBe("/abs/~/path");
  });
});

describe("getZhixingHome", () => {
  it("返回 string，包含 .zhixing", () => {
    const result = getZhixingHome();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});
