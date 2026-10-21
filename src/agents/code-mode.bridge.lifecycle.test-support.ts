/** Real embedded subscriber/catalog executor shared by bridge lifecycle regressions. */
import { expectDefined } from "@openclaw/normalization-core";
import { createDiagnosticEmbeddedRunOwner } from "../logging/diagnostic-run-activity.js";
import { createReplyOperation } from "../sessions/session-controller.js";
import { applyCodeModeCatalog, createCodeModeTools } from "./code-mode.js";
import { resultDetails, runUntilCompleted, waitUntilCompleted } from "./code-mode.test-support.js";
import {
  createAttemptNestedToolActivityState,
  readAttemptNestedToolActivity,
} from "./embedded-agent-runner/run/attempt-nested-tool-activity.js";
import { prepareEmbeddedAttemptStream } from "./embedded-agent-runner/run/attempt-stream-prepare.js";
import type { EmbeddedRunAttemptParams } from "./embedded-agent-runner/run/types.js";
import { clearTestEmbeddedRun as clearActiveEmbeddedRun } from "./embedded-agent-runner/runs.test-support.js";
import { createStubSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import type { Agent } from "./runtime/index.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";
import { SessionManager } from "./sessions/session-manager.js";
import { clearToolSearchCatalog, createToolSearchCatalogRef } from "./tool-search.js";
import type { AnyAgentTool } from "./tools/common.js";

export function createSubscribedCodeModeHarness(params: {
  name: string;
  sessionManager?: SessionManager;
  agent?: Agent;
  onBlockReplyFlush?: () => Promise<void>;
  onToolResult?: EmbeddedRunAttemptParams["onToolResult"];
  onBlockReply?: EmbeddedRunAttemptParams["onBlockReply"];
  onPartialReply?: EmbeddedRunAttemptParams["onPartialReply"];
  sourceReplyDeliveryMode?: EmbeddedRunAttemptParams["sourceReplyDeliveryMode"];
  timeoutMs?: number;
  observeToolTerminal?: EmbeddedRunAttemptParams["observeToolTerminal"];
  onToolStreamBoundary?: EmbeddedRunAttemptParams["onToolStreamBoundary"];
}) {
  const runId = `run-code-mode-${params.name}`;
  const sessionId = `session-code-mode-${params.name}`;
  const sessionKey = `agent:main:${params.name}`;
  const config = {
    tools: { codeMode: { enabled: true, timeoutMs: params.timeoutMs ?? 1_500 } },
  } as never;
  const catalogRef = createToolSearchCatalogRef();
  const runAbortController = new AbortController();
  const replyOperation = createReplyOperation({
    sessionKey,
    sessionId,
    agentId: "main",
    resetTriggered: false,
  });
  const { session, emit } = createStubSessionHarness();
  const sessionManager = params.sessionManager ?? SessionManager.inMemory();
  const nestedToolActivityState = createAttemptNestedToolActivityState();
  guardSessionManager(sessionManager, { config: {}, runId, sessionKey });
  const activeSession = Object.assign(session, {
    sessionManager,
    agent: params.agent ?? { hasQueuedMessages: () => false },
    isStreaming: false,
    messages: [],
    pendingMessageCount: 0,
  });
  const stream = prepareEmbeddedAttemptStream({
    attempt: {
      config,
      runId,
      sessionId,
      sessionKey,
      replyOperation,
      onToolResult: params.onToolResult,
      observeToolTerminal: params.observeToolTerminal,
      onToolStreamBoundary: params.onToolStreamBoundary,
      onPartialReply: params.onPartialReply,
      sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
      blockReplyBreak: "message_end",
    } as never,
    agentSession: {
      activeSession: activeSession as never,
      hookRunner: undefined as never,
      clientToolCallSlots: [],
      hasDeliveredSourceReply: () => false,
      markSourceReplyDelivered: () => undefined,
      builtinToolNames: new Set(),
      sourceReplyCapableToolNames: new Set(),
      coreBuiltinToolNames: new Set(),
      replaySafeToolNames: new Set(),
      codeModeExecToolNames: new Set(),
      sideEffectToolOwners: new Map(),
      trustedLocalMediaToolNames: new Set(),
    },
    hookAgentId: "main",
    diagnosticTrace: {} as never,
    diagnosticOwner: createDiagnosticEmbeddedRunOwner({ sessionId, sessionKey, runId }),
    nestedToolActivityState,
    isReplaySafeTool: () => false,
    runAbortController,
    abortRun: () => runAbortController.abort(),
    markExternalAbort: () => undefined,
    getRunState: () => ({
      aborted: runAbortController.signal.aborted,
      promptError: undefined,
      timedOut: false,
      yieldDetected: false,
    }),
    onBlockReply: params.onBlockReply,
    onBlockReplyFlush: params.onBlockReplyFlush,
  });
  const context = {
    config,
    runtimeConfig: config,
    sessionId,
    sessionKey,
    runId,
    catalogRef,
    abortSignal: runAbortController.signal,
    executeTool: stream.toolSearchCatalogExecutor,
  };
  const tools = createCodeModeTools(context);
  const exec = expectDefined(tools[0], "Code Mode exec");
  const wait = expectDefined(tools[1], "Code Mode wait");
  type CallOptions = Partial<
    Omit<Parameters<typeof context.executeTool>[0], "tool" | "toolName">
  > & {
    toolCallId: string;
  };
  return {
    ...context,
    replyOperation,
    sessionManager,
    readNestedActivities: () =>
      readAttemptNestedToolActivity(sessionManager, nestedToolActivityState),
    emit,
    tools,
    exec,
    wait,
    add: (...targets: AnyAgentTool[]) =>
      applyCodeModeCatalog({ ...context, tools: [...tools, ...targets] }),
    run: async (code: string, toolCallId = "code-call", signal?: AbortSignal) =>
      resultDetails(await exec.execute(toolCallId, { code }, signal)),
    complete: (code: string) => runUntilCompleted({ execTool: exec, waitTool: wait, code }),
    resume: (details: Record<string, unknown>) => waitUntilCompleted({ details, waitTool: wait }),
    call: (tool: AnyAgentTool, options: CallOptions) =>
      context.executeTool({
        tool,
        toolName: tool.name,
        source: "openclaw",
        input: {},
        acceptResultBeforeProjection: async (result) => result,
        ...options,
      }),
    runAbortController,
    subscription: stream.subscription,
    dispose: () => {
      clearToolSearchCatalog(context);
      stream.subscription.unsubscribe();
      clearActiveEmbeddedRun(sessionId, stream.queueHandle, sessionKey);
      replyOperation.complete();
    },
  };
}
