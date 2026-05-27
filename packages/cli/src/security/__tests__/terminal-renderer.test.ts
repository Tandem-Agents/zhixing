/**
 * TerminalConfirmationRenderer 单元测试
 *
 * 分三层：
 *
 * 1. **纯翻译层**（`buildSelectOptions` + `translate`）：不涉及 TTY，验证
 *    ConfirmationOption → SelectOption 的映射和 SelectResult → ConfirmationDecision
 *    的翻译正确。
 *
 * 2. **面板渲染**（`buildPanelBody`）：验证不同 DisplayBody.kind 产生合理的行。
 *
 * 3. **整合测试**（renderer + broker + PassThrough stdin/stdout）：真实走一遍
 *    attach → onRequest → SelectOperationRegion → broker.resolve 流程。
 */

import chalk from "chalk";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 强制启用 ANSI 染色——vitest non-TTY 下 chalk 默认 level=0，让 tone.error.bold
// 等染色断言生效（与 block-renderer.test.ts 一致策略）
chalk.level = 3;
import {
  ConfirmationBroker,
  type ConfirmationOption,
  type ConfirmationRequest,
  type SuggestedPattern,
} from "@zhixing/core";
import {
  TerminalConfirmationRenderer,
  buildInlinePanelBody,
  buildInlinePanelTitle,
  buildSelectOptions,
  translate,
} from "../terminal-renderer.js";
import type { ScreenController } from "../../screen/index.js";
import { _resetRawModeRefcountForTests } from "../../tui/index.js";

/**
 * Fake ScreenController —— integration 测试用。
 * SelectOperationRegion 实际仅调用 attachInput / detachInput / requestInputRepaint
 * 三个方法；其他方法 no-op 兜底满足接口。
 */
function makeFakeScreen(): ScreenController {
  return {
    attachInput: () => {},
    detachInput: () => {},
    setStatusBar: () => {},
    setStatusTail: () => {},
    withScrollWrite: () => {},
    writeScrollLine: () => {},
    requestInputRepaint: () => {},
    ensureScrollLeadingBlank: () => {},
    beginReplaceableSegment: () => ({
      replace: () => {},
      commit: () => {},
      close: () => {},
    }),
    suspend: () => {},
    resume: () => {},
    onSuspendChange: () => () => {},
    setFarewell: () => {},
    dispose: () => {},
  };
}

// ─── 测试辅助 ───

const PATTERN_NPM_INSTALL: SuggestedPattern = {
  pattern: { tool: "bash", argument: "npm install *" },
  label: "npm install *",
};

function makeRequest(
  opts: Partial<ConfirmationRequest> = {},
): ConfirmationRequest {
  const now = Date.now();
  return {
    id: "req-1",
    tool: "bash",
    toolInput: { command: "npm install express" },
    workingDirectory: "/tmp/ws",
    display: {
      title: "Bash 命令",
      body: {
        kind: "bash",
        command: "npm install express",
        commandPreview: "npm install express",
      },
      cwd: "/tmp/ws",
    },
    options: [
      { kind: "allow-once", label: "允许这一次" },
      { kind: "deny-with-reason", label: "拒绝", placeholder: "告诉知行哪里错了" },
    ],
    sessionType: "interactive",
    workspaceId: "ws-1",
    createdAt: now,
    expiresAt: now + 60_000,
    ...opts,
  };
}

function makeStreams() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  (stdin as unknown as { isTTY: boolean }).isTTY = false;
  (stdout as unknown as { isTTY: boolean }).isTTY = false;
  let captured = "";
  stdout.on("data", (d: Buffer | string) => {
    captured += d.toString("utf8");
  });
  return { stdin, stdout, getCaptured: () => captured };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function sendKeys(
  stdin: NodeJS.WritableStream,
  keys: readonly string[],
): Promise<void> {
  for (const k of keys) {
    stdin.write(k);
    await tick();
  }
}

const ENTER = "\r";
const DOWN = "\x1b[B";
const CTRL_C = "\x03";

beforeEach(() => {
  _resetRawModeRefcountForTests();
});

afterEach(() => {
  _resetRawModeRefcountForTests();
});

// ─── 层 1：纯翻译 ───

describe("buildSelectOptions", () => {
  it("ConfirmationOption 一对一映射到 SelectOption，并建立 optionById 反查表", () => {
    const req = makeRequest();
    const { selectOptions, optionById } = buildSelectOptions(req);

    expect(selectOptions).toHaveLength(2);
    expect(selectOptions[0]!.type).toBe("simple");
    expect(selectOptions[1]!.type).toBe("input");

    expect(optionById.size).toBe(2);
    expect(optionById.get("opt-0")?.kind).toBe("allow-once");
    expect(optionById.get("opt-1")?.kind).toBe("deny-with-reason");
  });

  it("input 类型选项透传 placeholder 并允许空提交", () => {
    const req = makeRequest({
      options: [
        {
          kind: "allow-with-note",
          label: "允许并补充",
          placeholder: "接下来做啥",
        },
      ],
    });
    const { selectOptions } = buildSelectOptions(req);
    const opt = selectOptions[0]!;
    expect(opt.type).toBe("input");
    if (opt.type === "input") {
      expect(opt.placeholder).toBe("接下来做啥");
      expect(opt.allowEmptySubmit).toBe(true);
    }
  });

  it("simple 选项透传 hotkey", () => {
    const req = makeRequest({
      options: [
        { kind: "allow-once", label: "允许", hotkey: "y" },
        { kind: "deny", label: "拒绝", hotkey: "n" },
      ],
    });
    const { selectOptions } = buildSelectOptions(req);
    expect(selectOptions[0]!.hotkey).toBe("y");
    expect(selectOptions[1]!.hotkey).toBe("n");
  });

  it("持久授权类（allow-session / workspace / global）label 加「⚠ 持久授权」后缀", () => {
    const req = makeRequest({
      options: [
        { kind: "allow-once", label: "允许一次" },
        { kind: "allow-session", label: "本会话允许", pattern: "git *" },
        {
          kind: "allow-workspace",
          label: "本工作区允许",
          pattern: "git *",
        },
        { kind: "allow-global", label: "全局允许", pattern: "git *" },
        { kind: "deny", label: "拒绝" },
      ],
    });
    const { selectOptions } = buildSelectOptions(req);
    // allow-once / deny 不加后缀
    expect(selectOptions[0]!.label).toBe("允许一次");
    expect(selectOptions[4]!.label).toBe("拒绝");
    // 持久授权三类加 ⚠ 持久授权 后缀
    expect(selectOptions[1]!.label).toContain("本会话允许");
    expect(selectOptions[1]!.label).toContain("⚠ 持久授权");
    expect(selectOptions[2]!.label).toContain("本工作区允许");
    expect(selectOptions[2]!.label).toContain("⚠ 持久授权");
    expect(selectOptions[3]!.label).toContain("全局允许");
    expect(selectOptions[3]!.label).toContain("⚠ 持久授权");
  });
});

describe("translate", () => {
  it("selected allow-once → { kind: 'allow-once' }", () => {
    const opt: ConfirmationOption = { kind: "allow-once", label: "x" };
    const map = new Map([["opt-0", opt]]);
    const result = translate({ kind: "selected", value: "opt-0" }, map);
    expect(result).toEqual({ kind: "allow-once" });
  });

  it("selected allow-with-note 带 note → { kind: 'allow-once', note }", () => {
    const opt: ConfirmationOption = {
      kind: "allow-with-note",
      label: "x",
      placeholder: "y",
    };
    const map = new Map([["opt-0", opt]]);
    const result = translate(
      { kind: "selected", value: "opt-0", note: "先检查依赖" },
      map,
    );
    expect(result).toEqual({ kind: "allow-once", note: "先检查依赖" });
  });

  it("selected deny-with-reason 带 note → { kind: 'deny', reason }", () => {
    const opt: ConfirmationOption = {
      kind: "deny-with-reason",
      label: "x",
      placeholder: "y",
    };
    const map = new Map([["opt-0", opt]]);
    const result = translate(
      { kind: "selected", value: "opt-0", note: "别用 rm -rf" },
      map,
    );
    expect(result).toEqual({ kind: "deny", reason: "别用 rm -rf" });
  });

  it("selected allow-workspace 携带 pattern", () => {
    const opt: ConfirmationOption = {
      kind: "allow-workspace",
      label: "x",
      pattern: PATTERN_NPM_INSTALL,
    };
    const map = new Map([["opt-0", opt]]);
    const result = translate({ kind: "selected", value: "opt-0" }, map);
    expect(result).toEqual({
      kind: "allow-workspace",
      pattern: PATTERN_NPM_INSTALL,
      note: undefined,
    });
  });

  it("selected allow-session / allow-global 携带 pattern", () => {
    const sessionOpt: ConfirmationOption = {
      kind: "allow-session",
      label: "x",
      pattern: PATTERN_NPM_INSTALL,
    };
    const globalOpt: ConfirmationOption = {
      kind: "allow-global",
      label: "x",
      pattern: PATTERN_NPM_INSTALL,
    };
    const map = new Map<string, ConfirmationOption>([
      ["opt-0", sessionOpt],
      ["opt-1", globalOpt],
    ]);
    expect(
      translate({ kind: "selected", value: "opt-0" }, map).kind,
    ).toBe("allow-session");
    expect(
      translate({ kind: "selected", value: "opt-1" }, map).kind,
    ).toBe("allow-global");
  });

  it("cancelled ctrl-c → { kind: 'cancelled', cause: 'user-ctrl-c' }", () => {
    const result = translate(
      { kind: "cancelled", cause: "ctrl-c" },
      new Map(),
    );
    expect(result).toEqual({ kind: "cancelled", cause: "user-ctrl-c" });
  });

  it("cancelled ctrl-d → { kind: 'cancelled', cause: 'user-ctrl-d' }", () => {
    const result = translate(
      { kind: "cancelled", cause: "ctrl-d" },
      new Map(),
    );
    expect(result).toEqual({ kind: "cancelled", cause: "user-ctrl-d" });
  });

  it("cancelled aborted → { kind: 'cancelled', cause: 'aborted' }", () => {
    const result = translate(
      { kind: "cancelled", cause: "aborted" },
      new Map(),
    );
    expect(result).toEqual({ kind: "cancelled", cause: "aborted" });
  });

  it("cancelled escape → { kind: 'deny' } (Esc 等价于拒绝)", () => {
    const result = translate(
      { kind: "cancelled", cause: "escape" },
      new Map(),
    );
    expect(result).toEqual({ kind: "deny" });
  });

  it("未知 value → deny with reason (防御性)", () => {
    const result = translate(
      { kind: "selected", value: "nonexistent" },
      new Map(),
    );
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason).toContain("未知选项");
    }
  });
});

// ─── 层 2：面板渲染 ───

describe("buildInlinePanelBody", () => {
  it("bash body 首行包含 '$' + 命令", () => {
    const req = makeRequest();
    const lines = buildInlinePanelBody(req);
    expect(lines[0]).toContain("$");
    expect(lines[0]).toContain("npm install express");
  });

  it("file-write body 显示 '写入' + 路径", () => {
    const req = makeRequest({
      display: {
        title: "写入文件",
        body: { kind: "file-write", path: "/tmp/x.ts" },
        cwd: "/tmp",
      },
    });
    const lines = buildInlinePanelBody(req);
    expect(lines.some((l) => l.includes("写入") && l.includes("/tmp/x.ts"))).toBe(
      true,
    );
  });

  it("messaging body 显示收件人 + 内容", () => {
    const req = makeRequest({
      display: {
        title: "发送消息",
        body: { kind: "messaging", recipient: "张三", content: "明天开会" },
        cwd: "/tmp",
      },
    });
    const lines = buildInlinePanelBody(req);
    expect(lines.some((l) => l.includes("张三"))).toBe(true);
    expect(lines.some((l) => l.includes("明天开会"))).toBe(true);
  });

  it("generic body 显示 summary", () => {
    const req = makeRequest({
      display: {
        title: "unknown",
        body: { kind: "generic", summary: "wechat_send {...}" },
        cwd: "/tmp",
      },
    });
    const lines = buildInlinePanelBody(req);
    expect(lines.some((l) => l.includes("wechat_send"))).toBe(true);
  });

  it("body 仅含主体——元信息/cwd/env/路径 全部不显示（用户决策真正依据是命令本身）", () => {
    const req = makeRequest({
      operationClass: "external",
      decision: {
        action: "confirm",
        matchedRules: [],
        reason: "需要网络",
        riskLevel: "medium",
      },
    });
    const lines = buildInlinePanelBody(req);
    const full = lines.join("\n");
    // 主体（命令）存在
    expect(full).toContain("npm install express");
    // 元信息全删——对用户决策无增值
    expect(full).not.toContain("/tmp/ws"); // cwd 删
    expect(full).not.toContain("外部"); // operationClass 删
    expect(full).not.toContain("中风险"); // riskLevel 删
    expect(full).not.toContain("需要网络"); // decision.reason 删
  });
});

describe("buildInlinePanelTitle", () => {
  it("按 DisplayBody.kind 派生场景化中文意图短语", () => {
    expect(
      buildInlinePanelTitle(
        makeRequest({
          display: {
            title: "x",
            body: {
              kind: "bash",
              command: "ls",
              commandPreview: "ls",
            },
            cwd: "/",
          },
        }),
      ),
    ).toContain("AI 想执行命令");

    expect(
      buildInlinePanelTitle(
        makeRequest({
          display: {
            title: "x",
            body: { kind: "file-write", path: "/a.ts" },
            cwd: "/",
          },
        }),
      ),
    ).toContain("AI 想写入文件");

    expect(
      buildInlinePanelTitle(
        makeRequest({
          display: {
            title: "x",
            body: { kind: "network", host: "example.com", direction: "outbound" },
            cwd: "/",
          },
        }),
      ),
    ).toContain("AI 想访问网络");
  });

  it("low / medium 风险——title 仅 intent 不染色不加 ⚠", () => {
    const req = makeRequest({
      decision: {
        action: "confirm",
        matchedRules: [],
        reason: "x",
        riskLevel: "medium",
      },
    });
    const title = buildInlinePanelTitle(req);
    expect(title).toBe("AI 想执行命令"); // 完全纯文本，无 ANSI
    expect(title).not.toContain("⚠");
    expect(title).not.toContain("\x1b"); // 无 ANSI 染色
  });

  it("high 风险——title 加 ⚠ + (高风险) 尾缀 + red bold 染色", () => {
    const req = makeRequest({
      decision: {
        action: "confirm",
        matchedRules: [],
        reason: "x",
        riskLevel: "high",
      },
    });
    const title = buildInlinePanelTitle(req);
    expect(title).toContain("⚠");
    expect(title).toContain("AI 想执行命令");
    expect(title).toContain("(高风险)");
    expect(title).toContain("\x1b["); // red bold ANSI
  });

  it("critical 风险——title 加 ⚠ + (关键操作) 尾缀 + red bold 染色", () => {
    const req = makeRequest({
      decision: {
        action: "confirm",
        matchedRules: [],
        reason: "x",
        riskLevel: "critical",
      },
    });
    const title = buildInlinePanelTitle(req);
    expect(title).toContain("⚠");
    expect(title).toContain("(关键操作)");
    expect(title).toContain("\x1b[");
  });
});

// ─── 层 3：整合测试 ───

describe("TerminalConfirmationRenderer integration", () => {
  it("attach 后 broker 有请求 → SelectOperationRegion 显示 → 用户选第一项 → broker.resolve", async () => {
    const { stdin, stdout } = makeStreams();
    const broker = new ConfirmationBroker();

    const renderer = new TerminalConfirmationRenderer({ screen: makeFakeScreen(), stdin });
    const detach = renderer.attach(broker);

    const req = makeRequest({
      options: [
        { kind: "allow-once", label: "允许一次" },
        { kind: "deny", label: "拒绝" },
      ],
    });
    const promise = broker.requestConfirmation(req);

    // 让 renderer 处理 onRequest 事件并展示面板
    await tick();

    // 用户按 Enter 选中默认（第一项）
    await sendKeys(stdin, [ENTER]);

    const decision = await promise;
    expect(decision).toEqual({ kind: "allow-once" });

    detach();
  });

  it("用户按 down+enter 选中第二项（deny）", async () => {
    const { stdin, stdout } = makeStreams();
    const broker = new ConfirmationBroker();
    const renderer = new TerminalConfirmationRenderer({ screen: makeFakeScreen(), stdin });
    const detach = renderer.attach(broker);

    const req = makeRequest({
      options: [
        { kind: "allow-once", label: "允许一次" },
        { kind: "deny", label: "拒绝" },
      ],
    });
    const promise = broker.requestConfirmation(req);
    await tick();
    await sendKeys(stdin, [DOWN, ENTER]);

    const decision = await promise;
    expect(decision).toEqual({ kind: "deny" });

    detach();
  });

  it("用户按 Ctrl+C → broker 得到 cancelled/user-ctrl-c", async () => {
    const { stdin, stdout } = makeStreams();
    const broker = new ConfirmationBroker();
    const renderer = new TerminalConfirmationRenderer({ screen: makeFakeScreen(), stdin });
    const detach = renderer.attach(broker);

    const promise = broker.requestConfirmation(makeRequest());
    await tick();
    await sendKeys(stdin, [CTRL_C]);

    const decision = await promise;
    expect(decision).toEqual({ kind: "cancelled", cause: "user-ctrl-c" });

    detach();
  });

  it("beforeShow / afterShow hooks 在面板前后被调用", async () => {
    const { stdin, stdout } = makeStreams();
    const broker = new ConfirmationBroker();
    const beforeShow = vi.fn();
    const afterShow = vi.fn();

    const renderer = new TerminalConfirmationRenderer({
      screen: makeFakeScreen(),
      stdin,
      beforeShow,
      afterShow,
    });
    const detach = renderer.attach(broker);

    const promise = broker.requestConfirmation(makeRequest());
    await tick();
    await sendKeys(stdin, [ENTER]);
    await promise;

    expect(beforeShow).toHaveBeenCalledTimes(1);
    expect(afterShow).toHaveBeenCalledTimes(1);
    // afterShow 在 beforeShow 之后
    const beforeOrder = beforeShow.mock.invocationCallOrder[0]!;
    const afterOrder = afterShow.mock.invocationCallOrder[0]!;
    expect(beforeOrder).toBeLessThan(afterOrder);

    detach();
  });

  it("detach 后新请求不再进入渲染器，走非交互兜底", async () => {
    const { stdin, stdout } = makeStreams();
    const broker = new ConfirmationBroker();
    const renderer = new TerminalConfirmationRenderer({ screen: makeFakeScreen(), stdin });
    const detach = renderer.attach(broker);

    detach();

    const decision = await broker.requestConfirmation(makeRequest());
    expect(decision.kind).toBe("deny"); // fail-to-deny 默认兜底
  });

  it("attach 到第二个 broker 前必须先 detach，否则抛错", () => {
    const renderer = new TerminalConfirmationRenderer();
    const b1 = new ConfirmationBroker();
    const b2 = new ConfirmationBroker();
    renderer.attach(b1);
    expect(() => renderer.attach(b2)).toThrow(/already attached/);
    renderer.detach();
    expect(() => renderer.attach(b2)).not.toThrow();
    renderer.detach();
  });

  it("FIFO：两个请求依次被展示，第一个 resolve 后第二个自动展示", async () => {
    const { stdin, stdout } = makeStreams();
    const broker = new ConfirmationBroker();
    const renderer = new TerminalConfirmationRenderer({ screen: makeFakeScreen(), stdin });
    const detach = renderer.attach(broker);

    const p1 = broker.requestConfirmation(
      makeRequest({ id: "r1", toolInput: { command: "ls" } }),
    );
    const p2 = broker.requestConfirmation(
      makeRequest({ id: "r2", toolInput: { command: "pwd" } }),
    );

    // r1 先展示
    await tick();
    await sendKeys(stdin, [ENTER]);
    expect((await p1).kind).toBe("allow-once");

    // r2 应该在 r1 resolve 后自动被 render
    await tick();
    await sendKeys(stdin, [ENTER]);
    expect((await p2).kind).toBe("allow-once");

    detach();
  });
});
