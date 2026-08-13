import type { ProgramUpdateHealthSnapshot } from "@zhixing/server";
import { createRpcClient } from "@zhixing/server";

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

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
}
