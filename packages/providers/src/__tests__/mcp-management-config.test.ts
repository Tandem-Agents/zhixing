import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { addMcpServerConfiguration, editMcpServerConfiguration, loadConfig, mcpConfigurationRevision, writeConfig } from "../config-loader.js";

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
    await editMcpServerConfiguration({ demo: entry }, {}, { ...options, saveCredentials: async () => {} });
    expect(await addMcpServerConfiguration("demo", entry, { ...options, expectedRevision })).toBe("conflict");
  });
  it("an open editor cannot overwrite a newly connected service or change credentials on conflict", async () => {
    const options = await fixture();
    await addMcpServerConfiguration("demo", entry, options);
    const saveCredentials = vi.fn();
    await expect(editMcpServerConfiguration({}, {}, { ...options, saveCredentials })).rejects.toThrow("编辑期间");
    expect(saveCredentials).not.toHaveBeenCalled();
    expect(loadConfig(options).mcp?.servers).toEqual({ demo: entry });
  });
  it("a failed credential commit cannot publish the proposed configuration", async () => {
    const options = await fixture();
    await expect(editMcpServerConfiguration({}, { demo: entry }, { ...options, saveCredentials: async () => { throw new Error("store unavailable"); } })).rejects.toThrow();
    expect(loadConfig(options).mcp?.servers).toEqual({});
  });
  it("a stale generic editor cannot erase an autonomous addition", async () => {
    const options = await fixture();
    const expected = loadConfig(options);
    await addMcpServerConfiguration("demo", entry, options);
    await expect(writeConfig(expected, { ...options, expected })).rejects.toThrow("编辑期间");
  });
});
