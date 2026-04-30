/**
 * 验证 8 个 builtin 工具(及 schedule 扩展工具)对 subAgentSafe capability tag 的声明,
 * 以及子 agent 装配过滤公式 `tools.filter(t => t.subAgentSafe === true)` 的输出。
 */

import { describe, expect, it } from "vitest";
import {
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createMemoryTool,
  createReadTool,
  createScheduleTool,
  createWebFetchTool,
  createWriteTool,
} from "../index.js";
import type { ToolDefinition } from "@zhixing/core";

function pluck(tool: ToolDefinition): { name: string; subAgentSafe: boolean | undefined } {
  return { name: tool.name, subAgentSafe: tool.subAgentSafe };
}

describe("subAgentSafe capability tag · builtin 工具声明", () => {
  it("8 个 builtin 工具按角色分类:read/glob/grep/edit/write/bash/web_fetch=true,memory=false", () => {
    const declarations = [
      createReadTool(),
      createGlobTool(),
      createGrepTool(),
      createEditTool(),
      createWriteTool(),
      createBashTool(),
      createWebFetchTool(),
      createMemoryTool(),
    ].map(pluck);

    expect(declarations).toEqual([
      { name: "read", subAgentSafe: true },
      { name: "glob", subAgentSafe: true },
      { name: "grep", subAgentSafe: true },
      { name: "edit", subAgentSafe: true },
      { name: "write", subAgentSafe: true },
      { name: "bash", subAgentSafe: true },
      { name: "web_fetch", subAgentSafe: true },
      { name: "memory", subAgentSafe: false },
    ]);
  });

  it("schedule 工具:子 agent 不持有定时任务管理能力", () => {
    const tool = createScheduleTool(() => ({ getStatusSummary: () => ({}) } as never));
    expect(tool.subAgentSafe).toBe(false);
  });
});

describe("子 agent 装配公式 · tools.filter(t => t.subAgentSafe === true)", () => {
  it("仅暴露显式声明 true 的工具,memory 与 schedule 被过滤掉", () => {
    const allTools: ToolDefinition[] = [
      createReadTool(),
      createGlobTool(),
      createGrepTool(),
      createEditTool(),
      createWriteTool(),
      createBashTool(),
      createWebFetchTool(),
      createMemoryTool(),
      createScheduleTool(() => ({ getStatusSummary: () => ({}) } as never)),
    ];

    const subAgentTools = allTools.filter((t) => t.subAgentSafe === true);
    const names = subAgentTools.map((t) => t.name);

    expect(names).toEqual(["read", "glob", "grep", "edit", "write", "bash", "web_fetch"]);
    expect(names).not.toContain("memory");
    expect(names).not.toContain("schedule");
  });

  it("严格 === true:undefined / false 都被排除(fail-closed)", () => {
    const undeclared: ToolDefinition = {
      name: "future_tool",
      description: "未声明 subAgentSafe 的工具",
      inputSchema: { type: "object", properties: {} },
      async call() {
        return { content: "" };
      },
    };
    expect(undeclared.subAgentSafe).toBeUndefined();
    expect([undeclared].filter((t) => t.subAgentSafe === true)).toHaveLength(0);
  });
});
