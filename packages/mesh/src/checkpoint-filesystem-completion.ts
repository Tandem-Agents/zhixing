// A bounded wait is not proof that delegated physical work has ended. Only
// locally issued errors carry this fence; it is never accepted over the wire.
const unsettled = new WeakMap<object, Promise<void>>();
export const checkpointFilesystemCompletion = (cause: unknown): Promise<void> | undefined =>
  cause !== null && typeof cause === 'object' ? unsettled.get(cause) : undefined;

export function retainCheckpointFilesystemCompletion(cause: unknown, completion: Promise<void>): void {
  if (cause !== null && typeof cause === 'object') unsettled.set(cause, completion);
}
