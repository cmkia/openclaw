import { action, createOptimistic, onSettled } from "solid-js";
import { createGitHubIdentity } from "../../features/github-connections/github-identity.ts";
import { projectOwner } from "./projection.ts";

/** Admission remains synchronous in the owner; only presentation joins its completion. */
export function createGitHubIdentityView(deps: Parameters<typeof createGitHubIdentity>[0] = {}) {
  const owner = createGitHubIdentity(deps);
  const projection = projectOwner(owner, (source) => source.read());
  const [saving, setSaving] = createOptimistic(false, { equals: false });
  const showSaving = action(function* (completion: Promise<void>) {
    setSaving(true);
    yield completion;
  });
  onSettled(() => {
    let previous: Promise<void> | undefined;
    const observe = () => {
      const completion = owner.read().mutationCompletion;
      if (completion && completion !== previous) {
        // The native error boundary consumes this same admitted result.
        void showSaving(completion).catch(() => {});
      }
      previous = completion;
    };
    const stop = owner.subscribe(observe);
    observe();
    return () => {
      stop();
      owner.dispose();
    };
  });
  const startAuthorization = action(function* () {
    yield owner.startAuthorization();
  });
  const cancelAuthorization = action(function* () {
    yield owner.cancelAuthorization();
  });
  return { ...owner, read: projection.read, saving, startAuthorization, cancelAuthorization };
}

export type GitHubIdentityView = ReturnType<typeof createGitHubIdentityView>;
