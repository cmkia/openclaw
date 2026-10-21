import { GrammyError } from "grammy";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import { buildTelegramApprovalCallbackData } from "./approval-callback-data.js";
import {
  createTelegramSpooledReplayDeferredParticipant,
  recordTelegramMessageProcessingResult,
  resolveTelegramUpdateReceivedAtSeconds,
  runWithTelegramUpdateProcessingFrame,
  type TelegramSpooledReplayDeferredParticipant,
} from "./bot-processing-outcome.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { resolveTelegramForumFlag } from "./bot/helpers.js";
import { commitTelegramMessageDispatchReplay } from "./message-dispatch-dedupe.js";
import { createTelegramIngressMonitor } from "./telegram-ingress-drain.js";
import type { TelegramSpooledUpdatePayload } from "./telegram-ingress-spool.payload.js";
import { telegramSpooledUpdateLaneKey } from "./telegram-ingress-spool.test-support.js";
import { createTelegramPrivateTopicCallback } from "./test-support/webhook-fixtures.js";

type MonitorOptions = Parameters<typeof createTelegramIngressMonitor>[0];
type Queue = MonitorOptions["queue"];
type MakeMonitor = (
  options: Omit<MonitorOptions, "queue" | "getConfig" | "accountId">,
) => ReturnType<typeof createTelegramIngressMonitor>;

function createFixture(stateDir: string) {
  const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
    channelId: "telegram",
    accountId: "default",
    stateDir,
  });
  return {
    stateDir,
    queue,
    monitor: (options: Parameters<MakeMonitor>[0]) =>
      createTelegramIngressMonitor({ queue, ...monitorDefaults, ...options }),
    enqueue: async (updateId: number, callback = false) => {
      const payload = callback ? callbackPayload(updateId) : updatePayload(updateId);
      const eventId = String(updateId).padStart(16, "0");
      const laneKey = telegramSpooledUpdateLaneKey(payload.update);
      await queue.enqueue(eventId, payload, { laneKey });
      return { eventId, payload, laneKey };
    },
  };
}
async function withTempState<T>(fn: (fixture: ReturnType<typeof createFixture>) => Promise<T>) {
  return withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-telegram-ingress-drain-", applyEnv: false },
    ({ stateDir }) => fn(createFixture(stateDir)),
  );
}

const cfg: OpenClawConfig = {
  channels: { telegram: { allowFrom: ["111"], dmPolicy: "allowlist" } },
};
const monitorDefaults = { getConfig: () => cfg, accountId: "default" };

function updatePayload(updateId: number) {
  return {
    version: 1,
    updateId,
    receivedAt: updateId,
    update: {
      update_id: updateId,
      message: { text: "hello", from: { id: 111 }, chat: { id: 111, type: "private" } },
    },
  } satisfies TelegramSpooledUpdatePayload;
}

function callbackPayload(updateId: number) {
  const payload = updatePayload(updateId);
  return {
    ...payload,
    update: {
      update_id: updateId,
      callback_query: {
        id: `callback-${updateId}`,
        data: "choice",
        from: { id: 111 },
        message: payload.update.message,
      },
    },
  } satisfies TelegramSpooledUpdatePayload;
}

function telegramSendError(errorCode: number, description: string): GrammyError {
  return new GrammyError(
    "Call to 'sendMessage' failed",
    { ok: false, error_code: errorCode, description },
    "sendMessage",
    { chat_id: 111 },
  );
}

async function createTelegramMessageDispatchReplayForgetError(): Promise<unknown> {
  type ReplayGuard = Parameters<typeof commitTelegramMessageDispatchReplay>[0]["guard"];
  type ReplayClaim = import("openclaw/plugin-sdk/persistent-dedupe").ChannelReplayClaimHandle;
  const diskError = new Error("dedupe disk write failed");
  const guard: ReplayGuard = {
    claim: async () => ({ kind: "invalid" }),
    forget: async (event) => !("keys" in event && event.keys?.[0] === "first"),
    warmup: async () => 0,
  };
  const claims: ReplayClaim[] = ["first", "second"].map((key) => ({
    keys: [key],
    commit: async (options) => {
      if (key === "second") {
        options?.onDiskError?.(diskError);
      }
      return true;
    },
    release: () => undefined,
  }));
  try {
    await commitTelegramMessageDispatchReplay({ guard, claims, requirePersistent: true });
  } catch (error) {
    return error;
  }
  throw new Error("expected Telegram dispatch rollback failure");
}

const deferred = <T = void>() => Promise.withResolvers<T>();

async function startDeferred(makeMonitor: MakeMonitor, name: string) {
  const participant: { current?: TelegramSpooledReplayDeferredParticipant } = {};
  const dispatch = vi.fn(async () => {
    participant.current = createTelegramSpooledReplayDeferredParticipant(name) ?? undefined;
  });
  const monitor = makeMonitor({ dispatch });
  monitor.start();
  await vi.waitFor(() => expect(participant.current).toBeDefined());
  return { monitor, participant, dispatch };
}

async function expectPending(queue: Queue, rows: Array<Record<string, unknown>>) {
  expect(await queue.listPending({ limit: "all" })).toMatchObject(rows);
}

async function waitPending(queue: Queue, rows: Array<Record<string, unknown>>) {
  await vi.waitFor(() => expectPending(queue, rows));
}

const replayBotId = telegramBotInfoForTest.id;
type StoredUpdate = { update_id: number } & Record<string, unknown>;
type ReplayCheck = {
  topicsEnabled?: boolean;
  rejected?: boolean;
  expectedLane?: string;
  receivedAt?: number;
};
async function withStoredReplay(
  entries: Array<{ update: StoredUpdate; laneKey: string; receivedAt?: number }>,
  run: (fixture: ReturnType<typeof createFixture>) => Promise<void>,
) {
  await withTempState(async ({ stateDir, queue }) => {
    for (const { update, laneKey, receivedAt = Date.now() } of entries) {
      await queue.enqueue(
        String(update.update_id).padStart(16, "0"),
        { ...updatePayload(update.update_id), receivedAt, update },
        { laneKey },
      );
    }
    expect((await queue.listPending()).map((record) => record.laneKey)).toEqual(
      entries.map(({ laneKey }) => laneKey),
    );
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await run(createFixture(stateDir));
  });
}
async function checkStoredReplay(update: StoredUpdate, laneKey: string, options: ReplayCheck = {}) {
  await withStoredReplay(
    [{ update, laneKey, receivedAt: options.receivedAt }],
    async ({ queue, monitor: makeMonitor }) => {
      const dispatch = vi.fn(async (dispatchedUpdate: unknown) => {
        if (options.receivedAt !== undefined) {
          expect(resolveTelegramUpdateReceivedAtSeconds(dispatchedUpdate)).toBe(
            Math.floor(options.receivedAt / 1000),
          );
        }
        if (options.expectedLane) {
          expect(await queue.listClaims()).toMatchObject([{ laneKey: options.expectedLane }]);
        }
        return { kind: "completed" as const };
      });
      const monitor = makeMonitor({
        botInfo: { ...telegramBotInfoForTest, has_topics_enabled: options.topicsEnabled ?? false },
        dispatch,
      });
      try {
        monitor.start();
        await monitor.waitForIdle();
        if (options.rejected) {
          expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
            { reason: "invalid-event", laneKey },
          ]);
          expect(dispatch).not.toHaveBeenCalled();
        } else {
          expect(dispatch).toHaveBeenCalledExactlyOnceWith(update, expect.any(Object));
          expect(await queue.listFailed?.()).toEqual([]);
          await expect(
            queue.enqueue(
              String(update.update_id).padStart(16, "0"),
              { ...updatePayload(update.update_id), update },
              { laneKey: options.expectedLane ?? laneKey },
            ),
          ).resolves.toMatchObject({ kind: "completed" });
        }
        expect(await queue.listPending()).toEqual([]);
      } finally {
        await monitor.stop();
      }
    },
  );
}
function replayMessage(update_id: number, message_thread_id?: number) {
  return {
    update_id,
    message: {
      chat: { id: 1234, type: "private" },
      message_id: update_id,
      text: "replay",
      ...(message_thread_id === undefined ? {} : { message_thread_id }),
    },
  };
}
function replayApproval(approvalKind: "exec" | "plugin", decision: "allow-once" | "deny") {
  return buildTelegramApprovalCallbackData({
    type: "approval",
    approvalKind,
    approvalId: "signed-approval",
    decision,
  });
}

type Callback = ReturnType<typeof createTelegramPrivateTopicCallback>;
type CallbackPatch = Partial<Omit<Callback, "from" | "message">> & {
  from?: Omit<Partial<Callback["from"]>, "is_bot"> & { is_bot?: boolean };
  inline_message_id?: string;
  inlineOnly?: boolean;
  message?: Partial<Omit<Callback["message"], "from" | "chat">> & {
    from?: Partial<Callback["message"]["from"]>;
    chat?: Partial<Callback["message"]["chat"]>;
    business_connection_id?: string;
    guest_query_id?: string;
    sender_chat?: { id: number; type: "channel" };
    direct_messages_topic?: { topic_id: number };
  };
};
function patchedCallback({ from, message, inlineOnly, ...patch }: CallbackPatch) {
  const callback = createTelegramPrivateTopicCallback(141, replayBotId);
  const { message: originalMessage, ...envelope } = callback;
  return {
    ...envelope,
    ...patch,
    from: { ...callback.from, ...from },
    ...(!inlineOnly
      ? {
          message: {
            ...originalMessage,
            ...message,
            from: { ...originalMessage.from, ...message?.from },
            chat: { ...originalMessage.chat, ...message?.chat },
          },
        }
      : {}),
  };
}

describe("createTelegramIngressMonitor", () => {
  it.each([
    {
      name: "wrapped callback authority rejection",
      callback: true,
      error: new Error("spooled callback failed", {
        cause: new Error("Gateway requester authority changed"),
      }),
      reason: "callback-authority-changed",
      message: "Gateway requester authority changed",
    },
    {
      name: "deferred callback authority rejection",
      callback: true,
      deferred: true,
      error: new Error("Gateway requester authority changed"),
      reason: "callback-authority-changed",
      message: "Gateway requester authority changed",
    },
    {
      name: "expired callback query",
      callback: true,
      error: new GrammyError(
        "Call to 'answerCallbackQuery' failed",
        {
          ok: false,
          error_code: 400,
          description:
            "Bad Request: query is too old and response timeout expired or query ID is invalid",
        },
        "answerCallbackQuery",
        { callback_query_id: "expired-callback" },
      ),
      reason: "callback-query-expired",
      message: "query is too old",
    },
    {
      name: "blocked Telegram recipient",
      error: telegramSendError(403, "Forbidden: bot was blocked by the user"),
      reason: "recipient-unreachable",
      message: "bot was blocked by the user",
    },
    {
      name: "wrapped missing harness",
      error: new Error("Agent turn failed", {
        cause: new Error('Requested agent harness "missing-harness-85470" is not registered.'),
      }),
      reason: "missing-agent-harness",
      message: 'Requested agent harness "missing-harness-85470" is not registered.',
    },
    {
      name: "wrapped archived session rejection",
      error: new Error("Command failed", {
        cause: Object.assign(new Error("Restore the archived session before starting work."), {
          name: "SessionWorkStartError",
          reason: "archived",
          retryable: false,
        }),
      }),
      reason: "session-archived",
      message: "Restore the archived session before starting work.",
    },
  ])("dead-letters a $name and releases the next same-chat update", async (testCase) => {
    const { error, reason, message } = testCase;
    const callback = "callback" in testCase && testCase.callback;
    await withTempState(async ({ queue, monitor: makeMonitor, enqueue }) => {
      const { eventId } = await enqueue(3, callback);
      await enqueue(4);
      const dispatch = vi
        .fn<MonitorOptions["dispatch"]>()
        .mockImplementationOnce(async () => {
          if ("deferred" in testCase && testCase.deferred) {
            const participant = createTelegramSpooledReplayDeferredParticipant("callback");
            participant?.settle({ kind: "failed-retryable", error });
            return undefined;
          }
          return { kind: "failed-retryable", error };
        })
        .mockResolvedValue({ kind: "completed" });
      const monitor = makeMonitor({ dispatch });

      monitor.start();
      await monitor.waitForIdle();

      expect(dispatch.mock.calls.map(([update]) => update)).toEqual([
        (callback ? callbackPayload(3) : updatePayload(3)).update,
        updatePayload(4).update,
      ]);
      expect(await queue.listFailed?.({ limit: "all" })).toEqual([
        expect.objectContaining({
          id: eventId,
          reason,
          message: expect.stringContaining(message),
        }),
      ]);
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
      await monitor.stop();
    });
  });

  it("keeps a fresh admission lane when the forum cache changes during ACK", async () => {
    await withTempState(async ({ queue, monitor: makeMonitor }) => {
      const update = {
        update_id: 17,
        message: {
          text: "hello",
          from: { id: 111 },
          chat: { id: -9017, type: "supergroup" },
        },
      };
      await resolveTelegramForumFlag({
        chatId: -9017,
        chatType: "supergroup",
        isGroup: true,
        isForum: false,
      });
      const ackEntered = deferred();
      const ackRelease = deferred();
      const receivedAt = 1_700_000_000_000;
      const delivered: Array<{ laneKey: string | undefined; receivedAt: number }> = [];
      const monitor = makeMonitor({
        botInfo: telegramBotInfoForTest,
        onDurableAdmission: async () => {
          ackEntered.resolve();
          await ackRelease.promise;
        },
        dispatch: async (raw, lifecycle) => {
          const [claim] = await queue.listClaims();
          delivered.push({
            laneKey: claim?.laneKey,
            receivedAt: resolveTelegramUpdateReceivedAtSeconds(raw),
          });
          await lifecycle.onAdopted();
          return { kind: "completed" };
        },
      });
      monitor.start();
      await monitor.waitForIdle();
      const admission = monitor.admit(update, { receivedAt });
      try {
        await ackEntered.promise;
        expect(await queue.listClaims()).toEqual([
          expect.objectContaining({ laneKey: "telegram:-9017", attempts: 0 }),
        ]);
        expect(delivered).toEqual([]);
        await resolveTelegramForumFlag({
          chatId: -9017,
          chatType: "supergroup",
          isGroup: true,
          isForum: true,
        });
        ackRelease.resolve();
        await admission;
        await monitor.waitForIdle();
        expect(delivered).toEqual([{ laneKey: "telegram:-9017", receivedAt: 1_700_000_000 }]);
        expect(await monitor.admit(update)).toMatchObject({
          kind: "durable",
          queueResult: { kind: "completed" },
        });
        expect(delivered).toHaveLength(1);
      } finally {
        ackRelease.resolve();
        await admission;
        await monitor.stop();
      }
    });
  });

  it("reconciles a cached General topic when private bot topics are disabled", async () => {
    await withTempState(async ({ queue, monitor: makeMonitor }) => {
      const eventId = "9".padStart(16, "0");
      const payload = updatePayload(9);
      payload.update.message.chat = { id: -9003, type: "supergroup" };
      await resolveTelegramForumFlag({
        chatId: -9003,
        chatType: "supergroup",
        isGroup: true,
        isForum: true,
      });
      await queue.enqueue(eventId, payload, { laneKey: "telegram:-9003" });

      const dispatch = vi.fn(async (_update, lifecycle) => {
        expect(await queue.listClaims()).toEqual([
          expect.objectContaining({ laneKey: "telegram:-9003:topic:1" }),
        ]);
        await lifecycle.onAdopted();
        return { kind: "completed" as const };
      });
      const monitor = makeMonitor({
        botInfo: { id: 999, has_topics_enabled: false } as never,
        dispatch,
      });

      monitor.start();
      await monitor.waitForIdle();

      expect(dispatch).toHaveBeenCalledOnce();
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
      await monitor.stop();
    });
  });

  it.each([
    {
      name: "private topic",
      updateKind: "edited_message",
      chat: { id: 1234, type: "private" },
      topic: { message_thread_id: 42 },
      laneKey: "telegram:1234:topic:42",
    },
    {
      name: "edited_channel_post",
      updateKind: "edited_channel_post",
      chat: { id: -1234, type: "channel" },
      topic: {},
      laneKey: "telegram:-1234",
    },
    {
      name: "mismatched Direct Messages lane telegram:-1234:approval",
      updateKind: "message",
      chat: { id: -1234, type: "supergroup", is_direct_messages: true },
      topic: { direct_messages_topic: { topic_id: 42 }, message_thread_id: 99 },
      laneKey: "telegram:-1234:approval",
      reject: true,
    },
  ])("replays promoted controls after restart: $name", async (testCase) => {
    const update = {
      update_id: 136,
      [testCase.updateKind]: {
        message_id: 1,
        date: 1_736_380_800,
        from: { id: 111, is_bot: false, first_name: "Ada" },
        chat: testCase.chat,
        ...testCase.topic,
        text: "/models@openclaw_bot",
      },
    };
    await checkStoredReplay(update, testCase.laneKey, {
      topicsEnabled: true,
      expectedLane: `telegram:${testCase.chat.id}:control`,
      receivedAt: 1_736_382_000_123,
      rejected: "reject" in testCase && testCase.reject,
    });
  });

  it.each([
    new Error("late provider blip"),
    new Error("Gateway requester authority changed"),
    Object.assign(new Error("workspace is not ready"), {
      name: "SessionWorkStartError",
      reason: "workspace_pending",
      retryable: true,
    }),
    new Error("Session is archived"),
  ])("preserves retry for a late deferred failure: %s", async (error) => {
    await withTempState(async ({ queue, monitor: makeMonitor, enqueue }) => {
      const { eventId } = await enqueue(4);
      const { monitor, participant } = await startDeferred(makeMonitor, "test:late-retry");
      expect(await queue.listClaims()).toHaveLength(1);
      participant.current?.settle({ kind: "failed-retryable", error });

      await waitPending(queue, [{ id: eventId, attempts: 1, lastError: error.message }]);
      await monitor.stop();
    });
  });

  it("dead-letters a late deferred dispatch dedupe rollback failure", async () => {
    await withTempState(async ({ queue, monitor: makeMonitor, enqueue }) => {
      const { eventId } = await enqueue(5);
      const { monitor, participant, dispatch } = await startDeferred(
        makeMonitor,
        "test:late-fatal",
      );
      participant.current?.settle({
        kind: "failed-retryable",
        error: await createTelegramMessageDispatchReplayForgetError(),
      });

      await vi.waitFor(async () =>
        expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
          { id: eventId, reason: "dispatch-dedupe-rollback-failed" },
        ]),
      );
      await monitor.waitForIdle();
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
      expect(await queue.listClaims()).toEqual([]);
      expect(dispatch).toHaveBeenCalledOnce();
      await monitor.stop();
    });
  });

  it("uses participant settlement to own the row despite frame completion after abort", async () => {
    await withTempState(async ({ queue, monitor: makeMonitor, enqueue }) => {
      const { eventId, payload, laneKey } = await enqueue(8);
      const started = deferred();
      const monitor = makeMonitor({
        dispatch: async (_update, lifecycle) => {
          const { result } = await runWithTelegramUpdateProcessingFrame(async () => {
            const participant = createTelegramSpooledReplayDeferredParticipant("test:inline-abort");
            expect(participant).not.toBeNull();
            const aborted = new Promise<void>((resolve) => {
              lifecycle.abortSignal.addEventListener("abort", () => resolve(), { once: true });
            });
            started.resolve();
            await aborted;
            recordTelegramMessageProcessingResult({ kind: "completed" });
            participant?.settle({ kind: "skipped" });
            await participant?.task;
          });
          return result;
        },
      });

      monitor.start();
      await started.promise;
      await monitor.stop();

      await expectPending(queue, [{ id: eventId, attempts: 0 }]);
      expect((await queue.listPending({ limit: "all" }))[0]?.lastError).toBeUndefined();
      expect((await queue.enqueue(eventId, payload, { laneKey })).kind).not.toBe("completed");
    });
  });

  it("uses participant adoption to own the row despite a failed frame outcome", async () => {
    await withTempState(async ({ queue, monitor: makeMonitor, enqueue }) => {
      const { eventId, payload, laneKey } = await enqueue(8);
      const release = vi.spyOn(queue, "release");
      const monitor = makeMonitor({
        dispatch: async () => {
          const { result } = await runWithTelegramUpdateProcessingFrame(async () => {
            const participant = createTelegramSpooledReplayDeferredParticipant("test:adopted");
            expect(participant).not.toBeNull();
            recordTelegramMessageProcessingResult({
              kind: "failed-retryable",
              error: new Error("late frame failure"),
            });
            participant?.settle({ kind: "completed" });
            await participant?.task;
          });
          return result;
        },
      });

      monitor.start();
      await monitor.waitForIdle();
      await monitor.stop();

      expect((await queue.enqueue(eventId, payload, { laneKey })).kind).toBe("completed");
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
      expect(release).not.toHaveBeenCalled();
    });
  });

  it("preserves an adopted tombstone when inline completion returns after shutdown", async () => {
    await withTempState(async ({ queue, monitor: makeMonitor, enqueue }) => {
      const { eventId, payload, laneKey } = await enqueue(8);
      const adopted = deferred();
      const finishDispatch = deferred();
      const monitor = makeMonitor({
        dispatch: async (_update, lifecycle) => {
          await lifecycle.onAdopted();
          adopted.resolve();
          await finishDispatch.promise;
          return { kind: "completed" };
        },
      });

      monitor.start();
      await adopted.promise;
      const stopped = monitor.stop();
      finishDispatch.resolve();
      await stopped;

      expect(await queue.listPending({ limit: "all" })).toEqual([]);
      expect((await queue.enqueue(eventId, payload, { laneKey })).kind).toBe("completed");
    });
  });

  it("releases when dispatch settles only after its owner was aborted", async () => {
    await withTempState(async ({ queue, monitor: makeMonitor, enqueue }) => {
      const { eventId, payload, laneKey } = await enqueue(8);
      const priorClaim = await queue.claim(eventId, { ownerId: "prior-owner" });
      if (!priorClaim) {
        throw new Error("Expected the prior Telegram ingress claim.");
      }
      const priorAttemptAt = Date.now() - 10_000;
      await queue.release(priorClaim, {
        releasedAt: priorAttemptAt,
        lastError: "previous delivery failed",
      });
      const dispatchGate = deferred();
      let ownerSignal: AbortSignal | undefined;
      const monitor = makeMonitor({
        dispatch: async (_update, lifecycle) => {
          ownerSignal = lifecycle.abortSignal;
          const participant = createTelegramSpooledReplayDeferredParticipant(
            "test:abort-before-settlement",
          );
          await dispatchGate.promise;
          participant?.settle({ kind: "completed" });
        },
      });

      monitor.start();
      await vi.waitFor(() => expect(ownerSignal).toBeDefined());
      const stopped = monitor.stop();
      await vi.waitFor(() => expect(ownerSignal?.aborted).toBe(true));
      dispatchGate.resolve();
      await stopped;

      expect(await queue.listClaims()).toEqual([]);
      expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
      await waitPending(queue, [
        {
          id: eventId,
          attempts: 1,
          lastAttemptAt: priorAttemptAt,
          lastError: "previous delivery failed",
        },
      ]);
      expect((await queue.enqueue(eventId, payload, { laneKey })).kind).not.toBe("completed");
    });
  });
  it.each([false, true])(
    "replays legacy DM lanes in order with topics enabled=%s",
    async (topicsEnabled) => {
      const base = "telegram:1234",
        topic = `${base}:topic:42`;
      const first = replayMessage(130, 42),
        second = replayMessage(131, topicsEnabled ? 42 : undefined);
      await withStoredReplay(
        [
          { update: first, laneKey: topicsEnabled ? base : topic },
          { update: second, laneKey: topicsEnabled ? topic : base },
        ],
        async ({ queue, monitor: makeMonitor }) => {
          const started = deferred(),
            release = deferred();
          const seen: number[] = [];
          const dispatch = vi.fn(async (update: unknown) => {
            const { update_id } = update as { update_id: number };
            seen.push(update_id);
            if (update_id === 130) {
              started.resolve();
              await release.promise;
            }
            return { kind: "completed" as const };
          });
          const monitor = makeMonitor({
            botInfo: { ...telegramBotInfoForTest, has_topics_enabled: topicsEnabled },
            dispatch,
          });
          try {
            monitor.start();
            await started.promise;
            await monitor.waitForPumpIdle();
            expect(seen).toEqual([130]);
            release.resolve();
            await monitor.waitForIdle();
            expect(seen).toEqual([130, 131]);
            expect(dispatch).toHaveBeenCalledTimes(2);
            expect(await queue.listPending()).toEqual([]);
            expect(await queue.listFailed?.()).toEqual([]);
          } finally {
            release.resolve();
            await monitor.stop();
          }
        },
      );
    },
  );

  it.each([
    ["exec", "telegram:1234:topic:42", 1234, "private", true, false],
    ["plugin", "telegram:1234:topic:42", 1234, "private", true, false],
    ["exec", "telegram:1234", 1234, "private", false, false],
    ["exec", "telegram:-1234", -1234, "group", false, false],
    ["exec", "telegram:-1001234", -1001234, "supergroup", false, false],
    ["exec", "telegram:-1001234:topic:42", -1001234, "supergroup", true, true],
    ["exec", "telegram:-1001234:topic:1", -1001234, "supergroup", false, true],
  ] as const)(
    "replays typed %s approvals from %s in their privileged lane",
    async (kind, laneKey, id, type, hasThread, isForum) => {
      const callback = createTelegramPrivateTopicCallback(142, replayBotId);
      const update = {
        update_id: 142,
        callback_query: {
          ...callback,
          data: replayApproval(kind, "allow-once"),
          message: {
            ...callback.message,
            chat: { id, type, ...(isForum ? { is_forum: true } : {}) },
            ...(hasThread ? {} : { message_thread_id: undefined }),
          },
        },
      };
      await checkStoredReplay(update, laneKey, { expectedLane: `telegram:${id}:approval` });
    },
  );

  it.each([
    [false, "telegram:1234:topic:42"],
    [true, "telegram:1234"],
  ] as const)(
    "replays legitimate private callbacks after capability transition (%s)",
    async (topicsEnabled, laneKey) => {
      await checkStoredReplay(
        { update_id: 140, callback_query: createTelegramPrivateTopicCallback(140, replayBotId) },
        laneKey,
        { topicsEnabled },
      );
    },
  );

  const allowExec = replayApproval("exec", "allow-once"),
    denyPlugin = replayApproval("plugin", "deny");
  it.each([
    ["a bot callback sender", { from: { is_bot: true } }],
    ["an invalid callback sender", { from: { id: 0 } }],
    ["a foreign bot-authored message", { message: { from: { id: 999 } } }],
    ["an inaccessible callback message", { message: { date: 0 } }],
    ["an independent business chat", { message: { business_connection_id: "business-1234" } }],
    ["an independent guest chat", { message: { guest_query_id: "guest-1234" } }],
    [
      "a message sent by another chat",
      { message: { sender_chat: { id: -1234, type: "channel" } } },
    ],
    [
      "a direct-messages topic from another surface",
      { message: { direct_messages_topic: { topic_id: 42 } } },
    ],
    ["an inline callback message", { inline_message_id: "inline-message-141" }],
    ["an oversized callback payload", { data: "x".repeat(65) }],
    ["a missing chat instance", { chat_instance: "" }],
    ["a reserved question callback", { data: "tgq1:ask_0123456789abcdef0123456789abcdef:1" }],
    ["a reserved approval callback", { data: "/approve exec:def456 deny" }],
    ["a malformed signed approval decision", { data: allowExec?.replace(":o:", ":z:") }],
    ["a malformed signed approval kind", { data: allowExec?.replace(":e:", ":x:") }],
    [
      "a signed approval missing its canonical identifier",
      { data: denyPlugin?.replace(/signed-approval$/, "") },
    ],
    [
      "an inline signed approval",
      { data: allowExec, inline_message_id: "inline-message-141", inlineOnly: true },
    ],
    ["a signed approval for another chat", { data: allowExec, message: { chat: { id: 9999 } } }],
    ["an ordinary callback without a topic", { message: { message_thread_id: undefined } }],
  ] as const)("does not authorize durable-lane reconciliation for %s", async (_name, patch) => {
    await checkStoredReplay(
      { update_id: 141, callback_query: patchedCallback(patch) },
      "telegram:1234:topic:42",
      { rejected: true },
    );
  });

  it.each(["telegram:9999:topic:42", "telegram:1234:topic:99", "telegram:1234:control"])(
    "rejects persisted DM lanes outside upgrade contract (%s)",
    async (laneKey) => {
      await checkStoredReplay(replayMessage(132, 42), laneKey, { rejected: true });
    },
  );
  const legacyTopicMessage = {
    chat: { id: 1234, type: "private" },
    message_id: 1,
    message_thread_id: 42,
  };
  it.each([
    {
      name: "a malformed callback query",
      update: {
        update_id: 134,
        callback_query: { data: "unrecognized-callback", message: legacyTopicMessage },
      },
    },
    {
      name: "a group message",
      update: {
        update_id: 135,
        message: {
          ...legacyTopicMessage,
          chat: { id: 1234, type: "group" },
          text: "wrong chat kind",
        },
      },
    },
  ])("rejects legacy lane reconciliation for $name", async ({ update }) => {
    await checkStoredReplay(update, "telegram:1234:topic:42", { rejected: true });
  });
});
