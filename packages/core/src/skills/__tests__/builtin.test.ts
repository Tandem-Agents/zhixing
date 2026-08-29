/** Builtin Skill registry and user-shadow boundary. */

import { describe, expect, it } from "vitest";
import {
  builtinIndexEntries,
  getBuiltinSkill,
  type BuiltinIndexEntry,
} from "../builtin.js";
import { skillNameToId } from "../id.js";

const DISTILL_ID = skillNameToId("提炼技能");
const ADMIT_ID = skillNameToId("接入技能");

describe("builtin 注册集", () => {
  it("登记提炼技能并在 main/work 可见", () => {
    const entry = getBuiltinSkill(DISTILL_ID);
    expect(entry).not.toBeNull();
    expect(entry!.modes).toEqual(["main", "work"]);
    expect(entry!.description.length).toBeGreaterThan(0);
    expect(entry!.body).toContain("何时提议");
    for (const mode of ["main", "work"] as const) {
      const entries = builtinIndexEntries(mode, new Set());
      expect(entries.map((item: BuiltinIndexEntry) => item.id)).toContain(
        DISTILL_ID,
      );
    }
  });

  it("每个内置能力至多关联一个工具", () => {
    expect(getBuiltinSkill(DISTILL_ID)!.tools).toEqual(["save_skill"]);
    expect(getBuiltinSkill(ADMIT_ID)!.tools).toEqual(["admit_skill"]);
    for (const id of [DISTILL_ID, ADMIT_ID]) {
      expect((getBuiltinSkill(id)!.tools ?? []).length).toBeLessThanOrEqual(1);
    }
  });

  it("登记接入技能并保留安全红线", () => {
    const entry = getBuiltinSkill(ADMIT_ID);
    expect(entry).not.toBeNull();
    expect(entry!.modes).toEqual(["main", "work"]);
    expect(entry!.body).toContain("原样转述");
  });

  it("用户 catalog 中的同 id 遮蔽 builtin", () => {
    const entries = builtinIndexEntries("main", new Set([DISTILL_ID]));
    expect(entries.map((entry) => entry.id)).not.toContain(DISTILL_ID);
    expect(entries.map((entry) => entry.id)).toContain(ADMIT_ID);
  });

  it("builtin 是用户 top-N 之外的独立追加池", () => {
    const userTopN = Array.from({ length: 20 }, (_, index) => ({
      id: `user-${index}`,
      description: `user ${index}`,
      pinned: false as const,
    }));
    const builtinPool = builtinIndexEntries(
      "main",
      new Set(userTopN.map((entry) => entry.id)),
    );
    expect([...userTopN, ...builtinPool]).toHaveLength(
      userTopN.length + builtinPool.length,
    );
    expect(builtinPool.map((entry) => entry.id)).toContain(DISTILL_ID);
    expect(builtinPool.map((entry) => entry.id)).toContain(ADMIT_ID);
  });
});
