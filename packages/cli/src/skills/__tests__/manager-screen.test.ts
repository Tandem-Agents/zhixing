import { describe, it, expect } from "vitest";
import { stripAnsi } from "../../tui/index.js";
import type { KeyEvent } from "../../tui/index.js";
import type { ManagedSkillRecord } from "@zhixing/core";
import { renderSkillManager, handleSkillManagerKey } from "../manager-screen.js";
import {
  SkillManagerController,
  type SkillManagerStore,
  type SkillManagerView,
} from "../manager-controller.js";

const rec = (
  id: string,
  over: Partial<ManagedSkillRecord> = {},
): ManagedSkillRecord => ({
  id,
  name: id,
  description: `${id} desc`,
  source: "own",
  dir: `/own/${id}`,
  mode: "main",
  pinned: false,
  disabled: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  usage: null,
  ...over,
});

const plain = (view: SkillManagerView): string =>
  stripAnsi(renderSkillManager(view, 80).join("\n"));

describe("renderSkillManager", () => {
  it("空库显示引导,footer 仍在", () => {
    const out = plain({ items: [], selectedIndex: -1 });
    expect(out).toContain("还没有技能");
    expect(out).toContain("Esc 退出");
  });

  it("状态徽标:★置顶 / ⊘禁用 / [mode] / 来源 / 使用次数", () => {
    const out = plain({
      items: [
        rec("deploy", {
          pinned: true,
          mode: "main",
          usage: { lastHitAt: "x", hitCount: 12 },
        }),
        rec("old", { disabled: true, source: "linked", mode: "work" }),
      ],
      selectedIndex: 0,
    });
    expect(out).toContain("deploy");
    expect(out).toContain("★");
    expect(out).toContain("[main]");
    expect(out).toContain("12 次");
    expect(out).toContain("old");
    expect(out).toContain("⊘");
    expect(out).toContain("linked");
    expect(out).toContain("[work]");
  });

  it("footer 含全部操作键位", () => {
    const out = plain({ items: [rec("a")], selectedIndex: 0 });
    for (const hint of ["↑↓", "p 置顶", "d 禁用", "m 改 mode", "a 归档", "Esc 退出"]) {
      expect(out).toContain(hint);
    }
  });
});

interface FakeStore {
  store: SkillManagerStore;
  calls: string[];
}

function fakeStore(initial: ManagedSkillRecord[]): FakeStore {
  let items = initial.map((m) => ({ ...m }));
  const calls: string[] = [];
  return {
    store: {
      async listForManagement() {
        return items.map((m) => ({ ...m }));
      },
      async setState(id, patch) {
        calls.push(`setState:${id}:${JSON.stringify(patch)}`);
        items = items.map((m) => (m.id === id ? { ...m, ...patch } : m));
      },
      async archive(id) {
        calls.push(`archive:${id}`);
        items = items.filter((m) => m.id !== id);
      },
    },
    calls,
  };
}

const char = (ch: string): KeyEvent => ({ type: "char", ch });

describe("handleSkillManagerKey", () => {
  it("Esc / Ctrl+C → exit", async () => {
    const c = new SkillManagerController(fakeStore([rec("a")]).store);
    await c.load();
    expect(await handleSkillManagerKey(c, { type: "escape" })).toBe("exit");
    expect(await handleSkillManagerKey(c, { type: "ctrl-c" })).toBe("exit");
  });

  it("↑↓ → 导航,不退出", async () => {
    const c = new SkillManagerController(fakeStore([rec("a"), rec("b")]).store);
    await c.load();
    expect(await handleSkillManagerKey(c, { type: "arrow-down" })).toBe(
      "continue",
    );
    expect(c.view().selectedIndex).toBe(1);
    await handleSkillManagerKey(c, { type: "arrow-up" });
    expect(c.view().selectedIndex).toBe(0);
  });

  it("p/d/m/a → 对应操作按序落 Store", async () => {
    const { store, calls } = fakeStore([rec("a")]);
    const c = new SkillManagerController(store);
    await c.load();
    await handleSkillManagerKey(c, char("p"));
    await handleSkillManagerKey(c, char("d"));
    await handleSkillManagerKey(c, char("m"));
    await handleSkillManagerKey(c, char("a"));
    expect(calls).toEqual([
      `setState:a:${JSON.stringify({ pinned: true })}`,
      `setState:a:${JSON.stringify({ disabled: true })}`,
      `setState:a:${JSON.stringify({ mode: "work" })}`,
      "archive:a",
    ]);
  });

  it("大写键位同样生效(toLowerCase)", async () => {
    const { store, calls } = fakeStore([rec("a")]);
    const c = new SkillManagerController(store);
    await c.load();
    await handleSkillManagerKey(c, char("P"));
    expect(calls).toContain(`setState:a:${JSON.stringify({ pinned: true })}`);
  });

  it("无关按键忽略、不退出", async () => {
    const c = new SkillManagerController(fakeStore([rec("a")]).store);
    await c.load();
    expect(await handleSkillManagerKey(c, char("z"))).toBe("continue");
    expect(await handleSkillManagerKey(c, { type: "enter" })).toBe("continue");
  });
});
