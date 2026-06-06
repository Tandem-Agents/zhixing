import { describe, it, expect } from "vitest";
import { homeToPort } from "../host-port.js";

describe("homeToPort", () => {
  it("同 home 确定性派生同端口（EADDRINUSE 单例仲裁的硬约束）", () => {
    // 同一 home 必须每次得到同一端口——否则 ensure 并发拉起无法靠「同端口 listen」原子仲裁单例。
    expect(homeToPort("/home/a/.zhixing")).toBe(homeToPort("/home/a/.zhixing"));
    expect(homeToPort("C:\\Users\\u\\.zhixing")).toBe(
      homeToPort("C:\\Users\\u\\.zhixing"),
    );
  });

  it("典型不同 home 派生不同端口（多实例并行隔离，需求5）", () => {
    // 非硬保证——hash % 1000 有碰撞可能（见 host-port.ts trade-off），这几个典型路径不撞。
    const ports = [
      homeToPort("/home/alice/.zhixing"),
      homeToPort("/home/bob/.zhixing"),
      homeToPort("/home/carol/.zhixing"),
    ];
    expect(new Set(ports).size).toBe(ports.length);
  });

  it("端口落在 18900–19899 区间（18900 + hash%1000，含空串 / 中英文路径）", () => {
    for (const home of [
      "",
      "/x",
      "/home/u/.zhixing",
      "C:\\Users\\u\\.zhixing",
      "/用户/知行/.zhixing",
    ]) {
      const p = homeToPort(home);
      expect(p).toBeGreaterThanOrEqual(18900);
      expect(p).toBeLessThanOrEqual(19899);
    }
  });
});
