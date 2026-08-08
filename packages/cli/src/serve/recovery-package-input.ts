import type { DecodedRecoveryPackage } from "@zhixing/mesh/recovery-package";
import { decodeRecoveryPackage } from "@zhixing/mesh/recovery-package";
import { acquireStdinOwnership } from "../tui/_internal/stdin-ownership.js";

const DEFAULT_MAX_RECOVERY_PACKAGE_BYTES = 16 * 1024 * 1024;

export interface RecoveryPackageInputOptions {
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: Pick<NodeJS.WriteStream, "isTTY" | "write">;
  readonly prompt?: string;
  readonly maxBytes?: number;
}

export async function readRecoveryPackageFromTty(
  options: RecoveryPackageInputOptions = {},
): Promise<DecodedRecoveryPackage> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_RECOVERY_PACKAGE_BYTES;
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("恢复包只能通过交互式保密输入提供");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("恢复包输入上限无效");
  }

  const bytes = Buffer.alloc(maxBytes);
  let length = 0;
  const wasRaw = stdin.isRaw;
  const ownership = acquireStdinOwnership(stdin);
  stdout.write(options.prompt ?? "请输入恢复包以完成真实回读验证：");
  stdin.setRawMode(true);
  stdin.resume();

  try {
    return await new Promise<DecodedRecoveryPackage>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        stdin.off("keypress", onKeypress);
        if (error) {
          reject(error);
          return;
        }
        try {
          resolve(decodeRecoveryPackage(bytes.subarray(0, length)));
        } catch (decodeError) {
          reject(decodeError);
        }
      };
      const append = (value: string) => {
        const chunk = Buffer.from(value, "utf8");
        try {
          if (length + chunk.byteLength > bytes.byteLength) {
            finish(new Error("恢复包超过允许长度"));
            return;
          }
          chunk.copy(bytes, length);
          length += chunk.byteLength;
        } finally {
          chunk.fill(0);
        }
      };
      const onKeypress = (
        value: string | undefined,
        key: { readonly name?: string; readonly ctrl?: boolean },
      ) => {
        if (key.ctrl && key.name === "c") {
          finish(new Error("恢复包输入已取消"));
          return;
        }
        if (key.name === "return" || key.name === "enter") {
          finish();
          return;
        }
        if (key.name === "backspace") {
          if (length > 0) length -= 1;
          return;
        }
        if (value && /^[\x20-\x7e]+$/u.test(value)) append(value);
      };
      stdin.on("keypress", onKeypress);
    });
  } finally {
    stdin.setRawMode(Boolean(wasRaw));
    ownership.release();
    bytes.fill(0);
    stdout.write("\n");
  }
}
