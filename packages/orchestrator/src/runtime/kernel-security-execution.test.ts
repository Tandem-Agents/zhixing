import { describe, expect, it, vi } from "vitest";
import {
  assembleKernelSecurityExecution,
  type KernelSecurityExecution,
  type KernelSecurityExecutionFactory,
} from "./kernel-security-execution.js";

function request() {
  return Object.freeze({
    extractArgument: () => "",
    builtinRuleSets: Object.freeze([]),
    workspacePath: null,
  });
}

function binding(): KernelSecurityExecution {
  return Object.freeze({
    contextId: Object.freeze({ kind: "main" as const }),
    trustContext: Object.freeze({ kind: "global" as const }),
    permissionRuleSource: Object.freeze({
      match: () => null,
      matchFrozen: () => null,
    }),
    recordApproval: () => Object.freeze({ kind: "recorded" as const }),
    securitySnapshot: () => Object.freeze({
      contextId: Object.freeze({ kind: "main" as const }),
      workspacePath: null,
      permissionRules: Object.freeze([]),
      confirmations: Object.freeze([]),
    }),
    executionPermissionRules: () => Object.freeze([]),
  });
}

describe("Kernel Security execution boundary", () => {
  it("captures one finite product-bound Security/Confirmation execution", () => {
    const created = binding();
    const create = vi.fn(() => created);
    const factory: KernelSecurityExecutionFactory = Object.freeze({ create });
    const capturedRequest = request();

    const captured = assembleKernelSecurityExecution(factory, capturedRequest);

    expect(captured).toBe(created);
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(capturedRequest);
    expect(Object.isFrozen(captured.permissionRuleSource)).toBe(true);
  });

  it("rejects mutable factories, mutable requests and incomplete bindings", () => {
    expect(() =>
      assembleKernelSecurityExecution(
        { create: () => binding() },
        request(),
      ),
    ).toThrow("factory must be frozen");
    expect(() =>
      assembleKernelSecurityExecution(
        Object.freeze({ create: () => binding() }),
        { ...request() },
      ),
    ).toThrow("request must be finite and immutable");
    expect(() =>
      assembleKernelSecurityExecution(
        Object.freeze({ create: () => Object.freeze({}) }) as never,
        request(),
      ),
    ).toThrow("binding is incomplete");
    expect(() =>
      assembleKernelSecurityExecution(
        Object.freeze({
          create: () => Object.freeze({
            ...binding(),
            permissionRuleSource: {
              match: () => null,
              matchFrozen: () => null,
            },
          }),
        }),
        request(),
      ),
    ).toThrow("binding is incomplete");
  });
});
