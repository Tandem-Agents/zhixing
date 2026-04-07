import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBashTool } from "../bash.js";

describe("Bash Tool", () => {
  const tool = createBashTool();
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zhixing-bash-test-"));
  });

  afterEach(async () => {
    // Windows 下被 kill 的子进程可能短暂锁住 tmpDir，重试清理
    for (let i = 0; i < 3; i++) {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  });

  const ctx = () => ({ workingDirectory: tmpDir });

  // ─── 基本执行 ───

  it("执行简单命令并返回输出", async () => {
    const result = await tool.call({ command: "echo hello" }, ctx());

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("hello");
    expect(result.content).toContain("[exit code: 0]");
  });

  it("在指定工作目录下执行", async () => {
    // 在 tmpDir 中创建标记文件
    await fs.writeFile(path.join(tmpDir, "marker.txt"), "found", "utf-8");

    // 用平台无关的方式验证工作目录
    const isWindows = process.platform === "win32";
    const command = isWindows ? "dir /b marker.txt" : "ls marker.txt";
    const result = await tool.call({ command }, ctx());

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("marker.txt");
  });

  // ─── 错误处理 ───

  it("命令失败时 isError 为 true", async () => {
    const isWindows = process.platform === "win32";
    const command = isWindows ? "exit /b 1" : "exit 1";
    const result = await tool.call({ command }, ctx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("[exit code:");
  });

  it("不存在的命令返回错误", async () => {
    const result = await tool.call(
      { command: "this_command_absolutely_does_not_exist_xyz123" },
      ctx(),
    );

    expect(result.isError).toBe(true);
  });

  it("空命令返回参数错误", async () => {
    const result = await tool.call({ command: "" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("command");
  });

  // ─── 超时 ───

  it("超时后命令被终止", async () => {
    const isWindows = process.platform === "win32";
    // 用一个会持续很久的命令
    const command = isWindows ? "ping -n 100 127.0.0.1" : "sleep 100";

    const result = await tool.call(
      { command, timeout: 500 },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("timed out");
  }, 10_000);

  // ─── stdout + stderr ───

  it("同时捕获 stdout 和 stderr", async () => {
    const isWindows = process.platform === "win32";
    const command = isWindows
      ? "echo out_msg && echo err_msg 1>&2"
      : "echo out_msg && echo err_msg >&2";
    const result = await tool.call({ command }, ctx());

    expect(result.content).toContain("out_msg");
    expect(result.content).toContain("err_msg");
  });

  // ─── 工具元信息 ───

  it("声明为非只读且需要权限", () => {
    expect(tool.isReadOnly).toBe(false);
    expect(tool.isParallelSafe).toBe(false);
    expect(tool.needsPermission).toBe(true);
  });
});
