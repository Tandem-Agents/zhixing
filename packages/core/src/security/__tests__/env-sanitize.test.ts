import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnvSanitize } from "../env-sanitize.js";

describe("EnvSanitize", () => {
  describe("isDangerous", () => {
    it("LD_PRELOAD 是危险变量", () => {
      expect(EnvSanitize.isDangerous("LD_PRELOAD")).toBe(true);
    });

    it("LD_LIBRARY_PATH 是危险变量", () => {
      expect(EnvSanitize.isDangerous("LD_LIBRARY_PATH")).toBe(true);
    });

    it("DYLD_INSERT_LIBRARIES 是危险变量", () => {
      expect(EnvSanitize.isDangerous("DYLD_INSERT_LIBRARIES")).toBe(true);
    });

    it("NODE_OPTIONS 是危险变量", () => {
      expect(EnvSanitize.isDangerous("NODE_OPTIONS")).toBe(true);
    });

    it("PATH 不在危险变量列表中", () => {
      expect(EnvSanitize.isDangerous("PATH")).toBe(false);
    });

    it("HOME 不在危险变量列表中", () => {
      expect(EnvSanitize.isDangerous("HOME")).toBe(false);
    });
  });

  describe("isConditionallyDangerous", () => {
    it("PYTHONPATH 是条件危险变量", () => {
      expect(EnvSanitize.isConditionallyDangerous("PYTHONPATH")).toBe(true);
    });

    it("RUBYLIB 是条件危险变量", () => {
      expect(EnvSanitize.isConditionallyDangerous("RUBYLIB")).toBe(true);
    });

    it("LD_PRELOAD 不在条件危险列表中", () => {
      expect(EnvSanitize.isConditionallyDangerous("LD_PRELOAD")).toBe(false);
    });
  });

  describe("buildCleanEnv", () => {
    it("从环境中移除危险变量", () => {
      const env = {
        HOME: "/home/user",
        PATH: "/usr/bin",
        LD_PRELOAD: "/tmp/evil.so",
        NODE_OPTIONS: "--inspect",
        TERM: "xterm",
      };

      const clean = EnvSanitize.buildCleanEnv(env);

      expect(clean["HOME"]).toBe("/home/user");
      expect(clean["PATH"]).toBe("/usr/bin");
      expect(clean["TERM"]).toBe("xterm");
      expect(clean["LD_PRELOAD"]).toBeUndefined();
      expect(clean["NODE_OPTIONS"]).toBeUndefined();
    });

    it("从环境中移除条件危险变量", () => {
      const env = {
        HOME: "/home/user",
        PYTHONPATH: "/tmp/evil",
        CLASSPATH: "/tmp/evil.jar",
      };

      const clean = EnvSanitize.buildCleanEnv(env);

      expect(clean["HOME"]).toBe("/home/user");
      expect(clean["PYTHONPATH"]).toBeUndefined();
      expect(clean["CLASSPATH"]).toBeUndefined();
    });

    it("不含危险变量的环境原样返回", () => {
      const env = {
        HOME: "/home/user",
        PATH: "/usr/bin",
        TERM: "xterm",
        LANG: "en_US.UTF-8",
      };

      const clean = EnvSanitize.buildCleanEnv(env);

      expect(Object.keys(clean).sort()).toEqual(
        Object.keys(env).sort(),
      );
    });

    it("空环境返回空对象", () => {
      const clean = EnvSanitize.buildCleanEnv({});
      expect(Object.keys(clean)).toHaveLength(0);
    });

    it("跳过 undefined 值的环境变量", () => {
      const env: Record<string, string | undefined> = {
        HOME: "/home/user",
        EMPTY_VAR: undefined,
      };

      const clean = EnvSanitize.buildCleanEnv(env as NodeJS.ProcessEnv);

      expect(clean["HOME"]).toBe("/home/user");
      expect("EMPTY_VAR" in clean).toBe(false);
    });
  });

  describe("getDangerousVarNames", () => {
    it("返回非空列表", () => {
      const names = EnvSanitize.getDangerousVarNames();
      expect(names.length).toBeGreaterThan(0);
    });

    it("包含 LD_PRELOAD", () => {
      const names = EnvSanitize.getDangerousVarNames();
      expect(names).toContain("LD_PRELOAD");
    });
  });

  describe("中间件执行", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) {
          delete process.env[key];
        }
      }
    });

    it("在管线中传递 sanitizedEnv 到结果", async () => {
      process.env["LD_PRELOAD"] = "/tmp/evil.so";

      const middleware = new EnvSanitize();
      const ctx = {
        request: {
          tool: "bash",
          arguments: { command: "ls" },
          context: {
            cwd: "/home/user",
            workspace: "/home/user",
            sessionType: "interactive" as const,
          },
        },
        toolName: "bash",
        toolInput: { command: "ls" },
        workingDirectory: "/home/user",
        state: {},
      };

      const result = await middleware.execute(ctx, async () => ({
        allowed: true,
      }));

      expect(result.sanitizedEnv).toBeDefined();
      expect(result.sanitizedEnv?.["LD_PRELOAD"]).toBeUndefined();
      expect(ctx.state.removedEnvVars).toContain("LD_PRELOAD");

      delete process.env["LD_PRELOAD"];
    });
  });
});
