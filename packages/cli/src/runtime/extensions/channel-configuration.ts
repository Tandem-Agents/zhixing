import { createHash, randomUUID } from "node:crypto";
import type { SecretStorePort } from "@zhixing/core/contracts";
import type { ExtensionBinding, ExtensionInstance, ExtensionManifest } from "@zhixing/core/extensions/contracts";
import type { ChannelConfig } from "@zhixing/core/channels";
import { channelDeclaration, validateChannelCredentials } from "@zhixing/core/channels/extension";
import { canonicalize } from "@zhixing/core/protocol";
import { loadConfig, loadCredentialSnapshot, type CredentialStoreCoordinator, type ZhixingConfig, type ChannelCredentialProjection } from "@zhixing/providers";

export interface ChannelProjection { readonly id: string; readonly config: ChannelConfig }
interface ConfigurationPublication {
  readonly revision: string;
  readonly entry: NonNullable<ZhixingConfig["messaging"]>[string] | null;
  readonly credentials: Readonly<Record<string, string>>;
  readonly intent?: { readonly enabled: boolean; readonly expectedIntentRevision: number };
}

/** Local immutable projections survive partial source writes, never enter Authority or a Run. */
export class ChannelConfiguration {
  constructor(private readonly configPath: string, private readonly secrets: SecretStorePort & CredentialStoreCoordinator) {}
  secretPort(): SecretStorePort & CredentialStoreCoordinator { return this.secrets; }

  entries() { return loadConfig({ configPath: this.configPath }).messaging ?? {}; }

  async pending(id: string): Promise<boolean> {
    return Boolean(await this.secrets.get({ kind: "channel", bindingId: `extension-edits/${id}` }));
  }

  /** Source publication, not activation: both sources must match before consumption. */
  async stage(ids: readonly string[], config: ZhixingConfig, credentials: ChannelCredentialProjection,
    states: Readonly<Record<string, { intentRevision: number }>>, intents: Readonly<Record<string, boolean>> = {}): Promise<void> {
    await this.secrets.runExclusive(async () => {
      for (const id of ids) {
        const encoded = await this.secrets.get({ kind: "channel", bindingId: `extension-edits/${id}` });
        const previous = encoded ? JSON.parse(encoded) as ConfigurationPublication : undefined;
        const inheritedIntent = previous?.intent?.expectedIntentRevision === (states[id]?.intentRevision ?? 0)
          ? previous.intent : undefined;
        const publication: ConfigurationPublication = { revision: randomUUID(), entry: config.messaging?.[id] ?? null,
          credentials: credentials.channels?.[id] ?? {},
          ...(intents[id] === undefined ? (inheritedIntent ? { intent: inheritedIntent } : {})
            : { intent: { enabled: intents[id]!, expectedIntentRevision: states[id]?.intentRevision ?? 0 } }) };
        await this.secrets.put({ kind: "channel", bindingId: `extension-edits/${id}` }, JSON.stringify(publication));
      }
    });
  }

  async publication(id: string): Promise<ConfigurationPublication | undefined> {
    const encoded = await this.secrets.get({ kind: "channel", bindingId: `extension-edits/${id}` });
    if (!encoded) return undefined;
    const publication = JSON.parse(encoded) as ConfigurationPublication;
    const snapshot = await loadCredentialSnapshot({ store: this.secrets });
    if (canonicalize(this.entries()[id] ?? null) !== canonicalize(publication.entry) ||
        canonicalize(snapshot.credentials.channels?.[id] ?? {}) !== canonicalize(publication.credentials)) {
      throw new Error("配置与凭据尚未完整保存，旧连接绑定保持不变");
    }
    return publication;
  }

  async requestedEnabled(id: string, current?: ExtensionInstance, sourceRevision?: string): Promise<boolean | undefined> {
    const publication = await this.publication(id);
    if (publication && sourceRevision !== undefined && publication.revision !== sourceRevision) throw new Error("配置发布在准备期间已变更");
    if (!publication?.intent || current?.binding.sourceRevision === publication.revision) return undefined;
    if ((current?.intentRevision ?? 0) !== publication.intent.expectedIntentRevision) {
      await this.acknowledge(id, publication.revision);
      throw new Error("连接状态在编辑期间已变更，未覆盖；请重新打开配置面板");
    }
    return publication.intent.enabled;
  }

  async acknowledge(id: string, revision: string | undefined): Promise<void> {
    if (!revision) return;
    await this.secrets.runExclusive(async () => {
      const ref = { kind: "channel" as const, bindingId: `extension-edits/${id}` };
      const encoded = await this.secrets.get(ref);
      if (encoded && (JSON.parse(encoded) as ConfigurationPublication).revision === revision) await this.secrets.delete(ref);
    });
  }

  async prepare(id: string, manifest: ExtensionManifest, current?: ExtensionInstance, requirePublication = false): Promise<ExtensionBinding> {
    const publication = await this.publication(id);
    const before = this.entries()[id];
    if (!before || (before.type ?? id) !== manifest.id) throw new Error("Channel configuration does not match artifact");
    const snapshot = await loadCredentialSnapshot({ store: this.secrets });
    if (canonicalize(before) !== canonicalize(this.entries()[id] ?? null)) throw new Error("Channel configuration changed while reading credentials");
    const credentials = snapshot.credentials.channels?.[id] ?? {};
    if (publication && (canonicalize(before) !== canonicalize(publication.entry) || canonicalize(credentials) !== canonicalize(publication.credentials))) {
      throw new Error("配置发布在准备期间已变更");
    }
    const declaration = channelDeclaration(manifest);
    validateChannelCredentials(declaration, credentials);
    const projected = Object.fromEntries(declaration.requiredFields.flatMap((field) => credentials[field.id] === undefined ? [] : [[field.id, credentials[field.id]!]]));
    const projection: ChannelProjection = { id, config: { type: manifest.id, enabled: true, credentials: projected,
      ...(before.options ? { options: before.options } : {}),
      ...(before.defaultTarget ? { defaultTarget: { channelId: id, to: before.defaultTarget.to } } : {}),
    } };
    if (current) {
      const previous = await this.read(current).catch(() => undefined);
      if (current.binding.manifest.digest === manifest.digest && previous && canonicalize(previous) === canonicalize(projection) &&
          (!publication || current.binding.sourceRevision === publication.revision)) return current.binding;
      if (requirePublication && !publication) throw new Error("来源已变化但缺少完整配置发布，请在配置入口确认应用；旧绑定保持不变");
    }
    const projectionRevision = randomUUID();
    await this.secrets.put({ kind: "channel", bindingId: `extension-projections/${id}/${projectionRevision}` }, JSON.stringify(projection));
    const publicFields = Object.fromEntries(declaration.requiredFields.filter((field) => !field.sensitive).map((field) => [field.id, projected[field.id] ?? ""]));
    return { manifest, configurationRevision: createHash("sha256").update(canonicalize({ entry: before, publicFields })).digest("hex"),
      exclusiveKey: createHash("sha256").update(canonicalize({ type: manifest.type, adapter: manifest.id,
        identity: Object.fromEntries(declaration.identityFields.map((field) => [field, projected[field]])) })).digest("hex"),
      projectionRevision,
      ...(publication ? { sourceRevision: publication.revision } : {}) };
  }

  async read(instance: ExtensionInstance): Promise<ChannelProjection> {
    const ref = { kind: "channel" as const, bindingId: `extension-projections/${instance.id}/${instance.binding.projectionRevision}` };
    let encoded = await this.secrets.get(ref);
    if (!encoded) {
      // After duty transfer only local credentials may materialize a projection.
      // Public account identity and configuration must match the committed binding.
      const local = await this.prepare(instance.id, instance.binding.manifest);
      const localRef = { kind: "channel" as const, bindingId: `extension-projections/${instance.id}/${local.projectionRevision}` };
      try {
        if (local.configurationRevision !== instance.binding.configurationRevision) throw new Error("Local Channel account/configuration does not match the committed instance");
        encoded = await this.secrets.get(localRef);
        if (!encoded) throw new Error("Local extension projection is not ready");
        await this.secrets.put(ref, encoded);
      } finally { await this.secrets.delete(localRef); }
    }
    const projection = JSON.parse(encoded) as ChannelProjection;
    if (projection.id !== instance.id || projection.config.type !== instance.binding.manifest.id) throw new Error("Local extension projection mismatch");
    validateChannelCredentials(channelDeclaration(instance.binding.manifest), projection.config.credentials);
    return projection;
  }

  /** Reuse the committed local projection, never resolve floating credentials. */
  async replacement(instance: ExtensionInstance, manifest: ExtensionManifest): Promise<ExtensionBinding> {
    const projection = await this.read(instance);
    validateChannelCredentials(channelDeclaration(manifest), projection.config.credentials);
    if (manifest.id !== instance.binding.manifest.id) throw new Error("换版不能更换连接身份");
    return { ...instance.binding, manifest };
  }

  async discard(id: string, binding: ExtensionBinding): Promise<void> {
    await this.secrets.delete({ kind: "channel", bindingId: `extension-projections/${id}/${binding.projectionRevision}` });
  }
}
