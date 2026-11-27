/** Builtin Skill registry and user-shadow boundary. */

import { describe, expect, it } from "vitest";
import {
  builtinIndexEntries,
  getBuiltinSkill,
  listBuiltinSkills,
  type BuiltinIndexEntry,
} from "../builtin.js";
import { decodeSkillPackageArchive } from "../archive.js";
import { skillNameToId } from "../id.js";

const COGNITION_ID = skillNameToId("知行系统认知");
const EXTENSION_ID = skillNameToId("外部能力接入");
const DISTILL_ID = skillNameToId("提炼技能");
const ADMIT_ID = skillNameToId("接入技能");
const CONVERSATION_ID = skillNameToId("对话通信");

describe("builtin 注册集", () => {
  it("登记五大内置 system 技能包并在 main/work 可见", () => {
    const allIds = listBuiltinSkills().map((entry) => entry.id);
    expect(allIds).toEqual([
      COGNITION_ID,
      EXTENSION_ID,
      DISTILL_ID,
      ADMIT_ID,
      CONVERSATION_ID,
    ]);

    for (const id of allIds) {
      const entry = getBuiltinSkill(id);
      expect(entry).not.toBeNull();
      expect(entry!.modes).toEqual(["main", "work"]);
      expect(entry!.description.length).toBeGreaterThan(0);
      expect(entry!.packageVersion).toMatch(/^sha256:/);
      const decoded = decodeSkillPackageArchive(entry!.archive.bytes);
      expect(decoded.packageVersion).toBe(entry!.packageVersion);
    }

    for (const mode of ["main", "work"] as const) {
      const entries = builtinIndexEntries(mode, new Set());
      expect(entries.map((item: BuiltinIndexEntry) => item.id)).toEqual(allIds);
    }
  });

  it("每个内置能力至多关联一个 v2 主锚点工具", () => {
    expect(getBuiltinSkill(COGNITION_ID)!.tools).toEqual(["runtime_inspect"]);
    expect(getBuiltinSkill(EXTENSION_ID)!.tools).toEqual(["extension"]);
    expect(getBuiltinSkill(DISTILL_ID)!.tools).toEqual(["skill_save"]);
    expect(getBuiltinSkill(ADMIT_ID)!.tools).toEqual(["skill_admit"]);
    expect(getBuiltinSkill(CONVERSATION_ID)!.tools).toEqual(["conversation"]);
    for (const entry of listBuiltinSkills()) {
      expect((entry.tools ?? []).length).toBeLessThanOrEqual(1);
    }
  });

  it("系统认知与外部能力接入完整封存多成员资源与离线 kit 声明闭包", () => {
    const cognition = getBuiltinSkill(COGNITION_ID)!;
    const cogPaths = decodeSkillPackageArchive(cognition.archive.bytes).header.members.map(
      (m) => m.path,
    );
    expect(cogPaths).toEqual(
      expect.arrayContaining([
        "SKILL.md",
        "topology-and-context.md",
        "workspaces-and-models.md",
        "mcp-and-extensions.md",
        "diagnostics-and-logs.md",
        "commands-and-surfaces.md",
      ]),
    );

    const ext = getBuiltinSkill(EXTENSION_ID)!;
    const extMembers = decodeSkillPackageArchive(ext.archive.bytes).header.members.map(
      (m) => m.path,
    );
    expect(extMembers).toEqual(
      expect.arrayContaining([
        "SKILL.md",
        "inbound.md",
        "delivery.md",
        "config-and-verification.md",
        "update-repair-rollback.md",
        "kit/authoring.md",
        "kit/manifest.schema.json",
        "kit/channel-sdk.mjs",
        "kit/channel-sdk.d.ts",
        "kit/contracts/channels/extension-worker.d.ts",
        "examples/starter-channel.ts",
        "examples/manifest.json",
        "examples/bad-1-missing-field.json",
        "examples/bad-2-export-shape.mjs",
        "examples/bad-3-digest-mismatch.json",
        "examples/bad-4-syntax-error.mjs",
      ]),
    );
  });

  it("保留提炼、接入与对话通信的核心规则", () => {
    expect(getBuiltinSkill(DISTILL_ID)!.body).toContain("writeTemplate");
    expect(getBuiltinSkill(ADMIT_ID)!.body).toContain("AdmissionLlm");
    expect(getBuiltinSkill(ADMIT_ID)!.body).toContain("admissionToken");
    expect(getBuiltinSkill(CONVERSATION_ID)!.body).toContain("<input-source");
  });

  it("用户 catalog 中的同 id 不破坏独立分池", () => {
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
    expect(builtinPool.map((entry) => entry.id)).toContain(COGNITION_ID);
    expect(builtinPool.map((entry) => entry.id)).toContain(EXTENSION_ID);
    expect(builtinPool.map((entry) => entry.id)).toContain(DISTILL_ID);
    expect(builtinPool.map((entry) => entry.id)).toContain(ADMIT_ID);
    expect(builtinPool.map((entry) => entry.id)).toContain(CONVERSATION_ID);
  });
});
