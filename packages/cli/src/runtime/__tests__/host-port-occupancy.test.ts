import net from "node:net";
import { describe, expect, it } from "vitest";
import { homeToPort } from "../../serve/host-port.js";
import { hostStartFailureNotice, occupiedHostPort } from "../host-port-occupancy.js";

async function listen(port: number): Promise<net.Server | undefined> {
  const server = net.createServer(socket => socket.destroy());
  return new Promise(resolve => {
    server.once("error", () => resolve(undefined));
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

describe("host start failure notice", () => {
  it("names the derived port when another program holds it, and points to logs otherwise", async () => {
    // 找一个当前空闲的派生端口来占
    let home = "", server: net.Server | undefined;
    for (let attempt = 0; attempt < 20 && !server; attempt++) {
      home = `E:\\occupancy-fixture-${process.pid}-${attempt}\\home`;
      server = await listen(homeToPort(home));
    }
    expect(server).toBeDefined();
    const port = homeToPort(home);
    try {
      expect(await occupiedHostPort(home)).toBe(port);
      expect(hostStartFailureNotice(port)).toBe(`本机服务端口 ${port} 已被其他程序占用，知行无法启动：关闭占用它的程序后再重试。`);
    } finally { await new Promise(resolve => server!.close(resolve)); }
    expect(await occupiedHostPort(home)).toBeUndefined();
    expect(hostStartFailureNotice(undefined)).toBe("本机服务启动失败，可用 zz logs 查看原因。");
  });
});
