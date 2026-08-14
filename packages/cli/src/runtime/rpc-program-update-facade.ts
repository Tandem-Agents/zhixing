import type { ProgramUpdateHealthSnapshot } from "@zhixing/server";
import { createRpcClient } from "@zhixing/server";
import { protocolDigest } from "@zhixing/core/protocol";
import type { ProgramUpdateProjection } from "../update/update-controller.js";
import {
  CoreHostConnection,
  type CoreHostRpcLink,
  defaultCoreHostConnectionDeps,
} from "./core-host-connection.js";

export interface ProgramUpdatePrepareRequest {
  readonly requestId: string;
  readonly candidateManifestDigest: string;
  readonly timeoutMs: number;
}

export interface DirectProgramUpdateRpcOptions {
  readonly url: string;
  readonly token: string;
  readonly timeoutMs: number;
}

/** 当前设备程序更新的本机认证 RPC 边界；调用方不持有原始 client。 */
export class RpcProgramUpdateFacade {
  constructor(private readonly options: DirectProgramUpdateRpcOptions) {}

  async prepare(
    request: ProgramUpdatePrepareRequest,
    signal?: AbortSignal,
  ): Promise<{ readonly operationId: string }> {
    return this.withAuthenticatedClient(signal, (client) =>
      client.request<{ readonly operationId: string }>("server.update.prepare", request),
    );
  }

  async health(signal?: AbortSignal): Promise<ProgramUpdateHealthSnapshot> {
    return this.withAuthenticatedClient(signal, (client) =>
      client.request<ProgramUpdateHealthSnapshot>("server.update.health"),
    );
  }

  private async withAuthenticatedClient<T>(
    signal: AbortSignal | undefined,
    operation: (
      client: ReturnType<typeof createRpcClient>,
    ) => Promise<T>,
  ): Promise<T> {
    throwIfAborted(signal);
    const client = createRpcClient({
      url: this.options.url,
      timeout: this.options.timeoutMs,
    });
    try {
      await client.connect();
      throwIfAborted(signal);
      await client.authenticate(this.options.token);
      throwIfAborted(signal);
      return await operation(client);
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

/** 当前权威设备的更新通知面；调用方不持有原始 RPC client。 */
export class RpcProgramUpdateSurfaceFacade {
  constructor(private readonly connection: CoreHostRpcLink) {}

  async status(): Promise<ProgramUpdateProjection> {
    return (await this.connection.getClient())
      .request<ProgramUpdateProjection>("server.update.status");
  }

  async prepare(
    request: ProgramUpdatePrepareRequest,
  ): Promise<{ readonly operationId: string }> {
    return (await this.connection.getClient())
      .request<{ readonly operationId: string }>("server.update.prepare", request);
  }

  async consumeNotice(noticeToken: string): Promise<{ readonly consumed: boolean }> {
    return (await this.connection.getClient())
      .request<{ readonly consumed: boolean }>("server.update.consumeNotice", {
        noticeToken,
      });
  }

  onChanged(handler: () => void): () => void {
    return this.connection.onNotification("server.update.changed", () => handler());
  }
}

export async function readCurrentAuthorityProgramUpdateStatus(): Promise<ProgramUpdateProjection> {
  const defaults = defaultCoreHostConnectionDeps();
  const connection = new CoreHostConnection({
    ...defaults,
    spawn: async () => ({
      ok: false,
      mode: "none",
      reason: "只读更新状态不会启动本机宿主",
    }),
  });
  try {
    return await new RpcProgramUpdateSurfaceFacade(connection).status();
  } finally {
    await connection.dispose();
  }
}

export type CurrentAuthorityProgramUpdateStatus =
  | { readonly availability: "available"; readonly projection: ProgramUpdateProjection }
  | { readonly availability: "unavailable" };

export async function tryReadCurrentAuthorityProgramUpdateStatus(): Promise<CurrentAuthorityProgramUpdateStatus> {
  try {
    return {
      availability: "available",
      projection: await readCurrentAuthorityProgramUpdateStatus(),
    };
  } catch {
    return { availability: "unavailable" };
  }
}

export async function requestCurrentHostProgramUpdatePrepare(
  candidateManifestDigest: string,
  signal?: AbortSignal,
): Promise<{ readonly operationId: string }> {
  if (signal?.aborted) throw signal.reason;
  const connection = new CoreHostConnection(defaultCoreHostConnectionDeps());
  try {
    return await new RpcProgramUpdateSurfaceFacade(connection).prepare({
      requestId: protocolDigest("ProgramUpdateHandoffRequest", 1, { candidateManifestDigest }),
      candidateManifestDigest,
      timeoutMs: 30_000,
    });
  } finally {
    await connection.dispose();
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
}
