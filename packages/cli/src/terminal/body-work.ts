import type { DeviceCapacityArbiterPort, DeviceCapacityBudget } from '@zhixing/core/resources';
import { BODY_PROJECTION_WORK_BYTES } from '@zhixing/terminal-ui/body-model';
import { terminalPhysicalStep } from './physical-step.js';

const budget: DeviceCapacityBudget = {
  occupancy: { memoryReservationBytes: BODY_PROJECTION_WORK_BYTES, temporaryBytes: 0, slots: 1 },
  quantum: { readBytes: 0, writeBytes: 0, ioOperations: 0 },
};

/** Live parsing and cold history share one workspace, including the complete
 * parser → amend/append → publication operation, not one free buffer per block. */
export class TerminalBodyWork {
  #tail = Promise.resolve(); #pending = 0;
  constructor(readonly capacity: DeviceCapacityArbiterPort, readonly signal: AbortSignal) {}
  run<T>(action: () => Promise<T>): Promise<T> {
    if (this.#pending >= 4) return Promise.reject(Error('terminal-body-work-capacity'));
    this.#pending++;
    const work = this.#tail.then(() => terminalPhysicalStep(this.capacity, budget, this.signal, action))
      .finally(() => { this.#pending--; });
    this.#tail = work.then(() => {}, () => {}); return work;
  }
}
