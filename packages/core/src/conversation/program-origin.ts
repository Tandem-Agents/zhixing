import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import { expandUserHome } from "../paths.js";
import { canonicalize, protocolDigest } from "../protocol/canonical.js";
import { isProtocolIdentifier } from "../protocol/validation.js";

export const PROGRAM_SURFACE_PRINCIPAL = "program:local" as const;
export const PROGRAM_TURN_CHANNEL = "program" as const;
export const PROGRAM_TICKET_PREFIX = "zxt1." as const;

export interface ProgramOriginIngressLike {
  readonly kind?: string;
  readonly surfacePrincipal?: string;
  readonly turnOrigin?: { readonly channel?: string } | null;
}

/**
 * Trusted three-field predicate for external program admissions.
 * Managed channels always have `kind === "channel"`, so even a channel with
 * `channelId === "program"` never matches this predicate.
 */
export function isProgramOrigin(
  ingress: ProgramOriginIngressLike | null | undefined,
): boolean {
  return (
    !!ingress &&
    ingress.kind === "first-party" &&
    ingress.surfacePrincipal === PROGRAM_SURFACE_PRINCIPAL &&
    ingress.turnOrigin?.channel === PROGRAM_TURN_CHANNEL
  );
}

/**
 * Derives a deterministic, target-isolated physical ingress/turn key from
 * `(conversationId, requestId)` so identical `--id` values across distinct
 * conversations never collide under the shared `program:local` principal.
 */
export function programConversationTurnId(
  conversationId: string,
  requestId: string,
): string {
  return `prog-${protocolDigest("ProgramConversationIngress", 1, {
    conversationId,
    requestId,
  })}`;
}

/**
 * Computes a deterministic caller-home identifier bound to the resolved
 * `ZHIXING_HOME` path (realpath when present, case-normalized on Windows).
 */
export function programHomeId(zhixingHome: string): string {
  const expanded = path.resolve(expandUserHome(zhixingHome));
  let resolved = expanded;
  try {
    resolved = fs.realpathSync.native
      ? fs.realpathSync.native(expanded)
      : fs.realpathSync(expanded);
  } catch {
    resolved = expanded;
  }
  const normalized =
    process.platform === "win32" ? resolved.toLowerCase() : resolved;
  return protocolDigest("ProgramConversationHome", 1, { path: normalized });
}

export interface ProgramConversationTicketPayload {
  readonly v: 1;
  readonly homeId: string;
  readonly conversationId: string;
  readonly requestId: string;
}

export function encodeProgramConversationTicket(input: {
  readonly homeId: string;
  readonly conversationId: string;
  readonly requestId: string;
}): string {
  if (!input.homeId || typeof input.homeId !== "string") {
    throw new TypeError("Program conversation ticket requires homeId");
  }
  if (!isProtocolIdentifier(input.conversationId)) {
    throw new TypeError("Program conversation ticket requires a valid conversationId");
  }
  if (!isProtocolIdentifier(input.requestId)) {
    throw new TypeError("Program conversation ticket requires a valid requestId");
  }
  const payload: ProgramConversationTicketPayload = {
    v: 1,
    homeId: input.homeId,
    conversationId: input.conversationId,
    requestId: input.requestId,
  };
  const encoded = Buffer.from(canonicalize(payload), "utf8").toString(
    "base64url",
  );
  return `${PROGRAM_TICKET_PREFIX}${encoded}`;
}

export type DecodedProgramConversationTicket =
  | { readonly ok: true; readonly payload: ProgramConversationTicketPayload }
  | { readonly ok: false; readonly code: "invalid_ticket"; readonly message: string };

export function decodeProgramConversationTicket(
  ticket: string,
): DecodedProgramConversationTicket {
  if (
    typeof ticket !== "string" ||
    !ticket.startsWith(PROGRAM_TICKET_PREFIX) ||
    ticket.length <= PROGRAM_TICKET_PREFIX.length ||
    ticket.length > 4096
  ) {
    return {
      ok: false,
      code: "invalid_ticket",
      message: "票据格式无效，请使用同一 ZHIXING_HOME 签发的 zxt1 票据或改用 --to <ID> --id <请求ID>。",
    };
  }
  const rawSegment = ticket.slice(PROGRAM_TICKET_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(rawSegment)) {
    return {
      ok: false,
      code: "invalid_ticket",
      message: "票据编码无效，请检查是否完整复制。",
    };
  }
  let parsed: unknown;
  try {
    const bytes = Buffer.from(rawSegment, "base64url");
    if (bytes.toString("base64url") !== rawSegment) {
      return {
        ok: false,
        code: "invalid_ticket",
        message: "票据编码不规范，请检查是否完整复制。",
      };
    }
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return {
      ok: false,
      code: "invalid_ticket",
      message: "票据内容无法解析，请检查是否完整复制。",
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      code: "invalid_ticket",
      message: "票据结构无效。",
    };
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
      "conversationId,homeId,requestId,v" ||
    record.v !== 1 ||
    typeof record.homeId !== "string" ||
    record.homeId.length === 0 ||
    typeof record.conversationId !== "string" ||
    !isProtocolIdentifier(record.conversationId) ||
    typeof record.requestId !== "string" ||
    !isProtocolIdentifier(record.requestId)
  ) {
    return {
      ok: false,
      code: "invalid_ticket",
      message: "票据字段无效。",
    };
  }
  return {
    ok: true,
    payload: {
      v: 1,
      homeId: record.homeId,
      conversationId: record.conversationId,
      requestId: record.requestId,
    },
  };
}

export function verifyProgramConversationTicket(
  ticket: string,
  expectedHomeId: string,
): DecodedProgramConversationTicket {
  const decoded = decodeProgramConversationTicket(ticket);
  if (!decoded.ok) return decoded;
  if (decoded.payload.homeId !== expectedHomeId) {
    return {
      ok: false,
      code: "invalid_ticket",
      message:
        "该票据属于另一个 ZHIXING_HOME，不能跨实例直接复用；若当前环境获准访问同一目标对话，请使用 zz conversation result --to <对话ID> --id <请求ID>。",
    };
  }
  return decoded;
}
