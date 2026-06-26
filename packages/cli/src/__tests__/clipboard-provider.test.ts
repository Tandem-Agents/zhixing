import { describe, expect, it, vi } from "vitest";
import { createSystemClipboardProvider } from "../clipboard-provider.js";

describe("createSystemClipboardProvider", () => {
  it("Windows 路径用 Console.Out.Write 精确输出剪贴板文本", async () => {
    const runCommand = vi.fn(async () => "hello");
    const provider = createSystemClipboardProvider("win32", runCommand);

    await expect(provider.readText()).resolves.toBe("hello");

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand.mock.calls[0]?.[0]).toBe("powershell.exe");
    expect(runCommand.mock.calls[0]?.[1]).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
        "[Console]::Out.Write((Get-Clipboard -Raw))",
      ].join("; "),
    ]);
  });

  it("Windows Raw 读取失败时回退到逐行读取并显式 join", async () => {
    const runCommand = vi
      .fn()
      .mockRejectedValueOnce(new Error("Raw unsupported"))
      .mockResolvedValueOnce("a\r\nb");
    const provider = createSystemClipboardProvider("win32", runCommand);

    await expect(provider.readText()).resolves.toBe("a\r\nb");

    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(runCommand.mock.calls[1]?.[1]?.[3]).toContain(
      "$value = Get-Clipboard",
    );
    expect(runCommand.mock.calls[1]?.[1]?.[3]).toContain(
      "($value -join [Environment]::NewLine)",
    );
  });

  it("空剪贴板返回 null，不继续尝试其它命令", async () => {
    const runCommand = vi.fn(async () => "");
    const provider = createSystemClipboardProvider("linux", runCommand);

    await expect(provider.readText()).resolves.toBeNull();

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand.mock.calls[0]?.[0]).toBe("wl-paste");
  });

  it("Linux 路径按 wl-paste、xclip、xsel 顺序 fallback", async () => {
    const runCommand = vi
      .fn()
      .mockRejectedValueOnce(new Error("missing wl-paste"))
      .mockRejectedValueOnce(new Error("missing xclip"))
      .mockResolvedValueOnce("from xsel");
    const provider = createSystemClipboardProvider("linux", runCommand);

    await expect(provider.readText()).resolves.toBe("from xsel");

    expect(runCommand.mock.calls.map(([file]) => file)).toEqual([
      "wl-paste",
      "xclip",
      "xsel",
    ]);
  });
});
