/**
 * Registry 内部一致性测试——把"约定"提升为机器可执行的契约。
 *
 * 这些约定之前靠注释 + reviewer 维护，现在用单测兜底——任何违反约定的提交直接挂 CI。
 */

import { describe, expect, it } from "vitest";
import { SUPPORTED_PROVIDERS } from "../providers-registry.js";
import { SUPPORTED_CHANNELS } from "../channels-registry.js";

const URL_PATTERN = /https?:\/\//i;

describe("providers-registry 一致性", () => {
  it("apiKeyHint 不得内嵌 URL（URL 走 docUrl 字段，单独渲染为可点击行）", () => {
    for (const p of SUPPORTED_PROVIDERS) {
      expect(p.apiKeyHint, `provider ${p.id} apiKeyHint 含 URL`).not.toMatch(
        URL_PATTERN,
      );
    }
  });

  it("docUrl（如声明）必须是 http(s) 协议", () => {
    for (const p of SUPPORTED_PROVIDERS) {
      if (p.docUrl !== undefined) {
        expect(p.docUrl, `provider ${p.id} docUrl 非 http(s)`).toMatch(
          URL_PATTERN,
        );
      }
    }
  });

  it("id 唯一", () => {
    const ids = SUPPORTED_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("channels-registry 一致性", () => {
  it("field.hint 不得内嵌 URL（URL 走 field.docUrl 字段）", () => {
    for (const c of SUPPORTED_CHANNELS) {
      for (const f of c.requiredFields) {
        expect(
          f.hint,
          `channel ${c.id} field ${f.id} hint 含 URL`,
        ).not.toMatch(URL_PATTERN);
      }
    }
  });

  it("field.docUrl（如声明）必须是 http(s) 协议", () => {
    for (const c of SUPPORTED_CHANNELS) {
      for (const f of c.requiredFields) {
        if (f.docUrl !== undefined) {
          expect(
            f.docUrl,
            `channel ${c.id} field ${f.id} docUrl 非 http(s)`,
          ).toMatch(URL_PATTERN);
        }
      }
    }
  });

  it("channel id 唯一", () => {
    const ids = SUPPORTED_CHANNELS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每个 channel 内部 field.id 唯一", () => {
    for (const c of SUPPORTED_CHANNELS) {
      const fids = c.requiredFields.map((f) => f.id);
      expect(new Set(fids).size, `channel ${c.id} 字段 id 不唯一`).toBe(
        fids.length,
      );
    }
  });
});
