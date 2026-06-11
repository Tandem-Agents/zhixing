/**
 * admit_skill 二段协议测试 —— 接入安全模型的验收锚。
 *
 * Store 用真实 SkillStore(tmp 目录):staging / admit / 孤儿清扫的契约就是
 * 磁盘行为,不 mock;裁判经 assess 闭包注入三态脚本。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  SkillStore,
  ADMISSION_TOKEN_TTL_MS,
  type AdmissionAssessment,
} from "@zhixing/core";
import { createAdmitSkillTool, type SkillAdmissionAssess } from "../skill.js";

let root: string;
let srcDir: string;
let store: SkillStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "admit-skill-"));
  srcDir = path.join(root, "外部技能源");
  await fs.mkdir(srcDir, { recursive: true });
  await fs.writeFile(
    path.join(srcDir, "SKILL.md"),
    "---\nname: 部署助手\ndescription: 部署时用\n---\n做法正文",
    "utf-8",
  );
  store = new SkillStore(path.join(root, "skills"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function assessAs(
  decision: AdmissionAssessment["verdict"]["decision"],
  reason = "测试理由",
): SkillAdmissionAssess {
  return async () => ({
    threats: [],
    verdict: { decision, reason },
  });
}

const CTX = { workingDirectory: "/tmp" } as never;

async function listStaging(): Promise<string[]> {
  try {
    return await fs.readdir(path.join(root, "skills", ".staging"));
  } catch {
    return [];
  }
}

describe("admit_skill 首调三态", () => {
  it("safe → 自动入库 linked、清暂存、content 含 id 与唤起提示", async () => {
    const tool = createAdmitSkillTool(store, assessAs("safe"), "main");
    const r = await tool.call({ path: srcDir }, CTX);

    expect(r.isError).toBe(false);
    expect(r.content).toContain("部署助手");
    expect(r.content).toContain("/部署助手");
    expect((await store.listAll()).map((s) => s.id)).toContain("部署助手");
    expect(await listStaging()).toEqual([]); // 清暂存
  });

  it("escalate → 拒绝、清暂存、不入库,且断言无 token 返回(结构性不可绕)", async () => {
    const tool = createAdmitSkillTool(
      store,
      assessAs("escalate", "确凿注入"),
      "main",
    );
    const r = await tool.call({ path: srcDir }, CTX);

    expect(r.isError).toBe(true);
    expect(r.content).toContain("不可绕过");
    expect(r.content).toContain("确凿注入");
    expect(r.content).not.toContain("admissionToken");
    expect(await store.listAll()).toEqual([]);
    expect(await listStaging()).toEqual([]);
  });

  it("needs-confirm → 保留暂存、返回报告与 token、不入库", async () => {
    const tool = createAdmitSkillTool(
      store,
      assessAs("needs-confirm", "可疑措辞"),
      "main",
    );
    const r = await tool.call({ path: srcDir }, CTX);

    expect(r.isError).toBe(false);
    expect(r.content).toContain("可疑措辞");
    expect(r.content).toContain("admissionToken");
    expect(await store.listAll()).toEqual([]); // 未入库
    expect((await listStaging()).length).toBe(1); // 暂存保留
  });

  it("首调缺 path → isError;源缺 name → 失败且清暂存", async () => {
    const tool = createAdmitSkillTool(store, assessAs("safe"), "main");
    const r1 = await tool.call({}, CTX);
    expect(r1.isError).toBe(true);

    await fs.writeFile(path.join(srcDir, "SKILL.md"), "---\n---\n无名", "utf-8");
    const r2 = await tool.call({ path: srcDir }, CTX);
    expect(r2.isError).toBe(true);
    expect(r2.content).toContain("name");
    expect(await listStaging()).toEqual([]);
  });
});

describe("admit_skill 确认重调(artifact 绑定)", () => {
  function extractToken(content: string): string {
    const m = content.match(/admissionToken 重调本工具完成接入\(有时效\):(\S+)/);
    expect(m).not.toBeNull();
    return m![1]!;
  }

  it("token 命中 + digest 一致 → 入库(用登记 mode)、清登记清暂存", async () => {
    const tool = createAdmitSkillTool(store, assessAs("needs-confirm"), "work");
    const first = await tool.call({ path: srcDir }, CTX);
    const token = extractToken(first.content as string);

    const second = await tool.call({ admissionToken: token }, CTX);
    expect(second.isError).toBe(false);
    expect(second.content).toContain("已接入");
    expect(await listStaging()).toEqual([]);
    // mode 用登记值(work)
    const managed = await store.listForManagement();
    expect(managed.find((s) => s.id === "部署助手")?.mode).toBe("work");

    // 重放同 token → 已失效
    const third = await tool.call({ admissionToken: token }, CTX);
    expect(third.isError).toBe(true);
    expect(third.content).toContain("重新审查");
  });

  it("TOCTOU 防御:确认前暂存被改写 → digest 不一致 → 拒且清暂存", async () => {
    const tool = createAdmitSkillTool(store, assessAs("needs-confirm"), "main");
    const first = await tool.call({ path: srcDir }, CTX);
    const token = extractToken(first.content as string);

    const stagingDirs = await listStaging();
    await fs.appendFile(
      path.join(root, "skills", ".staging", stagingDirs[0]!, "SKILL.md"),
      "\n被注入的新内容",
    );

    const second = await tool.call({ admissionToken: token }, CTX);
    expect(second.isError).toBe(true);
    expect(second.content).toContain("不一致");
    expect(await store.listAll()).toEqual([]);
    expect(await listStaging()).toEqual([]);
  });

  it("token 过期 → 拒且要求重新审查(惰性清理)", async () => {
    vi.useFakeTimers();
    try {
      const tool = createAdmitSkillTool(store, assessAs("needs-confirm"), "main");
      const first = await tool.call({ path: srcDir }, CTX);
      const token = extractToken(first.content as string);

      vi.advanceTimersByTime(ADMISSION_TOKEN_TTL_MS + 1000);
      const second = await tool.call({ admissionToken: token }, CTX);
      expect(second.isError).toBe(true);
      expect(second.content).toContain("重新审查");
    } finally {
      vi.useRealTimers();
    }
  });

  it("跨实例失效:新工具实例对旧 token 返回重新审查", async () => {
    const tool1 = createAdmitSkillTool(store, assessAs("needs-confirm"), "main");
    const first = await tool1.call({ path: srcDir }, CTX);
    const token = extractToken(first.content as string);

    const tool2 = createAdmitSkillTool(store, assessAs("needs-confirm"), "main");
    const r = await tool2.call({ admissionToken: token }, CTX);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("重新审查");
  });
});

describe("跨进程孤儿暂存清理", () => {
  it("内存登记丢失(模拟重启)但暂存超 TTL → 下次首调被 sweepStaleStaging 收走;未超不误删", async () => {
    // 直接造两个孤儿:一个 mtime 超期、一个新鲜
    const staleDir = await store.prepareStaging();
    await fs.writeFile(path.join(staleDir, "SKILL.md"), "stale", "utf-8");
    const past = new Date(Date.now() - ADMISSION_TOKEN_TTL_MS - 60_000);
    await fs.utimes(staleDir, past, past);
    const freshDir = await store.prepareStaging();
    await fs.writeFile(path.join(freshDir, "SKILL.md"), "fresh", "utf-8");

    const tool = createAdmitSkillTool(store, assessAs("safe"), "main");
    await tool.call({ path: srcDir }, CTX); // 首调触发清扫

    const left = await listStaging();
    expect(left).toHaveLength(1); // stale 收走,fresh 保留
    expect(path.join(root, "skills", ".staging", left[0]!)).toBe(freshDir);
  });
});

describe("admit_skill 安全自描述", () => {
  it("顶层 path 参数 + filesystem/read 与 app-state/write 双边界 + permissionArgumentKey", () => {
    const tool = createAdmitSkillTool(store, assessAs("safe"), "main");
    expect(tool.inputSchema.properties).toHaveProperty("path");
    expect(tool.permissionArgumentKey).toBe("path");
    expect(tool.boundaries).toEqual([
      { boundaryType: "filesystem", access: "read", dynamic: false },
      { boundaryType: "app-state", access: "write", dynamic: false },
    ]);
    expect(tool.isParallelSafe).toBe(false);
  });
});
