import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadProjectContext, injectContext, type ProjectContext } from "../project-context.js";
import type { Message } from "@zhixing/core";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ─── 辅助 ───

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function toolResultMsg(): Message {
  return {
    role: "user",
    content: [{ type: "tool_result", toolUseId: "t1", content: "ok" }],
  };
}

// ─── injectContext 测试 ───

describe("injectContext", () => {
  const ctx: ProjectContext = {
    instructions: "Always respond in English",
    date: "2025-06-15",
  };

  const ctxNoInstructions: ProjectContext = {
    instructions: null,
    date: "2025-06-15",
  };

  it("将 <context> 注入首条 user message 前", () => {
    const messages: Message[] = [userMsg("你好")];
    const result = injectContext(messages, ctx);

    expect(result).toHaveLength(1);
    const text = (result[0]!.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("<context>");
    expect(text).toContain("</context>");
    expect(text).toContain("Always respond in English");
    expect(text).toContain("2025-06-15");
    expect(text).toContain("你好");
  });

  it("不修改原始消息数组", () => {
    const messages: Message[] = [userMsg("原始")];
    const original = JSON.parse(JSON.stringify(messages));
    injectContext(messages, ctx);

    expect(messages).toEqual(original);
  });

  it("已有 <context> 标签时不重复注入", () => {
    const messages: Message[] = [userMsg("<context>existing</context>\n\n你好")];
    const result = injectContext(messages, ctx);

    const text = (result[0]!.content[0] as { type: "text"; text: string }).text;
    const matches = text.match(/<context>/g);
    expect(matches).toHaveLength(1);
  });

  it("多条消息时只注入首条 user", () => {
    const messages: Message[] = [
      userMsg("第一条"),
      { role: "assistant", content: [{ type: "text", text: "回复" }] },
      userMsg("第二条"),
    ];
    const result = injectContext(messages, ctx);

    const firstText = (result[0]!.content[0] as { type: "text"; text: string }).text;
    const thirdText = (result[2]!.content[0] as { type: "text"; text: string }).text;

    expect(firstText).toContain("<context>");
    expect(thirdText).not.toContain("<context>");
    expect(thirdText).toBe("第二条");
  });

  it("无 user 消息时返回原数组", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    const result = injectContext(messages, ctx);
    expect(result).toEqual(messages);
  });

  it("无 instructions 时仍注入日期", () => {
    const messages: Message[] = [userMsg("测试")];
    const result = injectContext(messages, ctxNoInstructions);

    const text = (result[0]!.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("<context>");
    expect(text).toContain("2025-06-15");
    expect(text).not.toContain("ZHIXING.md");
  });

  it("首条 user 是 tool_result 时在前面插入 text block", () => {
    const messages: Message[] = [toolResultMsg()];
    const result = injectContext(messages, ctx);

    expect(result[0]!.content).toHaveLength(2);
    expect(result[0]!.content[0]!.type).toBe("text");
    expect(result[0]!.content[1]!.type).toBe("tool_result");
  });
});

// ─── loadProjectContext 测试 ───

describe("loadProjectContext", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zhixing-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("无 ZHIXING.md 时 instructions 为 null", async () => {
    const ctx = await loadProjectContext(tmpDir);
    expect(ctx.instructions).toBeNull();
    expect(ctx.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("加载项目根目录的 ZHIXING.md", async () => {
    await fs.writeFile(path.join(tmpDir, "ZHIXING.md"), "项目指令", "utf-8");

    const ctx = await loadProjectContext(tmpDir);
    expect(ctx.instructions).toBe("项目指令");
  });

  it("加载 .zhixing/ZHIXING.md", async () => {
    await fs.mkdir(path.join(tmpDir, ".zhixing"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".zhixing", "ZHIXING.md"), "隐藏指令", "utf-8");

    const ctx = await loadProjectContext(tmpDir);
    expect(ctx.instructions).toBe("隐藏指令");
  });

  it("根目录 ZHIXING.md 优先于 .zhixing/ZHIXING.md", async () => {
    await fs.writeFile(path.join(tmpDir, "ZHIXING.md"), "根目录优先", "utf-8");
    await fs.mkdir(path.join(tmpDir, ".zhixing"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".zhixing", "ZHIXING.md"), "次选", "utf-8");

    const ctx = await loadProjectContext(tmpDir);
    expect(ctx.instructions).toBe("根目录优先");
  });

  it("空文件视为无内容", async () => {
    await fs.writeFile(path.join(tmpDir, "ZHIXING.md"), "   \n  ", "utf-8");

    const ctx = await loadProjectContext(tmpDir);
    expect(ctx.instructions).toBeNull();
  });

  it("date 是当天日期", async () => {
    const ctx = await loadProjectContext(tmpDir);
    const today = new Date().toISOString().slice(0, 10);
    expect(ctx.date).toBe(today);
  });
});
