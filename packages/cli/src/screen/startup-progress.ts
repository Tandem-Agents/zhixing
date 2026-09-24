import chalk from "chalk";

interface Writable {
  write(chunk: string): unknown;
}

export interface StartupProgressPresenterOptions {
  stdout: Writable;
  delayMs?: number;
  longDelayMs?: number;
  text?: string;
  longText?: string;
}

const DEFAULT_DELAY_MS = 700;
const DEFAULT_LONG_DELAY_MS = 4_000;

/**
 * 启动期临时提示：只写终端当前行，不进入 ScreenController 的 scroll 内容。
 * 首页接管屏幕前必须 stop/disable，让欢迎块成为第一块稳定内容。
 */
export class StartupProgressPresenter {
  private delayTimer: ReturnType<typeof setTimeout> | null = null;
  private longDelayTimer: ReturnType<typeof setTimeout> | null = null;
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private visible = false;
  private disabled = false;
  private currentText = "";

  private readonly delayMs: number;
  private readonly longDelayMs: number;
  private readonly text: string;
  private readonly longText: string;

  constructor(private readonly opts: StartupProgressPresenterOptions) {
    this.delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
    this.longDelayMs = opts.longDelayMs ?? DEFAULT_LONG_DELAY_MS;
    this.text = opts.text ?? chalk.yellow("正在打开知行...");
    this.longText =
      opts.longText ??
      chalk.yellow("正在等待知行就绪...");
  }

  begin(): void {
    if (this.disabled) return;
    this.stop();
    const started = performance.now();
    this.delayTimer = setTimeout(() => {
      this.delayTimer = null;
      this.render(this.text);
    }, this.delayMs);
    this.longDelayTimer = setTimeout(() => {
      this.longDelayTimer = null;
      const update = () => this.render(`${this.longText} ${chalk.dim(`已等待 ${Math.floor((performance.now() - started) / 1000)} 秒`)}`);
      update();
      this.elapsedTimer = setInterval(update, 1000);
    }, Math.max(this.delayMs, this.longDelayMs));
  }

  stop(): void {
    this.clearTimer("delayTimer");
    this.clearTimer("longDelayTimer");
    if (this.elapsedTimer) clearInterval(this.elapsedTimer);
    this.elapsedTimer = null;
    if (this.visible) {
      this.opts.stdout.write("\r\x1b[2K");
      this.visible = false;
    }
  }

  disable(): void {
    this.stop();
    this.disabled = true;
  }

  /** Release the temporary line for a durable notice, then restore only that line. */
  notify(message: string): void {
    const restore = this.visible;
    if (restore) this.opts.stdout.write("\r\x1b[2K");
    this.opts.stdout.write(message.endsWith("\n") ? message : `${message}\n`);
    if (restore) this.render(this.currentText);
  }

  acceptsStartupNotices(): boolean {
    return !this.disabled;
  }

  private render(text: string): void {
    if (this.disabled) return;
    this.opts.stdout.write(`\r\x1b[2K${text}`);
    this.currentText = text;
    this.visible = true;
  }

  private clearTimer(name: "delayTimer" | "longDelayTimer"): void {
    const timer = this[name];
    if (!timer) return;
    clearTimeout(timer);
    this[name] = null;
  }
}

export function createStartupProgressPresenter(
  opts: StartupProgressPresenterOptions,
): StartupProgressPresenter {
  return new StartupProgressPresenter(opts);
}
