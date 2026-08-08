import { PassThrough } from "node:stream";
import { encodeRecoveryPackage } from "@zhixing/mesh/recovery-package";
import { RecoveryRoot } from "@zhixing/mesh/recovery-root";
import { describe, expect, it } from "vitest";
import { readRecoveryPackageFromTty } from "./recovery-package-input.js";

describe("recovery package TTY input", () => {
  it("accepts paste, backspace and enter without echoing the secret", async () => {
    const stdin = ttyInput();
    const output: string[] = [];
    const root = RecoveryRoot.generate();
    const recoveryPackage = encodeRecoveryPackage(root);
    const reading = readRecoveryPackageFromTty({
      stdin,
      stdout: { isTTY: true, write: (value) => output.push(String(value)) } as never,
    });

    stdin.emit("keypress", `${recoveryPackage}x`, {});
    stdin.emit("keypress", undefined, { name: "backspace" });
    stdin.emit("keypress", "\r", { name: "return" });

    const decoded = await reading;
    expect(decoded.root.publicIdentity()).toEqual(root.publicIdentity());
    expect(output.join("")).not.toContain(recoveryPackage);
    expect(stdin.isRaw).toBe(false);
  });

  it("fails closed for non-TTY input and supports cancellation", async () => {
    const nonTty = ttyInput(false);
    await expect(readRecoveryPackageFromTty({
      stdin: nonTty,
      stdout: { isTTY: true, write: () => true } as never,
    })).rejects.toThrow("交互式保密输入");

    const stdin = ttyInput();
    const reading = readRecoveryPackageFromTty({
      stdin,
      stdout: { isTTY: true, write: () => true } as never,
    });
    stdin.emit("keypress", undefined, { name: "c", ctrl: true });
    await expect(reading).rejects.toThrow("输入已取消");
    expect(stdin.isRaw).toBe(false);
  });
});

function ttyInput(isTTY = true): NodeJS.ReadStream {
  const stream = new PassThrough() as PassThrough & NodeJS.ReadStream;
  Object.defineProperties(stream, {
    isTTY: { configurable: true, value: isTTY },
    isRaw: { configurable: true, value: false, writable: true },
  });
  stream.setRawMode = (mode: boolean) => {
    Object.defineProperty(stream, "isRaw", { configurable: true, value: mode, writable: true });
    return stream;
  };
  return stream;
}
