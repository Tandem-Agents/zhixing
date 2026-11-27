import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createTempDir } from "@zhixing-ai/test-utils";
import { DEFAULT_LOG_POLICY } from "@zhixing-ai/core/logging";
import { LocalLogStore, type LogFileInfo, type LogFileSystem } from "@zhixing-ai/core/logging/storage";
import {
  DefaultDeviceCapacityArbiter,
  createDefaultDeviceCapacityPolicy,
} from "@zhixing-ai/core/resources";
import { getBuiltinSkill } from "@zhixing-ai/core/skills/catalog";
import { BUILTIN_COMMANDS } from "../commands/builtin-definitions.js";
import { SHIPPED_LOG_SOURCES, createLocalLogProductApi, createLogAccess } from "../logging/access.js";
import { createRuntimeLogTools } from "../logging/tools.js";
import { createExtensionManagementHandle, createExtensionTools } from "../serve/extension-tools.js";
import { createMcpManagementTools } from "../serve/mcp-tools.js";
import { runContextStorage } from "@zhixing-ai/orchestrator/runtime";

function memoryLogFiles(): LogFileSystem {
  const files = new Map<string, Buffer>();
  let locked = false;
  const enoent = (name: string) =>
    Object.assign(new Error(`ENOENT: ${name}`), { code: "ENOENT" });
  const info = (name: string, buf: Buffer): LogFileInfo => ({
    bytes: buf.byteLength,
    identity: `mem:${name}`,
  });
  return {
    async open() {},
    async list(limit) {
      return [...files.keys()].sort().slice(0, limit);
    },
    async stat(name) {
      const buf = files.get(name);
      if (!buf) throw enoent(name);
      return info(name, buf);
    },
    async read(name, size, offset, limit) {
      const buf = files.get(name);
      if (!buf || buf.byteLength !== size) throw enoent(name);
      return Buffer.from(buf.subarray(offset, offset + limit));
    },
    async write(name, bytes) {
      files.set(name, Buffer.from(bytes));
    },
    async append(name, _identity, offset, bytes) {
      const cur = files.get(name) ?? Buffer.alloc(0);
      if (cur.byteLength !== offset) throw new Error("offset mismatch");
      files.set(name, Buffer.concat([cur, Buffer.from(bytes)]));
    },
    async rename(from, to) {
      const buf = files.get(from);
      if (!buf) throw enoent(from);
      files.set(to, buf);
      files.delete(from);
    },
    async truncate(name, _identity, bytes) {
      const cur = files.get(name);
      if (!cur) throw enoent(name);
      files.set(name, Buffer.from(cur.subarray(0, bytes)));
    },
    async remove(name) {
      files.delete(name);
    },
    async sync() {},
    async tryLock() {
      if (locked) return false;
      if (!files.has("writer.lock")) files.set("writer.lock", Buffer.alloc(0));
      locked = true;
      return true;
    },
    async tryReadLock() {
      return !locked;
    },
    async unlock() {
      locked = false;
    },
    async close() {},
  };
}

describe("builtin skill 知行系统认知 authoritative sync", () => {
  it("matches SHIPPED_LOG_SOURCES, BUILTIN_COMMANDS, mcp_discover actions, and extension actions as exact sets", () => {
    const skill = getBuiltinSkill("知行系统认知");
    expect(skill).not.toBeNull();
    const resources = new Map(skill!.resources.map((r) => [r.path, r.content]));

    const diagDoc = resources.get("diagnostics-and-logs.md")!;
    const versionedMatches = new Set(
      [...diagDoc.matchAll(/`([a-z-]+:\d+)`/g)].map((m) => m[1]!),
    );
    expect(versionedMatches).toEqual(new Set(SHIPPED_LOG_SOURCES));

    const bareSection = diagDoc.split("## 2.")[0] ?? "";
    const bareMatches = new Set(
      [...bareSection.matchAll(/^- `([a-z-]+)`$/gm)].map((m) => m[1]!),
    );
    const expectedBare = new Set(SHIPPED_LOG_SOURCES.map((s) => s.split(":")[0]!));
    expect(bareMatches).toEqual(expectedBare);
    expect(diagDoc).toContain('log_search({ "filter": { "source": "mcp", "level": "error" } })');
    expect(diagDoc).toContain('log_search({ "filter": { "source": "kernel", "level": "error" } })');

    const cmdDoc = resources.get("commands-and-surfaces.md")!;
    const documentedCommands = new Set(
      [...cmdDoc.matchAll(/^- `\/([a-z]+)`/gm)].map((m) => m[1]!),
    );
    const authoritativeCommands = new Set(Object.values(BUILTIN_COMMANDS).map((c) => c.name));
    expect(documentedCommands).toEqual(authoritativeCommands);

    const mcpTools = createMcpManagementTools(
      {
        search: async () => [],
        readSource: async () => ({ content: "" }),
        snapshot: async () => [],
      } as never,
      { deviceId: "dev-1", revision: () => "r1" },
    );
    const mcpDiscover = mcpTools.find((t) => t.name === "mcp_discover")!;
    const mcpActions = ((mcpDiscover.inputSchema as { properties: { action: { enum: string[] } } }).properties.action.enum);
    const mcpDoc = resources.get("mcp-and-extensions.md")!;
    const docMcpActions = new Set([...mcpDoc.matchAll(/^\s*- `(search|source|presets|status|pending)`/gm)].map((m) => m[1]!));
    // Note: search / source share a bullet line; match all inline code tokens inside the bullet block
    const mcpBulletsBlock = mcpDoc.split("## 受管扩展生命周期")[0] ?? "";
    const docMcpTokens = new Set([...mcpBulletsBlock.matchAll(/`(search|source|presets|status|pending)`/g)].map((m) => m[1]!));
    expect(docMcpTokens).toEqual(new Set(mcpActions));
    expect(mcpDoc).toContain(`支持 ${mcpActions.length} 个动作`);
    void docMcpActions;

    const extTools = createExtensionTools(createExtensionManagementHandle().port);
    const extTool = extTools.find((t) => t.name === "extension")!;
    const extActions = ((extTool.inputSchema as { properties: { action: { enum: string[] } } }).properties.action.enum);
    for (const action of extActions) {
      expect(mcpDoc).toContain(`\`${action}\``);
    }
  });

  it("queries { source: 'mcp', sourceVersion: 2 } cleanly using filter: { source: 'mcp' } from diagnostics-and-logs.md", async () => {
    const tempHome = await createTempDir("builtin-sync-logs");
    try {
      const capacity = new DefaultDeviceCapacityArbiter({
        policy: createDefaultDeviceCapacityPolicy(),
        probe: () => ({
          cpuBusyRatio: 0,
          availableMemoryBytes: 1024 ** 3,
          processRssBytes: 1024 ** 2,
          temporaryBytesAvailable: 1024 ** 3,
        }),
      });
      const files = memoryLogFiles();
      const writer = new LocalLogStore({ files, capacity, initialPolicy: DEFAULT_LOG_POLICY });
      await writer.initialize();
      await writer.append([{
        record: {
          schema: 1,
          id: "00000000-0000-4000-8000-000000000001",
          process: "host",
          seq: 1,
          occurredAt: Date.now(),
          source: "mcp",
          sourceVersion: 2,
          event: "connectFailed",
          level: "error",
          tier: "critical",
          refs: [],
          access: { scope: "storage" },
          message: "mcp connect failed",
          result: "failure",
          data: { server: "alpha", stage: "connect", reason: "http-401" },
        },
      }]);
      await writer.close();

      const access = createLogAccess(tempHome, capacity, files);
      const api = createLocalLogProductApi(access);
      const searchTool = createRuntimeLogTools(() => api).find((t) => t.name === "log_search")!;
      try {
        const res = await runContextStorage.run(
          { conversationId: "default", lineage: "main" } as never,
          () => searchTool.call({ filter: { source: "mcp", level: "error" } }, {} as never),
        );
        expect(res.isError).not.toBe(true);
        const parsed = JSON.parse(res.content) as { records: Array<{ id: string; source: string; sourceVersion: number }> };
        expect(parsed.records).toHaveLength(1);
        expect(parsed.records[0]).toMatchObject({
          id: "00000000-0000-4000-8000-000000000001",
          source: "mcp",
          sourceVersion: 2,
        });
      } finally {
        await access.close();
      }
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });
});
