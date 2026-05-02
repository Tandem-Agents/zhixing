/**
 * 敏感字段 mask 渲染纯函数。
 *
 * 两种场景：
 *   - 列表态（用户填完返回上层）：显示前 4 + **** + 后 4，让用户能粗略验证 key 没贴错
 *   - 输入态（用户正在编辑）：屏幕显示全 *，看到字符数即可
 *
 * 短字符串特例：长度 ≤ 8 时全 mask（前 4 + 后 4 会重叠暴露过半）
 */

/** 列表态显示：sk-xldt****qcmv（前 4 + **** + 后 4） */
export function maskForDisplay(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "*".repeat(value.length);
  const head = value.slice(0, 4);
  const tail = value.slice(-4);
  return `${head}****${tail}`;
}

/** 输入态显示：每个字符渲染为 * */
export function maskForInput(value: string): string {
  return "*".repeat(Array.from(value).length);
}
