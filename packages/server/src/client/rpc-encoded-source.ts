/** A complete, immutable JSON value. Opening pins the source until release;
 * transport owners release only after actual reads and write callbacks finish.
 * No filesystem or terminal policy belongs to the RPC client. */
export interface RpcEncodedJsonSource {
  readonly byteLength: number;
  open(): RpcEncodedJsonReader;
}
export interface RpcEncodedJsonReader {
  read(offset: number, maximum: number, signal: AbortSignal): Promise<Uint8Array>;
  release(): void;
}
export interface RpcRequestDeadline {
  readonly deadline: number;
  readonly signal?: AbortSignal;
}
