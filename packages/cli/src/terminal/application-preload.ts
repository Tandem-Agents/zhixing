import { isAbsolute } from 'node:path';
import { consumeTerminalParentEndpoint, TerminalParentTransport } from '@zhixing/terminal-ui/parent-transport';

/** S 的放行：只在耐久意向、身份绑定与完整准入之后到达，携带实例目录与目录身份。 */
export interface TerminalPreloadRelease {
  readonly directory: string;
  readonly directoryIdentity: string;
}

const IDENTITY = process.platform === 'win32' ? /^[a-f0-9]+:[a-f0-9]{16}$/u : /^[0-9]+:[0-9]+$/u;

/**
 * 受管只读预加载的父通道一侧：先接管 S 给的私有端点并挂好放行等待，再由调用方装载模块图。放行之前
 * 不读写 home、不记日志、不连接业务；放行帧不合法、收到其他帧或通道断开都按启动失败退出。
 */
export function awaitTerminalPreloadRelease(instance: string): { transport: TerminalParentTransport; release: Promise<TerminalPreloadRelease> } {
  const endpoint = consumeTerminalParentEndpoint();
  if (endpoint === undefined) throw Error('terminal-application-admission');
  const transport = new TerminalParentTransport(endpoint);
  const release = new Promise<TerminalPreloadRelease>((resolve, reject) => {
    const disconnected = () => reject(Error('terminal-preload-parent-closed'));
    transport.once('disconnect', disconnected);
    transport.once('message', (value: unknown) => {
      transport.off('disconnect', disconnected);
      const message = value as { type?: unknown; instance?: unknown; directory?: unknown; directoryId?: unknown } | null;
      if (message?.type !== 'terminal-preload-release' || message.instance !== instance ||
          typeof message.directory !== 'string' || !isAbsolute(message.directory) ||
          typeof message.directoryId !== 'string' || !IDENTITY.test(message.directoryId)) {
        reject(Error('terminal-preload-release-invalid'));
        return;
      }
      resolve({ directory: message.directory, directoryIdentity: message.directoryId });
    });
  });
  void release.catch(() => {});
  return { transport, release };
}
