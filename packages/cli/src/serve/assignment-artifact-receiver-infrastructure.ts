import path from "node:path";
import {
  FileResumableArtifactReceiver,
  type ArtifactStore,
} from "@zhixing/core/authority";
import {
  projectAssignmentArtifactReceiver,
  type AssignmentArtifactReceiverPort,
} from "./assignment-artifact-receiver.js";

const MAX_ASSIGNMENT_ARTIFACT_BYTES = 512 * 1024 * 1024;

/** The sole physical composition of the P09 assignment Mesh partial receiver. */
export function createAssignmentArtifactReceiverInfrastructure(options: Readonly<{
  zhixingHome: string;
  artifacts: ArtifactStore;
}>): AssignmentArtifactReceiverPort {
  return projectAssignmentArtifactReceiver(new FileResumableArtifactReceiver(
    options.artifacts,
    path.join(options.zhixingHome, "distributed-runtime", "mesh-artifact-partials"),
    { maxArtifactBytes: MAX_ASSIGNMENT_ARTIFACT_BYTES },
  ));
}
