/** Largest delay represented faithfully by Node.js timers. */
export const MAX_RUNTIME_TIMER_DELAY_MS = 2_147_483_647;

export function assertRuntimeTimerDelay(
  value: number,
  label: string,
  allowZero = false,
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > MAX_RUNTIME_TIMER_DELAY_MS
  ) {
    throw new TypeError(
      `${label} must be ${allowZero ? "a non-negative" : "a positive"} runtime timer duration`,
    );
  }
  return value;
}
