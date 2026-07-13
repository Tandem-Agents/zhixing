import { link, open, rm } from "node:fs/promises";

export interface PreparedExclusiveFileClaim {
  readonly claimPath: string;
  publish(): Promise<boolean>;
  dispose(): Promise<void>;
}

export async function prepareExclusiveFileClaim(
  targetPath: string,
  contents: string,
  claimId: string,
): Promise<PreparedExclusiveFileClaim> {
  if (!/^[a-f0-9]{32}$/u.test(claimId)) {
    throw new TypeError("Exclusive file claim id must be a 128-bit lowercase hex value");
  }
  const claimPath = `${targetPath}.claim-${claimId}`;
  const handle = await open(claimPath, "wx", 0o600);
  let closed = false;
  let prepared = false;
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    closed = true;
    prepared = true;
  } finally {
    if (!closed) await handle.close().catch(() => undefined);
    if (!prepared) await rm(claimPath, { force: true }).catch(() => undefined);
  }

  return {
    claimPath,
    async publish(): Promise<boolean> {
      try {
        await link(claimPath, targetPath);
        return true;
      } catch (error) {
        if (isNodeError(error, "EEXIST") || isNodeError(error, "ENOENT")) return false;
        throw new Error(
          "Atomic lock publication requires same-directory hard-link support",
          { cause: error },
        );
      }
    },
    async dispose(): Promise<void> {
      await rm(claimPath, { force: true });
    },
  };
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
