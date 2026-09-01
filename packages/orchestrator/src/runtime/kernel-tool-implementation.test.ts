import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@zhixing/core";
import {
  assembleKernelToolImplementation,
  type KernelToolImplementationPort,
  type KernelToolImplementationRequest,
} from "./kernel-tool-implementation.js";

const request = Object.freeze({
  requestedToolNames: Object.freeze(["read", "web_fetch"]),
  skillCatalogLoad: {} as never,
  skillCatalogSave: {} as never,
  skillCatalogAdmission: {} as never,
  skillMode: "main" as const,
}) satisfies KernelToolImplementationRequest;

function tool(name: string): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: "object" },
    call: async () => ({ content: name }),
  };
}

function port(
  tools: readonly ToolDefinition[] = request.requestedToolNames.map(tool),
): KernelToolImplementationPort {
  return Object.freeze({
    create: vi.fn(() => Object.freeze({
      tools: Object.freeze([...tools]),
      permissionRuleSets: Object.freeze([
        Object.freeze({ namespace: "web_fetch", rules: Object.freeze([]) }),
      ]),
    })),
  });
}

describe("Kernel Tool implementation demand boundary", () => {
  it("accepts one frozen exact, order-preserving implementation projection", () => {
    const implementation = port();

    const result = assembleKernelToolImplementation(implementation, request);

    expect(result.tools.map(({ name }) => name)).toEqual(["read", "web_fetch"]);
    expect(implementation.create).toHaveBeenCalledOnce();
    expect(implementation.create).toHaveBeenCalledWith(expect.objectContaining({
      requestedToolNames: request.requestedToolNames,
      skillMode: "main",
    }));
  });

  it("fails closed for duplicate demand, missing/reordered tools, or mutable output", () => {
    expect(() => assembleKernelToolImplementation(port(), {
      ...request,
      requestedToolNames: Object.freeze(["read", "read"]),
    })).toThrow(/frozen unique sequence/u);
    expect(() => assembleKernelToolImplementation(port([tool("read")]), request))
      .toThrow(/exact requested sequence/u);
    expect(() => assembleKernelToolImplementation(
      port([tool("web_fetch"), tool("read")]),
      request,
    )).toThrow(/exact requested sequence/u);
    expect(() => assembleKernelToolImplementation(Object.freeze({
      create: () => ({ tools: [], permissionRuleSets: [] }),
    }), request)).toThrow(/assembly must be frozen/u);
  });

  it("rejects mutable ports and duplicate permission namespaces", () => {
    expect(() => assembleKernelToolImplementation({
      create: port().create,
    }, request)).toThrow(/port must be frozen/u);
    expect(() => assembleKernelToolImplementation(Object.freeze({
      create: () => Object.freeze({
        tools: Object.freeze(request.requestedToolNames.map(tool)),
        permissionRuleSets: Object.freeze([
          Object.freeze({ namespace: "web_fetch", rules: Object.freeze([]) }),
          Object.freeze({ namespace: "web_fetch", rules: Object.freeze([]) }),
        ]),
      }),
    }), request)).toThrow(/frozen and unique/u);
  });
});
