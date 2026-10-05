import { randomUUID } from 'node:crypto';
import type { DeviceCapacityArbiterPort, DeviceCapacityBudget, DeviceCapacityStepPermit } from '@zhixing/core/resources';
import { checkpointFilesystemCompletion } from '@zhixing/mesh/filesystem';

/** Capacity covers one completed physical operation; retained pages belong to
 * the terminal root's separate durable byte account, never to this permit. */
export async function terminalPhysicalStep<T>(
  capacity: DeviceCapacityArbiterPort,
  bound: DeviceCapacityBudget,
  signal: AbortSignal,
  operation: (step: DeviceCapacityStepPermit) => Promise<T>,
  recovery = false,
): Promise<T> {
  const admission = await capacity.acquire({ admissionId: `terminal-${randomUUID()}`, serviceClass: recovery ? 'storage-recovery' : 'storage-foreground', atomic: bound, preferred: bound, maxWaitMs: 1000 }, signal);
  if (admission.kind !== 'granted') throw Error(`terminal-capacity-${admission.kind}`);
  const permit = admission.permit;
  const step = permit.tryBegin(bound);
  if (!step) { permit.release(); throw Error('terminal-physical-step-unavailable'); }
  let deferred = false;
  const release = () => { step.complete(); permit.release(); };
  try { signal.throwIfAborted(); return await operation(step); }
  catch (error) {
    const completion = checkpointFilesystemCompletion(error);
    if (completion) {
      deferred = true;
      // Report the failure to the existing close owner immediately. Timeout
      // cannot return another operation the still-running helper's allowance.
      void completion.then(release);
    }
    throw error;
  } finally { if (!deferred) release(); }
}

export const terminalMetadataStep: DeviceCapacityBudget = Object.freeze({
  occupancy: { memoryReservationBytes: 2 * 1024 * 1024, temporaryBytes: 128 * 1024, slots: 1 },
  quantum: { readBytes: 2 * 1024 * 1024, writeBytes: 128 * 1024, ioOperations: 4096 },
});
