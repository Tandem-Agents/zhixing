import { describe, expect, it } from "vitest";
import { parseServerSpecs } from "../mcp-config.js";

describe("parseServerSpecs", () => {
  it("undefined / 空表 → []", () => {
    expect(parseServerSpecs(undefined)).toEqual([]);
    expect(parseServerSpecs({})).toEqual([]);
    expect(parseServerSpecs({ servers: {} })).toEqual([]);
  });

  it("type 缺省 stdio，透传 command / args", () => {
    expect(
      parseServerSpecs({
        servers: { github: { command: "uvx", args: ["mcp-server-github"] } },
      }),
    ).toEqual([
      {
        serverId: "github",
        transport: "stdio",
        command: "uvx",
        args: ["mcp-server-github"],
      },
    ]);
  });

  it("http server 透传 url", () => {
    expect(
      parseServerSpecs({
        servers: { remote: { type: "http", url: "https://example.com/mcp" } },
      }),
    ).toEqual([
      { serverId: "remote", transport: "http", url: "https://example.com/mcp" },
    ]);
  });

  it("enabled:false 的 server 被跳过", () => {
    expect(
      parseServerSpecs({ servers: { off: { command: "x", enabled: false } } }),
    ).toEqual([]);
  });

  it("非法 serverId 被跳过（防工具命名错位）", () => {
    expect(parseServerSpecs({ servers: { bad__id: { command: "x" } } })).toEqual(
      [],
    );
  });

  it("多 server 仅保留启用且合法的，顺序稳定", () => {
    const specs = parseServerSpecs({
      servers: {
        github: { command: "a" },
        notion: { command: "b", enabled: true },
        disabled: { command: "c", enabled: false },
      },
    });
    expect(specs.map((s) => s.serverId)).toEqual(["github", "notion"]);
  });
});
