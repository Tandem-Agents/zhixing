import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type { ArtifactStore } from "../authority/interfaces.js";
import {
  MAX_INLINE_INTERACTION_DISPLAY_BYTES,
  type ArtifactRef,
} from "../contracts/index.js";
import { canonicalize } from "./canonical.js";
import {
  materializeInteractionDisplay,
  prepareInteractionDisplay,
  validateInteractionDisplay,
} from "./interaction-display.js";

class MemoryArtifacts implements ArtifactStore {
  readonly blobs = new Map<string, Uint8Array>();

  async put(bytes: Uint8Array): Promise<ArtifactRef> {
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
    this.blobs.set(digest, Uint8Array.from(bytes));
    return { digest, bytes: bytes.byteLength };
  }

  async get(ref: ArtifactRef): Promise<Uint8Array> {
    const bytes = this.blobs.get(ref.digest);
    if (!bytes) throw new Error(`missing artifact ${ref.digest}`);
    return Uint8Array.from(bytes);
  }

  async putVerifiedStream(
    ref: ArtifactRef,
    chunks: AsyncIterable<Uint8Array>,
  ): Promise<void> {
    const values: Uint8Array[] = [];
    for await (const chunk of chunks) values.push(chunk);
    const stored = await this.put(Buffer.concat(values));
    if (stored.digest !== ref.digest || stored.bytes !== ref.bytes) {
      this.blobs.delete(stored.digest);
      throw new TypeError("Artifact stream does not match its reference");
    }
  }

  async readRange(ref: ArtifactRef, offset: number, limit: number): Promise<Uint8Array> {
    return (await this.get(ref)).slice(offset, offset + limit);
  }

  async has(ref: ArtifactRef): Promise<boolean> {
    return this.blobs.has(ref.digest);
  }
}

describe("prepareInteractionDisplay", () => {
  it("freezes the exact 8 KiB boundary inline and externalizes boundary plus one", async () => {
    const artifacts = new MemoryArtifacts();
    const empty = { title: "T", lines: [""] };
    const overhead = Buffer.byteLength(canonicalize(empty), "utf8");
    const exact = { title: "T", lines: ["x".repeat(MAX_INLINE_INTERACTION_DISPLAY_BYTES - overhead)] };
    const oversized = { title: "T", lines: [`${exact.lines[0]}x`] };
    expect(Buffer.byteLength(canonicalize(exact), "utf8")).toBe(
      MAX_INLINE_INTERACTION_DISPLAY_BYTES,
    );
    expect(Buffer.byteLength(canonicalize(oversized), "utf8")).toBe(
      MAX_INLINE_INTERACTION_DISPLAY_BYTES + 1,
    );

    const inline = await prepareInteractionDisplay(exact, artifacts);
    const external = await prepareInteractionDisplay(oversized, artifacts);

    expect(inline).toEqual({ display: exact, references: [] });
    expect(external.display).toEqual({ ref: external.references[0] });
    expect(external.references).toHaveLength(1);
    expect(await artifacts.has(external.references[0]!)).toBe(true);
    expect(
      Buffer.from(await artifacts.get(external.references[0]!)).toString("utf8"),
    ).toBe(canonicalize(oversized));
  });

  it("fails closed when an externalized display artifact is absent", async () => {
    const artifacts = new MemoryArtifacts();
    const prepared = await prepareInteractionDisplay(
      { title: "T", lines: ["x".repeat(MAX_INLINE_INTERACTION_DISPLAY_BYTES)] },
      artifacts,
    );
    if (!("ref" in prepared.display)) throw new Error("expected externalized display");
    artifacts.blobs.delete(prepared.display.ref.digest);

    await expect(
      materializeInteractionDisplay(prepared.display, artifacts),
    ).rejects.toThrow("missing artifact");
  });

  it("materializes only canonical oversized display artifacts", async () => {
    const artifacts = new MemoryArtifacts();
    const oversized = {
      title: "T",
      lines: ["界".repeat(MAX_INLINE_INTERACTION_DISPLAY_BYTES)],
    };
    const prepared = await prepareInteractionDisplay(oversized, artifacts);
    expect(await materializeInteractionDisplay(prepared.display, artifacts)).toEqual(
      oversized,
    );

    const short = { title: "T", lines: ["short"] };
    const shortRef = await artifacts.put(Buffer.from(canonicalize(short), "utf8"));
    await expect(
      materializeInteractionDisplay({ ref: shortRef }, artifacts),
    ).rejects.toThrow("must exceed the inline budget");

    const nonCanonical = Buffer.from(
      JSON.stringify({ title: oversized.title, lines: oversized.lines }),
      "utf8",
    );
    const nonCanonicalRef = await artifacts.put(nonCanonical);
    await expect(
      materializeInteractionDisplay({ ref: nonCanonicalRef }, artifacts),
    ).rejects.toThrow("not canonical JSON");
  });

  it("rejects representations that bypass the inline-or-ref normalization", () => {
    expect(() =>
      validateInteractionDisplay({
        title: "T",
        lines: ["x".repeat(MAX_INLINE_INTERACTION_DISPLAY_BYTES)],
      }),
    ).toThrow("must be externalized");
    expect(() =>
      validateInteractionDisplay({
        ref: { digest: `sha256:${"a".repeat(64)}`, bytes: 9, extra: true },
      }),
    ).toThrow("unknown or missing fields");
  });
});
