import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import {
  AnchorSkillGlobalStateAdapter,
  CommandDispatcher,
  DefaultCommandRegistry,
  type CommandDef,
  type RuntimeContext,
} from "@zhixing/core";
import {
  SkillCatalogApplicationService,
  type SkillCatalogClient,
  type SkillCatalogEntry,
} from "@zhixing/core/skills/catalog";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "@zhixing/core/authority";
import {
  SkillCommandSource,
} from "../skill-command-source.js";

const NOW = "2026-08-29T00:00:00.000Z";

function rec(
  id: string,
  name: string,
  description = "desc",
): SkillCatalogEntry {
  return {
    id,
    name,
    description,
    source: "own",
    mode: "main",
    pinned: false,
    disabled: false,
    createdAt: NOW,
    usage: null,
    contentRef: { digest: `sha256:${"0".repeat(64)}`, bytes: 1 },
    revision: 1,
    digest: `sha256:${"f".repeat(64)}`,
  };
}

function sourceWith(
  skills: SkillCatalogEntry[],
  existing: Record<string, CommandDef> = {},
): SkillCommandSource {
  return new SkillCommandSource({
    client: clientWith(skills),
    findExisting: (name) => existing[name] ?? null,
  });
}

function clientWith(entries: readonly SkillCatalogEntry[]): SkillCatalogClient {
  return {
    query: async () => ({ entries, catalogRevision: 1 }),
    command: async () => {},
    onFact: () => () => {},
  };
}

const builtinCmd = (name: string): CommandDef => ({
  id: `${name}:repl`,
  name,
  description: "builtin",
  category: "info",
  execution: "local",
});

const ownSkillCmd = (id: string): CommandDef => ({
  id: `skill:${id}`,
  name: id,
  description: "skill",
  category: "plugin",
  execution: "agent",
});

describe("SkillCommandSource", () => {
  it("source id 为 'skill'", () => {
    expect(sourceWith([]).id).toBe("skill");
  });

  it("空 catalog → 空命令列表", async () => {
    expect(await sourceWith([]).list()).toEqual([]);
  });

  it("技能映射为 execution:agent 的 plugin 命令", async () => {
    const commands = await sourceWith([
      rec("deploy", "deploy", "部署到生产"),
    ]).list();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      name: "deploy",
      id: "skill:deploy",
      execution: "agent",
      category: "plugin",
      tag: "plugin",
      description: "部署到生产",
    });
  });

  it("原始 name 与 id 不同则保留 alias", async () => {
    const commands = await sourceWith([
      rec("deploy-service", "Deploy Service"),
      rec("review", "review"),
    ]).list();
    expect(commands[0]!.aliases).toEqual(["Deploy Service"]);
    expect(commands[1]!.aliases).toBeUndefined();
  });

  it("技能 id 撞非技能命令时核心命令优先", async () => {
    const commands = await sourceWith(
      [rec("help", "help"), rec("deploy", "deploy")],
      { help: builtinCmd("help") },
    ).list();
    expect(commands.map((command) => command.name)).toEqual(["deploy"]);
  });

  it("上一轮本源命令不产生自抑制", async () => {
    const commands = await sourceWith([rec("deploy", "deploy")], {
      deploy: ownSkillCmd("deploy"),
    }).list();
    expect(commands.map((command) => command.id)).toEqual(["skill:deploy"]);
  });
});

describe("SkillCommandSource · Authority Catalog 集成", () => {
  const runtime: RuntimeContext = {
    sessionBusy: false,
    workspaceId: null,
    cwd: ".",
    target: "cli",
    features: {},
    now: 0,
  };

  it("正式应用查询注册动态命令并保持 builtin-first dispatch", async () => {
    const root = await createTempDir("skill-command-authority");
    try {
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
        clock: () => NOW,
      });
      const state = new AnchorSkillGlobalStateAdapter({
        log,
        anchorEpoch: 1,
        clock: () => NOW,
      });
      for (const skill of [
        { name: "Deploy Service", description: "部署到生产", body: "# 步骤" },
        { name: "help", description: "撞内置命令", body: "x" },
      ]) {
        const content = await artifacts.put(Buffer.from(
          `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n${skill.body}`,
        ));
        await state.mutate(
          {
            kind: "skill-create",
            mode: "main",
            record: {
              name: skill.name,
              description: skill.description,
              content,
            },
          },
          {
            principal: { kind: "host", component: "skill-command-test" },
            requestId: `create:${skill.name}`,
            deadlineAt: "2026-08-29T01:00:00.000Z",
            authority: { domain: "global", anchorEpoch: 1 },
          },
        );
      }
      const application = new SkillCatalogApplicationService({
        globalState: state,
        anchorEpoch: 1,
        requestId: () => "list",
        now: () => new Date(NOW),
      });

      const registry = new DefaultCommandRegistry();
      registry.register({
        id: "help:repl",
        name: "help",
        description: "内置帮助",
        category: "info",
        execution: "local",
      });
      registry.registerDynamicSource(new SkillCommandSource({
        client: {
          query: (query) => application.query(query),
          command: async (command) => {
            await application.execute(command);
          },
          onFact: () => () => {},
        },
        findExisting: (name) => registry.findByName(name),
      }));
      await registry.refresh();

      expect(registry.findByName("deploy-service")).toMatchObject({
        id: "skill:deploy-service",
        execution: "agent",
      });
      expect(registry.findByName("help")?.id).toBe("help:repl");
      await expect(
        new CommandDispatcher({ registry }).dispatch("/deploy-service", runtime),
      ).resolves.toEqual({
        kind: "agent-message",
        text: "/deploy-service",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
