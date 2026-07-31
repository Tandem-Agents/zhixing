import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, chmod } from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { acquireFileLock } from "@zhixing/core/persistence";
import { canonicalize } from "@zhixing/core/protocol";

const TRANSPORT_VERSION = 1;

export interface LocalWorkspaceOwnerLease {
  readonly zhixingHome: string;
  readonly endpoint: string;
  readonly secretPath: string;
  release(): Promise<void>;
}

export function localWorkspaceEndpoint(zhixingHome: string): string {
  const digest = createHash("sha256")
    .update(path.resolve(zhixingHome))
    .digest("hex")
    .slice(0, 24);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\zhixing-workspace-${digest}`
    : path.join(zhixingHome, "runtime", `workspace-${digest}.sock`);
}

export async function acquireLocalWorkspaceOwner(
  zhixingHome: string,
  waitMs = 0,
): Promise<LocalWorkspaceOwnerLease> {
  const runtimeDir = path.join(zhixingHome, "runtime");
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const release = await acquireFileLock(
    path.join(runtimeDir, "local-workspace-management.owner.lock"),
    {
      staleMs: 30_000,
      waitMs,
      resourceName: "Local workspace management owner",
    },
  );
  let released = false;
  return {
    zhixingHome,
    endpoint: localWorkspaceEndpoint(zhixingHome),
    secretPath: path.join(runtimeDir, "local-workspace-management.transport.json"),
    async release() {
      if (released) return;
      released = true;
      await release();
    },
  };
}

interface TransportSecret {
  readonly v: typeof TRANSPORT_VERSION;
  readonly user: string;
  readonly token: string;
}

interface RequestEnvelope {
  readonly v: typeof TRANSPORT_VERSION;
  readonly id: string;
  readonly token: string;
  readonly body: unknown;
}

interface ResponseEnvelope {
  readonly v: typeof TRANSPORT_VERSION;
  readonly id: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

export class LocalWorkspaceTransportServer {
  readonly #lease: LocalWorkspaceOwnerLease;
  readonly #handle: (body: unknown) => Promise<unknown>;
  #server: Server | undefined;
  #secret: TransportSecret | undefined;

  constructor(
    lease: LocalWorkspaceOwnerLease,
    handle: (body: unknown) => Promise<unknown>,
  ) {
    this.#lease = lease;
    this.#handle = handle;
  }

  async start(): Promise<void> {
    if (this.#server) return;
    const secret: TransportSecret = {
      v: TRANSPORT_VERSION,
      user: os.userInfo().username,
      token: randomBytes(32).toString("base64url"),
    };
    await writeSecret(this.#lease.secretPath, secret);
    if (process.platform !== "win32") {
      await rm(this.#lease.endpoint, { force: true });
    }
    const server = net.createServer((socket) => this.#accept(socket));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.#lease.endpoint);
    });
    if (process.platform !== "win32") await chmod(this.#lease.endpoint, 0o600);
    this.#secret = secret;
    this.#server = server;
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    this.#secret = undefined;
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await rm(this.#lease.secretPath, { force: true });
    if (process.platform !== "win32") {
      await rm(this.#lease.endpoint, { force: true });
    }
  }

  #accept(socket: Socket): void {
    socket.setEncoding("utf8");
    let input = "";
    let settled = false;
    const reply = (response: ResponseEnvelope) => {
      if (settled) return;
      settled = true;
      socket.end(`${canonicalize(response)}\n`);
    };
    socket.on("data", (chunk) => {
      input += chunk;
      if (input.length > 1024 * 1024) {
        reply(errorResponse("unknown", "REQUEST_TOO_LARGE", "Local request is too large"));
        return;
      }
      const newline = input.indexOf("\n");
      if (newline < 0 || settled) return;
      const line = input.slice(0, newline);
      void this.#dispatch(line).then(reply);
    });
    socket.on("error", () => undefined);
  }

  async #dispatch(line: string): Promise<ResponseEnvelope> {
    let id = "unknown";
    try {
      const envelope = validateRequest(JSON.parse(line));
      id = envelope.id;
      if (
        !this.#secret ||
        envelope.token !== this.#secret.token ||
        os.userInfo().username !== this.#secret.user
      ) {
        return errorResponse(id, "UNAUTHORIZED", "Local workspace request is not authorized");
      }
      return {
        v: TRANSPORT_VERSION,
        id,
        ok: true,
        result: (await this.#handle(envelope.body)) ?? null,
      };
    } catch (error) {
      return errorResponse(
        id,
        errorCode(error),
        error instanceof Error ? error.message : "Local workspace request failed",
      );
    }
  }
}

export async function callLocalWorkspaceHost(
  zhixingHome: string,
  body: unknown,
): Promise<unknown> {
  const endpoint = localWorkspaceEndpoint(zhixingHome);
  const secret = validateSecret(
    JSON.parse(await readFile(path.join(zhixingHome, "runtime", "local-workspace-management.transport.json"), "utf8")),
  );
  if (secret.user !== os.userInfo().username) {
    throw new Error("Local workspace host belongs to another OS user");
  }
  const request: RequestEnvelope = {
    v: TRANSPORT_VERSION,
    id: randomBytes(16).toString("hex"),
    token: secret.token,
    body,
  };
  const response = await new Promise<ResponseEnvelope>((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    socket.setEncoding("utf8");
    let output = "";
    socket.once("connect", () => socket.write(`${canonicalize(request)}\n`));
    socket.on("data", (chunk) => {
      output += chunk;
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      socket.end();
      try {
        resolve(validateResponse(JSON.parse(output.slice(0, newline)), request.id));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
    socket.once("end", () => {
      if (!output.includes("\n")) reject(new Error("Local workspace host closed without a response"));
    });
  });
  if (!response.ok) {
    const error = new Error(response.error!.message) as Error & { code?: string };
    error.code = response.error!.code;
    throw error;
  }
  return response.result;
}

async function writeSecret(filePath: string, value: TransportSecret): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp = `${filePath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${canonicalize(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, filePath);
}

function validateSecret(value: unknown): TransportSecret {
  const record = exactRecord(value, ["token", "user", "v"], "transport secret");
  if (
    record.v !== TRANSPORT_VERSION ||
    typeof record.user !== "string" ||
    record.user.length === 0 ||
    typeof record.token !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(record.token)
  ) throw new Error("Local workspace transport secret is invalid");
  return record as unknown as TransportSecret;
}

function validateRequest(value: unknown): RequestEnvelope {
  const record = exactRecord(value, ["body", "id", "token", "v"], "request");
  if (
    record.v !== TRANSPORT_VERSION ||
    typeof record.id !== "string" ||
    !/^[a-f0-9]{32}$/u.test(record.id) ||
    typeof record.token !== "string"
  ) throw new Error("Local workspace request is invalid");
  return record as unknown as RequestEnvelope;
}

function validateResponse(value: unknown, requestId: string): ResponseEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Local workspace response is invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  const expected = record.ok === true ? "id,ok,result,v" : "error,id,ok,v";
  if (keys !== expected || record.v !== TRANSPORT_VERSION || record.id !== requestId) {
    throw new Error("Local workspace response is invalid");
  }
  if (record.ok === false) {
    const error = exactRecord(record.error, ["code", "message"], "response error");
    if (typeof error.code !== "string" || typeof error.message !== "string") {
      throw new Error("Local workspace response error is invalid");
    }
  }
  return record as unknown as ResponseEnvelope;
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Local workspace ${label} is invalid`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== [...keys].sort().join(",")) {
    throw new Error(`Local workspace ${label} fields are invalid`);
  }
  return record;
}

function errorResponse(id: string, code: string, message: string): ResponseEnvelope {
  return { v: TRANSPORT_VERSION, id, ok: false, error: { code, message } };
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : "LOCAL_WORKSPACE_ERROR";
}
