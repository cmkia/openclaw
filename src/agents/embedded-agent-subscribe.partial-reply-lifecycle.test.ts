import { AssistantMessageEventStream, type Message } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processCompletionsStream } from "../../packages/ai/src/transports/openai-completions-stream.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { onAgentEventForRun } from "../infra/agent-events.js";
import { runAgentLoop } from "../plugin-sdk/agent-core.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";
import { makeZeroUsageSnapshot } from "./usage.js";
const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  info: vi.fn(),
  isEnabled: vi.fn(() => false),
  trace: vi.fn(),
  warn: vi.fn(),
}));

// mock-isolation: Keep process-wide logger state outside the reply lifecycle fixture.
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => logger }));

import {
  createStubSessionHarness,
  createSubscribedSessionHarness,
  emitAssistantTextDelta,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { createReplyDelivery } from "./embedded-agent-subscribe.reply-delivery.js";
import { EmbeddedAgentSubscribeState } from "./embedded-agent-subscribe.run-state.js";
import type { SubscribeEmbeddedAgentSessionParams } from "./embedded-agent-subscribe.types.js";

type Subscription = ReturnType<typeof createSubscribedSessionHarness>["subscription"];
type Delivery = ReturnType<typeof createReplyDelivery>;
type Params = Omit<SubscribeEmbeddedAgentSessionParams, "session">;
type PartialReply = NonNullable<Params["onPartialReply"]>;
let runIndex = 0;
const pendingTasks: Array<{ resolve: () => void }> = [];
const subscriptions: Subscription[] = [];
const deliveries: Delivery[] = [];
const listeners: Array<() => void> = [];
function pending() {
  const task = createDeferred();
  pendingTasks.push(task);
  return task;
}
function subscribe(params: Params) {
  const harness = createSubscribedSessionHarness(params);
  subscriptions.push(harness.subscription);
  return harness;
}
function createDelivery(params: Params) {
  const options = { ...params, session: createStubSessionHarness().session };
  const delivery = createReplyDelivery({
    params: options,
    state: new EmbeddedAgentSubscribeState(options),
    log: logger,
  });
  deliveries.push(delivery);
  return delivery;
}
function fixture<T extends object>(
  create: (params: Params) => T,
  { observeEvents = false, ...hooks }: Partial<Params> & { observeEvents?: boolean } = {},
) {
  const partial = pending();
  const partials: Array<{ text?: string; delta?: string }> = [];
  const bus: Array<{ text: unknown; delta: unknown }> = [];
  const starts: string[] = [];
  const onPartialReply = vi.fn((payload: Parameters<PartialReply>[0]) => {
    partials.push({ text: payload.text, delta: payload.delta });
    starts.push(`partial:${payload.text}`);
    return hooks.onPartialReply ? hooks.onPartialReply(payload) : partial.promise;
  });
  const onAgentEvent = vi.fn((event: Parameters<NonNullable<Params["onAgentEvent"]>>[0]) => {
    if (event.stream === "assistant") {
      bus.push({ text: event.data.text, delta: event.data.delta });
    }
    if (event.stream === "tool" && event.data.phase === "start") {
      starts.push("tool");
    }
    return hooks.onAgentEvent?.(event);
  });
  return Object.assign(
    create({
      runId: `run-partial-${++runIndex}`,
      ...hooks,
      onPartialReply,
      ...(observeEvents || hooks.onAgentEvent ? { onAgentEvent } : {}),
    }),
    { partial, partials, bus, starts, onPartialReply, onAgentEvent },
  );
}
const rawDrain = (subscription: Subscription) =>
  subscription.waitForPendingEvents({ includePartialReplies: false });
function emitDeltas(emit: (event: unknown) => void, deltas = ["First", " second", " third"]) {
  for (const delta of deltas) {
    emitAssistantTextDelta({ emit, delta });
  }
}
function append(delivery: Delivery, text: string, delta: string, phase?: "final_answer") {
  delivery.emitAssistantStreamData(
    { text, delta, ...(phase ? { phase } : {}) },
    { emitPartialReply: true },
  );
}
const fragments = (...pairs: [string, string][]) => pairs.map(([text, delta]) => ({ text, delta }));
describe("subscribeEmbeddedAgentSession partial reply lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(async () => {
    pendingTasks.splice(0).forEach((task) => task.resolve());
    for (const subscription of subscriptions.splice(0)) {
      subscription.unsubscribe();
      await subscription.waitForPendingEvents();
    }
    for (const delivery of deliveries.splice(0)) {
      await delivery.waitForPendingEvents();
      delivery.clearAssistantStream();
    }
    listeners.splice(0).forEach((off) => off());
    vi.restoreAllMocks();
  });
  it("paces cumulative preview reads and settles the exact last append", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const delivery = fixture(createDelivery, { onPartialReply: () => undefined });
    const { partials } = delivery;
    append(delivery, "A", "A");
    clock.mockReturnValue(1_010);
    append(delivery, "AB", "B");
    expect(partials).toEqual(fragments(["A", "A"]));
    clock.mockReturnValue(1_080);
    append(delivery, "ABC", "C");
    expect(partials).toEqual(fragments(["A", "A"], ["ABC", "BC"]));
    append(delivery, "ABCD", "D");
    await delivery.waitForPendingEvents();
    expect(partials.at(-1)).toEqual({ text: "ABCD", delta: "D" });
  });

  it("joins a partial reply task created while terminal events settle", async () => {
    const { emit, subscription, partial, onPartialReply } = fixture(subscribe, {
      onBeforeTerminalDelivery: async () => undefined,
    });
    emitAssistantTextDelta({ emit, delta: "partial answer" });
    const failedAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "partial answer" }],
      stopReason: "error",
      errorMessage: "provider failed after partial",
      provider: "test-provider",
      model: "test-model",
    };
    emit({ type: "message_end", message: failedAssistant });
    emit({ type: "agent_end", messages: [failedAssistant], willRetry: false });
    const settled = vi.fn<() => void>();
    const settlement = subscription.waitForPendingEvents().then(settled);
    await vi.waitFor(() => expect(onPartialReply).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    partial.resolve();
    await settlement;
    expect(settled).toHaveBeenCalledOnce();
  });

  it("contains and logs a rejected partial reply after unsubscribe", async () => {
    const callbackError = new Error("draft send rejected");
    const { emit, subscription, partial, onPartialReply } = fixture(subscribe);
    emitAssistantTextDelta({ emit, delta: "partial answer" });
    await vi.waitFor(() => expect(onPartialReply).toHaveBeenCalledOnce());
    emitDeltas(emit, [" queued", " tail"]);
    await rawDrain(subscription);
    expect(onPartialReply).toHaveBeenCalledOnce();
    subscription.unsubscribe();
    partial.reject(callbackError);
    await expect(subscription.waitForPendingEvents()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      `assistant partial reply callback failed: ${String(callbackError)}`,
    );
    expect(onPartialReply).toHaveBeenCalledOnce();
  });

  it("queue-only drain coalesces a stalled partial and joins its latest successor", async () => {
    const first = pending();
    const h = fixture(subscribe, { observeEvents: true });
    h.onPartialReply.mockImplementationOnce(() => first.promise);
    emitDeltas(h.emit);
    const drained = vi.fn<() => void>();
    const broadDrain = h.subscription.waitForPendingEvents().then(drained);
    // Timeout salvage joins only handlers that mutate the raw text buffer.
    await rawDrain(h.subscription);
    expect(drained).not.toHaveBeenCalled();
    expect(h.onPartialReply).toHaveBeenCalledOnce();
    expect(h.onPartialReply).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "First", delta: "First" }),
    );
    expect(
      h.onAgentEvent.mock.calls.filter(([event]) => event.stream === "assistant"),
    ).toHaveLength(3);
    first.resolve();
    await vi.waitFor(() => expect(h.onPartialReply).toHaveBeenCalledTimes(2));
    expect(h.onPartialReply).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "First second third", delta: " second third" }),
    );
    expect(drained).not.toHaveBeenCalled();
    h.partial.resolve();
    await broadDrain;
    expect(drained).toHaveBeenCalledOnce();
  });

  it("starts the latest partial before a nested tool without waiting for a stalled send", async () => {
    const { emit, subscription, starts } = fixture(subscribe, { observeEvents: true });
    emitDeltas(emit);
    await rawDrain(subscription);
    expect(starts).toEqual(["partial:First"]);
    await subscription.runToolLifecycle({
      toolName: "read",
      toolCallId: "read-after-text",
      args: { path: "/tmp/input" },
      execute: async (onStart) => {
        onStart();
        return { content: [{ type: "text", text: "Read complete." }] };
      },
    });
    await rawDrain(subscription);
    expect(starts).toEqual(["partial:First", "partial:First second third", "tool"]);
    emitAssistantTextDelta({ emit, delta: " fourth" });
    await rawDrain(subscription);
    expect(starts.at(-1)).toBe("partial:First second third fourth");
  });

  it("preserves both delta domains when a retired callback reenters an unemitted scope", async () => {
    const first = pending();
    const onPartialReply = vi
      .fn<PartialReply>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => append(delivery, "ABCD", "D", "final_answer"));
    const delivery: ReturnType<typeof fixture<Delivery>> = fixture(createDelivery, {
      onPartialReply,
      observeEvents: true,
    });
    const { partials, bus } = delivery;
    append(delivery, "A", "A");
    append(delivery, "AB", "B");
    expect(partials).toEqual(fragments(["A", "A"]));
    append(delivery, "ABC", "C", "final_answer");
    expect(partials).toEqual(fragments(["A", "A"], ["AB", "B"], ["ABCD", "CD"]));
    expect(bus).toEqual(partials);
  });

  it("keeps reasoning deltas coherent when partial delivery reenters", async () => {
    const partial = pending();
    const runId = "run-reasoning-reentrant-partial";
    const bus: Array<{ text: unknown; delta: unknown }> = [];
    const off = onAgentEventForRun(runId, (event) => {
      if (event.stream === "thinking") {
        bus.push({ text: event.data.text, delta: event.data.delta });
      }
    });
    listeners.push(off);
    const onPartialReply = vi
      .fn<PartialReply>()
      .mockImplementationOnce(() => partial.promise)
      .mockImplementationOnce(() => emitThinking("AX", "X"));
    const { emit } = fixture(subscribe, { runId, onPartialReply });
    function emitThinking(thinking: string, delta: string): void {
      const message = { role: "assistant", content: [{ type: "thinking", thinking }] };
      emit({
        type: "message_update",
        message,
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta, partial: message },
      });
    }
    emit({ type: "message_start", message: { role: "assistant", content: [] } });
    emitThinking("A", "A");
    emitDeltas(emit, ["a", "b", "<think>AB"]);
    expect(onPartialReply).toHaveBeenCalledTimes(2);
    expect(bus).toEqual(fragments(["A", "A"], ["AX", "X"], ["AB", "AB"]));
  });

  it("starts the first partial once before a reentrant block reply", async () => {
    const delivery: ReturnType<typeof fixture<Delivery>> = fixture(createDelivery, {
      onAgentEvent: (event) => {
        if (event.stream === "assistant") {
          delivery.emitBlockReply({ text: "Block." });
        }
      },
      onPartialReply: () => undefined,
      onBlockReply: (payload) => {
        delivery.starts.push(`block:${payload.text}`);
      },
    });
    append(delivery, "First", "First");
    await delivery.waitForPendingEvents();
    expect(delivery.starts).toEqual(["partial:First", "block:Block."]);
  });

  it("retires pending partials at a sanitized empty generic commentary boundary", async () => {
    const { emit, subscription, partials, onAgentEvent } = fixture(subscribe, {
      observeEvents: true,
    });
    const text = "<think>hidden reasoning</think>";
    const textSignature = JSON.stringify({ v: 1, id: "commentary", phase: "commentary" });
    const message = { role: "assistant", content: [{ type: "text", text, textSignature }] };
    const commentary = {
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", delta: "", partial: message },
    };
    emit(commentary);
    emitDeltas(emit);
    await rawDrain(subscription);
    expect(partials).toEqual(fragments(["First", "First"]));
    emit(commentary);
    await rawDrain(subscription);
    expect(partials).toEqual(
      fragments(["First", "First"], ["First second third", " second third"]),
    );
    emitAssistantTextDelta({ emit, delta: " fourth" });
    await rawDrain(subscription);
    expect(partials.at(-1)).toEqual({ text: "First second third fourth", delta: " fourth" });
    const preambleEvents = onAgentEvent.mock.calls.filter(
      ([event]) => event.stream === "item" && event.data.kind === "preamble",
    );
    expect(preambleEvents).toHaveLength(0);
  });
});

const NATIVE_REASONING_BENCH_PREFIX = "REASONING_BENCH:";

it("keeps native reasoning prefix comparison work linear", async ({ signal }) => {
  const runId = "native-reasoning-prefix-work";
  const probe = vi.spyOn(String.prototype, "startsWith");
  let comparedPrefixChars = 0;
  const collectPrefixWork = () => {
    for (const [index, [search, position]] of probe.mock.calls.entries()) {
      const text = probe.mock.contexts[index];
      if (
        typeof text === "string" &&
        typeof search === "string" &&
        (position ?? 0) === 0 &&
        text.slice(0, NATIVE_REASONING_BENCH_PREFIX.length) === NATIVE_REASONING_BENCH_PREFIX &&
        search.length > NATIVE_REASONING_BENCH_PREFIX.length
      ) {
        comparedPrefixChars += search.length;
      }
    }
    // Keeping every argument would itself retain all historical prefixes.
    probe.mockClear();
  };
  const off = onAgentEventForRun(runId, collectPrefixWork);
  const chunks = Array.from({ length: 4096 }, (_, index) =>
    (index === 0 ? NATIVE_REASONING_BENCH_PREFIX : "").padEnd(64, "x"),
  );
  const model = makeProviderModelFixture({
    id: "reasoning-fixture",
    api: "openai-completions",
    provider: "synthetic",
    baseUrl: "https://example.test/v1",
    reasoning: true,
  });
  const output = makeAgentAssistantMessage({
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: makeZeroUsageSnapshot(),
    timestamp: 1,
  });
  const acknowledgments = chunks.map(() => createDeferred());
  const release = () => acknowledgments.forEach((acknowledgment) => acknowledgment.resolve());
  signal.addEventListener("abort", release, { once: true });
  if (signal.aborted) {
    release();
  }
  const frame = (
    delta: { role?: "assistant"; reasoning_content?: string },
    finish_reason: "stop" | null = null,
  ) => ({
    id: "reasoning-fixture",
    object: "chat.completion.chunk" as const,
    created: 1,
    model: model.id,
    choices: [{ index: 0, delta, finish_reason }],
  });
  async function* wire() {
    for (const [index, text] of chunks.entries()) {
      yield frame({ role: "assistant", reasoning_content: text });
      await acknowledgments[index]!.promise;
    }
    yield frame({}, "stop");
  }
  const { emit, subscription } = createSubscribedSessionHarness({ runId });
  const observed = { text: "", delta: "", events: 0 };
  const unsubscribe = onAgentEventForRun(runId, (event) => {
    if (event.stream === "thinking") {
      observed.text = String(event.data.text);
      observed.delta += String(event.data.delta);
      observed.events++;
    }
  });
  const stream = new AssistantMessageEventStream();
  stream.push({ type: "start", partial: output });
  let producing: Promise<void> | undefined;
  let consumed = 0;
  try {
    try {
      await runAgentLoop(
        [{ role: "user", content: "Explain the fixture.", timestamp: 0 }],
        { systemPrompt: "", messages: [] },
        {
          model,
          convertToLlm: (messages) =>
            messages.filter((message): message is Message =>
              ["user", "assistant", "toolResult"].includes(message.role),
            ),
        },
        async (event) => {
          emit(event);
          await subscription.waitForPendingEvents();
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent.type === "thinking_delta"
          ) {
            acknowledgments[consumed++]?.resolve();
          }
        },
        signal,
        (_model, _context, streamOptions) => {
          producing = processCompletionsStream(wire(), output, model, stream, {
            signal: streamOptions?.signal,
          }).then(
            () => {
              stream.push({ type: "done", reason: "stop", message: output });
              stream.end();
            },
            (error: unknown) => {
              stream.end({ ...output, stopReason: "error", errorMessage: String(error) });
              throw error;
            },
          );
          void producing.catch(() => {});
          return stream;
        },
      );
      await producing;
    } finally {
      signal.removeEventListener("abort", release);
      release();
      unsubscribe();
      subscription.unsubscribe();
      await producing?.catch(() => {});
    }
    collectPrefixWork();
    const expected = chunks.join("").trim();
    expect([observed.text, observed.delta, observed.events]).toEqual([
      expected,
      expected,
      chunks.length,
    ]);
    expect(comparedPrefixChars).toBeLessThan(chunks.join("").length * 4);
  } finally {
    off();
    probe.mockRestore();
  }
});
