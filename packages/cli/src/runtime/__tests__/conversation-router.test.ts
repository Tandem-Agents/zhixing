/**
 * RoutingConversationRepository 回归 —— 委派正确性 + setActive 切换目标。
 *
 * 路由核是工作模式 task_list / 段切换持久化的单一决策点，必须保证：
 *   - 默认透传初始(主)repo
 *   - setActive 后所有方法整体切到新目标，无方法漏切
 *   - 透传参数与返回值原样穿过（不做任何加工）
 */

import { describe, expect, it, vi } from "vitest";
import type { IConversationRepository } from "@zhixing/core";
import { RoutingConversationRepository } from "../conversation-router.js";

/** 每个方法返回带标记的值，便于断言路由到了哪个后端。 */
function makeRepo(tag: string): IConversationRepository {
  return {
    list: vi.fn().mockResolvedValue([{ id: `${tag}-conv` }]),
    get: vi.fn().mockResolvedValue({ id: `${tag}-get` }),
    create: vi.fn().mockResolvedValue({ id: `${tag}-created` }),
    rename: vi.fn().mockResolvedValue({ id: `${tag}-renamed` }),
    archive: vi.fn().mockResolvedValue({ id: `${tag}-archived` }),
    delete: vi.fn().mockResolvedValue(undefined),
    ensureDefault: vi.fn().mockResolvedValue({ id: `${tag}-default` }),
    findLatest: vi.fn().mockResolvedValue(`${tag}-latest`),
    touch: vi.fn().mockResolvedValue(undefined),
    clearViewLayerState: vi.fn().mockResolvedValue(undefined),
    updateTaskListState: vi.fn().mockResolvedValue(undefined),
    appendSegmentMeta: vi.fn().mockResolvedValue(undefined),
  } as unknown as IConversationRepository;
}

describe("RoutingConversationRepository", () => {
  it("默认透传初始 repo", async () => {
    const main = makeRepo("main");
    const router = new RoutingConversationRepository(main);
    expect(await router.findLatest()).toBe("main-latest");
    expect(await router.get("x")).toEqual({ id: "main-get" });
  });

  it("setActive 后所有方法整体切到新目标", async () => {
    const main = makeRepo("main");
    const scene = makeRepo("scene");
    const router = new RoutingConversationRepository(main);

    router.setActive(scene);
    expect(await router.findLatest()).toBe("scene-latest");
    expect(await router.list()).toEqual([{ id: "scene-conv" }]);
    expect(await router.create({})).toEqual({ id: "scene-created" });
    expect(main.findLatest).not.toHaveBeenCalled();

    router.setActive(main);
    expect(await router.findLatest()).toBe("main-latest");
  });

  it("参数原样透传到当前后端", async () => {
    const main = makeRepo("main");
    const router = new RoutingConversationRepository(main);
    await router.updateTaskListState("conv-1", undefined);
    await router.touch("conv-2");
    expect(main.updateTaskListState).toHaveBeenCalledWith("conv-1", undefined);
    expect(main.touch).toHaveBeenCalledWith("conv-2");
  });
});
