import fs from "node:fs";
import path from "node:path";
import { threadId } from "node:worker_threads";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureClawInstallSchemaVersionFacts } from "../claws/provenance-runtime-read.js";
import "../claws/tool-policy-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { unregisterResolvedAgentDir } from "./agent-dir-registry.js";
import { resolveAgentDir } from "./agent-scope-config.js";
import { saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  createPreparedModelCatalogWorker,
  getPreparedModelCatalogWorkerPoolSnapshot,
  createPreparedModelCatalogWorkerInput,
} from "./prepared-model-catalog-worker.js";
import { stubCatalogEnv } from "./prepared-model-catalog-worker.shared.test-support.js";
import {
  createCatalogFixture,
  catalogEntry,
  PROVIDER_ID,
  PLUGIN_ID,
  writeFixtureFiles,
} from "./prepared-model-catalog-worker.test-support.js";
import { getPreparedModelFullCatalogAuth } from "./prepared-model-runtime-auth.js";
import { prepareWorkspaceBuildGroup } from "./prepared-model-runtime.facts.js";
import { retainPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import { createCatalogInspectionPool } from "./test-helpers/prepared-model-catalog-inspection.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest } = usePreparedCatalogWorkerFixtures();

async function createFixture() {
  const fixture = await createCatalogFixture(makeTempDir, 0);
  stubCatalogEnv(fixture.env);
  return fixture;
}

async function prepareInput(input: Parameters<typeof prepareWorkspaceBuildGroup>[0][number]) {
  const prepared = await prepareWorkspaceBuildGroup([input], "static");
  retireAfterTest(retainPreparedPluginGeneration(prepared.pluginGeneration));
  return createPreparedModelCatalogWorkerInput({
    agentFacts: prepared.agentFacts[0]!,
    pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
  });
}

const catalogResult = {
  status: "ok",
  kind: "catalog",
  snapshot: { entries: expect.arrayContaining([catalogEntry("plugin-generation-v1")]) },
};

describe("catalog request existing directory ownership", () => {
  beforeEach(() => {
    vi.stubEnv("CODEX_HOME", makeTempDir("openclaw-directory-request-empty-codex-"));
  });

  it("serves repeated catalog requests from prepared provenance without copying shared state", async () => {
    const fixture = await createFixture();
    const value = await prepareInput({
      agentId: "main",
      agentDir: fixture.agentDir,
      config: fixture.config,
      env: fixture.env,
    });
    const database = openOpenClawStateDatabase({ env: fixture.env });
    const clawInstallSchemaVersions = captureClawInstallSchemaVersionFacts({ env: fixture.env });
    await closeOpenClawStateDatabaseByPathAsync(database.path);
    const { pool } = createCatalogInspectionPool(fixture.env);
    try {
      // Worker startup and the copy probe are real; this contract does not measure their latency.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      for (let tick = 0; tick < 3; tick++) {
        const { inspection, ...result } = await pool.run(
          {
            value,
            request: { kind: "catalog", syntheticAuth: [], clawInstallSchemaVersions },
            ...(tick === 0 ? { inspection: { copyProbePath: database.path } } : {}),
          },
          { timeoutMs: 30_000 },
        );
        expect(result).toMatchObject(catalogResult);
        expect(inspection.sqliteCopies).toBe(0);
        if (tick === 0) {
          expect(inspection.copyHookObserved).toBe(true);
        }
      }
    } finally {
      try {
        await pool.close();
      } finally {
        vi.useRealTimers();
        await closeOpenClawStateDatabaseByPathAsync(database.path);
      }
    }
  });

  it.each([
    { label: "same normalized owner", existing: ["MAIN"], conflict: false },
    { label: "foreign owner", existing: ["foreign"], conflict: true },
    { label: "ambiguous owners", existing: ["main", "foreign"], conflict: true },
  ])("preserves $label across the request", async ({ existing, conflict }) => {
    const fixture = await createFixture();
    const config = {
      ...fixture.config,
      agents: {
        ...fixture.config.agents,
        entries: { main: { agentDir: path.join(fixture.root, "custom-owner", "agent") } },
      },
    } satisfies OpenClawConfig;
    const agentDir = resolveAgentDir(config, "main", fixture.env);
    retireAfterTest(() => {
      unregisterResolvedAgentDir({ agentId: "main", agentDir, env: fixture.env });
      unregisterResolvedAgentDir({ agentId: "foreign", agentDir, env: fixture.env });
    });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [`${PROVIDER_ID}:main`]: {
            type: "api_key",
            provider: PROVIDER_ID,
            key: "existing-owner-key-not-real",
          },
        },
      },
      agentDir,
    );
    const value = structuredClone(
      await prepareInput({
        agentId: "main",
        agentDir,
        inheritedAuthDir: agentDir,
        config,
        env: fixture.env,
      }),
    );
    unregisterResolvedAgentDir({ agentId: "main", agentDir, env: fixture.env });
    const { pool } = createCatalogInspectionPool(fixture.env);
    let completed: Awaited<ReturnType<typeof pool.run>>;
    try {
      completed = await pool.run(
        {
          value,
          request: {
            kind: "catalog",
            syntheticAuth: [],
            clawInstallSchemaVersions: captureClawInstallSchemaVersionFacts({ env: fixture.env }),
          },
          inspection: { existingAgentIds: existing },
        },
        { timeoutMs: 30_000 },
      );
    } finally {
      await pool.close();
    }
    const { inspection, ...result } = completed;
    if (conflict) {
      expect(result).toEqual({
        status: "failed",
        authCredentials: [],
        error: `Conflicting registered agent owners for ${agentDir}`,
      });
      expect(fs.existsSync(fixture.marker)).toBe(false);
      expect(inspection.foreignReleased).toBe(true);
    } else {
      expect(result).toMatchObject(catalogResult);
      expect(fs.readFileSync(fixture.marker, "utf8")).toBe("start\ndone\n");
    }
    expect(inspection.registeredAgentId).toBe(
      existing.some((agentId) => agentId.toLowerCase() === "main") ? "main" : undefined,
    );
  });
});

it.each(["Gateway", "standalone"])("%s isolates and releases custom directories", async (owner) => {
  vi.stubEnv("CODEX_HOME", makeTempDir("openclaw-directory-empty-codex-"));
  const fixture = await createCatalogFixture(makeTempDir, 0);
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  vi.stubEnv("OPENCLAW_STATE_DIR", fixture.env.OPENCLAW_STATE_DIR);
  const observations = path.join(fixture.root, "directory-catalog.jsonl");
  const readObservations = () => fs.readFileSync(observations, "utf8");
  const pluginDir = path.join(fixture.root, "plugin");
  writeFixtureFiles(pluginDir, {
    "index.cjs": `const fs = require("node:fs");
const id = ${JSON.stringify(PROVIDER_ID)};
const catalog = (models) => ({ provider: { baseUrl: "https://directory.invalid/v1", api: "openai-completions", models } });
module.exports = { id: ${JSON.stringify(PLUGIN_ID)}, register(api) {
    api.registerProvider({ id, label: "Directory catalog", auth: [],
      staticCatalog: { run: async () => catalog([]) },
      catalog: { run: async (context) => {
        const auth = context.resolveProviderApiKey(${JSON.stringify(PROVIDER_ID)});
        const modelId = { "alpha-key-not-real": "alpha-model", "beta-key-not-real": "beta-model" }[auth.discoveryApiKey];
        fs.appendFileSync(${JSON.stringify(observations)}, JSON.stringify([auth.profileId, context.agentDir, require("node:worker_threads").threadId]) + "\\n");
        if (!modelId) throw new Error("Unexpected directory credential");
        return catalog([{ id: modelId, name: modelId }]);
      } },
    });
} };`,
    "openclaw.plugin.json": {
      id: PLUGIN_ID,
      providers: [PROVIDER_ID],
      providerCatalogEntry: "./index.cjs",
      modelCatalog: { discovery: { [PROVIDER_ID]: "runtime" } },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    },
  });
  const directory = (...parts: string[]) => ({ agentDir: path.join(fixture.root, ...parts) });
  const entries = {
    alpha: directory("custom-owner", "agent"),
    beta: directory("custom-catalog"),
    foreign: directory("other-parent", "agent"),
  };
  const profiles = (agentId: string): AuthProfileStore["profiles"] => ({
    [`${PROVIDER_ID}:${agentId}`]: {
      type: "api_key",
      provider: PROVIDER_ID,
      key: `${agentId}-key-not-real`,
    },
  });
  const config = {
    ...fixture.config,
    agents: { defaults: { model: `${PROVIDER_ID}/selected-model` }, entries },
  };
  const retirement = new AbortController();
  retireAfterTest(() => {
    retirement.abort();
    for (const [agentId, { agentDir }] of Object.entries(entries)) {
      unregisterResolvedAgentDir({ agentId, agentDir });
    }
  });
  for (const agentId of ["alpha", "beta", "foreign"] as const) {
    saveAuthProfileStore(
      { version: 1, profiles: profiles(agentId) },
      resolveAgentDir(config, agentId),
    );
  }
  const ownership =
    owner === "Gateway" ? { allowGatewaySubagentBinding: true } : { env: fixture.env };
  const context = { workspaceDir: fixture.workspaceDir, config, ...ownership };
  const prepared = await prepareWorkspaceBuildGroup(
    (["alpha", "beta"] as const).map((agentId) =>
      Object.assign(
        { agentId, inheritedAuthDir: entries[agentId].agentDir },
        entries[agentId],
        context,
      ),
    ),
    "static",
  );
  retireAfterTest(retainPreparedPluginGeneration(prepared.pluginGeneration));
  const createWorker = (agentFacts: (typeof prepared.agentFacts)[number]) =>
    createPreparedModelCatalogWorker({
      agentFacts,
      pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
      pluginRegistry: prepared.pluginGeneration.pluginRegistry,
      isCurrent: () => !retirement.signal.aborted,
      retirementSignal: retirement.signal,
    });
  const workers = prepared.agentFacts.map(createWorker);
  for (const attempt of [1, 2]) {
    const catalogs = await Promise.all(workers.map((worker) => worker.loadCatalog()));
    for (const [index, agentId] of ["alpha", "beta"].entries()) {
      const catalog = catalogs[index]!.modelCatalog;
      expect(catalog.entries).toContainEqual(catalogEntry(`${agentId}-model`));
      expect(catalog.entries).not.toContainEqual(
        expect.objectContaining({ id: `${agentId === "alpha" ? "beta" : "alpha"}-model` }),
      );
      expect(getPreparedModelFullCatalogAuth(catalog)?.authStore.profiles).toEqual(
        profiles(agentId),
      );
    }
    expect(readObservations().trim().split("\n")).toHaveLength(attempt * 2);
  }
  const alpha = prepared.agentFacts[0]!;
  const foreign = {
    agentDir: entries.foreign.agentDir,
    inheritedAuthDir: entries.foreign.agentDir,
  };
  const beforeRejection = readObservations();
  for (const [input, actual, requested] of [
    [{ agentId: undefined }, "alpha", "custom-owner"],
    [foreign, "foreign", "alpha"],
    [{ ...foreign, agentId: undefined }, "foreign", "other-parent"],
  ] as const) {
    await expect(
      createWorker({ ...alpha, input: { ...alpha.input, ...input } }).loadCatalog(),
    ).rejects.toThrow(`belongs to agent ${actual}; requested agent ${requested}`);
  }
  expect(readObservations()).toBe(beforeRejection);
  const next = await workers[1]!.loadCatalog();
  expect(next.modelCatalog.entries).toContainEqual(catalogEntry("beta-model"));
  const events: Array<[profileId: string, agentDir: string, thread: number]> = readObservations()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    events
      .map(([profileId, agentDir]) => [profileId, agentDir] as const)
      .toSorted(([left], [right]) => left.localeCompare(right)),
  ).toEqual(
    ["alpha", "alpha", "beta", "beta", "beta"].map((agentId) => [
      `${PROVIDER_ID}:${agentId}`,
      agentId === "alpha" ? entries.alpha.agentDir : entries.beta.agentDir,
    ]),
  );
  expect(new Set(events.map((event) => event[2])).size).toBe(owner === "Gateway" ? 1 : 2);
  expect(events.every((event) => event[2] !== threadId)).toBe(true);
  if (owner === "Gateway") {
    const pool = getPreparedModelCatalogWorkerPoolSnapshot();
    expect([pool.workersCreated, pool.workers, pool.activeTasks, pool.pendingTasks]).toEqual([
      1, 1, 0, 0,
    ]);
  }
});
