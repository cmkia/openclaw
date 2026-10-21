import { mkdir, realpath, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, onTestFinished, vi, beforeEach } from "vitest";
import { WorkerConnectRequestFrameSchema } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import {
  installSessionPlacementAdmissionProvider,
  withSessionPlacementTurnAdmission,
} from "../../agents/session-placement-admission.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "../../agents/test-helpers/agent-message-fixtures.js";
import {
  configureExecutionIdentityAdmissionSink,
  type ExecutionIdentityAdmissionWork,
} from "../../audit/execution-identity-admission.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  runWithoutOwnedSessionTranscriptWrites,
  withOwnedSessionTranscriptWrites,
} from "../../config/sessions/transcript-write-context.js";
import { setActiveNodeContexts } from "../../infra/active-node-context.js";
import { saveMediaBuffer } from "../../media/store.js";
import { runNodeWorkerWorkspaceTransfer } from "../../node-host/node-worker-transfer-client.js";
import { runCommandWithTimeout, type SpawnResult } from "../../process/exec.js";
import { waitForSessionRunEnd } from "../../sessions/session-controller.native-runtime.js";
import {
  createUserTurnTranscriptRecorder,
  buildPersistedUserTurnMessage,
} from "../../sessions/user-turn-transcript.js";
import {
  buildWorkerConnectParams,
  type WorkerLaunchDescriptor,
} from "../../worker/launch-descriptor.js";
import { parseNodeWorkerWorkspaceExecInput } from "../../worker/node-workspace-protocol.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import { verifyAgentRuntimeIdentityToken } from "../agent-runtime-identity-token.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { startNodeWorkspaceTransferTestServer } from "./node-workspace-transfer.test-support.js";
import { placementTurnOwner } from "./placement-record.js";
import type { WorkerTunnelHandle, WorkerTurnTunnelHandle } from "./tunnel-contract.js";
import {
  completeTurn,
  createLauncher,
  installLauncherTest,
  environmentForTunnel,
  launchDescriptor,
  localResult,
  runIdentity,
  remoteExecEnvironment,
  revocableTurn,
} from "./worker-turn-launcher-flow.test-support.js";
import * as fx from "./worker-turn-launcher.test-support.js";
import { captureWorkspaceManifest } from "./workspace-manifest-worker.js";
import { parseWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { WORKER_ATTACHMENT_DIRECTORY_PREFIX } from "./workspace-path-exclusions.js";
import { applyStagedWorkerWorkspace } from "./workspace-reconcile.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "./workspace-sync-scripts.js";

function wireUser(text: string, timestamp: number) {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function readCall(id: string, timestamp: number, stopReason: "stop" | "toolUse" = "stop") {
  return makeAgentAssistantMessage({
    content: [{ type: "toolCall", id, name: "read", arguments: {} }],
    timestamp,
    stopReason,
  });
}

async function verifyIdentity(assignment: WorkerLaunchDescriptor["assignment"]) {
  const identity = await verifyAgentRuntimeIdentityToken(assignment.agentRuntimeIdentityToken);
  expect(identity?.operationalRunInstance).toEqual(assignment.operationalRunInstance);
  return identity;
}

describe("worker turn launcher remote handoff", () => {
  installLauncherTest();
  afterEach(() => setActiveNodeContexts([]));

  it("settles a delegated worker reply and conflict without borrowing its parent transcript", async () => {
    setActiveNodeContexts([{ nodeId: "active-mac" }]);
    let admissionWork: ExecutionIdentityAdmissionWork | undefined;
    fx.setWorkerTurnAdmissionCleanup(
      configureExecutionIdentityAdmissionSink((work) => {
        admissionWork = work;
        return true;
      }),
    );
    fx.setWorkerTurnSessionTarget({
      ...fx.sessionTarget,
      agentId: "worker-agent",
      sessionKey: "agent:worker-agent:worker-turn",
    });
    await upsertSessionEntryCore(fx.sessionTarget, {
      sessionId: fx.SESSION_ID,
      updatedAt: Date.now(),
    });
    const initialized = await runCommandWithTimeout(["git", "-C", fx.root, "init", "--quiet"], {
      timeoutMs: 10_000,
    });
    expect(initialized.code).toBe(0);
    await fx.seedActivePlacement();
    const manager = await fx.openSessionManager();
    const earlierRequestId = await manager.appendMessageAsync(
      makeAgentUserMessage({ content: "Earlier request", timestamp: 10 }),
    );
    await manager.appendMessageAsync(readCall("call-1", 11));
    await manager.appendCustomMessageEntryAsync("context", "Custom durable context", true, {});
    await manager.appendCompactionAsync(
      "Compacted durable context",
      expectDefined(earlierRequestId, "persisted pre-compaction user entry"),
      100,
    );
    const toolResult = makeTextToolResult("call-1", "read", "result", false, 12);
    await manager.appendMessageAsync(toolResult);
    let descriptor: WorkerLaunchDescriptor | undefined;
    const environment = fx.browserEnvironment();
    environment.desktop!.apps![0]!.args = ["-File", "C:\\ProgramData\\OpenClaw\\browser.ps1"];
    const bootstrapReceipt = expectDefined(environment.bootstrapReceipt, "bootstrap receipt");
    const acknowledgeCredentialDelivery = vi.fn(async () => true);
    const reconcileWorkspace = vi.fn(
      async (request: Parameters<WorkerTunnelHandle["reconcileWorkspace"]>[0]) => {
        if (request.source.kind !== "local") {
          throw new Error("expected a local workspace source");
        }
        expect(request.source.stagedResult).toBeDefined();
        await request.source.stagedResult!.record(request.source.stagedResult!.ref);
        expect(await fx.placements.listPendingWorkspaceResultsAsync()).toMatchObject([
          { stagedResultRef: request.source.stagedResult!.ref, workspaceAcceptedAtMs: null },
        ]);
        await request.source.journal.commit(fx.MANIFEST_REF);
        return {
          manifestRef: fx.MANIFEST_REF,
          changed: false,
          verifyStable: async () => {},
          verifyLocalStable: async () => {},
          publishStagedResult: async () => {},
          discardPreparedStagedResult: async () => {},
          getAppliedWorkspaceResult: () => ({
            manifestRef: fx.MANIFEST_REF,
            manifest: { version: 1 as const, baseCommit: null, entries: [] },
            conflictPaths: ["src/local.ts"],
            verifyLocalStable: async () => {},
          }),
        };
      },
    );
    const tunnel: WorkerTunnelHandle = fx.createWorkerTurnTunnel({
      quiesceWorkspace: vi.fn(async () => ({
        assertActive: vi.fn(async () => {}),
        resume: vi.fn(async () => {
          expect(fx.placements.get(fx.SESSION_ID)?.turnClaim).toMatchObject({
            owner: "worker",
            runId: "run-worker-turn",
          });
          expect(await fx.placements.listPendingWorkspaceResultsAsync()).toHaveLength(1);
        }),
      })),
      launchTurn: vi.fn(async (request): Promise<SpawnResult> => {
        expect(fx.placements.get(fx.SESSION_ID)?.turnClaim).toMatchObject({
          owner: "worker",
          runId: "run-worker-turn",
          ownerEpoch: fx.OWNER_EPOCH,
        });
        descriptor = launchDescriptor(request.plan);
        const connectFrame = {
          type: "req" as const,
          id: "launch-validation",
          method: "connect" as const,
          params: buildWorkerConnectParams(descriptor),
        };
        expect(Value.Check(WorkerConnectRequestFrameSchema, connectFrame)).toBe(true);
        expect(descriptor.admission.handshake).toEqual({
          bundleHash: bootstrapReceipt.bundleHash,
          openclawVersion: bootstrapReceipt.openclawVersion,
          protocolFeatures: bootstrapReceipt.protocolFeatures,
        });
        expect(descriptor.admission.handshake).not.toHaveProperty("installKind");
        expect(request.timeoutMs).toBe(5_000);
        const activeRuntimeIdentity = await verifyAgentRuntimeIdentityToken(
          descriptor.assignment.agentRuntimeIdentityToken,
        );
        expect(activeRuntimeIdentity?.delegatedAuthority.kind).toBe("worker");
        expect(
          activeRuntimeIdentity &&
            createAgentRuntimeApprovalAuthorityValidator(fx.placements)(activeRuntimeIdentity),
        ).toBe(true);
        expect(descriptor.connectionEndpoint).toEqual({
          kind: "unix",
          socketPath: "/worker/gateway.sock",
        });
        expect(acknowledgeCredentialDelivery).not.toHaveBeenCalled();
        request.onDispatchReady?.();
        expect(acknowledgeCredentialDelivery).toHaveBeenCalledOnce();
        // Remote commits arrive on their own RPC context, outside the launching tool.
        return runWithoutOwnedSessionTranscriptWrites(async () => {
          return completeTurn(request, "Worker reply", 21);
        });
      }),
      reconcileWorkspace,
    });
    const environments = environmentForTunnel({
      get: vi.fn(() => environment),
      acknowledgeCredentialDelivery,
      startTunnel: vi.fn(async () => tunnel),
    });
    const preparingWorkspace = createDeferred();
    const resumePreparation = createDeferred();
    const resolveWorkspace = vi.fn(async () => {
      preparingWorkspace.resolve();
      await resumePreparation.promise;
      return { kind: "local" as const, path: fx.root };
    });
    const provider = createLauncher({
      environments,
      resolveWorkspace,
      reconcileActivePlacement: async () => {},
    });
    const runLocal = vi.fn(localResult);
    const onAgentEvent = vi.fn(() => {
      throw new Error("supplemental event failed");
    });

    onTestFinished(installSessionPlacementAdmissionProvider(provider));
    const input = fx.turn("run-worker-turn", true);
    onTestFinished(() => input.preparedRunAdmission.close());
    const recorder = createUserTurnTranscriptRecorder({
      target: { ...fx.sessionTarget, sessionEntry: undefined, config: input.config },
      input: { text: "Canonical transcript request" },
    });
    await recorder.persistApproved();
    const parentTarget = {
      ...fx.sessionTarget,
      sessionId: "parent-session",
      sessionKey: "agent:worker-agent:parent",
    };
    await upsertSessionEntryCore(parentTarget, {
      sessionId: parentTarget.sessionId,
      activeWriterRunId: "parent-run",
      updatedAt: 1,
    });
    const parent = await SessionManager.openAsync(parentTarget);
    await parent.appendMessageAsync(makeAgentUserMessage({ content: "Delegate this task" }));
    const parentEntries = parent.getPersistedEntries();
    const preparationStartedAtMs = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(preparationStartedAtMs);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const execution = withOwnedSessionTranscriptWrites(
      {
        sessionTarget: { ...parentTarget, expectedWriterRunId: "parent-run" },
        assertCommitAllowed: () => {},
        withTranscriptWrite: async (write) => await write(),
      },
      () =>
        withSessionPlacementTurnAdmission(
          runIdentity(input.runId),
          {
            ...input,
            userTurnTranscriptRecorder: recorder,
            gatewayUiCommandTarget: { connId: "requesting-ui", profileId: "requester" },
            toolsAllow: ["browser"],
            workspaceDir: path.join(fx.root, "stale-caller-workspace"),
            transcriptPrompt: "Canonical transcript request",
            extraSystemPrompt: "Keep the worker guidance.",
            onAgentEvent,
          },
          runLocal,
        ),
    );
    let result: Awaited<typeof execution>;
    try {
      await awaitGateBeforeSettlement(
        preparingWorkspace.promise,
        execution,
        "Worker settled before workspace preparation",
      );
      // Descriptor timeout belongs to worker execution, not host preparation.
      clock.mockReturnValue(preparationStartedAtMs + 6_000);
      await vi.advanceTimersByTimeAsync(1_000);
      resumePreparation.resolve();
      vi.useRealTimers();
      result = await execution;
    } finally {
      resumePreparation.resolve();
      vi.useRealTimers();
      await execution.catch(() => {});
      clock.mockRestore();
    }
    expect(result.payloads).toEqual([{ text: "Worker reply" }]);
    await waitForSessionRunEnd(fx.SESSION_ID, null);
    expect((await SessionManager.openAsync(parentTarget)).getPersistedEntries()).toEqual(
      parentEntries,
    );
    expect(runLocal).not.toHaveBeenCalled();
    expect(resolveWorkspace).toHaveBeenCalledWith({
      sessionId: fx.SESSION_ID,
      sessionKey: fx.sessionTarget.sessionKey,
      agentId: fx.sessionTarget.agentId,
    });
    expect(reconcileWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ kind: "local", path: fx.root }),
      }),
    );
    const conflictSummary =
      "Cloud result applied with 1 conflict(s); kept local versions: src/local.ts. Cloud versions staged at refs/openclaw/worker-results/";
    expect(fx.placements.get(fx.SESSION_ID)?.turnClaim).toBeNull();
    expect(fx.placements.get(fx.SESSION_ID)?.workspaceResultConflict).toMatchObject({
      paths: ["src/local.ts"],
      stagedResultRef: expect.stringMatching(/^refs\/openclaw\/worker-results\//u),
    });
    expect(onAgentEvent).not.toHaveBeenCalled();
    const entries = (await fx.openSessionManager()).getBranch();
    const conflictIndex = entries.findIndex(
      (entry) => entry.type === "custom_message" && entry.customType === "cloud-workspace-conflict",
    );
    expect(entries[conflictIndex]).toMatchObject({
      type: "custom_message",
      content: expect.stringContaining(conflictSummary),
      display: true,
    });
    expect(conflictIndex).toBeGreaterThan(
      entries.findLastIndex(
        (entry) => entry.type === "message" && entry.message.role === "assistant",
      ),
    );
    const assignment = expectDefined(descriptor, "worker launch descriptor").assignment;
    expect(descriptor).toMatchObject({
      version: 4,
      assignment: {
        prompt: expect.stringMatching(/^\[[^\]]+\] Inspect this workspace$/u),
        suppressPromptTranscript: true,
        agentId: fx.sessionTarget.agentId,
      },
    });
    const systemPrompt = assignment.systemPrompt;
    expect(systemPrompt).toContain("You are a personal assistant running inside OpenClaw.");
    expect(systemPrompt).toContain("Keep the worker guidance.");
    expect(systemPrompt).toContain("active_node=active-mac");
    expect(systemPrompt).toContain("active_node_identity=unknown");
    expect(systemPrompt).toContain("Working directory: /worker/workspace");
    const verifiedRuntimeIdentity = await verifyIdentity(assignment);
    expect(verifiedRuntimeIdentity).toMatchObject({
      agentId: fx.sessionTarget.agentId,
      sessionKey: fx.sessionTarget.sessionKey,
      turnSourceChannel: "telegram",
      turnSourceTo: "chat-worker",
      turnSourceAccountId: "worker-account",
      turnSourceThreadId: "thread-worker",
      gatewayUiCommandTarget: { connId: "requesting-ui", profileId: "requester" },
      executionIdentity: { runId: "run-worker-turn" },
    });
    expect(assignment.agentId).toBe(verifiedRuntimeIdentity?.agentId);
    expect(
      verifiedRuntimeIdentity &&
        createAgentRuntimeApprovalAuthorityValidator(fx.placements)(verifiedRuntimeIdentity),
    ).toBe(false);
    expect(admissionWork?.kind).toBe("capture");
    if (admissionWork?.kind === "capture") {
      expect(admissionWork.envelope.runtimeInstanceId).toBe(fx.ENVIRONMENT_ID);
    }
    expect(verifiedRuntimeIdentity).not.toHaveProperty("approvalOwnerPluginId");
    expect(assignment).not.toHaveProperty("admittedRunContext");
    expect(assignment).not.toHaveProperty("gatewayUiCommandTarget");
    expect(assignment.toolAuthority.allowedToolNames).toEqual(["browser"]);
    expect(assignment.browser).toEqual({
      cdpUrl: "http://127.0.0.1:9222",
      launcherPath: "/usr/local/bin/openclaw-worker-browser",
      launcherArgs: ["-File", "C:\\ProgramData\\OpenClaw\\browser.ps1"],
    });
    expect(assignment.initialMessages).toEqual([
      wireUser(expect.stringContaining("Compacted durable context"), expect.any(Number)),
      wireUser(expect.stringMatching(/^\[[^\]]+\] Earlier request$/u), 10),
      expect.objectContaining({ role: "assistant" }),
      toolResult,
      wireUser("Custom durable context", expect.any(Number)),
    ]);
    expect(
      (await fx.openSessionManager())
        .getEntries()
        .flatMap((entry) =>
          entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : [],
        ),
    ).toContain("Canonical transcript request");
  });

  it("keeps reset tool pairs valid without replaying the already-persisted current user", async () => {
    setActiveNodeContexts([{ nodeId: "disconnected-mac", isCurrent: () => false }]);
    const remote = path.join(await realpath(fx.root), "remote");
    await mkdir(remote);
    await fx.seedActivePlacement("worker-turn", remote);
    const image = {
      type: "image" as const,
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==",
      mimeType: "image/png",
    };
    const inlineImages = [
      { ...image, sourceIndex: 0 },
      { ...image, sourceIndex: 2 },
    ];
    const savedImage = await saveMediaBuffer(
      Buffer.from(image.data, "base64"),
      "image/png",
      "inbound",
      5_000,
      "offloaded.png",
    );
    const imagePath = savedImage.path;
    const manager = await fx.openSessionManager();
    await manager.appendMessageAsync(readCall("shared-call", 16, "toolUse"));
    const firstKeptEntryId = await manager.appendMessageAsync(
      makeAgentUserMessage({ content: "Earlier request", timestamp: 17 }),
    );
    await manager.appendMessageAsync(
      makeTextToolResult("shared-call", "read", "Discarded owner result", false, 18),
    );
    await manager.appendMessageAsync(readCall("shared-call", 19, "toolUse"));
    await manager.appendMessageAsync(
      makeTextToolResult("shared-call", "read", "Kept owner result", false, 20),
    );
    await manager.appendMessageAsync(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "Earlier reply" }],
        timestamp: 21,
      }),
    );
    await manager.appendResetBoundaryAsync("new", firstKeptEntryId);
    await manager.appendMessageAsync(
      makeAgentUserMessage({ content: "Inspect this workspace", timestamp: 22 }),
    );
    let descriptor: WorkerLaunchDescriptor | undefined;
    const tunnel: WorkerTunnelHandle = fx.createWorkerTurnTunnel({
      runWorkspaceCommand: vi.fn(
        async (command) =>
          await runCommandWithTimeout([...command.argv], {
            cwd: remote,
            input: command.input,
            timeoutMs: 5_000,
            signal: command.signal,
          }),
      ),
      stageAttachments: vi.fn(async () => {}),
      launchTurn: vi.fn(async (request): Promise<SpawnResult> => {
        request.onDispatchReady?.();
        descriptor = launchDescriptor(request.plan);
        return completeTurn(request, "Worker reply", 21);
      }),
      reconcileWorkspace: vi.fn(fx.reconcileUnchangedLocalWorkspace),
    });
    const environments = environmentForTunnel({
      get: vi.fn(() => fx.browserEnvironment()),
      startTunnel: vi.fn(async () => tunnel),
    });
    const provider = createLauncher({ environments });

    await provider.executeTurn(
      runIdentity("run-persisted-user"),
      {
        ...fx.turn("run-persisted-user"),
        config: {
          ...fx.turn("run-persisted-user").config,
          plugins: { entries: { browser: { enabled: false } } },
        },
        toolsAllow: ["browser"],
        suppressNextUserMessagePersistence: true,
        images: inlineImages,
        imageOrder: ["inline", "offloaded", "inline"],
        media: [{ path: imagePath, contentType: "image/png", kind: "image" }],
      },
      localResult,
    );

    const assignment = expectDefined(descriptor, "worker launch descriptor").assignment;
    expect(assignment.prompt).toEqual([
      { type: "text", text: expect.stringContaining("Inspect this workspace") },
      image,
      image,
      image,
    ]);
    expect(JSON.stringify(assignment.prompt)).toContain("media/inbound/openclaw-staged-");
    expect(tunnel.stageAttachments).toHaveBeenCalledOnce();
    expect(assignment.systemPrompt).toContain(
      "You are a personal assistant running inside OpenClaw.",
    );
    expect(assignment.systemPrompt).toContain("active_node=unknown");
    expect(assignment.systemPrompt).toContain("active_node_identity=unknown");
    expect(assignment.systemPrompt).not.toContain("disconnected-mac");
    const verifiedRuntimeIdentity = await verifyIdentity(assignment);
    expect(verifiedRuntimeIdentity).not.toHaveProperty("executionIdentity");
    expect(verifiedRuntimeIdentity).not.toHaveProperty("approvalOwnerPluginId");
    expect(assignment.toolAuthority.allowedToolNames).toEqual([]);
    expect(assignment.browser).toBeUndefined();
    expect(assignment.initialMessages).toMatchObject([
      { role: "user" },
      { role: "assistant", content: [{ id: "shared-call" }] },
      { role: "toolResult", toolCallId: "shared-call" },
      { role: "assistant" },
    ]);
    expect(JSON.stringify(assignment.initialMessages)).not.toContain("Discarded owner result");
    const persistedEntries = (await fx.openSessionManager()).getEntries();
    const persistedCurrentUsers = persistedEntries.filter(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "user" &&
        (entry.message.content === "Inspect this workspace" ||
          (Array.isArray(entry.message.content) &&
            entry.message.content.some(
              (part) => part.type === "text" && part.text === "Inspect this workspace",
            ))),
    );
    expect(persistedCurrentUsers).toHaveLength(1);
  });
});

describe("reconciliation continuation authority", () => {
  installLauncherTest();
  it.each([
    { mode: "remote-exec", authority: "source", revokeAt: "wait" },
    { mode: "remote-exec", authority: "admitted", revokeAt: "wait" },
    { mode: "worker-turn", authority: "source", revokeAt: "wait" },
    { mode: "worker-turn", authority: "admitted", revokeAt: "wait" },
    { mode: "remote-exec", authority: "source", revokeAt: "workspace" },
    { mode: "remote-exec", authority: "admitted", revokeAt: "workspace" },
    { mode: "remote-exec", authority: "source", revokeAt: "tunnel" },
    { mode: "remote-exec", authority: "admitted", revokeAt: "tunnel" },
    { mode: "remote-exec", authority: "source", revokeAt: "dispatch" },
    { mode: "remote-exec", authority: "admitted", revokeAt: "dispatch" },
    { mode: "remote-exec", authority: "source", revokeAt: "init" },
    { mode: "remote-exec", authority: "admitted", revokeAt: "init" },
    { mode: "remote-exec", authority: "source", revokeAt: "write" },
    { mode: "remote-exec", authority: "admitted", revokeAt: "write" },
    { mode: "remote-exec", authority: "source", revokeAt: "never" },
  ] as const)(
    "$mode checks $authority authority after $revokeAt",
    async ({ mode, authority, revokeAt }) => {
      const remote = path.join(fx.root, "remote-attachments");
      await mkdir(remote);
      await fx.seedActivePlacement(mode, remote);
      const active = fx.placements.get(fx.SESSION_ID);
      if (active?.state !== "active") {
        throw new Error("expected active placement");
      }
      const prior = await fx.placements.claimTurn({
        ...fx.sessionTarget,
        claimId: "prior-result",
        runId: "prior-run",
        owner: placementTurnOwner(active),
      });
      await fx.placements.markWorkspaceResultPending(prior);
      const waiting = vi.spyOn(fx.placements, "waitForTurnClaimRelease");
      const bytes = Buffer.from("authorized attachment original");
      const saved = await saveMediaBuffer(bytes, "text/plain", "inbound", bytes.length, "note.txt");
      const abort = new AbortController();
      const authorityTurn = await revocableTurn(
        "followup",
        authority,
        "test.reconciliation-source",
      );
      const { revoke } = authorityTurn;
      const input = {
        ...authorityTurn.input,
        abortSignal: abort.signal,
        media: [{ path: saved.path, contentType: "text/plain" }],
      };
      // Real attachment commands write to an isolated workspace; only transport is synthetic.
      const executedCommands: string[][] = [];
      const runWorkspaceCommand = vi.fn<WorkerTunnelHandle["runWorkspaceCommand"]>(
        async (command) => {
          // Simulate transport readiness yielding before its synchronous dispatch guard.
          await Promise.resolve();
          if (revokeAt === "dispatch") {
            revoke();
          }
          command.assertCurrent?.();
          executedCommands.push([...command.argv]);
          const result = await runCommandWithTimeout([...command.argv], {
            cwd: remote,
            input: command.input,
            timeoutMs: 5000,
          });
          if (revokeAt === command.argv[5]) {
            revoke();
          }
          return result;
        },
      );
      const environments = remoteExecEnvironment(runWorkspaceCommand, () => {
        if (revokeAt === "tunnel") {
          revoke();
        }
      });
      const resolveWorkspace = vi.fn(async () => {
        if (revokeAt === "workspace") {
          revoke();
        }
        return { kind: "local" as const, path: fx.root };
      });
      const runLocal = vi.fn(async () => {
        const directories = (await readdir(remote)).filter((name) =>
          name.startsWith(WORKER_ATTACHMENT_DIRECTORY_PREFIX),
        );
        expect(directories).toHaveLength(1);
        const directory = path.join(remote, directories[0]!);
        const files = await readdir(directory);
        expect(files).toHaveLength(1);
        expect(await readFile(path.join(directory, files[0]!))).toEqual(bytes);
        return { meta: { durationMs: 1 } };
      });
      const uninstall = installSessionPlacementAdmissionProvider(
        fx.createWorkerSessionTurnPlacementProvider({
          environments,
          placements: fx.placements,
          resolveWorkspace,
        }),
      );
      const run = withSessionPlacementTurnAdmission(
        { ...fx.sessionTarget, runId: input.runId },
        input,
        runLocal,
      );
      void run.catch(() => undefined);
      try {
        await vi.waitFor(() => expect(waiting).toHaveBeenCalledOnce());
        expect(runWorkspaceCommand).not.toHaveBeenCalled();
        if (revokeAt === "wait") {
          revoke();
        }
        await fx.placements.updateWorkspaceBaseManifest({
          claim: prior,
          manifestRef: fx.MANIFEST_REF,
        });
        await fx.placements.acceptWorkspaceResult(prior);
        await fx.placements.completeWorkspaceResultAndReleaseTurn(prior);
        if (revokeAt === "never") {
          await expect(run).resolves.toMatchObject({ meta: { durationMs: 1 } });
          expect(runLocal).toHaveBeenCalledOnce();
          expect(runWorkspaceCommand).toHaveBeenCalled();
        } else {
          await expect(run).rejects.toThrow(/authority/);
          expect(abort.signal.aborted).toBe(false);
          const transferred = revokeAt === "init" || revokeAt === "write";
          expect(environments.startTunnel).toHaveBeenCalledTimes(
            transferred || revokeAt === "tunnel" || revokeAt === "dispatch" ? 1 : 0,
          );
          if (transferred) {
            expect(executedCommands.map((argv) => argv[5])).toEqual(
              revokeAt === "init" ? ["init", "cleanup"] : ["init", "write", "cleanup"],
            );
          } else {
            expect(runWorkspaceCommand).toHaveBeenCalledTimes(revokeAt === "dispatch" ? 1 : 0);
            expect(executedCommands).toEqual([]);
          }
          expect(runLocal).not.toHaveBeenCalled();
          expect(await readdir(remote)).toEqual([]);
        }
        expect(fx.placements.get(fx.SESSION_ID)).toMatchObject({
          state: "active",
          turnClaim: null,
        });
      } finally {
        abort.abort();
        await run.catch(() => undefined);
        authorityTurn.close();
        uninstall();
      }
    },
  );
});

describe("worker turn attachment retention", () => {
  beforeEach(fx.setupWorkerTurnLauncherTest);
  afterEach(fx.cleanupWorkerTurnLauncherTest);

  it.each(["worker-turn", "remote-exec"] as const)(
    "keeps later image and PDF originals readable with %s retention",
    async (executionMode) => {
      const physicalRoot = await realpath(fx.root);
      const remote = path.join(physicalRoot, "remote");
      const local = path.join(physicalRoot, "local");
      const remoteHome = path.join(physicalRoot, "remote-home");
      const relative = (file: string) => path.relative(remote, file).split(path.sep).join("/");
      await Promise.all([mkdir(remote), mkdir(local), mkdir(remoteHome)]);
      for (const directory of [remote, local]) {
        await writeFile(path.join(directory, "remote-edits.txt"), "preserve me");
      }
      const base = await captureWorkspaceManifest({ root: local, baseCommit: null });
      await fx.seedActivePlacement(executionMode, remote);
      // These arrive after placement: the initial workspace snapshot cannot include them.
      const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(220_000, 65)]);
      const image = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==",
        "base64",
      );
      const media = await Promise.all([
        saveMediaBuffer(pdf, "application/pdf", "inbound", pdf.length, "report.pdf"),
        saveMediaBuffer(image, "image/png", "inbound", image.length, "photo.png"),
      ]);
      const recorder = createUserTurnTranscriptRecorder({
        message: buildPersistedUserTurnMessage({ text: "Read both attachments", media }),
        target: { ...fx.sessionTarget, sessionEntry: { sessionId: fx.SESSION_ID, updatedAt: 1 } },
      });
      const input = {
        ...fx.turn(),
        workspaceDir: local,
        prompt: "Read both attachments",
        media: [media[0]!],
        userTurnTranscriptRecorder: recorder,
      };
      const originalFiles = new Map<string, Buffer>();
      const outputFiles = {
        "remote-edits.txt": "worker edit",
        "report.txt": "Read both attachments",
        "openclaw-inbound-project/report.txt": "user project output",
        "openclaw-inbound-12345678-1234-4234-8234-123456789ab-/report.txt": "user project output",
      };
      let workerManifestPaths: string[] = [];
      let acceptedManifestPaths: string[] = [];
      const verifyFiles = async (prompt: string) => {
        const files: Buffer[] = [];
        for (const entry of await readdir(remote, { recursive: true, withFileTypes: true })) {
          if (!entry.isFile() || entry.name === "remote-edits.txt") {
            continue;
          }
          const file = path.join(entry.parentPath, entry.name);
          const bytes = await readFile(file);
          originalFiles.set(file, bytes);
          if (entry.name === ".gitignore") {
            continue;
          }
          files.push(bytes);
          expect(prompt).toContain(relative(path.dirname(file)));
        }
        expect(files).toHaveLength(2);
        expect(files).toEqual(expect.arrayContaining([pdf, image]));
        expect(await readFile(path.join(remote, "remote-edits.txt"), "utf8")).toBe("preserve me");
        for (const [file, content] of Object.entries(outputFiles)) {
          await mkdir(path.dirname(path.join(remote, file)), { recursive: true });
          await writeFile(path.join(remote, file), content);
        }
      };
      const tunnel = fx.createWorkerTurnTunnel({
        runWorkspaceCommand: vi.fn(async (command) => {
          parseNodeWorkerWorkspaceExecInput(
            JSON.stringify({
              gatewayNamespace: "attachments",
              environmentId: fx.ENVIRONMENT_ID,
              sessionId: fx.SESSION_ID,
              generation: fx.OWNER_EPOCH,
              argv: command.argv,
              input: command.input,
            }),
          );
          return await runCommandWithTimeout([...command.argv], {
            cwd: remote,
            input: command.input,
            timeoutMs: 10_000,
            signal: command.signal,
          });
        }),
        stageAttachments: async (request) => {
          const service = createNodeWorkspaceTransferService({
            getOwner: () => ({
              credential: fx.credential(),
              environment: fx.attachedEnvironment(),
            }),
            temporaryRoot: path.join(remoteHome, "transfers"),
          });
          const server = await startNodeWorkspaceTransferTestServer(service);
          try {
            await service.prepareSync({
              environmentId: fx.ENVIRONMENT_ID,
              ownerEpoch: fx.OWNER_EPOCH,
              sessionId: fx.SESSION_ID,
              localPath: local,
              isAuthorized: request.isAuthorized,
            });
            const prepared = await service.prepareAttachments({
              ...request,
              environmentId: fx.ENVIRONMENT_ID,
            });
            await runNodeWorkerWorkspaceTransfer({
              gatewayUrl: server.gatewayUrl,
              environmentId: fx.ENVIRONMENT_ID,
              workspaceDir: remote,
              manifestHome: remoteHome,
              transfer: {
                direction: "download",
                token: prepared.token,
                manifestRef: prepared.snapshot.manifestRef,
                attachments: true,
              },
              signal: request.signal,
            });
          } finally {
            await service.closeAll();
            await server.close();
          }
        },
        launchTurn: vi.fn<WorkerTurnTunnelHandle["launchTurn"]>(async (request) => {
          const prompt = request.plan.assignment.prompt;
          await verifyFiles(
            typeof prompt === "string"
              ? prompt
              : prompt.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
          );
          request.onDispatchReady?.();
          const session = await fx.openSessionManager();
          const transcriptLeafId = await session.appendMessageAsync(
            makeAgentAssistantMessage({ content: [{ type: "text", text: "Read both" }] }),
          );
          return await fx.acknowledgeCompletedWorkerTurn(request.turnClaim, transcriptLeafId);
        }),
        reconcileWorkspace: vi.fn(async (request) => {
          if (request.source.kind !== "local") {
            throw new Error("expected a local workspace source");
          }
          const capture = await runCommandWithTimeout(
            [process.execPath, "-e", REMOTE_WORKSPACE_MANIFEST_JS, remote],
            { timeoutMs: 10_000, baseEnv: { ...process.env, HOME: remoteHome } },
          );
          expect(capture.code, capture.stderr).toBe(0);
          const manifestRef = capture.stdout.trim();
          const raw = await readFile(
            path.join(remoteHome, ".openclaw-worker", "manifests", `${manifestRef.slice(7)}.json`),
            "utf8",
          );
          const result = await applyStagedWorkerWorkspace({
            root: local,
            stagingRoot: remote,
            baseManifestRef: fx.MANIFEST_REF,
            currentManifestRef: manifestRef,
            base: base.manifest,
            current: parseWorkerWorkspaceManifest(raw, manifestRef),
            acceptance: { kind: "reconcile" },
            journal: request.source.journal,
          });
          workerManifestPaths = JSON.parse(raw).entries.map(
            (entry: { path: string }) => entry.path,
          );
          acceptedManifestPaths = result.manifest.entries.map((entry) => entry.path);
          return {
            ...result,
            changed: true,
            verifyStable: async () => {},
            publishStagedResult: async () => {},
            discardPreparedStagedResult: async () => {},
          };
        }),
      });
      const provider = fx.createWorkerSessionTurnPlacementProvider({
        placements: fx.placements,
        resolveWorkspace: async () => ({ kind: "local", path: local }),
        environments: fx.workerTurnEnvironments(tunnel, {
          acknowledgeCredentialDelivery: async () => true,
        }),
      });
      await provider.executeTurn({ ...fx.sessionTarget, runId: input.runId }, input, async () => {
        await verifyFiles(input.prompt);
        return { meta: { durationMs: 1 } };
      });
      await waitForSessionRunEnd(fx.SESSION_ID, null);
      if (executionMode === "remote-exec") {
        const commands = vi.mocked(tunnel.runWorkspaceCommand).mock.calls;
        expect(commands.at(-1)?.[0].input).toBe(JSON.stringify({ op: "discover" }));
        // At most one setup, three PDF chunks, and one image chunk.
        expect(commands.length - 1).toBeLessThanOrEqual(5);
      }
      expect(tunnel.syncWorkspace).not.toHaveBeenCalled();
      expect(tunnel.reconcileWorkspace).toHaveBeenCalledOnce();
      const retainedFiles =
        executionMode === "worker-turn" ? [...originalFiles.keys()].map(relative) : [];
      const expectedFiles = [...Object.keys(outputFiles), ...retainedFiles].toSorted();
      const ancestors = (file: string) => {
        const segments = file.split("/");
        return segments.map((_segment, index) => segments.slice(0, index + 1).join("/"));
      };
      const expectedPaths = [...new Set(expectedFiles.flatMap(ancestors))].toSorted();
      expect(workerManifestPaths).toEqual(expectedPaths);
      expect(acceptedManifestPaths).toEqual(expectedFiles);
      expect(
        (await readdir(local, { recursive: true }))
          .map((entry) => entry.split(path.sep).join("/"))
          .toSorted(),
      ).toEqual(expectedPaths);
      for (const [file, content] of Object.entries(outputFiles)) {
        expect(await readFile(path.join(local, file), "utf8")).toBe(content);
      }
      for (const [file, bytes] of originalFiles) {
        expect(await readFile(file)).toEqual(bytes);
        if (executionMode === "worker-turn") {
          expect(await readFile(path.join(local, path.relative(remote, file)))).toEqual(bytes);
        }
      }
      expect(input.prompt).toBe("Read both attachments");
    },
  );
});
