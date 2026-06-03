/**
 * chromeOnlyVisibility 环境过滤契约 —— 验证"无 chrome 终端下 alt-screen 命令
 * 不进 registry.list(ctx)"(/help 与补全据此剔除它们),以及"findByName 不被
 * visibility 挡"(硬打名字仍可召唤的 escape hatch)。
 *
 * 这是 legacy 非 TTY 管道观测不到的行为(stdout 异步缓冲在快速退出时丢失),故用
 * 真实 DefaultCommandRegistry 在单测里锁定契约。
 */

import { describe, it, expect } from "vitest";
import {
  DefaultCommandRegistry,
  type CommandDef,
  type RuntimeContext,
} from "@zhixing/core";
import {
  FEATURE_CHROME,
  chromeOnlyVisibility,
  requireChrome,
} from "../command-visibility.js";
import { stripAnsi } from "../../tui/index.js";
import type { CliWriter, ScreenController } from "../../screen/index.js";

function runtime(chrome: boolean): RuntimeContext {
  return {
    sessionBusy: false,
    workspaceId: null,
    cwd: ".",
    target: "cli",
    features: { [FEATURE_CHROME]: chrome },
    now: 0,
  };
}

const plainCmd: CommandDef = {
  id: "status:repl",
  name: "status",
  description: "显示会话状态",
  category: "info",
  execution: "local",
};

const chromeCmd: CommandDef = {
  id: "config:repl",
  name: "config",
  description: "修改基础配置",
  category: "config",
  execution: "local",
  visibility: chromeOnlyVisibility,
};

describe("chromeOnlyVisibility · 环境过滤", () => {
  it("有 chrome → list 同时含普通命令与 alt-screen 命令", () => {
    const r = new DefaultCommandRegistry();
    r.register(plainCmd);
    r.register(chromeCmd);
    const names = r.list(runtime(true)).map((c) => c.name);
    expect(names).toContain("status");
    expect(names).toContain("config");
  });

  it("无 chrome → list 过滤掉 alt-screen 命令,普通命令仍在", () => {
    const r = new DefaultCommandRegistry();
    r.register(plainCmd);
    r.register(chromeCmd);
    const names = r.list(runtime(false)).map((c) => c.name);
    expect(names).toContain("status");
    expect(names).not.toContain("config");
  });

  it("escape hatch:无 chrome 时 findByName 仍命中(执行路径不被 visibility 挡)", () => {
    const r = new DefaultCommandRegistry();
    r.register(chromeCmd);
    expect(r.findByName("config")?.id).toBe("config:repl");
  });
});

function makeWriter(): CliWriter & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    line: (text: string) => {
      lines.push(text);
    },
  } as unknown as CliWriter & { lines: string[] };
}

describe("requireChrome · 执行期兜底", () => {
  it("有 chrome(screen 非 null) → 放行、不打印", () => {
    const w = makeWriter();
    const ok = requireChrome({} as ScreenController, w, "配置编辑器");
    expect(ok).toBe(true);
    expect(w.lines).toHaveLength(0);
  });

  it("无 chrome(screen null) → 拦截、打印含命令用途的提示", () => {
    const w = makeWriter();
    const ok = requireChrome(null, w, "配置编辑器");
    expect(ok).toBe(false);
    expect(w.lines).toHaveLength(1);
    expect(stripAnsi(w.lines[0]!)).toContain("配置编辑器");
  });
});
