/**
 * RuntimeSession 错误类型。
 *
 * `ReloadBuildError` 在 reload 中途构建新资源失败时抛出——session 内部 catch 后转为
 * `ReloadResult.failed` 返回；旧 session 状态完全不动，磁盘已写新值，下次启动自然 pickup。
 */

export class ReloadBuildError extends Error {
  override readonly name = "ReloadBuildError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
