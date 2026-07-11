import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface GoldenNormalizeOptions {
  /** 由调用方声明的动态字段；值被统一替换，但字段本身仍保留在契约中。 */
  volatileKeys?: readonly string[];
  /** 对平台路径、临时目录等测试环境值做定向替换。 */
  replaceStrings?: Readonly<Record<string, string>>;
}

/**
 * 把行为采样转换为可审阅、跨机器稳定的 JSON 值。
 *
 * 对象键排序用于消除构造顺序噪声；动态值只允许由调用方按字段或精确字符串
 * 显式声明。禁止按值的外观猜测身份，否则业务枚举与用户内容可能被误归一化。
 */
export function normalizeGolden(
  value: unknown,
  options: GoldenNormalizeOptions = {},
): unknown {
  const volatileKeys = new Set(options.volatileKeys ?? []);
  const replacements = Object.entries(options.replaceStrings ?? {}).sort(
    ([left], [right]) => right.length - left.length,
  );

  const visit = (input: unknown, key?: string): unknown => {
    if (key && volatileKeys.has(key)) {
      const valueType = input === null ? "null" : Array.isArray(input) ? "array" : typeof input;
      if (valueType === "object" || valueType === "array") {
        throw new TypeError(
          `Golden volatile field must be scalar so its shape remains visible: ${key}`,
        );
      }
      return `<${key}:${valueType}>`;
    }
    if (input === null || typeof input === "boolean" || typeof input === "number") {
      return input;
    }
    if (typeof input === "string") {
      let output = input;
      for (const [from, to] of replacements) output = output.split(from).join(to);
      return output;
    }
    if (Array.isArray(input)) return input.map((item) => visit(item));
    if (typeof input === "object") {
      const record = input as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .filter((entryKey) => record[entryKey] !== undefined)
          .map((entryKey) => [entryKey, visit(record[entryKey], entryKey)]),
      );
    }
    throw new TypeError(`Golden value is not JSON-compatible: ${typeof input}`);
  };

  return visit(value);
}

/**
 * 比较当前行为与已提交基线。只有显式设置 ZHIXING_UPDATE_GOLDENS=1 才会写盘，
 * 普通测试永远是只读比较，避免误把回归更新成“新预期”。
 */
export async function assertGolden(
  fixture: URL,
  actual: unknown,
  options: GoldenNormalizeOptions = {},
): Promise<void> {
  const file = fileURLToPath(fixture);
  const serialized = `${JSON.stringify(normalizeGolden(actual, options), null, 2)}\n`;

  if (process.env.ZHIXING_UPDATE_GOLDENS === "1") {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, serialized, "utf8");
    return;
  }

  let expected: string;
  try {
    expected = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Missing golden: ${file}. Run the explicit runtime golden update command.`,
      );
    }
    throw error;
  }

  if (expected.replace(/\r\n/g, "\n") !== serialized) {
    throw new Error(
      `Golden mismatch: ${file}. Inspect the behavior change before explicitly updating the baseline.`,
    );
  }
}
