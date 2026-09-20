import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuthorityCommitLog } from "@zhixing/core/authority";
import { ExtensionApplication } from "@zhixing/core/extensions/application";
import { ExtensionArtifacts } from "@zhixing/core/extensions/artifacts";
import { canonicalize } from "@zhixing/core/protocol";
import type { ChannelConfiguration } from "./channel-configuration.js";
import { packagedExtensions } from "./catalog.js";

/** Fails before a readiness proof when pinned code or local account material is missing. */
export function createChannelExtensionReadiness(configuration: ChannelConfiguration, artifactDirectory: string) {
  return async (log: AuthorityCommitLog): Promise<{ channels: readonly string[]; revision: string }> => {
    const artifacts = new ExtensionArtifacts(artifactDirectory);
    const seeds = packagedExtensions();
    const application = new ExtensionApplication({ log: () => log, assertOwner: () => { throw new Error("Readiness cannot change extension intent"); } });
    const instances = (await application.list()).instances;
    const ready: { id: string; digest: string; configuration: string }[] = [];
    for (const instance of instances) {
      if (!instance.enabled || instance.binding.manifest.type !== "channel") continue;
      try { await artifacts.resolve(instance.binding.manifest); }
      catch {
        const seed = seeds.find(({ manifest }) => manifest.digest === instance.binding.manifest.digest);
        if (!seed) throw new Error(`Extension artifact is not ready: ${instance.id}`);
        await artifacts.import(seed.manifest, await readFile(join(seed.directory, seed.manifest.entry)));
      }
      await configuration.read(instance);
      ready.push({ id: instance.id, digest: instance.binding.manifest.digest, configuration: instance.binding.configurationRevision });
    }
    for (const [id, entry] of Object.entries(configuration.entries())) {
      if (instances.some((instance) => instance.id === id)) continue;
      const seed = seeds.find(({ manifest }) => manifest.type === "channel" && manifest.id === (entry.type ?? id));
      if (!seed) throw new Error(`Channel migration artifact is not ready: ${id}`);
      await artifacts.import(seed.manifest, await readFile(join(seed.directory, seed.manifest.entry)));
      const binding = await configuration.prepare(id, seed.manifest);
      try { ready.push({ id, digest: binding.manifest.digest, configuration: binding.configurationRevision }); }
      finally { await configuration.discard(id, binding); }
    }
    ready.sort((left, right) => left.id.localeCompare(right.id, "en-US"));
    return { channels: ready.map(({ id }) => id), revision: createHash("sha256").update(canonicalize(ready)).digest("hex") };
  };
}
