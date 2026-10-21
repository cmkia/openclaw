import { AsyncLocalStorage } from "node:async_hooks";
import { runWithAsyncStore } from "../shared/async-store.js";

type ModelTransportContext = {
  sessionKey?: string;
  runId?: string;
  requestId: string;
  priority?: "interactive" | "background";
  onRateLimitWait?: (retryAt: number) => () => void;
};

const modelTransportContext = new AsyncLocalStorage<ModelTransportContext>();

export function withModelTransportContext<T>(context: ModelTransportContext, run: () => T): T {
  return runWithAsyncStore(modelTransportContext, context, run);
}

export function getModelTransportContext(): ModelTransportContext | undefined {
  return modelTransportContext.getStore();
}

export function formatModelTransportContext(): string {
  const context = modelTransportContext.getStore();
  return context
    ? ` sessionKey=${JSON.stringify(context.sessionKey ?? "unknown")} runId=${JSON.stringify(context.runId ?? "unknown")} requestId=${JSON.stringify(context.requestId)} requestNumber=${context.requestId.slice(context.requestId.lastIndexOf(":") + 1)}`
    : "";
}
