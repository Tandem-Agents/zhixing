import { getZhixingHome } from "@zhixing/core";

/**
 * 由 ZHIXING_HOME 确定性派生核心宿主端口。
 *
 * 同 home → 同端口：`listen` 的 EADDRINUSE 是**原子**单例仲裁（并发拉起也只活一个），
 * 不退回非原子的 PID 文件比对。不同 home → 不同端口：多个 zhixing 并行互不撞（需求5）。
 * 用户显式 `--port` 仍可覆盖。
 */
export function homeToPort(home: string = getZhixingHome()): number {
  let hash = 0;
  for (let i = 0; i < home.length; i++) {
    hash = (hash * 31 + home.charCodeAt(i)) | 0;
  }
  return 18900 + (Math.abs(hash) % 1000);
}
