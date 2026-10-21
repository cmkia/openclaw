import { expect, it, vi, describe } from "vitest";
import {
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
  WORKER_RPC_SET_VERSION,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { NODE_WORKER_ENVIRONMENT_STOP_COMMAND } from "../../infra/node-commands.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { WorkerNodeLostError } from "../../worker/worker-node-loss.js";
import { installWorkerPlacementReconcileGuard } from "../server-worker-placement-reconcile-guard.js";
import { StaleWorkerBuildError } from "./admission.js";
import { hashWorkerCredential } from "./credential.js";
import { createNodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import {
  transport,
  withWorkspaceDrain,
  workspaceTransfer,
} from "./node-worker-tunnel.test-support.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import type { WorkerSessionTurnClaim } from "./placement-store.js";
import { advancePlacementFixtureToActive } from "./placement-test-fixtures.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import { createProviderReplayDispatch } from "./provider-replay.test-support.js";
import { createWorkerEnvironmentService } from "./service.js";
import { BUNDLE_ARTIFACT, createProvider } from "./service.test-support.js";
import { createWorkerEnvironmentStore } from "./store.js";
import type { WorkerTurnTunnelHandle } from "./tunnel-contract.js";
import {
  executeTurn,
  installLauncherTest,
  createLauncher,
} from "./worker-turn-launcher-flow.test-support.js";
import {
  ENVIRONMENT_ID,
  SESSION_ID,
  SESSION_KEY,
  createWorkerSessionTurnPlacementProvider,
  database,
  placements,
  root,
  attachedEnvironment,
  seedActivePlacement,
  createWorkerTurnTunnel,
  reconcileUnchangedLocalWorkspace,
  type WorkerTurnLauncherOptions,
  turn,
  workerTurnRequest,
  workerTurnEnvironments,
} from "./worker-turn-launcher.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import { createWorkerWorkspaceRecoveryFixture } from "./workspace-recovery.test-support.js";

installLauncherTest();

it("settles a stale-build turn when a lost shared node rejects its stop acknowledgement", async () => {
  const store = await createWorkerEnvironmentStore({ database });
  let installation = {
    ...BUNDLE_ARTIFACT,
    protocolFeatures: [
      WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
      WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
    ],
  };
  const nodeTransport = transport();
  let rejectStop = true;
  const stopRequests = vi.fn<typeof nodeTransport.invoke>(async (request) => {
    expect(request.command).toBe(NODE_WORKER_ENVIRONMENT_STOP_COMMAND);
    return rejectStop
      ? { ok: false, error: { code: "UNAVAILABLE" } }
      : { ok: true, payloadJSON: "null" };
  });
  vi.spyOn(nodeTransport, "invoke").mockImplementation(withWorkspaceDrain(stopRequests));
  const nodeTunnelManager = createNodeWorkerTunnelManager({
    gatewayDeviceId: "gateway-recovery-fixture",
    getEnvironment: store.get,
    listEnvironments: store.list,
    getTransport: () => nodeTransport,
    launchNodeWorker: vi.fn(),
    validateWorkerTurn: (claim) => placements.validateTurnClaim(claim),
    workspaceTransfer: workspaceTransfer({ closeAll: vi.fn(async () => {}) }),
  });
  const inspect = vi.fn(async () => ({ status: "destroyed" as const }));
  const provider = createProvider({ supportedExecutionModes: ["worker-turn"], inspect });
  const warn = vi.fn();
  const environments = createWorkerEnvironmentService({
    scheduler: createTestGatewayScheduler(),
    store,
    getConfig: () => ({}),
    resolveProvider: () => provider,
    prepareInstallation: async () => installation,
    bootstrapWorker: vi.fn(),
    placementStore: createWorkerSessionPlacementGate(placements),
    nodeTunnelManager,
    logger: { warn },
  });
  const workspaceOperations = createWorkerWorkspaceOperationCoordinator();
  const dispatch = coordinateWorkerPlacementDispatch(
    createProviderReplayDispatch({
      initialPlacements: await placements.listAsync(),
      placements,
      environments,
      workspaceOperations,
      runRecoveryBarrier: async ({ run }) => await run({ kind: "local", path: root }),
      runReclaimBarrier: async ({ begin, reclaim }) =>
        await reclaim({ kind: "local", path: root }, await begin()),
      ...createWorkerWorkspaceRecoveryFixture({
        resolveWorkspace: async () => ({ kind: "local", path: root }),
      }),
    }),
    (_request, run) => run(),
  );
  const uninstall = installWorkerPlacementReconcileGuard({
    placements,
    environments,
    dispatch,
    isStopping: () => false,
  });
  try {
    await store.createIntent({
      environmentId: ENVIRONMENT_ID,
      providerId: provider.id,
      profileId: "development",
      profileSnapshot: { executionMode: "worker-turn", settings: { device: "node-1" } },
      provisionOperationId: "shared-node-recovery",
    });
    await store.transition({
      environmentId: ENVIRONMENT_ID,
      from: "requested",
      to: "provisioning",
    });
    const ready = await store.transition({
      environmentId: ENVIRONMENT_ID,
      from: "provisioning",
      to: "ready",
      patch: {
        leaseId: "shared-node-lease",
        nodeDeviceId: "node-1",
        sharedHost: true,
        credential: {
          credentialHash: hashWorkerCredential("ready-worker-recovery-fixture"),
          sessionId: null,
          rpcSetVersion: WORKER_RPC_SET_VERSION,
          expiresAtMs: Date.now() + 60_000,
        },
        bootstrapReceipt: {
          bundleHash: installation.bundleHash,
          openclawVersion: installation.openclawVersion,
          protocolFeatures: installation.protocolFeatures,
          installKind: "bundle",
        },
      },
    });
    const attached = await environments.attachSession({
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: ready.ownerEpoch,
      sessionId: SESSION_ID,
    });
    await advancePlacementFixtureToActive(
      placements,
      database,
      {
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        agentId: "main",
        executionMode: "worker-turn",
      },
      {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: attached.ownerEpoch,
        workerBundleHash: installation.bundleHash,
        remoteWorkspaceDir: "/worker/workspace",
        seedEnvironment: false,
      },
    );
    installation = { ...installation, bundleHash: "d".repeat(64) };
    const startTunnel = vi.spyOn(environments, "startTunnel");
    const launcher = createWorkerSessionTurnPlacementProvider({
      placements,
      environments,
      workspaceOperations,
      reconcileActivePlacement: dispatch.reconcileActive,
    });
    const runId = "stale-build-shared-node-stop-failed";
    const failure = await executeTurn(launcher, runId, vi.fn()).catch((error: unknown) => error);

    expect(startTunnel).toHaveBeenCalledOnce();
    await expect(startTunnel.mock.results[0]?.value).rejects.toBeInstanceOf(StaleWorkerBuildError);
    expect(inspect).toHaveBeenCalledOnce();
    expect(stopRequests).toHaveBeenCalled();
    expect(store.getCredential(ENVIRONMENT_ID)).toBeUndefined();
    expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "failed", turnClaim: null });
    expect(failure).toBeInstanceOf(Error);
    expect(warn).toHaveBeenCalledWith(
      `Worker environment reconcile failed (${ENVIRONMENT_ID}, ${provider.id})`,
    );
  } finally {
    rejectStop = false;
    await uninstall();
    await environments.stop();
  }
});

const pendingResults = () => placements.listPendingWorkspaceResultsAsync();

describe("worker turn launcher node-loss continuation", () => {
  it.each([
    "reconnect",
    "partial persistence failed",
    "node never reconnects",
    "retained workspace and no reconnect",
  ] as const)("allows continuation only after a settled reconnect: %s", async (mode) => {
    await seedActivePlacement();
    const reconnects = mode === "reconnect";
    const runId = reconnects ? "node-loss-reconnect" : "node-loss-unavailable";
    const loss = new WorkerNodeLostError();
    const reconnect = createDeferred();
    const waiting = createDeferred();
    const order: string[] = [];
    let interruptedClaim: WorkerSessionTurnClaim | undefined;
    const launchTurn = vi.fn<WorkerTurnTunnelHandle["launchTurn"]>(async (request) => {
      interruptedClaim = request.turnClaim;
      request.onDispatchReady?.();
      if (!reconnects && mode !== "retained workspace and no reconnect") {
        await placements.markWorkspaceResultPending(request.turnClaim);
      }
      throw loss;
    });
    const waitForAdmissionNode = vi.fn<
      NonNullable<WorkerTurnLauncherOptions["waitForAdmissionNode"]>
    >(async ({ signal, assertCurrent }) => {
      if (!reconnects) {
        throw new Error("node admission expired");
      }
      expect(signal.aborted).toBe(false);
      expect(await pendingResults()).toMatchObject([
        { runId, recoveryRequestedAtMs: expect.any(Number) },
      ]);
      waiting.resolve();
      await reconnect.promise;
      assertCurrent();
      order.push("node reconnected");
    });
    const reconcileActivePlacement = vi.fn(async () => {
      if (reconnects) {
        expect(interruptedClaim).toBeDefined();
        await placements.acceptWorkspaceResult(interruptedClaim!);
        await placements.completeWorkspaceResultAndReleaseTurn(interruptedClaim!);
        order.push("workspace settled");
      }
    });
    const destroy = vi.fn(async () => attachedEnvironment());
    const nodeEnvironment = {
      ...attachedEnvironment(),
      nodeDeviceId: "paired-node",
      sshEndpoint: null,
    };
    const provider = createLauncher({
      waitForAdmissionNode,
      reconcileActivePlacement,
      persistAbandonedPartial: async (claim) => {
        if (mode === "partial persistence failed") {
          throw new Error("transcript unavailable");
        }
        if (reconnects) {
          expect(claim.missingToolResultText).toBe(loss.message);
          order.push("transcript saved");
        }
      },
      environments: workerTurnEnvironments(
        createWorkerTurnTunnel({
          reconcileWorkspace: reconcileUnchangedLocalWorkspace,
          launchTurn,
        }),
        {
          get: reconnects ? () => nodeEnvironment : attachedEnvironment,
          ...(reconnects ? {} : { destroy }),
          acknowledgeCredentialDelivery: async () => true,
          stopTunnel: async () => {
            if (reconnects) {
              order.push("tunnel stopped");
            }
          },
        },
      ),
    });
    const runLocal = vi.fn();
    const attempt = provider.executeTurn(workerTurnRequest(runId), turn(runId), runLocal);
    const outcome = attempt.catch((error: unknown) => error);
    try {
      if (!reconnects) {
        await expect(attempt).rejects.toBe(loss);
        expect(loss.canContinue).toBe(false);
        expect(waitForAdmissionNode).toHaveBeenCalledTimes(
          mode === "partial persistence failed" ? 0 : 1,
        );
        expect(await pendingResults()).toHaveLength(1);
        expect(destroy).not.toHaveBeenCalled();
        if (mode === "retained workspace and no reconnect") {
          expect(placements.get(SESSION_ID)).toMatchObject({ state: "active" });
          expect(await pendingResults()).toMatchObject([
            { recoveryRequestedAtMs: expect.any(Number) },
          ]);
        }
      } else {
        await awaitGateBeforeSettlement(
          waiting.promise,
          outcome,
          "node loss settled before reconnect admission",
        );
        expect(loss.canContinue).toBe(false);
        expect(reconcileActivePlacement).not.toHaveBeenCalled();
        reconnect.resolve();
        expect(await outcome).toBe(loss);
        expect(loss.canContinue).toBe(true);
        expect(order).toEqual([
          "transcript saved",
          "tunnel stopped",
          "node reconnected",
          "workspace settled",
        ]);
        expect(runLocal).not.toHaveBeenCalled();
        expect(await pendingResults()).toEqual([]);
        expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
      }
      expect(launchTurn).toHaveBeenCalledOnce();
    } finally {
      reconnect.resolve();
      await outcome;
    }
  });
});
