import { describe, expect, it } from "vitest";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { addMcpServerConfiguration, loadConfig, mcpConfigurationRevision, writeConfig } from "../config-loader.js";

const entry = { type: "stdio" as const, command: "node", args: ["fixture.js"] };
async function fixture() {
  const configPath = path.join(await createTempDir("mcp-config-cas"), "config.jsonc");
  await writeConfig({ llm: { main: { provider: "openai", model: "fixture" } }, mcp: { servers: {} } }, { configPath });
  return { configPath };
}
describe("MCP configuration ownership", () => {
  it("adds once, preserves unrelated domains, and never replaces a conflicting ID", async () => {
    const options = await fixture();
    const expectedRevision = mcpConfigurationRevision(options);
    expect(await addMcpServerConfiguration("demo", entry, { ...options, expectedRevision })).toBe("added");
    expect(await addMcpServerConfiguration("demo", entry, { ...options, expectedRevision })).toBe("unchanged");
    expect(await addMcpServerConfiguration("demo", { command: "other" }, options)).toBe("conflict");
    expect(loadConfig(options).llm?.main.model).toBe("fixture");
  });
  it("does not reinstall a removed server from a delayed proposal even when values return to the original state", async () => {
    const options = await fixture();
    const expectedRevision = mcpConfigurationRevision(options);
    await addMcpServerConfiguration("demo", entry, options);
    const current = loadConfig(options);
    await writeConfig({ ...current, mcp: { servers: {} } }, { ...options, expected: current });
    expect(await addMcpServerConfiguration("demo", entry, { ...options, expectedRevision })).toBe("conflict");
  });
  it("a stale generic editor cannot erase an autonomous addition", async () => {
    const options = await fixture();
    const expected = loadConfig(options);
    await addMcpServerConfiguration("demo", entry, options);
    await expect(writeConfig(expected, { ...options, expected })).rejects.toThrow("编辑期间");
  });
});
