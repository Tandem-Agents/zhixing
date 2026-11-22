/** JSON-RPC busy error code (-32003, matching RPC_ERROR_CODES.BUSY). */
export const RPC_BUSY_ERROR_CODE = -32003;

export interface RpcBusyErrorShape {
  readonly message: string;
  readonly reason?: string;
}

/**
 * Reads structured RPC BUSY metadata without pulling transport dependencies
 * into lightweight terminal/text command bundles.
 */
export function readRpcBusyError(error: unknown): RpcBusyErrorShape | undefined {
  if (!(error instanceof Error)) return undefined;
  if ((error as { readonly code?: unknown }).code !== RPC_BUSY_ERROR_CODE) return undefined;
  const data = (error as { readonly data?: unknown }).data;
  const reason =
    data && typeof data === 'object' && 'reason' in data && typeof (data as { readonly reason?: unknown }).reason === 'string'
      ? (data as { readonly reason: string }).reason
      : undefined;
  return { message: error.message, ...(reason ? { reason } : {}) };
}
