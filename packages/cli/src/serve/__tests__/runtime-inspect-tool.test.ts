import { Buffer } from "node:buffer";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createTempDir } from "@zhixing-ai/test-utils";
import { localConversationId } from "@zhixing-ai/core/conversation";
import { getBuiltinSkill } from "@zhixing-ai/core/skills/catalog";
import { runContextStorage } from "@zhixing-ai/orchestrator/runtime";
import { BUILTIN_COMMANDS } from "../../commands/builtin-definitions.js";
import { SHIPPED_LOG_SOURCES } from "../../logging/access.js";
import { validateCandidatePayload } from "../../runtime/extensions/validate-candidate.js";
import {
  createHomeBoundHealthBinding,
  createRuntimeInspectTool,
  RUNTIME_INSPECT_MAX_BYTES,
  type RuntimeInspectDeps,
} from "../runtime-inspect-tool.js";
import { createBackupTargetConfigurationInfrastructure } from "../backup-target-config-infrastructure.js";
import { resolveRuntimeSessionKind } from "../session-surface-kind.js";

function baseDeps(overrides: Partial<RuntimeInspectDeps> = {}): RuntimeInspectDeps {
  return {
    version: "0.1.0-test",
    deviceRoles: () => ["anchor", "executor"],
    executionRole: () => "hybrid",
    anchorReachable: () => true,
    mcpServerIds: () => ["alpha", "beta"],
    listWorkspaces: async () => [
      { deviceName: "主工作站", workspaceName: "默认项目" },
      { deviceName: "便携本", workspaceName: "默认项目" },
    ],
    readModels: async () => ({
      roleSummary: {
        main: { source: "configured", ready: true },
        light: { source: "configured", ready: true },
        power: { source: "configured", ready: false },
      },
      sessionSelectionMode: "default",
      dispatchSelectionMode: "fixed",
    }),
    inspectHealth: async () => ({
      processStatus: "running",
      healthCode: "healthy",
    }),
    ...overrides,
  };
}

describe("resolveRuntimeSessionKind & runtime_inspect", () => {
  it("enforces the channel union gate for both intrinsic channel IDs and shared default DM channel turns", async () => {
    const tool = createRuntimeInspectTool(baseDeps());

    // 1) Intrinsic channel conversation ID triggered via first-party RPC turnOrigin
    const groupKind = await runContextStorage.run(
      {
        conversationId: "feishu:group:oc_group_1",
        lineage: "main",
        runtimeKind: "conversation",
        toolNames: ["runtime_inspect", "log_search", "workscene_change_approve"],
        turnOrigin: {
          channel: "rpc",
          messageIdentity: { id: "m1", source: { kind: "program" } },
        },
      } as never,
      async () => ({
        kind: resolveRuntimeSessionKind(runContextStorage.getStore()),
        summary: JSON.parse((await tool.call({}, {} as never)).content),
        workspaces: JSON.parse((await tool.call({ scope: "workspaces" }, {} as never)).content),
        models: JSON.parse((await tool.call({ scope: "models" }, {} as never)).content),
        health: JSON.parse((await tool.call({ scope: "health" }, {} as never)).content),
      }),
    );

    expect(groupKind.kind).toBe("channel");
    expect(groupKind.summary).toMatchObject({
      sessionKind: "channel",
      availableScopes: ["summary"],
      logAccess: { mode: "conversation", filterableRefKinds: ["conversation"] },
    });
    expect(groupKind.workspaces).toEqual({ availability: "ineligible", items: [] });
    expect(groupKind.models).toEqual({ availability: "ineligible" });
    expect(groupKind.health).toEqual({ availability: "ineligible" });

    // 2) Shared "default" conversation carrying a Feishu DM channel turnOrigin
    const dmKind = await runContextStorage.run(
      {
        conversationId: "default",
        lineage: "main",
        runtimeKind: "conversation",
        toolNames: ["runtime_inspect", "log_read", "workscene_change_approve"],
        turnOrigin: {
          channel: "feishu",
          target: { channelId: "feishu:bot-1", to: "ou_secret_dm_user" },
          messageIdentity: { id: "m2", source: { kind: "channel", channelId: "feishu" } },
        },
      } as never,
      async () => ({
        kind: resolveRuntimeSessionKind(runContextStorage.getStore()),
        summary: JSON.parse((await tool.call({ scope: "summary" }, {} as never)).content),
        workspaces: JSON.parse((await tool.call({ scope: "workspaces" }, {} as never)).content),
      }),
    );

    expect(dmKind.kind).toBe("channel");
    expect(dmKind.summary.availableScopes).toEqual(["summary"]);
    expect(dmKind.workspaces).toEqual({ availability: "ineligible", items: [] });
  });

  it("intersects mountedMcpServers strictly with frozen run.toolNames and covers models & workspaces gates", async () => {
    const tool = createRuntimeInspectTool(baseDeps());

    const mainResult = await runContextStorage.run(
      {
        conversationId: "default",
        lineage: "main",
        runtimeKind: "conversation",
        lineageRole: "main",
        effectivePrimaryRole: "main",
        hasAuthorizedWorkspace: false,
        toolNames: ["runtime_inspect", "mcp__alpha__ping", "workscene_change_approve", "log_search"],
      } as never,
      async () => ({
        summary: JSON.parse((await tool.call({}, {} as never)).content),
        workspaces: JSON.parse((await tool.call({ scope: "workspaces" }, {} as never)).content),
        models: JSON.parse((await tool.call({ scope: "models" }, {} as never)).content),
      }),
    );

    expect(mainResult.summary.mountedMcpServers).toEqual(["alpha"]);
    expect(mainResult.summary.logAccess).toEqual({
      mode: "storage",
      filterableRefKinds: [
        "conversation",
        "toolCall",
        "extension",
        "operation",
        "delivery",
        "modelAttempt",
        "task",
        "generation",
      ],
    });
    expect(mainResult.summary.availableScopes).toEqual(["summary", "workspaces", "models", "health"]);
    expect(mainResult.workspaces).toMatchObject({
      availability: "ok",
      totalCount: 2,
      omittedCount: 0,
      items: [
        { deviceName: "便携本", workspaceName: "默认项目", ambiguous: true },
        { deviceName: "主工作站", workspaceName: "默认项目", ambiguous: true },
      ],
    });
    expect(mainResult.models).toEqual({
      availability: "ok",
      effectivePrimaryRole: "main",
      roleSummary: {
        main: { source: "configured", ready: true },
        light: { source: "configured", ready: true },
        power: { source: "configured", ready: false },
      },
      sessionSelectionMode: "default",
      dispatchSelectionMode: "fixed",
    });
    expect(JSON.stringify(mainResult)).not.toMatch(/sk-|apiKey|baseURL|connectionId/i);

    // Without workspace selection tool, workspaces scope returns ineligible
    const noWsGate = await runContextStorage.run(
      {
        conversationId: "default",
        lineage: "main",
        runtimeKind: "conversation",
        toolNames: ["runtime_inspect"],
      } as never,
      async () => JSON.parse((await tool.call({ scope: "workspaces" }, {} as never)).content),
    );
    expect(noWsGate).toEqual({ availability: "ineligible", items: [] });

    // Local conversation returns models ok but workspaces ineligible
    const localResult = await runContextStorage.run(
      {
        conversationId: localConversationId("dev-local-1", "01J00000000000000000000001"),
        lineage: "main",
        runtimeKind: "conversation",
        toolNames: ["runtime_inspect", "workscene_change_approve"],
      } as never,
      async () => ({
        kind: resolveRuntimeSessionKind(runContextStorage.getStore()),
        workspaces: JSON.parse((await tool.call({ scope: "workspaces" }, {} as never)).content),
        models: JSON.parse((await tool.call({ scope: "models" }, {} as never)).content),
      }),
    );
    expect(localResult.kind).toBe("local");
    expect(localResult.workspaces).toEqual({ availability: "ineligible", items: [] });
    expect(localResult.models.availability).toBe("ok");
  });

  it("enforces <= 6144 UTF-8 byte budget on summary and paginates workspaces with long names without looping", async () => {
    const oversizedTools = Array.from({ length: 300 }, (_, i) => `tool_number_${i}_${"x".repeat(25)}`);
    const longWorkspaces = Array.from({ length: 10 }, (_, i) => ({
      deviceName: `device-${i}-${"D".repeat(4000)}`,
      workspaceName: `workspace-${i}-${"W".repeat(4000)}`,
    }));
    const tool = createRuntimeInspectTool(baseDeps({ listWorkspaces: async () => longWorkspaces }));

    const summaryRes = await runContextStorage.run(
      {
        conversationId: "default",
        lineage: "main",
        runtimeKind: "conversation",
        toolNames: oversizedTools,
      } as never,
      () => tool.call({ scope: "summary" }, {} as never),
    );
    expect(Buffer.byteLength(summaryRes.content, "utf8")).toBeLessThanOrEqual(RUNTIME_INSPECT_MAX_BYTES);
    const summaryJson = JSON.parse(summaryRes.content);
    expect(summaryJson.toolsPagination.totalCount).toBe(300);
    expect(summaryJson.toolsPagination.omittedCount).toBeGreaterThan(0);

    // Reject cursor on non-workspaces scopes
    const badCursor = await tool.call({ scope: "summary", cursor: "abc" }, {} as never);
    expect(badCursor.isError).toBe(true);

    // Paginate through all 10 oversized workspace entries and guarantee strict termination
    const collected: Array<{ deviceName: string; workspaceName: string; truncatedDisplay?: boolean }> = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const pageRes = await runContextStorage.run(
        {
          conversationId: "default",
          lineage: "main",
          runtimeKind: "conversation",
          toolNames: ["runtime_inspect", "workscene_change_approve"],
        } as never,
        () => tool.call({ scope: "workspaces", ...(cursor ? { cursor } : {}) }, {} as never),
      );
      expect(Buffer.byteLength(pageRes.content, "utf8")).toBeLessThanOrEqual(RUNTIME_INSPECT_MAX_BYTES);
      const parsed = JSON.parse(pageRes.content);
      expect(parsed.availability).toBe("ok");
      expect(parsed.items.length).toBeGreaterThanOrEqual(1);
      collected.push(...parsed.items);
      cursor = parsed.nextCursor;
      pages += 1;
    } while (cursor && pages < 50);

    expect(cursor).toBeUndefined();
    expect(collected).toHaveLength(10);
    expect(collected.some((item) => item.truncatedDisplay === true)).toBe(true);
  });

  it("binds health check explicitly to supplied zhixingHome without leaking PID, port or backup paths", async () => {
    const tempHome = await createTempDir("inspect-health-isolated");
    try {
      const tool = createRuntimeInspectTool(
        baseDeps({
          inspectHealth: undefined,
          healthBinding: createHomeBoundHealthBinding(
            tempHome,
            createBackupTargetConfigurationInfrastructure(tempHome),
          ),
        }),
      );
      const healthRes = await runContextStorage.run(
        {
          conversationId: "default",
          lineage: "main",
          runtimeKind: "conversation",
          toolNames: ["runtime_inspect"],
        } as never,
        () => tool.call({ scope: "health" }, {} as never),
      );
      expect(healthRes.isError).not.toBe(true);
      const parsed = JSON.parse(healthRes.content);
      expect(parsed).toEqual({
        availability: "ok",
        processStatus: "stopped",
        healthCode: "setup-required",
      });
      expect(Object.keys(parsed).sort()).toEqual(["availability", "healthCode", "processStatus"]);
      expect(healthRes.content).not.toContain(tempHome);

      const unavailTool = createRuntimeInspectTool(baseDeps({ inspectHealth: undefined, healthBinding: undefined }));
      const unavailRes = await runContextStorage.run(
        { conversationId: "default", lineage: "main", runtimeKind: "conversation", toolNames: ["runtime_inspect"] } as never,
        () => unavailTool.call({ scope: "health" }, {} as never),
      );
      expect(JSON.parse(unavailRes.content)).toEqual({ availability: "unavailable" });
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });
});

describe("Wave 5.3 system:* builtin skill packages parity & offline compilation", () => {
  it("keeps system:知行系统认知 strictly aligned with BUILTIN_COMMANDS, CLI commands and SHIPPED_LOG_SOURCES", () => {
    const pkg = getBuiltinSkill("知行系统认知");
    expect(pkg).not.toBeNull();
    expect(pkg!.tools).toEqual(["runtime_inspect"]);

    const commandsDoc = pkg!.resources.find((r) => r.path === "commands-and-surfaces.md")?.content ?? "";
    for (const def of Object.values(BUILTIN_COMMANDS)) {
      expect(commandsDoc).toContain(`\`/${def.name}\``);
      if ("aliases" in def && Array.isArray(def.aliases)) {
        for (const alias of def.aliases) {
          expect(commandsDoc).toContain(`\`/${alias}\``);
        }
      }
    }
    for (const cliGroup of [
      "zz status",
      "zz stop",
      "zz doctor",
      "zz logs location|search|read|policy",
      "zz app remove",
      "zz pair",
      "zz device list|remove|continue|status",
      "zz duty targets|migrate|continue|cancel",
      "zz backup setup|verify|status|recover|recover-finish",
      "zz backup root rotate|invalidate|approve-reset|reset",
      "zz workspace status|list|create|create-scene|rename|repath|remove|reset",
      "zz conversation list|new|read|send|result",
    ]) {
      expect(commandsDoc).toContain(cliGroup);
    }
    expect(commandsDoc).toContain("飞书");
    expect(commandsDoc).toContain("严禁直接在聊天消息里让用户点或输入 `/config`、`/mcp`");

    const logsDoc = pkg!.resources.find((r) => r.path === "diagnostics-and-logs.md")?.content ?? "";
    for (const source of SHIPPED_LOG_SOURCES) {
      expect(logsDoc).toContain(`\`${source}\``);
    }
  });

  it("materializes system:外部能力接入 into an isolated temp directory and compiles examples/starter-channel.ts cleanly with tsc", async () => {
    const pkg = getBuiltinSkill("外部能力接入");
    expect(pkg).not.toBeNull();
    expect(pkg!.resources.length + 1).toBeLessThanOrEqual(64);
    for (const res of pkg!.resources) {
      expect(res.path.split("/").length).toBeLessThanOrEqual(6);
      expect(Buffer.from(res.content, "utf8").includes(0)).toBe(false);
    }
    for (const negPath of [
      "examples/bad-1-missing-field.json",
      "examples/bad-2-export-shape.mjs",
      "examples/bad-3-digest-mismatch.json",
      "examples/bad-4-syntax-error.mjs",
    ]) {
      expect(pkg!.resources.some((r) => r.path === negPath)).toBe(true);
    }

    const tempDir = await createTempDir("ext-kit-offline-tsc");
    try {
      for (const res of pkg!.resources) {
        if (!res.path.startsWith("kit/") && !res.path.startsWith("examples/")) continue;
        const target = path.join(tempDir, res.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, res.content, "utf8");
      }

      const starterPath = path.join(tempDir, "examples", "starter-channel.ts");
      const program = ts.createProgram([starterPath], {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      });
      const diagnostics = ts.getPreEmitDiagnostics(program);
      const formatted = ts.formatDiagnostics(diagnostics, {
        getCanonicalFileName: (f) => f,
        getCurrentDirectory: () => tempDir,
        getNewLine: () => "\n",
      });
      expect(formatted).toBe("");

      // Verify validateCandidatePayload rejects bad-1-missing-field and bad-3-digest-mismatch
      const bad1 = JSON.parse(
        pkg!.resources.find((r) => r.path === "examples/bad-1-missing-field.json")!.content,
      );
      await expect(
        validateCandidatePayload({ manifest: bad1, code: "export {};", provenance: { url: "https://example.com", revision: "1", kind: "authored" }, sources: {}, build: "node" }),
      ).rejects.toThrow();

      const bad3 = JSON.parse(
        pkg!.resources.find((r) => r.path === "examples/bad-3-digest-mismatch.json")!.content,
      );
      await expect(validateCandidatePayload(bad3)).rejects.toThrow();

      const bad4Syntax = pkg!.resources.find((r) => r.path === "examples/bad-4-syntax-error.mjs")!.content;
      const manifest = JSON.parse(pkg!.resources.find((r) => r.path === "examples/manifest.json")!.content);
      await expect(
        validateCandidatePayload({
          manifest,
          code: bad4Syntax,
          provenance: { url: "https://example.com", revision: "1", kind: "authored" },
          sources: { "index.mjs": bad4Syntax },
          build: "node",
        }),
      ).rejects.toThrow();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 20_000);
});
