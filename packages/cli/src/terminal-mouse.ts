export interface TerminalMouseLease {
  release(): void;
}

interface TerminalMouseController {
  acquire(stdout: NodeJS.WriteStream): TerminalMouseLease;
  activeLeases(): number;
  resetForTests(): void;
}

const ENABLE_MOUSE_PASTE_TRACKING = "\x1b[?1006h\x1b[?1000h";
const DISABLE_MOUSE_PASTE_TRACKING = "\x1b[?1000l\x1b[?1006l";

function createTerminalMouseController(): TerminalMouseController {
  let leaseCount = 0;
  let lockedStdout: NodeJS.WriteStream | null = null;
  let exitHookRegistered = false;

  function disableTracking(): void {
    if (leaseCount <= 0 && !lockedStdout) {
      leaseCount = 0;
      return;
    }
    leaseCount = 0;
    lockedStdout?.write(DISABLE_MOUSE_PASTE_TRACKING);
    lockedStdout = null;
  }

  function registerExitHook(): void {
    if (exitHookRegistered) return;
    exitHookRegistered = true;
    process.on("exit", disableTracking);
  }

  return {
    acquire(stdout: NodeJS.WriteStream): TerminalMouseLease {
      if (!stdout.isTTY) return { release: () => {} };
      if (leaseCount === 0) {
        lockedStdout = stdout;
        stdout.write(ENABLE_MOUSE_PASTE_TRACKING);
        registerExitHook();
      }
      leaseCount++;

      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          if (leaseCount > 0) {
            leaseCount--;
          }
          if (leaseCount <= 0) {
            disableTracking();
          }
        },
      };
    },

    activeLeases(): number {
      return leaseCount;
    },

    resetForTests(): void {
      leaseCount = 0;
      lockedStdout = null;
      if (exitHookRegistered) {
        process.off("exit", disableTracking);
      }
      exitHookRegistered = false;
    },
  };
}

export const terminalMouseController: TerminalMouseController =
  createTerminalMouseController();

export function _getTerminalMouseRefcount(): number {
  return terminalMouseController.activeLeases();
}

export function _resetTerminalMouseRefcountForTests(): void {
  terminalMouseController.resetForTests();
}
