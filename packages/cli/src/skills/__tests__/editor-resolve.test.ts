import { describe, it, expect } from "vitest";
import {
  resolveEditor,
  openInEditor,
  buildSpawnInvocation,
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
  it("spawn 收到 命令 + [...baseArgs, 文件];onError 透传供 spawn 失败回传", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const onError = (): void => {};
    let passedOnError: unknown;
    const resolved: ResolvedEditor = {
      command: "code",
      baseArgs: ["--new-window"],
      source: "configured",
    };
    openInEditor("/tmp/SKILL.md", resolved, onError, (command, args, oe) => {
      calls.push({ command, args });
      passedOnError = oe;
    });
    expect(calls).toEqual([
      { command: "code", args: ["--new-window", "/tmp/SKILL.md"] },
    ]);
    expect(passedOnError).toBe(onError);
  });
});

describe("buildSpawnInvocation — 跨平台 spawn 构造", () => {
  it("非 Windows:原样直传、不走 shell", () => {
    expect(buildSpawnInvocation("code", ["--wait", "/tmp/a.md"], "linux")).toEqual({
      command: "code",
      args: ["--wait", "/tmp/a.md"],
      shell: false,
    });
  });

  it("Windows:走 shell;含空格的程序路径加引号、无空格的文件原样", () => {
    const inv = buildSpawnInvocation(
      "D:\\workapp\\Microsoft VS Code\\bin\\code",
      ["C:\\Users\\me\\skill.md"],
      "win32",
    );
    expect(inv.shell).toBe(true);
    expect(inv.command).toBe('"D:\\workapp\\Microsoft VS Code\\bin\\code"');
    expect(inv.args).toEqual(["C:\\Users\\me\\skill.md"]);
  });

  it("Windows:含空格的文件路径也加引号(防被空格切断)", () => {
    expect(
      buildSpawnInvocation("notepad", ["C:\\My Docs\\skill.md"], "win32").args,
    ).toEqual(['"C:\\My Docs\\skill.md"']);
  });

  it("Windows:无扩展名 code 走 shell(由 cmd.exe 按 PATHEXT 补全 .cmd)", () => {
    expect(buildSpawnInvocation("code", ["/tmp/a.md"], "win32").shell).toBe(true);
  });
});
