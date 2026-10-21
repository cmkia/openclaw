import { executePreparedSqliteWorkerCommand } from "../../infra/sqlite-worker-store.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import type { AgentDatabaseExecutionScope } from "../../state/openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import type {
  SessionActor,
  SessionActorLifetime,
  SessionActorTarget,
} from "./session-actor-contract.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { createSessionActorReplica } from "./session-actor-replica.js";
import { createSessionActor } from "./session-actor.js";

/** Capture once; every command borrows the existing physical writer admission. */
export function captureDurableSessionActor(params: {
  database: OpenClawAgentDatabaseOptions & { path: string };
  target: SessionActorTarget & {
    database: Extract<SessionActorTarget["database"], { kind: "file" }>;
  };
  lifetime: SessionActorLifetime;
}): SessionActor {
  const target = Object.freeze({
    sessionKey: params.target.sessionKey,
    database: Object.freeze({ ...params.target.database }),
  });
  const database = {
    ...params.database,
    env: Object.freeze({ ...(params.database.env ?? process.env) }),
  };
  const execution = captureOpenClawAgentDatabaseExecution(database, {
    expectedIdentity: target.database,
  });
  const lifetime = {
    assertAdmission: () => params.lifetime.assertAdmission?.(),
    assertCurrent: () => {
      params.lifetime.assertCurrent();
      execution.assertCurrent();
    },
    assertReadable: () => {
      params.lifetime.assertReadable();
      execution.assertCurrent();
    },
  };
  return createSessionActor({
    target,
    lifetime,
    replica: createSessionActorReplica({
      target,
      lifetime,
      currentGeneration() {
        return execution.capturePreparedGenerationClaim()?.incarnation;
      },
    }),
    transport: {
      run: (operation, authorize, concurrentBoardReads) => {
        const prepared = concurrentBoardReads
          ? execution.capturePreparedGenerationClaim()
          : undefined;
        const assertCurrent = () => {
          lifetime.assertCurrent();
          prepared?.assertCurrent();
        };
        return withSessionEntryWorker(
          database,
          execution.fileIdentity?.physicalIdentity,
          assertCurrent,
          async (_execution, source) => {
            // Cold preparation retains exclusive admission; a qualified append cannot reopen.
            if (prepared) {
              prepared.assertCurrent();
            } else {
              await execution.prepare(source);
            }
            const run = async <Value>(
              dispatch: (worker: AgentDatabaseExecutionScope) => Promise<Value>,
            ) => {
              const result = await execution.runExisting(source, dispatch);
              if (result === undefined) {
                throw new Error("Session actor database disappeared");
              }
              return result;
            };
            return operation({
              execute: (command) => run((worker) => worker.execute(command)),
              executePrepared: (command, options) =>
                run((worker) => executePreparedSqliteWorkerCommand(worker, command, options)),
            });
          },
          undefined,
          execution,
          undefined,
          undefined,
          undefined,
          (admission, retained, request, grant) => {
            authorize(request, { admission, retained }, grant);
            return true;
          },
          undefined,
          "write",
          undefined,
          prepared ? concurrentBoardReads : undefined,
        );
      },
      release: () => execution.release(),
    },
  });
}

type AcquisitionTarget = SessionActorTarget | { database: { kind: "memory" }; sessionKey: string };

/** One actor contract selects either its durable worker or memory owner at acquisition. */
export function createSessionActorFactory(
  database: OpenClawAgentDatabaseOptions & { path: string },
) {
  const captured = {
    ...database,
    env: Object.freeze({ ...(database.env ?? process.env) }),
  };
  return {
    async acquire(requestedTarget: AcquisitionTarget, lifetime: SessionActorLifetime) {
      lifetime.assertAdmission?.();
      lifetime.assertCurrent();
      if (requestedTarget.database.kind === "memory") {
        const owner = memorySessionActorOwners.get(captured);
        return owner.acquire(
          {
            sessionKey: requestedTarget.sessionKey,
            database:
              "handle" in requestedTarget.database ? requestedTarget.database : owner.identity,
          },
          lifetime,
        );
      }
      return captureDurableSessionActor({
        database: captured,
        target: { sessionKey: requestedTarget.sessionKey, database: requestedTarget.database },
        lifetime,
      });
    },
  };
}
