import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { describe, it, expect } from "vitest";
import { SkillCommandSource } from "../skill-command-source.js";
import {
  SkillStore,
  DefaultCommandRegistry,
  type CommandDef,
  type RuntimeContext,
  type SkillRecord,
} from "@zhixing/core";
import { CommandDispatcher } from "../../command-dispatcher.js";

function rec(id: string, name: string, description = "desc"): SkillRecord {
  return {
    id,
    name,
    description,
    source: "own",
    dir: `/skills/own/${id}`,
    mode: "main",
    pinned: false,
    disabled: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function sourceWith(
  skills: SkillRecord[],
  existing: Record<string, CommandDef> = {},
): SkillCommandSource {
  return new SkillCommandSource({
    listAll: async () => skills,
    findExisting: (name) => existing[name] ?? null,
  });
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

  it("空库 → 空命令列表", async () => {
    expect(await sourceWith([]).list()).toEqual([]);
  });

  it("技能映射为 execution:agent 的 plugin 命令(name=id、id 命名空间化、无 handler)", async () => {
    const cmds = await sourceWith([rec("deploy", "deploy", "部署到生产")]).list();
    expect(cmds).toHaveLength(1);
    const c = cmds[0]!;
    expect(c.name).toBe("deploy");
    expect(c.id).toBe("skill:deploy");
    expect(c.execution).toBe("agent");
    expect(c.category).toBe("plugin");
    expect(c.tag).toBe("plugin");
    expect(c.description).toBe("部署到生产");
    expect(c.handler).toBeUndefined();
  });

  it("原始 name 与 id 不同 → aliases 保留原名;相同 → 无 aliases", async () => {
    const cmds = await sourceWith([
      rec("deploy-service", "Deploy Service"),
      rec("review", "review"),
    ]).list();
    expect(cmds[0]!.aliases).toEqual(["Deploy Service"]);
    expect(cmds[1]!.aliases).toBeUndefined();
  });

  it("技能 id 撞非技能命令(builtin)→ 跳过、不注册为 slash 命令(核心命令优先)", async () => {
    const cmds = await sourceWith([rec("help", "help"), rec("deploy", "deploy")], {
      help: builtinCmd("help"),
    }).list();
    expect(cmds.map((c) => c.name)).toEqual(["deploy"]);
  });

  it("findExisting 命中的是本源上一轮的 skill: 命令 → 不自抑制(仍注册)", async () => {
    const cmds = await sourceWith([rec("deploy", "deploy")], {
      deploy: ownSkillCmd("deploy"),
    }).list();
    expect(cmds.map((c) => c.id)).toEqual(["skill:deploy"]);
  });
});

describe("SkillCommandSource · 集成(真实 SkillStore + registry + dispatcher)", () => {
  const RUNTIME: RuntimeContext = {
    sessionBusy: false,
    workspaceId: null,
    cwd: ".",
    target: "cli",
    features: {},
    now: 0,
  };

  it("真实磁盘技能 → 注册为 /<id> 命令、撞 builtin 跳过、dispatch 产 agent-message", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skillcmd-"));
    try {
      const store = new SkillStore(root);
      await store.create({
        name: "Deploy Service",
        description: "部署到生产",
        body: "# 步骤",
        mode: "main",
      });
      // 故意取一个会撞内置 /help 的技能名
      await store.create({
        name: "help",
        description: "撞内置命令",
        body: "x",
        mode: "main",
      });

      const registry = new DefaultCommandRegistry();
      registry.register({
        id: "help:repl",
        name: "help",
        description: "内置帮助",
        category: "info",
        execution: "local",
      });
      registry.registerDynamicSource(
        new SkillCommandSource({
          listAll: () => store.listAll(),
          findExisting: (name) => registry.findByName(name),
        }),
      );
      await registry.refresh();

      // deploy-service:注册成功、id 命名空间化、execution=agent
      const deploy = registry.findByName("deploy-service");
      expect(deploy?.id).toBe("skill:deploy-service");
      expect(deploy?.execution).toBe("agent");

      // help:撞内置 → findByName 仍解析到内置(技能未注册为 slash 命令)
      expect(registry.findByName("help")?.id).toBe("help:repl");

      // dispatch /<id> → 不调 handler、原文作 user message 发给 agent loop
      const dispatcher = new CommandDispatcher({ registry });
      const res = await dispatcher.dispatch("/deploy-service", RUNTIME);
      expect(res).toEqual({
        kind: "agent-message",
        text: "/deploy-service",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
