import { describe, it, expect } from "vitest";
import {
  buildSystemPrompt,
  CACHE_BOUNDARY,
  MAIN_AGENT_SEGMENTS,
  SUB_AGENT_DELEGATION_TEXT,
  SUB_AGENT_SEGMENTS,
  WORKING_MODE_TEXT,
} from "../system-prompt.js";
import { subAgentProfile } from "../../profile/default-profiles.js";
import type { ToolDefinition } from "@zhixing/core";
import { createWebFetchTool } from "@zhixing/tools-builtin";

// ─── 工具工厂 ───

function stubTool(name: string, overrides?: Partial<ToolDefinition>): ToolDefinition {
  return {
    name,
    description: `stub ${name}`,
    inputSchema: { type: "object" },
    call: async () => ({ content: "" }),
    ...overrides,
  };
}

const defaultTools = [
  stubTool("read"),
  stubTool("write"),
  stubTool("edit"),
  stubTool("glob"),
  stubTool("grep"),
  stubTool("bash"),
];

// ─── 测试 ───

describe("buildSystemPrompt", () => {
  const ctx = { tools: defaultTools, cwd: "/test/project" };

  it("包含身份定义", () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("Zhixing");
    expect(prompt).toContain("知行");
  });

  it("包含工作原则", () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("## Principles");
    expect(prompt).toContain("Read before edit");
  });

  it("包含动态生成的工具使用段", () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("## Tool Usage");
    expect(prompt).toContain("`read`");
    expect(prompt).toContain("`grep`");
    expect(prompt).toContain("`glob`");
    expect(prompt).toContain("`edit`");
    expect(prompt).toContain("`write`");
    expect(prompt).toContain("`bash`");
  });

  it("含 Commitment 信号抑制叙述原则", async () => {
    const { COMMITMENT_SIGNAL } = await import("@zhixing/core");
    const prompt = buildSystemPrompt(ctx);
    // 直接引用 core 常量——保证系统提示里的信号字面与 tool-executor 附加到 content 的逐字一致
    expect(prompt).toContain(COMMITMENT_SIGNAL);
    expect(prompt).toMatch(/Do NOT restate|not restate/i);
  });

  it("包含风格段", () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("## Style");
    expect(prompt).toContain("concise");
  });

  it("包含安全段", () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("## Safety");
    expect(prompt).toContain("destructive");
  });

  it("包含消息流元协议段(解释 <system-meta> 标签)", () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("[系统元信息标签]");
    expect(prompt).toContain("<system-meta kind=");
    expect(prompt).toContain("compact-summary");
    expect(prompt).toContain("dropped-turns");
  });

  it("元协议段位于 Principles 之后、Tool Usage 之前", () => {
    const prompt = buildSystemPrompt(ctx);
    const principlesIdx = prompt.indexOf("## Principles");
    const metaIdx = prompt.indexOf("[系统元信息标签]");
    const toolUsageIdx = prompt.indexOf("## Tool Usage");
    expect(principlesIdx).toBeGreaterThan(0);
    expect(metaIdx).toBeGreaterThan(principlesIdx);
    expect(toolUsageIdx).toBeGreaterThan(metaIdx);
  });

  it("子 agent system prompt 也包含元协议段", () => {
    const profile = subAgentProfile({ subAgentId: "sub-1", task: "t" });
    const prompt = buildSystemPrompt({
      ...ctx,
      profile,
      segments: SUB_AGENT_SEGMENTS,
    });
    expect(prompt).toContain("[系统元信息标签]");
  });

  it("元协议段在不同 ctx / 调用次数间 byte-equal(prompt cache 友好)", () => {
    // 元协议段位于缓存分界之前的静态区,跨 ctx 必须 byte-equal
    const prompt1 = buildSystemPrompt(ctx);
    const prompt2 = buildSystemPrompt({ ...ctx, cwd: "/other/path" });
    const static1 = prompt1.split(CACHE_BOUNDARY)[0]!;
    const static2 = prompt2.split(CACHE_BOUNDARY)[0]!;
    expect(static1).toBe(static2);
    expect(static1).toContain("[系统元信息标签]");
  });

  it("包含缓存分界标记", () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("__ZHIXING_CACHE_BOUNDARY__");
  });

  it("分界标记将静态区和动态区分隔", () => {
    const prompt = buildSystemPrompt(ctx);
    const [before, after] = prompt.split(CACHE_BOUNDARY);

    // 静态区包含身份和原则
    expect(before).toContain("Zhixing");
    expect(before).toContain("## Principles");

    // 动态区包含环境信息
    expect(after).toContain("## Environment");
    expect(after).toContain("/test/project");
  });

  it("包含环境信息", () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain("## Environment");
    expect(prompt).toContain("Working directory: /test/project");
    expect(prompt).toContain("Platform:");
    expect(prompt).toContain("Node.js:");
  });

  it("shell 参数会出现在环境段", () => {
    const prompt = buildSystemPrompt({ ...ctx, shell: "zsh" });
    expect(prompt).toContain("Shell: zsh");
  });

  it("不传 shell 时环境段不含 Shell 行", () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).not.toContain("Shell:");
  });

  describe("Working directory 字段语义（workspace > cwd 优先）", () => {
    // 架构契约（单一字段语义）：用户配置 workspace 后,workspace 就是用户认知的
    // "工作目录"。chrome welcome 也将其标为"工作目录"。LLM 收到的 "Working
    // directory" 必须与用户视角一致——指向 workspace，避免中英文翻译
    // （"工作目录" ↔ "Working directory"）让 LLM 错位到 cwd。

    it("配置了 workspace 时,Working directory 指向 workspace 而非 cwd", () => {
      const prompt = buildSystemPrompt({
        ...ctx,
        cwd: "/where/cli/launched",
        workspace: "/user/workspace",
      });
      expect(prompt).toContain("Working directory: /user/workspace");
      // 反向断言:cwd 不应作为"工作目录"暴露给 LLM
      expect(prompt).not.toContain("Working directory: /where/cli/launched");
    });

    it("未配置 workspace 时,Working directory fallback 到 cwd", () => {
      const prompt = buildSystemPrompt({ ...ctx, cwd: "/just/cwd" });
      expect(prompt).toContain("Working directory: /just/cwd");
    });

    it("system prompt 不暴露 cwd 字段—— cwd 是 cli 实现细节,LLM 不需知道", () => {
      // 即使 workspace 与 cwd 不同,prompt 也不应该把 cwd 作为独立字段告诉 LLM。
      // 这是修复"用户问'工作目录里有什么',LLM 用 cwd 而非 workspace"bug 的核心契约。
      const prompt = buildSystemPrompt({
        ...ctx,
        cwd: "/where/cli/launched",
        workspace: "/user/workspace",
      });
      // 不出现单独的 cwd 字段(无论以何种名义)
      expect(prompt).not.toContain("/where/cli/launched");
      // 不出现描述两者差异的旧 Note
      expect(prompt).not.toContain("workspace and working directory differ");
    });

    it("workspace === cwd 场景行为不变(用户在工作区内启动 cli)", () => {
      const samePath = "/user/workspace";
      const prompt = buildSystemPrompt({
        ...ctx,
        cwd: samePath,
        workspace: samePath,
      });
      expect(prompt).toContain(`Working directory: ${samePath}`);
      // 同一路径不应出现两次(消除"Working directory" + "Workspace" 双字段冗余)
      const occurrences = prompt.split(samePath).length - 1;
      expect(occurrences).toBe(1);
    });
  });

  describe("工具段动态适应", () => {
    it("仅有 read 工具时，工具段只包含 read", () => {
      const prompt = buildSystemPrompt({ ...ctx, tools: [stubTool("read")] });
      expect(prompt).toContain("`read`");
      expect(prompt).not.toContain("`grep`");
      expect(prompt).not.toContain("`bash`");
    });

    it("无工具时，工具段只有标题", () => {
      const prompt = buildSystemPrompt({ ...ctx, tools: [] });
      expect(prompt).toContain("## Tool Usage");
      expect(prompt).not.toContain("`read`");
    });

    it("添加自定义工具时不影响已有段落", () => {
      const tools = [...defaultTools, stubTool("custom_tool")];
      const prompt = buildSystemPrompt({ ...ctx, tools });
      expect(prompt).toContain("`read`");
    });

    it("常规装配下输出 hint-list 工具使用段", () => {
      const prompt = buildSystemPrompt({ ...ctx, tools: [stubTool("read")] });
      // 老格式 "Use `X` to ..." 仍然输出
      expect(prompt).toContain("Use `read` to view file contents");
    });

    it("包含 parallelSafe 工具时提示并行", () => {
      const tools = [stubTool("read", { isParallelSafe: true })];
      const prompt = buildSystemPrompt({ ...ctx, tools });
      expect(prompt).toContain("parallel");
    });

    it("含 web_fetch(真实工具)时输出 distill / preapproved hosts / not-search 引导", () => {
      const prompt = buildSystemPrompt({
        ...ctx,
        tools: [createWebFetchTool()],
      });
      expect(prompt).toContain("`web_fetch`");
      expect(prompt).toMatch(/does not search the web/i);
      expect(prompt).toMatch(/with `prompt`/i);
      expect(prompt).toMatch(/without `prompt`/i);
      expect(prompt).toContain("github.com");
      expect(prompt).toContain("docs.anthropic.com");
      expect(prompt).toMatch(/Do not invent URLs/i);
    });

    it("不含 web_fetch 时无 web_fetch 引导段", () => {
      const prompt = buildSystemPrompt({ ...ctx, tools: [stubTool("read")] });
      expect(prompt).not.toContain("`web_fetch`");
      expect(prompt).not.toContain("Pre-approved hosts");
    });

    it("自描述 systemPromptHints 通用透传(任意工具自带 hints 都生效)", () => {
      const customHints = [
        "- Use `custom_tool` for X",
        "- Custom hint line 2",
      ];
      const tool = stubTool("custom_tool", { systemPromptHints: customHints });
      const prompt = buildSystemPrompt({ ...ctx, tools: [tool] });
      expect(prompt).toContain("Use `custom_tool` for X");
      expect(prompt).toContain("Custom hint line 2");
    });

    it("无 systemPromptHints 字段的工具不影响其他工具的 hints", () => {
      const toolWithHints = stubTool("custom_a", {
        systemPromptHints: ["- Hint A"],
      });
      const toolWithout = stubTool("custom_b");
      const prompt = buildSystemPrompt({ ...ctx, tools: [toolWithHints, toolWithout] });
      expect(prompt).toContain("Hint A");
    });
  });

  it("静态区在不同 cwd 间保持一致", () => {
    const prompt1 = buildSystemPrompt({ ...ctx, cwd: "/project/a" });
    const prompt2 = buildSystemPrompt({ ...ctx, cwd: "/project/b" });

    const static1 = prompt1.split(CACHE_BOUNDARY)[0];
    const static2 = prompt2.split(CACHE_BOUNDARY)[0];

    expect(static1).toBe(static2);
  });

  // ─── byte-equal 锚点 ───
  //
  // 主路径 prompt 是产品契约 —— 任何无意改动(段顺序、文案、缓存分界标记格式)
  // 都会让此快照失守,强制开发者主动审视改动。环境段含 platform / Node 版本等
  // 动态字段,此处仅锚定缓存分界之前的静态区。
  it("主路径静态区(默认 profile + 默认 segments,无 memory 工具)byte-equal 锚点", () => {
    const prompt = buildSystemPrompt(ctx);
    const staticPart = prompt.split(CACHE_BOUNDARY)[0];
    expect(staticPart).toMatchInlineSnapshot(`
      "You are Zhixing (知行), a personal intelligent assistant.
      Your name means "unity of knowledge and action" — you understand problems and take action to solve them.

      ## Principles
      - Respond in the same language the user uses
      - When a task requires action, use tools immediately without asking for permission
      - Read before edit: always read a file before modifying it to ensure exact text match
      - Edit over write: prefer targeted replacement over full overwrite when modifying existing files
      - Search before act: use glob/grep to discover relevant files before reading or editing
      - If a command fails, analyze the error and try an alternative approach
      - Show your reasoning when making non-obvious decisions

      [系统元信息标签]
      对话历史中可能出现 <system-meta kind="..."> 标签，这是上下文管理机制插入的元信息，不是用户原话：
      - kind="compact-summary": 之前对话的压缩摘要，已替代早期消息
      - kind="ack": 紧跟摘要的阅读回执（由你先前发出）
      - kind="dropped-turns" count="N": 已省略 N 轮对话的占位标记

      遇到这些标签时：
      - 按 kind 字段理解含义，将其中内容作为上下文使用
      - 不要回应标签本身（它们不是用户提问）
      - 基于可见的信息继续对话

      ## Tool Usage
      - Use \`read\` to view file contents, not bash cat/head/tail
      - Use \`grep\` to search file contents by regex, not bash grep/rg
      - Use \`glob\` to find files by name pattern, not bash find
      - Use \`edit\` for targeted text replacements, not bash sed/awk
      - Use \`write\` to create files or overwrite entire content
      - Use \`bash\` for system commands, package management, git operations, and tasks not covered by other tools
      - If a tool result ends with \`[Commitment already sent to user. Do not restate.]\`, the user has already seen the tool's confirmation directly via a commit message. Do NOT restate what the tool just did (no "已创建..." / "I've scheduled..."). If no additional insight is needed, end the turn with a brief acknowledgment or no text.

      ## Style
      - Be warm, concise, and natural in conversation
      - Do not use emojis unless the user does
      - Use markdown for code blocks and structured output
      - Keep responses focused — answer what was asked
      - When introducing yourself, speak conversationally — never list capabilities

      ## Safety
      - Never execute destructive commands (rm -rf /, DROP DATABASE, etc.) without explicit user request
      - Do not access files outside the workspace unless the user's intent is clear
      - Refuse requests that could compromise system security"
    `);
  });

  // 含 memory 工具时主 agent 完整段集的 byte-equal 锚点。
  // 与上一条无 memory 锚点互补:Tool Usage 的 memory 提示行改动 / 段顺序变化
  // 都会被此快照拦截。两个快照共同覆盖主 agent 段集全态。
  it("主路径静态区(默认 profile + 含 memory 工具)完整段集 byte-equal 锚点", () => {
    const prompt = buildSystemPrompt({
      ...ctx,
      tools: [...defaultTools, stubTool("memory")],
    });
    const staticPart = prompt.split(CACHE_BOUNDARY)[0];
    expect(staticPart).toMatchInlineSnapshot(`
      "You are Zhixing (知行), a personal intelligent assistant.
      Your name means "unity of knowledge and action" — you understand problems and take action to solve them.

      ## Principles
      - Respond in the same language the user uses
      - When a task requires action, use tools immediately without asking for permission
      - Read before edit: always read a file before modifying it to ensure exact text match
      - Edit over write: prefer targeted replacement over full overwrite when modifying existing files
      - Search before act: use glob/grep to discover relevant files before reading or editing
      - If a command fails, analyze the error and try an alternative approach
      - Show your reasoning when making non-obvious decisions

      [系统元信息标签]
      对话历史中可能出现 <system-meta kind="..."> 标签，这是上下文管理机制插入的元信息，不是用户原话：
      - kind="compact-summary": 之前对话的压缩摘要，已替代早期消息
      - kind="ack": 紧跟摘要的阅读回执（由你先前发出）
      - kind="dropped-turns" count="N": 已省略 N 轮对话的占位标记

      遇到这些标签时：
      - 按 kind 字段理解含义，将其中内容作为上下文使用
      - 不要回应标签本身（它们不是用户提问）
      - 基于可见的信息继续对话

      ## Tool Usage
      - Use \`read\` to view file contents, not bash cat/head/tail
      - Use \`grep\` to search file contents by regex, not bash grep/rg
      - Use \`glob\` to find files by name pattern, not bash find
      - Use \`edit\` for targeted text replacements, not bash sed/awk
      - Use \`write\` to create files or overwrite entire content
      - Use \`bash\` for system commands, package management, git operations, and tasks not covered by other tools
      - Use \`memory\` to save, search, and manage the user's persistent memories (identity, relationships)
      - When the user says "remember this" or shares personal info, save it with \`memory\`
      - Always confirm before saving new memories, unless the user explicitly asked you to remember
      - If a tool result ends with \`[Commitment already sent to user. Do not restate.]\`, the user has already seen the tool's confirmation directly via a commit message. Do NOT restate what the tool just did (no "已创建..." / "I've scheduled..."). If no additional insight is needed, end the turn with a brief acknowledgment or no text.

      ## Style
      - Be warm, concise, and natural in conversation
      - Do not use emojis unless the user does
      - Use markdown for code blocks and structured output
      - Keep responses focused — answer what was asked
      - When introducing yourself, speak conversationally — never list capabilities

      ## Safety
      - Never execute destructive commands (rm -rf /, DROP DATABASE, etc.) without explicit user request
      - Do not access files outside the workspace unless the user's intent is clear
      - Refuse requests that could compromise system security"
    `);
  });

  // 子 agent 装配链路的 byte-equal 锚点 —— 锁定 SUB_AGENT_SEGMENTS 的 4 段输出。
  //
  // 任何下列改动都会被此快照拦截:
  //   - SUB_AGENT_SEGMENTS 段集合 / 段顺序变更
  //   - subAgentProfile() 身份段 / Constraints 文案变更
  //   - principles / tool-usage / safety 段文案变更对子的影响
  //   - 子 agent 渗透 style 段(应被严格排除)
  //
  // 与主 agent 双锚点互补 —— 共同保证主子两条 system prompt 路径都被 byte-equal 锁定。
  it("子 agent SUB_AGENT_SEGMENTS 4 段(无 memory / 无 style)byte-equal 锚点", () => {
    // 固定 subAgentId 让 displayName 可锚定;真实 spawn 时 id 由 dispatcher 生成
    const profile = subAgentProfile({
      subAgentId: "abc123def",
      task: "Read src/foo.ts and summarize its public API.",
    });
    const prompt = buildSystemPrompt({
      ...ctx,
      profile,
      segments: SUB_AGENT_SEGMENTS,
    });
    const staticPart = prompt.split(CACHE_BOUNDARY)[0];
    expect(staticPart).toMatchInlineSnapshot(`
      "# Your Role
      You are a sub-agent dispatched by the main agent to perform the following task:

      \`\`\`
      Read src/foo.ts and summarize its public API.
      \`\`\`

      # Constraints
      - Your output is read by the main agent only — the user does not see it. Make your output self-contained; do not reference 'just now' or other context the user might assume.
      - Use as few tool calls as possible. When you have enough to answer, finalize.
      - You do not have access to the Task tool — you cannot dispatch further sub-agents.
      - Stay focused on the assigned task. Do not initiate user conversation, do not send external messages.

      ## Principles
      - Respond in the same language the user uses
      - When a task requires action, use tools immediately without asking for permission
      - Read before edit: always read a file before modifying it to ensure exact text match
      - Edit over write: prefer targeted replacement over full overwrite when modifying existing files
      - Search before act: use glob/grep to discover relevant files before reading or editing
      - If a command fails, analyze the error and try an alternative approach
      - Show your reasoning when making non-obvious decisions

      [系统元信息标签]
      对话历史中可能出现 <system-meta kind="..."> 标签，这是上下文管理机制插入的元信息，不是用户原话：
      - kind="compact-summary": 之前对话的压缩摘要，已替代早期消息
      - kind="ack": 紧跟摘要的阅读回执（由你先前发出）
      - kind="dropped-turns" count="N": 已省略 N 轮对话的占位标记

      遇到这些标签时：
      - 按 kind 字段理解含义，将其中内容作为上下文使用
      - 不要回应标签本身（它们不是用户提问）
      - 基于可见的信息继续对话

      ## Tool Usage
      - Use \`read\` to view file contents, not bash cat/head/tail
      - Use \`grep\` to search file contents by regex, not bash grep/rg
      - Use \`glob\` to find files by name pattern, not bash find
      - Use \`edit\` for targeted text replacements, not bash sed/awk
      - Use \`write\` to create files or overwrite entire content
      - Use \`bash\` for system commands, package management, git operations, and tasks not covered by other tools
      - If a tool result ends with \`[Commitment already sent to user. Do not restate.]\`, the user has already seen the tool's confirmation directly via a commit message. Do NOT restate what the tool just did (no "已创建..." / "I've scheduled..."). If no additional insight is needed, end the turn with a brief acknowledgment or no text.

      ## Safety
      - Never execute destructive commands (rm -rf /, DROP DATABASE, etc.) without explicit user request
      - Do not access files outside the workspace unless the user's intent is clear
      - Refuse requests that could compromise system security"
    `);
  });
});

// ─── Segment: Sub-Agent Delegation 条件性渲染契约 ───

describe("buildSystemPrompt · sub-agent-delegation 段条件性渲染", () => {
  const ctx = { tools: defaultTools, cwd: "/test/project" };

  it("MAIN_AGENT_SEGMENTS 含 'sub-agent-delegation'(主 agent 启用此段)", () => {
    expect(MAIN_AGENT_SEGMENTS).toContain("sub-agent-delegation");
  });

  it("SUB_AGENT_SEGMENTS 不含 'sub-agent-delegation'(子 agent 工具集无 Task,delegation 无意义)", () => {
    expect(SUB_AGENT_SEGMENTS).not.toContain("sub-agent-delegation");
  });

  it("tools 不含 Task 时不渲染 delegation 段(byte-equal 历史输出,无回归)", () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).not.toContain("## Sub-Agent Delegation");
    expect(prompt).not.toContain("Task tool");
  });

  it("tools 含 Task 时渲染 delegation 段,内容 byte-equal SUB_AGENT_DELEGATION_TEXT", () => {
    const tools = [...defaultTools, stubTool("Task")];
    const prompt = buildSystemPrompt({ ...ctx, tools });
    expect(prompt).toContain(SUB_AGENT_DELEGATION_TEXT);
    expect(prompt).toContain("## Sub-Agent Delegation (Task tool)");
  });

  it("delegation 段含关键决策语义:When to use / parallel / failure 暴露契约", () => {
    const tools = [...defaultTools, stubTool("Task")];
    const prompt = buildSystemPrompt({ ...ctx, tools });
    expect(prompt).toContain("When to use Task:");
    expect(prompt).toContain("up to 3 Tasks in a single turn");
    expect(prompt).toContain("MUST surface the failure");
  });

  it("delegation 段紧跟 tool-usage 段(段顺序不变)", () => {
    const tools = [...defaultTools, stubTool("Task")];
    const prompt = buildSystemPrompt({ ...ctx, tools });
    const toolUsageIdx = prompt.indexOf("## Tool Usage");
    const delegationIdx = prompt.indexOf("## Sub-Agent Delegation");
    expect(toolUsageIdx).toBeGreaterThan(0);
    expect(delegationIdx).toBeGreaterThan(toolUsageIdx);
  });

  it("子 agent 装配(SUB_AGENT_SEGMENTS)即使 tools 含 Task 也不渲染 delegation(段未启用)", () => {
    // 极端测试:子 agent 工具集出错地含 Task 时,segment 未启用是最后一道防线
    const profile = subAgentProfile({ subAgentId: "x", task: "t" });
    const tools = [...defaultTools, stubTool("Task")];
    const prompt = buildSystemPrompt({
      ...ctx,
      profile,
      segments: SUB_AGENT_SEGMENTS,
      tools,
    });
    expect(prompt).not.toContain("## Sub-Agent Delegation");
  });

  it("含 Task 工具完整 byte-equal 锚点(主路径开 Task 后的全段输出)", () => {
    const tools = [...defaultTools, stubTool("Task")];
    const prompt = buildSystemPrompt({ ...ctx, tools });
    const staticPart = prompt.split(CACHE_BOUNDARY)[0];
    expect(staticPart).toMatchInlineSnapshot(`
      "You are Zhixing (知行), a personal intelligent assistant.
      Your name means "unity of knowledge and action" — you understand problems and take action to solve them.

      ## Principles
      - Respond in the same language the user uses
      - When a task requires action, use tools immediately without asking for permission
      - Read before edit: always read a file before modifying it to ensure exact text match
      - Edit over write: prefer targeted replacement over full overwrite when modifying existing files
      - Search before act: use glob/grep to discover relevant files before reading or editing
      - If a command fails, analyze the error and try an alternative approach
      - Show your reasoning when making non-obvious decisions

      [系统元信息标签]
      对话历史中可能出现 <system-meta kind="..."> 标签，这是上下文管理机制插入的元信息，不是用户原话：
      - kind="compact-summary": 之前对话的压缩摘要，已替代早期消息
      - kind="ack": 紧跟摘要的阅读回执（由你先前发出）
      - kind="dropped-turns" count="N": 已省略 N 轮对话的占位标记

      遇到这些标签时：
      - 按 kind 字段理解含义，将其中内容作为上下文使用
      - 不要回应标签本身（它们不是用户提问）
      - 基于可见的信息继续对话

      ## Tool Usage
      - Use \`read\` to view file contents, not bash cat/head/tail
      - Use \`grep\` to search file contents by regex, not bash grep/rg
      - Use \`glob\` to find files by name pattern, not bash find
      - Use \`edit\` for targeted text replacements, not bash sed/awk
      - Use \`write\` to create files or overwrite entire content
      - Use \`bash\` for system commands, package management, git operations, and tasks not covered by other tools
      - If a tool result ends with \`[Commitment already sent to user. Do not restate.]\`, the user has already seen the tool's confirmation directly via a commit message. Do NOT restate what the tool just did (no "已创建..." / "I've scheduled..."). If no additional insight is needed, end the turn with a brief acknowledgment or no text.

      ## Sub-Agent Delegation (Task tool)

      You have access to a \`Task\` tool that lets you launch sub-agents for research-style sub-tasks with isolated context.

      When to use Task:
      - Research tasks needing multiple Read/Grep/WebFetch rounds (sub-agent's intermediate results don't pollute your context window)
      - Comparison/contrast tasks (dispatch parallel Tasks, e.g. "compare A vs B vs C" → 3 Tasks)
      - Multi-perspective analysis (e.g. security review + performance review + readability review)

      You may launch up to 3 Tasks in a single turn. They run in parallel.

      When a Task fails, you MUST surface the failure in your final response — do not silently continue or pretend it succeeded.

      ## Style
      - Be warm, concise, and natural in conversation
      - Do not use emojis unless the user does
      - Use markdown for code blocks and structured output
      - Keep responses focused — answer what was asked
      - When introducing yourself, speak conversationally — never list capabilities

      ## Safety
      - Never execute destructive commands (rm -rf /, DROP DATABASE, etc.) without explicit user request
      - Do not access files outside the workspace unless the user's intent is clear
      - Refuse requests that could compromise system security"
    `);
  });
});

// ─── Segment: Working Mode 条件性渲染契约 ───

describe("buildSystemPrompt · working-mode 段条件性渲染", () => {
  const ctx = { tools: defaultTools, cwd: "/test/project" };

  it("MAIN_AGENT_SEGMENTS 含 'working-mode'(主 agent 启用此段)", () => {
    expect(MAIN_AGENT_SEGMENTS).toContain("working-mode");
  });

  it("SUB_AGENT_SEGMENTS 不含 'working-mode'(子 agent 无 workmode 工具)", () => {
    expect(SUB_AGENT_SEGMENTS).not.toContain("working-mode");
  });

  it("tools 不含 workmode_enter 时不渲染(byte-equal 历史输出,无回归)", () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).not.toContain("## Working Mode");
  });

  it("含 workmode_enter(power 只有 exit)时也不渲染 —— 仅 main runtime 启用", () => {
    const prompt = buildSystemPrompt({
      ...ctx,
      tools: [...defaultTools, stubTool("workmode_exit")],
    });
    expect(prompt).not.toContain("## Working Mode");
  });

  it("tools 含 workmode_enter 时渲染,内容 byte-equal WORKING_MODE_TEXT", () => {
    const tools = [...defaultTools, stubTool("workmode_enter")];
    const prompt = buildSystemPrompt({ ...ctx, tools });
    expect(prompt).toContain(WORKING_MODE_TEXT);
    expect(prompt).toContain("## Working Mode (work scenes)");
  });

  it("段含关键决策语义:先探后问 / turn 边界生效", () => {
    const tools = [...defaultTools, stubTool("workmode_enter")];
    const prompt = buildSystemPrompt({ ...ctx, tools });
    expect(prompt).toContain("workscene_memory_query");
    expect(prompt).toContain("Probe before asking, ask before switching");
    expect(prompt).toContain("the switch happens at the turn boundary");
  });

  it("working-mode 段紧跟 sub-agent-delegation(段顺序不变)", () => {
    const tools = [
      ...defaultTools,
      stubTool("Task"),
      stubTool("workmode_enter"),
    ];
    const prompt = buildSystemPrompt({ ...ctx, tools });
    const delegationIdx = prompt.indexOf("## Sub-Agent Delegation");
    const workingModeIdx = prompt.indexOf("## Working Mode");
    expect(delegationIdx).toBeGreaterThan(0);
    expect(workingModeIdx).toBeGreaterThan(delegationIdx);
  });
});

// ─── Segment: Skill Index 条件性渲染契约 ───

describe("buildSystemPrompt · skill-index 段条件性渲染", () => {
  const ctx = { tools: defaultTools, cwd: "/test/project" };
  // 段只逐字透传装配方预渲染好的字符串,不感知 renderSkillIndex 的具体产出 ——
  // 故用任意标记串验证"透传 / 跳过"语义,不耦合 core 的渲染实现。
  const SKILL_INDEX_SAMPLE =
    "## Available Skills\n- **deploy**: 部署流程\n- **review**: 代码审查约定";

  it("MAIN_AGENT_SEGMENTS 含 'skill-index'(主 agent 启用此段)", () => {
    expect(MAIN_AGENT_SEGMENTS).toContain("skill-index");
  });

  it("SUB_AGENT_SEGMENTS 不含 'skill-index'(子 agent 不注入技能)", () => {
    expect(SUB_AGENT_SEGMENTS).not.toContain("skill-index");
  });

  it("不传 skillIndex 时不渲染(byte-equal 历史输出,无技能用户无回归)", () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).not.toContain("## Available Skills");
  });

  it("skillIndex 为 null 时不渲染(与缺省同义)", () => {
    const prompt = buildSystemPrompt({ ...ctx, skillIndex: null });
    expect(prompt).not.toContain("## Available Skills");
  });

  it("skillIndex 为字符串时逐字透传进 prompt", () => {
    const prompt = buildSystemPrompt({ ...ctx, skillIndex: SKILL_INDEX_SAMPLE });
    expect(prompt).toContain(SKILL_INDEX_SAMPLE);
  });

  it("skill-index 段紧随 working-mode(置于 working-mode 之后)", () => {
    const prompt = buildSystemPrompt({
      ...ctx,
      tools: [...defaultTools, stubTool("workmode_enter")],
      skillIndex: SKILL_INDEX_SAMPLE,
    });
    const workingModeIdx = prompt.indexOf("## Working Mode");
    const skillIdx = prompt.indexOf("## Available Skills");
    expect(workingModeIdx).toBeGreaterThan(0);
    expect(skillIdx).toBeGreaterThan(workingModeIdx);
  });
});

// ─── profile / segments 扩展点 ───

describe("buildSystemPrompt · profile + segments 扩展点", () => {
  const ctx = { tools: defaultTools, cwd: "/test/project" };

  it("默认 profile / 默认 segments 等价于不传(主路径 byte-equal)", () => {
    const baseline = buildSystemPrompt(ctx);
    const explicit = buildSystemPrompt({
      ...ctx,
      // 不传 profile / segments,显式与默认值等价
    });
    expect(explicit).toBe(baseline);
  });

  it("自定义 segments 子集只输出指定段", () => {
    const prompt = buildSystemPrompt({
      ...ctx,
      segments: ["identity", "tool-usage"],
    });
    expect(prompt).toContain("Zhixing");
    expect(prompt).toContain("## Tool Usage");
    expect(prompt).not.toContain("## Principles");
    expect(prompt).not.toContain("## Style");
    expect(prompt).not.toContain("## Safety");
  });

  it("空 segments 数组只剩缓存分界 + 环境段", () => {
    const prompt = buildSystemPrompt({ ...ctx, segments: [] });
    expect(prompt.startsWith(CACHE_BOUNDARY.replace(/^\n|\n$/g, ""))).toBe(false);
    expect(prompt).toContain("## Environment");
    expect(prompt).not.toContain("Zhixing");
  });

  it("自定义 profile.instructions 替换身份段文本", () => {
    const customProfile = {
      name: "TestBot",
      role: "main",
      instructions: "I am TestBot — a custom assistant.",
      constraints: [] as readonly string[],
    };
    const prompt = buildSystemPrompt({ ...ctx, profile: customProfile });
    expect(prompt).toContain("I am TestBot");
    expect(prompt).not.toContain("You are Zhixing");
  });

  it("profile.constraints 非空时追加 Constraints 段", () => {
    const profile = {
      name: "Bot",
      role: "sub",
      instructions: "I am a sub-agent.",
      constraints: ["Do not access external resources.", "Be terse."],
    };
    const prompt = buildSystemPrompt({
      ...ctx,
      profile,
      segments: ["identity"],
    });
    expect(prompt).toContain("# Constraints");
    expect(prompt).toContain("- Do not access external resources.");
    expect(prompt).toContain("- Be terse.");
  });

  it("profile.tone 存在时前置 Tone 段", () => {
    const profile = {
      name: "Bot",
      role: "main",
      instructions: "I am Bot.",
      tone: "Be encouraging.",
      constraints: [] as readonly string[],
    };
    const prompt = buildSystemPrompt({
      ...ctx,
      profile,
      segments: ["identity"],
    });
    expect(prompt).toContain("# Tone");
    expect(prompt).toContain("Be encouraging.");
    // Tone 在 instructions 之前
    expect(prompt.indexOf("# Tone")).toBeLessThan(prompt.indexOf("I am Bot."));
  });
});

describe("segmentOverrides(段内容运行时覆盖)", () => {
  const base = { tools: defaultTools, cwd: "/test/project" };

  it("覆盖 skill-index 段:输出含 override 内容", () => {
    const out = buildSystemPrompt({
      ...base,
      segmentOverrides: { "skill-index": "## OVERRIDE-SKILLS" },
    });
    expect(out).toContain("## OVERRIDE-SKILLS");
  });

  it("override 优先于 ctx.skillIndex", () => {
    const out = buildSystemPrompt({
      ...base,
      skillIndex: "OLD-FROM-FIELD",
      segmentOverrides: { "skill-index": "NEW-FROM-OVERRIDE" },
    });
    expect(out).toContain("NEW-FROM-OVERRIDE");
    expect(out).not.toContain("OLD-FROM-FIELD");
  });

  it("override 为 null:该段被跳过", () => {
    const withSkill = buildSystemPrompt({ ...base, skillIndex: "SOME-SKILLS" });
    expect(withSkill).toContain("SOME-SKILLS");
    const cleared = buildSystemPrompt({
      ...base,
      skillIndex: "SOME-SKILLS",
      segmentOverrides: { "skill-index": null },
    });
    expect(cleared).not.toContain("SOME-SKILLS");
  });

  it("不传 / 空 segmentOverrides:输出 byte-equal 历史(无回归)", () => {
    const a = buildSystemPrompt(base);
    const b = buildSystemPrompt({ ...base, segmentOverrides: {} });
    expect(b).toBe(a);
  });

  it("可覆盖任意段(如 identity)、与默认渲染不同", () => {
    const def = buildSystemPrompt(base);
    const overridden = buildSystemPrompt({
      ...base,
      segmentOverrides: { identity: "## CUSTOM-IDENTITY" },
    });
    expect(overridden).toContain("## CUSTOM-IDENTITY");
    expect(overridden).not.toBe(def);
  });
});
