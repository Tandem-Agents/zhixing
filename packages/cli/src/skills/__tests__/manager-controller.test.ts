import { describe, it, expect } from "vitest";
import type { ManagedSkillRecord } from "@zhixing/core";
import {
  SkillManagerController,
  type SkillManagerStore,
} from "../manager-controller.js";

const rec = (
  id: string,
  over: Partial<ManagedSkillRecord> = {},
): ManagedSkillRecord => ({
  id,
  name: id.toUpperCase(),
  description: "d",
  source: "own",
  dir: `/skills/own/${id}`,
  mode: "main",
  pinned: false,
  disabled: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  usage: null,
  ...over,
});

interface Call {
  op: "setState" | "archive";
  id: string;
  patch?: unknown;
}

function fakeStore(initial: ManagedSkillRecord[]): {
  store: SkillManagerStore;
  calls: Call[];
} {
  let items = initial.map((m) => ({ ...m }));
  const calls: Call[] = [];
  // 模拟 rankWithUsage 的"pinned 优先"重排,用于验证选中跟随被置顶项
  const sorted = () =>
    [...items].sort((a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1));
  const store: SkillManagerStore = {
    async listForManagement() {
      return sorted();
    },
    async setState(id, patch) {
      calls.push({ op: "setState", id, patch });
      items = items.map((m) => (m.id === id ? { ...m, ...patch } : m));
    },
    async archive(id) {
      calls.push({ op: "archive", id });
      items = items.filter((m) => m.id !== id);
    },
  };
  return { store, calls };
}

describe("SkillManagerController", () => {
  it("load 后给出列表 + 选中第 0;空库 selectedIndex = -1", async () => {
    const c = new SkillManagerController(fakeStore([rec("a"), rec("b")]).store);
    await c.load();
    expect(c.view().items.map((m) => m.id)).toEqual(["a", "b"]);
    expect(c.view().selectedIndex).toBe(0);

    const empty = new SkillManagerController(fakeStore([]).store);
    await empty.load();
    expect(empty.view().selectedIndex).toBe(-1);
  });

  it("moveUp / moveDown 环绕", async () => {
    const c = new SkillManagerController(
      fakeStore([rec("a"), rec("b"), rec("c")]).store,
    );
    await c.load();
    c.moveUp();
    expect(c.view().selectedIndex).toBe(2);
    c.moveDown();
    expect(c.view().selectedIndex).toBe(0);
  });

  it("togglePin:调 setState、列表重排、选中跟随被置顶项", async () => {
    const { store, calls } = fakeStore([rec("a"), rec("b")]);
    const c = new SkillManagerController(store);
    await c.load();
    c.moveDown(); // 选中 b
    await c.togglePin();
    expect(calls).toContainEqual({
      op: "setState",
      id: "b",
      patch: { pinned: true },
    });
    expect(c.view().items.map((m) => m.id)).toEqual(["b", "a"]); // b 置顶上移
    expect(c.view().items[c.view().selectedIndex]!.id).toBe("b"); // 选中跟随 b
  });

  it("toggleDisabled:翻转 disabled,技能仍在全集、选中仍在其上", async () => {
    const { store, calls } = fakeStore([rec("a")]);
    const c = new SkillManagerController(store);
    await c.load();
    await c.toggleDisabled();
    expect(calls).toContainEqual({
      op: "setState",
      id: "a",
      patch: { disabled: true },
    });
    expect(c.view().items.find((m) => m.id === "a")!.disabled).toBe(true);
    expect(c.view().items[c.view().selectedIndex]!.id).toBe("a");
  });

  it("cycleMode:main ↔ work", async () => {
    const { store, calls } = fakeStore([rec("a", { mode: "main" })]);
    const c = new SkillManagerController(store);
    await c.load();
    await c.cycleMode();
    expect(calls).toContainEqual({
      op: "setState",
      id: "a",
      patch: { mode: "work" },
    });
  });

  it("archiveSelected:调 archive、移除该项、选中落位不越界", async () => {
    const { store, calls } = fakeStore([rec("a"), rec("b")]);
    const c = new SkillManagerController(store);
    await c.load();
    c.moveDown(); // 选中末项 b
    await c.archiveSelected();
    expect(calls).toContainEqual({ op: "archive", id: "b" });
    expect(c.view().items.map((m) => m.id)).toEqual(["a"]);
    expect(c.view().selectedIndex).toBe(0); // 末项归档后落到新末项
  });

  it("每次变更触发 onMutate(供接 /<name> 刷新)", async () => {
    let mutated = 0;
    const c = new SkillManagerController(fakeStore([rec("a")]).store, () => {
      mutated++;
    });
    await c.load();
    await c.togglePin();
    await c.toggleDisabled();
    expect(mutated).toBe(2);
  });

  it("空库:状态操作是 no-op、不抛", async () => {
    const { store, calls } = fakeStore([]);
    const c = new SkillManagerController(store);
    await c.load();
    await c.togglePin();
    await c.archiveSelected();
    expect(calls).toEqual([]);
  });
});
