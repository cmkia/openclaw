import { AsyncLocalStorage } from "node:async_hooks";
import { isPromise } from "node:util/types";
import { serialize } from "node:v8";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { createDeferredCore } from "../shared/deferred.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import type {
  Actor,
  OperationScope,
  PreparedSqliteWorkerCommand,
  SqliteWorkerExecutionScope,
  StoreClient,
} from "./sqlite-worker-broker.types.js";
import {
  SqliteWorkerError,
  type SqliteWorkerOperations,
  type SqliteWorkerStore,
} from "./sqlite-worker-contract.js";
import type { SqliteWorkerAdmissionFactory } from "./sqlite-worker-operation-admission.js";
import {
  captureSqliteWorkerStateContext,
  type SqliteWorkerStateContext,
} from "./sqlite-worker-state-context.js";
import { classifyWorkerRequest } from "./worker-request-diagnostics.js";

export function prepareSqliteWorkerCommand(command: {
  type: PropertyKey;
  input: unknown;
}): PreparedSqliteWorkerCommand {
  const { type, input } = command;
  return {
    type,
    requestClass: classifyWorkerRequest(type, input),
    payload: serialize({ type, input }),
  };
}

export function runSqliteWorkerClientOperation<Operations extends SqliteWorkerOperations, T>(
  client: StoreClient | undefined,
  operation: (scope: SqliteWorkerExecutionScope<Operations>) => T | Promise<T>,
  stateContext: SqliteWorkerStateContext | undefined,
  track: (pending: Promise<void>) => () => void,
  assertCurrent?: (commandType: PropertyKey) => void,
  createAdmission?: SqliteWorkerAdmissionFactory,
): Promise<T> {
  if (!client || client.sealed) {
    return Promise.reject(new SqliteWorkerError("SQLite worker store is closed", "closed"));
  }
  const scope: OperationScope = {
    maintenanceScope: getOpenClawDatabaseMaintenanceScope(),
    createAdmission,
    assertCurrent,
    active: true,
    pending: new Set(),
    ...(stateContext ? { stateContext: captureSqliteWorkerStateContext(stateContext) } : {}),
  };
  const released = createDeferredCore();
  client.scopes.add(released.promise);
  const untrack = track(released.promise);
  return (async () => {
    try {
      const result = operation({
        executePrepared: (command, options = {}) => client.executePrepared(command, options, scope),
        execute: (command, options = {}) =>
          // SAFETY: The exact admitted store retains its typed backend.
          client.execute(command, options, scope) as Promise<
            Operations[typeof command.type]["output"]
          >,
      });
      return isPromise(result) ? await result : result;
    } finally {
      scope.active = false;
      // A callback can throw after dispatch or leave a command unawaited.
      await Promise.allSettled(scope.pending);
      client.scopes.delete(released.promise);
      untrack();
      released.resolve();
    }
  })();
}

export function createSqliteWorkerClient<Operations extends SqliteWorkerOperations>(owner: {
  actor: Actor;
  isDraining: () => boolean;
  isAvailable: () => boolean;
  retireIdle?: () => Promise<void> | undefined;
  dispatch: (
    payload: Buffer<ArrayBuffer>,
    signal: AbortSignal | undefined,
    scope: OperationScope | undefined,
    assertCurrent: (() => void) | undefined,
    createAdmission: SqliteWorkerAdmissionFactory | undefined,
    requestClass: string,
  ) => Promise<unknown>;
  release: (reclaiming: boolean) => Promise<void>;
}) {
  let closed: Promise<void> | undefined;
  let reclaiming = false;
  const pending = new Set<Promise<unknown>>();
  const execute = (
    input:
      | { command: { type: PropertyKey; input: unknown } }
      | { prepared: PreparedSqliteWorkerCommand },
    options: { signal?: AbortSignal },
    scope?: OperationScope,
  ): Promise<unknown> => {
    if (scope ? !scope.active : client.sealed || owner.isDraining()) {
      return Promise.reject(new SqliteWorkerError("SQLite worker store is closed", "closed"));
    }
    if (options.signal?.aborted) {
      return Promise.reject(
        toErrorObject(options.signal.reason, "SQLite worker operation canceled"),
      );
    }
    let payload: Buffer<ArrayBuffer>;
    let requestClass: string;
    let assertCurrent: (() => void) | undefined;
    const admission = scope?.assertCurrent;
    const createAdmission = scope?.createAdmission;
    // Queued callbacks run from Worker replies, outside this command's async context.
    const inCaller = admission || createAdmission ? AsyncLocalStorage.snapshot() : undefined;
    try {
      const commandType = "command" in input ? input.command.type : input.prepared.type;
      requestClass =
        "command" in input
          ? classifyWorkerRequest(commandType, input.command.input)
          : input.prepared.requestClass;
      assertCurrent = admission && inCaller ? () => inCaller(admission, commandType) : undefined;
      assertCurrent?.();
      payload =
        "command" in input
          ? serialize({ type: commandType, input: input.command.input })
          : input.prepared.payload;
    } catch (error) {
      return Promise.reject(toErrorObject(error, "SQLite worker command could not be serialized"));
    }
    const operation = owner.dispatch(
      payload,
      options.signal,
      scope,
      assertCurrent,
      createAdmission && inCaller
        ? (admissionOperation) => inCaller(createAdmission, admissionOperation)
        : undefined,
      requestClass,
    );
    pending.add(operation);
    scope?.pending.add(operation);
    const settled = () => {
      pending.delete(operation);
      scope?.pending.delete(operation);
    };
    void operation.then(settled, settled);
    return operation;
  };
  const client: StoreClient = {
    actor: owner.actor,
    close: () => store.close(),
    retireIdle: owner.retireIdle
      ? () => {
          if (client.sealed || client.scopes.size || pending.size) {
            return undefined;
          }
          reclaiming = true;
          try {
            return owner.retireIdle?.();
          } finally {
            reclaiming = false;
          }
        }
      : undefined,
    sealed: owner.isDraining(),
    isAvailable: owner.isAvailable,
    scopes: new Set(),
    execute: (command, options, scope) => execute({ command }, options, scope),
    executePrepared: (command, options, scope) => execute({ prepared: command }, options, scope),
  };
  const store: SqliteWorkerStore<Operations> = {
    execute: (command, options = {}) =>
      // SAFETY: The typed backend owns this result.
      client.execute(command, options) as Promise<Operations[typeof command.type]["output"]>,
    close: () => {
      if (!closed) {
        client.sealed = true;
        // The idle owner seals synchronously; carry that close mode through settlement.
        const reclaimingIdle = reclaiming;
        closed = (async () => {
          await Promise.allSettled(client.scopes);
          await Promise.allSettled(pending);
          await owner.release(reclaimingIdle);
        })().catch((error: unknown) => {
          closed = undefined;
          throw error;
        });
      }
      return closed;
    },
  };
  return { store, client };
}
