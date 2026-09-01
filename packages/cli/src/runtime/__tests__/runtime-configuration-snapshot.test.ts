import type { ZhixingConfig } from "@zhixing/providers";
import { describe, expect, it } from "vitest";
import { createRuntimeConfigurationSnapshot } from "../runtime-configuration-snapshot.js";

describe("runtime configuration snapshot", () => {
  it("deep-clones and recursively freezes the validated configuration shape", () => {
    const source: ZhixingConfig = {
      llm: {
        main: { provider: "main", model: "model-main" },
        light: { provider: "light", model: "model-light" },
      },
      messaging: {
        chat: {
          type: "feishu",
          options: { labels: ["one", "two"] },
          defaultTarget: { to: "owner" },
        },
      },
      mcp: {
        servers: {
          docs: {
            type: "stdio",
            command: "node",
            args: ["server.js"],
            tools: { include: ["search"] },
          },
        },
      },
      workspace: {
        root: "C:\\workspace",
        protectedPaths: ["private"],
      },
      intent: { cancelKeywords: ["停止"] },
      network: { proxy: "off" },
    };

    const snapshot = createRuntimeConfigurationSnapshot(source);

    expect(snapshot).toEqual(source);
    expect(snapshot).not.toBe(source);
    expect(snapshot.llm).not.toBe(source.llm);
    expect(snapshot.messaging).not.toBe(source.messaging);
    expect(snapshot.mcp?.servers?.docs?.args).not.toBe(
      source.mcp?.servers?.docs?.args,
    );
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.llm)).toBe(true);
    expect(Object.isFrozen(snapshot.messaging?.chat?.options)).toBe(true);
    expect(
      Object.isFrozen(snapshot.mcp?.servers?.docs?.tools?.include),
    ).toBe(true);
    expect(Object.isFrozen(snapshot.workspace?.protectedPaths)).toBe(true);
    expect(Object.isFrozen(snapshot.intent?.cancelKeywords)).toBe(true);

    source.llm!.main.model = "changed-after-publication";
    source.mcp!.servers!.docs!.args!.push("changed");
    expect(snapshot.llm?.main.model).toBe("model-main");
    expect(snapshot.mcp?.servers?.docs?.args).toEqual(["server.js"]);
    expect(() => {
      snapshot.llm!.main.model = "runtime-mutation";
    }).toThrow();
    expect(() => {
      snapshot.intent!.cancelKeywords!.push("runtime-mutation");
    }).toThrow();
  });

  it("preserves absence and undefined without adding defaults", () => {
    const snapshot = createRuntimeConfigurationSnapshot({
      network: { proxy: undefined },
    });

    expect(snapshot).toEqual({ network: { proxy: undefined } });
    expect("llm" in snapshot).toBe(false);
    expect(Object.isFrozen(snapshot.network)).toBe(true);
  });
});
