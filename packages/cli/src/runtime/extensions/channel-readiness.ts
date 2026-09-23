import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuthorityCommitLog } from "@zhixing/core/authority";
import { ExtensionApplication } from "@zhixing/core/extensions/application";
import type { ExtensionManifest } from "@zhixing/core/extensions/contracts";
import { ExtensionArtifacts } from "@zhixing/core/extensions/artifacts";
import { ExtensionCandidates } from "@zhixing/core/extensions/candidate";
import { canonicalize } from "@zhixing/core/protocol";
import type { ChannelConfiguration } from "./channel-configuration.js";
import { packagedExtensions } from "./catalog.js";

/** Fails before a readiness proof when pinned code or local account material is missing. */
export function createChannelExtensionReadiness(configuration: ChannelConfiguration, artifactDirectory: string) {
  return async (log: AuthorityCommitLog): Promise<{ channels: readonly string[]; revision: string }> => {
    const artifacts = new ExtensionArtifacts(artifactDirectory);
    const seeds = packagedExtensions();
    const application = new ExtensionApplication({ log: () => log, assertOwner: () => { throw new Error("Readiness cannot change extension intent"); } });
    const { instances, operations } = await application.list();
    const ready: { id: string; digest: string; configuration: string }[] = [];
    const candidates = new ExtensionCandidates(join(artifactDirectory, "..", "candidates"));
    const ensureArtifact = async (manifest: ExtensionManifest) => {
      try { await artifacts.resolve(manifest); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const seed = seeds.find(item => item.manifest.digest === manifest.digest);
        if (!seed) throw new Error(`Extension artifact is not ready: ${manifest.id}`);
        await artifacts.import(manifest, await readFile(join(seed.directory, seed.manifest.entry)));
      }
    };
    // A handover can still fail after duty transfer. Its pinned rollback input
    // must be available before the destination is allowed to become owner.
    for (const operation of operations ?? []) {
      if (!operation.previous || ["ready", "cancelled"].includes(operation.phase)) continue;
      const instance = instances.find(item => item.id === operation.instanceId);
      if (!instance?.enabled) continue;
      if (!seeds.some(seed => seed.manifest.digest === operation.previous!.binding.manifest.digest)) await candidates.read(operation.previous.binding.manifest.digest);
      await ensureArtifact(operation.previous.binding.manifest);
      await configuration.read({ ...instance, binding: operation.previous.binding });
      ready.push({ id: `${instance.id}:rollback`, digest: operation.previous.binding.manifest.digest, configuration: operation.previous.binding.configurationRevision });
    }
    for (const instance of instances) {
      if (!instance.enabled || instance.binding.manifest.type !== "channel") continue;
      if (!seeds.some(seed => seed.manifest.digest === instance.binding.manifest.digest)) await candidates.read(instance.binding.manifest.digest);
      await ensureArtifact(instance.binding.manifest);
      await configuration.read(instance);
      ready.push({ id: instance.id, digest: instance.binding.manifest.digest, configuration: instance.binding.configurationRevision });
    }
    for (const operation of operations ?? []) {
      if (operation.phase !== "configuration" || !operation.candidate) continue;
      await candidates.read(operation.candidate.digest);
    }
    for (const [id, entry] of Object.entries(configuration.entries())) {
      if (instances.some((instance) => instance.id === id)) continue;
      if (operations?.some(operation => operation.instanceId === id)) continue;
      const seed = seeds.find(({ manifest }) => manifest.type === "channel" && manifest.id === (entry.type ?? id));
      if (!seed) throw new Error(`Channel migration artifact is not ready: ${id}`);
      await artifacts.import(seed.manifest, await readFile(join(seed.directory, seed.manifest.entry)));
      const binding = await configuration.prepare(id, seed.manifest);
      try { ready.push({ id, digest: binding.manifest.digest, configuration: binding.configurationRevision }); }
      finally { await configuration.discard(id, binding); }
    }
    ready.sort((left, right) => left.id.localeCompare(right.id, "en-US"));
    return { channels: ready.filter(({ id }) => !id.endsWith(":rollback")).map(({ id }) => id), revision: createHash("sha256").update(canonicalize(ready)).digest("hex") };
  };
}
