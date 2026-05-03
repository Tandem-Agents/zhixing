/**
 * Entry 派生 helpers 测试——把 EntryState ↔ Status 的派生 invariant 上锁到 CI。
 *
 * 这些 invariant 是 caller 可信赖的契约：
 *   - blocked → level=pending；ready → level=ready；disabled → level=disabled
 *   - 仅 blocked 态产出 issues；其余态 issues 必为空
 */

import { describe, expect, it } from "vitest";
import { deriveEntryStatus, deriveEntryIssues } from "../entry.js";
import type { SectionEntry } from "../types.js";

const mkEntry = (state: SectionEntry["state"]): SectionEntry => ({
  label: "test",
  state,
});

describe("deriveEntryStatus", () => {
  it("ready → level=ready", () => {
    const status = deriveEntryStatus(
      mkEntry({ kind: "ready", statusText: "已配置" }),
    );
    expect(status).toEqual({ level: "ready", text: "已配置" });
  });

  it("disabled → level=disabled", () => {
    const status = deriveEntryStatus(
      mkEntry({ kind: "disabled", statusText: "未启用" }),
    );
    expect(status).toEqual({ level: "disabled", text: "未启用" });
  });

  it("blocked → level=pending（无视 issues 数量）", () => {
    const status = deriveEntryStatus(
      mkEntry({ kind: "blocked", statusText: "待补充", issues: ["a", "b"] }),
    );
    expect(status).toEqual({ level: "pending", text: "待补充" });
  });
});

describe("deriveEntryIssues", () => {
  it("ready → 空数组", () => {
    expect(deriveEntryIssues(mkEntry({ kind: "ready", statusText: "x" }))).toEqual(
      [],
    );
  });

  it("disabled → 空数组", () => {
    expect(deriveEntryIssues(mkEntry({ kind: "disabled", statusText: "x" }))).toEqual(
      [],
    );
  });

  it("blocked → 返回声明的 issues（保序）", () => {
    expect(
      deriveEntryIssues(
        mkEntry({
          kind: "blocked",
          statusText: "x",
          issues: ["主模型 - 服务商", "主模型 - 模型"],
        }),
      ),
    ).toEqual(["主模型 - 服务商", "主模型 - 模型"]);
  });
});
