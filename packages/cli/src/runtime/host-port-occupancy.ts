import net from "node:net";
import { homeToPort } from "../serve/host-port.js";

/**
 * 宿主已确认启动失败（子进程退出）之后，核对按 home 派生的宿主端口：此时本 home 没有存活的宿主，
 * 端口上若还能连上，就是被其他程序占着，宿主因此无法监听。只做一次短时连接，不发送任何数据。
 */
export async function occupiedHostPort(zhixingHome: string, timeoutMs = 300): Promise<number | undefined> {
  const port = homeToPort(zhixingHome);
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (occupied: boolean) => { clearTimeout(timer); socket.destroy(); resolve(occupied ? port : undefined); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** 宿主启动失败给用户的说明：端口被占写明端口与下一步，其他原因指向运行日志 */
export function hostStartFailureNotice(occupiedPort: number | undefined): string {
  return occupiedPort === undefined
    ? "本机服务启动失败，可用 zz logs 查看原因。"
    : `本机服务端口 ${occupiedPort} 已被其他程序占用，知行无法启动：关闭占用它的程序后再重试。`;
}
