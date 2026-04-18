import { describe, expect, it } from "vitest";
import {
  assembleLayers,
  assembleSystemPrompt,
  buildToolCatalog,
} from "../layer-assembler.js";
import type { ToolDeclaration, LayerAssemblerInput } from "../layer-assembler.js";
import {
  INTERACTIVE_PROFILE,
  AUTONOMOUS_PROFILE,
  LOOKUP_PROFILE,
  hintToProfile,
} from "../context-profile.js";
import type { TurnDigest } from "../turn-digest.js";

// ─── 测试辅助 ───

const IDENTITY = "你是知行，一个智能助手。";

const ALL_TOOLS: ToolDeclaration[] = [
  { name: "read", description: "读取文件", categories: ["query"] },
  { name: "grep", description: "搜索代码", categories: ["query"] },
  { name: "edit", description: "编辑文件", categories: ["mutation"] },
  { name: "write", description: "写入文件", categories: ["mutation"] },
  { name: "bash", description: "执行命令", categories: ["execution"] },
  { name: "memory_write", description: "写入记忆", categories: ["memory-write"] },
  { name: "task_update", description: "更新任务", categories: ["task-ledger"] },
  { name: "send_message", description: "发送消息", categories: ["social"] },
  { name: "escalate", description: "场景升级", categories: ["scenario"] },
];

function makeInput(overrides: Partial<LayerAssemblerInput> = {}): LayerAssemblerInput {
  return {
    profile: INTERACTIVE_PROFILE,
    identity: IDENTITY,
    ...overrides,
  };
}

function makeDigest(overrides: Partial<TurnDigest> = {}): TurnDigest {
  return {
    turnIndex: 1,
    userMessagePreview: "测试",
    toolCalls: [],
    filesModified: [],
    outcome: "success",
    ...overrides,
  };
}

// ─── buildToolCatalog ───

describe("buildToolCatalog", () => {
  it("filters tools by allowed categories", () => {
    const result = buildToolCatalog(ALL_TOOLS, ["query", "scenario"]);

    expect(result).toContain("read");
    expect(result).toContain("grep");
    expect(result).toContain("escalate");
    expect(result).not.toContain("edit");
    expect(result).not.toContain("bash");
    expect(result).not.toContain("send_message");
  });

  it("includes tool if any category matches", () => {
    const multiCategoryTools: ToolDeclaration[] = [
      { name: "hybrid", description: "多类别工具", categories: ["query", "mutation"] },
    ];

    const result = buildToolCatalog(multiCategoryTools, ["query"]);
    expect(result).toContain("hybrid");
  });

  it("returns empty string when no tools match", () => {
    const result = buildToolCatalog(ALL_TOOLS, ["system"]);
    expect(result).toBe("");
  });

  it("returns empty string for empty tool list", () => {
    const result = buildToolCatalog([], ["query"]);
    expect(result).toBe("");
  });

  it("formats as [可用工具] header with one tool per line", () => {
    const result = buildToolCatalog(ALL_TOOLS, ["query"]);
    expect(result).toMatch(/^\[可用工具\]\n- read: .+\n- grep: .+$/);
  });
});

// ─── Layer 0: Identity + Tool Catalog ───

describe("Layer 0 (Static)", () => {
  it("always includes identity text", () => {
    const result = assembleLayers(makeInput());
    expect(result.layer0).toContain(IDENTITY);
  });

  it("includes filtered tool catalog when tools provided", () => {
    const result = assembleLayers(makeInput({ tools: ALL_TOOLS }));
    expect(result.layer0).toContain("[可用工具]");
    expect(result.layer0).toContain("read");
  });

  it("omits tool catalog when no tools", () => {
    const result = assembleLayers(makeInput({ tools: undefined }));
    expect(result.layer0).toBe(IDENTITY);
  });

  it("filters tools by profile.toolCategories", () => {
    const result = assembleLayers(
      makeInput({ profile: LOOKUP_PROFILE, tools: ALL_TOOLS }),
    );
    expect(result.layer0).toContain("read");
    expect(result.layer0).toContain("escalate");
    expect(result.layer0).not.toContain("edit");
    expect(result.layer0).not.toContain("bash");
  });
});

// ─── Layer 1: User Profile ───

describe("Layer 1 (Profile)", () => {
  it("includes user profile when includeProfile=true", () => {
    const result = assembleLayers(
      makeInput({
        profile: INTERACTIVE_PROFILE,
        userProfile: "25岁，软件工程师，偏好简洁代码",
      }),
    );
    expect(result.layer1).toContain("[用户画像]");
    expect(result.layer1).toContain("软件工程师");
  });

  it("skips when includeProfile=false", () => {
    const result = assembleLayers(
      makeInput({
        profile: LOOKUP_PROFILE,
        userProfile: "should be ignored",
      }),
    );
    expect(result.layer1).toBe("");
  });

  it("skips when no userProfile provided", () => {
    const result = assembleLayers(
      makeInput({ profile: INTERACTIVE_PROFILE, userProfile: undefined }),
    );
    expect(result.layer1).toBe("");
  });

  it("autonomous profile skips user profile", () => {
    const result = assembleLayers(
      makeInput({
        profile: AUTONOMOUS_PROFILE,
        userProfile: "should be ignored",
      }),
    );
    expect(result.layer1).toBe("");
  });
});

// ─── Layer 2: Scene Content ───

describe("Layer 2 (Scene)", () => {
  it("includes scene content for basic mode", () => {
    const result = assembleLayers(
      makeInput({
        profile: INTERACTIVE_PROFILE,
        sceneContent: "[技能] 代码审查\n审查PR时注意安全漏洞",
      }),
    );
    expect(result.layer2).toContain("代码审查");
  });

  it("includes scene content for enriched mode (social)", () => {
    const socialProfile = hintToProfile("social");
    const result = assembleLayers(
      makeInput({
        profile: socialProfile,
        sceneContent: "[关系] 张三：同事\n[日记] 2026-04-15 和张三讨论了项目",
      }),
    );
    expect(result.layer2).toContain("张三");
    expect(result.layer2).toContain("日记");
  });

  it("skips for skip mode (lookup)", () => {
    const result = assembleLayers(
      makeInput({
        profile: LOOKUP_PROFILE,
        sceneContent: "this should be ignored",
      }),
    );
    expect(result.layer2).toBe("");
  });

  it("returns empty when no sceneContent", () => {
    const result = assembleLayers(
      makeInput({ sceneContent: undefined }),
    );
    expect(result.layer2).toBe("");
  });

  it("includes scene content for minimal mode (autonomous)", () => {
    const result = assembleLayers(
      makeInput({
        profile: AUTONOMOUS_PROFILE,
        sceneContent: "[技能] 文件搜索",
      }),
    );
    expect(result.layer2).toContain("文件搜索");
  });
});

// ─── Layer 3: Dynamic ───

describe("Layer 3 (Dynamic)", () => {
  it("includes workspace context", () => {
    const result = assembleLayers(
      makeInput({ workspaceContext: "[工作区] /home/user/project" }),
    );
    expect(result.layer3).toContain("/home/user/project");
  });

  it("includes current time", () => {
    const result = assembleLayers(
      makeInput({ currentTime: "2026-04-18 14:30 CST" }),
    );
    expect(result.layer3).toContain("[当前时间] 2026-04-18 14:30 CST");
  });

  it("includes turn digest trail", () => {
    const result = assembleLayers(
      makeInput({
        turnDigests: [
          makeDigest({ turnIndex: 1, userMessagePreview: "重构代码" }),
          makeDigest({
            turnIndex: 2,
            userMessagePreview: "运行测试",
            toolCalls: ["bash(npm test)"],
          }),
        ],
      }),
    );
    expect(result.layer3).toContain("[轨迹]");
    expect(result.layer3).toContain("T1");
    expect(result.layer3).toContain("T2");
  });

  it("includes active task hint", () => {
    const result = assembleLayers(
      makeInput({ activeTaskHint: "重构 auth 模块 (3/7 完成)" }),
    );
    expect(result.layer3).toContain("[活跃任务]");
    expect(result.layer3).toContain("3/7 完成");
  });

  it("returns empty when no dynamic content", () => {
    const result = assembleLayers(makeInput());
    expect(result.layer3).toBe("");
  });

  it("joins multiple components with double newline", () => {
    const result = assembleLayers(
      makeInput({
        workspaceContext: "[工作区] /project",
        currentTime: "2026-04-18",
        activeTaskHint: "任务进行中",
      }),
    );
    expect(result.layer3).toContain("\n\n");
  });
});

// ─── assembleSystemPrompt (full integration) ───

describe("assembleSystemPrompt", () => {
  it("joins non-empty layers with --- separator", () => {
    const result = assembleSystemPrompt(
      makeInput({
        tools: ALL_TOOLS,
        userProfile: "工程师",
        workspaceContext: "[工作区] /project",
      }),
    );

    expect(result).toContain("---");
    expect(result).toContain(IDENTITY);
    expect(result).toContain("[用户画像]");
    expect(result).toContain("[工作区]");
  });

  it("omits empty layers (no consecutive separators)", () => {
    const result = assembleSystemPrompt(makeInput());
    expect(result).not.toContain("---\n\n---");
    expect(result).toBe(IDENTITY);
  });

  it("lookup profile: only Layer 0 + Layer 3 (no L1, no L2)", () => {
    const result = assembleLayers(
      makeInput({
        profile: LOOKUP_PROFILE,
        tools: ALL_TOOLS,
        userProfile: "should be skipped",
        sceneContent: "should be skipped",
        currentTime: "2026-04-18",
      }),
    );

    expect(result.layer0).toContain(IDENTITY);
    expect(result.layer0).toContain("read");
    expect(result.layer0).not.toContain("edit");
    expect(result.layer1).toBe("");
    expect(result.layer2).toBe("");
    expect(result.layer3).toContain("2026-04-18");
  });

  it("social profile: enriched Layer 2 included", () => {
    const socialProfile = hintToProfile("social");
    const result = assembleLayers(
      makeInput({
        profile: socialProfile,
        tools: ALL_TOOLS,
        userProfile: "用户画像",
        sceneContent: "丰富的关系数据",
      }),
    );

    expect(result.layer1).toContain("[用户画像]");
    expect(result.layer2).toContain("丰富的关系数据");
  });

  it("autonomous profile: no L1, minimal L2, restricted tools", () => {
    const result = assembleLayers(
      makeInput({
        profile: AUTONOMOUS_PROFILE,
        tools: ALL_TOOLS,
        userProfile: "should be skipped",
        sceneContent: "minimal content",
      }),
    );

    expect(result.layer0).not.toContain("send_message");
    expect(result.layer0).not.toContain("memory_write");
    expect(result.layer0).toContain("bash");
    expect(result.layer1).toBe("");
    expect(result.layer2).toContain("minimal content");
  });
});

// ─── LayerResult.systemPrompt consistency ───

describe("LayerResult consistency", () => {
  it("systemPrompt equals assembleSystemPrompt output", () => {
    const input = makeInput({
      tools: ALL_TOOLS,
      userProfile: "测试用户",
      sceneContent: "测试场景",
      workspaceContext: "[工作区]",
      currentTime: "now",
    });

    const layerResult = assembleLayers(input);
    const directResult = assembleSystemPrompt(input);

    expect(layerResult.systemPrompt).toBe(directResult);
  });
});
