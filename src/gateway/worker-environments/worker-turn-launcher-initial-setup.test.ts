import { describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  withinTest,
  createDeferred,
} from "../../../test/helpers/promise.js";
import {
  type SessionPlacementTurnParams,
  installSessionPlacementAdmissionProvider,
  resolveSessionPlacementRuntimeOverride,
  withSessionPlacementTurnAdmission,
} from "../../agents/session-placement-admission.js";
import { patchSessionEntryCore, loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { waitForSessionRunEnd } from "../../sessions/session-controller.native-runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { result as processResult } from "./bootstrap.test-support.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import { createCoordinatorTestService } from "./placement-dispatch-coordinator.test-support.js";
import { placementTurnOwner } from "./placement-record.js";
import { completeWorkerWorkspaceTeardown } from "./placement-teardown.js";
import type { WorkerTurnTunnelHandle } from "./tunnel-contract.js";
import { waitForPendingWorkerResult } from "./worker-turn-admission.js";
import {
  expectUncalled,
  installLauncherTest,
  localResult,
  revocableTurn,
  remoteExecEnvironment,
  runIdentity,
  createLauncher,
  environmentForTunnel,
  executeTurn,
  completeTurn,
} from "./worker-turn-launcher-flow.test-support.js";
import * as fx from "./worker-turn-launcher.test-support.js";

// Pause the real placement store/coordinator at the producer's published setup state.
async function setup(
  executionMode: "worker-turn" | "remote-exec",
  onActivated?: () => Promise<void>,
) {
  const paused = createDeferredCore();
  const finish = createDeferredCore();
  const waiting = createDeferredCore();
  let failure: Error | undefined;
  const dispatch = coordinateWorkerPlacementDispatch(
    createCoordinatorTestService({
      dispatch: async (_request, report) =>
        await fx.dispatchInitialWorkerPlacement({
          database: fx.database,
          placements: fx.placements,
          identity: { ...fx.sessionTarget, executionMode },
          workspace: fx.root,
          onTransition: async (placement) => {
            report?.(placement);
            if (placement.state === "active") {
              await onActivated?.();
            }
            if (placement.state === "syncing") {
              paused.resolve();
              await finish.promise;
              if (failure) {
                throw failure;
              }
            }
          },
        }),
    }),
    (_request, run) => run(),
  );
  const operation = dispatch.dispatch({
    ...fx.sessionTarget,
    executionMode,
    profileId: "development",
  });
  void operation.catch(() => undefined);
  await paused.promise;
  return {
    finish,
    operation,
    waitForInitialPlacement: (...args: Parameters<typeof dispatch.waitForInitialPlacement>) => {
      waiting.resolve();
      return dispatch.waitForInitialPlacement(...args);
    },
    wait: (run: Promise<unknown>, signal: AbortSignal) =>
      withinTest(
        awaitGateBeforeSettlement(waiting.promise, run, "turn skipped the setup wait"),
        signal,
      ),
    settle: async (run: Promise<unknown>) => {
      finish.resolve();
      await Promise.allSettled([run, operation]);
    },
    fail: () => {
      failure = new Error("setup transfer failed");
    },
  };
}

// Exercise real remote-exec admission and settlement; only the remote transport is synthetic.
function readyEnvironment() {
  return remoteExecEnvironment(
    async (command) =>
      await runCommandWithTimeout([...command.argv], {
        cwd: fx.root,
        input: command.input,
        timeoutMs: 5000,
      }),
  );
}

function startHeldTurn(
  fixture: Awaited<ReturnType<typeof setup>>,
  input: SessionPlacementTurnParams,
  options: {
    environments?: fx.WorkerTurnEnvironmentService;
    throughAdmission?: boolean;
    onAdmitted?: () => void;
    resolveWorkspace?: fx.WorkerTurnLauncherOptions["resolveWorkspace"];
  } = {},
) {
  const { environments = readyEnvironment(), throughAdmission, onAdmitted, ...overrides } = options;
  const runLocal = vi.fn(localResult);
  const provider = fx.createWorkerSessionTurnPlacementProvider({
    environments,
    placements: fx.placements,
    waitForInitialPlacement: fixture.waitForInitialPlacement,
    ...overrides,
  });
  const uninstall = throughAdmission
    ? installSessionPlacementAdmissionProvider(provider)
    : () => {};
  const identity = runIdentity(input.runId);
  const run = throughAdmission
    ? withSessionPlacementTurnAdmission(identity, input, runLocal)
    : provider.executeTurn(identity, input, runLocal, onAdmitted);
  void run.catch(() => undefined);
  return {
    run,
    runLocal,
    environments,
    [Symbol.asyncDispose]: async () => {
      await fixture.settle(run);
      uninstall();
    },
  };
}

describe("initial worker setup admission", () => {
  installLauncherTest();

  it.for(["worker-turn", "remote-exec"] as const)(
    "holds %s input without agent IO until syncing becomes authoritative and active",
    async (mode, { signal }) => {
      const fixture = await setup(mode);
      const admitted = vi.fn();
      await using held = startHeldTurn(
        fixture,
        { ...fx.turn("initial-input"), abortSignal: signal },
        {
          environments: mode === "worker-turn" ? fx.unusedEnvironments() : readyEnvironment(),
          onAdmitted: admitted,
        },
      );
      const { run, runLocal, environments } = held;
      const settled = vi.fn();
      void run.then(settled, settled);
      await fixture.wait(run, signal);
      expectUncalled(settled, environments.get, runLocal, environments.startTunnel, admitted);
      expect(fx.placements.get(fx.SESSION_ID)?.turnClaim).toBeNull();
      fixture.finish.resolve();
      await fixture.operation;
      if (mode === "worker-turn") {
        await expect(run).rejects.toThrow("does not match its attached environment");
        expect(environments.get).toHaveBeenCalledOnce();
        expectUncalled(runLocal);
      } else {
        await expect(run).resolves.toMatchObject({ meta: { durationMs: 1 } });
        expect(runLocal).toHaveBeenCalledOnce();
        expect(admitted).toHaveBeenCalledOnce();
        expect(fx.placements.get(fx.SESSION_ID)).toMatchObject({
          state: "active",
          turnClaim: null,
        });
      }
    },
  );

  it("keeps the worker runtime default when setup finishes during its read", async ({ signal }) => {
    const fixture = await setup("worker-turn");
    const reading = createDeferredCore();
    const resumeRead = createDeferredCore();
    const readProjection = fx.placements.readProjection.bind(fx.placements);
    const read = vi
      .spyOn(fx.placements, "readProjection")
      .mockImplementationOnce(async (...args) => {
        const projection = await readProjection(...args);
        reading.resolve();
        await resumeRead.promise;
        return projection;
      });
    const environments = fx.unusedEnvironments();
    const uninstall = installSessionPlacementAdmissionProvider(
      fx.createWorkerSessionTurnPlacementProvider({ environments, placements: fx.placements }),
    );
    const runtime = resolveSessionPlacementRuntimeOverride(fx.sessionTarget);
    void runtime.catch(() => undefined);
    try {
      await withinTest(
        awaitGateBeforeSettlement(reading.promise, runtime, "runtime selection skipped its read"),
        signal,
      );
      fixture.finish.resolve();
      await fixture.operation;
      resumeRead.resolve();
      await expect(runtime).resolves.toBe("openclaw");
      expect(fx.placements.get(fx.SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
      expect(environments.startTunnel).not.toHaveBeenCalled();
    } finally {
      resumeRead.resolve();
      fixture.finish.resolve();
      await Promise.allSettled([runtime, fixture.operation]);
      uninstall();
      read.mockRestore();
    }
  });

  it("refreshes pending-result facts after waiting for initial setup", async ({ signal }) => {
    const fixture = await setup("remote-exec", async () => {
      const claim = await fx.placements.claimTurn({
        ...fx.sessionTarget,
        claimId: "setup-result-claim",
        runId: "setup-result-run",
        owner: { kind: "local", environmentId: fx.ENVIRONMENT_ID, ownerEpoch: fx.OWNER_EPOCH },
      });
      await fx.placements.markWorkspaceResultPending(claim);
      await fx.placements.clearLocalTurnClaimsAfterRestartAsync();
    });
    const claimTurn = vi.spyOn(fx.placements, "claimTurn");
    await using held = startHeldTurn(
      fixture,
      { ...fx.turn("waiting-input"), abortSignal: signal },
      { environments: fx.unusedEnvironments() },
    );
    const { run, runLocal } = held;
    await fixture.wait(run, signal);
    fixture.finish.resolve();
    await fixture.operation;
    await expect(run).rejects.toThrow("Workspace recovery is still pending");
    expect(claimTurn.mock.calls.filter(([claim]) => claim.runId === "waiting-input")).toEqual([]);
    expect(runLocal).not.toHaveBeenCalled();
  });

  it.for(["failure", "abort", "incarnation", "writer", "runtime", "replacement"] as const)(
    "does not execute held input after %s",
    async (change, { signal }) => {
      const fixture = await setup(
        "remote-exec",
        change === "replacement"
          ? async () => {
              const current = fx.placements.get(fx.SESSION_ID)!;
              await fx.placements.transition({
                sessionId: fx.SESSION_ID,
                expectedGeneration: current.generation,
                from: "active",
                to: "draining",
              });
            }
          : undefined,
      );
      const controller = new AbortController();
      await using held = startHeldTurn(
        fixture,
        { ...fx.turn("obsolete-input"), abortSignal: AbortSignal.any([controller.signal, signal]) },
        { throughAdmission: true },
      );
      const { run, runLocal, environments } = held;
      await fixture.wait(run, signal);
      if (change === "failure") {
        fixture.fail();
      }
      if (change === "abort") {
        controller.abort(new Error("operator cancelled input"));
        await expect(run).rejects.toThrow(/aborted/);
      }
      if (change === "incarnation") {
        await patchSessionEntryCore(fx.sessionTarget, () => ({ lifecycleRevision: "replacement" }));
      }
      if (change === "writer") {
        await patchSessionEntryCore(fx.sessionTarget, () => ({ activeWriterRunId: "replacement" }));
      }
      if (change === "runtime") {
        rotateAgentEventLifecycleGeneration();
      }
      fixture.finish.resolve();
      await fixture.operation.catch(() => undefined);
      await expect(run).rejects.toThrow();
      expectUncalled(runLocal, environments.startTunnel);
      expect(fx.placements.get(fx.SESSION_ID)?.turnClaim).toBeNull();
    },
  );

  it.for(["source", "admitted"] as const)(
    "rejects %s authority revoked during setup before workspace IO",
    async (kind, { signal }) => {
      const fixture = await setup("remote-exec");
      const resolveWorkspace = vi.fn(async () => ({ kind: "local" as const, path: fx.root }));
      using authority = await revocableTurn("revoked-input", kind, "test.setup-source");
      await using held = startHeldTurn(
        fixture,
        { ...authority.input, abortSignal: signal },
        { resolveWorkspace, throughAdmission: true },
      );
      const { run, runLocal, environments } = held;
      await fixture.wait(run, signal);
      authority.revoke();
      fixture.finish.resolve();
      await fixture.operation;
      await expect(run).rejects.toThrow(/authority/);
      expectUncalled(resolveWorkspace, environments.startTunnel, runLocal);
      expect(fx.placements.get(fx.SESSION_ID)?.turnClaim).toBeNull();
    },
  );

  it("rejects orphan setup instead of waiting indefinitely or running locally", async () => {
    const placement = await fx.placements.startDispatch(fx.sessionTarget);
    const dispatch = coordinateWorkerPlacementDispatch(
      createCoordinatorTestService({}),
      (_request, run) => run(),
    );
    await expect(dispatch.waitForInitialPlacement(placement)).rejects.toThrow(
      "no matching live dispatch owner",
    );
  });
});

async function claimActivePlacement(
  claimId: string,
  runId: string,
  mode: "worker-turn" | "remote-exec" = "worker-turn",
) {
  await fx.seedActivePlacement(mode);
  const active = fx.placements.get(fx.SESSION_ID);
  if (active?.state !== "active") {
    throw new Error("expected active placement");
  }
  const turnClaim = await fx.placements.claimTurn({
    ...runIdentity(runId),
    claimId,
    owner: placementTurnOwner(active),
  });
  return { active, turnClaim };
}

describe("worker turn admission before launch", () => {
  installLauncherTest();
  it.each(["worker-turn", "remote-exec"] as const)(
    "rejects compaction successors throughout the %s placement lifecycle without changing ownership",
    async (executionMode) => {
      const provider = createLauncher();
      const successorGate = vi.spyOn(provider, "assertCompactionSuccessorAllowed");
      const uninstall = installSessionPlacementAdmissionProvider(provider);
      try {
        await fx.withWorkerCompactionAdoption("run-placement-compaction", async (adopt) => {
          const successorId = "session-unsupported-successor";
          const assertRejected = async () => {
            const before = fx.placements.get(fx.SESSION_ID);
            const entryBefore = loadSessionEntry(fx.sessionTarget);
            await expect(adopt(successorId), before?.state).rejects.toThrow(
              /worker placement.*same session ID/u,
            );
            expect(fx.placements.get(fx.SESSION_ID)).toEqual(before);
            expect(loadSessionEntry(fx.sessionTarget)).toEqual(entryBefore);
            expect(await fx.placements.getAsync(successorId)).toBeUndefined();
          };
          const localClaim = await fx.placements.claimTurn({
            ...fx.sessionTarget,
            claimId: "local-before-dispatch",
            runId: "run-placement-compaction",
            owner: { kind: "local" },
          });
          const placement = await fx.dispatchInitialWorkerPlacement({
            database: fx.database,
            placements: fx.placements,
            identity: { ...fx.sessionTarget, executionMode },
            workspace: "/worker/workspace",
            onTransition: async (current) => {
              if (current.state === "requested") {
                await expect(adopt(fx.SESSION_ID)).resolves.toBeUndefined();
                expect(successorGate).not.toHaveBeenCalled();
              }
              await assertRejected();
              if (current.state === "requested") {
                expect(fx.placements.validateTurnClaim(localClaim)).toBe(true);
                await fx.placements.releaseTurn(localClaim);
              }
            },
          });
          const workerClaim = await fx.placements.claimTurn({
            ...fx.sessionTarget,
            claimId: "active-worker-compaction",
            runId: "run-placement-compaction",
            owner: placementTurnOwner(placement),
          });
          const priorGateCalls = successorGate.mock.calls.length;
          await expect(adopt(fx.SESSION_ID)).resolves.toBeUndefined();
          expect(successorGate).toHaveBeenCalledTimes(priorGateCalls);
          await assertRejected();
          const draining = await fx.placements.startDrain({
            sessionId: fx.SESSION_ID,
            environmentId: fx.ENVIRONMENT_ID,
            ownerEpoch: fx.OWNER_EPOCH,
            expectedGeneration: placement.generation,
          });
          await assertRejected();
          expect(fx.placements.validateTurnClaim(workerClaim)).toBe(true);
          await fx.placements.releaseTurn(workerClaim);
          const reconciling = await fx.placements.startReconcile({
            sessionId: fx.SESSION_ID,
            environmentId: fx.ENVIRONMENT_ID,
            ownerEpoch: fx.OWNER_EPOCH,
            expectedGeneration: draining.generation,
          });
          await assertRejected();
          await fx.placements.transition({
            sessionId: fx.SESSION_ID,
            from: "reconciling",
            to: "reclaimed",
            expectedGeneration: reconciling.generation,
          });
          await assertRejected();
          await fx.placements.startDispatch({ ...fx.sessionTarget, executionMode });
          await fx.placements.fail({
            sessionId: fx.SESSION_ID,
            recoveryError: "fixture dispatch failed",
          });
          await assertRejected();
        });
      } finally {
        uninstall();
      }
    },
  );

  it.each(["worker-turn", "remote-exec"] as const)(
    "holds a %s replacement across pending-result admission and reconciliation",
    async (mode) => {
      const { turnClaim: priorClaim } = await claimActivePlacement(
        "prior-result-claim",
        "prior-result-run",
        mode,
      );
      const projectionReads = vi.spyOn(fx.placements, "readProjection");
      let readsBeforeClaim = 0;
      if (mode === "remote-exec") {
        const claimTurn = fx.placements.claimTurn.bind(fx.placements);
        vi.spyOn(fx.placements, "claimTurn").mockImplementationOnce(async (...args) => {
          readsBeforeClaim = projectionReads.mock.calls.length;
          try {
            return await claimTurn(...args);
          } catch (error) {
            await fx.placements.markWorkspaceResultPending(priorClaim);
            throw error;
          }
        });
      } else {
        await fx.placements.markWorkspaceResultPending(priorClaim);
      }
      const waitForRelease = vi.spyOn(fx.placements, "waitForTurnClaimRelease");
      const provider = createLauncher();

      if (mode === "worker-turn") {
        await expect(executeTurn(provider, priorClaim.runId)).rejects.toThrow(
          "already has an active turn claim",
        );
        expect(waitForRelease).not.toHaveBeenCalled();
      }

      const replacement = executeTurn(provider, "next-run");
      void replacement.catch(() => undefined);
      await vi.waitFor(() => expect(waitForRelease).toHaveBeenCalledOnce());
      expect(waitForRelease).toHaveBeenCalledWith(fx.SESSION_ID, {
        signal: expect.any(AbortSignal),
      });
      expect(fx.placements.get(fx.SESSION_ID)?.turnClaim?.runId).toBe(priorClaim.runId);

      await fx.placements.updateWorkspaceBaseManifest({
        claim: priorClaim,
        manifestRef: fx.MANIFEST_REF,
      });
      await fx.placements.acceptWorkspaceResult(priorClaim);
      await fx.placements.completeWorkspaceResultAndReleaseTurn(priorClaim);
      await expect(replacement).rejects.toThrow(
        `Active ${mode === "worker-turn" ? "worker" : "remote-exec"} placement does not match its attached environment`,
      );
      // Both preparation facts must come from one worker request, even when claim admission loses a race.
      if (mode === "remote-exec") {
        expect(readsBeforeClaim).toBe(1);
      }
    },
  );

  it("returns a recovery outcome for restart-cleared claim retry", async () => {
    const runId = "restart-result-run";
    await fx.seedActivePlacement("remote-exec");
    const priorClaim = await fx.placements.claimTurn({
      ...fx.sessionTarget,
      claimId: "restart-result-claim",
      runId: "restart-result-run",
      owner: { kind: "local", environmentId: fx.ENVIRONMENT_ID, ownerEpoch: fx.OWNER_EPOCH },
    });
    await fx.placements.markWorkspaceResultPending(priorClaim);
    await fx.placements.recordStagedWorkspaceResult(
      priorClaim,
      "refs/openclaw/worker-results/missing",
    );
    await fx.placements.clearLocalTurnClaimsAfterRestartAsync();
    const pending = await fx.placements.listPendingWorkspaceResultsAsync();
    expect(pending).toMatchObject([
      { stagedResultRef: "refs/openclaw/worker-results/missing", workspaceAcceptedAtMs: null },
    ]);
    expect(fx.placements.get(fx.SESSION_ID)?.turnClaim).toBeNull();

    // Prove the wait boundary first: a resolved claim wait must not trigger a retry loop.
    await expect(
      waitForPendingWorkerResult({ placements: fx.placements, sessionId: fx.SESSION_ID }),
    ).rejects.toThrow("Workspace recovery is still pending");
    const runLocal = vi.fn(localResult);
    const provider = createLauncher();
    await expect(
      provider.executeTurn({ ...fx.sessionTarget, runId }, fx.turn(runId), runLocal),
    ).rejects.toThrow("Wait for workspace recovery to finish before retrying");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(runLocal).not.toHaveBeenCalled();
    expect(await fx.placements.listPendingWorkspaceResultsAsync()).toEqual(pending);
    expect(fx.placements.get(fx.SESSION_ID)?.turnClaim).toBeNull();
  });

  it("redispatches the admitted replacement after pending-result recovery reclaims it", async () => {
    const { active, turnClaim: priorClaim } = await claimActivePlacement(
      "reclaimed-result-claim",
      "reclaimed-result-run",
    );
    await fx.placements.markWorkspaceResultPending(priorClaim);
    await fx.placements.startWorkspaceResultDrain(priorClaim);
    vi.spyOn(fx.placements, "waitForTurnClaimRelease").mockImplementationOnce(async () => {
      await fx.placements.updateWorkspaceBaseManifest({
        claim: priorClaim,
        manifestRef: fx.MANIFEST_REF,
      });
      await fx.placements.acceptWorkspaceResult(priorClaim);
      await completeWorkerWorkspaceTeardown({
        placements: fx.placements,
        turnClaim: priorClaim,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
      });
    });
    const redispatchPlacement = vi.fn(async () => {
      throw new Error("redispatch reached");
    });
    const provider = createLauncher({ redispatchPlacement });

    await expect(executeTurn(provider, "next-after-reclaim")).rejects.toThrow("redispatch reached");
    expect(redispatchPlacement).toHaveBeenCalledOnce();
    expect(fx.placements.get(fx.SESSION_ID)).toMatchObject({ state: "reclaimed", turnClaim: null });
  });

  it("waits for an exact cancelled worker turn and preserves its placement for the next run", async () => {
    await fx.seedActivePlacement();
    const cancelled = new AbortController();
    const cancellationStarted = createDeferred();
    const transportCancelled = createDeferred();
    const finishCancellation = createDeferred();
    let launchCount = 0;
    const stopTunnel = vi.fn(async () => {});
    const destroy = vi.fn(async () => fx.attachedEnvironment());
    const launchTurn = vi.fn<WorkerTurnTunnelHandle["launchTurn"]>(async (request) => {
      request.onDispatchReady?.();
      launchCount += 1;
      if (launchCount === 1) {
        request.signal?.addEventListener("abort", () => transportCancelled.resolve(), {
          once: true,
        });
        cancellationStarted.resolve();
        await finishCancellation.promise;
        return processResult({ code: 1, killed: true });
      }
      return completeTurn(request, "Recovered after cancellation", 41);
    });
    const environments = environmentForTunnel({
      acquireTurnCredential: vi.fn(async () => fx.credential(String(launchCount + 1).repeat(43))),
      startTunnel: vi.fn(async () =>
        fx.createWorkerTurnTunnel({
          launchTurn,
          reconcileWorkspace: vi.fn(fx.reconcileUnchangedLocalWorkspace),
        }),
      ),
      stopTunnel,
      destroy,
    });
    const provider = fx.createWorkerSessionTurnPlacementProvider({
      environments,
      placements: fx.placements,
    });
    const firstRunId = "run-cancelled-worker";
    const first = provider.executeTurn(
      runIdentity(firstRunId),
      { ...fx.turn(firstRunId), abortSignal: cancelled.signal },
      localResult,
    );
    void first.catch(() => undefined);
    let replacement: Promise<unknown> | undefined;

    try {
      await cancellationStarted.promise;
      // The session controller queues a follow-up while the current producer owns custody.
      replacement = executeTurn(provider, "run-after-cancellation");
      cancelled.abort(new Error("operator stopped the previous turn"));
      await transportCancelled.promise;
      let replacementSettled = false;
      void replacement.then(
        () => {
          replacementSettled = true;
        },
        () => {
          replacementSettled = true;
        },
      );
      expect(replacementSettled).toBe(false);
      expect(fx.placements.get(fx.SESSION_ID)?.turnClaim?.runId).toBe(firstRunId);
      expect(launchTurn).toHaveBeenCalledOnce();

      finishCancellation.resolve();
      await expect(first).rejects.toThrow("Cloud worker process failed before completing the turn");
      await expect(replacement).resolves.toMatchObject({
        payloads: [{ text: "Recovered after cancellation" }],
      });
      await waitForSessionRunEnd(fx.SESSION_ID, null);
      expectUncalled(stopTunnel, destroy);
      expect(fx.placements.get(fx.SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
    } finally {
      finishCancellation.resolve();
      await Promise.allSettled([first, replacement].filter((operation) => operation !== undefined));
    }
  });
});
