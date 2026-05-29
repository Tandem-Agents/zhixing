import { describe, it, expect } from "vitest";
import {
  resolveEditor,
  openInEditor,
  type EditorResolveEnv,
  type ResolvedEditor,
} from "../editor-resolve.js";

const noProbe = (): null => null;

const env = (over: Partial<EditorResolveEnv>): EditorResolveEnv => ({
  platform: "linux",
  probe: noProbe,
  ...over,
});

describe("resolveEditor — 优先级链", () => {
  it("configured 最高优先,且能切出参数", () => {
    const r = resolveEditor(
      env({ configured: "code --wait", visual: "vim", editor: "nano" }),
    );
    expect(r).toEqual({ command: "code", baseArgs: ["--wait"], source: "configured" });
  });

  it("无 configured → 落 $VISUAL", () => {
    const r = resolveEditor(env({ visual: "vim", editor: "nano" }));
    expect(r).toEqual({ command: "vim", baseArgs: [], source: "visual" });
  });

  it("VISUAL 缺 → $EDITOR", () => {
    const r = resolveEditor(env({ editor: "nano" }));
    expect(r.source).toBe("editor");
    expect(r.command).toBe("nano");
  });

  it("env 都缺 → git core.editor", () => {
    const r = resolveEditor(env({ gitEditor: "vim" }));
    expect(r.source).toBe("git");
  });

  it("空串视为未设置、被跳过", () => {
    const r = resolveEditor(env({ configured: "", visual: "  ", editor: "nano" }));
    expect(r.source).toBe("editor");
  });
});

describe("resolveEditor — PATH 探测", () => {
  it("配置全缺 → 按偏好探测,GUI(code)优先", () => {
    const r = resolveEditor(
      env({ probe: (c) => (c === "code" || c === "vim" ? `/usr/bin/${c}` : null) }),
    );
    expect(r).toEqual({ command: "/usr/bin/code", baseArgs: [], source: "probe" });
  });

  it("只探到终端编辑器也用", () => {
    const r = resolveEditor(env({ probe: (c) => (c === "vim" ? "/usr/bin/vim" : null) }));
    expect(r.command).toBe("/usr/bin/vim");
    expect(r.source).toBe("probe");
  });
});

describe("resolveEditor — OS 兜底", () => {
  it("Windows → notepad", () => {
    expect(resolveEditor(env({ platform: "win32" }))).toEqual({
      command: "notepad",
      baseArgs: [],
      source: "os-default",
    });
  });

  it("macOS → open -t", () => {
    expect(resolveEditor(env({ platform: "darwin" }))).toEqual({
      command: "open",
      baseArgs: ["-t"],
      source: "os-default",
    });
  });

  it("Linux → nano", () => {
    expect(resolveEditor(env({ platform: "linux" })).command).toBe("nano");
  });
});

describe("openInEditor", () => {
  it("spawn 收到 命令 + [...baseArgs, 文件]", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const resolved: ResolvedEditor = {
      command: "code",
      baseArgs: ["--new-window"],
      source: "configured",
    };
    openInEditor("/tmp/SKILL.md", resolved, (command, args) =>
      calls.push({ command, args }),
    );
    expect(calls).toEqual([
      { command: "code", args: ["--new-window", "/tmp/SKILL.md"] },
    ]);
  });
});
