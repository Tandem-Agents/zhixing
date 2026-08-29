import { describe, it, expect } from "vitest";
import type {
  SkillCatalogClient,
  SkillCatalogEntry,
} from "@zhixing/core/skills/catalog";
import { SkillManagerController } from "../manager-controller.js";

const rec = (
  id: string,
  over: Partial<SkillCatalogEntry> = {},
): SkillCatalogEntry => ({
  id,
  name: id.toUpperCase(),
  description: "d",
  source: "own",
  mode: "main",
  pinned: false,
  disabled: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  usage: null,
  contentRef: {
    digest: `sha256:${id.padEnd(64, "0")}`,
    bytes: 1,
  },
  revision: 1,
  digest: `sha256:${id.padEnd(64, "f")}`,
  ...over,
});

interface Call {
  op: "setState" | "archive";
  id: string;
  patch?: unknown;
}

function fakeClient(initial: SkillCatalogEntry[]): {
  client: SkillCatalogClient;
  calls: Call[];
} {
  let items = initial.map((m) => ({ ...m }));
  const calls: Call[] = [];
  // 模拟 rankWithUsage 的"pinned 优先"重排,用于验证选中跟随被置顶项
  const sorted = () =>
    [...items].sort((a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1));
  const client: SkillCatalogClient = {
    async query() {
      return { entries: sorted(), catalogRevision: 1 };
    },
    async command(command) {
      if (command.kind === "set-state") {
        calls.push({ op: "setState", id: command.skillId, patch: command.patch });
        items = items.map((item) =>
          item.id === command.skillId ? { ...item, ...command.patch } : item
        );
      } else {
        calls.push({ op: "archive", id: command.skillId });
        items = items.filter((item) => item.id !== command.skillId);
      }
    },
    onFact: () => () => {},
  };
  return { client, calls };
}

describe("SkillManagerController", () => {
  it("load 后给出列表 + 选中第 0;空库 selectedIndex = -1", async () => {
    const c = new SkillManagerController(fakeClient([rec("a"), rec("b")]).client);
    await c.load();
    expect(c.view().items.map((m) => m.id)).toEqual(["a", "b"]);
    expect(c.view().selectedIndex).toBe(0);

    const empty = new SkillManagerController(fakeClient([]).client);
    await empty.load();
    expect(empty.view().selectedIndex).toBe(-1);
  });

  it("moveUp / moveDown 环绕", async () => {
    const c = new SkillManagerController(
      fakeClient([rec("a"), rec("b"), rec("c")]).client,
    );
    await c.load();
    c.moveUp();
    expect(c.view().selectedIndex).toBe(2);
    c.moveDown();
    expect(c.view().selectedIndex).toBe(0);
  });

  it("togglePin:调 setState、列表重排、选中跟随被置顶项", async () => {
    const { client, calls } = fakeClient([rec("a"), rec("b")]);
    const c = new SkillManagerController(client);
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
    const { client, calls } = fakeClient([rec("a")]);
    const c = new SkillManagerController(client);
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
    const { client, calls } = fakeClient([rec("a", { mode: "main" })]);
    const c = new SkillManagerController(client);
    await c.load();
    await c.cycleMode();
    expect(calls).toContainEqual({
      op: "setState",
      id: "a",
      patch: { mode: "work" },
    });
  });

  it("archiveSelected:调 archive、移除该项、选中落位不越界", async () => {
    const { client, calls } = fakeClient([rec("a"), rec("b")]);
    const c = new SkillManagerController(client);
    await c.load();
    c.moveDown(); // 选中末项 b
    await c.archiveSelected();
    expect(calls).toContainEqual({ op: "archive", id: "b" });
    expect(c.view().items.map((m) => m.id)).toEqual(["a"]);
    expect(c.view().selectedIndex).toBe(0); // 末项归档后落到新末项
  });

  it("每次变更触发 onMutate(供接 /<name> 刷新)", async () => {
    let mutated = 0;
    const c = new SkillManagerController(fakeClient([rec("a")]).client, () => {
      mutated++;
    });
    await c.load();
    await c.togglePin();
    await c.toggleDisabled();
    expect(mutated).toBe(2);
  });

  it("空库:状态操作是 no-op、不抛", async () => {
    const { client, calls } = fakeClient([]);
    const c = new SkillManagerController(client);
    await c.load();
    await c.togglePin();
    await c.archiveSelected();
    expect(calls).toEqual([]);
  });
});
