import type {
  HomeTrustRecord,
  WorkspaceProbeRequest,
  WorkspaceProbeResult,
} from "@zhixing/core/contracts";
import { createLiveTrustedDeviceProtocolVerifier } from "./trusted-device-protocol-verifier.js";
import { EnvironmentProbeMeshClient } from "./environment-probe-mesh.js";
import type { WorksceneRemoteWorkspaceProbePort } from "./workscene-directory.js";
import type { MeshConnectionRegistry } from "@zhixing/mesh/bootstrap";

type LiveMeshTopologyTrust = {
  current(): HomeTrustRecord;
};

/** Explicit single-machine implementation: remote workspace probing is unavailable. */
export const REJECT_REMOTE_WORKSPACE_PROBE: WorksceneRemoteWorkspaceProbePort =
  Object.freeze({
    async probe(): Promise<never> {
      throw new Error("目标设备当前不可达，无法确认工作区状态");
    },
  });

/**
 * Static Host topology adapter. Trust and connectivity remain live data while
 * the Workscene dependency graph is complete before the directory is exposed.
 */
export class MeshWorksceneRemoteWorkspaceProbe
  implements WorksceneRemoteWorkspaceProbePort {
  readonly #verifier;

  constructor(private readonly options: {
    readonly trust: LiveMeshTopologyTrust;
    readonly connections: Pick<MeshConnectionRegistry, "has" | "client">;
  }) {
    this.#verifier = createLiveTrustedDeviceProtocolVerifier((deviceId) =>
      this.options.trust.current().members.find((member) =>
        member.device.deviceId === deviceId
      )?.device
    );
  }

  async probe(
    deviceId: string,
    request: WorkspaceProbeRequest,
  ): Promise<WorkspaceProbeResult> {
    const target = this.options.trust.current().members.find((member) =>
      member.device.deviceId === deviceId
    );
    if (
      target?.state !== "active" ||
      !target.roles.includes("executor") ||
      !this.options.connections.has(deviceId)
    ) {
      throw new Error(`Workspace probe executor is unavailable: ${deviceId}`);
    }
    return new EnvironmentProbeMeshClient(
      this.options.connections.client(deviceId),
      this.#verifier,
    ).probe(request);
  }
}
