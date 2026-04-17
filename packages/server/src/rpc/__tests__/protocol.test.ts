import { describe, it, expect } from "vitest";
import {
  parseMessage,
  encodeRequest,
  encodeNotification,
  encodeSuccess,
  encodeError,
  isRequest,
  isNotification,
  isResponse,
  isSuccessResponse,
  isErrorResponse,
  RPC_ERROR_CODES,
} from "../protocol.js";

describe("JSON-RPC 2.0 protocol", () => {
  describe("parseMessage", () => {
    it("parses a valid request", () => {
      const text = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "auth",
        params: { token: "abc" },
      });
      const result = parseMessage(text);
      expect(result.kind).toBe("request");
      if (result.kind === "request") {
        expect(result.message.id).toBe(1);
        expect(result.message.method).toBe("auth");
        expect(result.message.params).toEqual({ token: "abc" });
      }
    });

    it("parses a request with string id", () => {
      const text = JSON.stringify({ jsonrpc: "2.0", id: "req-001", method: "health" });
      const result = parseMessage(text);
      expect(result.kind).toBe("request");
      if (result.kind === "request") {
        expect(result.message.id).toBe("req-001");
      }
    });

    it("parses a notification (no id)", () => {
      const text = JSON.stringify({
        jsonrpc: "2.0",
        method: "session.delta",
        params: { sessionId: "s1", delta: { text: "hello" } },
      });
      const result = parseMessage(text);
      expect(result.kind).toBe("notification");
      if (result.kind === "notification") {
        expect(result.message.method).toBe("session.delta");
      }
    });

    it("parses a success response", () => {
      const text = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } });
      const result = parseMessage(text);
      expect(result.kind).toBe("response");
      if (result.kind === "response" && isSuccessResponse(result.message)) {
        expect(result.message.result).toEqual({ ok: true });
      }
    });

    it("parses an error response", () => {
      const text = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: "Method not found" },
      });
      const result = parseMessage(text);
      expect(result.kind).toBe("response");
      if (result.kind === "response" && isErrorResponse(result.message)) {
        expect(result.message.error.code).toBe(-32601);
      }
    });

    it("returns parse error for invalid JSON", () => {
      const result = parseMessage("not json {");
      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.error.code).toBe(RPC_ERROR_CODES.PARSE_ERROR);
        expect(result.id).toBeNull();
      }
    });

    it("returns invalid request for missing jsonrpc field", () => {
      const text = JSON.stringify({ id: 1, method: "auth" });
      const result = parseMessage(text);
      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.error.code).toBe(RPC_ERROR_CODES.INVALID_REQUEST);
        // Should still extract id even when invalid
        expect(result.id).toBe(1);
      }
    });

    it("returns invalid request for wrong jsonrpc version", () => {
      const text = JSON.stringify({ jsonrpc: "1.0", id: 1, method: "auth" });
      const result = parseMessage(text);
      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.error.code).toBe(RPC_ERROR_CODES.INVALID_REQUEST);
      }
    });

    it("rejects array (batch) — MVP doesn't support batches", () => {
      const text = JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "auth" }]);
      const result = parseMessage(text);
      expect(result.kind).toBe("error");
    });

    it("rejects request without method", () => {
      const text = JSON.stringify({ jsonrpc: "2.0", id: 1 });
      const result = parseMessage(text);
      expect(result.kind).toBe("error");
    });
  });

  describe("type guards", () => {
    it("isRequest distinguishes request from notification", () => {
      expect(isRequest({ jsonrpc: "2.0", id: 1, method: "x" })).toBe(true);
      expect(isRequest({ jsonrpc: "2.0", method: "x" })).toBe(false);
    });

    it("isNotification requires no id field", () => {
      expect(isNotification({ jsonrpc: "2.0", method: "x" })).toBe(true);
      expect(isNotification({ jsonrpc: "2.0", id: 1, method: "x" })).toBe(false);
    });

    it("isResponse detects both success and error responses", () => {
      expect(isResponse({ jsonrpc: "2.0", id: 1, result: 1 })).toBe(true);
      expect(isResponse({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "x" } })).toBe(true);
      expect(isResponse({ jsonrpc: "2.0", id: 1, method: "x" })).toBe(false);
    });
  });

  describe("encoders", () => {
    it("encodeRequest produces valid JSON-RPC request", () => {
      const text = encodeRequest(1, "auth", { token: "abc" });
      const parsed = JSON.parse(text);
      expect(parsed).toEqual({
        jsonrpc: "2.0",
        id: 1,
        method: "auth",
        params: { token: "abc" },
      });
    });

    it("encodeRequest omits params when undefined", () => {
      const text = encodeRequest(1, "health");
      const parsed = JSON.parse(text);
      expect(parsed).toEqual({ jsonrpc: "2.0", id: 1, method: "health" });
      expect("params" in parsed).toBe(false);
    });

    it("encodeNotification produces a notification (no id)", () => {
      const text = encodeNotification("session.delta", { text: "hi" });
      const parsed = JSON.parse(text);
      expect(parsed).toEqual({
        jsonrpc: "2.0",
        method: "session.delta",
        params: { text: "hi" },
      });
      expect("id" in parsed).toBe(false);
    });

    it("encodeSuccess produces success response", () => {
      const text = encodeSuccess(1, { sessionId: "s1" });
      const parsed = JSON.parse(text);
      expect(parsed).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: { sessionId: "s1" },
      });
    });

    it("encodeError produces error response", () => {
      const text = encodeError(1, { code: -32601, message: "Method not found" });
      const parsed = JSON.parse(text);
      expect(parsed).toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: "Method not found" },
      });
    });

    it("encodeSuccess preserves null id (parse error response)", () => {
      const text = encodeSuccess(null, { ok: true });
      const parsed = JSON.parse(text);
      expect(parsed.id).toBeNull();
    });

    it("encodeSuccess coerces undefined result to null (spec compliance)", () => {
      const text = encodeSuccess(1, undefined);
      const parsed = JSON.parse(text);
      expect(parsed).toEqual({ jsonrpc: "2.0", id: 1, result: null });
      expect("result" in parsed).toBe(true);
    });
  });

  describe("round-trip", () => {
    it("encode then parse yields same request", () => {
      const text = encodeRequest("req-1", "session.send", { text: "hello" });
      const result = parseMessage(text);
      expect(result.kind).toBe("request");
      if (result.kind === "request") {
        expect(result.message.id).toBe("req-1");
        expect(result.message.method).toBe("session.send");
        expect(result.message.params).toEqual({ text: "hello" });
      }
    });

    it("encode then parse yields same notification", () => {
      const text = encodeNotification("schedule.started", { taskId: "t1" });
      const result = parseMessage(text);
      expect(result.kind).toBe("notification");
      if (result.kind === "notification") {
        expect(result.message.method).toBe("schedule.started");
        expect(result.message.params).toEqual({ taskId: "t1" });
      }
    });
  });
});
