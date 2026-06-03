/**
 * listUserTrustRules 单元测试 —— 排除 builtin 系统规则、保留用户可管规则。
 */

import { describe, expect, it } from "vitest";
import { PermissionStore } from "../permission-store.js";
import { SecurityPipeline } from "../security-pipeline.js";
import { listUserTrustRules } from "../trust-rules.js";
import type { PermissionRule } from "../types.js";

function makeRule(
  overrides: Partial<PermissionRule> & {
    id: string;
    tool?: string;
    argument?: string;
  },
): PermissionRule {
  return {
    id: overrides.id,
    pattern: {
      tool: overrides.pattern?.tool ?? overrides.tool ?? "bash",
      argument: overrides.pattern?.argument ?? overrides.argument ?? "ls",
    },
    decision: overrides.decision ?? "allow",
    scope: overrides.scope ?? "context",
    createdAt: overrides.createdAt ?? 0,
    lastMatchedAt: overrides.lastMatchedAt ?? 0,
    matchCount: overrides.matchCount ?? 0,
    contextId: overrides.contextId ?? { kind: "main" },
    contextPath: overrides.contextPath,
    contributors: overrides.contributors,
  };
}

function makePipeline(rules: PermissionRule[]): SecurityPipeline {
  const store = new PermissionStore({ rootDir: null });
  for (const r of rules) {
    if (r.scope === "builtin") {
      store.registerBuiltinRules("test-ns", [r]);
    } else {
      store.create({ kind: "main" }, r);
    }
  }
  return new SecurityPipeline({
    trustContext: { kind: "global" },
    permissionStore: store,
  });
}

describe("listUserTrustRules", () => {
  it("排除 builtin 系统规则、保留用户规则", () => {
    const pipeline = makePipeline([
      makeRule({ id: "user-y", tool: "bash", argument: "ls" }),
      makeRule({ id: "user-z", tool: "write", argument: "src/**" }),
      makeRule({ id: "builtin-x", scope: "builtin", tool: "bash", argument: "rm" }),
    ]);
    const ids = listUserTrustRules(pipeline).map((r) => r.id);
    expect(ids).toContain("user-y");
    expect(ids).toContain("user-z");
    expect(ids).not.toContain("builtin-x");
  });

  it("无用户规则时返回空数组", () => {
    const pipeline = makePipeline([
      makeRule({ id: "builtin-only", scope: "builtin" }),
    ]);
    expect(listUserTrustRules(pipeline)).toEqual([]);
  });
});
