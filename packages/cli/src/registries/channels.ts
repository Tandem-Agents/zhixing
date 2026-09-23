import { channelDeclaration, type ChannelField } from "@zhixing/core/channels/extension";
import { packagedExtensions } from "../runtime/extensions/catalog.js";
import type { ExtensionPublicSnapshot, ExtensionManifest } from "@zhixing/core/extensions/contracts";

export type ChannelFieldSpec = ChannelField;
export interface SupportedChannel {
  readonly id: string;
  readonly instanceId?: string;
  readonly label: string;
  readonly description?: string;
  readonly requiredFields: readonly ChannelFieldSpec[];
}

/** UI fields are a projection of validated type declarations, not a platform registry. */
export function listSupportedChannels(snapshot?: ExtensionPublicSnapshot): readonly SupportedChannel[] {
  const definitions: { manifest: ExtensionManifest; instanceId?: string }[] = packagedExtensions().map(({ manifest }) => ({ manifest }));
  const bound = new Map((snapshot?.instances ?? []).map(instance => [instance.id, instance.binding.manifest]));
  for (const operation of snapshot?.operations ?? []) {
    if (operation.candidate && ["configuration", "verifying"].includes(operation.phase) && !bound.has(operation.instanceId)) bound.set(operation.instanceId, operation.candidate);
  }
  for (const [instanceId, manifest] of bound) definitions.push({ instanceId, manifest });
  return definitions.filter(({ manifest }) => manifest.type === "channel").map(({ manifest, instanceId }) => {
    const declaration = channelDeclaration(manifest);
    return { id: manifest.id, ...(instanceId ? { instanceId } : {}), label: declaration.label, description: declaration.description, requiredFields: declaration.requiredFields };
  });
}

/** Bound instances never borrow the fields or sensitivity of another version. */
export function findSupportedChannel(catalog: readonly SupportedChannel[], instanceId: string, type = instanceId): SupportedChannel | undefined {
  return catalog.find(channel => channel.instanceId === instanceId) ?? catalog.find(channel => !channel.instanceId && channel.id === type);
}
