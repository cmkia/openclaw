import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNoisyPngBuffer,
  createSolidPngBuffer,
} from "../../../test/helpers/image-fixtures.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  rotateAgentRunRegistryLifecycleGeneration,
} from "../../infra/agent-run-registry.js";
import * as rootLogger from "../../logger.js";
import * as localMediaAccess from "../../media/local-media-access.js";
import { readPersistedMediaFacts, type MediaFact } from "../../media/media-facts.js";
import * as mediaReferences from "../../media/media-reference.js";
import { cleanOldMedia, saveMediaBuffer } from "../../media/store.js";
import { waitForSessionRunEnd } from "../../sessions/session-controller.native-runtime.js";
import {
  buildPersistedUserTurnMessage,
  createUserTurnTranscriptRecorder,
  type UserTurnInput,
} from "../../sessions/user-turn-transcript.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import type { WorkerLaunchPlan } from "../../worker/launch-descriptor.js";
import { NODE_WORKER_WORKSPACE_STDOUT_MAX_BYTES } from "../../worker/node-workspace-protocol.js";
import { parseMessageWithAttachments } from "../chat-attachments.js";
import { result as processResult } from "./bootstrap.test-support.js";
import { projectWorkerSessionTurnClaim } from "./placement-record.js";
import type { WorkerSessionWorkspace } from "./session-workspace.js";
import type { WorkerTunnelHandle, WorkerTurnTunnelHandle } from "./tunnel-contract.js";
import {
  completeTurn,
  environmentForTunnel,
  expectUncalled,
  runIdentity,
} from "./worker-turn-launcher-flow.test-support.js";
import {
  createWorkerTurnTunnel,
  reconcileUnchangedLocalWorkspace,
  SESSION_ID,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  openSessionManager,
  placements,
  root,
  seedActivePlacement,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
} from "./worker-turn-launcher.test-support.js";
import { prepareWorkerTurnMedia } from "./worker-turn-media.js";

afterAll(closeStateDatabaseForTest);

function recordInput(input: Parameters<typeof createUserTurnTranscriptRecorder>[0]["input"]) {
  return createUserTurnTranscriptRecorder({
    target: { ...sessionTarget, sessionEntry: undefined },
    input,
  });
}

type Input = UserTurnInput;
type Prompt = WorkerLaunchPlan["assignment"]["prompt"];
function parts(prompt: Prompt) {
  if (!Array.isArray(prompt)) {
    throw new Error("missing multimodal prompt");
  }
  return prompt;
}
const imageData = (prompt: Prompt) =>
  parts(prompt)
    .filter((part) => part.type === "image")
    .map((part) => part.data);
const urls = (message: Parameters<typeof readPersistedMediaFacts>[0]) =>
  readPersistedMediaFacts(message)?.map((fact) => fact.url);
const save = (bytes: Buffer, type = "image/png") => saveMediaBuffer(bytes, type, "inbound");
const ref = ({ id }: { id: string }, contentType = "image/png", hydrationSuppressed = false) => ({
  url: `media://inbound/${id}`,
  contentType,
  ...(hydrationSuppressed ? { hydrationSuppressed } : {}),
});
const workerPath = (file: string) =>
  path.posix.join("/worker/workspace", file.split(path.sep).join("/"));
const inlineImage = () => ({
  type: "image" as const,
  data: createSolidPngBuffer(2, 2, { r: 255, g: 0, b: 0 }).toString("base64"),
  mimeType: "image/png",
});
const messages = async () => (await openSessionManager()).buildSessionContext().messages;
const users = async () =>
  (await openSessionManager())
    .getBranch()
    .flatMap((entry) =>
      entry.type === "message" && entry.message.role === "user" ? [entry.message] : [],
    );
const appendInput = async (input: Input) =>
  (await openSessionManager()).appendMessageAsync(buildPersistedUserTurnMessage(input));
const silentWarning = () => vi.spyOn(rootLogger, "logWarn").mockImplementation(() => {});

async function readStagedFiles(localPath: string, include: (name: string) => boolean) {
  const files = new Map<string, Buffer>();
  for (const file of await fs.readdir(localPath, { recursive: true })) {
    const source = path.join(localPath, file);
    if (include(file) && (await fs.stat(source)).isFile()) {
      files.set(file, await fs.readFile(source));
    }
  }
  return files;
}

async function imagePair(png: Buffer) {
  const image = await save(png);
  const described = await save(png);
  const media = [ref(image), ref(described, "image/png", true)];
  return { image, described, media };
}

async function harness(assistantText = "image received", workspace?: string) {
  await seedActivePlacement("worker-turn", workspace);
  const launches: WorkerLaunchPlan[] = [];
  const remoteFiles = new Map<string, Buffer>();
  const environment = attachedEnvironment();
  const tunnel: WorkerTurnTunnelHandle = createWorkerTurnTunnel({
    syncWorkspace: vi.fn(async () => {
      throw new Error("must not resync active workspace");
    }),
    stageAttachments: vi.fn(async (request) => {
      expect(request.isAuthorized()).toBe(true);
      for (const [file, bytes] of await readStagedFiles(
        request.localPath,
        (name) => !remoteFiles.has(name),
      )) {
        remoteFiles.set(file, bytes);
      }
    }),
    quiesceWorkspace: vi.fn(async () => ({ assertActive: async () => {}, resume: async () => {} })),
    reconcileWorkspace: vi.fn(reconcileUnchangedLocalWorkspace),
    launchTurn: vi.fn<WorkerTurnTunnelHandle["launchTurn"]>(async (request) => {
      launches.push(structuredClone(request.plan));
      request.onDispatchReady?.();
      return completeTurn(request, assistantText, Date.now(), {
        transcriptSeq: request.plan.assignment.transcript.nextSeq,
        liveSeq: request.plan.assignment.liveEvents.nextSeq,
      });
    }),
  });
  const provider = createWorkerSessionTurnPlacementProvider({
    placements,
    environments: environmentForTunnel({
      get: () => environment,
      startTunnel: async () => tunnel,
      destroy: async () => environment,
    }),
  });
  const runLocal = vi.fn(async () => ({ meta: { durationMs: 0 } }));
  const execute = async (input: Parameters<typeof provider.executeTurn>[1]) =>
    await provider.executeTurn(runIdentity(input.runId), input, runLocal);
  const inputFiles = () =>
    new Map([...remoteFiles].filter(([file]) => path.basename(file) !== ".gitignore"));
  const record = (
    runId: string,
    input: Input,
    overrides: Partial<Parameters<typeof execute>[0]> = {},
  ) => execute({ ...turn(runId), userTurnTranscriptRecorder: recordInput(input), ...overrides });
  const assignment = (index = 0) => launches[index]!.assignment;
  return {
    launches,
    remoteFiles,
    inputFiles,
    tunnel,
    environment,
    execute,
    record,
    assignment,
    runLocal,
  };
}

describe("cloud turn media boundary", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true });
  });

  it("stages relative worker reply bytes before reconciliation without using the Gateway copy", async () => {
    const remoteRoot = path.join(root, "remote-output");
    const remotePath = path.join(remoteRoot, "reply.txt");
    const bytes = Buffer.from("worker-only output\n".repeat(5_000));
    await fs.mkdir(remoteRoot);
    await fs.writeFile(remotePath, bytes);
    await fs.writeFile(path.join(root, "reply.txt"), "stale Gateway copy");
    const text = "MEDIA:./reply.txt";
    const rig = await harness(text, remoteRoot);
    vi.mocked(rig.tunnel.runWorkspaceCommand).mockImplementation(async ({ argv }) => {
      let stdout = "";
      let stderr = "";
      const commandProcess = {
        argv: [process.execPath, path.resolve(remoteRoot, argv[4]!), ...argv.slice(5)],
        platform: process.platform,
        exitCode: 0,
        stdout: { write: (value: string) => (stdout += value) },
        stderr: { write: (value: string) => (stderr += value) },
      };
      runInNewContext(argv[2]!, {
        Buffer,
        process: commandProcess,
        require: createRequire(import.meta.url),
      });
      return processResult({
        stdout: stdout.slice(0, NODE_WORKER_WORKSPACE_STDOUT_MAX_BYTES),
        stderr,
        code: commandProcess.exitCode,
      });
    });
    vi.mocked(rig.tunnel.reconcileWorkspace).mockImplementationOnce(async (request) => {
      await fs.rm(remotePath);
      return await reconcileUnchangedLocalWorkspace(request);
    });

    const result = await rig.execute(turn("outbound-relative"));
    const mediaUrl = result.payloads?.[0]?.mediaUrl;
    expect(mediaUrl).toBeTypeOf("string");
    await expect(fs.readFile(mediaUrl!)).resolves.toEqual(bytes);
    expect((await openSessionManager()).getLeafEntry()).toMatchObject({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
  });

  it("preserves ordered managed image input, follow-up files, replay and canonical paths", async () => {
    const rig = await harness();
    const png = createNoisyPngBuffer(256, 256);
    expect(png.length).toBeGreaterThan(64 * 1024);
    const small = createSolidPngBuffer(2, 2, { r: 255, g: 0, b: 0 });
    const saved = await save(png);
    const media = [ref(saved), ref(await save(small))];
    const input = {
      text: "compare in order",
      media,
      mediaImageLayout: {
        slots: [
          { kind: "offloaded", factIndex: 0 },
          { kind: "inline", factIndex: 1 },
        ],
      },
    } satisfies Input;
    const {
      images: [inline],
    } = await parseMessageWithAttachments("compare in order", [
      { content: small.toString("base64"), mimeType: "image/png", fileName: "inline.png" },
    ]);
    expect(inline?.sourceIndex).toBe(0);
    if (!inline) {
      throw new Error("missing parsed inline image");
    }
    const wireInline = { type: "image" as const, data: inline.data, mimeType: inline.mimeType };
    await rig.record("images-first", input, {
      prompt: "compare in order",
      images: [inline],
      imageOrder: ["offloaded", "inline"],
    });
    const content = parts(rig.assignment().prompt);
    expect(imageData(content)).toEqual([png.toString("base64"), inline.data]);
    expect(rig.inputFiles().size).toBe(2);
    const promptText = content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    for (const file of rig.inputFiles().keys()) {
      expect(promptText).toContain(workerPath(file));
    }
    const preservedPath = [...rig.inputFiles().keys()][0]!;
    rig.remoteFiles.set(preservedPath, Buffer.from("worker edit"));

    const document = await save(Buffer.from("second turn document"), "text/plain");
    await rig.record(
      "images-followup",
      {
        text: "read the file",
        media: [ref(document, "text/plain")],
      },
      { prompt: "read the file" },
    );
    expect(rig.inputFiles().size).toBe(3);
    expect(rig.remoteFiles.get(preservedPath)?.toString()).toBe("worker edit");
    expect(
      [...rig.inputFiles().values()].some((data) => data.toString() === "second turn document"),
    ).toBe(true);
    const replay = rig.assignment(1).initialMessages.find((message) => message.role === "user");
    expect(replay?.content).toEqual(content);
    const userMessages = await users();
    expect(userMessages).toHaveLength(2);
    expect(readPersistedMediaFacts(userMessages[0]!)).toMatchObject(media);
    expect(JSON.stringify(userMessages)).not.toContain("/worker/workspace");
    await expect(fs.readFile(saved.path)).resolves.toEqual(png);
    await rig.execute({ ...turn("image-only"), prompt: "", images: [inline] });
    const imageOnly = rig.assignment(2).prompt;
    expect(imageOnly).toEqual(expect.arrayContaining([wireInline]));
    expect(rig.inputFiles().size).toBe(4);
    expect(await users()).toHaveLength(3);
    expectUncalled(rig.runLocal, rig.tunnel.syncWorkspace);
  });

  it("restores ordered mixed input without a recorder", async () => {
    const rig = await harness();
    const offloaded = createSolidPngBuffer(3, 3, { r: 0, g: 0, b: 255 });
    const inline = inlineImage();
    const saved = await save(offloaded);
    await rig.execute({
      ...turn("raw-mixed"),
      prompt: "compare",
      images: [inline],
      imageOrder: ["inline", "offloaded"],
      media: [ref(saved)],
    });
    const prompt = parts(rig.assignment().prompt);
    expect(imageData(prompt)).toEqual([inline.data, offloaded.toString("base64")]);
    await rig.execute(turn("raw-mixed-replay"));
    expect(
      rig.assignment(1).initialMessages.find((message) => message.role === "user")?.content,
    ).toEqual(prompt);
  });

  it("honors a text-only selected model for current and replay images while staging attachments", async () => {
    const rig = await harness();
    const rawImage = inlineImage();
    await rig.execute({ ...turn("raw-history"), prompt: "raw image", images: [rawImage] });
    const png = createSolidPngBuffer(2, 2, { r: 0, g: 255, b: 0 });
    const {
      image: historical,
      described: describedHistory,
      media: historyMedia,
    } = await imagePair(png);
    await rig.record("structured-history", { text: "structured images", media: historyMedia });
    const canonicalHistory = structuredClone(await messages());
    const rawHistory = canonicalHistory[0];
    if (rawHistory?.role !== "user") {
      throw new Error("missing raw user history");
    }
    expect(readPersistedMediaFacts(rawHistory) ?? []).toHaveLength(0);
    expect(rawHistory.content).toContainEqual(rawImage);
    expect(rig.inputFiles().size).toBe(3);

    const { image: current, described: describedCurrent, media } = await imagePair(png);
    vi.mocked(rig.tunnel.stageAttachments!).mockClear();
    await rig.record(
      "text-only",
      { text: "read attachment files", media },
      {
        modelHasVision: false,
        prompt: "read attachment files",
        images: [rawImage],
      },
    );

    const assignment = rig.assignment(2);
    expect(rig.tunnel.stageAttachments).toHaveBeenCalledTimes(1);
    expect(rig.inputFiles().size).toBe(5);
    for (const saved of [historical, describedHistory, current, describedCurrent]) {
      const file = [...rig.inputFiles().keys()].find((key) =>
        key.endsWith(`input-${path.basename(saved.path)}`),
      );
      expect(file).toBeDefined();
      expect(rig.inputFiles().get(file!)).toEqual(png);
      expect(JSON.stringify([assignment.prompt, assignment.initialMessages])).toContain(
        workerPath(file!),
      );
    }
    const currentParts = typeof assignment.prompt === "string" ? [] : assignment.prompt;
    expect.soft(currentParts.filter((part) => part.type === "image")).toEqual([]);
    const replayUsers = assignment.initialMessages.filter((message) => message.role === "user");
    expect(replayUsers).toHaveLength(2);
    expect
      .soft(replayUsers.flatMap((message) => message.content).some((part) => part.type === "image"))
      .toBe(false);
    expect(replayUsers[0]?.content).toEqual([
      { type: "text", text: expect.stringMatching(/^\[[^\]]+\] raw image$/u) },
    ]);
    const canonical = await messages();
    expect(canonical.slice(0, canonicalHistory.length)).toEqual(canonicalHistory);
    expect(urls(canonical.at(-2)!)).toEqual(media.map((fact) => fact.url));
    expect(JSON.stringify(canonical)).not.toContain("/worker/workspace");
    expect(rig.runLocal).not.toHaveBeenCalled();
  });

  it("continues plaintext replay after a recent canonical image expires while private input survives", async () => {
    const rig = await harness();
    const png = createSolidPngBuffer(2, 2, { r: 255, g: 0, b: 0 });
    const { image: expired, described, media } = await imagePair(png);
    await rig.record("before-expiry", { text: "inspect the image", media });
    const canonical = structuredClone((await messages())[0]);
    expect(urls(canonical!)).toEqual(media.map((fact) => fact.url));
    const privateInputs = rig.inputFiles();
    expect(privateInputs.size).toBe(2);
    await rig.execute(turn("plaintext-one"));
    await rig.execute(turn("plaintext-two"));
    expect(rig.launches).toHaveLength(3);

    // Age the original only: the configured sweep does not own the worker's private copy.
    await fs.utimes(expired.path, 0, 0);
    await cleanOldMedia(60 * 60_000, { recursive: true, pruneEmptyDirs: true });
    await expect(fs.stat(expired.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(described.path)).resolves.toEqual(png);
    expect(rig.inputFiles()).toEqual(privateInputs);
    vi.mocked(rig.tunnel.stageAttachments!).mockClear();
    const warning = silentWarning();

    await rig.execute({ ...turn("after-expiry"), prompt: "What is two plus two?" });

    expect(rig.launches).toHaveLength(4);
    expect(rig.assignment(3).prompt).toMatch(/^\[[^\]]+\] What is two plus two\?$/u);
    const firstUser = rig.assignment(3).initialMessages.find((message) => message.role === "user");
    expect(firstUser?.content).toEqual([
      { type: "text", text: expect.stringContaining("inspect the image") },
    ]);
    expect(firstUser?.content[0]).toMatchObject({
      text: expect.stringContaining("/worker/workspace/media/inbound/openclaw-staged-"),
    });
    expect(firstUser?.content[0]).toMatchObject({
      text: expect.stringContaining(`input-${path.basename(described.path)}`),
    });
    expect(rig.tunnel.stageAttachments).toHaveBeenCalledTimes(1);
    expect(rig.inputFiles()).toEqual(privateInputs);
    expect((await messages())[0]).toEqual(canonical);
    expect(warning.mock.calls).toEqual([
      ["worker-media: Omitted an unavailable historical attachment source"],
    ]);
    expect(rig.runLocal).not.toHaveBeenCalled();
  });

  it.each([
    ["image/png", false, /could not load 1 image/],
    ["text/plain", true, /media ID does not resolve/],
  ] as const)(
    "rejects unavailable current %s input (suppressed=%s)",
    async (contentType, hydrationSuppressed, error) => {
      const rig = await harness();
      await expect(
        rig.execute({
          ...turn("missing-current"),
          modelHasVision: true,
          media: [{ url: "media://inbound/missing", contentType, hydrationSuppressed }],
        }),
      ).rejects.toThrow(error);
      expect(rig.launches).toHaveLength(0);
      expectUncalled(rig.tunnel.stageAttachments, rig.runLocal);
    },
  );

  it.each(["cancellation", "admission", "placement"] as const)(
    "does not omit %s loss while loading a historical source",
    async (failure) => {
      const rig = await harness();
      const input = turn("expired-authority");
      const controller = new AbortController();
      await appendInput({
        text: "described image",
        media: [ref({ id: "missing" }, "image/png", true)],
      });
      const loseAuthority = async () => {
        if (failure === "cancellation") {
          controller.abort(new Error("cancelled during source loading"));
        } else if (failure === "admission") {
          input.preparedRunAdmission.close();
        } else {
          rig.environment.ownerEpoch++;
        }
        throw new Error("source unavailable");
      };
      if (failure === "placement") {
        vi.spyOn(mediaReferences, "resolveMediaReferenceLocalPath").mockImplementationOnce(
          loseAuthority,
        );
      } else {
        vi.spyOn(mediaReferences, "resolveMediaReferenceLocalPath").mockResolvedValueOnce(
          path.join(root, "source.png"),
        );
        vi.spyOn(localMediaAccess, "readLocalMediaFile").mockImplementationOnce(loseAuthority);
      }
      const warning = silentWarning();
      await expect(rig.execute({ ...input, abortSignal: controller.signal })).rejects.toThrow(
        failure === "cancellation"
          ? /cancelled during source loading/
          : /placement|claim|authority/,
      );
      expect(rig.launches).toHaveLength(0);
      expectUncalled(warning, rig.tunnel.stageAttachments);
    },
  );

  it.each([
    "caller",
    "admission",
    "replacement",
    "lifecycle",
    "claim",
    "dispatch",
    "unrelated",
  ] as const)(
    "cancels in-flight attachments on %s closure without launching an abandoned turn",
    async (closure) => {
      const rig = await harness();
      const input = turn("in-flight-media");
      let cancelledAtBoundary: boolean | undefined;
      let launchCancelled: boolean | undefined;
      let transferSignal: AbortSignal | undefined;
      const launchMock = vi.spyOn(rig.tunnel, "launchTurn");
      const launch = launchMock.getMockImplementation()!;
      launchMock.mockImplementation(async (request) => {
        launchCancelled = request.signal?.aborted;
        request.signal?.throwIfAborted();
        return await launch(request);
      });
      const controller = new AbortController();
      const saved = await save(Buffer.from("document"), "text/plain");
      vi.mocked(rig.tunnel.stageAttachments!).mockImplementationOnce(async (request) => {
        transferSignal = request.signal;
        expect(request.isAuthorized()).toBe(true);
        if (closure === "caller") {
          controller.abort(new Error("caller cancelled"));
        } else if (closure === "admission") {
          input.preparedRunAdmission.close();
        } else if (closure === "replacement" || closure === "unrelated") {
          const other = claimAgentRunDelegatedAuthority({
            instanceId: "another-instance",
            runId: closure === "replacement" ? input.runId : "unrelated-run",
          });
          releaseAgentRunDelegatedAuthority(other);
        } else if (closure === "lifecycle") {
          rotateAgentRunRegistryLifecycleGeneration();
        } else if (closure === "claim") {
          const placement = placements.get(SESSION_ID);
          const claim = placement && projectWorkerSessionTurnClaim(placement);
          if (!claim) {
            throw new Error("missing active claim");
          }
          await placements.releaseTurn(claim);
        }
        cancelledAtBoundary = request.signal?.aborted;
        request.signal?.throwIfAborted();
      });
      const operation = rig.execute({
        ...input,
        abortSignal: controller.signal,
        onExecutionPhase: ({ phase }) => {
          if (closure === "dispatch" && phase === "attempt_dispatch") {
            input.preparedRunAdmission.close();
          }
        },
        media: [ref(saved, "text/plain")],
      });
      if (closure === "unrelated") {
        await operation;
        expect(rig.launches).toHaveLength(1);
        await waitForSessionRunEnd(SESSION_ID, null);
        expect(transferSignal?.aborted).toBe(true);
        input.preparedRunAdmission.close();
      } else {
        await expect(operation).rejects.toThrow();
        expect(rig.launches).toHaveLength(0);
      }
      expect(cancelledAtBoundary).toBe(closure !== "unrelated" && closure !== "dispatch");
      if (closure === "dispatch") {
        expect(launchCancelled).toBe(true);
      }
      expect(rig.tunnel.stageAttachments).toHaveBeenCalledTimes(1);
      expect(rig.runLocal).not.toHaveBeenCalled();
    },
  );

  it.each(["staging write", "transfer"] as const)(
    "propagates historical attachment %s failures",
    async (failure) => {
      const rig = await harness();
      const saved = await save(Buffer.from("document"), "text/plain");
      await appendInput({ text: "read the document", media: [ref(saved, "text/plain")] });
      const error = new Error(`historical ${failure} failed`);
      if (failure === "transfer") {
        vi.mocked(rig.tunnel.stageAttachments!).mockRejectedValueOnce(error);
      } else {
        const writeFile = fs.writeFile;
        vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
          const destination = args[0];
          if (
            typeof destination === "string" &&
            destination.includes("worker-attachments-") &&
            path.basename(destination).startsWith("input-")
          ) {
            throw error;
          }
          return await writeFile(...args);
        });
      }
      const warning = silentWarning();
      await expect(rig.execute(turn("failed-staging"))).rejects.toBe(error);
      expect(rig.launches).toHaveLength(0);
      expectUncalled(warning, rig.runLocal);
    },
  );

  it("stages described image sources without reinjection or pruned history and rejects a retired turn before transfer", async () => {
    const rig = await harness();
    const unavailable = { path: path.join(root, "missing.png"), contentType: "image/png" };
    const manager = await openSessionManager();
    const append = (input: Input) =>
      manager.appendMessageAsync(buildPersistedUserTurnMessage(input));
    await append({ text: "old", media: [unavailable] });
    for (let index = 0; index < 4; index++) {
      await manager.appendMessageAsync(
        makeAgentAssistantMessage({ content: [{ type: "text", text: "processed" }] }),
      );
      await append({ text: "next" });
    }
    const png = createSolidPngBuffer(2, 2, { r: 0, g: 255, b: 0 });
    const saved = await save(png);
    const prompt = `described [media attached: ${saved.path}]`;
    await rig.record(
      "suppressed",
      {
        text: prompt,
        media: [{ path: saved.path, contentType: "image/png", hydrationSuppressed: true }],
        mediaImageLayout: {
          slots: [{ kind: "offloaded", factIndex: 0 }],
          suppressedFactIndexes: [0],
        },
      },
      { prompt },
    );
    expect(
      rig
        .assignment()
        .initialMessages.some(
          (message) =>
            typeof message.content !== "string" &&
            message.content.some((part) => part.type === "image"),
        ),
    ).toBe(false);
    expect(rig.tunnel.stageAttachments).toHaveBeenCalledTimes(1);
    expect([...rig.inputFiles().values()]).toEqual([png]);
    const remotePath = workerPath([...rig.inputFiles().keys()][0]!);
    expect(rig.assignment().prompt).toEqual(
      expect.stringContaining(`described [media attached: ${remotePath}]`),
    );

    const invalidRecorder = createUserTurnTranscriptRecorder({
      target: { ...sessionTarget, sessionEntry: undefined },
      resolveInput: async () => {
        rig.environment.ownerEpoch++;
        return { text: "stale", media: [unavailable] };
      },
    });
    await expect(
      rig.execute({ ...turn("stale"), userTurnTranscriptRecorder: invalidRecorder }),
    ).rejects.toThrow(/placement|claim|authority|environment/);
    expect(rig.launches).toHaveLength(1);
    expect(rig.tunnel.stageAttachments).toHaveBeenCalledTimes(1);
  });
});

describe("worker media policy", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(cleanupWorkerTurnLauncherTest);

  function mediaFixture(
    workspace: WorkerSessionWorkspace,
    remoteWorkspaceDir: string,
    config?: Parameters<typeof prepareWorkerTurnMedia>[0]["turn"]["config"],
  ) {
    const staged: Buffer[] = [];
    const stageAttachments = vi.fn<NonNullable<WorkerTunnelHandle["stageAttachments"]>>(
      async (request) => {
        expect(request.isAuthorized()).toBe(true);
        staged.push(
          ...(
            await readStagedFiles(request.localPath, (name) => path.basename(name) !== ".gitignore")
          ).values(),
        );
      },
    );
    const input = turn("media-policy");
    const prepare = (media: MediaFact[], history: AgentMessage[] = []) =>
      prepareWorkerTurnMedia({
        turn: {
          ...input,
          media,
          config: config ?? input.config,
        },
        workspace,
        remoteWorkspaceDir,
        history,
        tunnel: {
          environmentId: "media-policy-environment",
          ownerEpoch: 1,
          stageAttachments,
          syncWorkspace: vi.fn(),
          reconcileWorkspace: vi.fn(),
          quiesceWorkspace: vi.fn(),
          runWorkspaceCommand: vi.fn(),
          stop: vi.fn(),
        },
        signal: new AbortController().signal,
        isAuthorized: () => true,
      });
    return { stageAttachments, staged, prepare };
  }

  describe.each(["local", "repository"] as const)("%s workspace media policy", (kind) => {
    async function fixture(workspaceOnly: boolean) {
      const gatewayWorkspace = path.join(root, "gateway-agent-workspace");
      const localWorkspace = path.join(root, "session-workspace");
      await Promise.all([fs.mkdir(gatewayWorkspace), fs.mkdir(localWorkspace)]);
      const workspace: WorkerSessionWorkspace =
        kind === "local"
          ? { kind, path: localWorkspace }
          : {
              kind,
              repository: await getSessionRepositoryWorkspaceStore().create({
                agentId: sessionTarget.agentId,
                sessionKey: sessionTarget.sessionKey,
                url: "https://github.com/example/repository.git",
                assertCurrent: () => {},
              }),
            };
      // Matching remote cwd metadata must not grant access to the Gateway directory.
      return {
        gatewayWorkspace,
        localWorkspace,
        ...mediaFixture(workspace, gatewayWorkspace, {
          tools: { fs: { workspaceOnly } },
          agents: { defaults: { workspace: gatewayWorkspace } },
        }),
      };
    }

    it.each([
      { workspaceOnly: true, contentType: "image/png", name: "image.png" },
      { workspaceOnly: true, contentType: "text/plain", name: "document.txt" },
      { workspaceOnly: false, contentType: "image/png", name: "image.png" },
      { workspaceOnly: false, contentType: "text/plain", name: "document.txt" },
    ])(
      "applies workspaceOnly=$workspaceOnly to Gateway $contentType sources",
      async ({ workspaceOnly, contentType, name }) => {
        const f = await fixture(workspaceOnly);
        const data =
          contentType === "image/png"
            ? createSolidPngBuffer(2, 2, { r: 255, g: 0, b: 0 })
            : Buffer.from("Gateway agent file outside this session workspace");
        const source = path.join(f.gatewayWorkspace, name);
        await fs.writeFile(source, data);
        const preparation = f.prepare([{ path: source, contentType }]);
        if (workspaceOnly) {
          await expect(preparation).rejects.toThrow(
            contentType === "image/png"
              ? "could not load 1 image"
              : "not under an allowed directory",
          );
          expect(f.stageAttachments).not.toHaveBeenCalled();
        } else {
          await preparation;
          expect(f.staged).toEqual([data]);
        }
      },
    );

    it("keeps managed originals readable under workspace-only policy", async () => {
      const f = await fixture(true);
      const image = createSolidPngBuffer(2, 2, { r: 0, g: 255, b: 0 });
      const document = Buffer.from("Managed incoming document");
      const savedImage = await saveMediaBuffer(image, "image/png", "inbound");
      const savedDocument = await saveMediaBuffer(document, "text/plain", "inbound");
      const media: MediaFact[] = [
        { url: `media://inbound/${savedImage.id}`, contentType: "image/png" },
        { path: savedDocument.path, contentType: "text/plain" },
      ];
      const expected = [image, document];
      if (kind === "local") {
        const local = Buffer.from("Owned local session file");
        const source = path.join(f.localWorkspace, "owned.txt");
        await fs.writeFile(source, local);
        media.push({ path: source, contentType: "text/plain" });
        expected.push(local);
      }
      const prepared = await f.prepare(media);
      expect(prepared.images).toHaveLength(1);
      expect(f.stageAttachments).toHaveBeenCalledOnce();
      expect(f.staged).toHaveLength(expected.length);
      expect(f.staged).toEqual(expect.arrayContaining(expected));
    });
  });

  it("refuses device-folder attachments and does not restage a refused one from history", async () => {
    const saved = await saveMediaBuffer(Buffer.from("Refused note"), "text/plain", "inbound");
    const fact: MediaFact = { path: saved.path, contentType: "text/plain" };
    const { prepare, stageAttachments } = mediaFixture(
      { kind: "device-folder", deviceId: "device-1", path: "/srv/project" },
      "/srv/project",
    );
    await expect(prepare([fact])).rejects.toThrow("Attachments are not supported");
    const refused = {
      role: "user",
      content: [{ type: "text", text: "Read the note" }],
      timestamp: 1,
      __openclaw: { media: [fact] },
    } as AgentMessage;
    await expect(prepare([], [refused])).resolves.toBeDefined();
    expect(stageAttachments).not.toHaveBeenCalled();
  });
});
