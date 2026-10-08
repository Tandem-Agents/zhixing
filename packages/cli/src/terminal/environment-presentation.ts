import type { TerminalView } from '@zhixing/terminal-ui/protocol';
import type { ReplLocalViewSnapshot } from '../runtime/repl-local-view.js';

/** Only the existing public configuration/Host projection crosses into U.
 * Do not serialize the configuration, host info, or local filesystem state. */
export function terminalEnvironment(view: Pick<ReplLocalViewSnapshot, 'primaryModel' | 'workspaceRoot'>): NonNullable<TerminalView['environment']> {
  return {
    provider: view.primaryModel.providerId.slice(0, 256),
    model: view.primaryModel.model.slice(0, 512),
    workspace: view.workspaceRoot?.slice(0, 4096) ?? null,
  };
}
