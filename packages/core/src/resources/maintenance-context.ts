import { AsyncLocalStorage } from "node:async_hooks";
import type { StorageMaintenanceUrgency } from "./storage-maintenance.js";

/**
 * 维护执行语境 —— 仅进程内可见的隐式调用语境。
 *
 * 存在理由:同一个维护任务(投影 flush、生命周期对账、日志迁移)既可能被前台
 * 权威写同步等待,也可能由启动恢复或后台回收触发。紧急度是"当前谁在等它"这个
 * 阻塞关系决定的,任务自身无从判断,只有顶层所有者知道。语境把这个事实从顶层
 * 传到叶级准入点,取代在叶级硬编码紧急度。
 *
 * 紧急度不是任务属性也不是调用方偏好:调用方不得为了插队而提级,叶级也不得
 * 因为"自己是恢复逻辑"就恒定报恢复。
 */
export interface MaintenanceExecutionContext {
  /** 当前有用户或权威操作在等它为前台;恢复可用性但无调用等待为恢复;其余为后台 */
  readonly urgency: StorageMaintenanceUrgency;
  /**
   * 当前调用栈是否持有文件锁或处于串行段。持有时准入必须零等待:
   * 排队等待会把锁的持有时间拉长到准入超时,阻塞所有其他持锁者。
   */
  readonly holdingExclusion: boolean;
}

const maintenanceContext = new AsyncLocalStorage<MaintenanceExecutionContext>();

/**
 * 声明这段调用的真实阻塞关系,互斥标记继承。
 *
 * 两类调用点需要它:阻塞关系内在固定的(提交前 flush 恒被当前权威写等待、
 * 周期回收恒无人等待),以及顶层所有者知道而下游无从判断的(同一个生命周期
 * 对账,前台授权请求触发时是前台,启动恢复触发时是恢复)。
 *
 * 两个维度正交、各自独立设置:紧急度换了不代表离开互斥区,反之亦然。
 */
export function runInMaintenanceContext<T>(
  urgency: StorageMaintenanceUrgency,
  operation: () => Promise<T>,
): Promise<T> {
  return maintenanceContext.run(
    {
      urgency,
      holdingExclusion: maintenanceContext.getStore()?.holdingExclusion ?? false,
    },
    operation,
  );
}

/**
 * 标记进入互斥区(文件锁、串行队列),紧急度继承。叶级准入随之转为零等待。
 */
export function runHoldingMaintenanceExclusion<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return maintenanceContext.run(
    {
      urgency: maintenanceContext.getStore()?.urgency ?? "background",
      holdingExclusion: true,
    },
    operation,
  );
}

/**
 * 叶级准入点读取当前紧急度。
 *
 * 缺省为 background 而非 foreground:漏注入语境时,前台任务被当后台排队只会
 * 变慢且可观测;反过来把后台冒充前台会破坏"自动任务不得饿死交互任务"的公平
 * 保证,且不可观测。错误代价不对称,默认取可观测的那一侧。
 */
export function currentMaintenanceUrgency(): StorageMaintenanceUrgency {
  return maintenanceContext.getStore()?.urgency ?? "background";
}

/** 叶级准入点判断是否必须零等待。 */
export function isHoldingMaintenanceExclusion(): boolean {
  return maintenanceContext.getStore()?.holdingExclusion ?? false;
}
