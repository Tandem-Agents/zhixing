const ILLEGAL_FILENAME_CHARS = '<>:"/\\|?*';

export function normalizeRubricId(input: string): string {
  let out = "";
  for (const ch of input.toLowerCase()) {
    if (/\s/.test(ch)) {
      out += "-";
      continue;
    }
    const code = ch.codePointAt(0)!;
    if (code <= 0x1f) continue;
    if (ILLEGAL_FILENAME_CHARS.includes(ch)) continue;
    out += ch;
  }
  return out.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
}

export function rubricTitleToId(title: string): string {
  return normalizeRubricId(title);
}

export function rubricTextToId(text: string, fallback: string): string {
  return rubricTitleToId(text) || fallback;
}
