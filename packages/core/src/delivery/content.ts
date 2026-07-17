import type { ArtifactStore } from "../authority/index.js";
import type { ArtifactRef, DeliveryIntentDto } from "../contracts/index.js";
import type { OutboundContentDto } from "../channels/types.js";
import { collectArtifactRefs } from "../authority/artifact-references.js";
import {
  MAX_INLINE_DELIVERY_CONTENT_BYTES,
  canonicalOutboundContentDto,
  validateOutboundContentDto,
} from "./content-schema.js";

export class DeliveryContentValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeliveryContentValidationError";
  }
}

export interface CompiledDeliveryContent {
  readonly content: DeliveryIntentDto["content"];
  readonly references: readonly ArtifactRef[];
}

export async function compileDeliveryContent(
  input: string | OutboundContentDto | { readonly ref: ArtifactRef },
  artifacts: ArtifactStore,
): Promise<CompiledDeliveryContent> {
  if (typeof input === "string") {
    return storeWhenLarge({ text: input, markdown: input }, artifacts);
  }
  if ("ref" in input) {
    const bytes = await artifacts.get(input.ref);
    const text = Buffer.from(bytes).toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
      if (canonicalOutboundContentDto(parsed) !== text) {
        throw new TypeError("Delivery content artifact is not canonical JSON");
      }
    } catch (error) {
      throw new DeliveryContentValidationError(
        "Delivery content artifact is invalid",
        { cause: error },
      );
    }
    return {
      content: { ref: input.ref },
      references: [input.ref, ...collectArtifactRefs(parsed)],
    };
  }
  try {
    validateOutboundContentDto(input);
  } catch (error) {
    throw new DeliveryContentValidationError("Delivery content is invalid", {
      cause: error,
    });
  }
  return storeWhenLarge(input, artifacts);
}

async function storeWhenLarge(
  content: OutboundContentDto,
  artifacts: ArtifactStore,
): Promise<CompiledDeliveryContent> {
  let text: string;
  try {
    text = canonicalOutboundContentDto(content);
  } catch (error) {
    throw new DeliveryContentValidationError("Delivery content is invalid", {
      cause: error,
    });
  }
  const nested = collectArtifactRefs(content);
  if (Buffer.byteLength(text, "utf8") <= MAX_INLINE_DELIVERY_CONTENT_BYTES) {
    return { content, references: nested };
  }
  const ref = await artifacts.put(Buffer.from(text, "utf8"));
  return { content: { ref }, references: [ref, ...nested] };
}
