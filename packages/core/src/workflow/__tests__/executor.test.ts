import { describe, expect, it } from "vitest";
import {
  DefaultNodeExecutorRegistry,
  type NodeExecutor,
} from "../executor.js";

describe("DefaultNodeExecutorRegistry", () => {
  it("registers and resolves executors by id", () => {
    const registry = new DefaultNodeExecutorRegistry();
    const executor: NodeExecutor = {
      executorId: "agent.review",
      async run() {
        return { status: "succeeded", output: "done" };
      },
    };

    registry.register(executor);

    expect(registry.has("agent.review")).toBe(true);
    expect(registry.get("agent.review")).toBe(executor);
    expect(registry.list()).toEqual([executor]);
  });

  it("rejects duplicate executor ids", () => {
    const registry = new DefaultNodeExecutorRegistry();
    const executor: NodeExecutor = {
      executorId: "agent.review",
      async run() {
        return { status: "succeeded", output: "done" };
      },
    };

    registry.register(executor);

    expect(() => registry.register(executor)).toThrow(
      'Node executor "agent.review" is already registered',
    );
  });
});
