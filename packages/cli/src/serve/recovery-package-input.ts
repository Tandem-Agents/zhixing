export const DEFAULT_MAX_RECOVERY_PACKAGE_BYTES = 16 * 1024 * 1024;

/** The dedicated secret surface has the same byte budget as the original TTY reader. */
export function assertRecoveryPackageInputLimit(
  value: string | Uint8Array,
  maxBytes = DEFAULT_MAX_RECOVERY_PACKAGE_BYTES,
): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_RECOVERY_PACKAGE_BYTES) {
    throw new RangeError("恢复包输入上限无效");
  }
  const length = typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength;
  if (length > maxBytes) throw new Error("恢复包超过允许长度");
}

/** Secret input belongs exclusively to the managed terminal surface. */
export function requireRecoveryPackageSurface(): never {
  throw new Error("恢复包需要交互式保密输入；请在完整交互终端中重新运行原命令。");
}
