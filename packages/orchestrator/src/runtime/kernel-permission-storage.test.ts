import { describe, expect, it, vi } from "vitest";
import {
  assembleKernelPermissionStorage,
  bindKernelPermissionRuleSource,
  type KernelPermissionStorageBinding,
  type KernelPermissionStorageFactory,
} from "./kernel-permission-storage.js";

function request() {
  return Object.freeze({
    extractArgument: () => "",
    builtinRuleSets: Object.freeze([]),
  });
}

function binding(): KernelPermissionStorageBinding {
  return Object.freeze({
    trustAdministration: Object.freeze({
      workspaceIdentity: (workspacePath: string) => workspacePath,
      listExecutionRules: () => Object.freeze([]),
      snapshotExecutionRules: () => Object.freeze([]),
      createExecutionRule: () => undefined,
    }),
    rulesFor: () =>
      Object.freeze({
        match: () => null,
        matchFrozen: () => null,
      }),
  });
}

describe("Kernel permission storage boundary", () => {
  it("captures one finite Host binding and one context-bound readonly source", () => {
    const created = binding();
    const create = vi.fn(() => created);
    const factory: KernelPermissionStorageFactory = Object.freeze({ create });

    const captured = assembleKernelPermissionStorage(factory, request());
    const source = bindKernelPermissionRuleSource(captured, { kind: "main" });

    expect(captured).toBe(created);
    expect(create).toHaveBeenCalledOnce();
    expect(Object.isFrozen(source)).toBe(true);
  });

  it("rejects mutable factories, incomplete bindings and mutable rule sources", () => {
    expect(() =>
      assembleKernelPermissionStorage(
        { create: () => binding() },
        request(),
      ),
    ).toThrow("factory must be frozen");
    expect(() =>
      assembleKernelPermissionStorage(
        Object.freeze({ create: () => Object.freeze({}) }) as never,
        request(),
      ),
    ).toThrow("binding is incomplete");
    expect(() =>
      bindKernelPermissionRuleSource(
        Object.freeze({
          ...binding(),
          rulesFor: () => ({ match: () => null, matchFrozen: () => null }),
        }),
        { kind: "main" },
      ),
    ).toThrow("rule source is incomplete");
  });
});
