import { getZhixingHome } from "@zhixing/core";

/**
 * 由 ZHIXING_HOME 确定性派生核心宿主端口。
 *
 * 同 home → 同端口：`listen` 的 EADDRINUSE 是**原子**单例仲裁（并发拉起也只活一个），
 * 不退回非原子的 PID 文件比对——「同 home 确定性端口」是单例仲裁的**硬约束**（动态分配
 * 做不到「同 home 撞同端口」、也就做不到 EADDRINUSE 单例）。不同 home → 不同端口：
 * 多个 zhixing 并行互不撞。
 *
 * Trade-off：`hash % 1000` 有碰撞可能——两个不同 home 偶发派生到同端口时，后启动者 listen
 * 失败。碰撞概率低（同时运行的 home 通常个位数 / 1000 槽），换取「同 home 确定性端口」
 * 这一单例前提，是有意取舍、非缺陷。
 */
export function homeToPort(home: string = getZhixingHome()): number {
  let hash = 0;
  for (let i = 0; i < home.length; i++) {
    hash = (hash * 31 + home.charCodeAt(i)) | 0;
  }
  return 18900 + (Math.abs(hash) % 1000);
}
