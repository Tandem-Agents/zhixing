import { getEventListeners } from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import { createBashTool } from "../bash.js";

describe("Bash Tool", () => {
  const tool = createBashTool();
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir("bash");
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

  it("声明 interruptBehavior=grace (持有外部子进程, 需 SIGTERM→SIGKILL 升级链)", () => {
    expect(tool.interruptBehavior).toBe("grace");
  });

  // ─── abort 路径 + listener 资源回收 ───

  it("abort 信号触发 → 工具立即返回 ABORT 错误 (不等 grace 期完成)", async () => {
    const isWindows = process.platform === "win32";
    const command = isWindows ? "ping -n 100 127.0.0.1" : "sleep 100";
    const controller = new AbortController();

    const callPromise = tool.call(
      { command },
      { ...ctx(), abortSignal: controller.signal },
    );

    // 100ms 后触发 abort, 上层应在毫秒级响应 (P95 SLO 监控 loop 框架延迟,
    // 子进程后台 gracefulKill 不阻塞 promise reject)
    setTimeout(() => controller.abort(), 100);

    const t0 = Date.now();
    const result = await callPromise;
    const elapsed = Date.now() - t0;

    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("abort");
    // 上限放宽到 1500ms 含 abort 触发延迟 + 测试调度抖动
    expect(elapsed).toBeLessThan(1500);
  }, 5_000);

  it("已 aborted signal → 工具立即返回 ABORT 错误", async () => {
    const isWindows = process.platform === "win32";
    const command = isWindows ? "ping -n 100 127.0.0.1" : "sleep 100";
    const controller = new AbortController();
    controller.abort();

    const result = await tool.call(
      { command },
      { ...ctx(), abortSignal: controller.signal },
    );

    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("abort");
  }, 3_000);

  it("命令正常完成 → abort listener 被清理 (不残留)", async () => {
    const controller = new AbortController();
    const before = getEventListeners(controller.signal, "abort").length;

    const result = await tool.call(
      { command: "echo done" },
      { ...ctx(), abortSignal: controller.signal },
    );

    expect(result.isError).toBeFalsy();
    expect(getEventListeners(controller.signal, "abort").length).toBe(before);
  });

  it("命令超时 → abort listener 被清理 (不残留)", async () => {
    const isWindows = process.platform === "win32";
    const command = isWindows ? "ping -n 100 127.0.0.1" : "sleep 100";
    const controller = new AbortController();
    const before = getEventListeners(controller.signal, "abort").length;

    const result = await tool.call(
      { command, timeout: 500 },
      { ...ctx(), abortSignal: controller.signal },
    );

    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toContain("timed out");
    expect(getEventListeners(controller.signal, "abort").length).toBe(before);
  }, 10_000);

  it("abort 触发 → abort listener 被清理 (不残留)", async () => {
    const isWindows = process.platform === "win32";
    const command = isWindows ? "ping -n 100 127.0.0.1" : "sleep 100";
    const controller = new AbortController();
    const before = getEventListeners(controller.signal, "abort").length;

    const callPromise = tool.call(
      { command },
      { ...ctx(), abortSignal: controller.signal },
    );
    setTimeout(() => controller.abort(), 100);

    await callPromise;

    expect(getEventListeners(controller.signal, "abort").length).toBe(before);
  }, 5_000);
});
