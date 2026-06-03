/**
 * handleTrustCommand 单测 —— /trust 的 target 无关命令行为（列表 / 撤销）。
 *
 * 用 fake pipeline（list + revoke + getContextId）驱动,验证:无参列出用户规则（排除
 * builtin）、revoke <id> 调 store.revoke 并回执、撤销不存在的规则报错、缺 id 给用法提示。
 */

import { describe, expect, it } from "vitest";
import type { SecurityPipeline } from "@zhixing/core";
import type { CliWriter } from "../../screen/index.js";
import { handleTrustCommand } from "../commands.js";

function rule(id: string, scope = "global") {
  return {
    id,
    scope,
    pattern: { tool: "bash", argument: id },
    contributors: [{ origin: "user" }],
    matchCount: 0,
  };
}

function setup(initial: ReturnType<typeof rule>[]) {
  const rules = [...initial];
  const revoked: string[] = [];
  const lines: string[] = [];
  const pipeline = {
    getPermissionStore: () => ({
      list: () => rules,
      revoke: (id: string) => {
        const i = rules.findIndex((r) => r.id === id);
        if (i < 0) return false;
        rules.splice(i, 1);
        revoked.push(id);
        return true;
      },
    }),
    getContextId: () => ({ kind: "main" }),
  } as unknown as SecurityPipeline;
  const writer = { line: (s: string) => lines.push(s) } as unknown as CliWriter;
  const out = () => lines.join("\n");
  return { pipeline, writer, revoked, out };
}

describe("handleTrustCommand", () => {
  it("无参：列出用户规则、排除 builtin", () => {
    const { pipeline, writer, out } = setup([
      rule("r-user-a"),
      rule("r-builtin", "builtin"),
    ]);
    handleTrustCommand("", { pipeline, writer });
    expect(out()).toContain("r-user-a");
    expect(out()).not.toContain("r-builtin");
  });

  it("无用户规则：提示暂无", () => {
    const { pipeline, writer, out } = setup([rule("r-builtin", "builtin")]);
    handleTrustCommand("", { pipeline, writer });
    expect(out()).toContain("暂无信任规则");
  });

  it("revoke <id>：调 store.revoke 并回执", () => {
    const { pipeline, writer, revoked, out } = setup([rule("r-x")]);
    handleTrustCommand("revoke r-x", { pipeline, writer });
    expect(revoked).toEqual(["r-x"]);
    expect(out()).toContain("已撤销");
  });

  it("revoke 不存在的 id：报不存在", () => {
    const { pipeline, writer, revoked, out } = setup([rule("r-x")]);
    handleTrustCommand("revoke nope", { pipeline, writer });
    expect(revoked).toEqual([]);
    expect(out()).toContain("不存在");
  });

  it("revoke 缺 id：给用法提示", () => {
    const { pipeline, writer, out } = setup([rule("r-x")]);
    handleTrustCommand("revoke", { pipeline, writer });
    expect(out()).toContain("用法");
  });
});
