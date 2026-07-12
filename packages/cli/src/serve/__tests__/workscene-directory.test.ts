/**
 * WorksceneDirectory 持久层实现 —— 真实注册表 + 场景对话库(临时 home)锁
 * 与 server 契约的对齐:enter 的取 / 建语义与全域键形态、不存在的表达
 * (rename null / remove false / enter null)。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import {
  ConversationRepository,
  FsWorkSceneRegistry,
  parseConversationId,
} from "@zhixing/core";
import type { ConversationManager } from "@zhixing/owner-kernel";
import { createWorksceneDirectory } from "../workscene-directory.js";

let originalHome: string | undefined;
let directory: ReturnType<typeof createWorksceneDirectory>;
let home: string;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function busyError(message = "busy"): Error {
  return Object.assign(new Error(message), {
    name: "WorksceneBusyError",
    code: "WORKSCENE_BUSY",
  });
}

beforeEach(async () => {
  const tmp = await createTempDir("workscene-dir");
  home = tmp;
  originalHome = process.env.ZHIXING_HOME;
  process.env.ZHIXING_HOME = tmp;
  directory = createWorksceneDirectory({ registry: new FsWorkSceneRegistry() });
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.ZHIXING_HOME;
  else process.env.ZHIXING_HOME = originalHome;
});

describe("workscene directory(持久层实现)", () => {
  it("create/list/rename/remove 全链;不存在的表达为 null/false", async () => {
    expect(await directory.rename("ghost", "x")).toBeNull();
    expect(await directory.remove("ghost")).toBe(false);

    const { scene } = await directory.create({ name: "评审场景" });
    expect((await directory.list()).map((s) => s.id)).toContain(scene.id);

    const renamed = await directory.rename(scene.id, "新场景名");
    expect(renamed?.name).toBe("新场景名");

    expect(await directory.remove(scene.id)).toBe(true);
    expect(await directory.get(scene.id)).toBeNull();
  });

  it("enterScene:首次创建场景对话、再次进入复用同一对话;全域键可解析回场景", async () => {
    const { scene } = await directory.create({ name: "开发场景" });

    const first = await directory.enterScene(scene.id, "conn-1");
    expect(first).not.toBeNull();
    const parsed = parseConversationId(first!.conversationId);
    expect(parsed.scope).toEqual({ kind: "workscene", sceneId: scene.id });

    // 场景库内确实建了对话
    const repo = new ConversationRepository({
      kind: "workscene",
      sceneId: scene.id,
    });
    expect((await repo.list()).map((c) => c.id)).toContain(parsed.localId);

    // 再次进入:复用"场景当前对话",不重复创建
    const second = await directory.enterScene(scene.id, "conn-1");
    expect(second!.conversationId).toBe(first!.conversationId);
    expect(await repo.list()).toHaveLength(1);

    // 场景不存在 → null
    expect(await directory.enterScene("ghost", "conn-1")).toBeNull();
  });

  it("enter 并发原子性:同一空场景并发进入只建一个对话(per-scene 串行)", async () => {
    const { scene } = await directory.create({ name: "并发场景" });

    const [a, b, c] = await Promise.all([
      directory.enterScene(scene.id, "conn-1"),
      directory.enterScene(scene.id, "conn-2"),
      directory.enterScene(scene.id, "conn-3"),
    ]);

    expect(a!.conversationId).toBe(b!.conversationId);
    expect(b!.conversationId).toBe(c!.conversationId);
    const repo = new ConversationRepository({
      kind: "workscene",
      sceneId: scene.id,
    });
    expect(await repo.list()).toHaveLength(1);
  });

  it("create / setWorkdir 统一校验、规范化、缺失目录软提示与解绑", async () => {
    await expect(directory.create({ name: "   " })).rejects.toMatchObject({
      code: "WORKSCENE_INPUT",
    });
    await expect(directory.create({ name: "" })).rejects.toMatchObject({
      code: "WORKSCENE_INPUT",
    });
    await expect(directory.create({ name: "bad", workdir: "rel/path" })).rejects.toThrow(
      /绝对路径/,
    );

    const filePath = path.join(home, "not-dir.txt");
    await fs.writeFile(filePath, "x", "utf-8");
    await expect(
      directory.create({ name: "file", workdir: filePath }),
    ).rejects.toThrow(/不是目录/);

    const existingDir = path.join(home, "existing");
    await fs.mkdir(existingDir);
    const created = await directory.create({
      name: " 有目录 ",
      workdir: `${existingDir}${path.sep}.`,
    });
    expect(created.scene.name).toBe("有目录");
    expect(created.scene.workdir).toBe(path.normalize(`${existingDir}${path.sep}.`));
    expect(created.workdirWarning).toBeUndefined();

    const missing = path.join(home, "missing");
    const rebound = await directory.setWorkdir(created.scene.id, missing);
    expect(rebound?.scene.workdir).toBe(missing);
    expect(rebound?.workdirWarning).toContain("下次进入将自动创建");

    const cleared = await directory.setWorkdir(created.scene.id, null);
    expect(cleared?.scene.workdir).toBeUndefined();
    await expect(directory.rename(created.scene.id, "   ")).rejects.toMatchObject({
      code: "WORKSCENE_INPUT",
    });
    await expect(directory.setWorkdir(created.scene.id, "   ")).rejects.toMatchObject({
      code: "WORKSCENE_INPUT",
    });
    await expect(directory.setWorkdir(created.scene.id, "")).rejects.toMatchObject({
      code: "WORKSCENE_INPUT",
    });
    expect(await directory.setWorkdir("ghost", null)).toBeNull();
  });

  it("remove / setWorkdir 通过 quiescePrefix 静默,并在落盘后释放闸", async () => {
    const calls: string[] = [];
    const registry = new FsWorkSceneRegistry();
    const manager = {
      async quiescePrefix(prefix: string) {
        calls.push(`quiesce:${prefix}`);
        return () => calls.push(`release:${prefix}`);
      },
      addObserver: () => true,
    } as unknown as ConversationManager;
    const guarded = createWorksceneDirectory({
      registry,
      conversations: () => manager,
    });
    const { scene } = await guarded.create({ name: "守卫场景" });
    const nextWorkdir = path.join(home, "next");

    const changed = await guarded.setWorkdir(scene.id, nextWorkdir);
    expect(changed?.scene.workdir).toBe(nextWorkdir);
    expect(calls).toEqual([
      `quiesce:ws:${scene.id}:`,
      `release:ws:${scene.id}:`,
    ]);

    calls.length = 0;
    expect(await guarded.remove(scene.id)).toBe(true);
    expect(calls).toEqual([
      `quiesce:ws:${scene.id}:`,
      `release:ws:${scene.id}:`,
    ]);
  });

  it("enter 先完成时 observer 已登记,后续 remove 命中 BUSY 且不删除场景", async () => {
    const observers = new Set<string>();
    const manager = {
      addObserver(conversationId: string) {
        observers.add(conversationId);
        return true;
      },
      async quiescePrefix(prefix: string) {
        if ([...observers].some((id) => id.startsWith(prefix))) {
          throw busyError();
        }
        return () => {};
      },
    } as unknown as ConversationManager;
    const guarded = createWorksceneDirectory({
      registry: new FsWorkSceneRegistry(),
      conversations: () => manager,
    });
    const { scene } = await guarded.create({ name: "入场优先" });

    const entered = await guarded.enterScene(scene.id, "conn-1");
    await expect(guarded.remove(scene.id)).rejects.toMatchObject({
      code: "WORKSCENE_BUSY",
    });

    expect(entered?.scene.id).toBe(scene.id);
    expect(await guarded.get(scene.id)).not.toBeNull();
  });

  it("enterScene 的 touch 失败不撤销已登记 observer 与入场结果", async () => {
    class TouchFailRegistry extends FsWorkSceneRegistry {
      override async touch(): Promise<void> {
        throw new Error("touch failed");
      }
    }
    const observed: string[] = [];
    const guarded = createWorksceneDirectory({
      registry: new TouchFailRegistry(),
      conversations: () =>
        ({
          addObserver(conversationId: string) {
            observed.push(conversationId);
            return true;
          },
        }) as unknown as ConversationManager,
    });
    const { scene } = await guarded.create({ name: "touch 失败仍入场" });

    const entered = await guarded.enterScene(scene.id, "conn-1");

    expect(entered?.scene.id).toBe(scene.id);
    expect(observed).toEqual([entered?.conversationId]);
  });

  it("remove 先进入链时 enter 等待并在删除后返回 null,不注册 observer", async () => {
    const gate = deferred();
    const calls: string[] = [];
    const manager = {
      addObserver() {
        calls.push("addObserver");
        return true;
      },
      async quiescePrefix() {
        calls.push("quiesce");
        await gate.promise;
        return () => calls.push("release");
      },
    } as unknown as ConversationManager;
    const guarded = createWorksceneDirectory({
      registry: new FsWorkSceneRegistry(),
      conversations: () => manager,
    });
    const { scene } = await guarded.create({ name: "删除优先" });

    const removing = guarded.remove(scene.id);
    await Promise.resolve();
    const entering = guarded.enterScene(scene.id, "conn-1");
    gate.resolve();

    await expect(removing).resolves.toBe(true);
    await expect(entering).resolves.toBeNull();
    expect(calls).toEqual(["quiesce", "release"]);
  });

  it("setWorkdir 先进入链时 enter 等待并返回新 workdir 场景", async () => {
    const gate = deferred();
    const manager = {
      addObserver: () => true,
      async quiescePrefix() {
        await gate.promise;
        return () => {};
      },
    } as unknown as ConversationManager;
    const guarded = createWorksceneDirectory({
      registry: new FsWorkSceneRegistry(),
      conversations: () => manager,
    });
    const { scene } = await guarded.create({ name: "改目录优先" });
    const nextWorkdir = path.join(home, "new-workdir");

    const changing = guarded.setWorkdir(scene.id, nextWorkdir);
    await Promise.resolve();
    const entering = guarded.enterScene(scene.id, "conn-1");
    gate.resolve();

    await expect(changing).resolves.toMatchObject({
      scene: { id: scene.id, workdir: nextWorkdir },
    });
    await expect(entering).resolves.toMatchObject({
      scene: { id: scene.id, workdir: nextWorkdir },
    });
  });
});
