import { describe, expect, it, vi } from 'vitest';
import type { ManagedCommandPorts } from '../managed-command.js';
const mocks = vi.hoisted(() => ({ uninstall: vi.fn(async () => {}), remove: vi.fn(async () => {}) }));
vi.mock('../../runtime/anchor-uninstall-command.js', () => ({ uninstallCurrentDevice: mocks.uninstall }));
vi.mock('../../runtime/device-removal-command.js', () => ({ removeDevice: mocks.remove }));
import { runManagedCli, usesInteractiveTerminal } from '../../index.js';

describe('actual CLI registry terminal composition', () => {
  it('keeps metadata, unknown flags and complete plain commands on the original route', () => {
    expect(usesInteractiveTerminal(['pair'])).toBe(true);
    expect(usesInteractiveTerminal(['pair', '--help'])).toBe(false);
    expect(usesInteractiveTerminal(['pair', '--made-up'])).toBe(false);
    expect(usesInteractiveTerminal(['backup', 'status'])).toBe(false);
    expect(usesInteractiveTerminal(['backup', 'recover-finish', '--confirm-old-device-isolated'])).toBe(false);
    expect(usesInteractiveTerminal(['device', 'remove', '--current', '--permanent', '--confirm', '--duty-device', 'other-device'])).toBe(false);
    expect(usesInteractiveTerminal(['device', 'remove', '--current', '--permanent', '--confirm', '--recovery-backup'])).toBe(true);
    expect(usesInteractiveTerminal(['duty', 'migrate'])).toBe(true);
    expect(usesInteractiveTerminal(['duty', 'migrate', 'other-device'])).toBe(false);
    expect(usesInteractiveTerminal(['device', 'remove', 'other-device', '--permanent', '--mode', 'destroy', '--confirm'])).toBe(false);
  });
  it('returns the real success code without falling through current-device uninstall or closing borrowed logging', async () => {
    const finish = vi.fn(), prepare = vi.fn(async () => {}), write = vi.fn(), uninstallIO = {}, uninstall = {};
    const ports = { logging: { finish }, prepare, write, uninstallIO, uninstall } as unknown as ManagedCommandPorts;
    expect(await runManagedCli(['device', 'remove', '--current', '--permanent', '--confirm', '--recovery-backup'], ports)).toBe(0);
    expect(mocks.uninstall).toHaveBeenCalledWith({ recoveryBackup: true, confirmed: true }, uninstallIO, uninstall);
    expect(mocks.remove).not.toHaveBeenCalled(); expect(prepare).toHaveBeenCalledWith(true); expect(finish).not.toHaveBeenCalled();
  });
});
