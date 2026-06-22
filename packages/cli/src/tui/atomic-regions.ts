export type AtomicRegionPatterns = RegExp | readonly RegExp[];

export interface AtomicStringRange {
  readonly start: number;
  readonly end: number;
  readonly content: string;
}

export function hasAtomicRegionPatterns(
  patterns: AtomicRegionPatterns | undefined,
): patterns is AtomicRegionPatterns {
  if (!patterns) return false;
  return Array.isArray(patterns) ? patterns.length > 0 : true;
}

export function collectAtomicStringRanges(
  text: string,
  patterns: AtomicRegionPatterns,
): AtomicStringRange[] {
  const ranges: AtomicStringRange[] = [];
  const normalized = Array.isArray(patterns) ? patterns : [patterns];

  for (const pattern of normalized) {
    const re = toGlobalRegExp(pattern);
    for (const match of text.matchAll(re)) {
      const content = match[0];
      if (content.length === 0) continue;
      const start = match.index!;
      ranges.push({
        start,
        end: start + content.length,
        content,
      });
    }
  }

  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const result: AtomicStringRange[] = [];
  let coveredEnd = -1;
  for (const range of ranges) {
    if (range.start < coveredEnd) continue;
    result.push(range);
    coveredEnd = range.end;
  }
  return result;
}

function toGlobalRegExp(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}
