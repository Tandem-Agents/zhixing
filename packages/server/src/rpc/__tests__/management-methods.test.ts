/**
 * trust.* / skill.* 管理面方法契约 —— 薄壳直达目录、坏参数
 * fail-fast、skill 写后向全连接广播 skill.changed(携结构版本)。
 */

import { describe, expect, it, vi } from "vitest";
import {
  createSkillCatalogProductApiContribution,
  SKILL_CATALOG_LIST_QUERY,
  SKILL_CATALOG_PRODUCT_API_EXACT_SET,
  SkillCatalogApplicationError,
  type SkillCatalogApplication,
} from "@zhixing/core/skills/catalog";
import {
  createTrustAdministrationProductApiContribution,
  TRUST_ADMINISTRATION_PRODUCT_API_EXACT_SET,
  TrustAdministrationApplicationError,
  type TrustAdministrationApplication,
} from "@zhixing/core/trust-administration";
import { ProductApiDispatcher } from "@zhixing/core/product-api";
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

function makeCtx(slots: {
  productApi?: ProductApiDispatcher;
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
  readonly productApi: ProductApiDispatcher;
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
    server: { productApi: input.productApi } as ServerContext,
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

async function dispatchTrustRequest(input: {
  readonly method: string;
  readonly params?: unknown;
  readonly productApi: ProductApiDispatcher;
  readonly authenticated?: boolean;
}) {
  const registry = new HandlerRegistry();
  registry.registerAll([buildTrustListMethod(), buildTrustRevokeMethod()]);
  const sendSuccess = vi.fn();
  const sendError = vi.fn();
  const dispatcher = new RpcDispatcher({
    registry,
    server: { productApi: input.productApi } as ServerContext,
  });
  await dispatcher.handleMessage({
    id: 1,
    authenticated: input.authenticated ?? true,
    loopback: true,
    closed: false,
    clientInfo: { id: "trust-management-test" },
    sendSuccess,
    sendError,
    notify: vi.fn(),
    close: vi.fn(),
    onClose: () => () => undefined,
  }, JSON.stringify({
    jsonrpc: "2.0",
    id: "trust-wire",
    method: input.method,
    params: input.params,
  }));
  return { sendSuccess, sendError };
}

describe("trust.*", () => {
  function makeProductApi(
    application: TrustAdministrationApplication,
  ): ProductApiDispatcher {
    return new ProductApiDispatcher(TRUST_ADMINISTRATION_PRODUCT_API_EXACT_SET, [
      createTrustAdministrationProductApiContribution(application),
    ]);
  }

  function makeTrust(): TrustAdministrationApplication & { calls: unknown[] } {
    const calls: unknown[] = [];
    return {
      calls,
      async query(query) {
        calls.push(["query", query]);
        return { rules: [{ id: "r1", scope: "global" }] as never };
      },
      async execute(command) {
        calls.push(["execute", command]);
        if (command.ruleId === "ghost") {
          throw new TrustAdministrationApplicationError(
            "not-found",
            `Trust rule not found: ${command.ruleId}`,
          );
        }
        return {
          revoked: true,
          fact: {
            kind: "trust-administration-rule-revoked",
            ruleId: command.ruleId,
          },
        };
      },
    };
  }

  it("list/revoke 只经同一 Product API;不存在保持 NOT_FOUND", async () => {
    const rules = [{ id: "r1", scope: "global" }];
    const trust = makeTrust();
    const ctx = makeCtx({ productApi: makeProductApi(trust) });

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
    expect(trust.calls).toEqual([
      ["query", { kind: "list", conversationId: undefined }],
      ["execute", { kind: "revoke", ruleId: "r1", conversationId: undefined }],
      ["execute", { kind: "revoke", ruleId: "ghost", conversationId: undefined }],
    ]);
  });

  it("fails closed when the Host did not contribute Trust Administration", async () => {
    await expect(call(buildTrustListMethod(), {}, makeCtx({})))
      .rejects.toMatchObject({
        code: RPC_ERROR_CODES.INTERNAL_ERROR,
        message: "Trust Administration application not configured on server",
      });
  });

  it("preserves authentication, wire results, invalid params, and not-found through the dispatcher", async () => {
    const productApi = makeProductApi(makeTrust());
    const unauthorized = await dispatchTrustRequest({
      method: "trust.list",
      productApi,
      authenticated: false,
    });
    expect(unauthorized.sendError).toHaveBeenCalledWith("trust-wire", {
      code: RPC_ERROR_CODES.UNAUTHORIZED,
      message: "Method requires authentication: trust.list",
      data: undefined,
    });

    const list = await dispatchTrustRequest({ method: "trust.list", productApi });
    expect(list.sendSuccess).toHaveBeenCalledWith("trust-wire", {
      rules: [{ id: "r1", scope: "global" }],
    });

    const invalid = await dispatchTrustRequest({
      method: "trust.revoke",
      params: {},
      productApi,
    });
    expect(invalid.sendError).toHaveBeenCalledWith("trust-wire", {
      code: RPC_ERROR_CODES.INVALID_PARAMS,
      message: "trust.revoke requires 'ruleId'",
      data: undefined,
    });

    const missing = await dispatchTrustRequest({
      method: "trust.revoke",
      params: { ruleId: "ghost" },
      productApi,
    });
    expect(missing.sendError).toHaveBeenCalledWith("trust-wire", {
      code: RPC_ERROR_CODES.NOT_FOUND,
      message: "Trust rule not found: ghost",
      data: undefined,
    });
  });
});

describe("skill.*", () => {
  function makeProductApi(application: SkillCatalogApplication): ProductApiDispatcher {
    return new ProductApiDispatcher(SKILL_CATALOG_PRODUCT_API_EXACT_SET, [
      createSkillCatalogProductApiContribution(application),
    ]);
  }

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

  it("fails closed when the Host did not contribute the Skill Product API", async () => {
    await expect(call(buildSkillListMethod(), {}, makeCtx({}))).rejects.toMatchObject({
      code: RPC_ERROR_CODES.INTERNAL_ERROR,
      message: "Skill Catalog application not configured on server",
    });
  });

  it("list 返回管理视图与结构版本", async () => {
    const skills = makeSkills();
    const productApi = makeProductApi(skills);
    const ctx = makeCtx({ productApi });
    const direct = await productApi.query(SKILL_CATALOG_LIST_QUERY, { kind: "list" });
    expect(await call(buildSkillListMethod(), {}, ctx)).toEqual({
      skills: [{ id: "s1" }],
      structuralVersion: 7,
    });
    expect(direct).toEqual({ entries: [{ id: "s1" }], catalogRevision: 7 });
  });

  it("setState:patch 校验(空 patch / 坏类型 / 坏 mode 拒)、成功后广播 skill.changed 携新版本", async () => {
    const skills = makeSkills();
    const broadcastAll = vi.fn();
    const ctx = makeCtx({ productApi: makeProductApi(skills), broadcastAll });
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
    const ctx = makeCtx({ productApi: makeProductApi(skills), broadcastAll });
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
      productApi: makeProductApi(skills),
    });
    expect(list.sendSuccess).toHaveBeenCalledWith("skill-wire", {
      skills: [{ id: "s1" }],
      structuralVersion: 7,
    });

    const setState = await dispatchSkillRequest({
      method: "skill.setState",
      params: { skillId: "s1", pinned: true },
      productApi: makeProductApi(skills),
    });
    expect(setState.sendSuccess).toHaveBeenCalledWith("skill-wire", { ok: true });

    const archive = await dispatchSkillRequest({
      method: "skill.archive",
      params: { skillId: "s1" },
      productApi: makeProductApi(skills),
    });
    expect(archive.sendSuccess).toHaveBeenCalledWith("skill-wire", { ok: true });

    const invalid = await dispatchSkillRequest({
      method: "skill.setState",
      params: { skillId: "s1" },
      productApi: makeProductApi(skills),
    });
    expect(invalid.sendError).toHaveBeenCalledWith("skill-wire", {
      code: RPC_ERROR_CODES.INVALID_PARAMS,
      message: "skill.setState requires at least one of: pinned / disabled / mode",
      data: undefined,
    });

    const notFound = await dispatchSkillRequest({
      method: "skill.archive",
      params: { skillId: "ghost" },
      productApi: makeProductApi(skills),
    });
    expect(notFound.sendError).toHaveBeenCalledWith("skill-wire", {
      code: RPC_ERROR_CODES.NOT_FOUND,
      message: "Skill not found: ghost",
      data: undefined,
    });

    const conflict = await dispatchSkillRequest({
      method: "skill.setState",
      params: { skillId: "conflict", disabled: true },
      productApi: makeProductApi(skills),
    });
    expect(conflict.sendError).toHaveBeenCalledWith("skill-wire", {
      code: RPC_ERROR_CODES.INTERNAL_ERROR,
      message: "Internal error",
      data: { message: "Skill changed" },
    });

    const commitFailure = await dispatchSkillRequest({
      method: "skill.archive",
      params: { skillId: "failed" },
      productApi: makeProductApi(skills),
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
