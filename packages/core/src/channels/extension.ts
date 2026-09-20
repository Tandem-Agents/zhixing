import type { ChannelBindingPolicy, ChannelCapabilities } from "./types.js";
import type { ExtensionBinding, ExtensionManifest } from "../extensions/contracts.js";

export interface ChannelField {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly example: string;
  readonly sensitive: boolean;
  readonly capabilityGroup?: string;
  readonly docUrl?: string;
}
export interface ChannelDeclaration {
  readonly label: string;
  readonly description?: string;
  readonly requiredFields: readonly ChannelField[];
  readonly identityFields: readonly string[];
  readonly capabilities: ChannelCapabilities;
  readonly bindingPolicy?: ChannelBindingPolicy;
}

export function channelDeclaration(manifest: ExtensionManifest): ChannelDeclaration {
  if (manifest.type !== "channel" || manifest.contract !== 1) throw new TypeError("Unsupported Channel contract");
  const d = manifest.declaration as ChannelDeclaration | undefined;
  if (!d || typeof d.label !== "string" || !Array.isArray(d.requiredFields) || !d.capabilities ||
      !Array.isArray(d.capabilities.chatTypes) ||
      d.capabilities.chatTypes.some((type) => !["dm", "group", "thread"].includes(type)) ||
      [d.capabilities.media, d.capabilities.edit, d.capabilities.streaming].some((value) => typeof value !== "boolean") ||
      (d.bindingPolicy !== undefined && !["per-group", "per-user-in-group"].includes(d.bindingPolicy?.group))) {
    throw new TypeError("Invalid Channel declaration");
  }
  const ids = new Set<string>();
  for (const field of d.requiredFields) {
    if (!field || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(field.id) || ids.has(field.id) ||
        [field.label, field.hint, field.example].some((value) => typeof value !== "string") ||
        typeof field.sensitive !== "boolean" ||
        (field.capabilityGroup !== undefined && typeof field.capabilityGroup !== "string") ||
        (field.docUrl !== undefined && !/^https:\/\//.test(field.docUrl))) {
      throw new TypeError("Invalid Channel field declaration");
    }
    ids.add(field.id);
  }
  if (!Array.isArray(d.identityFields) || !d.identityFields.length ||
      new Set(d.identityFields).size !== d.identityFields.length ||
      d.identityFields.some((id) => !d.requiredFields.some((field) => field.id === id && !field.sensitive && !field.capabilityGroup))) {
    throw new TypeError("Channel requires public account identity fields");
  }
  return structuredClone(d);
}

export function validateChannelCredentials(declaration: ChannelDeclaration, credentials: Readonly<Record<string, string>>): void {
  const groups = new Set(declaration.requiredFields.filter((field) => field.capabilityGroup && credentials[field.id]).map((field) => field.capabilityGroup));
  for (const field of declaration.requiredFields) {
    if (field.capabilityGroup && !groups.has(field.capabilityGroup)) continue;
    if (typeof credentials[field.id] !== "string" || !credentials[field.id]) throw new Error(`Missing Channel field: ${field.id}`);
  }
}

/** Channel owns compatibility; the shared lifecycle has no platform semantics. */
export function validateChannelReplacement(previous: ExtensionBinding, binding: ExtensionBinding, purpose: "update" | "repair"): void {
  const old = channelDeclaration(previous.manifest);
  const next = channelDeclaration(binding.manifest);
  const sameSet = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every(value => right.includes(value));
  if (previous.manifest.id !== binding.manifest.id || previous.exclusiveKey !== binding.exclusiveKey ||
      (old.bindingPolicy?.group ?? "per-group") !== (next.bindingPolicy?.group ?? "per-group") ||
      !sameSet(old.identityFields, next.identityFields) ||
      old.requiredFields.some(field => !next.requiredFields.some(item => item.id === field.id && item.sensitive === field.sensitive && item.capabilityGroup === field.capabilityGroup)) ||
      old.capabilities.chatTypes.some(type => !next.capabilities.chatTypes.includes(type)) ||
      (["media", "edit", "streaming"] as const).some(key => old.capabilities[key] && !next.capabilities[key]) ||
      (purpose === "repair" && (!sameSet(old.capabilities.chatTypes, next.capabilities.chatTypes) ||
        (["media", "edit", "streaming"] as const).some(key => old.capabilities[key] !== next.capabilities[key]) ||
        old.requiredFields.length !== next.requiredFields.length))) throw new Error("候选改变账号、权限声明或既有能力，未切换原连接");
}
