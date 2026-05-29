/**
 * 技能名 → id 的单一变换。
 *
 * 目录名(Store 产生技能时)、索引显示、`/<name>` slash 名、`load_skill` 查找
 * 全部共用这一个函数 —— 用不同变换会在某一环断链。要点:
 *   - **保留 Unicode**:中文名「代码审查」直接成为可用 id,不像普通 sanitize
 *     那样移除非 ASCII(否则中文名会被抹空)。
 *   - **只移除文件名非法字符**(`<>:"/\|?*` 与控制符),使结果可直接当文件名 /
 *     目录名,且不含路径分隔符(防越界)。
 *   - **幂等**:对已经是 id 的输入再跑一次,结果不变 —— Store 对入参再过一遍也安全。
 *
 * 变换顺序:小写 → 空白转 `-` → 移除非法字符 → 合并连续 `-` → 去首尾 `-`。
 */

/** 文件名非法字符:Windows 保留 + 路径分隔符;不含空格(空格在上一步已转 `-`)。 */
const ILLEGAL_FILENAME_CHARS = '<>:"/\\|?*';

export function skillNameToId(name: string): string {
  let out = "";
  for (const ch of name.toLowerCase()) {
    if (/\s/.test(ch)) {
      out += "-"; // 空白(含 \t\n\r)→ 词分隔符
      continue;
    }
    const code = ch.codePointAt(0)!;
    if (code <= 0x1f) continue; // 其余控制符:移除
    if (ILLEGAL_FILENAME_CHARS.includes(ch)) continue; // 文件名非法字符:移除
    out += ch; // 其余(含 Unicode 字母)原样保留
  }
  return out.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
}
