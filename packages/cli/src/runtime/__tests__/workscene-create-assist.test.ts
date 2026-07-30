import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import {
  createWorksceneCreateSelectionRequest,
  runWorksceneCreateAssist,
  type WorksceneCreateAssistDeps,
  type WorksceneCreateProposal,
} from "../workscene-create-assist.js";

function scripted(...responses: string[]): WorksceneCreateAssistDeps["complete"] {
  let index = 0;
  return vi.fn(async () => responses[index++] ?? '{"final":{"kind":"cancelled"}}');
}

function scene(
  name = "写作",
  workspace?: { deviceId: string; bindingRef: string },
) {
  return {
    sceneId: "scene-1",
    revision: 1,
    name,
    ...(workspace ? { workspace } : {}),
    lastActiveAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeDeps(
  overrides: Partial<WorksceneCreateAssistDeps> = {},
): WorksceneCreateAssistDeps & {
  confirm: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  askUser: ReturnType<typeof vi.fn>;
} {
  const confirm = vi.fn(async () => true);
  const authorizeLocalWorkspace = vi.fn(async () => ({
    deviceId: "device-local",
    bindingRef: "workspace-local",
  }));
  const create = vi.fn(
    async (
      name: string,
      workspace?: { deviceId: string; bindingRef: string },
    ) => scene(name, workspace),
  );
  const askUser = vi.fn(async () => null);
  return {
    listScenes: vi.fn(async () => []),
    complete: scripted('{"final":{"kind":"cancelled"}}'),
    confirm,
    authorizeLocalWorkspace,
    create,
    askUser,
    ...overrides,
  } as WorksceneCreateAssistDeps & {
    confirm: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    askUser: ReturnType<typeof vi.fn>;
  };
}

describe("runWorksceneCreateAssist", () => {
  it("确认后用规范化名称与目录创建，并在确认面展示缺失目录提示", async () => {
    const root = await createTempDir("workscene-create-assist");
    const missing = path.join(root, "missing-project");
    const normalized = path.normalize(missing);
    let proposal: WorksceneCreateProposal | null = null;
    const deps = makeDeps({
      complete: scripted(
        JSON.stringify({
          call: {
            tool: "workscene_create",
            input: { name: "  论文项目  ", workdir: `  ${missing}  ` },
          },
        }),
        '{"final":{"kind":"created"}}',
      ),
      confirm: vi.fn(async (p: WorksceneCreateProposal) => {
        proposal = p;
        return true;
      }),
    });

    const result = await runWorksceneCreateAssist("给论文项目建一个场景", deps);

    expect(result.kind).toBe("created");
    expect(deps.authorizeLocalWorkspace).toHaveBeenCalledWith(
      "论文项目",
      normalized,
    );
    expect(deps.create).toHaveBeenCalledWith("论文项目", {
      deviceId: "device-local",
      bindingRef: "workspace-local",
    });
    expect(proposal?.summary).toContain(`工作目录：${normalized}`);
    expect(proposal?.summary).toContain("下次进入将自动创建");
  });

  it("信息不足时先澄清，再用用户补充创建", async () => {
    const deps = makeDeps({
      complete: scripted(
        '{"final":{"kind":"ask","question":"这个场景叫什么名字？"}}',
        '{"call":{"tool":"workscene_create","input":{"name":"写作"}}}',
        '{"final":{"kind":"created"}}',
      ),
      askUser: vi.fn(async () => "写作"),
    });

    const result = await runWorksceneCreateAssist("帮我新建一个", deps);

    expect(result.kind).toBe("created");
    expect(deps.askUser).toHaveBeenCalledWith(
      "这个场景叫什么名字？",
      undefined,
    );
    expect(deps.create).toHaveBeenCalledWith("写作", undefined);
  });

  it("本地预检失败不弹确认门，并把校验错误回灌给模型澄清", async () => {
    const prompts: string[] = [];
    const deps = makeDeps({
      complete: vi.fn(async (prompt: string) => {
        prompts.push(prompt);
        return prompts.length === 1
          ? '{"call":{"tool":"workscene_create","input":{"name":"   "}}}'
          : '{"final":{"kind":"ask","question":"请提供工作场景名称。"}}';
      }),
      askUser: vi.fn(async () => null),
    });

    const result = await runWorksceneCreateAssist("新建", deps);

    expect(result.kind).toBe("cancelled");
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.create).not.toHaveBeenCalled();
    expect(prompts[1]).toContain("工作场景名称不能为空");
    expect(deps.askUser).toHaveBeenCalledWith("请提供工作场景名称。", undefined);
  });

  it("用户在确认门取消时不创建，并按取消收尾", async () => {
    const deps = makeDeps({
      complete: scripted(
        '{"call":{"tool":"workscene_create","input":{"name":"写作"}}}',
        '{"final":{"kind":"cancelled"}}',
      ),
      confirm: vi.fn(async () => false),
    });

    const result = await runWorksceneCreateAssist("写作", deps);

    expect(result.kind).toBe("cancelled");
    expect(deps.create).not.toHaveBeenCalled();
  });

  it("同一轮智能创建只执行一次 create，重复工具调用走幂等结果", async () => {
    const deps = makeDeps({
      complete: scripted(
        '{"call":{"tool":"workscene_create","input":{"name":"写作"}}}',
        '{"call":{"tool":"workscene_create","input":{"name":"写作二号"}}}',
        '{"final":{"kind":"created"}}',
      ),
    });

    const result = await runWorksceneCreateAssist("写作", deps);

    expect(result.kind).toBe("created");
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(deps.create).toHaveBeenCalledTimes(1);
    expect(deps.create).toHaveBeenCalledWith("写作", undefined);
  });

  it("模型先声称已创建会被拒绝，真实创建成功后才可 created 收尾", async () => {
    const deps = makeDeps({
      complete: scripted(
        '{"final":{"kind":"created"}}',
        '{"call":{"tool":"workscene_create","input":{"name":"写作"}}}',
        '{"final":{"kind":"created"}}',
      ),
    });

    const result = await runWorksceneCreateAssist("写作", deps);

    expect(result.kind).toBe("created");
    expect(deps.create).toHaveBeenCalledTimes(1);
    expect(deps.complete).toHaveBeenCalledTimes(3);
  });

  it("LLM 不可用时降级到固定输入，并保留用户首句", async () => {
    const deps = makeDeps({
      complete: vi.fn(async () => {
        throw new Error("model down");
      }),
    });

    const result = await runWorksceneCreateAssist("写作项目", deps);

    expect(result).toEqual({
      kind: "fallback",
      prefill: "写作项目",
      reason: "model down",
    });
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.create).not.toHaveBeenCalled();
  });

  it("运行中收到 abort 时按取消收尾，不切固定输入降级", async () => {
    const controller = new AbortController();
    const deps = makeDeps({
      complete: vi.fn(async () => {
        controller.abort();
        return '{"final":{"kind":"created"}}';
      }),
    });

    const result = await runWorksceneCreateAssist(
      "写作项目",
      deps,
      controller.signal,
    );

    expect(result).toEqual({ kind: "cancelled" });
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.create).not.toHaveBeenCalled();
  });

  it("持续不收尾时降级，不执行无确认副作用", async () => {
    const deps = makeDeps({
      complete: vi.fn(async () => '{"call":{"tool":"missing","input":{}}}'),
    });

    const result = await runWorksceneCreateAssist("写作项目", deps);

    expect(result.kind).toBe("fallback");
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.create).not.toHaveBeenCalled();
  });
});

describe("createWorksceneCreateSelectionRequest", () => {
  it("确认请求复用工作场景摘要，且只有创建 / 取消两个选择", () => {
    const request = createWorksceneCreateSelectionRequest({
      name: "写作",
      summary: "动作：创建工作场景\n新场景：写作",
    });

    expect(request.title).toContain("写作");
    expect(request.body).toEqual(["动作：创建工作场景", "新场景：写作"]);
    expect(request.options.map((option) => option.value)).toEqual([
      "create",
      "cancel",
    ]);
    expect(request.initialValue).toBe("create");
  });
});
