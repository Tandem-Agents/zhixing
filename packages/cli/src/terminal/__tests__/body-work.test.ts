import { expect, it } from 'vitest';
import type { DeviceCapacityArbiterPort } from '@zhixing/core/resources';
import { TerminalBodyWork } from '../body-work.js';

it('holds one accounted parser workspace through actual consumer acknowledgement and serializes cold/live users', async () => {
  let active = 0, peak = 0, acquired = 0, completed = 0;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const capacity: DeviceCapacityArbiterPort = { async acquire(request) {
    expect(request.atomic.occupancy.memoryReservationBytes).toBe(16 * 1024 * 1024);
    active++; acquired++; peak = Math.max(peak, active);
    return { kind: 'granted', permit: { granted: request.atomic,
      tryBegin: () => ({ claim: () => { throw Error('Parser workspace is not an I/O allowance'); }, complete: () => { completed++; } }),
      release: () => { active--; },
    } };
  } };
  const workspace = new TerminalBodyWork(capacity, new AbortController().signal);
  const live = workspace.run(async () => { entered(); await blocked; });
  await started;
  let coldRan = false;
  const cold = workspace.run(async () => { coldRan = true; });
  await Promise.resolve(); expect(coldRan).toBe(false); expect(active).toBe(1); expect(acquired).toBe(1);
  release(); await Promise.all([live, cold]);
  expect(peak).toBe(1); expect(completed).toBe(2); expect(active).toBe(0); expect(coldRan).toBe(true);
});
