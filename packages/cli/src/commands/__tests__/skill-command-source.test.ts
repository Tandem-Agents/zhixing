import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { AnchorSkillGlobalStateAdapter } from "@zhixing/core/skills/global-state";
import { CommandDispatcher, DefaultCommandRegistry, type CommandDef, type RuntimeContext } from "@zhixing/core/typeahead";
import {
  SkillCatalogApplicationService,
  type SkillCatalogClient,
  type SkillCatalogEntry,
} from "@zhixing/core/skills/catalog";
import { createAnchorSkillCatalogManagementCorrectnessPort } from "@zhixing/core/skills/catalog-correctness";
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

  it("禁用技能投影为 hidden：不进发现入口，名称与别名照常注册", async () => {
    const commands = await sourceWith([
      { ...rec("deploy-service", "部署服务"), disabled: true },
      rec("review", "review"),
    ]).list();
    expect(commands).toEqual([
      expect.objectContaining({
        id: "skill:deploy-service",
        name: "deploy-service",
        aliases: ["部署服务"],
        execution: "agent",
        hidden: true,
      }),
      expect.objectContaining({ id: "skill:review", name: "review" }),
    ]);
    // 启用的技能不带 hidden，照常出现在补全与帮助
    expect(commands[1]).not.toHaveProperty("hidden");
  });

  it("禁用技能撞非技能命令时同样跳过，不以 hidden 遮蔽核心命令", async () => {
    const commands = await sourceWith(
      [{ ...rec("help", "help"), disabled: true }],
      { help: builtinCmd("help") },
    ).list();
    expect(commands).toEqual([]);
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

  /** 真实 Authority 日志 + Correctness 端口 + 管理应用，注册表接本源；用例结束删除临时根。 */
  async function withAuthorityCatalog(
    skills: readonly { name: string; description: string; body: string }[],
    body: (input: {
      application: SkillCatalogApplicationService;
      registry: DefaultCommandRegistry;
    }) => Promise<void>,
  ): Promise<void> {
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
      for (const skill of skills) {
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
      // 不固定 requestId：管理提交按请求身份幂等，禁用与启用必须是两次不同的请求
      const application = new SkillCatalogApplicationService(
        createAnchorSkillCatalogManagementCorrectnessPort({
          globalState: state,
          anchorEpoch: 1,
          now: () => new Date(NOW),
        }),
      );

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
      await body({ application, registry });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  it("正式应用查询注册动态命令并保持 builtin-first dispatch", async () => {
    await withAuthorityCatalog([
      { name: "Deploy Service", description: "部署到生产", body: "# 步骤" },
      { name: "help", description: "撞内置命令", body: "x" },
    ], async ({ registry }) => {
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
    });
  });

  it("管理提交禁用后补全与帮助不列出，按名与别名仍可调用；启用后恢复", async () => {
    await withAuthorityCatalog([
      { name: "Deploy Service", description: "部署到生产", body: "# 步骤" },
    ], async ({ application, registry }) => {
      const listed = () => registry.list(runtime).map((command) => command.name);
      expect(listed()).toContain("deploy-service");

      await application.execute({
        kind: "set-state",
        skillId: "deploy-service",
        patch: { disabled: true },
      });
      await registry.refresh();
      // 管理投影仍含禁用项（/skills 要浏览），命令源把它投影为 hidden
      expect((await application.query({ kind: "list" })).entries[0]).toMatchObject({
        id: "deploy-service",
        disabled: true,
      });
      expect(listed()).not.toContain("deploy-service");
      expect(registry.findByName("deploy-service")).toMatchObject({
        id: "skill:deploy-service",
        hidden: true,
        execution: "agent",
      });
      expect(registry.findByName("Deploy Service")?.id).toBe("skill:deploy-service");
      await expect(
        new CommandDispatcher({ registry }).dispatch("/deploy-service", runtime),
      ).resolves.toEqual({ kind: "agent-message", text: "/deploy-service" });

      await application.execute({
        kind: "set-state",
        skillId: "deploy-service",
        patch: { disabled: false },
      });
      await registry.refresh();
      expect(listed()).toContain("deploy-service");
      expect(registry.findByName("deploy-service")).not.toHaveProperty("hidden");
    });
  });
});
