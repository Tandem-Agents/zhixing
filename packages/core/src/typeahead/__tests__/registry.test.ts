/**
 * DefaultCommandRegistry 单元测试
 *
 * 覆盖面（spec §5.8 ICommandRegistry 合约）：
 *   - 静态 register / unregister / find / findByName
 *   - 动态源 registerDynamicSource / refresh / unregister
 *   - 可见性过滤（targets / predicate）
 *   - Hidden 命令的 escape hatch 语义
 *   - onChange 事件订阅与 unsubscribe
 *   - 异常传播与 error hook
 */

import { describe, expect, it, vi } from "vitest";
import { DefaultCommandRegistry } from "../registry.js";
import type { CommandDef, DynamicCommandSource, RuntimeContext } from "../types.js";

// ─── 辅助 ───

function makeCmd(partial: Partial<CommandDef> & Pick<CommandDef, "id" | "name">): CommandDef {
  return {
    description: partial.description ?? "test command",
    category: partial.category ?? "info",
    execution: partial.execution ?? "local",
    ...partial,
  };
}

function makeCtx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    sessionBusy: false,
    workspaceId: null,
    cwd: "/tmp/test",
    target: "cli",
    features: {},
    now: 1_700_000_000_000,
    ...overrides,
  };
}

// ─── 静态注册 / 查询 ───

describe("DefaultCommandRegistry — 静态注册与查询", () => {
  it("register 后 find(id) 能找到", () => {
    const reg = new DefaultCommandRegistry();
    const cmd = makeCmd({ id: "a:builtin", name: "a" });
    reg.register(cmd);
    expect(reg.find("a:builtin")).toBe(cmd);
  });

  it("find 不存在的 id 返回 null", () => {
    const reg = new DefaultCommandRegistry();
    expect(reg.find("nonexistent")).toBeNull();
  });

  it("findByName 按 name 查找（大小写不敏感）", () => {
    const reg = new DefaultCommandRegistry();
    const cmd = makeCmd({ id: "model:builtin", name: "model" });
    reg.register(cmd);
    expect(reg.findByName("model")).toBe(cmd);
    expect(reg.findByName("MODEL")).toBe(cmd);
    expect(reg.findByName("Model")).toBe(cmd);
  });

  it("findByName 按 alias 查找（大小写不敏感）", () => {
    const reg = new DefaultCommandRegistry();
    const cmd = makeCmd({
      id: "new:builtin",
      name: "new",
      aliases: ["reset", "fresh"],
    });
    reg.register(cmd);
    expect(reg.findByName("reset")).toBe(cmd);
    expect(reg.findByName("RESET")).toBe(cmd);
    expect(reg.findByName("fresh")).toBe(cmd);
  });

  it("findByName 找不到返回 null", () => {
    const reg = new DefaultCommandRegistry();
    reg.register(makeCmd({ id: "a:builtin", name: "a" }));
    expect(reg.findByName("zzz")).toBeNull();
  });

  it("findByName **包括 hidden 命令**（escape hatch）", () => {
    const reg = new DefaultCommandRegistry();
    const cmd = makeCmd({
      id: "debug:builtin",
      name: "debug",
      hidden: true,
    });
    reg.register(cmd);
    expect(reg.findByName("debug")).toBe(cmd);
    // 对比：list 里看不到
    expect(reg.list(makeCtx())).not.toContain(cmd);
  });

  it("重复 id 的 register 抛 Error", () => {
    const reg = new DefaultCommandRegistry();
    reg.register(makeCmd({ id: "a:builtin", name: "a" }));
    expect(() =>
      reg.register(makeCmd({ id: "a:builtin", name: "b" })),
    ).toThrow(/duplicate command id/);
  });

  it("unregister 移除命令，返回 true", () => {
    const reg = new DefaultCommandRegistry();
    reg.register(makeCmd({ id: "a:builtin", name: "a" }));
    expect(reg.unregister("a:builtin")).toBe(true);
    expect(reg.find("a:builtin")).toBeNull();
  });

  it("unregister 不存在的 id 返回 false", () => {
    const reg = new DefaultCommandRegistry();
    expect(reg.unregister("nonexistent")).toBe(false);
  });
});

// ─── list 与可见性 ───

describe("DefaultCommandRegistry — list 与可见性", () => {
  it("list 返回所有非 hidden 命令", () => {
    const reg = new DefaultCommandRegistry();
    reg.register(makeCmd({ id: "a:builtin", name: "a" }));
    reg.register(makeCmd({ id: "b:builtin", name: "b", hidden: true }));
    reg.register(makeCmd({ id: "c:builtin", name: "c" }));
    const names = reg.list(makeCtx()).map((c) => c.name);
    expect(names.sort()).toEqual(["a", "c"]);
  });

  it("list 按 visibility.targets 过滤", () => {
    const reg = new DefaultCommandRegistry();
    reg.register(
      makeCmd({
        id: "cli-only:builtin",
        name: "cli-only",
        visibility: { targets: ["cli"] },
      }),
    );
    reg.register(
      makeCmd({
        id: "web-only:builtin",
        name: "web-only",
        visibility: { targets: ["web"] },
      }),
    );
    reg.register(makeCmd({ id: "any:builtin", name: "any" }));

    const cliNames = reg.list(makeCtx({ target: "cli" })).map((c) => c.name);
    expect(cliNames.sort()).toEqual(["any", "cli-only"]);

    const webNames = reg.list(makeCtx({ target: "web" })).map((c) => c.name);
    expect(webNames.sort()).toEqual(["any", "web-only"]);
  });

  it("list 按 visibility.predicate 过滤（返回 false 时隐藏）", () => {
    const reg = new DefaultCommandRegistry();
    reg.register(
      makeCmd({
        id: "busy-guard:builtin",
        name: "needs-idle",
        visibility: {
          predicate: (ctx) => !ctx.sessionBusy,
        },
      }),
    );
    expect(reg.list(makeCtx({ sessionBusy: false }))).toHaveLength(1);
    expect(reg.list(makeCtx({ sessionBusy: true }))).toHaveLength(0);
  });

  it("list 的 predicate 抛异常时保守隐藏 + 调用 onSourceError", () => {
    const onSourceError = vi.fn();
    const reg = new DefaultCommandRegistry({ onSourceError });
    reg.register(
      makeCmd({
        id: "broken:builtin",
        name: "broken",
        visibility: {
          predicate: () => {
            throw new Error("predicate boom");
          },
        },
      }),
    );
    expect(reg.list(makeCtx())).toHaveLength(0);
    expect(onSourceError).toHaveBeenCalledOnce();
    expect(onSourceError.mock.calls[0]![0]).toContain("visibility-predicate");
    expect(onSourceError.mock.calls[0]![1].message).toContain("predicate boom");
  });

  it("targets 和 predicate 并存：两者都满足才可见", () => {
    const reg = new DefaultCommandRegistry();
    reg.register(
      makeCmd({
        id: "strict:builtin",
        name: "strict",
        visibility: {
          targets: ["cli"],
          predicate: (ctx) => ctx.features.enabled === true,
        },
      }),
    );
    expect(reg.list(makeCtx({ target: "cli", features: {} }))).toHaveLength(0); // predicate 不过
    expect(
      reg.list(makeCtx({ target: "cli", features: { enabled: true } })),
    ).toHaveLength(1);
    expect(
      reg.list(makeCtx({ target: "web", features: { enabled: true } })),
    ).toHaveLength(0); // target 不过
  });
});

// ─── 动态源 ───

describe("DefaultCommandRegistry — 动态源", () => {
  function makeSource(
    id: string,
    commands: CommandDef[] | (() => Promise<CommandDef[]>),
  ): DynamicCommandSource {
    return {
      id,
      list: async () =>
        typeof commands === "function" ? commands() : commands,
    };
  }

  it("registerDynamicSource + refresh 把命令加入 registry", async () => {
    const reg = new DefaultCommandRegistry();
    const source = makeSource("plugin-x", [
      makeCmd({ id: "greet:plugin", name: "greet" }),
    ]);
    reg.registerDynamicSource(source);
    // 注册后但未 refresh 时，命令还不在 registry
    expect(reg.find("greet:plugin")).toBeNull();
    await reg.refresh();
    expect(reg.find("greet:plugin")).not.toBeNull();
    expect(reg.findByName("greet")).not.toBeNull();
  });

  it("动态源的 unregister 清除所有贡献的命令", async () => {
    const reg = new DefaultCommandRegistry();
    const source = makeSource("plugin-x", [
      makeCmd({ id: "a:plugin", name: "a" }),
      makeCmd({ id: "b:plugin", name: "b" }),
    ]);
    const unregister = reg.registerDynamicSource(source);
    await reg.refresh();
    expect(reg.find("a:plugin")).not.toBeNull();
    expect(reg.find("b:plugin")).not.toBeNull();
    unregister();
    expect(reg.find("a:plugin")).toBeNull();
    expect(reg.find("b:plugin")).toBeNull();
  });

  it("refresh 替换动态源的旧 commands（不是累加）", async () => {
    const reg = new DefaultCommandRegistry();
    let phase = 1;
    const source = makeSource("plugin-x", async () => {
      return phase === 1
        ? [makeCmd({ id: "old:plugin", name: "old" })]
        : [makeCmd({ id: "new:plugin", name: "new" })];
    });
    reg.registerDynamicSource(source);
    await reg.refresh();
    expect(reg.find("old:plugin")).not.toBeNull();

    phase = 2;
    await reg.refresh();
    expect(reg.find("old:plugin")).toBeNull(); // 老命令被清
    expect(reg.find("new:plugin")).not.toBeNull();
  });

  it("refresh 单源失败不影响其他源，onSourceError 被调用", async () => {
    const onSourceError = vi.fn();
    const reg = new DefaultCommandRegistry({ onSourceError });
    const good = makeSource("good", [
      makeCmd({ id: "g:plugin", name: "g" }),
    ]);
    const bad: DynamicCommandSource = {
      id: "bad",
      list: async () => {
        throw new Error("source boom");
      },
    };
    reg.registerDynamicSource(good);
    reg.registerDynamicSource(bad);
    await reg.refresh();

    expect(reg.find("g:plugin")).not.toBeNull(); // good 源的命令还在
    expect(onSourceError).toHaveBeenCalledOnce();
    expect(onSourceError.mock.calls[0]![0]).toBe("bad");
    expect(onSourceError.mock.calls[0]![1].message).toContain("source boom");
  });

  it("动态源 id 冲突于静态命令时跳过并报错", async () => {
    const onSourceError = vi.fn();
    const reg = new DefaultCommandRegistry({ onSourceError });
    reg.register(makeCmd({ id: "shared:id", name: "static-one" }));
    const source = makeSource("plugin-x", [
      makeCmd({ id: "shared:id", name: "dynamic-one" }),
    ]);
    reg.registerDynamicSource(source);
    await reg.refresh();

    // 静态的那一条应保留
    expect(reg.find("shared:id")?.name).toBe("static-one");
    expect(onSourceError).toHaveBeenCalled();
    const errorCall = onSourceError.mock.calls.find(
      (call) => call[0] === "plugin-x",
    );
    expect(errorCall?.[1].message).toContain("already registered");
  });

  it("重复 registerDynamicSource 同 id 抛 Error", () => {
    const reg = new DefaultCommandRegistry();
    const source = makeSource("plugin-x", []);
    reg.registerDynamicSource(source);
    expect(() => reg.registerDynamicSource(source)).toThrow(/duplicate dynamic source/);
  });
});

// ─── onChange ───

describe("DefaultCommandRegistry — onChange", () => {
  it("onChange 在 register 时触发", () => {
    const reg = new DefaultCommandRegistry();
    const listener = vi.fn();
    reg.onChange(listener);
    reg.register(makeCmd({ id: "a:b", name: "a" }));
    expect(listener).toHaveBeenCalledOnce();
  });

  it("onChange 在 unregister 时触发（仅对真正存在的 id）", () => {
    const reg = new DefaultCommandRegistry();
    reg.register(makeCmd({ id: "a:b", name: "a" }));
    const listener = vi.fn();
    reg.onChange(listener);
    reg.unregister("nonexistent");
    expect(listener).not.toHaveBeenCalled();
    reg.unregister("a:b");
    expect(listener).toHaveBeenCalledOnce();
  });

  it("onChange 在 refresh 完成后触发一次", async () => {
    const reg = new DefaultCommandRegistry();
    const source: DynamicCommandSource = {
      id: "s",
      list: async () => [makeCmd({ id: "x:plugin", name: "x" })],
    };
    reg.registerDynamicSource(source);
    const listener = vi.fn();
    reg.onChange(listener);
    await reg.refresh();
    expect(listener).toHaveBeenCalledOnce();
  });

  it("unsubscribe 返回的函数停止后续事件", () => {
    const reg = new DefaultCommandRegistry();
    const listener = vi.fn();
    const unsub = reg.onChange(listener);
    reg.register(makeCmd({ id: "a:b", name: "a" }));
    expect(listener).toHaveBeenCalledOnce();
    unsub();
    reg.register(makeCmd({ id: "c:d", name: "c" }));
    expect(listener).toHaveBeenCalledOnce(); // 还是 1
  });

  it("listener 抛异常不影响 registry 后续工作", () => {
    const onSourceError = vi.fn();
    const reg = new DefaultCommandRegistry({ onSourceError });
    reg.onChange(() => {
      throw new Error("listener boom");
    });
    expect(() =>
      reg.register(makeCmd({ id: "a:b", name: "a" })),
    ).not.toThrow();
    expect(onSourceError).toHaveBeenCalledWith(
      "change-listener",
      expect.objectContaining({ message: "listener boom" }),
    );
    // 后续 register 仍然工作
    expect(() =>
      reg.register(makeCmd({ id: "c:d", name: "c" })),
    ).not.toThrow();
  });
});
