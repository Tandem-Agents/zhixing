import { readPlatformProcessBirth, type PlatformProcessBirth } from '../platform/secret-platform.js';
import type { StopEndpointLock } from "@zhixing/core/protocol";
import { isProcessAlive, resolveProcessStartTime } from "@zhixing/server/client";
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

/** A released listener proves no process exit. Only OS liveness or birth
 * identity may establish that this PID no longer denotes the old host. */
export async function endpointProcessMayBeOldHost(
  _owner: Pick<BoundZhixingServer, "ownsEndpoint">,
  oldEndpoint: StopEndpointLock,
  probes: RecordedHostProbes = {},
): Promise<boolean> {
  return recordedHostMayBeAlive(oldEndpoint, probes);
}

export interface RecordedHostProbes {
    readonly alive?: (pid: number) => boolean;
    readonly startTime?: (pid: number) => Promise<number | null>;
    readonly birth?: (pid: number) => Promise<PlatformProcessBirth>;
    readonly platform?: NodeJS.Platform;
}

/** Marker removal and listener replacement are not OS exit proofs. */
export async function recordedHostMayBeAlive(
  oldEndpoint: StopEndpointLock,
  probes: RecordedHostProbes = {},
): Promise<boolean> {
  const alive = probes.alive ?? isProcessAlive;
  const birth = probes.birth ? await probes.birth(oldEndpoint.pid)
    : probes.startTime ? await readPlatformProcessBirth(oldEndpoint.pid, probes.startTime, null, alive)
    : await readPlatformProcessBirth(oldEndpoint.pid, resolveProcessStartTime, undefined, alive);
  // Windows kill(0) may report ESRCH while the old process handle is still
  // unsignaled. Native incarnation evidence therefore outranks that hint.
  if (birth.kind === 'absent') return false;
  if (birth.kind === 'unknown') return true;
  const live = birth.startTime;
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
