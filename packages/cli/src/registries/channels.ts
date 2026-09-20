import { channelDeclaration, type ChannelField } from "@zhixing/core/channels/extension";
import { packagedExtensions } from "../runtime/extensions/catalog.js";

export type ChannelFieldSpec = ChannelField;
export interface SupportedChannel {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly requiredFields: readonly ChannelFieldSpec[];
}

/** UI fields are a projection of validated type declarations, not a platform registry. */
export function listSupportedChannels(): readonly SupportedChannel[] {
  return packagedExtensions().filter(({ manifest }) => manifest.type === "channel").map(({ manifest }) => {
    const declaration = channelDeclaration(manifest);
    return { id: manifest.id, label: declaration.label, description: declaration.description, requiredFields: declaration.requiredFields };
  });
}
