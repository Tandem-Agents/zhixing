import type { ManagedServiceCommandRunner } from '../serve/managed-service.js';
import { createTerminalOwnedProcessFactory } from './host-launch.js';

/** The domain service adapter retains its commands; S owns their actual lifetime. */
export const terminalManagedServiceCommand: ManagedServiceCommandRunner = async (command, args, options) => {
  options.signal.throwIfAborted();
  const deadline = Date.now() + options.timeoutMs;
  const owner = createTerminalOwnedProcessFactory('managed-service')(command, args,
    { signal: options.signal, deadline: Math.min(deadline, Date.now() + 5000) });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let bytes = 0, failure: string | undefined;
  const fail = (reason: string) => { failure ??= reason; owner.child.kill('SIGTERM'); };
  const collect = (target: Buffer[]) => (chunk: Buffer) => {
    bytes += chunk.length;
    if (failure || bytes > 1024 * 1024) fail('服务命令输出超过容量。'); else target.push(chunk);
  };
  owner.child.stdout.on('data', collect(stdout)); owner.child.stderr.on('data', collect(stderr));
  owner.child.stdin.on('error', () => fail('服务命令输入失败。'));
  owner.child.on('error', () => { failure ??= '服务命令启动失败。'; });
  const timer = setTimeout(() => fail('服务命令未在期限内完成。'), Math.max(1, deadline - Date.now()));
  try {
    try { await owner.ready; owner.child.stdin.end(); } catch { fail('服务命令启动失败。'); }
    const result = await owner.closed;
    options.signal.throwIfAborted(); if (failure) throw Error(failure);
    return { code: result.code ?? -1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
  } finally { clearTimeout(timer); }
};
