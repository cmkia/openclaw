import { createRealtimeTranscriptionWebSocketSession } from "openclaw/plugin-sdk/realtime-transcription-session";
import {
  createStreamingPcmResampler,
  mulawToPcm,
} from "openclaw/plugin-sdk/realtime-voice-provider";
import { normalizeSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { resolveReadOnlyEnvSecretRef } from "openclaw/plugin-sdk/secret-ref-readonly";

// The Gateway retains a closing transcription relay for five seconds. Report a
// slow local final before that owner disappears, preserving earlier transcripts.
const FINALIZE_DEADLINE_MS = 4500;
const MAX_PENDING_ITEMS = 64;
const MAX_SETTLED_ITEMS = 4096;
const MAX_TRANSCRIPT_BYTES = 256 * 1024;
const PCM_SAMPLES_PER_MS = 24;
// Speaches rc.3 examines only the latest three seconds when detecting speech.
const VAD_WINDOW_MS = 3000;

function configuration(raw = {}, cfg) {
  // The plugin config is the sole endpoint/credential owner. The generic Talk
  // session contract may override only the requested transcription model.
  const value = cfg?.plugins?.entries?.["local-whisper"]?.config ?? {};
  const model = raw.model ?? value.model;
  const baseUrl = new URL(value.baseUrl);
  if (
    !["http:", "https:"].includes(baseUrl.protocol) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new Error(
      "Configure a private HTTP(S) Speaches baseUrl without embedded credentials or query parameters.",
    );
  }
  if (typeof model !== "string" || !model.trim()) {
    throw new Error("Configure the local Whisper model installed on the speech service.");
  }
  const credential = resolveReadOnlyEnvSecretRef({
    value: value.apiKey,
    path: "plugins.entries.local-whisper.config.apiKey",
    cfg,
    expectedEnvId: "LOCAL_WHISPER_API_KEY",
    normalizeValue: normalizeSecretInputString,
  });
  if (credential.status !== "available")
    throw new Error(
      "The private speech service credential is unavailable. Check its LOCAL_WHISPER_API_KEY env SecretRef, selected provider, and allowlist.",
    );
  return {
    baseUrl: baseUrl.toString(),
    model: model.trim(),
    language: value.language,
    apiKey: credential.value,
  };
}

function createSession(request) {
  const config = configuration(request.providerConfig, request.cfg);
  const url = new URL(config.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = url.pathname.replace(/\/$/, "").replace(/\/v1$/, "") + "/v1/realtime";
  url.searchParams.set("intent", "transcription");
  url.searchParams.set("model", config.model);
  url.searchParams.set("transcription_model", config.model);
  if (config.language) url.searchParams.set("language", config.language);
  const resampler = createStreamingPcmResampler(8000, 24000);
  const pending = new Map();
  const settled = new Set();
  const transcript = [];
  let transcriptBytes = 0;
  let transcriptDelivered = false;
  let hasAudio = false;
  let closing = false;
  let awaitingBarrier = false;
  let failed = false;
  let finalizeTimer;

  const deliverTranscript = () => {
    if (transcriptDelivered) return;
    transcriptDelivered = true;
    if (transcript.length) request.onTranscript?.(transcript.join(" "));
  };
  const finish = (transport) => {
    clearTimeout(finalizeTimer);
    transport.closeNow();
    deliverTranscript();
  };
  const fail = (message, transport) => {
    if (failed) return;
    failed = true;
    finish(transport);
    request.onError?.(new Error(message));
  };
  const maybeFinish = (transport) => {
    if (closing && !awaitingBarrier && pending.size === 0) finish(transport);
  };
  const track = (id, transport) => {
    if (typeof id !== "string" || !id || id.length > 1024) {
      fail(
        "Local transcription returned an invalid utterance identity. Restart dictation.",
        transport,
      );
      return false;
    }
    if (settled.has(id)) return false;
    if (!pending.has(id)) {
      if (pending.size >= MAX_PENDING_ITEMS) {
        fail(
          "Local transcription is falling behind. Stop dictation and check the speech service load.",
          transport,
        );
        return false;
      }
      pending.set(id, { done: false, text: "" });
    }
    return true;
  };
  const flush = (transport) => {
    for (const [id, item] of pending) {
      if (!item.done) break;
      if (settled.size >= MAX_SETTLED_ITEMS) {
        fail(
          "Local dictation reached its utterance limit. Start a new dictation session.",
          transport,
        );
        return;
      }
      pending.delete(id);
      settled.add(id);
      if (item.text) {
        const nextBytes =
          transcriptBytes + Buffer.byteLength(item.text) + (transcript.length ? 1 : 0);
        if (nextBytes > MAX_TRANSCRIPT_BYTES) {
          fail(
            "Local dictation reached its text limit. Earlier text was kept; start a new dictation session.",
            transport,
          );
          return;
        }
        transcript.push(item.text);
        transcriptBytes = nextBytes;
      }
    }
    maybeFinish(transport);
  };
  const append = (pcm, transport) => {
    if (!pcm.length) return;
    if (!transport.sendJson({ type: "input_audio_buffer.append", audio: pcm.toString("base64") })) {
      fail(
        "Local transcription could not accept captured audio. Check the speech service and retry.",
        transport,
      );
      return;
    }
    hasAudio = true;
  };

  return createRealtimeTranscriptionWebSocketSession({
    providerId: "local-whisper",
    callbacks: {
      onError() {
        if (failed) return;
        failed = true;
        clearTimeout(finalizeTimer);
        deliverTranscript();
        request.onError?.(
          new Error(
            "The local speech connection failed. Earlier text was kept; check the speech service and retry.",
          ),
        );
      },
    },
    url: url.toString(),
    headers: { Authorization: `Bearer ${config.apiKey}` },
    // Reopening a local Whisper session would lose its VAD buffer and make
    // already accepted speech ambiguous. Let the user restart visibly instead.
    maxReconnectAttempts: 0,
    connectTimeoutMs: 15000,
    closeTimeoutMs: 5000,
    onMessage(event, transport) {
      if (failed) return;
      switch (event.type) {
        case "session.created":
        case "session.updated":
          // Speaches rc.3 configures transcription through the URL. Its update
          // schema requires prefix_padding_ms while the update handler rejects
          // that field. Admit native settings without changing configuration.
          if (
            event.session?.input_audio_format !== "pcm16" ||
            event.session?.input_audio_transcription?.model !== config.model ||
            (config.language &&
              event.session?.input_audio_transcription?.language !== config.language) ||
            event.session?.turn_detection?.type !== "server_vad" ||
            event.session?.turn_detection?.prefix_padding_ms !== 0 ||
            event.session?.turn_detection?.create_response !== false
          ) {
            fail(
              "The local speech service did not accept the requested transcription-only PCM/VAD configuration. Check its pinned version, model, and language.",
              transport,
            );
            return;
          }
          if (event.type === "session.created") transport.markReady();
          else if (closing && awaitingBarrier) {
            awaitingBarrier = false;
            maybeFinish(transport);
          }
          break;
        case "input_audio_buffer.speech_started":
          if (track(event.item_id, transport)) request.onSpeechStart?.();
          break;
        case "input_audio_buffer.speech_stopped":
        case "input_audio_buffer.committed":
          track(event.item_id, transport);
          break;
        case "conversation.item.input_audio_transcription.completed": {
          if (!track(event.item_id, transport)) return;
          if (
            typeof event.transcript !== "string" ||
            Buffer.byteLength(event.transcript) > MAX_TRANSCRIPT_BYTES
          ) {
            fail(
              "The local speech service returned an invalid transcript. Check its logs and restart dictation.",
              transport,
            );
            return;
          }
          pending.set(event.item_id, { done: true, text: event.transcript.trim() });
          flush(transport);
          break;
        }
        case "conversation.item.input_audio_transcription.failed":
          fail(
            "Local Whisper could not transcribe an utterance. Earlier text was kept; check the speech service and retry.",
            transport,
          );
          break;
        case "error":
          fail(
            "Local transcription failed. Check the private speech service configuration and retry.",
            transport,
          );
          break;
      }
    },
    sendAudio(audio, transport) {
      append(resampler.process(mulawToPcm(audio)), transport);
    },
    onClose(transport) {
      // Browser dictation accepts one result after Stop; once any result is
      // visible it may stop listening immediately. Keep VAD inference streaming,
      // but publish the bounded ordered text once after drain (or before error)
      // so a previously completed utterance cannot hide the last spoken tail.
      closing = true;
      append(resampler.flush(), transport);
      if (failed || !hasAudio) {
        finish(transport);
        return;
      }
      // A manual commit during active speech leaves audio_end_ms unset in
      // Speaches rc.3, causing its transcriber to assert. A complete silent
      // VAD window instead produces the native stop boundary and auto-commit.
      awaitingBarrier = true;
      append(Buffer.alloc(VAD_WINDOW_MS * PCM_SAMPLES_PER_MS * 2), transport);
      if (failed) return;
      // Native append/update handlers run synchronously in receive order. The
      // empty update preserves settings and its FIFO session.updated follows
      // every VAD boundary caused by the silence. Once acknowledged, pending
      // finals are the only work left, including when the tail was only quiet.
      if (!transport.sendJson({ type: "session.update", session: {} })) {
        fail(
          "Local transcription could not finish captured audio. Check the speech service and retry.",
          transport,
        );
        return;
      }
      finalizeTimer = setTimeout(
        () =>
          fail(
            "Local transcription took too long to finish. Earlier text was kept; retry a shorter utterance and check server load.",
            transport,
          ),
        FINALIZE_DEADLINE_MS,
      );
      finalizeTimer.unref?.();
      maybeFinish(transport);
    },
  });
}

export const localWhisperProvider = {
  id: "local-whisper",
  label: "Local Whisper",
  autoSelectOrder: 1000,
  resolveConfig: ({ cfg, rawConfig }) => configuration(rawConfig, cfg),
  isConfigured({ cfg, providerConfig }) {
    try {
      configuration(providerConfig, cfg);
      return true;
    } catch {
      return false;
    }
  },
  createSession,
};
