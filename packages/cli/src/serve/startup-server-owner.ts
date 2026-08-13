import type { StopEndpointLock } from "@zhixing/core/protocol";
import type { BoundZhixingServer } from "@zhixing/server";

/**
 * Proves that a live PID at an old endpoint is this process reusing the exact
 * home endpoint it already owns. A PID match without the same bound port is
 * never a successor proof.
 */
export function ownsCurrentSuccessorEndpoint(
  owner: Pick<BoundZhixingServer, "ownsEndpoint">,
  oldEndpoint: StopEndpointLock,
  currentEndpoint: StopEndpointLock,
  currentPid: number = process.pid,
): boolean {
  return oldEndpoint.pid === currentPid &&
    currentEndpoint.pid === currentPid &&
    oldEndpoint.port === currentEndpoint.port &&
    owner.ownsEndpoint(currentEndpoint.port);
}
