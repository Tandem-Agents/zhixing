/** Only explicitly classified, payload-free failures may cross a log consumer boundary. */
export class LogRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LogRequestError";
  }
}

export class LogStoreNotInitializedError extends LogRequestError {
  constructor() { super("日志存储尚未初始化；历史日志可用 zz logs read zxlog-local:legacy/catalog 查看"); }
}

export function publicLogErrorMessage(error: unknown): string {
  if (error instanceof LogRequestError) return error.message;
  if (error instanceof Error && error.name === "AbortError")
    return "日志查询已取消";
  return "日志访问暂不可用，请稍后重试或在本机检查存储状态";
}
