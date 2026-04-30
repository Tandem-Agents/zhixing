import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEventMap } from "@zhixing/core";
import { createEventBus } from "@zhixing/core";
import { setupSubAgentStatus } from "../sub-agent-status.js";

// 去 ANSI 颜色 / chalk 控制码的简易实现:让断言聚焦语义文本不依赖颜色实现
const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\x1b\[[0-9;]*m/g, "");

// 收集 stdout 全部写入并去 ANSI 后拼接,便于子串断言
const allStdoutText = (
  spy: ReturnType<typeof vi.spyOn>,
): string => spy.mock.calls.map((c) => stripAnsi(String(c[0] ?? ""))).join("");

// TokenUsage 零值 helper:仅 inputTokens / outputTokens 必填,cacheReadTokens /
// cacheWriteTokens 是 optional 维度,本套测试不验缓存语义,故省略保持最小契约
const usageZero = { inputTokens: 0, outputTokens: 0 };

// agent:run_end 事件的零值 payload(契约 reason / duration / usage 三字段必填,
// error / abortReason 等可选项视场景再加)
const runEndCompleted = {
  reason: "completed" as const,
  duration: 0,
  usage: usageZero,
};

// 创建主 bus(主路径装配 lineage="main"),与生产路径一致
const newMainBus = () => createEventBus<AgentEventMap>({ lineage: "main" });

// 创建子 bus(继承主 bus,lineage 必须以 "main/" 开头)
const newSubBus = (parent: ReturnType<typeof newMainBus>, subId: string) =>
  createEventBus<AgentEventMap>({ parent, lineage: `main/sub-${subId}` });

describe("setupSubAgentStatus · TTY 模式", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let pauseUI: ReturnType<typeof vi.fn>;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    // 锚定 TTY 让测试覆盖 \r 单行刷新路径(vitest 默认非 TTY 走整行换行)
    originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    pauseUI = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalIsTTY === undefined) {
      delete (process.stdout as unknown as { isTTY?: boolean }).isTTY;
    } else {
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: originalIsTTY,
      });
    }
  });

  it("主 Task tool:call_start → 输出 [Task#1: desc] 启动子 agent + pauseUI 被调", async () => {
    const bus = newMainBus();
    const handle = setupSubAgentStatus(bus, pauseUI);

    await bus.emit("tool:call_start", {
      id: "tc1",
      name: "Task",
      input: { description: "解析模块", prompt: "..." },
    });

    const out = allStdoutText(stdoutSpy);
    expect(out).toContain("[Task#1: 解析模块]");
    expect(out).toContain("启动子 agent");
    expect(pauseUI).toHaveBeenCalled();

    handle.dispose();
  });

  it("子 tool:call_start (lineage main/sub-X) → \\r 刷新行带最近工具", async () => {
    const bus = newMainBus();
    const subBus = newSubBus(bus, "aaaaaaaa");
    const handle = setupSubAgentStatus(bus, pauseUI);

    await bus.emit("tool:call_start", {
      id: "tc1",
      name: "Task",
      input: { description: "解析", prompt: "..." },
    });
    stdoutSpy.mockClear();

    await subBus.emit("tool:call_start", {
      id: "ct1",
      name: "read",
      input: { path: "packages/cli/src/render.ts" },
    });

    const writes = stdoutSpy.mock.calls.map((c) => String(c[0]));
    // TTY: 写入应包含 \r(清行或新行起头)
    expect(writes.some((w) => w.startsWith("\r"))).toBe(true);

    const out = allStdoutText(stdoutSpy);
    expect(out).toContain("[Task#1: 解析]");
    expect(out).toContain("read packages/cli/src/render.ts");

    handle.dispose();
  });

  it("子 tool:call_end → 行尾追加 ✓ + 耗时(success)", async () => {
    const bus = newMainBus();
    const subBus = newSubBus(bus, "aaaaaaaa");
    const handle = setupSubAgentStatus(bus, pauseUI);

    await bus.emit("tool:call_start", {
      id: "tc1",
      name: "Task",
      input: { description: "x", prompt: "..." },
    });
    await subBus.emit("tool:call_start", {
      id: "ct1",
      name: "read",
      input: { path: "a.ts" },
    });
    stdoutSpy.mockClear();

    await subBus.emit("tool:call_end", {
      id: "ct1",
      name: "read",
      duration: 123,
      success: true,
      resultSize: 0,
    });

    const out = allStdoutText(stdoutSpy);
    expect(out).toContain("✓");
    expect(out).toContain("123ms");

    handle.dispose();
  });

  it("子 tool:call_end success=false → 行尾追加 ✗(失败标记)", async () => {
    const bus = newMainBus();
    const subBus = newSubBus(bus, "aaaaaaaa");
    const handle = setupSubAgentStatus(bus, pauseUI);

    await bus.emit("tool:call_start", {
      id: "tc1",
      name: "Task",
      input: { description: "x", prompt: "..." },
    });
    await subBus.emit("tool:call_start", {
      id: "ct1",
      name: "bash",
      input: { command: "exit 1" },
    });
    stdoutSpy.mockClear();

    await subBus.emit("tool:call_end", {
      id: "ct1",
      name: "bash",
      duration: 50,
      success: false,
      resultSize: 0,
    });

    const out = allStdoutText(stdoutSpy);
    expect(out).toContain("✗");
    expect(out).toContain("50ms");

    handle.dispose();
  });

  it("主 Task tool:call_end → 换行收尾 + 总耗时(s 单位)", async () => {
    const bus = newMainBus();
    const handle = setupSubAgentStatus(bus, pauseUI);

    await bus.emit("tool:call_start", {
      id: "tc1",
      name: "Task",
      input: { description: "x", prompt: "..." },
    });
    stdoutSpy.mockClear();

    await bus.emit("tool:call_end", {
      id: "tc1",
      name: "Task",
      duration: 1234,
      success: true,
      resultSize: 0,
    });

    const writes = stdoutSpy.mock.calls.map((c) => String(c[0]));
    // 末尾收尾行以 \n 结束(回到正常输出流)
    expect(writes.some((w) => w.endsWith("\n"))).toBe(true);

    const out = allStdoutText(stdoutSpy);
    expect(out).toContain("[Task#1: x]");
    expect(out).toContain("✓");
    expect(out).toMatch(/\d+\.\ds/); // "0.0s" / "1.2s" 等

    handle.dispose();
  });

  it("跨 Task 计数 N 累积:Task#1 收尾 → Task#2 显示 N=2", async () => {
    const bus = newMainBus();
    const handle = setupSubAgentStatus(bus, pauseUI);

    // Task#1 完整生命周期
    await bus.emit("tool:call_start", {
      id: "t1",
      name: "Task",
      input: { description: "first", prompt: "..." },
    });
    await bus.emit("tool:call_end", {
      id: "t1",
      name: "Task",
      duration: 100,
      success: true,
      resultSize: 0,
    });
    stdoutSpy.mockClear();

    // Task#2 起始
    await bus.emit("tool:call_start", {
      id: "t2",
      name: "Task",
      input: { description: "second", prompt: "..." },
    });

    const out = allStdoutText(stdoutSpy);
    expect(out).toContain("[Task#2: second]");
    expect(out).not.toContain("[Task#1");

    handle.dispose();
  });

  it("Task#1 收尾后,sub-X 子事件不再被关联(防 TaskN+1 串扰)", async () => {
    const bus = newMainBus();
    const subA = newSubBus(bus, "aaaaaaaa");
    const handle = setupSubAgentStatus(bus, pauseUI);

    await bus.emit("tool:call_start", {
      id: "t1",
      name: "Task",
      input: { description: "first", prompt: "..." },
    });
    await bus.emit("tool:call_end", {
      id: "t1",
      name: "Task",
      duration: 100,
      success: true,
      resultSize: 0,
    });
    stdoutSpy.mockClear();

    // Task#1 已收尾,残留的 sub-A 事件不应再驱动状态条
    await subA.emit("tool:call_start", {
      id: "ct1",
      name: "read",
      input: { path: "x.ts" },
    });

    const out = allStdoutText(stdoutSpy);
    expect(out).toBe(""); // 完全静默
    handle.dispose();
  });

  it("多 sub bus 串行匹配:Task#2 关联首个 sub-bbb 而非 sub-aaa(顺序匹配)", async () => {
    const bus = newMainBus();
    const subA = newSubBus(bus, "aaaaaaaa");
    const subB = newSubBus(bus, "bbbbbbbb");
    const handle = setupSubAgentStatus(bus, pauseUI);

    // Task#1 + sub-A
    await bus.emit("tool:call_start", {
      id: "t1",
      name: "Task",
      input: { description: "1st", prompt: "..." },
    });
    await subA.emit("tool:call_start", {
      id: "ca",
      name: "read",
      input: { path: "a.ts" },
    });
    await bus.emit("tool:call_end", {
      id: "t1",
      name: "Task",
      duration: 100,
      success: true,
      resultSize: 0,
    });

    // Task#2 + sub-B
    await bus.emit("tool:call_start", {
      id: "t2",
      name: "Task",
      input: { description: "2nd", prompt: "..." },
    });
    stdoutSpy.mockClear();
    await subB.emit("tool:call_start", {
      id: "cb",
      name: "grep",
      input: { pattern: "foo" },
    });

    const out = allStdoutText(stdoutSpy);
    expect(out).toContain("[Task#2: 2nd]");
    expect(out).toContain('grep "foo"');

    handle.dispose();
  });

  it("agent:run_end 兜底:Task 未收尾即 run_end → 内部状态重置,后续 sub 事件不再驱动", async () => {
    const bus = newMainBus();
    const subA = newSubBus(bus, "aaaaaaaa");
    const handle = setupSubAgentStatus(bus, pauseUI);

    await bus.emit("tool:call_start", {
      id: "t1",
      name: "Task",
      input: { description: "x", prompt: "..." },
    });
    // run_end 直接打断(模拟 esc / 异常退出),Task 未自然收尾
    await bus.emit("agent:run_end", runEndCompleted);
    stdoutSpy.mockClear();

    await subA.emit("tool:call_start", {
      id: "c1",
      name: "read",
      input: { path: "a.ts" },
    });

    const out = allStdoutText(stdoutSpy);
    expect(out).toBe(""); // 内部 currentTask 已重置,sub 事件不响应
    handle.dispose();
  });

  it("dispose 解绑 listener:释放后任何事件不再触发 stdout", async () => {
    const bus = newMainBus();
    const subA = newSubBus(bus, "aaaaaaaa");
    const handle = setupSubAgentStatus(bus, pauseUI);
    handle.dispose();

    stdoutSpy.mockClear();
    pauseUI.mockClear();

    await bus.emit("tool:call_start", {
      id: "t1",
      name: "Task",
      input: { description: "x", prompt: "..." },
    });
    await subA.emit("tool:call_start", {
      id: "c1",
      name: "read",
      input: { path: "a.ts" },
    });
    await bus.emit("tool:call_end", {
      id: "t1",
      name: "Task",
      duration: 1,
      success: true,
      resultSize: 0,
    });

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(pauseUI).not.toHaveBeenCalled();
  });

  it("description 缺失/空串 → '(unnamed task)' 兜底(防御性,非 Task 工具误传安全)", async () => {
    const bus = newMainBus();
    const handle = setupSubAgentStatus(bus, pauseUI);

    await bus.emit("tool:call_start", {
      id: "t1",
      name: "Task",
      input: { prompt: "..." }, // 无 description
    });

    const out = allStdoutText(stdoutSpy);
    expect(out).toContain("(unnamed task)");
    handle.dispose();
  });

  it("超长 description 截断到 30 字符 + … (防 LLM 输出超长撑爆终端列宽)", async () => {
    const bus = newMainBus();
    const handle = setupSubAgentStatus(bus, pauseUI);

    const longDesc = "A".repeat(100);
    await bus.emit("tool:call_start", {
      id: "t1",
      name: "Task",
      input: { description: longDesc, prompt: "..." },
    });

    const out = allStdoutText(stdoutSpy);
    // 截断后形如 "AAA...AAA…",含 … 截断符 + 不超过 31 字符(30 + …)
    expect(out).toContain("…");
    expect(out).not.toContain(longDesc); // 完整长串不应出现
    handle.dispose();
  });

  it("非 Task 工具的主 bus tool:call_start 不开 Task(只 Task 名才触发)", async () => {
    const bus = newMainBus();
    const handle = setupSubAgentStatus(bus, pauseUI);

    await bus.emit("tool:call_start", {
      id: "tc1",
      name: "read",
      input: { path: "a.ts" },
    });

    const out = allStdoutText(stdoutSpy);
    expect(out).toBe(""); // 主 bus read 不是 Task,状态条不响应
    handle.dispose();
  });
});

describe("setupSubAgentStatus · 非 TTY 模式(CI / pipe / 重定向)", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let pauseUI: ReturnType<typeof vi.fn>;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    pauseUI = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalIsTTY === undefined) {
      delete (process.stdout as unknown as { isTTY?: boolean }).isTTY;
    } else {
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: originalIsTTY,
      });
    }
  });

  it("非 TTY:Task 起止仍各打整行(\\n 结尾,无 \\r 控制符)", async () => {
    const bus = newMainBus();
    const handle = setupSubAgentStatus(bus, pauseUI);

    await bus.emit("tool:call_start", {
      id: "t1",
      name: "Task",
      input: { description: "x", prompt: "..." },
    });
    await bus.emit("tool:call_end", {
      id: "t1",
      name: "Task",
      duration: 100,
      success: true,
      resultSize: 0,
    });

    const writes = stdoutSpy.mock.calls.map((c) => String(c[0]));
    // 非 TTY 不应有 \r 控制符
    expect(writes.every((w) => !w.includes("\r"))).toBe(true);
    // 全部以 \n 结尾(整行打,不单行刷新)
    expect(writes.every((w) => w.endsWith("\n"))).toBe(true);
    handle.dispose();
  });

  it("非 TTY:子工具中间帧静默(stdout 零输出),避免 CI / pipe 日志爆炸", async () => {
    const bus = newMainBus();
    const subA = newSubBus(bus, "aaaaaaaa");
    const handle = setupSubAgentStatus(bus, pauseUI);

    await bus.emit("tool:call_start", {
      id: "t1",
      name: "Task",
      input: { description: "x", prompt: "..." },
    });
    stdoutSpy.mockClear();

    // 子工具中间帧(start + end)非 TTY 应静默,只 Task 起止帧写整行
    await subA.emit("tool:call_start", {
      id: "c1",
      name: "read",
      input: { path: "a.ts" },
    });
    await subA.emit("tool:call_end", {
      id: "c1",
      name: "read",
      duration: 50,
      success: true,
      resultSize: 0,
    });

    expect(stdoutSpy).not.toHaveBeenCalled();
    handle.dispose();
  });

  it("非 TTY:Task 收尾仍正常(中间帧静默不影响关闭路径)", async () => {
    const bus = newMainBus();
    const subA = newSubBus(bus, "aaaaaaaa");
    const handle = setupSubAgentStatus(bus, pauseUI);

    await bus.emit("tool:call_start", {
      id: "t1",
      name: "Task",
      input: { description: "x", prompt: "..." },
    });
    await subA.emit("tool:call_start", {
      id: "c1",
      name: "read",
      input: { path: "a.ts" },
    });
    stdoutSpy.mockClear();

    await bus.emit("tool:call_end", {
      id: "t1",
      name: "Task",
      duration: 1000,
      success: true,
      resultSize: 0,
    });

    const out = allStdoutText(stdoutSpy);
    expect(out).toContain("[Task#1: x]");
    expect(out).toContain("✓");
    handle.dispose();
  });
});
