import { join } from "node:path";
import { FileResumableArtifactReceiver, type ArtifactStore } from "@zhixing/core/authority";
import type { ExtensionArtifactReceiverPort } from "./extension-management-mesh.js";

/** Physical staging stays at the Host infrastructure edge, outside Mesh routing. */
export function createExtensionArtifactReceiver(input: {
  readonly home: string;
  readonly artifacts: ArtifactStore;
}): ExtensionArtifactReceiverPort {
  const receiver = new FileResumableArtifactReceiver(input.artifacts,
    join(input.home, "extensions", "transfers"), { maxArtifactBytes: 24 * 1024 * 1024 });
  return Object.freeze<ExtensionArtifactReceiverPort>({
    progress: (ref) => receiver.progress(ref),
    append: (ref, offset, bytes) => receiver.append(ref, offset, bytes),
  });
}
