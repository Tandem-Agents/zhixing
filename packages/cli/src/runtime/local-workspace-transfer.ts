import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { getZhixingHome } from "@zhixing/core";

const TRANSFER_VERSION = 1;
const TRANSFER_RETENTION_MS = 10 * 60_000;

interface LocalWorkspaceTransfer {
  readonly version: typeof TRANSFER_VERSION;
  readonly requestId: string;
  readonly createdAt: string;
  readonly displayName: string;
  readonly absolutePath: string;
}

function transferDirectory(): string {
  return path.join(getZhixingHome(), "runtime", "local-workspace-transfers");
}

function transferPath(token: string): string {
  if (!/^[0-9a-f-]{36}$/iu.test(token)) {
    throw new TypeError("Local workspace transfer token is invalid");
  }
  return path.join(transferDirectory(), `${token}.json`);
}

/**
 * Hands a raw local path to the co-located host without placing it on RPC or
 * mesh. Only the opaque token crosses the ordinary control wire.
 */
export async function createLocalWorkspaceTransfer(input: {
  readonly displayName: string;
  readonly absolutePath: string;
}): Promise<{ token: string; requestId: string }> {
  const token = randomUUID();
  const requestId = `environment-admin-transfer:${token}`;
  const directory = transferDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await removeExpiredTransfers(directory);
  const handle = await open(transferPath(token), "wx", 0o600);
  try {
    await handle.writeFile(
      JSON.stringify({
        version: TRANSFER_VERSION,
        requestId,
        createdAt: new Date().toISOString(),
        displayName: input.displayName,
        absolutePath: input.absolutePath,
      } satisfies LocalWorkspaceTransfer),
      "utf8",
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { token, requestId };
}

export async function readLocalWorkspaceTransfer(
  token: string,
): Promise<LocalWorkspaceTransfer> {
  const parsed = JSON.parse(
    await readFile(transferPath(token), "utf8"),
  ) as Partial<LocalWorkspaceTransfer>;
  if (
    parsed.version !== TRANSFER_VERSION ||
    typeof parsed.requestId !== "string" ||
    typeof parsed.createdAt !== "string" ||
    typeof parsed.displayName !== "string" ||
    typeof parsed.absolutePath !== "string"
  ) {
    throw new TypeError("Local workspace transfer is malformed");
  }
  const createdAt = Date.parse(parsed.createdAt);
  if (
    !Number.isFinite(createdAt) ||
    new Date(createdAt).toISOString() !== parsed.createdAt ||
    Date.now() - createdAt > TRANSFER_RETENTION_MS
  ) {
    throw new TypeError("Local workspace transfer is expired");
  }
  return parsed as LocalWorkspaceTransfer;
}

export async function removeLocalWorkspaceTransfer(token: string): Promise<void> {
  await rm(transferPath(token), { force: true });
}

async function removeExpiredTransfers(directory: string): Promise<void> {
  const now = Date.now();
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() && /^[0-9a-f-]{36}\.json$/iu.test(entry.name),
      )
      .map(async (entry) => {
        const target = path.join(directory, entry.name);
        const metadata = await stat(target);
        if (now - metadata.mtimeMs > TRANSFER_RETENTION_MS) {
          await rm(target, { force: true });
        }
      }),
  );
}
