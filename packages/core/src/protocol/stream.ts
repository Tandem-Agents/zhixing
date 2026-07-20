import type { StreamFrame } from "../contracts/protocol.js";
import type { Digest } from "../types/distributed.js";
import { byteDigest, canonicalize } from "./canonical.js";

export type StreamDataFramePayload = Exclude<
  StreamFrame["payload"],
  { readonly kind: "provisional-final" }
>;

export type StreamFrameMeta = StreamFrame["meta"];

/** Canonical stream-chain implementation shared by producers and replay validators. */
export class StreamDigestChain {
  readonly #assignmentId: string;
  #head: Digest;
  #dataFrames = 0;

  constructor(assignmentId: string) {
    this.#assignmentId = assignmentId;
    this.#head = byteDigest(
      Buffer.concat([
        Buffer.from("zhixing:stream:v1", "utf8"),
        Buffer.from(assignmentId, "utf8"),
      ]),
    );
  }

  append(payload: StreamDataFramePayload, meta: StreamFrameMeta = {}): number {
    const seq = this.#dataFrames + 1;
    this.#head = byteDigest(
      Buffer.concat([
        Buffer.from(this.#head.slice("sha256:".length), "hex"),
        Buffer.from(canonicalize({ seq, payload, meta }), "utf8"),
      ]),
    );
    this.#dataFrames = seq;
    return seq;
  }

  final(): { readonly finalSeq: number; readonly streamDigest: Digest } {
    return {
      finalSeq: this.#dataFrames + 1,
      streamDigest: this.#head,
    };
  }

  get assignmentId(): string {
    return this.#assignmentId;
  }
}
