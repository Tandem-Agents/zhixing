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
  /**
   * 读取当前紧急度。以函数承载而不是快照值:义务级维护任务在同键合流后仍可被
   * 更强等待者提级,其内部叶步骤的准入必须读到提级后的值,静态快照会把整段
   * 义务锁死在启动时的优先级上。静态声明点一律包成常量函数。
   */
  readonly urgency: () => StorageMaintenanceUrgency;
  /**
   * 当前完整维护义务的共享取消信号。叶级容量排队和步骤开始前的安全检查点
   * 必须读取这一信号；它不代表单个等待者，也不携带或继承任何容量 permit。
   */
  readonly abort: AbortSignal;
  /**
   * 当前调用栈是否持有文件锁或处于串行段。持有时准入必须零等待:
   * 排队等待会把锁的持有时间拉长到准入超时,阻塞所有其他持锁者。
   */
  readonly holdingExclusion: boolean;
}

const maintenanceContext = new AsyncLocalStorage<MaintenanceExecutionContext>();
const neverAbortMaintenance = new AbortController().signal;

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
      urgency: () => urgency,
      abort: maintenanceContext.getStore()?.abort ?? neverAbortMaintenance,
      holdingExclusion: maintenanceContext.getStore()?.holdingExclusion ?? false,
    },
    operation,
  );
}

/**
 * 为延后执行且已经转交给耐久维护 owner 的工作建立全新语境。
 *
 * Node 会把 AsyncLocalStorage 传播进 timer；直接在 timer 中继续会错误继承
 * 原调用者的紧急度、取消信号和互斥标记。只有具备独立耐久重试凭据、且由
 * 自身 owner 接管生命周期的后台续跑可以使用本原语。
 */
export function runDetachedMaintenanceContext<T>(
  urgency: StorageMaintenanceUrgency,
  operation: () => Promise<T>,
): Promise<T> {
  return maintenanceContext.run(
    {
      urgency: () => urgency,
      abort: neverAbortMaintenance,
      holdingExclusion: false,
    },
    operation,
  );
}

/**
 * 声明一段调用内的紧急度可随同键提级变化。仅供义务级协调层使用:义务的
 * 有效紧急度 = 当前最强等待者,叶级准入读取时必须看到最新值。
 */
export function runWithMaintenanceUrgency<T>(
  urgency: () => StorageMaintenanceUrgency,
  abort: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  return maintenanceContext.run(
    {
      urgency,
      abort,
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
      urgency: maintenanceContext.getStore()?.urgency ?? (() => "background"),
      abort: maintenanceContext.getStore()?.abort ?? neverAbortMaintenance,
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
  return maintenanceContext.getStore()?.urgency() ?? "background";
}

/** 叶级容量排队与安全检查点读取当前完整维护义务的共享取消信号。 */
export function currentMaintenanceAbortSignal(): AbortSignal {
  return maintenanceContext.getStore()?.abort ?? neverAbortMaintenance;
}

/** 叶级准入点判断是否必须零等待。 */
export function isHoldingMaintenanceExclusion(): boolean {
  return maintenanceContext.getStore()?.holdingExclusion ?? false;
}
