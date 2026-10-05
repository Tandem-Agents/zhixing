/** Bound a JSON control projection before it leaves its receive owner. Native
 * stringify still defines escaping; its replacer rejects before accumulating
 * an oversized string/container. This measures content/structure, not V8 heap.
 * Return the original immutable projection, never a second parsed copy. */
export function boundedControlProjection<T>(value: T, maximumBytes: number): T {
  let remaining = maximumBytes;
  const charge = (bytes: number): void => {
    remaining -= bytes;
    if (remaining < 0) throw Error('控制结果超过当前展示容量，请缩小请求后重试。');
  };
  const string = (text: string): void => {
    // Check the unescaped lower bound before allocating its escaped encoding.
    if (Buffer.byteLength(text) > remaining) charge(remaining + 1);
    charge(Buffer.byteLength(JSON.stringify(text)));
  };
  JSON.stringify(value, (key, item: unknown) => {
    string(key); charge(2); // separators, including a conservative root slot
    if (typeof item === 'string') string(item);
    else if (item === null) charge(4);
    else if (typeof item === 'number' || typeof item === 'boolean') charge(Buffer.byteLength(JSON.stringify(item)));
    else if (typeof item === 'object') charge(2);
    else if (item !== undefined) throw Error('Unsupported control projection');
    return item;
  });
  return value;
}
