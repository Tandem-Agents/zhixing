import { beforeEach, describe, expect, it, vi } from 'vitest';
const ports = vi.hoisted(() => ({ run: vi.fn(), record: vi.fn() }));
vi.mock('../supervisor.js', () => ({ runTerminalSupervisor: ports.run }));
vi.mock('../../logging/bootstrap.js', () => ({ beginEntryLogging: () => ({ records: { record: ports.record } }) }));
vi.mock('../../logging/runtime.js', () => ({ beginRuntimeLogging: vi.fn(), recordRuntimeFailure: vi.fn() }));
import { launchTerminal, terminalExitNotice } from '../launch.js';
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

describe('terminal exit notice', () => {
  it('explains a known startup refusal and keeps the log pointer for unknown causes', () => {
    expect(terminalExitNotice(71, 'terminal-original-modes-unavailable')).toBe(
      '这个终端窗口的显示模式与知行不兼容（常见于其他程序或上次异常结束留下的状态），知行无法在这里启动；请新开一个终端窗口后再运行 zz。（退出码 71）\n');
    expect(terminalExitNotice(71, 'terminal-mode-query-failed')).toBe('知行终端意外结束（退出码 71）；请用 zz logs 查看此次记录。\n');
    expect(terminalExitNotice(70, undefined)).toBe('知行终端意外结束（退出码 70）；请用 zz logs 查看此次记录。\n');
    expect(terminalExitNotice(0, 'user-exit')).toBeUndefined();
    expect(terminalExitNotice(130, 'user-interrupt')).toBeUndefined();
    // 独立命令自己以非零结束（如需要确认、用户取消）：命令已写出说明，不再追加“意外结束”
    expect(terminalExitNotice(1, 'command-failed')).toBeUndefined();
  });
});
