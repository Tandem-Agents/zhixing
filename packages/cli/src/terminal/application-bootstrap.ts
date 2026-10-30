import { logFailureEvidence } from '@zhixing/core/logging';
import { TerminalChannel } from '@zhixing/terminal-ui/channel';
import { consumeTerminalParentEndpoint, TerminalParentTransport } from '@zhixing/terminal-ui/parent-transport';

/** Only for a failed bootstrap, before the application consumes its endpoint.
 * S already owns a recorder and the real process: use that existing close
 * receipt rather than starting a second log store or application owner. */
export async function reportApplicationBootstrapFailure(error: unknown, stage: 'writer-declaration' | 'module-load', durationMs: number,
  preloadedTransport?: TerminalParentTransport): Promise<void> {
  // 受管预加载已接管父端点：失败回执沿用同一条父通道
  const endpoint = preloadedTransport ? undefined : consumeTerminalParentEndpoint();
  const instance = process.env.ZHIXING_TERMINAL_INSTANCE;
  if (!instance || (!preloadedTransport && endpoint === undefined) || preloadedTransport?.connected === false) return;
  const transport = preloadedTransport ?? new TerminalParentTransport(endpoint!);
  const channel = new TerminalChannel(instance, (packet, done) => transport.send(packet, done),
    message => { if (message.type === 'close') channel.beginClose(); }, () => transport.close());
  transport.on('message', value => channel.accept(value));
  transport.once('disconnect', () => channel.close());
  const failure = logFailureEvidence(error);
  try {
    await channel.send({ type: 'exit', code: 71, reason: 'terminal-application-bootstrap-failed',
      bootstrapFailure: { stage, durationMs, category: failure.category, ...(failure.code ? { code: failure.code } : {}) } });
    await channel.closeAfterReceived();
  } finally {
    channel.close(); transport.close();
    // 启动已失败：回执已被 S 确认或投递已超时，父通道再无可收之物。只半关闭时句柄要等对端关闭，
    // S 不关就一直不退出；彻底释放，进程退出不取决于对端
    transport.socket.destroy();
  }
}
