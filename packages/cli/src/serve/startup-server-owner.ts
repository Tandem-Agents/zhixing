import { resolvePlatformProcessStartTime } from '../platform/secret-platform.js';
import type { StopEndpointLock } from "@zhixing/core/protocol";
import { isProcessAlive, resolveProcessStartTime, type BoundZhixingServer } from "@zhixing/server";

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

/** A released listener proves no process exit. Only OS liveness or birth
 * identity may establish that this PID no longer denotes the old host. */
export async function endpointProcessMayBeOldHost(
  _owner: Pick<BoundZhixingServer, "ownsEndpoint">,
  oldEndpoint: StopEndpointLock,
  probes: {
    readonly alive?: (pid: number) => boolean;
    readonly startTime?: (pid: number) => Promise<number | null>;
    readonly platform?: NodeJS.Platform;
  } = {},
): Promise<boolean> {
  if (!(probes.alive ?? isProcessAlive)(oldEndpoint.pid)) return false;
  const live = await (probes.startTime ?? (pid => resolvePlatformProcessStartTime(pid, resolveProcessStartTime)))(oldEndpoint.pid);
  if (live === null) return true;
  if (oldEndpoint.startTime !== null) return live === oldEndpoint.startTime;
  // Older Windows records have no birth field. A process born strictly after
  // the old host recorded its generation cannot be that host; all other cases
  // remain unresolved until actual exit. Windows start times are Unix ms.
  if ((probes.platform ?? process.platform) === 'win32') {
    const recorded = Date.parse(oldEndpoint.startedAt);
    if (Number.isFinite(recorded) && live > recorded) return false;
  }
  return true;
}
