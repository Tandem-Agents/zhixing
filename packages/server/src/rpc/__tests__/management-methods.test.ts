/**
 * trust.* / skill.* / memory.* 管理面方法契约 —— 薄壳直达目录、坏参数
 * fail-fast、skill 写后向全连接广播 skill.changed(携结构版本)。
 */

import { describe, expect, it, vi } from "vitest";
import {
  buildTrustListMethod,
  buildTrustRevokeMethod,
} from "../methods/trust.js";
import {
  buildSkillListMethod,
  buildSkillSetStateMethod,
  buildSkillArchiveMethod,
} from "../methods/skill.js";
import {
  buildMemoryJournalStatsMethod,
  buildMemoryPeopleListMethod,
} from "../methods/memory.js";
import { RPC_ERROR_CODES } from "../protocol.js";
import type { ServerContext } from "../../context.js";
import type {
  SkillDirectory,
  TrustDirectory,
  MemoryDirectory,
} from "../../runtime/management-directories.js";

function makeCtx(slots: {
  trust?: TrustDirectory;
  skills?: SkillDirectory;
  memory?: MemoryDirectory;
  broadcastAll?: (method: string, params: unknown) => void;
}) {
  return {
    server: slots as unknown as ServerContext,
    connection: { id: 1 },
  } as never;
}

async function call(entry: { handler: (p: unknown, c: never) => unknown }, params: unknown, ctx: never) {
  return await entry.handler(params, ctx);
}

describe("trust.*", () => {
  it("list 透传目录;revoke 不存在 NOT_FOUND、存在 revoked:true", async () => {
    const rules = [{ id: "r1", scope: "global" }];
    const revoke = vi.fn(async (id: string) => id === "r1");
    const ctx = makeCtx({
      trust: { list: async () => rules, revoke } as unknown as TrustDirectory,
    });

    expect(await call(buildTrustListMethod(), {}, ctx)).toEqual({ rules });
    expect(await call(buildTrustRevokeMethod(), { ruleId: "r1" }, ctx)).toEqual({
      revoked: true,
    });
    await expect(
      call(buildTrustRevokeMethod(), { ruleId: "ghost" }, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.NOT_FOUND });
    await expect(
      call(buildTrustRevokeMethod(), {}, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
  });
});

describe("skill.*", () => {
  function makeSkills(): SkillDirectory & { calls: unknown[] } {
    const calls: unknown[] = [];
    let version = 7;
    return {
      calls,
      async list() {
        return [{ id: "s1" }] as never;
      },
      async setState(id, patch) {
        calls.push(["setState", id, patch]);
        if (id === "ghost") return false;
        version += 1;
        return true;
      },
      async archive(id) {
        calls.push(["archive", id]);
        if (id === "ghost") return false;
        version += 1;
        return true;
      },
      structuralVersion: () => version,
    };
  }

  it("list 返回管理视图与结构版本", async () => {
    const skills = makeSkills();
    const ctx = makeCtx({ skills });
    expect(await call(buildSkillListMethod(), {}, ctx)).toEqual({
      skills: [{ id: "s1" }],
      structuralVersion: 7,
    });
  });

  it("setState:patch 校验(空 patch / 坏类型 / 坏 mode 拒)、成功后广播 skill.changed 携新版本", async () => {
    const skills = makeSkills();
    const broadcastAll = vi.fn();
    const ctx = makeCtx({ skills, broadcastAll });
    const method = buildSkillSetStateMethod();

    for (const bad of [
      {},
      { skillId: "s1" },
      { skillId: "s1", pinned: "yes" },
      { skillId: "s1", mode: "ghost-mode" },
      { skillId: "s1", mode: "all" }, // 非法值——SkillMode 只有 main / work
    ]) {
      await expect(call(method, bad, ctx)).rejects.toMatchObject({
        code: RPC_ERROR_CODES.INVALID_PARAMS,
      });
    }
    expect(broadcastAll).not.toHaveBeenCalled();

    await call(method, { skillId: "s1", pinned: true, mode: "work" }, ctx);
    expect(skills.calls).toEqual([
      ["setState", "s1", { pinned: true, mode: "work" }],
    ]);
    expect(broadcastAll).toHaveBeenCalledWith("skill.changed", {
      structuralVersion: 8,
    });

    await expect(
      call(method, { skillId: "ghost", disabled: true }, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.NOT_FOUND });
  });

  it("archive:成功广播、不存在 NOT_FOUND 不广播", async () => {
    const skills = makeSkills();
    const broadcastAll = vi.fn();
    const ctx = makeCtx({ skills, broadcastAll });

    await call(buildSkillArchiveMethod(), { skillId: "s1" }, ctx);
    expect(broadcastAll).toHaveBeenCalledTimes(1);

    await expect(
      call(buildSkillArchiveMethod(), { skillId: "ghost" }, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.NOT_FOUND });
    expect(broadcastAll).toHaveBeenCalledTimes(1);
  });
});

describe("memory.*", () => {
  it("journalStats / peopleList 只读透传", async () => {
    const ctx = makeCtx({
      memory: {
        journalStats: async () => ({ totalFiles: 3 }) as never,
        peopleList: async () => [{ id: "p1" }] as never,
      },
    });
    expect(await call(buildMemoryJournalStatsMethod(), {}, ctx)).toEqual({
      stats: { totalFiles: 3 },
    });
    expect(await call(buildMemoryPeopleListMethod(), {}, ctx)).toEqual({
      people: [{ id: "p1" }],
    });
  });
});

describe("isLoopbackAddress(信任级判定要素)", () => {
  it("IPv4 127/8、IPv6 ::1 及 IPv4 映射为 loopback;其余与空值不是", async () => {
    const { isLoopbackAddress } = await import("../connection.js");
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.8.8.8")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.2")).toBe(false);
    expect(isLoopbackAddress("::ffff:192.168.1.2")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});
