import type { Digest, IsoTime, JsonValue, WireSchemaV1 } from "../types/distributed.js";

export interface LogicalRecord<Body = JsonValue> {
  stream: string;
  body: Body;
}

export interface CommitEnvelope<Body = JsonValue>
  extends WireSchemaV1<"CommitEnvelope"> {
  lsn: number;
  at: IsoTime;
  entries: Array<LogicalRecord<Body>>;
  envelopeDigest: Digest;
}
