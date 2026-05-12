/**
 * task-tail 模块公共导出 —— 屏幕底部任务区的渲染 + 生命周期。
 *
 * 模块职责：
 *   - 渲染纯函数（task-tail-render / tasklist-render）—— 无副作用，可独立 snapshot 测试
 *   - TaskTail 类 —— 订阅 TaskListService 状态变化，通过 ScreenController.setStatusTail 投递
 *
 * 与 status-bar 同层级，互不耦合：两者各自通过 ScreenController 的独立 API
 * （setStatusBar / setStatusTail）注入信息，chrome 协议在渲染时按双源拼接或独立显示。
 */

export { renderTaskTail } from "./task-tail-render.js";
export { renderTaskList } from "./tasklist-render.js";
export { TaskTail, type TaskTailOptions } from "./task-tail.js";
