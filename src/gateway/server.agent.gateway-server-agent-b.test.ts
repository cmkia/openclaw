import { once } from "node:events";
import { beforeEach, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import { AcpRuntimeError } from "../acp/runtime/errors.js";
import {
  listSessionPendingInputs,
  loadSessionEntry,
  loadTranscriptEventsSync,
} from "../config/sessions/session-accessor.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { registerAgentRunContext } from "../infra/agent-run-registry.js";
import { readAgentCommandCall } from "./agent-command.test-helpers.js";
import { refusePendingInputCommit } from "./pending-input-commit.test-support.js";
import { installConnectedSessionStoreGatewaySuite } from "./test-helpers.connected-session-store.js";
import {
  agentCommandMock,
  connectOk,
  connectWebchatClient,
  installGatewayTestHooks,
  onceMessage,
  prepareGatewayReplyRuntimeForTest,
  rpcReq,
  testState,
  trackConnectChallengeNonce,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const gatewaySuite = installConnectedSessionStoreGatewaySuite("openclaw-gw-agent-");

async function writeMainSessionEntry(sessionId: string) {
  await writeSessionStore({ entries: { main: { sessionId, updatedAt: Date.now() } } });
  return {
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId,
    storePath: gatewaySuite.sessionStorePath,
  };
}

async function sendAgentWsRequest(
  reqId: string,
  params: { message: string; idempotencyKey: string; sessionKey?: string },
) {
  await prepareGatewayReplyRuntimeForTest();
  gatewaySuite.ws.send(JSON.stringify({ type: "req", id: reqId, method: "agent", params }));
}

function agentResponse(id: string, accepted = false) {
  return onceMessage(
    gatewaySuite.ws,
    (message) =>
      message.type === "res" &&
      message.id === id &&
      (message.payload?.status === "accepted") === accepted,
  );
}

beforeEach(async () => {
  vi.mocked(agentCommandMock).mockClear();
  testState.allowFrom = undefined;
  testState.sessionStorePath = gatewaySuite.sessionStorePath;
  await writeSessionStore({ entries: {} });
});

test("write-scoped callers cannot reset conversations", async () => {
  const scope = await writeMainSessionEntry("sess-main-before-write-reset");
  const writeWs = new WebSocket(gatewaySuite.ws.url);
  trackConnectChallengeNonce(writeWs);
  try {
    await once(writeWs, "open");
    await connectOk(writeWs, { scopes: ["operator.write"] });
    expect(await rpcReq(writeWs, "sessions.reset", { key: "main" })).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("missing scope: operator.admin") },
    });
    expect(loadSessionEntry(scope)?.sessionId).toBe("sess-main-before-write-reset");
    expect(agentCommandMock).not.toHaveBeenCalled();
  } finally {
    writeWs.close();
  }
});

test.each(["completion", "abort"] as const)(
  "a hanging agent dispatch durably admits its turn before ACK and %s",
  async (outcome) => {
    const scope = await writeMainSessionEntry(`sess-durable-agent-${outcome}`);
    const runId = `idem-agent-durable-${outcome}`;
    const content = "keep this aborted agent turn queryable";
    const dispatch = createDeferred<unknown>();
    vi.mocked(agentCommandMock).mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[0] as { abortSignal?: AbortSignal };
      const finish = () => {
        const reason = options.abortSignal?.reason;
        dispatch.reject(reason instanceof Error ? reason : new Error("agent run aborted"));
      };
      options.abortSignal?.addEventListener("abort", finish, { once: true });
      try {
        return await dispatch.promise;
      } finally {
        options.abortSignal?.removeEventListener("abort", finish);
      }
    });
    const ackP = agentResponse(runId, true);
    const finalP = agentResponse(runId);

    try {
      await sendAgentWsRequest(runId, {
        message: content,
        sessionKey: "main",
        idempotencyKey: runId,
      });
      expect((await ackP).payload).toMatchObject({ runId, status: "accepted" });
      expect(loadTranscriptEventsSync(scope)).toEqual([]);
      const userMessage = { role: "user", content };
      const expectPending = async (
        state: "queued" | "cancelled",
        message: Record<string, string> = userMessage,
      ) =>
        expect(await listSessionPendingInputs(scope)).toMatchObject({
          total: 1,
          items: [{ runId, state, message }],
        });
      await expectPending("queued", { ...userMessage, idempotencyKey: `${runId}:user` });

      await readAgentCommandCall({ runId });
      if (outcome === "abort") {
        const aborted = await rpcReq(gatewaySuite.ws, "chat.abort", { runId, sessionKey: "main" });
        expect(aborted.ok).toBe(true);
      } else {
        dispatch.resolve({ payloads: [{ text: "ok" }], meta: { durationMs: 1 } });
      }
      const final = await finalP;
      if (outcome === "abort") {
        expect(final.payload).toMatchObject({ runId, status: "timeout", stopReason: "rpc" });
        expect(loadTranscriptEventsSync(scope)).toEqual([]);
        await expectPending("cancelled");
      } else {
        expect(final.payload).toMatchObject({ runId, status: "ok" });
      }
    } finally {
      dispatch.resolve({ payloads: [{ text: "ok" }], meta: { durationMs: 1 } });
      await Promise.allSettled([ackP, finalP]);
    }
  },
);

test("agent returns a wire error when durable user-turn admission fails", async () => {
  await writeMainSessionEntry("sess-durable-agent-failure");
  using refusal = refusePendingInputCommit({
    operation: "stage",
    message: "injected agent transcript admission failure",
    sessionId: "sess-durable-agent-failure",
    runId: "idem-agent-durable-failure",
  });
  const response = await rpcReq(gatewaySuite.ws, "agent", {
    message: "this turn must not be acknowledged",
    sessionKey: "main",
    idempotencyKey: "idem-agent-durable-failure",
  });
  expect(response).toMatchObject({
    ok: false,
    error: {
      code: "UNAVAILABLE",
      message: expect.stringContaining("injected agent transcript admission failure"),
    },
  });
  expect(vi.mocked(agentCommandMock)).not.toHaveBeenCalled();
  refusal.mockRestore();
});

test("agent final response surfaces redacted ACP runtime cause details", async () => {
  const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
  vi.mocked(agentCommandMock).mockRejectedValueOnce(
    new AcpRuntimeError("ACP_TURN_FAILED", "Internal error", {
      cause: new Error(`upstream rejected token=${token}`),
    }),
  );

  const finalP = agentResponse("ag-acp-error-detail");
  await sendAgentWsRequest("ag-acp-error-detail", {
    message: "hi",
    idempotencyKey: "idem-agent-acp-error-detail",
  });
  const final = await finalP;
  const errorMessage = (final.error as { message?: string } | undefined)?.message ?? "";
  expect(final).toMatchObject({ ok: false, payload: { status: "error" } });
  expect(errorMessage).toMatch(/ACP_TURN_FAILED/);
  expect(errorMessage).toMatch(/Internal error/);
  expect(errorMessage).toMatch(/upstream rejected/);
  expect(errorMessage).not.toContain("AcpRuntimeError");
  expect(JSON.stringify(final)).not.toContain(token);
});

test("agent events stream to webchat clients when run context is registered", async () => {
  await writeMainSessionEntry("sess-main");
  const webchatWs = await connectWebchatClient({ port: Number(new URL(gatewaySuite.ws.url).port) });
  try {
    registerAgentRunContext("run-auto-1", { sessionKey: "main" });
    const finalChatP = onceMessage(
      webchatWs,
      (o) =>
        o.type === "event" &&
        o.event === "chat" &&
        o.payload?.state === "final" &&
        o.payload.runId === "run-auto-1",
      8000,
    );
    for (const [stream, data] of [
      ["assistant", { text: "hi from agent" }],
      ["lifecycle", { phase: "end" }],
    ] as const) {
      emitAgentEvent({ runId: "run-auto-1", stream, data });
    }
    expect((await finalChatP).payload).toMatchObject({ sessionKey: "main", runId: "run-auto-1" });
  } finally {
    webchatWs.close();
  }
});
