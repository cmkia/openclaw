import type { AgentEvent } from "openclaw/plugin-sdk/agent-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import {
  onAgentEvent as registerAgentEventListener,
  resetAgentEventsForTest,
} from "../infra/agent-events.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  buildBlockedToolResult,
  recordAdjustedParamsForToolCall,
  recordStructuredReplayTrustForToolCall,
} from "./agent-tools.before-tool-call.js";
import { recordToolExecutionTracked } from "./agent-tools.before-tool-call.state.js";
import { addSession, deleteSession, markExited } from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { createProcessTool } from "./bash-tools.process.js";
import { projectEmbeddedMessageDeliveryFact } from "./embedded-agent-message-delivery.js";
import { buildEmbeddedRunPayloads } from "./embedded-agent-runner/run/payloads.js";
import {
  activateAskUserPrompt,
  createBasicAskUserArgs,
  finishPendingAskUserPrompts,
} from "./embedded-agent-subscribe.handlers.tools.ask-user.test-support.js";
import { handleToolExecutionUpdate } from "./embedded-agent-subscribe.handlers.tools.progress.js";
import { registerToolChannelProgressTests } from "./embedded-agent-subscribe.handlers.tools.progress.test-support.js";
import { handleToolExecutionStart } from "./embedded-agent-subscribe.handlers.tools.start.js";
import {
  createTestContext,
  endTool,
  requireEvent,
  requireString,
  resultWithDetails,
  type CapturedAgentEvent,
  type ToolExecutionEndEvent,
} from "./embedded-agent-subscribe.handlers.tools.test-support.js";
import type { ToolHandlerContext } from "./embedded-agent-subscribe.handlers.types.js";
import * as questionDispatch from "./harness/gateway-question-dispatch.js";
import { claimPendingAgentQuestionAnswer } from "./harness/gateway-question.js";
import {
  cancelAskUserPromptDelivery,
  normalizeAskUserParams,
  reserveAskUserPromptDelivery,
} from "./tools/ask-user-tool.js";
import * as gatewayTransport from "./tools/gateway.js";
import { createSecretsTool } from "./tools/secrets-tool.js";
import { markCoreTtsToolResult } from "./tools/tts-tool-result-provenance.js";

// mock-isolation: Keep prompt-readiness RPCs on the fixture, never the operator Gateway.
vi.mock("./harness/gateway-question-dispatch.runtime.js", () => ({
  callGatewayTool: async (method: string) => {
    if (method !== "question.list") {
      throw new Error(`Unexpected question readiness RPC: ${method}`);
    }
    return { questions: [] };
  },
}));

type ToolExecutionStartEvent = Omit<Extract<AgentEvent, { type: "tool_execution_start" }>, "type">;
type ToolExecutionUpdateEvent = {
  toolName: string;
  toolCallId: string;
  args?: unknown;
  partialResult?: unknown;
  hideFromChannelProgress?: boolean;
};

function startTool(ctx: ToolHandlerContext, event: ToolExecutionStartEvent) {
  if (event.toolName === "ask_user" || event.toolName === "secrets") {
    const { sessionKey, runId, agentId } = ctx.params;
    onTestFinished(() => cancelAskUserPromptDelivery(event.toolCallId, sessionKey, runId, agentId));
  }
  return handleToolExecutionStart(ctx, { type: "tool_execution_start", ...event });
}

async function executeTool(
  ctx: ToolHandlerContext,
  event: ToolExecutionStartEvent & Omit<ToolExecutionEndEvent, "toolName" | "toolCallId">,
) {
  const { toolName, toolCallId, args, ...completion } = event;
  await startTool(ctx, { toolName, toolCallId, args });
  await endTool(ctx, { toolName, toolCallId, ...completion });
}

function updateTool(ctx: ToolHandlerContext, event: ToolExecutionUpdateEvent) {
  return handleToolExecutionUpdate(ctx, {
    type: "tool_execution_update",
    args: event.args ?? {},
    partialResult: event.partialResult,
    ...event,
  });
}

function bindTool(ctx: ToolHandlerContext, toolName: string, toolCallId: string) {
  const identity = { toolName, toolCallId };
  return {
    start: (args: unknown, event: Partial<ToolExecutionStartEvent> = {}) =>
      startTool(ctx, { ...identity, args, ...event }),
    end: (result: unknown, event: Partial<Omit<ToolExecutionEndEvent, "result">> = {}) =>
      endTool(ctx, { ...identity, result, ...event }),
    run: (
      args: unknown,
      result: unknown,
      event: Partial<Omit<ToolExecutionEndEvent, "result">> = {},
    ) => executeTool(ctx, { ...identity, args, result, ...event }),
    update: (partialResult: unknown, event: Partial<ToolExecutionUpdateEvent> = {}) =>
      updateTool(ctx, { ...identity, partialResult, ...event }),
  };
}

function createToolHarness(
  toolName: string,
  toolCallId: string,
  params: Partial<ToolHandlerContext["params"]> = {},
) {
  const fixture = createTestContext();
  Object.assign(fixture.ctx.params, params);
  return { ...fixture, ...bindTool(fixture.ctx, toolName, toolCallId) };
}

function registerChannel(
  id: Parameters<typeof createChannelTestPluginBase>[0]["id"],
  plugin: Pick<ChannelPlugin, "threading" | "messaging"> & {
    actions?: Pick<
      NonNullable<ChannelPlugin["actions"]>,
      "extractToolSend" | "extractToolSendResult"
    >;
  },
) {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: id,
        source: "test",
        plugin: { ...createChannelTestPluginBase({ id }), ...plugin },
      },
    ]),
  );
}

afterEach(finishPendingAskUserPrompts);

function captureAgentEvents(): CapturedAgentEvent[] {
  const events: CapturedAgentEvent[] = [];
  registerAgentEventListener((event) => events.push(event));
  return events;
}

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text", text }], ...(details ? { details } : {}) };
}

function errorPayloads(ctx: ToolHandlerContext) {
  return buildEmbeddedRunPayloads({
    assistantTexts: [],
    lastAssistant: undefined,
    lastToolError: ctx.state.lastToolError,
    sessionKey: "agent:unit-session",
    toolResultFormat: "markdown",
  });
}

function questionButton(questionId: string, optionValue: string) {
  return { label: optionValue, action: { type: "question", questionId, optionValue } };
}

describe("progress_card compatibility plan events", () => {
  it("emits the typed full plan snapshot after a successful write", async () => {
    const { ctx, onAgentEvent, run } = createToolHarness("progress_card", "plan-1");
    ctx.params.onToolResult = vi.fn();
    ctx.shouldEmitToolResult = () => true;
    ctx.shouldEmitToolOutput = () => true;
    const emitted: CapturedAgentEvent[] = [];
    const unsubscribe = registerAgentEventListener((event) => emitted.push(event));
    try {
      await run(
        {
          markdown: "Implementation underway",
          plan: [
            { step: "Inspect", status: "completed" },
            { step: "Patch", status: "in_progress" },
          ],
        },
        textResult("Progress card updated (rev 2, 1/2 done)", {
          revision: 2,
          steps: { completed: 1, total: 2 },
        }),
      );
      await Promise.resolve();

      const expected = {
        stream: "plan",
        data: {
          phase: "update",
          title: "Plan updated",
          source: "openclaw",
          explanation: "1/2 complete",
          steps: [
            { step: "Inspect", status: "completed" },
            { step: "Patch", status: "in_progress" },
          ],
        },
      };
      expect(onAgentEvent).toHaveBeenCalledWith(expected);
      expect(emitted).toContainEqual(expect.objectContaining(expected));
      expect(ctx.emitToolSummary).not.toHaveBeenCalled();
      expect(ctx.emitToolOutput).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
});

const requireRecord = createRequireRecord("record", "expected-label-object");

function expectRecordFields(value: unknown, label: string, expected: Record<string, unknown>) {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key]).toEqual(expectedValue);
  }
}

function requireMockCallArg(mock: ReturnType<typeof vi.fn>, callIndex: number, label: string) {
  return requireRecord(mock.mock.calls[callIndex]?.[0], label);
}

function requireNestedRecord(value: unknown, label: string, path: string[]) {
  let current = value;
  for (const key of path) {
    current = requireRecord(current, label)[key];
  }
  return requireRecord(current, label);
}

function expectInteractiveApprovalButtons(
  result: Record<string, unknown>,
  expectedButtons: readonly Record<string, unknown>[],
) {
  const interactive = result.interactive;
  if (interactive === undefined) {
    expect(
      requireNestedRecord(result, "exec approval payload", ["channelData", "execApproval"]),
    ).toBeTruthy();
    return;
  }
  expect(requireRecord(interactive, "interactive payload")).toEqual({
    blocks: [{ type: "buttons", buttons: expectedButtons }],
  });
}

function requireSingleMessagingTarget(ctx: ToolHandlerContext) {
  const targets = ctx.state.messagingToolSentTargets;
  expect(targets).toHaveLength(1);
  return requireRecord(targets[0], "messaging target");
}

describe("handleToolExecutionStart read path checks", () => {
  it("reserves the question before flushing and delivers only its numbered prompt", async () => {
    const { ctx, onBlockReplyFlush, start } = createToolHarness("ask_user", "ask-call-1");
    const flush = createDeferred();
    onBlockReplyFlush.mockReturnValue(flush.promise);
    const delivered = createDeferred();
    const onToolResult = vi.fn(() => delivered.resolve());
    ctx.params.onToolResult = onToolResult;
    const args = {
      questions: [
        {
          id: "deploy_target",
          header: "Target",
          question: "Where should this deploy?",
          options: [
            { label: "Staging (Recommended)", description: "Safer default" },
            { label: "Production" },
          ],
        },
      ],
    };

    const pending = start(args);
    const activation = await activateAskUserPrompt("ask-call-1", args);
    expect(onToolResult).not.toHaveBeenCalled();
    flush.resolve();
    await pending;
    await delivered.promise;
    expect(onToolResult).toHaveBeenCalledOnce();
    await start(args, { toolCallId: "ask-second" });
    expect(onToolResult).toHaveBeenCalledOnce();
    const { questionId } = activation;

    expect(onToolResult).toHaveBeenCalledWith({
      text: [
        "Question for you:",
        "",
        "Target",
        "Where should this deploy?",
        "1. Staging (Recommended) - Safer default",
        "2. Production",
        "Other: reply with your own answer.",
        "",
        "Reply with the number, the option text, or your own answer.",
      ].join("\n"),
      channelData: {
        askUser: { questionId, optionValues: ["Staging (Recommended)", "Production"] },
      },
      presentationTextMode: "fallback",
      presentation: {
        blocks: [
          { type: "text", text: "Where should this deploy?" },
          {
            type: "text",
            text: [
              "- Staging (Recommended): Safer default",
              "- Production",
              "",
              "Reply with the number, the option text, or your own answer.",
            ].join("\n"),
          },
          {
            type: "buttons",
            buttons: [
              questionButton(questionId, "Staging (Recommended)"),
              questionButton(questionId, "Production"),
              { label: "Other…", action: { type: "question", questionId, intent: "custom-input" } },
            ],
          },
        ],
      },
    });
    await activation.finish();
  });

  it.each([
    ["public Control UI", "telegram", "https://console.example.test", true, true],
    ["missing public origin", "discord", undefined, true, false],
    ["native app with disabled Control UI", "webchat", undefined, false, true],
  ] as const)(
    "delivers a credential link or native prompt or visible blocker for %s",
    async (_name, messageChannel, publicOrigin, enabled, available) => {
      vi.useFakeTimers();
      const { ctx, start } = createToolHarness("secrets", "secret-call-1");
      const delivered = createDeferred();
      const answer = createDeferred<unknown>();
      const onToolResult = vi.fn<NonNullable<ToolHandlerContext["params"]["onToolResult"]>>(
        async () => delivered.promise,
      );
      ctx.params.onToolResult = onToolResult;
      ctx.params.messageChannel = messageChannel;
      // A destination id must not be mistaken for the channel family.
      ctx.params.currentChannelId = "telegram";
      ctx.params.config = {
        gateway: { publicOrigin, controlUi: { basePath: "/control", enabled } },
      };
      const args = { action: "request", name: "TEST_API_KEY", kind: "secret" };
      let questionId = "";
      const gatewayCall = vi.fn(async (method: string, _options: unknown, params: unknown) => {
        if (method === "question.request") {
          questionId = String(requireRecord(params, "question request").id);
          return { id: questionId };
        }
        if (method === "question.waitAnswer") {
          return await answer.promise;
        }
        if (method === "question.resolve") {
          answer.resolve({ status: "cancelled" });
          return { ok: true };
        }
        throw new Error(`unexpected method ${method}`);
      });
      await start(args);
      const storeTransportSpy = vi
        .spyOn(gatewayTransport, "callGatewayTool")
        .mockImplementation(gatewayCall);
      const questionResolverSpy = vi
        .spyOn(questionDispatch, "resolveAgentQuestionGatewayCall")
        .mockReturnValue(gatewayCall);
      const tool = createSecretsTool({
        agentId: ctx.params.agentId,
        sessionKey: ctx.params.sessionKey,
        runId: ctx.params.runId,
      });

      // Attach rejection handling before any assertion, and always retire both waits.
      const outcome = tool.execute("secret-call-1", args).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      try {
        await vi.advanceTimersByTimeAsync(50);
        expect(gatewayCall.mock.calls.some(([method]) => method === "question.waitAnswer")).toBe(
          true,
        );
        expect(gatewayCall.mock.calls.some(([method]) => method === "question.resolve")).toBe(
          false,
        );
        await expect(
          claimPendingAgentQuestionAnswer({
            sessionKey: ctx.params.sessionKey!,
            text: "not-a-credential",
          }),
        ).resolves.toBe(false);
        if (messageChannel === "webchat") {
          expect(onToolResult).not.toHaveBeenCalled();
        } else {
          await vi.waitFor(() => expect(onToolResult).toHaveBeenCalledOnce());
          const payload = onToolResult.mock.calls[0]?.[0];
          if (available) {
            expect(payload?.text).toBe(
              `🔑 Agent requests credential TEST_API_KEY (secret). Reply is disabled for secrets — open to provide it: https://console.example.test/control/ask/${questionId}`,
            );
          } else {
            expect(payload?.text).toContain("Credential request unavailable here");
            expect(payload?.text).toContain("Control UI or native app");
            expect(payload?.text).toContain("retry");
            expect(payload?.text).toContain("Never send credentials in chat");
            expect(payload?.text).not.toMatch(/https?:/);
          }
          expect(payload?.channelData).toEqual({ askUser: { questionId } });
          expect(payload).not.toHaveProperty("presentation");
          expect(payload).not.toHaveProperty("interactive");
          expect(payload?.text).not.toContain("Reply with your answer");
        }
        // A blocker must finish delivery while its question is still pending.
        expect(gatewayCall.mock.calls.some(([method]) => method === "question.resolve")).toBe(
          false,
        );
        delivered.resolve();
        if (available) {
          answer.resolve({
            status: "answered",
            answers: { answers: { secret_value: ["stored"] } },
          });
          await expect(outcome).resolves.toMatchObject({
            result: { details: { status: "stored" } },
          });
          expect(gatewayCall.mock.calls.some(([method]) => method === "question.resolve")).toBe(
            false,
          );
        } else {
          await expect(outcome).resolves.toMatchObject({
            error: new Error("credential-request prompt delivery failed"),
          });
          expect(gatewayCall).toHaveBeenCalledWith(
            "question.resolve",
            { timeoutMs: 10_000 },
            { id: questionId, cancel: true, resolvedBy: "prompt-delivery-failed" },
          );
        }
      } finally {
        try {
          delivered.resolve();
          answer.resolve({ status: "cancelled" });
          await outcome;
        } finally {
          questionResolverSpy.mockRestore();
          storeTransportSpy.mockRestore();
          vi.useRealTimers();
        }
      }
    },
  );

  it.each([
    {
      name: "multi-question",
      questions: [
        ...createBasicAskUserArgs().questions,
        {
          id: "region",
          header: "Region",
          question: "Which region?",
          options: [{ label: "EU" }, { label: "US" }],
        },
      ],
      hint: "Reply by number or question id. Use a declared option where choices are fixed.",
    },
    {
      name: "multi-select",
      questions: [
        {
          id: "checks",
          header: "Checks",
          question: "Which checks should run?",
          options: [{ label: "Unit" }, { label: "Lint" }],
          multiSelect: true,
        },
      ],
      hint: "Reply with comma-separated option numbers or text, or your own answer.",
    },
  ])("keeps $name ask_user prompts text-only", async ({ name, questions, hint }) => {
    const { ctx, start } = createToolHarness("ask_user", "tool-call");
    const onToolResult = vi.fn();
    ctx.params.onToolResult = onToolResult;
    const toolCallId = `ask-${name}`;

    await start({ questions }, { toolCallId });
    const activation = await activateAskUserPrompt(toolCallId, { questions });
    await vi.waitFor(() => expect(onToolResult).toHaveBeenCalledOnce());

    const payload = onToolResult.mock.calls[0]?.[0];
    expect(payload?.text).toContain(hint);
    expect(payload).not.toHaveProperty("presentation");
    expect(payload).not.toHaveProperty("presentationTextMode");
    expect(payload?.channelData).toEqual({ askUser: { questionId: activation.questionId } });
    await activation.finish();
  });

  it("releases ask_user reservation when the callback flush throws synchronously", () => {
    const { ctx, onBlockReplyFlush } = createTestContext();
    ctx.params.onToolResult = vi.fn();
    const failure = new Error("flush failed");
    onBlockReplyFlush.mockImplementation(() => {
      throw failure;
    });
    const args = createBasicAskUserArgs();

    expect(() =>
      startTool(ctx, { toolName: "ask_user", toolCallId: "ask-callback-failure", args }),
    ).toThrow(failure);
    onTestFinished(() => cancelAskUserPromptDelivery("ask-callback-retry", "agent:unit-session"));
    expect(
      reserveAskUserPromptDelivery({
        toolCallId: "ask-callback-retry",
        sessionKey: "agent:unit-session",
        questions: normalizeAskUserParams(args).questions,
      }),
    ).toBeDefined();
  });

  it("releases an undelivered ask_user reservation when execution is rejected", async () => {
    const { ctx, run, start } = createToolHarness("ask_user", "ask-denied");
    const onToolResult = vi.fn();
    ctx.params.onToolResult = onToolResult;
    const args = createBasicAskUserArgs();

    await run(args, textResult("denied"), { isError: true });
    await Promise.resolve();
    expect(onToolResult).not.toHaveBeenCalled();

    await start(args, { toolCallId: "ask-after-denial" });
    const activation = await activateAskUserPrompt("ask-after-denial", args);
    await vi.waitFor(() => expect(onToolResult).toHaveBeenCalledOnce());
    await activation.finish();
  });

  it("warns for a missing read path and accepts the corrected file_path alias", async () => {
    const { ctx, warn, onBlockReplyFlush, onExecutionPhase, start } = createToolHarness(
      "read",
      "tool-read-corrected",
    );

    const evt: ToolExecutionStartEvent = { toolName: "read", toolCallId: "tool-2", args: {} };

    await startTool(ctx, evt);

    expect(warn).toHaveBeenCalledTimes(1);
    const warnMessage = String(warn.mock.calls[0]?.[0] ?? "");
    const warnMeta = warn.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(warnMessage).toContain("read tool called without path");
    expect(warnMeta?.event).toBe("embedded_read_tool_start_warning");
    expect(warnMeta?.tags).toEqual(["tool_start", "read", "embedded", "validation"]);
    expect(warnMeta?.runId).toBe("run-test");
    expect(warnMeta?.sessionKey).toBe("agent:unit-session");
    expect(warnMeta?.sessionId).toBe("session-test-id");
    expect(warnMeta?.agentId).toBe("agent-test-id");
    expect(warnMeta?.toolCallId).toBe("tool-2");
    expect(warnMeta?.argsType).toBe("object");
    expect(warnMeta?.consoleMessage).toContain("runId=run-test");
    expect(warnMeta?.consoleMessage).toContain("sessionKey=agent:unit-session");
    expect(warnMeta?.consoleMessage).toContain("sessionId=session-test-id");
    expect(warnMeta?.consoleMessage).toContain("agentId=agent-test-id");
    expect(warnMeta?.consoleMessage).toContain("toolCallId=tool-2");
    expect(warnMeta?.consoleMessage).toContain("argsType=object");
    expect(warnMeta?.consoleMessage).toContain("read tool called without path");
    expect(warnMeta).not.toHaveProperty("argsPreview");
    await start({ file_path: "/tmp/example.txt" });
    expect(warn).toHaveBeenCalledOnce();
    expect(onBlockReplyFlush).toHaveBeenCalledTimes(2);
    expect(onBlockReplyFlush).toHaveBeenCalledWith({
      reason: "tool_start",
      assistantMessageIndex: 0,
    });
    expect(onExecutionPhase).toHaveBeenCalledWith({
      phase: "tool_execution_started",
      tool: "read",
      toolCallId: "tool-read-corrected",
      source: "embedded-agent",
    });
  });

  it("does not include malformed read payloads in warnings", async () => {
    const { warn, start } = createToolHarness("read", "tool-bounded-args");
    const args = "private-read-payload";
    await start(args);

    const warnMeta = warn.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(warn).toHaveBeenCalledOnce();
    expect(warnMeta?.argsType).toBe("string");
    expect(warnMeta).not.toHaveProperty("argsPreview");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(args);
  });

  it("keeps tool state when phase callbacks throw and event callbacks reject", async () => {
    const { ctx, warn, onExecutionPhase, onAgentEvent } = createTestContext();
    onExecutionPhase.mockImplementation(() => {
      throw new Error("phase exploded");
    });
    onAgentEvent.mockRejectedValue(new Error("event exploded"));

    const evt: ToolExecutionStartEvent = {
      toolName: "exec",
      toolCallId: "tool-callback-throws",
      args: { command: "echo hi" },
    };

    await startTool(ctx, evt);
    await Promise.resolve();

    expect(ctx.state.toolMetaById.has("tool-callback-throws")).toBe(true);
    expect(ctx.state.itemStartedCount).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("tool execution phase callback failed"),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("tool agent event callback failed"));
  });
});

describe("handleToolExecutionEnd cron mutation tracking", () => {
  it.each([
    ...(
      [
        ["exec", "npx -y openclaw cron add --at +1h --message 'follow up'"],
        ["exec", "pnpm dlx openclaw@latest cron add --at +1h --message 'follow up'"],
        ["exec", "npx openclaw@latest cron add --at +1h --message 'follow up'"],
        ["exec", "env OPENCLAW_PROFILE=test openclaw cron add --at +1h --message 'follow up'"],
        ["exec", "openclaw --profile work cron create --at +1h --message 'follow up'"],
        ["exec", "openclaw cron add --at +1h --message 'follow up' 2>&1"],
      ] as const
    ).map(([toolName, command]) => ({ toolName, command, expected: 1 })),
    ...(
      [
        ["openclaw cron add --at '+1h", "an unterminated shell argument"],
        ["cd /tmp && openclaw cron add --at +1h", "a compound command"],
        ["openclaw cron add --at +1h; true", "a semicolon suffix"],
        ["openclaw cron add --at +1h | cat", "a pipeline suffix"],
        ["openclaw cron add --bad # ignored\ntrue", "a comment-masked cron failure"],
        ["corepack pnpm openclaw cron add --at +1h", "a corepack pnpm package script"],
        ["openclaw cron add --bad &>>/tmp/cron.log", "a bash-only append redirection"],
      ] as const
    ).map(([command, label]) => ({ toolName: "exec", command, label, expected: 0 })),
  ])(
    "counts only successful direct cron adds: $command",
    async ({ toolName, command, expected }) => {
      const { ctx, run } = createToolHarness("exec", "tool-shell-cron-failed");
      if (expected) {
        await run(
          { command },
          resultWithDetails({
            status: "completed",
            exitCode: 1,
            aggregated: "Cron job name is required.",
          }),
          { toolName },
        );
        expect(ctx.state.successfulCronAdds).toBe(0);
      }
      await run(
        { command },
        resultWithDetails({
          status: "completed",
          exitCode: 0,
          durationMs: 12,
          aggregated: expected ? "warning text and human-readable success output" : "completed",
        }),
        { toolName, toolCallId: "tool-shell-cron-add", isError: false },
      );
      expect(ctx.state.successfulCronAdds).toBe(expected);
    },
  );

  it.each(["cancelled-before-body", "policy-blocked", "middleware-rewritten"] as const)(
    "derives cron replay safety from %s execution evidence",
    async (mode) => {
      const { ctx } = createTestContext();
      const toolCallId = `tool-cron-${mode}`;
      if (mode === "cancelled-before-body") {
        recordToolExecutionTracked(toolCallId, "run-test");
      }
      await executeTool(ctx, {
        toolName: "cron",
        toolCallId,
        args: { action: "add", job: { name: "reminder" } },
        isError: mode !== "policy-blocked",
        ...(mode === "cancelled-before-body" ? { executionStarted: true } : {}),
        result:
          mode === "policy-blocked"
            ? buildBlockedToolResult({ reason: "blocked by policy", toolCallId, runId: "run-test" })
            : mode === "cancelled-before-body"
              ? { details: { status: "error", error: "cancelled before tool body" } }
              : {
                  content: [{ type: "text", text: "blocked by middleware" }],
                  details: {
                    status: "blocked",
                    deniedReason: "plugin-before-tool-call",
                    reason: "blocked by middleware",
                  },
                },
      });
      const executed = mode === "middleware-rewritten";
      expect(ctx.state.replayState).toEqual({
        replayInvalid: executed,
        hadPotentialSideEffects: executed,
      });
      expect(ctx.state.lastToolError?.mutatingAction).toBe(executed);
    },
  );

  it("records a structured core read action as replay-safe", async () => {
    const toolCallId = "tool-cron-status";
    const { ctx, run } = createToolHarness("cron", toolCallId);
    recordStructuredReplayTrustForToolCall(
      toolCallId,
      { name: "cron", execute: vi.fn() } as never,
      "run-test",
    );
    await run({ action: "status" }, { details: { ok: true } }, { isError: false });
    expect(ctx.state.replayState.hadPotentialSideEffects).toBe(false);
  });

  it("records instance-trusted search calls as replay-safe", async () => {
    const { ctx, run } = createToolHarness("search", "tool-search");
    ctx.params.replaySafeToolNames = new Set(["search"]);
    await run({ query: "scheduler" }, { matches: [] });
    expect(ctx.state.toolMetas).toEqual([
      expect.objectContaining({ toolName: "search", replaySafe: true }),
    ]);
    expect(ctx.state.replayState).toEqual({ replayInvalid: false, hadPotentialSideEffects: false });
  });
});

registerToolChannelProgressTests({ createTestContext, startTool, updateTool, endTool });

describe("handleToolExecutionEnd MCP App channel view tracking", () => {
  const result = (viewId: string, title: string) => ({
    details: { mcpAppPreview: { view: { id: viewId, title }, mcpApp: { viewId } } },
  });

  it("retains only the latest successful bounded view identity", async () => {
    const { ctx, end } = createToolHarness("mcp_first", "mcp-first");

    await end(result("view-first", "First app"));
    await end(result("view-failed", "Failed app"), {
      toolName: "mcp_failed",
      toolCallId: "mcp-failed",
      isError: true,
    });
    const invalid = result("view-invalid", "Invalid app");
    invalid.details.mcpAppPreview.view.id = "different-view";
    await end(invalid, { toolName: "mcp_invalid", toolCallId: "mcp-invalid" });
    expect(ctx.state.latestMcpAppChannelView).toEqual({ viewId: "view-first" });
    await end(result("view-latest", "Latest app"), {
      toolName: "mcp_latest",
      toolCallId: "mcp-latest",
    });

    expect(ctx.state.latestMcpAppChannelView).toEqual({ viewId: "view-latest" });
  });
});

describe("handleToolExecutionEnd MCP connect action tracking", () => {
  it("retains only a successful HTTP(S) connect action", async () => {
    const { ctx, end } = createToolHarness("mcp_connect", "mcp-connect");

    await end(
      resultWithDetails({
        mcpConnect: {
          serverName: "calendar",
          authorizationUrl: "https://auth.example/authorize?state=opaque",
        },
      }),
    );

    expect(ctx.state.latestMcpConnectAction).toEqual({
      serverName: "calendar",
      authorizationUrl: "https://auth.example/authorize?state=opaque",
    });
  });
});

describe("handleToolExecutionEnd mutating failure recovery", () => {
  it("keeps an earlier message error when the next delivery is intentionally suppressed", async () => {
    const { ctx, run } = createToolHarness("message", "message-failed");
    await run(
      {
        action: "send",
        channel: "telegram",
        target: "123",
        message: "failed",
        media: "/tmp/failed.png",
      },
      resultWithDetails({
        status: "error",
        error: "Telegram transport failed",
        media: { mediaUrl: "/tmp/failed.png" },
      }),
      { isError: true },
    );
    await run(
      { action: "send", channel: "telegram", target: "123", message: "omitted" },
      { details: { status: "suppressed", reason: "cancelled_by_message_sending_hook" } },
      { toolCallId: "message-suppressed" },
    );
    expect(ctx.state.messagingToolSentMediaUrls).toEqual([]);
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
    expect(ctx.state.lastToolError).toMatchObject({
      toolName: "message",
      error: "Telegram transport failed",
    });
  });

  it("records plugin-owner mutation failure metadata", async () => {
    const { ctx, run } = createToolHarness("memory_store", "tool-failure-metadata");
    ctx.params.sideEffectToolOwners = new Map([
      ["memory_store", '["memory-lancedb","memory_store"]'],
    ]);
    await run(
      { text: "The user prefers metric units." },
      { details: { status: "error", error: "429 insufficient_quota" } },
      { isError: true },
    );
    expect(ctx.state.lastToolError).toMatchObject({
      toolName: "memory_store",
      mutatingAction: true,
    });
  });

  it.each([false, true])(
    "exports validation diagnostics only before execution (started=%s)",
    async (executionStarted) => {
      const { ctx, onAgentEvent } = createTestContext();
      const error = executionStarted
        ? 'Validation failed for tool "edit":\n  - secret tool output\n\nReceived arguments:\n{}'
        : 'Validation failed for tool "edit":\n  - edits: must have required properties edits\n\nReceived arguments:\n{"path":"secret.txt","contents":"PTY_PLANTED_SECRET"}';
      await executeTool(ctx, {
        toolName: "edit",
        toolCallId: "tool-edit-validation",
        args: executionStarted ? {} : { path: "secret.txt" },
        isError: true,
        executionStarted,
        ...(executionStarted ? {} : { errorKind: "argument-validation" as const }),
        result: { details: { status: "error", error } },
      });
      if (executionStarted) {
        const resultEvent = onAgentEvent.mock.calls.find(
          ([event]) => event.stream === "tool" && event.data.phase === "result",
        )?.[0];
        expect(resultEvent?.data).not.toHaveProperty("toolErrorSummary");
      } else {
        expect(onAgentEvent).toHaveBeenCalledWith({
          stream: "tool",
          data: expect.objectContaining({
            phase: "result",
            toolErrorSummary: "edit tool validation failed: invalid arguments",
          }),
        });
      }
      expect(JSON.stringify(onAgentEvent.mock.calls)).not.toContain(
        executionStarted ? "secret tool output" : "PTY_PLANTED_SECRET",
      );
    },
  );

  it("snapshots hook-adjusted args before result middleware can mutate them", async () => {
    const toolCallId = "tool-cron-mutable-adjusted-args";
    const { ctx, onAgentEvent, start, end } = createToolHarness("cron", toolCallId);
    const executedArgs = { action: "add", job: { name: "rewritten mutation" } };
    recordAdjustedParamsForToolCall(toolCallId, executedArgs, "run-test");

    await start({ action: "status" });
    executedArgs.action = "status";
    await end({ ok: true });

    expect(ctx.state.replayState).toEqual({
      replayInvalid: true,
      hadPotentialSideEffects: true,
    });
    expect(ctx.state.successfulCronAdds).toBe(1);
    const resultEvent = onAgentEvent.mock.calls.find(
      ([event]) => event.stream === "tool" && event.data.phase === "result",
    )?.[0];
    expect(resultEvent?.data).not.toHaveProperty("args");
  });

  it("records preview suppression for a confirmed current-source poll", async () => {
    const { ctx, run } = createToolHarness("message", "tool-message-source-poll");
    ctx.params.sourceReplyDeliveryMode = "automatic";
    await run(
      {
        action: "poll",
        provider: "telegram",
        target: "chat-poll",
        pollQuestion: "Preferred default?",
        pollOption: ["Tell me right away", "Only important"],
      },
      { ok: true, pollId: "poll-1", details: { sourceReplyRoute: "current-source" } },
    );
    expect(ctx.state.currentSourceMessagingToolSentTextsNormalized).toEqual(["preferred default?"]);
    expect(ctx.state.messageToolOnlySourceReplyDelivered).toBe(true);
    expect(ctx.state.messagingToolSentTexts).toEqual([]);
  });

  it.each([
    ["the exact source route", "account-1", "chat123", "thread-1", true],
    ["the same target in another account", "account-2", "chat123", "thread-1", false],
    ["the same target in another thread", "account-1", "chat123", "thread-2", false],
    ["another target", "account-1", "chat456", "thread-1", false],
  ] as const)(
    "records explicit message sends only for %s",
    async (label, accountId, target, threadId, expected) => {
      const { ctx, run } = createToolHarness("message", `tool-message-explicit-${label}`, {
        config: {},
        sourceReplyDeliveryMode: "message_tool_only",
        messageChannel: "test-channel",
        currentAccountId: "account-1",
        currentChannelId: "chat123",
        currentThreadId: "thread-1",
      });

      await run(
        {
          action: "send",
          channel: "test-channel",
          accountId,
          target,
          threadId,
          message: "explicit reply",
        },
        { details: { ok: true } },
      );

      expect(ctx.state.messageToolOnlySourceReplyDelivered).toBe(expected);
    },
  );

  it("records rich-content delivery when visible text is blank", async () => {
    const { ctx, run } = createToolHarness("message", "tool-call");
    const toolCallId = "tool-message-rich-content";

    await run(
      {
        action: "send",
        provider: "telegram",
        to: "chat-rich",
        text: "  ",
        presentation: JSON.stringify({
          blocks: [{ type: "buttons", buttons: [{ label: "OK", value: "ok" }] }],
        }),
      },
      { details: { messageId: "message-rich" } },
      { toolCallId },
    );

    expect(ctx.state.messagingToolSentTargets).toEqual([
      expect.objectContaining({
        tool: "message",
        provider: "telegram",
        to: "chat-rich",
        hasRichContent: true,
      }),
    ]);
  });

  it("records thread creation as target evidence without a source reply", async () => {
    const { ctx, run } = createToolHarness("message", "tool-message-target");
    ctx.params.sourceReplyDeliveryMode = "automatic";
    await run(
      {
        action: "thread-create",
        provider: "telegram",
        target: "chat-thread",
        message: "new thread",
      },
      { ok: true, thread: { id: "thread-1" } },
    );
    expect(ctx.state.currentSourceMessagingToolSentTextsNormalized).toEqual([]);
    expect(ctx.state.messageToolOnlySourceReplyDelivered).toBe(false);
    expect(ctx.state.messagingToolSentTexts).toEqual([]);
    expect(ctx.state.messagingToolSentMediaUrls).toEqual([]);
    expect(ctx.state.messagingToolSentTargets).toEqual([
      expect.objectContaining({ tool: "message", provider: "telegram", to: "chat-thread" }),
    ]);
  });

  it.each([
    {
      toolName: "exec",
      args: { command: "printf changed > /tmp/demo.txt && false" },
      isError: true,
      result: { error: "Command exited with code 1" },
    },
    {
      toolName: "browser",
      args: { action: "act", kind: "click", ref: "e12" },
      isError: false,
      result: { details: { ok: true } },
    },
    {
      toolName: "subagents",
      args: { action: "list" },
      isError: false,
      result: { status: "ok", action: "list", total: 0, text: "no active subagents." },
    },
  ])("keeps untrusted $toolName calls replay-unsafe: $args", async (event) => {
    const { ctx } = createTestContext();
    await executeTool(ctx, { toolCallId: "tool-untrusted", ...event });
    expect(ctx.state.replayState).toEqual({ replayInvalid: true, hadPotentialSideEffects: true });
  });
});

describe("handleToolExecutionEnd timeout metadata", () => {
  it("marks every finalized built-in call with its explicit outcome", async () => {
    const { ctx, end } = createToolHarness("read", "tool-read-complete");

    await end({ content: "ok" });
    await end(
      { details: { status: "running" } },
      { toolName: "process", toolCallId: "tool-process-running" },
    );
    await end(
      { details: { async: true, status: "started" } },
      { toolName: "image_generate", toolCallId: "tool-image-async-started" },
    );
    await end(
      { error: "failed" },
      { toolName: "write", toolCallId: "tool-write-failed", isError: true },
    );

    expect(ctx.state.toolMetas.map(({ toolName, isError }) => ({ toolName, isError }))).toEqual([
      { toolName: "read", isError: false },
      { toolName: "process", isError: false },
      { toolName: "image_generate", isError: false },
      { toolName: "write", isError: true },
    ]);
    expect(ctx.state.toolMetas[2]?.asyncStarted).toBe(true);
  });

  it("marks a parked Code Mode exec only when the tool is the marked control tool", async () => {
    const { ctx, end } = createToolHarness("exec", "tool-code-mode-waiting");
    ctx.params.codeModeExecToolNames = new Set(["exec"]);

    await end({ details: { status: "waiting", runId: "cm_parked", reason: "pending_tools" } });
    ctx.params.codeModeExecToolNames = new Set();
    await end(
      { details: { status: "waiting", runId: "cm_impostor" } },
      { toolCallId: "tool-plain-exec-waiting" },
    );

    expect(ctx.state.toolMetas.map((entry) => entry.codeModeSuspended)).toEqual([true, undefined]);
  });

  it("records intentional termination with its exact tool call id", async () => {
    const { ctx, end } = createToolHarness("terminal_action", "tool-terminal-current");

    await end({
      content: [{ type: "text", text: "Done." }],
      details: { status: "done" },
      terminate: true,
    });

    expect(ctx.state.toolMetas).toEqual([
      expect.objectContaining({
        toolName: "terminal_action",
        toolCallId: "tool-terminal-current",
        terminate: true,
      }),
    ]);
  });

  it("retains every failed call after later successes change the last-error slot", async () => {
    const { ctx, end } = createToolHarness("exec", "tool-call");

    for (const [toolCallId, isError] of [
      ["tool-write-failed", true],
      ["tool-read-failed", true],
      ["tool-read-succeeded", false],
      ["tool-exec-failed", true],
    ] as const) {
      await end(isError ? { error: `${toolCallId} failed` } : { content: "ok" }, {
        toolName: toolCallId.split("-")[1]!,
        toolCallId,
        isError,
      });
      if (toolCallId === "tool-read-failed") {
        expect(ctx.state.lastToolError).toMatchObject({
          toolName: "read",
          error: "tool-read-failed failed",
          mutatingAction: false,
        });
      }
    }

    expect(ctx.state.toolMetas.map(({ toolName, isError }) => ({ toolName, isError }))).toEqual([
      { toolName: "write", isError: true },
      { toolName: "read", isError: true },
      { toolName: "read", isError: false },
      { toolName: "exec", isError: true },
    ]);
    expect(ctx.state.lastToolError).toMatchObject({
      toolName: "exec",
      error: "tool-exec-failed failed",
    });
  });

  async function executeProcessResult(
    ctx: ToolHandlerContext,
    params: {
      action?: string;
      details?: Record<string, unknown>;
      isError?: boolean;
      output?: string;
    } = {},
  ) {
    const action = params.action ?? "poll";
    const output = params.output ?? "SAFE_PROCESS_STDERR";
    await executeTool(ctx, {
      toolName: "process",
      toolCallId: `tool-process-${action}`,
      args: { action, sessionId: "wild-lagoon" },
      isError: params.isError ?? true,
      result: textResult(output, {
        status: "completed",
        sessionId: "wild-lagoon",
        exitReason: "exit",
        aggregated: output,
        ...params.details,
      }),
    });
  }

  it("projects a structured diagnostic from the real terminal process log result", async () => {
    const action = "log";
    const { ctx, run } = createToolHarness("process", "tool-call");
    const sessionId = `wild-lagoon-${action}`;
    const session = createProcessSessionFixture({
      id: sessionId,
      command: "test",
      backgrounded: true,
    });
    addSession(session);
    markExited(session, 0, null, "failed", "overall-timeout", false);

    try {
      const args = { action, sessionId } as Parameters<
        ReturnType<typeof createProcessTool>["execute"]
      >[1];
      const result = await createProcessTool().execute(`tool-real-process-${action}`, args);
      await run(args, result, { toolCallId: `tool-process-${action}` });

      expect(ctx.state.lastToolError).toMatchObject({
        toolName: "process",
        terminalDiagnostic: {
          kind: "process",
          sessionId,
          reason: { kind: "timeout", timeoutKind: "overall-timeout" },
        },
      });
    } finally {
      deleteSession(sessionId);
    }
  });

  const dummyTelegramToken = `123456:${"A".repeat(28)}WXYZ`;
  it.each([
    {
      label: "signal",
      details: { exitCode: 0, exitSignal: "SIGKILL", exitReason: "signal" },
      reason: { kind: "signal", signal: "SIGKILL" },
    },
    {
      label: "credential-shaped output",
      details: { exitCode: 7 },
      output: `${dummyTelegramToken} ${"x".repeat(500)}`,
      reason: { kind: "exit", exitCode: 7 },
    },
    {
      label: "terminal control characters",
      details: { exitCode: 7 },
      output: "SAFE\u001b[31m_PROCESS_STDERR",
      reason: { kind: "exit", exitCode: 7 },
    },
    {
      label: "log without terminal provenance",
      action: "log",
      details: { exitReason: undefined, exitCode: 7, exitSignal: "SIGKILL" },
      reason: undefined,
    },
  ])(
    "projects only safe terminal process diagnostics: $label",
    async ({ label, action, details, output, reason }) => {
      const { ctx } = createTestContext();
      await executeProcessResult(ctx, {
        action,
        details,
        output: output ?? `No terminal process result for ${label}.`,
      });
      expect(ctx.state.lastToolError?.terminalDiagnostic).toEqual(
        reason ? { kind: "process", sessionId: "wild-lagoon", reason } : undefined,
      );
      if (label === "credential-shaped output") {
        expect(ctx.state.lastToolError?.error?.length).toBeLessThanOrEqual(401);
        expect(ctx.state.lastToolError?.error).toMatch(/…$/u);
        expect(JSON.stringify(ctx.state.lastToolError)).toContain(dummyTelegramToken);
      } else if (label === "terminal control characters") {
        expect(ctx.state.lastToolError?.error).toBeUndefined();
      }
    },
  );

  it.each([
    {
      name: "records raw exec metadata without exposing it in default payload warnings",
      toolCallId: "tool-exec-raw-command",
      args: { command: "python3 /tmp/audit.py" },
      meta: "run python3 /tmp/audit.py, `python3 /tmp/audit.py`",
    },
    {
      name: "records backtick commands without exposing them in default payload warnings",
      toolCallId: "tool-exec-raw-command-backticks",
      args: { command: "node -e 'console.log(1, `x`)'" },
      meta: "run node inline script, ``node -e 'console.log(1, `x`)'``",
    },
  ])("$name", async ({ toolCallId, args, meta }) => {
    const { ctx, run } = createToolHarness("exec", "tool-call");
    ctx.params.toolProgressDetail = "raw";
    await run(
      args,
      {
        error: "Command exited with code 1",
        content: [{ type: "text", text: "Command exited with code 1" }],
        details: { status: "failed", exitCode: 1 },
      },
      { toolCallId, isError: true },
    );
    expectRecordFields(ctx.state.lastToolError, "last tool error", { toolName: "exec", meta });
    const payloads = errorPayloads(ctx);
    expect(payloads[0]?.text).toBe("⚠️ Exec failed (exit 1)");
  });

  it.each([
    {
      label: "structured tool error",
      result: textResult("SYSTEM_RUN_DENIED: approval required", {
        status: "failed",
        error: { code: "SYSTEM_RUN_DENIED", message: "approval required" },
      }),
      error: "approval required",
    },
    {
      label: "thrown gateway error",
      result: resultWithDetails({
        status: "error",
        error: "UNAVAILABLE: SYSTEM_RUN_DENIED: approval required",
        gatewayCode: "UNAVAILABLE",
        nodeError: { code: "UNAVAILABLE", message: "SYSTEM_RUN_DENIED: approval required" },
      }),
      error: "UNAVAILABLE: SYSTEM_RUN_DENIED: approval required",
    },
  ])("records denial codes from $label results", async ({ result, error }) => {
    const { ctx, end } = createToolHarness("exec", "tool-exec-denied");
    await end(result, { isError: true });
    expectRecordFields(ctx.state.lastToolError, "last tool error", {
      toolName: "exec",
      errorCode: "SYSTEM_RUN_DENIED",
      error,
    });
  });
});

describe("handleToolExecutionEnd exec approval prompts", () => {
  it("emits a deterministic approval payload and marks assistant output suppressed", async () => {
    const { ctx, onAgentEvent, run } = createToolHarness("exec", "tool-exec-approval");
    const onToolResult = vi.fn();
    ctx.params.onToolResult = onToolResult;

    await run(
      { command: "npm view diver name version description" },
      resultWithDetails({
        status: "approval-pending",
        approvalId: "12345678-1234-1234-1234-123456789012",
        approvalSlug: "12345678",
        expiresAtMs: 1_800_000_000_000,
        allowedDecisions: ["allow-once", "deny"],
        host: "gateway",
        command: "npm view diver name version description",
        cwd: "/tmp/work",
        warningText: "Warning: heredoc execution requires explicit approval in allowlist mode.",
      }),
    );

    const result = requireMockCallArg(onToolResult, 0, "tool result");
    expect(requireString(result.text, "tool result text")).toContain(
      "```txt\n/approve 12345678 allow-once\n```",
    );
    expectRecordFields(
      requireNestedRecord(result, "exec approval payload", ["channelData", "execApproval"]),
      "exec approval payload",
      {
        approvalId: "12345678-1234-1234-1234-123456789012",
        approvalSlug: "12345678",
        approvalKind: "exec",
        allowedDecisions: ["allow-once", "deny"],
      },
    );
    expectInteractiveApprovalButtons(result, [
      {
        label: "Allow Once",
        value: "/approve 12345678-1234-1234-1234-123456789012 allow-once",
        style: "success",
      },
      {
        label: "Deny",
        value: "/approve 12345678-1234-1234-1234-123456789012 deny",
        style: "danger",
      },
    ]);
    expect(ctx.state.deterministicApprovalPromptSent).toBe(true);
    expect(result.text).not.toContain("allow-always");
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "approval",
      data: expect.objectContaining({
        phase: "requested",
        status: "pending",
        itemId: "command:tool-exec-approval",
        approvalId: "12345678-1234-1234-1234-123456789012",
        approvalSlug: "12345678",
      }),
    });
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "item",
      data: expect.objectContaining({
        itemId: "tool:tool-exec-approval",
        phase: "end",
        status: "blocked",
        summary: "Awaiting approval before command can run.",
      }),
    });
  });

  it("emits a deterministic unavailable payload when the initiating surface cannot approve", async () => {
    const { ctx, end } = createToolHarness("exec", "tool-exec-unavailable");
    const onToolResult = vi.fn();
    const onAgentToolResult = vi.fn();
    ctx.params.onToolResult = onToolResult;
    ctx.params.onAgentToolResult = onAgentToolResult;

    await end(
      resultWithDetails({
        status: "approval-unavailable",
        reason: "no-approval-route",
        channel: "discord",
        channelLabel: "Discord",
        accountId: "work",
        host: "node",
        nodeId: "node-mac-1",
      }),
    );

    const text = requireString(
      requireMockCallArg(onToolResult, 0, "tool result").text,
      "tool result text",
    );
    expect(text).toContain("no interactive approval client is currently available");
    expect(text).toContain(
      "Print the Control UI URL with `openclaw dashboard --no-open`, open it in a browser, then use the approval inbox.",
    );
    expect(text).toContain(
      "Inspect the node's effective exec policy with `openclaw approvals get --node node-mac-1`.",
    );
    expect(text).not.toContain("/approve");
    expect(text).not.toContain("Pending command:");
    expect(text).not.toContain("Host:");
    expect(text).not.toContain("CWD:");
    expect(onAgentToolResult).toHaveBeenCalledWith({
      toolName: "exec",
      result: expect.objectContaining({
        details: expect.objectContaining({ status: "approval-unavailable" }),
      }),
      isError: true,
    });
    expect(ctx.state.toolMetas).toEqual([
      expect.objectContaining({ toolName: "exec", isError: true }),
    ]);
    expect(ctx.state.deterministicApprovalPromptSent).toBe(false);
  });

  it("records an actionable failure when deterministic approval delivery rejects", async () => {
    const { ctx, warn, end } = createToolHarness("exec", "tool-exec-approval-reject");
    ctx.params.onToolResult = vi.fn(async () => {
      throw new Error("delivery failed");
    });

    await end(
      resultWithDetails({
        status: "approval-pending",
        approvalId: "12345678-1234-1234-1234-123456789012",
        approvalSlug: "12345678",
        expiresAtMs: 1_800_000_000_000,
        host: "gateway",
        command: "npm view diver name version description",
        cwd: "/tmp/work",
      }),
    );

    expect(ctx.state.deterministicApprovalPromptSent).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to deliver exec approval prompt: delivery failed"),
    );
    expect(ctx.state.lastToolError).toMatchObject({
      toolName: "exec",
      error: "Approval prompt delivery failed: delivery failed",
      mutatingAction: false,
    });
    const payloads = errorPayloads(ctx);
    expect(payloads[0]?.text).toBe("⚠️ Exec blocked");
  });

  it("projects a started execution failure with its duration", async () => {
    const { onAgentEvent, run } = createToolHarness("exec", "tool-exec-status");
    await run(
      { command: "exit 7" },
      { content: [], details: { status: "failed", exitCode: 7, durationMs: 12 } },
      { isError: true, executionStarted: true },
    );

    const events = onAgentEvent.mock.calls.map((call) => call[0] as CapturedAgentEvent);
    expect(
      events
        .filter((event) => event.stream === "item" && event.data?.phase === "end")
        .map((event) => event.data?.status),
    ).toEqual(["failed"]);
    const commandOutput = requireEvent(
      events,
      (event) => event.stream === "command_output",
      "command output event",
    ).data;
    expect([
      commandOutput?.status,
      commandOutput?.exitCode,
      commandOutput?.durationMs,
      "durationMs" in commandOutput!,
    ]).toEqual(["failed", 7, 12, true]);
  });
});

describe("handleToolExecutionEnd derived tool events", () => {
  it.each([false, true])("projects only bounded typed public progress (typed=%s)", (typed) => {
    resetAgentEventsForTest();
    const events = captureAgentEvents();
    const largeProgress = "x".repeat(9000);
    const toolName = typed ? "custom_fetcher" : "web_fetch";
    const toolCallId = typed ? "tool-large-progress" : "tool-web-fetch-untyped";
    const { onAgentEvent, update } = createToolHarness(toolName, toolCallId);
    update(
      typed
        ? {
            content: [],
            details: undefined,
            progress: { text: largeProgress, visibility: "channel", privacy: "public" },
          }
        : { content: [{ type: "text", text: "Fetching page content..." }], details: undefined },
    );
    const itemEvent = requireRecord(
      onAgentEvent.mock.calls.map(([event]) => event).find((event) => event.stream === "item"),
      "tool item event",
    );
    const item = requireRecord(itemEvent.data, "tool item data");
    if (typed) {
      const progressText = requireString(item.progressText, "progress text");
      expect(progressText).toContain("...(live output truncated)...");
      expect(progressText.length).toBeLessThan(largeProgress.length);
      expectRecordFields(item, "progress item", {
        itemId: `tool:${toolCallId}`,
        phase: "update",
        kind: "tool",
        name: toolName,
        status: "running",
      });
      expect(item.meta).toBeUndefined();
    } else {
      expect(item.progressText).toBeUndefined();
    }
    expect(
      events.filter((event) => event.stream === "tool" && event.data?.phase === "update"),
    ).toHaveLength(typed ? 0 : 1);
    expect(
      onAgentEvent.mock.calls.map(([event]) => event).filter((event) => event.stream === "tool"),
    ).toHaveLength(typed ? 0 : 1);
    resetAgentEventsForTest();
  });

  it.each([false, true])(
    "keeps exec visibility changes timely with bounded output (text content: %s)",
    async (withTextContent) => {
      const field = "hideFromChannelProgress";
      resetAgentEventsForTest();
      const events: Array<{ stream?: string; ts?: number; data?: Record<string, unknown> }> = [];
      const unsubscribe = registerAgentEventListener((event) => events.push(event));
      const { ctx, onAgentEvent, start, end } = createToolHarness("exec", "tool-call");
      const onAgentToolResult = vi.fn();
      ctx.params.onAgentToolResult = onAgentToolResult;
      const toolCallId = "exec-lifecycle";
      const output =
        '  OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789\napiKey: "ghp_abcdefghij1234567890"\n' +
        "x".repeat(9000);
      const content = withTextContent ? { content: [{ type: "text", text: output }] } : {};
      const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
      try {
        await start({ command: "cat ~/.openclaw/openclaw.json" }, { toolCallId });
        const update: ToolExecutionUpdateEvent = {
          toolName: "exec",
          toolCallId,
          partialResult: { ...content, details: { status: "running", aggregated: output } },
        };
        updateTool(ctx, update);
        update.hideFromChannelProgress = true;
        for (const now of [1100, 1200, 1250, 1251]) {
          clock.mockReturnValue(now);
          updateTool(ctx, update);
        }
        await end(
          {
            ...content,
            details: {
              status: "completed",
              aggregated: output,
              exitCode: 0,
              durationMs: 12,
              cwd: "/tmp/work",
            },
          },
          { toolCallId },
        );
        const itemUpdates = events.filter(
          (event) => event.stream === "item" && event.data?.phase === "update",
        );
        expect(itemUpdates.map((event) => event.ts)).toEqual([1000, 1100, 1250]);
        expect(itemUpdates.map((event) => event.data?.kind)).toEqual(["tool", "tool", "tool"]);
        expect(itemUpdates[1]?.data?.[field]).toBe(true);
        const updates = events.filter(
          (event) => event.stream === "tool" && event.data?.phase === "update",
        );
        expect(updates.map((event) => event.ts)).toEqual([1000, 1250]);
        const liveResult = requireNestedRecord(updates[0]?.data, "update", ["partialResult"]);
        const resultEvent = requireEvent(
          events,
          (event) => event.stream === "tool" && event.data?.phase === "result",
          "result",
        );
        const finalResult = requireNestedRecord(resultEvent.data, "result", ["result"]);
        for (const result of [liveResult, finalResult]) {
          if (withTextContent) {
            expect(result.details).not.toHaveProperty("aggregated");
            expect(result.content).toEqual([
              { type: "text", text: `${output.slice(0, 8000)}\n…(truncated)…` },
            ]);
          } else {
            expect(result.details).toHaveProperty(
              "aggregated",
              `${output.slice(0, 8000)}\n...(live output truncated)...`,
            );
          }
        }
        expect(onAgentToolResult).toHaveBeenCalledWith({
          toolName: "exec",
          result: expect.objectContaining({
            details: expect.objectContaining({ aggregated: output }),
          }),
          isError: false,
        });
        const commandEvents = onAgentEvent.mock.calls
          .map(([event]) => event)
          .filter((event) => event.stream === "command_output");
        expect(commandEvents.map((event) => event.data.phase)).toEqual(["delta", "delta", "end"]);
        for (const text of commandEvents.map((event) => event.data.output)) {
          expect(text).toBe(`${output.slice(0, 8000)}\n...(live output truncated)...`);
        }
        expect(commandEvents.at(-1)?.data).toMatchObject({
          itemId: "command:exec-lifecycle",
          status: "completed",
          exitCode: 0,
          durationMs: 12,
          cwd: "/tmp/work",
        });
        for (const stream of ["tool", "item"]) {
          expect(
            onAgentEvent.mock.calls
              .map(([event]) => event)
              .filter((event) => event.stream === stream && event.data.phase === "update"),
          ).toHaveLength(5);
        }
        expect(events.slice(-3).map((event) => [event.stream, event.data?.phase])).toEqual([
          ["tool", "result"],
          ["item", "end"],
          ["command_output", "end"],
        ]);
        expect(ctx.state.itemActiveIds.size).toBe(0);
        expect(ctx.state.itemCompletedCount).toBe(ctx.state.itemStartedCount);
      } finally {
        clock.mockRestore();
        unsubscribe();
        resetAgentEventsForTest();
      }
    },
  );

  it("emits patch summary events for apply_patch results", async () => {
    const { onAgentEvent, run } = createToolHarness("apply_patch", "tool-patch-summary");

    await run(
      { patch: "*** Begin Patch" },
      resultWithDetails({
        summary: { added: ["a.ts"], modified: ["b.ts"], deleted: ["c.ts"] },
      }),
    );

    const patchEvent = requireRecord(
      onAgentEvent.mock.calls
        .map((call) => call[0])
        .find((event) => (event as { stream?: string })?.stream === "patch"),
      "patch event",
    );
    expectRecordFields(patchEvent.data, "patch event data", {
      itemId: "patch:tool-patch-summary",
      added: ["a.ts"],
      modified: ["b.ts"],
      deleted: ["c.ts"],
      summary: "1 added, 1 modified, 1 deleted",
    });
  });
});

describe("messaging tool media URL tracking", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it("keeps the suppressed adapter thread independent from scoped session identity", async () => {
    const currentThreadId = undefined;
    registerChannel("telegram", {
      threading: {
        resolveAutoThreadId: ({ toolContext }) => toolContext?.currentThreadTs,
      },
    });
    const { ctx, start, end } = createToolHarness("message", "tool-message-scoped-thread-none", {
      sessionKey: "agent:main:main:thread:1234:42",
      messageChannel: "telegram",
      currentChannelId: "1234",
      currentMessagingTarget: "1234",
      currentThreadId,
      replyToMode: "all",
    });
    await start({ action: "send", to: "1234", message: "thread ownership" });
    await end({ details: { messageId: "message-scoped-thread" } });

    expect(requireSingleMessagingTarget(ctx).threadId).toBe(currentThreadId);
  });

  it("preserves the pre-send reply state when committing implicit thread evidence", async () => {
    registerChannel("slack", {
      messaging: { normalizeTarget: (raw: string) => raw.trim().toLowerCase() },
      threading: {
        resolveAutoThreadId: ({ toolContext }) =>
          toolContext?.replyToMode === "first" && !toolContext.hasRepliedRef?.value
            ? toolContext.currentThreadTs
            : undefined,
      },
    });
    const { ctx, start, end } = createToolHarness("message", "tool-first-threaded-message");
    ctx.params.messageChannel = "slack";
    ctx.params.currentChannelId = "D1";
    ctx.params.currentMessagingTarget = "user:u1";
    ctx.params.currentThreadId = "171.222";
    ctx.params.replyToMode = "first";
    ctx.params.hasRepliedRef = { value: false };

    await start({ action: "send", to: "user:U1", content: "hi" });
    ctx.params.hasRepliedRef.value = true;
    await end({ details: { messageId: "message-1" } });

    expectRecordFields(requireSingleMessagingTarget(ctx), "messaging target", {
      provider: "slack",
      to: "user:u1",
      threadId: "171.222",
      threadImplicit: true,
      text: "hi",
    });
  });

  it("reconciles unresolved send targets from successful provider results", async () => {
    registerChannel("mattermost", {
      actions: {
        extractToolSend: ({ args }) =>
          args.action === "send" && typeof args.to === "string"
            ? { to: args.to, threadImplicit: true }
            : null,
        extractToolSendResult: ({ result }) => {
          const providerResult = result as {
            status?: string;
            details?: { redacted?: boolean; toolSend?: unknown };
          };
          if (providerResult.status !== "sent" || providerResult.details?.redacted !== true) {
            return null;
          }
          const details = providerResult.details;
          return (details?.toolSend as { to: string; threadId?: string } | undefined) ?? null;
        },
      },
    });
    const { ctx, run } = createToolHarness("message", "tool-mattermost-name");
    ctx.consumeToolSendReceipt = () => ({
      details: { toolSend: { to: "channel:resolved-id", threadId: "root-1" } },
    });

    await run(
      { action: "send", provider: "mattermost", to: "town-square", content: "hi" },
      { status: "sent", details: { redacted: true } },
    );

    expectRecordFields(requireSingleMessagingTarget(ctx), "messaging target", {
      provider: "mattermost",
      to: "channel:resolved-id",
      threadId: "root-1",
      text: "hi",
    });
  });

  it.each([
    {
      name: "result payload",
      args: { action: "send", to: "channel:123", content: "hi" },
      result: textResult(
        JSON.stringify({ ok: true, mediaUrls: ["file:///img-a.jpg", "file:///img-b.jpg"] }),
      ),
      text: "hi",
      provider: undefined,
      mediaUrls: ["file:///img-a.jpg", "file:///img-b.jpg"],
    },
    {
      name: "upload and attachment paths",
      args: {
        action: "upload-file",
        channel: "discord",
        to: "channel:123",
        message: "track ready",
        path: "/tmp/generated-song.mp3",
        attachments: [{ filePath: "/tmp/generated-cover.png" }],
      },
      result: { ok: true },
      text: "track ready",
      provider: "discord",
      mediaUrls: ["/tmp/generated-song.mp3", "/tmp/generated-cover.png"],
    },
  ])(
    "commits media delivery evidence from $name",
    async ({ args, result, text, provider, mediaUrls }) => {
      const { ctx, run } = createToolHarness("message", "tool-media");
      await run(args, result);
      expect(ctx.state.messagingToolSentMediaUrls).toEqual(mediaUrls);
      expectRecordFields(requireSingleMessagingTarget(ctx), "messaging target", {
        ...(provider === undefined ? {} : { provider }),
        to: "channel:123",
        text,
        mediaUrls,
      });
    },
  );

  it("commits internal-ui source replies from successful message sends", async () => {
    const { ctx, run } = createToolHarness("message", "tool-internal-source-reply");
    ctx.params.sourceReplyDeliveryMode = "message_tool_only";
    ctx.consumeToolSendReceipt = () => ({
      details: {
        messageDelivery: { status: "settled", partialDelivery: false, createdThreadIds: [] },
      },
    });

    await run(
      { action: "send", message: "visible in tui" },
      resultWithDetails({
        status: "ok",
        deliveryStatus: "sent",
        sourceReplySink: "internal-ui",
        idempotencyKey: "stable-source-reply",
        sourceReply: {
          text: "visible in tui",
          mediaUrls: ["file:///tmp/reply.png"],
          channelData: { source: "tui" },
        },
      }),
    );

    expect(ctx.state.messagingToolSourceReplyPayloads).toEqual([
      {
        text: "visible in tui",
        mediaUrls: ["file:///tmp/reply.png"],
        channelData: { source: "tui" },
        idempotencyKey: "stable-source-reply",
        sourceReplyFinal: true,
      },
    ]);
  });

  it.each([
    {
      kind: "widget",
      presentation: {
        target: "current_channel",
        receipt: {
          primaryPlatformMessageId: "discord-message-1",
          platformMessageIds: ["discord-message-1"],
          parts: [],
          sentAt: 1,
        },
      },
      delivered: true,
    },
    {
      kind: "canvas",
      presentation: { target: "assistant_message", title: "Status", sandbox: "scripts" },
      view: { id: "cv_1", url: "/__openclaw__/canvas/documents/cv_1/index.html" },
      delivered: false,
    },
  ])(
    "records source delivery only for current-channel widgets ($kind)",
    async ({ delivered, ...details }) => {
      const { ctx, run } = createToolHarness("show_widget", "tool-widget");
      const onDeliveredMessageToolOnlySourceReply = vi.fn();
      Object.assign(ctx.params, {
        sourceReplyDeliveryMode: "message_tool_only",
        coreBuiltinToolNames: new Set(["show_widget"]),
        onDeliveredMessageToolOnlySourceReply,
      });
      await run({ title: "Status", widget_code: "<p>ready</p>" }, resultWithDetails(details));
      expect(ctx.state.messageToolOnlySourceReplyDelivered).toBe(delivered);
      expect(onDeliveredMessageToolOnlySourceReply).toHaveBeenCalledTimes(delivered ? 1 : 0);
    },
  );

  it.each([
    {
      name: "payload-only",
      delivery: {
        channel: "googlechat",
        to: "spaces/AAA",
        ok: true,
        payload: { ok: true, messageId: "plugin-message-1" },
      },
      expected: {
        status: "settled",
        primaryPlatformMessageId: "plugin-message-1",
        partialDelivery: false,
        createdThreadIds: [],
      },
      message: "visible after redaction",
      isError: false,
    },
    {
      name: "partial broadcast",
      delivery: {
        channel: "googlechat",
        to: "spaces/AAA",
        ok: false,
        sentBeforeError: true as const,
      },
      expected: { status: "settled", partialDelivery: true, createdThreadIds: [] },
      message: "visible before failure",
      isError: true,
    },
  ])(
    "commits $name delivery after middleware replaces details",
    async ({ delivery, expected, message, isError }) => {
      const { ctx, run } = createToolHarness("message", "tool-private-broadcast");
      ctx.params.sourceReplyDeliveryMode = "message_tool_only";
      const messageDelivery = projectEmbeddedMessageDeliveryFact({
        kind: "broadcast",
        channel: "googlechat",
        action: "broadcast",
        handledBy: "core",
        payload: { results: [delivery] },
        dryRun: false,
      });
      expect(messageDelivery).toEqual(expected);
      ctx.consumeToolSendReceipt = () => ({ details: { messageDelivery } });
      await run({ action: "send", message }, { details: { redacted: true } }, { isError });
      expect(ctx.state.messagingToolSentTexts).toEqual([message]);
      expect(ctx.state.sourceReplyDeliveryState).toBe(isError ? "missing" : "delivered");
    },
  );

  it("does not commit dry-run or external message sends as internal-ui source replies", async () => {
    const { ctx, run } = createToolHarness("message", "tool-dry-run-source-reply");

    await run(
      { action: "send", message: "preview" },
      resultWithDetails({
        status: "ok",
        deliveryStatus: "dry_run",
        sourceReplySink: "internal-ui",
        sourceReply: { text: "preview" },
      }),
    );

    await run(
      { action: "send", to: "channel:123", message: "sent externally" },
      resultWithDetails({
        status: "ok",
        deliveryStatus: "sent",
        sourceReply: { text: "sent externally" },
      }),
      { toolCallId: "tool-external-source-reply" },
    );

    expect(ctx.state.messagingToolSourceReplyPayloads).toHaveLength(0);
  });
});

describe("control UI tool payload fidelity", () => {
  afterEach(() => {
    resetAgentEventsForTest();
  });

  it("preserves gateway arguments and primitive results", async () => {
    const events = captureAgentEvents();
    const { ctx, start, end } = createToolHarness("gateway", "tool-secret");
    const result = "OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789";
    ctx.shouldEmitToolOutput = () => true;
    await start({
      action: "config.apply",
      raw: 'apiKey: "sk-1234567890abcdefXYZ"',
      headers: { Authorization: "Bearer abcdef0123456789QWERTY=" },
    });
    await end(result);
    const emittedResult = requireEvent(
      events,
      (event) => event.stream === "tool" && event.data?.phase === "result",
      "tool result",
    ).data?.result;
    expect(emittedResult).toBe(result);
    expect(ctx.emitToolOutput).toHaveBeenCalledWith(
      "gateway",
      "config.apply",
      emittedResult,
      result,
    );
    const startEvent = requireEvent(
      events,
      (event) => event.stream === "tool" && event.data?.phase === "start",
      "tool start",
    );
    const serialized = JSON.stringify(startEvent.data?.args ?? {});
    expect(serialized).toContain("sk-1234567890abcdefXYZ");
    expect(serialized).toContain("abcdef0123456789QWERTY=");
    expect(serialized).toContain("config.apply");
  });
});

function createMediaHarness(
  toolName: string,
  toolCallId: string,
  overrides: {
    shouldEmitToolOutput?: boolean;
    onToolResult?: NonNullable<ToolHandlerContext["params"]["onToolResult"]>;
    toolResultFormat?: "markdown" | "plain";
    builtinToolNames?: ReadonlySet<string>;
    coreBuiltinToolNames?: ReadonlySet<string>;
    trustedLocalMediaToolNames?: ReadonlySet<string>;
  } = {},
) {
  const harness = createToolHarness(toolName, toolCallId);
  const { ctx } = harness;
  ctx.params.onToolResult =
    overrides.onToolResult ?? vi.fn<NonNullable<ToolHandlerContext["params"]["onToolResult"]>>();
  ctx.params.toolResultFormat = overrides.toolResultFormat;
  ctx.params.coreBuiltinToolNames = overrides.coreBuiltinToolNames;
  ctx.builtinToolNames = overrides.builtinToolNames;
  ctx.trustedLocalMediaToolNames =
    overrides.trustedLocalMediaToolNames ?? overrides.builtinToolNames;
  ctx.shouldEmitToolOutput = () => overrides.shouldEmitToolOutput ?? false;
  ctx.state.pendingToolMediaAttachments = [];
  return harness;
}

describe("handleToolExecutionEnd media emission", () => {
  it("routes image fallback media with verbose output", async () => {
    const onToolResult = vi.fn();
    const { ctx, end } = createMediaHarness("browser", "media-image", {
      shouldEmitToolOutput: true,
      onToolResult,
    });
    await end({
      content: [
        { type: "text", text: "Screenshot saved." },
        { type: "image", data: "base64", mimeType: "image/png" },
      ],
      details: { path: "/tmp/screenshot.png" },
    });
    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.emitToolOutput).toHaveBeenCalledTimes(1);
    expect(ctx.state.pendingToolMediaUrls).toStrictEqual([]);
  });

  it("aligns retained attachment metadata after filtering local media and merging duplicates", async () => {
    const { ctx, end } = createMediaHarness("plugin_tool", "generated-media");
    ctx.state.pendingToolMediaUrls.push("https://example.com/existing.png");
    ctx.state.pendingToolMediaAttachments?.push({});

    await end(
      resultWithDetails({
        media: {
          mediaUrls: [
            "/tmp/private.png",
            "https://example.com/existing.png",
            "https://example.com/video.mp4",
          ],
          attachments: [
            { type: "image", path: "/tmp/private.png", name: "private.png" },
            {
              type: "image",
              url: "https://example.com/existing.png",
              name: "existing.png",
              width: 320,
            },
            {
              type: "video",
              url: "https://example.com/video.mp4",
              name: "friendly-video.mp4",
              durationMs: 5_000,
              width: 1280,
              height: 720,
              trustedLocalMedia: true,
            },
          ],
        },
      }),
    );

    expect(ctx.state.pendingToolMediaUrls).toEqual([
      "https://example.com/existing.png",
      "https://example.com/video.mp4",
    ]);
    expect(ctx.state.pendingToolMediaAttachments).toEqual([
      { type: "image", url: "https://example.com/existing.png", name: "existing.png", width: 320 },
      {
        type: "video",
        url: "https://example.com/video.mp4",
        name: "friendly-video.mp4",
        durationMs: 5_000,
        width: 1280,
        height: 720,
      },
    ]);
    expect(ctx.state.pendingToolMediaTrustByUrl.get("https://example.com/video.mp4")).toBe(false);
  });

  it.each([
    {
      name: "case-variant collision",
      toolName: "Web_Search",
      builtinToolNames: new Set(["web_search"]),
      provenance: {},
    },
    {
      name: "MCP provenance",
      toolName: "browser",
      builtinToolNames: undefined,
      provenance: { mcpServer: "probe", mcpTool: "browser" },
    },
  ])("rejects local media with $name", async ({ toolName, builtinToolNames, provenance }) => {
    const onToolResult = vi.fn();
    const { ctx, end } = createMediaHarness(toolName, "media-untrusted", {
      shouldEmitToolOutput: false,
      onToolResult,
      builtinToolNames,
    });
    await end(
      textResult("Generated media.", {
        media: { mediaUrl: "/tmp/secret.png" },
        ...provenance,
      }),
    );
    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toStrictEqual([]);
  });

  it("queues one voice copy when TTS output text mentions the generated file", async () => {
    const { ctx, end } = createMediaHarness("tts", "tc-1", {
      shouldEmitToolOutput: true,
      onToolResult: vi.fn(),
      toolResultFormat: "plain",
      builtinToolNames: new Set(["tts"]),
      coreBuiltinToolNames: new Set(["tts"]),
    });

    await end(
      markCoreTtsToolResult(
        {
          content: [{ type: "text", text: "Generated audio reply at /tmp/reply.opus" }],
          details: {
            media: { mediaUrl: "/tmp/reply.opus", audioAsVoice: true, trustedLocalMedia: true },
          },
        },
        ["/tmp/reply.opus"],
      ),
    );

    expect(ctx.emitToolOutput).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual(["/tmp/reply.opus"]);
    expect(ctx.state.pendingToolAudioAsVoice).toBe(true);
    expect(ctx.state.toolAutoDeliveryMediaUrls).toEqual(new Set(["/tmp/reply.opus"]));
    expect(ctx.state.pendingToolMediaTrustByUrl.get("/tmp/reply.opus")).toBe(true);
  });

  it("does not grant auto-delivery to a trusted plugin tts when core tts is present", async () => {
    const { ctx, end } = createMediaHarness("tts", "plugin-tts", {
      shouldEmitToolOutput: false,
      builtinToolNames: new Set(["tts"]),
      coreBuiltinToolNames: new Set(["tts"]),
      trustedLocalMediaToolNames: new Set(["tts"]),
    });

    await end(
      resultWithDetails({
        media: { mediaUrl: "/tmp/plugin.opus", audioAsVoice: true, trustedLocalMedia: true },
      }),
    );

    expect(ctx.state.pendingToolMediaUrls).toEqual(["/tmp/plugin.opus"]);
    expect(ctx.state.toolAutoDeliveryMediaUrls).toEqual(new Set());
  });

  it("keeps verbose text for untrusted remote TTS media", async () => {
    const text = "remote tool output";
    const mediaUrl = "https://example.com/reply.opus";
    const { ctx, end } = createMediaHarness("tts", "tc-1", {
      shouldEmitToolOutput: true,
      onToolResult: vi.fn(),
      toolResultFormat: "plain",
      builtinToolNames: new Set(["web_search"]),
    });
    await end(textResult(text, { media: { mediaUrl, audioAsVoice: true } }));
    expect(ctx.emitToolOutput).toHaveBeenCalledExactlyOnceWith("tts", undefined, text, undefined);
    expect(ctx.state.pendingToolMediaUrls).toStrictEqual([mediaUrl]);
    expect(ctx.state.pendingToolAudioAsVoice).toBe(true);
    expect(ctx.state.toolAutoDeliveryMediaUrls).toEqual(new Set());
  });

  it.each([true, false])(
    "admits omitted-name TTS media only with core provenance (%s)",
    async (owned) => {
      const { ctx, end } = createMediaHarness("tts", "tc-1", {
        shouldEmitToolOutput: false,
        onToolResult: vi.fn(),
        builtinToolNames: new Set(["web_search"]),
      });

      const result = {
        content: [{ type: "text", text: "(spoken) hello" }],
        details: {
          media: { mediaUrl: "/tmp/reply.opus", audioAsVoice: true, trustedLocalMedia: true },
        },
      };
      await end(owned ? markCoreTtsToolResult(result, ["/tmp/reply.opus"]) : result);

      expect(ctx.state.pendingToolMediaUrls).toEqual(owned ? ["/tmp/reply.opus"] : []);
      expect(ctx.state.pendingToolAudioAsVoice).toBe(owned);
      expect(ctx.state.pendingToolMediaTrustByUrl.get("/tmp/reply.opus")).toBe(
        owned ? true : undefined,
      );
      expect(ctx.state.toolAutoDeliveryMediaUrls).toEqual(
        new Set(owned ? ["/tmp/reply.opus"] : []),
      );
    },
  );
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
