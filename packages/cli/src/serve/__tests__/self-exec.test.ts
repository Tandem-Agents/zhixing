import { describe, it, expect } from "vitest";
import {
  isDaemonChild,
  resolveSelfExec,
  buildDaemonSpawnOptions,
  filterDaemonChildEnv,
  UnsupportedSelfExecError,
  DAEMON_CHILD_ENV_VAR,
} from "../self-exec.js";

describe("isDaemonChild", () => {
  it("returns true when env var is '1'", () => {
    expect(isDaemonChild({ [DAEMON_CHILD_ENV_VAR]: "1" })).toBe(true);
  });

  it("returns false when env var is missing", () => {
    expect(isDaemonChild({})).toBe(false);
  });

  it("returns false for any value other than '1'", () => {
    expect(isDaemonChild({ [DAEMON_CHILD_ENV_VAR]: "0" })).toBe(false);
    expect(isDaemonChild({ [DAEMON_CHILD_ENV_VAR]: "true" })).toBe(false);
    expect(isDaemonChild({ [DAEMON_CHILD_ENV_VAR]: "" })).toBe(false);
  });
});

describe("resolveSelfExec", () => {
  const baseDeps = {
    argv: ["/usr/bin/node", "/path/to/zhixing/dist/index.js"],
    execPath: "/usr/bin/node",
    env: { PATH: "/usr/bin", HOME: "/home/u" },
    fileExistsFn: () => true,
  };

  it("resolves to { execPath, [entry, ...forwarded], env with DAEMON_CHILD=1 }", () => {
    const r = resolveSelfExec(["serve", "--port", "18900"], baseDeps);
    expect(r.command).toBe("/usr/bin/node");
    expect(r.args).toEqual(["/path/to/zhixing/dist/index.js", "serve", "--port", "18900"]);
    expect(r.env[DAEMON_CHILD_ENV_VAR]).toBe("1");
  });

  it("filters TTY-related env vars and sets NO_COLOR", () => {
    const r = resolveSelfExec([], {
      ...baseDeps,
      env: { PATH: "/bin", TERM: "xterm", FORCE_COLOR: "1", COLUMNS: "120" },
    });
    expect(r.env.TERM).toBeUndefined();
    expect(r.env.FORCE_COLOR).toBeUndefined();
    expect(r.env.COLUMNS).toBeUndefined();
    expect(r.env.NO_COLOR).toBe("1");
    expect(r.env.PATH).toBe("/bin"); // non-TTY vars preserved
  });

  it("throws UnsupportedSelfExecError when argv[1] is missing", () => {
    expect(() =>
      resolveSelfExec([], { ...baseDeps, argv: ["/usr/bin/node"] }),
    ).toThrow(UnsupportedSelfExecError);
  });

  it("throws for non-.js entry (bundled binary)", () => {
    expect(() =>
      resolveSelfExec([], { ...baseDeps, argv: ["/usr/bin/node", "/opt/zhixing-bin"] }),
    ).toThrow(/not a JavaScript file/);
  });

  it("throws when entry script does not exist on disk", () => {
    expect(() =>
      resolveSelfExec([], { ...baseDeps, fileExistsFn: () => false }),
    ).toThrow(/does not exist on disk/);
  });

  it("accepts .mjs and .cjs entries", () => {
    expect(() =>
      resolveSelfExec([], { ...baseDeps, argv: ["/node", "/x/index.mjs"] }),
    ).not.toThrow();
    expect(() =>
      resolveSelfExec([], { ...baseDeps, argv: ["/node", "/x/index.cjs"] }),
    ).not.toThrow();
  });
});

describe("filterDaemonChildEnv", () => {
  it("strips TERM/COLUMNS/LINES/FORCE_COLOR/CLICOLOR/COLORTERM", () => {
    const r = filterDaemonChildEnv({
      TERM: "xterm-256color",
      COLUMNS: "120",
      LINES: "40",
      FORCE_COLOR: "1",
      CLICOLOR: "1",
      CLICOLOR_FORCE: "1",
      COLORTERM: "truecolor",
      HOME: "/home/u",
    });
    expect(r.TERM).toBeUndefined();
    expect(r.COLUMNS).toBeUndefined();
    expect(r.LINES).toBeUndefined();
    expect(r.FORCE_COLOR).toBeUndefined();
    expect(r.CLICOLOR).toBeUndefined();
    expect(r.CLICOLOR_FORCE).toBeUndefined();
    expect(r.COLORTERM).toBeUndefined();
    expect(r.HOME).toBe("/home/u");
  });

  it("always sets NO_COLOR=1", () => {
    expect(filterDaemonChildEnv({}).NO_COLOR).toBe("1");
    expect(filterDaemonChildEnv({ NO_COLOR: "0" }).NO_COLOR).toBe("1");
  });

  it("strips SSH_TTY* entries", () => {
    const r = filterDaemonChildEnv({ SSH_TTY: "/dev/pts/0", SSH_CONNECTION: "1.2.3.4" });
    expect(r.SSH_TTY).toBeUndefined();
    expect(r.SSH_CONNECTION).toBe("1.2.3.4"); // 非 TTY 保留
  });

  it("drops undefined values", () => {
    const r = filterDaemonChildEnv({ A: undefined, B: "value" });
    expect(r.A).toBeUndefined();
    expect(r.B).toBe("value");
  });
});

describe("buildDaemonSpawnOptions", () => {
  it("returns detached=true, windowsHide=true, stdio with logFd", () => {
    const env = { NO_COLOR: "1" };
    const opts = buildDaemonSpawnOptions(42, env);
    expect(opts.detached).toBe(true);
    expect(opts.windowsHide).toBe(true);
    expect(opts.stdio).toEqual(["ignore", 42, 42]);
    expect(opts.env).toBe(env);
  });
});
