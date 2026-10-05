// One total deadline covers cooperative cleanup, actual execution exit and R.
// The final 500 ms already reserved by S belongs to assets/helpers/restoration;
// every writer, including N's logger, must use the same earlier phase deadline.
export const TERMINAL_RECOVERY_RESERVE_MS = 500;
export const TERMINAL_LOG_EXIT_RESERVE_MS = 150;
export const terminalWriterDeadline = (deadline: number): number => deadline - TERMINAL_RECOVERY_RESERVE_MS;

/** File owners share S's absolute deadline, including a stuck open/close RPC.
 * Expiry closes admission in the session and rejects; it never proves exit. */
export async function closeTerminalFiles(
  deadline: number,
  cleanup: () => Promise<void>,
  closeSession: (remainingMs: number) => Promise<void>,
): Promise<void> {
  if (!Number.isSafeInteger(deadline) || deadline <= 0) throw Error('terminal-close-deadline');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void closeSession(0).catch(() => {});
      reject(Error('terminal-files-close-unconfirmed'));
    }, Math.max(0, deadline - Date.now()));
  });
  const work = (async () => {
    try { await cleanup(); }
    finally { await closeSession(Math.max(0, deadline - Date.now())); }
  })();
  try { await Promise.race([work, expired]); }
  finally { clearTimeout(timer); }
}
