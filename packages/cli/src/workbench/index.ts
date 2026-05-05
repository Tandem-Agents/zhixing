/**
 * 工作台 UI 子系统公共 API 入口。
 *
 * 工作台 = REPL 主对话循环的视觉层，与 config-editor 子系统平级。
 * caller（repl.ts / 未来的命令输出统一渲染等）从此入口拿渲染函数和类型。
 *
 * 当前组件：
 *   - welcome.ts    启动稳态快照（chrome 内的运行环境信息）
 *   - advisories.ts 启动异常告知（chrome 之前的需要立即看到的警告）
 */

export {
  renderHomeWelcome,
  type WorkbenchHomeInfo,
} from "./welcome.js";

export {
  renderStartupAdvisories,
  type StartupAdvisoryInfo,
} from "./advisories.js";
