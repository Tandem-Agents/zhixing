import { createHash } from "node:crypto";
import type { StreamFrame } from "../contracts/protocol.js";
import type { Digest } from "../types/distributed.js";
import { canonicalize } from "./canonical.js";

export type StreamDataFramePayload = Exclude<
  StreamFrame["payload"],
  { readonly kind: "provisional-final" }
>;

export type StreamFrameMeta = StreamFrame["meta"];

/** Canonical stream-chain implementation shared by producers and replay validators. */
export class StreamDigestChain {
  readonly #assignmentId: string;
  #head: Buffer;
  #dataFrames = 0;

  constructor(assignmentId: string) {
    this.#assignmentId = assignmentId;
    this.#head = createHash("sha256")
      .update(Buffer.from("zhixing:stream:v1", "utf8"))
      .update(Buffer.from(assignmentId, "utf8"))
      .digest();
  }

  append(payload: StreamDataFramePayload, meta: StreamFrameMeta = {}): number {
    const seq = this.#dataFrames + 1;
    this.#head = createHash("sha256")
      .update(this.#head)
      .update(Buffer.from(canonicalize({ seq, payload, meta }), "utf8"))
      .digest();
    this.#dataFrames = seq;
    return seq;
  }

  final(): { readonly finalSeq: number; readonly streamDigest: Digest } {
    return {
      finalSeq: this.#dataFrames + 1,
      streamDigest: `sha256:${this.#head.toString("hex")}` as Digest,
    };
  }

  get assignmentId(): string {
    return this.#assignmentId;
  }
}
