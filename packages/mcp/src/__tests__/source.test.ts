import { describe, expect, it } from "vitest";
import { fetchMcpServerSource, type HttpGetText } from "../source.js";

/** 按 url 路由的 mock GET——不真联网。 */
function mockGet(routes: Record<string, { status: number; body: string }>): HttpGetText {
  return async (url) => {
    for (const [needle, res] of Object.entries(routes)) {
      if (url.includes(needle)) return res;
    }
    return { status: 404, body: "" };
  };
}

const REG = "registry.npmmirror.com";
const CDN = "cdn.jsdelivr.net";

describe("fetchMcpServerSource", () => {
  it("packument 顶层 readme → found（带 README + 主页）", async () => {
    const httpGetText = mockGet({
      [REG]: {
        status: 200,
        body: JSON.stringify({
          name: "x",
          "dist-tags": { latest: "1.0.0" },
          readme: "# X\n设置说明",
          versions: { "1.0.0": { homepage: "https://x.dev" } },
        }),
      },
    });
    const r = await fetchMcpServerSource("x", { httpGetText });
    expect(r).toEqual({ kind: "found", readme: "# X\n设置说明", homepage: "https://x.dev" });
  });

  it("顶层无 readme → 取 latest 版本的 readme", async () => {
    const httpGetText = mockGet({
      [REG]: {
        status: 200,
        body: JSON.stringify({
          "dist-tags": { latest: "2.0.0" },
          versions: { "2.0.0": { readme: "版本内 README" } },
        }),
      },
    });
    const r = await fetchMcpServerSource("x", { httpGetText });
    expect(r.kind).toBe("found");
    if (r.kind === "found") expect(r.readme).toBe("版本内 README");
  });

  it("registry 无 readme → 回退 jsdelivr 取 README.md", async () => {
    const httpGetText = mockGet({
      [REG]: { status: 200, body: JSON.stringify({ "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": {} } }) },
      [CDN]: { status: 200, body: "来自 jsdelivr 的 README" },
    });
    const r = await fetchMcpServerSource("x", { httpGetText });
    expect(r.kind).toBe("found");
    if (r.kind === "found") expect(r.readme).toBe("来自 jsdelivr 的 README");
  });

  it("registry 与 jsdelivr 都无 README → found 但 readme 空（上层据此走诚实提示）", async () => {
    const httpGetText = mockGet({
      [REG]: { status: 200, body: JSON.stringify({ "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": {} } }) },
      // CDN 未命中 → mock 默认 404
    });
    const r = await fetchMcpServerSource("x", { httpGetText });
    expect(r.kind).toBe("found");
    if (r.kind === "found") expect(r.readme).toBe("");
  });

  it("404 → not-found（确不存在，区别于查询失败）", async () => {
    const httpGetText = mockGet({ [REG]: { status: 404, body: "" } });
    expect(await fetchMcpServerSource("nope", { httpGetText })).toEqual({ kind: "not-found" });
  });

  it("网络抛错 → error（查询失败，不等同没这个包）", async () => {
    const httpGetText: HttpGetText = async () => {
      throw new Error("ECONNRESET");
    };
    const r = await fetchMcpServerSource("x", { httpGetText });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.reason).toContain("ECONNRESET");
  });

  it("非 200/404（如 500）→ error", async () => {
    const httpGetText = mockGet({ [REG]: { status: 500, body: "oops" } });
    const r = await fetchMcpServerSource("x", { httpGetText });
    expect(r.kind).toBe("error");
  });

  it("响应非 JSON → error", async () => {
    const httpGetText = mockGet({ [REG]: { status: 200, body: "<html>not json" } });
    const r = await fetchMcpServerSource("x", { httpGetText });
    expect(r.kind).toBe("error");
  });
});
