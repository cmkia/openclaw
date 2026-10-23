import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";
import plugin from "../index.mjs";

// The external plugin has no ws dependency. Its test server uses the same
// installed host transport dependency as the public SDK under test.
const { WebSocketServer } = createRequire(
  import.meta.resolve("openclaw/plugin-sdk/realtime-transcription-session"),
)("ws");

const KEY = "synthetic-local-speech-contract-credential";
const MODEL = "Systran/faster-whisper-tiny";
const NATIVE_SESSION = {
  input_audio_format: "pcm16",
  input_audio_transcription: { model: MODEL, language: "pt" },
  turn_detection: {
    type: "server_vad",
    prefix_padding_ms: 0,
    create_response: false,
  },
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t, handle) {
  const previousKey = process.env.LOCAL_WHISPER_API_KEY;
  process.env.LOCAL_WHISPER_API_KEY = KEY;
  t.after(() => {
    if (previousKey === undefined) delete process.env.LOCAL_WHISPER_API_KEY;
    else process.env.LOCAL_WHISPER_API_KEY = previousKey;
  });
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const closed = deferred();
  const pcm = [];
  server.on("connection", (socket, request) => {
    assert.equal(request.headers.authorization, `Bearer ${KEY}`);
    const url = new URL(request.url, "http://fixture.test");
    assert.equal(url.pathname, "/v1/realtime");
    assert.equal(url.searchParams.get("intent"), "transcription");
    assert.equal(url.searchParams.get("model"), MODEL);
    assert.equal(url.searchParams.get("transcription_model"), MODEL);
    assert.equal(url.searchParams.get("language"), "pt");
    const emit = (value) => socket.send(JSON.stringify(value));
    socket.on("close", () => closed.resolve());
    socket.on("message", (bytes) => {
      const event = JSON.parse(bytes.toString());
      if (event.type === "session.update") {
        // An empty native update is a processing acknowledgement, with no
        // unsupported format or turn-detection changes.
        assert.deepEqual(event.session, {});
        emit({ type: "session.updated", session: NATIVE_SESSION });
        return;
      }
      if (event.type === "input_audio_buffer.append") pcm.push(Buffer.from(event.audio, "base64"));
      handle(event, emit);
    });
    emit({
      type: "session.created",
      session: NATIVE_SESSION,
    });
  });
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  let provider;
  plugin.register({
    registerRealtimeTranscriptionProvider(value) {
      provider = value;
    },
  });
  assert.equal(provider.id, "local-whisper");
  const config = {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    model: MODEL,
    language: "pt",
    apiKey: { source: "env", provider: "default", id: "LOCAL_WHISPER_API_KEY" },
  };
  // The actual Talk catalog may pass a source config SecretRef rather than a
  // materialized string. Exercise that public contract through the same SDK.
  const cfg = { plugins: { entries: { "local-whisper": { enabled: true, config } } } };
  assert.equal(provider.isConfigured({ cfg, providerConfig: {} }), true);
  assert.equal(
    provider.isConfigured({ cfg: { plugins: { entries: {} } }, providerConfig: {} }),
    false,
  );
  return {
    provider,
    cfg,
    pcm,
    closed: closed.promise,
    async processed() {
      const socket = [...server.clients][0];
      const pong = once(socket, "pong");
      socket.ping();
      await pong;
    },
  };
}

test("configured credential ownership rejects blocked providers, allowlists, and unrelated environment values", async (t) => {
  const f = await fixture(t, () => {});
  const ref = { source: "env", provider: "default", id: "LOCAL_WHISPER_API_KEY" };
  const cases = [
    { apiKey: { ...ref, provider: "unconfigured" } },
    {
      apiKey: { ...ref, provider: "restricted" },
      secrets: { providers: { restricted: { source: "env", allowlist: ["OTHER_SPEECH_KEY"] } } },
    },
    {
      apiKey: { ...ref, provider: "restricted-file" },
      secrets: {
        providers: {
          "restricted-file": { source: "file", path: "/not-read-by-env-resolution", mode: "json" },
        },
      },
    },
    { apiKey: { ...ref, source: "store" } },
    { apiKey: { ...ref, id: "OTHER_SPEECH_KEY" } },
  ];
  const previousOther = process.env.OTHER_SPEECH_KEY;
  process.env.OTHER_SPEECH_KEY = "synthetic-unrelated-credential";
  t.after(() => {
    if (previousOther === undefined) delete process.env.OTHER_SPEECH_KEY;
    else process.env.OTHER_SPEECH_KEY = previousOther;
  });
  for (const entry of cases) {
    const cfg = structuredClone(f.cfg);
    cfg.plugins.entries["local-whisper"].config.apiKey = entry.apiKey;
    if (entry.secrets) cfg.secrets = entry.secrets;
    assert.equal(f.provider.isConfigured({ cfg, providerConfig: {} }), false);
    assert.throws(
      () => f.provider.createSession({ cfg, providerConfig: {} }),
      /credential is unavailable.*selected provider, and allowlist/,
    );
  }
  const allowed = structuredClone(f.cfg);
  allowed.plugins.entries["local-whisper"].config.apiKey.provider = "selected";
  allowed.secrets = { providers: { selected: { source: "env", allowlist: [ref.id] } } };
  assert.equal(f.provider.isConfigured({ cfg: allowed, providerConfig: {} }), true);
  delete process.env.LOCAL_WHISPER_API_KEY;
  assert.equal(f.provider.isConfigured({ cfg: f.cfg, providerConfig: {} }), false);
});

test("stopping during active speech completes native VAD before transcribing the captured tail", async (t) => {
  const transcripts = [],
    errors = [];
  let announced = false;
  const f = await fixture(t, (event, emit) => {
    if (event.type === "input_audio_buffer.commit") {
      // Native rc.3 cannot transcribe a manually committed active VAD buffer:
      // its audio_end_ms is unset. Surface failure rather than invent a final.
      emit({ type: "conversation.item.input_audio_transcription.failed", item_id: "tail" });
      return;
    }
    if (event.type !== "input_audio_buffer.append") return;
    if (!announced) {
      announced = true;
      emit({ type: "input_audio_buffer.speech_started", item_id: "tail" });
    }
    if (Buffer.from(event.audio, "base64").length >= 144000) {
      emit({ type: "input_audio_buffer.speech_stopped", item_id: "tail", audio_end_ms: 3100 });
      emit({ type: "input_audio_buffer.committed", item_id: "tail" });
      emit({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "tail",
        transcript: "Agende uma reunião amanhã.",
      });
      emit({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "tail",
        transcript: "Agende uma reunião amanhã.",
      });
    }
  });
  const session = f.provider.createSession({
    cfg: f.cfg,
    providerConfig: {},
    onTranscript: (text) => transcripts.push(text),
    onError: (error) => errors.push(error.message),
  });
  await session.connect();
  assert.equal(session.isConnected(), true);
  // The fixture controls VAD events independently of the synthetic G.711
  // silence. Its 100 ms of captured samples must survive the PCM conversion,
  // followed by a complete 3000 ms silent native VAD window.
  session.sendAudio(Buffer.alloc(400, 0xff));
  session.sendAudio(Buffer.alloc(400, 0xff));
  session.close();
  await f.closed;
  const pcm = Buffer.concat(f.pcm);
  assert.equal(pcm.length, 148800);
  assert.equal(
    pcm.every((byte) => byte === 0),
    true,
  );
  assert.deepEqual(transcripts, ["Agende uma reunião amanhã."]);
  assert.deepEqual(errors, []);
  assert.equal(session.isConnected(), false);
});

test("VAD finals retain capture order and closing after trailing silence succeeds", async (t) => {
  const transcripts = [],
    errors = [];
  const finished = deferred();
  let announced = false;
  let commits = 0;
  const f = await fixture(t, (event, emit) => {
    if (event.type === "input_audio_buffer.commit") commits += 1;
    if (event.type !== "input_audio_buffer.append" || announced) return;
    announced = true;
    for (const item_id of ["first", "second"]) {
      emit({ type: "input_audio_buffer.speech_started", item_id });
      emit({ type: "input_audio_buffer.speech_stopped", item_id, audio_end_ms: 500 });
      emit({ type: "input_audio_buffer.committed", item_id });
    }
    emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "second",
      transcript: "Segunda frase.",
    });
    emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "first",
      transcript: "Primeira frase.",
    });
    finished.resolve();
  });
  const session = f.provider.createSession({
    cfg: f.cfg,
    providerConfig: {},
    onTranscript: (text) => transcripts.push(text),
    onError: (error) => errors.push(error.message),
  });
  await session.connect();
  session.sendAudio(Buffer.alloc(8000, 0xff));
  await finished.promise;
  await f.processed();
  assert.deepEqual(
    transcripts,
    [],
    "Dictation must retain completed segments until Stop drains the final tail",
  );
  // Native VAD never starts another utterance for silence alone. Closing this
  // quiet tail must not wait for an impossible additional speech_stopped.
  session.sendAudio(Buffer.alloc(800, 0xff));
  session.close();
  await f.closed;
  assert.deepEqual(transcripts, ["Primeira frase. Segunda frase."]);
  assert.equal(Buffer.concat(f.pcm).length, 196800);
  assert.equal(commits, 0, "An already VAD-committed stream must not manufacture a duplicate tail");
  assert.deepEqual(errors, []);
});

test("an older VAD final arriving after close cannot discard the final captured tail", async (t) => {
  const transcripts = [],
    errors = [];
  const firstFinal = deferred();
  let emitTail;
  const f = await fixture(t, (event, emit) => {
    if (
      event.type !== "input_audio_buffer.commit" &&
      !(
        event.type === "input_audio_buffer.append" &&
        Buffer.from(event.audio, "base64").length >= 144000
      )
    )
      return;
    // Native FIFO permits an older VAD boundary/final to reach the client after
    // close appends silence. That boundary covers only the first 500 ms.
    emitTail = () => {
      emit({ type: "input_audio_buffer.committed", item_id: "tail" });
      emit({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "tail",
        transcript: "Final capturado.",
      });
    };
    emit({ type: "input_audio_buffer.speech_started", item_id: "vad" });
    emit({ type: "input_audio_buffer.speech_stopped", item_id: "vad", audio_end_ms: 500 });
    emit({ type: "input_audio_buffer.committed", item_id: "vad" });
    emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "vad",
      transcript: "Primeira frase.",
    });
    // Native stop events precede the processing barrier, but CPU inference and
    // its final may complete after both that barrier and the older final.
    emit({ type: "input_audio_buffer.speech_started", item_id: "tail" });
    emit({ type: "input_audio_buffer.speech_stopped", item_id: "tail", audio_end_ms: 3500 });
    firstFinal.resolve();
  });
  const session = f.provider.createSession({
    cfg: f.cfg,
    providerConfig: {},
    onTranscript: (text) => transcripts.push(text),
    onError: (error) => errors.push(error.message),
  });
  await session.connect();
  session.sendAudio(Buffer.alloc(8000, 0xff));
  session.close();
  await firstFinal.promise;
  await f.processed();
  assert.deepEqual(
    transcripts,
    [],
    "An earlier final must not make the browser stop awaiting the last tail",
  );
  emitTail();
  await f.closed;
  assert.deepEqual(transcripts, ["Primeira frase. Final capturado."]);
  assert.deepEqual(errors, []);
});

test("local inference failure delivers completed text before its error and never echoes upstream credentials", async (t) => {
  const transcripts = [],
    errors = [];
  let announced = false;
  const f = await fixture(t, (event, emit) => {
    if (event.type !== "input_audio_buffer.append" || announced) return;
    announced = true;
    emit({ type: "input_audio_buffer.committed", item_id: "kept" });
    emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "kept",
      transcript: "Texto preservado.",
    });
    emit({
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "failed",
      error: { message: `Synthetic private diagnostic: ${KEY}` },
    });
  });
  const session = f.provider.createSession({
    cfg: f.cfg,
    providerConfig: {},
    onTranscript: (text) => transcripts.push(text),
    onError(error) {
      assert.deepEqual(transcripts, ["Texto preservado."]);
      errors.push(error.message);
    },
  });
  await session.connect();
  session.sendAudio(Buffer.alloc(800, 0xff));
  await f.closed;
  assert.deepEqual(transcripts, ["Texto preservado."]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Earlier text was kept/);
  assert.equal(errors[0].includes(KEY), false);
});

test("the complete dictation result has a bounded byte size across utterances", async (t) => {
  const transcripts = [],
    errors = [];
  const first = "a".repeat(128 * 1024);
  let announced = false;
  const f = await fixture(t, (event, emit) => {
    if (event.type !== "input_audio_buffer.append" || announced) return;
    announced = true;
    for (const item_id of ["first", "second"]) {
      emit({ type: "input_audio_buffer.committed", item_id });
      emit({
        type: "conversation.item.input_audio_transcription.completed",
        item_id,
        transcript: first,
      });
    }
  });
  const session = f.provider.createSession({
    cfg: f.cfg,
    providerConfig: {},
    onTranscript: (text) => transcripts.push(text),
    onError: (error) => errors.push(error.message),
  });
  await session.connect();
  session.sendAudio(Buffer.alloc(800, 0xff));
  await f.closed;
  assert.deepEqual(
    transcripts,
    [first],
    "The completed prefix survives rejection of an oversized joined result",
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /text limit.*Earlier text was kept/);
});

test("a stalled final reports failure within the Gateway relay drain budget", async (t) => {
  const committed = deferred(),
    failed = deferred();
  const errors = [];
  const f = await fixture(t, (event, emit) => {
    if (
      event.type === "input_audio_buffer.append" &&
      Buffer.from(event.audio, "base64").length >= 144000
    ) {
      emit({ type: "input_audio_buffer.speech_started", item_id: "stalled" });
      emit({ type: "input_audio_buffer.speech_stopped", item_id: "stalled", audio_end_ms: 3100 });
      emit({ type: "input_audio_buffer.committed", item_id: "stalled" });
      committed.resolve();
    }
  });
  const session = f.provider.createSession({
    cfg: f.cfg,
    providerConfig: {},
    onError(error) {
      errors.push(error.message);
      failed.resolve();
    },
  });
  await session.connect();
  session.sendAudio(Buffer.alloc(800, 0xff));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    session.close();
    await committed.promise;
    t.mock.timers.tick(4500);
    await failed.promise;
    assert.equal(errors.length, 1);
    assert.match(errors[0], /took too long.*Earlier text was kept/);
  } finally {
    t.mock.timers.reset();
  }
  await f.closed;
});
