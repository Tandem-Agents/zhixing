/**
 * trust.* / skill.* 管理面方法契约 —— 薄壳直达目录、坏参数
 * fail-fast、skill 写后向全连接广播 skill.changed(携结构版本)。
 */

import { describe, expect, it, vi } from "vitest";
import {
  SkillCatalogApplicationError,
  type SkillCatalogApplication,
} from "@zhixing/core/skills/catalog";
import {
  buildTrustListMethod,
  buildTrustRevokeMethod,
} from "../methods/trust.js";
import {
  buildSkillListMethod,
  buildSkillSetStateMethod,
  buildSkillArchiveMethod,
} from "../methods/skill.js";
import { RpcDispatcher } from "../dispatcher.js";
import { HandlerRegistry } from "../handlers.js";
import { RPC_ERROR_CODES } from "../protocol.js";
import type { ServerContext } from "../../context.js";
import type { TrustDirectory } from "../../runtime/management-directories.js";

function makeCtx(slots: {
  trust?: TrustDirectory;
  skillCatalog?: SkillCatalogApplication;
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

async function dispatchSkillRequest(input: {
  readonly method: string;
  readonly params?: unknown;
  readonly skillCatalog: SkillCatalogApplication;
}) {
  const registry = new HandlerRegistry();
  registry.registerAll([
    buildSkillListMethod(),
    buildSkillSetStateMethod(),
    buildSkillArchiveMethod(),
  ]);
  const sendSuccess = vi.fn();
  const sendError = vi.fn();
  const dispatcher = new RpcDispatcher({
    registry,
    server: { skillCatalog: input.skillCatalog } as ServerContext,
  });
  await dispatcher.handleMessage({
    id: 1,
    authenticated: true,
    loopback: true,
    closed: false,
    clientInfo: { id: "skill-management-test" },
    sendSuccess,
    sendError,
    notify: vi.fn(),
    close: vi.fn(),
    onClose: () => () => undefined,
  }, JSON.stringify({
    jsonrpc: "2.0",
    id: "skill-wire",
    method: input.method,
    params: input.params,
  }));
  return { sendSuccess, sendError };
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
  function makeSkills(): SkillCatalogApplication & { calls: unknown[] } {
    const calls: unknown[] = [];
    let version = 7;
    return {
      calls,
      async query(query) {
        calls.push(["query", query]);
        return {
          entries: [{ id: "s1" }] as never,
          catalogRevision: version,
        };
      },
      async execute(command) {
        calls.push(["execute", command]);
        if (command.skillId === "ghost") {
          throw new SkillCatalogApplicationError(
            "not-found",
            `Skill not found: ${command.skillId}`,
          );
        }
        if (command.skillId === "conflict") {
          throw new SkillCatalogApplicationError("conflict", "Skill changed");
        }
        if (command.skillId === "failed") throw new Error("commit failed");
        version += 1;
        return {
          fact: {
            kind: "skill-catalog-changed",
            catalogRevision: version,
          },
        };
      },
    };
  }

  it("list 返回管理视图与结构版本", async () => {
    const skills = makeSkills();
    const ctx = makeCtx({ skillCatalog: skills });
    const direct = await skills.query({ kind: "list" });
    expect(await call(buildSkillListMethod(), {}, ctx)).toEqual({
      skills: [{ id: "s1" }],
      structuralVersion: 7,
    });
    expect(direct).toEqual({ entries: [{ id: "s1" }], catalogRevision: 7 });
  });

  it("setState:patch 校验(空 patch / 坏类型 / 坏 mode 拒)、成功后广播 skill.changed 携新版本", async () => {
    const skills = makeSkills();
    const broadcastAll = vi.fn();
    const ctx = makeCtx({ skillCatalog: skills, broadcastAll });
    const method = buildSkillSetStateMethod();
    const command = {
      kind: "set-state" as const,
      skillId: "s1",
      patch: { pinned: true, mode: "work" as const },
    };
    await expect(makeSkills().execute(command)).resolves.toEqual({
      fact: { kind: "skill-catalog-changed", catalogRevision: 8 },
    });

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
    expect(skills.calls).toEqual([["execute", command]]);
    expect(broadcastAll).toHaveBeenCalledWith("skill.changed", {
      structuralVersion: 8,
    });

    await expect(
      call(method, { skillId: "ghost", disabled: true }, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.NOT_FOUND });
    await expect(makeSkills().execute({
      kind: "set-state",
      skillId: "ghost",
      patch: { disabled: true },
    })).rejects.toMatchObject({ code: "not-found" });
    await expect(
      call(method, { skillId: "conflict", disabled: true }, ctx),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      call(method, { skillId: "failed", disabled: true }, ctx),
    ).rejects.toThrow("commit failed");
    expect(broadcastAll).toHaveBeenCalledTimes(1);
  });

  it("archive:成功广播、不存在 NOT_FOUND 不广播", async () => {
    const skills = makeSkills();
    const broadcastAll = vi.fn();
    const ctx = makeCtx({ skillCatalog: skills, broadcastAll });
    await expect(makeSkills().execute({
      kind: "archive",
      skillId: "s1",
    })).resolves.toEqual({
      fact: { kind: "skill-catalog-changed", catalogRevision: 8 },
    });

    await call(buildSkillArchiveMethod(), { skillId: "s1" }, ctx);
    expect(broadcastAll).toHaveBeenCalledTimes(1);

    await expect(
      call(buildSkillArchiveMethod(), { skillId: "ghost" }, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.NOT_FOUND });
    expect(broadcastAll).toHaveBeenCalledTimes(1);
  });

  it("preserves all three methods and pre-migration errors through the real dispatcher", async () => {
    const skills = makeSkills();

    const list = await dispatchSkillRequest({
      method: "skill.list",
      skillCatalog: skills,
    });
    expect(list.sendSuccess).toHaveBeenCalledWith("skill-wire", {
      skills: [{ id: "s1" }],
      structuralVersion: 7,
    });

    const setState = await dispatchSkillRequest({
      method: "skill.setState",
      params: { skillId: "s1", pinned: true },
      skillCatalog: skills,
    });
    expect(setState.sendSuccess).toHaveBeenCalledWith("skill-wire", { ok: true });

    const archive = await dispatchSkillRequest({
      method: "skill.archive",
      params: { skillId: "s1" },
      skillCatalog: skills,
    });
    expect(archive.sendSuccess).toHaveBeenCalledWith("skill-wire", { ok: true });

    const invalid = await dispatchSkillRequest({
      method: "skill.setState",
      params: { skillId: "s1" },
      skillCatalog: skills,
    });
    expect(invalid.sendError).toHaveBeenCalledWith("skill-wire", {
      code: RPC_ERROR_CODES.INVALID_PARAMS,
      message: "skill.setState requires at least one of: pinned / disabled / mode",
      data: undefined,
    });

    const notFound = await dispatchSkillRequest({
      method: "skill.archive",
      params: { skillId: "ghost" },
      skillCatalog: skills,
    });
    expect(notFound.sendError).toHaveBeenCalledWith("skill-wire", {
      code: RPC_ERROR_CODES.NOT_FOUND,
      message: "Skill not found: ghost",
      data: undefined,
    });

    const conflict = await dispatchSkillRequest({
      method: "skill.setState",
      params: { skillId: "conflict", disabled: true },
      skillCatalog: skills,
    });
    expect(conflict.sendError).toHaveBeenCalledWith("skill-wire", {
      code: RPC_ERROR_CODES.INTERNAL_ERROR,
      message: "Internal error",
      data: { message: "Skill changed" },
    });

    const commitFailure = await dispatchSkillRequest({
      method: "skill.archive",
      params: { skillId: "failed" },
      skillCatalog: skills,
    });
    expect(commitFailure.sendError).toHaveBeenCalledWith("skill-wire", {
      code: RPC_ERROR_CODES.INTERNAL_ERROR,
      message: "Internal error",
      data: { message: "commit failed" },
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
