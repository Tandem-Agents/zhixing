/**
 * 屏幕协调层公共导出。
 *
 * cli REPL 模式启动一个 ScreenController，所有写到屏幕的逻辑（output / status-bar /
 * scheduler 通知 / retry / compact / interrupt 等）必须经此协调，禁止直接
 * process.stdout.write。
 */

export {
  createScreenController,
  type ScreenController,
  type InputRegion,
} from "./screen-controller.js";

export {
  createScreenWriter,
  createStdoutWriter,
  type CliWriter,
} from "./cli-writer.js";
