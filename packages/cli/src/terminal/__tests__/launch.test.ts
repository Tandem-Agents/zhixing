import { beforeEach, describe, expect, it, vi } from 'vitest';
const ports = vi.hoisted(() => ({ run: vi.fn(), record: vi.fn() }));
vi.mock('../supervisor.js', () => ({ runTerminalSupervisor: ports.run }));
vi.mock('../../logging/bootstrap.js', () => ({ beginEntryLogging: () => ({ records: { record: ports.record } }) }));
vi.mock('../../logging/runtime.js', () => ({ beginRuntimeLogging: vi.fn(), recordRuntimeFailure: vi.fn() }));
import { launchTerminal } from '../launch.js';
describe('foreground exit feedback after terminal restoration', () => {
  beforeEach(() => vi.resetAllMocks());
  it.each([71, 74, 75, 78])('prints an explanation when the supervisor returns failure %s instead of throwing', async code => {
    const output = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      ports.run.mockResolvedValue(code);
      expect(await launchTerminal([])).toBe(code);
      expect(output).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(`退出码 ${code}`));
      expect(output.mock.calls[0]![0]).toContain('zz logs');
    } finally { output.mockRestore(); }
  });
  it.each([0, 130])('does not label ordinary exit/cancellation %s as a failure', async code => {
    const output = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try { ports.run.mockResolvedValue(code); expect(await launchTerminal([])).toBe(code); expect(output).not.toHaveBeenCalled(); }
    finally { output.mockRestore(); }
  });
});
