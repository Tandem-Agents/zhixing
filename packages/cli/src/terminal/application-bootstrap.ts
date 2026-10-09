import { logFailureEvidence } from '@zhixing/core/logging';
import { TerminalChannel } from '@zhixing/terminal-ui/channel';
import { consumeTerminalParentEndpoint, TerminalParentTransport } from '@zhixing/terminal-ui/parent-transport';

/** Only for a failed bootstrap, before the application consumes its endpoint.
 * S already owns a recorder and the real process: use that existing close
 * receipt rather than starting a second log store or application owner. */
export async function reportApplicationBootstrapFailure(error: unknown, stage: 'writer-declaration' | 'module-load', durationMs: number): Promise<void> {
  const endpoint = consumeTerminalParentEndpoint();
  const instance = process.env.ZHIXING_TERMINAL_INSTANCE;
  if (!instance || endpoint === undefined) return;
  const transport = new TerminalParentTransport(endpoint);
  const channel = new TerminalChannel(instance, (packet, done) => transport.send(packet, done),
    message => { if (message.type === 'close') channel.beginClose(); }, () => transport.close());
  transport.on('message', value => channel.accept(value));
  transport.once('disconnect', () => channel.close());
  const failure = logFailureEvidence(error);
  try {
    await channel.send({ type: 'exit', code: 71, reason: 'terminal-application-bootstrap-failed',
      bootstrapFailure: { stage, durationMs, category: failure.category, ...(failure.code ? { code: failure.code } : {}) } });
    await channel.closeAfterReceived();
  } finally { channel.close(); transport.close(); }
}
