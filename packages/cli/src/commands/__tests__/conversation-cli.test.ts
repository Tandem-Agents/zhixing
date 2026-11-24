import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  encodeProgramConversationTicket,
  PROGRAM_MAX_WAIT_SLICE_MS,
  programHomeId,
  type ProgramConversationReadResult,
  type ProgramConversationResultOutput,
} from "@zhixing-ai/core/conversation/application";
import { RPC_ERROR_CODES, RpcClientClosedError, RpcClientError } from "@zhixing-ai/server/client";
import { createTempDir } from "@zhixing-ai/test-utils";
import { isProductLogWriter } from "../../logging/writer-classification.js";
import { cliLoggingMode, normalizeCliArgs } from "../../logging/entry-mode.js";
import { program } from "../../index.js";
import {
  runConversationListCommand,
  runConversationNewCommand,
  runConversationReadCommand,
  runConversationResultCommand,
  runConversationSendCommand,
} from "../conversation.js";

function captureIO(extra: Partial<Parameters<typeof runConversationListCommand>[1]> = {}) {
  let out = "";
  let err = "";
  return {
    get stdoutText() {
      return out;
    },
    get stderrText() {
      return err;
    },
    io: {
      stdout: {
        write: (chunk: string | Uint8Array) => {
          out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
          return true;
        },
      },
      stderr: {
        write: (chunk: string | Uint8Array) => {
          err += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
          return true;
        },
      },
      ...extra,
    },
  };
}

function fakeConnection(
  handler: (method: string, params: unknown) => Promise<unknown>,
) {
  return () =>
    ({
      facade: {
        ensureConnected: async () => {},
        list: (input: unknown) => handler("conversation.program.list", input),
        create: (input: unknown) => handler("conversation.program.new", input),
        read: (input: unknown) => handler("conversation.program.read", input),
        send: (input: unknown) => handler("conversation.program.send", input),
        result: (input: unknown) => handler("conversation.program.result", input),
      },
      dispose: async () => {},
    }) as never;
}

describe("zz conversation CLI & isolated arg normalization", () => {
  it("keeps cliLoggingMode === 'none' (not a product log writer) and folds option values only for conversation", () => {
    expect(cliLoggingMode(["conversation", "list"])).toBe("none");
    expect(cliLoggingMode(["conversation", "send", "default", "--text=-V"])).toBe("none");
    expect(
      isProductLogWriter(["node", "dist/index.js"], "/tmp/zhixing-home"),
    ).toBe(true);
    expect(
      isProductLogWriter(
        ["node", "dist/index.js", "conversation", "send", "default", "--text", "hi"],
        "/tmp/zhixing-home",
      ),
    ).toBe(false);
    expect(
      isProductLogWriter(
        ["node", "packages/cli/src/entry.ts", "conversation", "list"],
        "/tmp/zhixing-home",
      ),
    ).toBe(false);

    // Non-conversation commands retain exact legacy separator stripping & version flags
    expect(normalizeCliArgs(["-V"])).toEqual(["-V"]);
    expect(normalizeCliArgs(["status", "--version"])).toEqual(["status", "--version"]);
    expect(normalizeCliArgs(["logs", "search", "-V"])).toEqual(["logs", "search", "-V"]);
    expect(normalizeCliArgs(["--", "status"])).toEqual(["status"]);

    // Conversation command preserves literal --, -V, --version, --help values on declared value options
    expect(normalizeCliArgs(["conversation", "send", "default", "--text", "--"])).toEqual([
      "conversation",
      "send",
      "default",
      "--text=--",
    ]);
    expect(normalizeCliArgs(["--", "conversation", "send", "default", "--text", "-V"])).toEqual([
      "conversation",
      "send",
      "default",
      "--text=-V",
    ]);
    expect(normalizeCliArgs(["conversation", "send", "default", "--text", "--version"])).toEqual([
      "conversation",
      "send",
      "default",
      "--text=--version",
    ]);
    expect(normalizeCliArgs(["conversation", "new", "--name", "-V"])).toEqual([
      "conversation",
      "new",
      "--name=-V",
    ]);
    expect(normalizeCliArgs(["conversation", "list", "--query", "--version"])).toEqual([
      "conversation",
      "list",
      "--query=--version",
    ]);
  });

  it("includes the 4 copy-pasteable conversation examples in both root --help and conversation --help", () => {
    const renderHelp = (cmd: typeof program) => {
      let text = "";
      const prev = cmd.configureOutput();
      cmd.configureOutput({ ...prev, writeOut: (chunk) => { text += chunk; } });
      try {
        cmd.outputHelp();
      } finally {
        cmd.configureOutput(prev);
      }
      return text;
    };
    const rootHelp = renderHelp(program);
    const convCmd = program.commands.find((c) => c.name() === "conversation")!;
    const convHelp = renderHelp(convCmd);
    expect(rootHelp.trim()).toBe(program.helpInformation().trim());
    expect(convHelp.trim()).toBe(convCmd.helpInformation().trim());
    for (const helpText of [rootHelp, convHelp]) {
      expect(helpText).toContain("zz conversation list --json");
      expect(helpText).toContain("zz conversation new --scene <sceneId>");
      expect(helpText).toContain("zz conversation send <conversationId> --file message.md");
      expect(helpText).toContain("zz conversation result <ticket> --wait 60");
    }
  });

  it("validates UTF-8 / < 1 MiB budget, pre-flushes ticket before RPC write, slices >30s waits into <=15s hops, and detaches on SIGINT without aborting", async () => {
    const tmp = await createTempDir("conv-cli-send");
    const homeA = path.join(tmp, "home-a");
    const homeB = path.join(tmp, "home-b");

    // 1. Oversized > 1 MiB payload rejected before connecting/writing (exit 1)
    let connected = false;
    const oversizeCap = captureIO({
      zhixingHome: homeA,
      openClient: () => {
        connected = true;
        throw new Error("must not connect");
      },
    });
    const oversizeCode = await runConversationSendCommand(
      "default",
      { text: "中".repeat(400_000), json: true },
      oversizeCap.io,
    );
    expect(oversizeCode).toBe(1);
    expect(connected).toBe(false);
    expect(JSON.parse(oversizeCap.stdoutText)).toMatchObject({
      admitted: false,
      error: { code: "payload_too_large" },
    });

    // 2. Invalid UTF-8 file rejected before writing (exit 1)
    const badFile = path.join(tmp, "bad.bin");
    await writeFile(badFile, Buffer.from([0xff, 0xfe, 0xfd]));
    const badUtf8Cap = captureIO({ zhixingHome: homeA });
    expect(
      await runConversationSendCommand("default", { file: badFile }, badUtf8Cap.io),
    ).toBe(1);

    // 3. Multi-slice wait (> 30s) uses waitMs <= 15_000 deducting elapsed time, and assembles multi-page answer cleanly on stdout
    const waitSlices: number[] = [];
    const methodsCalled: string[] = [];
    let stderrBeforeSend = "";
    const validFile = path.join(tmp, "msg.md");
    const verbatimBody = "/exit\n@file:nonexistent\n```ts\nconst x = '--version';\n```";
    await writeFile(validFile, verbatimBody, "utf8");

    let sentPayload: unknown;
    let pollCount = 0;
    const sendCap = captureIO({
      zhixingHome: homeA,
      openClient: fakeConnection(async (method, params) => {
        methodsCalled.push(method);
        if (method === "conversation.program.send") {
          stderrBeforeSend = sendCap.stderrText;
          sentPayload = params;
          return {
            v: 1,
            admitted: true,
            conversationId: "ws:dev:primary",
            requestId: "req-slice",
            runId: "run-1",
          };
        }
        if (method === "conversation.program.result") {
          const p = params as { waitMs?: number; cursor?: string };
          if (p.cursor === undefined) {
            waitSlices.push(p.waitMs ?? 0);
            pollCount += 1;
            if (pollCount < 3) {
              await new Promise((r) => setTimeout(r, 20));
              return {
                v: 1,
                state: "pending",
                conversationId: "ws:dev:primary",
                requestId: "req-slice",
                runId: "run-1",
                runState: "running",
              } satisfies ProgramConversationResultOutput;
            }
            return {
              v: 1,
              state: "completed",
              conversationId: "ws:dev:primary",
              requestId: "req-slice",
              runId: "run-1",
              runState: "committed",
              answer: "第一页内容-",
              answerTruncated: true,
              nextCursor: "zxbc1.page2",
            } satisfies ProgramConversationResultOutput;
          }
          return {
            v: 1,
            state: "completed",
            conversationId: "ws:dev:primary",
            requestId: "req-slice",
            runId: "run-1",
            runState: "committed",
            answer: "第二页完整收尾",
            answerTruncated: false,
          } satisfies ProgramConversationResultOutput;
        }
        throw new Error(`Unexpected method ${method}`);
      }),
    });

    const okCode = await runConversationSendCommand(
      "ws:dev:primary",
      { file: validFile, id: "req-slice", wait: "45" },
      sendCap.io,
    );
    expect(okCode).toBe(0);
    // Recovery token MUST be flushed to stderr BEFORE conversation.program.send is called
    expect(stderrBeforeSend).toContain("ticket=zxt1.");
    expect(stderrBeforeSend).toContain("requestId=req-slice");
    // Verbatim preservation of /exit, @file:nonexistent, and code blocks
    expect(sentPayload).toEqual({
      conversationId: "ws:dev:primary",
      requestId: "req-slice",
      text: verbatimBody,
    });
    // Pure stdout answer without banner/ticket noise
    expect(sendCap.stdoutText).toBe("第一页内容-第二页完整收尾\n");
    expect(waitSlices.length).toBe(3);
    for (const w of waitSlices) {
      expect(w).toBeLessThanOrEqual(PROGRAM_MAX_WAIT_SLICE_MS);
    }

    // 4. SIGINT during wait detaches locally (exit 2, prints ticket) and NEVER calls session.abort
    const sigBus = new EventEmitter();
    const sigMethods: string[] = [];
    const sigCap = captureIO({
      zhixingHome: homeA,
      signals: sigBus as never,
      openClient: fakeConnection(async (method) => {
        sigMethods.push(method);
        if (method === "conversation.program.send") {
          return {
            v: 1,
            admitted: true,
            conversationId: "default",
            requestId: "req-sig",
            runId: "run-sig",
          };
        }
        setTimeout(() => sigBus.emit("SIGINT"), 15);
        await new Promise((r) => setTimeout(r, 40));
        return {
          v: 1,
          state: "pending",
          conversationId: "default",
          requestId: "req-sig",
          runId: "run-sig",
        };
      }),
    });
    const sigCode = await runConversationSendCommand(
      "default",
      { stdin: true, id: "req-sig", wait: "30" },
      { ...sigCap.io, stdin: Readable.from(["来自管道的多行\n第二行"]) },
    );
    expect(sigCode).toBe(2);
    expect(sigCap.stdoutText.trim().startsWith("zxt1.")).toBe(true);
    expect(sigMethods).not.toContain("session.abort");

    // 5. Transport drop after write returns ticket with exit 3; cross-home ticket rejected with exit 1 while --to + --id works
    const dropCap = captureIO({
      zhixingHome: homeA,
      openClient: fakeConnection(async () => {
        throw new RpcClientClosedError("socket dropped after send");
      }),
    });
    const dropCode = await runConversationSendCommand(
      "default",
      { text: "--version", id: "req-drop" },
      dropCap.io,
    );
    expect(dropCode).toBe(3);
    const ticketFromA = dropCap.stdoutText.trim();
    expect(ticketFromA.startsWith("zxt1.")).toBe(true);

    // Cross-home ticket use in homeB fails with invalid_ticket (exit 1)
    const crossHomeCap = captureIO({ zhixingHome: homeB, openClient: fakeConnection(async () => ({})) });
    expect(
      await runConversationResultCommand(ticketFromA, { json: true }, crossHomeCap.io),
    ).toBe(1);
    expect(JSON.parse(crossHomeCap.stdoutText)).toMatchObject({
      error: { code: "invalid_ticket" },
    });

    // Explicit --to + --id in homeB succeeds (exit 0)
    const explicitCap = captureIO({
      zhixingHome: homeB,
      openClient: fakeConnection(async () => ({
        v: 1,
        state: "completed",
        conversationId: "default",
        requestId: "req-drop",
        runId: "run-drop",
        answer: "恢复查询成功",
        answerTruncated: false,
      })),
    });
    expect(
      await runConversationResultCommand(
        undefined,
        { to: "default", id: "req-drop" },
        explicitCap.io,
      ),
    ).toBe(0);
    expect(explicitCap.stdoutText).toBe("恢复查询成功\n");

    // 6. Legacy host returning -32601:
    //    (a) Brand-new send WITHOUT --id (confirmed never previously admitted) exits 1 (`admitted: false`)
    const legacyFreshCap = captureIO({
      zhixingHome: homeA,
      openClient: fakeConnection(async () => {
        throw new RpcClientError(RPC_ERROR_CODES.METHOD_NOT_FOUND, "Method not found");
      }),
    });
    expect(
      await runConversationSendCommand(
        "default",
        { text: "hello", json: true },
        legacyFreshCap.io,
      ),
    ).toBe(1);
    expect(JSON.parse(legacyFreshCap.stdoutText)).toMatchObject({
      admitted: false,
      error: { code: "unsupported_host_version" },
    });

    //    (b) Explicit replayable `send --id`, `result <ticket>`, and `result --to + --id` preserve ticket and exit 3 (cannot rule out prior acceptance)
    const legacyReplayCap = captureIO({
      zhixingHome: homeA,
      openClient: fakeConnection(async () => {
        throw new RpcClientError(RPC_ERROR_CODES.METHOD_NOT_FOUND, "Method not found");
      }),
    });
    expect(
      await runConversationSendCommand(
        "default",
        { text: "hello", id: "req-legacy", json: true },
        legacyReplayCap.io,
      ),
    ).toBe(3);
    const replayParsed = JSON.parse(legacyReplayCap.stdoutText);
    expect(replayParsed.admitted).toBeUndefined();
    expect(replayParsed.ticket).toMatch(/^zxt1\./u);
    expect(replayParsed.error.code).toBe("unsupported_host_version");

    const legacyResultTicketCap = captureIO({
      zhixingHome: homeA,
      openClient: fakeConnection(async () => {
        throw new RpcClientError(RPC_ERROR_CODES.METHOD_NOT_FOUND, "Method not found");
      }),
    });
    expect(
      await runConversationResultCommand(
        replayParsed.ticket,
        { json: true },
        legacyResultTicketCap.io,
      ),
    ).toBe(3);
    expect(JSON.parse(legacyResultTicketCap.stdoutText).ticket).toBe(replayParsed.ticket);

    const legacyResultPairCap = captureIO({
      zhixingHome: homeA,
      openClient: fakeConnection(async () => {
        throw new RpcClientError(RPC_ERROR_CODES.METHOD_NOT_FOUND, "Method not found");
      }),
    });
    expect(
      await runConversationResultCommand(
        undefined,
        { to: "default", id: "req-legacy", json: true },
        legacyResultPairCap.io,
      ),
    ).toBe(3);
    expect(JSON.parse(legacyResultPairCap.stdoutText).ticket).toBe(replayParsed.ticket);
  });

  it("reassembles multi-frame read pages and retries cursor_expired when --before is omitted", async () => {
    const tmp = await createTempDir("conv-cli-read");
    let attempt = 0;
    const readCap = captureIO({
      zhixingHome: tmp,
      openClient: fakeConnection(async (_method, params) => {
        const p = params as { before?: string };
        attempt += 1;
        if (attempt === 1) {
          return {
            v: 1,
            conversationId: "default",
            scope: "main",
            entries: [
              {
                runId: "r1",
                runIndex: 0,
                messageIndex: 1,
                blockIndex: 0,
                role: "assistant",
                type: "text",
                text: "后半段",
                offset: 3,
                length: 6,
                final: true,
              },
            ],
            inputsOutsideHistory: [],
            inputsOutsideHistoryTruncated: false,
            hasMore: true,
            nextBefore: "zxbc1.old",
          } satisfies ProgramConversationReadResult;
        }
        if (attempt === 2 && p.before === "zxbc1.old") {
          throw new RpcClientError(-32000, "expired", {
            programError: { code: "cursor_expired", retryable: true, exitCode: 3 },
          });
        }
        return {
          v: 1,
          conversationId: "default",
          scope: "main",
          entries: [
            {
              runId: "r1",
              runIndex: 0,
              messageIndex: 0,
              blockIndex: 0,
              role: "user",
              type: "text",
              text: "外部问题",
              offset: 0,
              length: 4,
              final: true,
              programOrigin: true,
            },
            {
              runId: "r1",
              runIndex: 0,
              messageIndex: 1,
              blockIndex: 0,
              role: "assistant",
              type: "text",
              text: "完整回复",
              offset: 0,
              length: 4,
              final: true,
            },
          ],
          inputsOutsideHistory: [],
          inputsOutsideHistoryTruncated: false,
          hasMore: false,
        } satisfies ProgramConversationReadResult;
      }),
    });

    expect(await runConversationReadCommand("default", { limit: "1" }, readCap.io)).toBe(0);
    expect(readCap.stdoutText).toContain("◇ 来自外部程序:\n外部问题");
    expect(readCap.stdoutText).toContain("● 助手:\n完整回复");

    // Mutually exclusive --name and --scene on `new` exits 1 without RPC
    const newCap = captureIO({ zhixingHome: tmp });
    expect(
      await runConversationNewCommand({ name: "A", scene: "scene-1" }, newCap.io),
    ).toBe(1);

    // Structured non-retryable `not_found` thrown by `conversation.program.send` exits 1 (`admitted: false`), NOT 3
    const notFoundCap = captureIO({
      zhixingHome: tmp,
      openClient: fakeConnection(async () => {
        throw new RpcClientError(-32000, "not found", {
          programError: { code: "not_found", retryable: false, exitCode: 1 },
        });
      }),
    });
    expect(
      await runConversationSendCommand(
        "local-deadbeef-missing",
        { text: "hello", json: true },
        notFoundCap.io,
      ),
    ).toBe(1);
    expect(JSON.parse(notFoundCap.stdoutText)).toMatchObject({
      admitted: false,
      error: { code: "not_found" },
    });

    const homeId = await programHomeId(tmp);
    expect(encodeProgramConversationTicket({ homeId, conversationId: "default", requestId: "r1" })).toContain("zxt1.");
  });

  it("awaits stderr recovery-line flush before submitting RPC and preserves admitted status on post-admission -32601/auth errors", async () => {
    const tmp = await createTempDir("conv-cli-flush-and-version");

    // 1. Delayed Node Writable stderr: recovery-line-flushed MUST precede openClient & rpc-send/rpc-create
    const sendTimeline: string[] = [];
    const delayedSendStderr = new Writable({
      write(_chunk, _enc, cb) {
        setTimeout(() => {
          sendTimeline.push("recovery-line-flushed");
          cb();
        }, 35);
      },
    });
    const delayedSendCap = captureIO({
      zhixingHome: tmp,
      stderr: delayedSendStderr,
      openClient: () => {
        sendTimeline.push("open-client");
        return fakeConnection(async (method) => {
          sendTimeline.push(`rpc:${method}`);
          if (method === "conversation.program.send") {
            return {
              v: 1,
              admitted: true,
              conversationId: "default",
              requestId: "req-delayed",
              runId: "run-delayed",
            };
          }
          return {
            v: 1,
            state: "completed",
            conversationId: "default",
            requestId: "req-delayed",
            runId: "run-delayed",
            runState: "committed",
            answer: "ok",
            answerTruncated: false,
          };
        })();
      },
    });
    expect(
      await runConversationSendCommand(
        "default",
        { text: "hello", id: "req-delayed", wait: "5" },
        delayedSendCap.io,
      ),
    ).toBe(0);
    expect(sendTimeline[0]).toBe("recovery-line-flushed");
    expect(sendTimeline.slice(0, 3)).toEqual([
      "recovery-line-flushed",
      "open-client",
      "rpc:conversation.program.send",
    ]);

    const newTimeline: string[] = [];
    const delayedNewStderr = new Writable({
      write(_chunk, _enc, cb) {
        setTimeout(() => {
          newTimeline.push("recovery-line-flushed");
          cb();
        }, 30);
      },
    });
    const delayedNewCap = captureIO({
      zhixingHome: tmp,
      stderr: delayedNewStderr,
      openClient: () => {
        newTimeline.push("open-client");
        return fakeConnection(async (method) => {
          newTimeline.push(`rpc:${method}`);
          return {
            v: 1,
            conversationId: "chat-new-1",
            scope: "main",
            created: true,
          };
        })();
      },
    });
    expect(
      await runConversationNewCommand(
        { name: "延迟写测", id: "req-new-delayed" },
        delayedNewCap.io,
      ),
    ).toBe(0);
    expect(newTimeline).toEqual([
      "recovery-line-flushed",
      "open-client",
      "rpc:conversation.program.new",
    ]);

    // 2. Failing Node Writable stderr: zero RPC submission on both `send` and `new`
    let failingClientOpened = 0;
    const makeFailingStderr = () =>
      new Writable({
        write(_chunk, _enc, cb) {
          setTimeout(() => cb(new Error("EPIPE simulated")), 10);
        },
      });
    const failSendCap = captureIO({
      zhixingHome: tmp,
      stderr: makeFailingStderr(),
      openClient: () => {
        failingClientOpened += 1;
        return fakeConnection(async () => ({}))();
      },
    });
    expect(
      await runConversationSendCommand(
        "default",
        { text: "should-not-send", json: true },
        failSendCap.io,
      ),
    ).toBe(1);
    expect(failingClientOpened).toBe(0);
    expect(JSON.parse(failSendCap.stdoutText)).toMatchObject({
      admitted: false,
    });

    const failNewCap = captureIO({
      zhixingHome: tmp,
      stderr: makeFailingStderr(),
      openClient: () => {
        failingClientOpened += 1;
        return fakeConnection(async () => ({}))();
      },
    });
    expect(
      await runConversationNewCommand(
        { name: "should-not-create", json: true },
        failNewCap.io,
      ),
    ).toBe(1);
    expect(failingClientOpened).toBe(0);

    // 3. `send` already received admitted=true & runId, then subsequent `result` returns -32601 or UNAUTHORIZED -> MUST exit 3 with ticket & admitted=true, NEVER exit 1
    for (const errCode of [RPC_ERROR_CODES.METHOD_NOT_FOUND, RPC_ERROR_CODES.UNAUTHORIZED]) {
      const postAdmitCap = captureIO({
        zhixingHome: tmp,
        openClient: fakeConnection(async (method) => {
          if (method === "conversation.program.send") {
            return {
              v: 1,
              admitted: true,
              conversationId: "default",
              requestId: `req-post-${errCode}`,
              runId: "run-already-admitted",
            };
          }
          throw new RpcClientError(errCode, "Simulated host downgrade/auth rotation");
        }),
      });
      const exitCode = await runConversationSendCommand(
        "default",
        { text: "already admitted", id: `req-post-${errCode}`, wait: "0.05", json: true },
        postAdmitCap.io,
      );
      expect(exitCode).toBe(3);
      const parsed = JSON.parse(postAdmitCap.stdoutText);
      expect(parsed).toMatchObject({
        v: 1,
        state: "temporarily_unavailable",
        admitted: true,
        runId: "run-already-admitted",
      });
      expect(parsed.ticket).toMatch(/^zxt1\./u);
    }

    // 4. SIGINT observation detach truthfulness:
    //    (a) Never-observed `result --wait` interrupted before first RPC response -> exits 3 (`state: "unknown"`), NOT `pending` (2)
    const unsubmittedSig = new EventEmitter();
    const unsubmittedCap = captureIO({
      zhixingHome: tmp,
      signals: unsubmittedSig as never,
      openClient: fakeConnection(async () => {
        setTimeout(() => unsubmittedSig.emit("SIGINT"), 15);
        await new Promise((r) => setTimeout(r, 60));
        throw new Error("aborted before first authoritative response");
      }),
    });
    expect(
      await runConversationResultCommand(
        undefined,
        { to: "default", id: "never-submitted", wait: "10", json: true },
        unsubmittedCap.io,
      ),
    ).toBe(3);
    expect(JSON.parse(unsubmittedCap.stdoutText)).toMatchObject({
      v: 1,
      state: "unknown",
      conversationId: "default",
      requestId: "never-submitted",
    });

    //    (b) `send` already received `admitted: true, runId` then interrupted by SIGINT -> exits 2 (`state: "pending"`) AND retains `runId` + `admitted: true`
    const knownAdmittedSig = new EventEmitter();
    const knownAdmittedCap = captureIO({
      zhixingHome: tmp,
      signals: knownAdmittedSig as never,
      openClient: fakeConnection(async (method) => {
        if (method === "conversation.program.send") {
          return {
            v: 1,
            admitted: true,
            conversationId: "default",
            requestId: "known-admitted-sig",
            runId: "run-known-sig-1",
          };
        }
        setTimeout(() => knownAdmittedSig.emit("SIGINT"), 15);
        await new Promise((r) => setTimeout(r, 60));
        throw new Error("aborted during poll");
      }),
    });
    expect(
      await runConversationSendCommand(
        "default",
        { text: "keep runId", id: "known-admitted-sig", wait: "10", json: true },
        knownAdmittedCap.io,
      ),
    ).toBe(2);
    expect(JSON.parse(knownAdmittedCap.stdoutText)).toMatchObject({
      v: 1,
      state: "pending",
      admitted: true,
      conversationId: "default",
      requestId: "known-admitted-sig",
      runId: "run-known-sig-1",
    });

    //    (c) `result --wait` observed authoritative `pending` on slice 1, then SIGINT on slice 2 -> exits 2 (`state: "pending"`) AND retains `runId` + `runState`
    const polledPendingSig = new EventEmitter();
    let resultSlice = 0;
    const polledPendingCap = captureIO({
      zhixingHome: tmp,
      signals: polledPendingSig as never,
      openClient: fakeConnection(async () => {
        resultSlice += 1;
        if (resultSlice === 1) {
          return {
            v: 1,
            state: "pending",
            conversationId: "default",
            requestId: "polled-pending-sig",
            runId: "run-polled-sig-2",
            runState: "running",
          };
        }
        setTimeout(() => polledPendingSig.emit("SIGINT"), 15);
        await new Promise((r) => setTimeout(r, 60));
        throw new Error("aborted on slice 2");
      }),
    });
    expect(
      await runConversationResultCommand(
        undefined,
        { to: "default", id: "polled-pending-sig", wait: "10", json: true },
        polledPendingCap.io,
      ),
    ).toBe(2);
    expect(JSON.parse(polledPendingCap.stdoutText)).toMatchObject({
      v: 1,
      state: "pending",
      conversationId: "default",
      requestId: "polled-pending-sig",
      runId: "run-polled-sig-2",
      runState: "running",
    });
  });
});
